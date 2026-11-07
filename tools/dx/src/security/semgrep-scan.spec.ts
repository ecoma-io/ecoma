import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildDockerArgs,
  isScannablePath,
  listChangedFiles,
  localSkipReason,
  reportScanResult,
  resolveGitDirMounts,
  SEMGREP_IMAGE,
  summarizeFindings,
} from './semgrep-scan.js';
import { gitEnv } from '../utils.js';

const DX_ROOT = resolve(import.meta.dirname, '../..');
const REPO_ROOT = resolve(DX_ROOT, '../..');
const CODE_ANALYSIS = join(REPO_ROOT, '.github/workflows/code-analysis.yml');
const LEFTHOOK = join(REPO_ROOT, 'lefthook.yml');

/**
 * Image và script gate phải là ĐÚNG CÁI CI đang chạy.
 *
 * Nếu hai bên lệch phiên bản hoặc lệch cách gate thì "push xanh ở local" không
 * còn là bằng chứng cho `analysis-gate` — nó chỉ là bằng chứng cho một chương
 * trình khác. Vì vậy hai hằng này được assert bằng chính chuỗi trong
 * `code-analysis.yml`, không bằng một bản sao tự ghi.
 */
const CI_IMAGE =
  'semgrep/semgrep:1.182.1@sha256:451b3d875c00dac7ed5db5293e584a07de11449a409c10b3c2d2652f429630b6';

/**
 * Vi phạm thật, cấy vào một file TypeScript.
 *
 * Nó phải làm `security-sensitive-value-logged` bắt được: `authorization` là
 * tên nằm trong danh sách threat model của rule, và `console.log` là sink. Dùng
 * một chuỗi tùy ý sẽ cho một test xanh mà không chứng minh gì, vì gate không
 * bao giờ thấy finding.
 */
const REAL_VIOLATION = [
  'export function leak(authorization: string, userId: string) {',
  '  console.log(`token=${authorization} user=${userId}`);',
  '  return { ok: true };',
  '}',
  '',
].join('\n');

/** Git trong repo tạm, `GIT_*` scrub để không ghim vào repo workspace. */
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() });
}

function initRepo(prefix = 'semgrep-repo-'): string {
  const repo = join(process.env.SEMGREP_TEST_TMP ?? '/tmp', `${prefix}${process.pid}`);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'semgrep-test@example.com');
  git(repo, 'config', 'user.name', 'semgrep test');
  git(repo, 'config', 'commit.gpgsign', 'false');

  return repo;
}

function commitAll(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--no-verify', '-m', message);

  return git(repo, 'rev-parse', 'HEAD').trim();
}

/* -------------------------------------------------------------------------- */
/*  Docker + semgrep thật — Docker là dependency phát triển BẮT BUỘC            */
/* -------------------------------------------------------------------------- */

/**
 * Cài bộ rule thật của repository vào một repo tạm.
 *
 * Test chạy đúng rule của repo này chứ không phải rule nhàu, vì điều đang kiểm
 * là "danh sách extension trong `semgrep-scan.ts` khớp với cái engine thật
 * quét được" — một rule nhàu sẽ cho khả năng quét khác và kết luận sai.
 */
function installRules(repo: string): void {
  mkdirSync(join(repo, '.github/semgrep'), { recursive: true });
  for (const name of ['security.yml', 'architecture.yml', 'workflows.yml']) {
    execFileSync('cp', [
      join(REPO_ROOT, '.github/semgrep', name),
      join(repo, '.github/semgrep', name),
    ]);
  }
}

beforeAll(() => {
  // Probe Docker một lần trước cả suite: lỗi nhanh, rõ ràng, và pre-pull sẵn
  // image semgrep cho các test engine phía dưới. Theo policy fail-loud của
  // `docs/architecture/06-testing.md` §6, vắng Docker phải làm toàn bộ lần chạy đỏ
  // (ném lỗi ở đây) — KHÔNG được skip, vì skip với exit 0 che mất việc một phần
  // suite bắt buộc chưa hề chạy. Tiền lệ: suite PG của app auth (d96c40de).
  const probe = join(process.env.SEMGREP_TEST_TMP ?? '/tmp', `semgrep-docker-probe-${process.pid}`);
  rmSync(probe, { recursive: true, force: true });
  mkdirSync(probe, { recursive: true });
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      env: gitEnv(),
    });
    execFileSync(
      'docker',
      ['run', '--rm', '--volume', `${probe}:/src`, '--workdir', '/src', SEMGREP_IMAGE, 'true'],
      { stdio: 'ignore', env: gitEnv(), timeout: 300_000 },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Docker is a mandatory development dependency for this repository (policy: docs/architecture/06-testing.md §6); probe failed: ${reason}`,
      { cause: error },
    );
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}, 300_000);

afterAll(() => {
  const repo = join(process.env.SEMGREP_TEST_TMP ?? '/tmp', `semgrep-repo-${process.pid}`);
  rmSync(repo, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe('semgrep scan scope', () => {
  it('treats only the extensions the rules actually scan as in scope', () => {
    // Đây là phép đo, không phải phỏng đoán: các extension ngoài danh sách dưới
    // đây ĐÃ THỬ CỐ TÌNH và cho 0 finding trên semgrep 1.181.0, dù `.mts`/`.cts`
    // cùng khai báo `languages: [typescript]` như `.ts`. Thêm chúng vào đây thì
    // hook tốn 12s rồi không tìm được gì.
    for (const path of [
      'apps/foo/src/a.ts',
      'apps/foo/src/a.tsx',
      '.github/workflows/ci.yml',
      'apps/foo/ci.yaml',
      'apps/foo/wrangler.jsonc',
    ]) {
      expect(isScannablePath(path)).toBe(true);
    }

    for (const path of [
      'apps/foo/src/a.mts',
      'apps/foo/src/a.cts',
      'apps/foo/src/a.vue',
      'apps/foo/src/a.js',
      'apps/foo/src/a.mjs',
      'apps/foo/package.json',
      'apps/foo/wrangler.toml',
      'docs/architecture/01-architecture.md',
    ]) {
      expect(isScannablePath(path)).toBe(false);
    }
  });

  it('lists the files changed against the base the hook already uses', () => {
    const repo = initRepo();
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    const base = commitAll(repo, 'base');

    writeFileSync(join(repo, 'changed.ts'), 'export const a = 1;\n');
    const head = commitAll(repo, 'change');

    const listed = listChangedFiles(base, repo);

    expect(listed.ok).toBe(true);
    expect(listed.ok && listed.files).toEqual(['changed.ts']);
    expect(head).not.toBe(base);
  });

  it('fails closed when the base cannot be diffed', () => {
    // Base hỏng KHÔNG được hiểu là "không có gì đổi" — đó là im lặng bỏ gate.
    const repo = initRepo();
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'base');

    const listed = listChangedFiles('0'.repeat(40), repo);

    expect(listed.ok).toBe(false);
  });

  it('reads the changed-file list from the scratch repo even when a hook left GIT_DIR behind', () => {
    // Lefthook export GIT_DIR ở pre-push và nó thắng cwd; đây là điều kiện hook
    // thật, nên phải tái hiện chứ không chỉ giả định `gitEnv()` đúng.
    const repo = initRepo();
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    const base = commitAll(repo, 'base');
    writeFileSync(join(repo, 'real.ts'), 'export const a = 1;\n');
    commitAll(repo, 'change');

    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(repo, '.git-does-not-exist');
    try {
      const listed = listChangedFiles(base, repo);
      expect(listed.ok).toBe(true);
      expect(listed.ok && listed.files).toEqual(['real.ts']);
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previous;
      }
    }
  });
});

describe('summarizeFindings', () => {
  it('reads rule, path and line out of a SARIF report', () => {
    const dir = join(process.env.SEMGREP_TEST_TMP ?? '/tmp', `semgrep-sarif-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const report = join(dir, 'report.sarif');
    writeFileSync(
      report,
      JSON.stringify({
        runs: [
          {
            results: [
              {
                ruleId: 'github.semgrep.security-sensitive-value-logged',
                message: { text: 'A sensitive value was logged.' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'apps/foo/src/a.ts' },
                      region: { startLine: 12 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(summarizeFindings(report)).toEqual([
      {
        rule: 'github.semgrep.security-sensitive-value-logged',
        path: 'apps/foo/src/a.ts',
        line: 12,
        message: 'A sensitive value was logged.',
      },
    ]);

    rmSync(dir, { recursive: true, force: true });
  });

  it('reports nothing for a SARIF with no results', () => {
    const dir = join(process.env.SEMGREP_TEST_TMP ?? '/tmp', `semgrep-sarif-empty-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const report = join(dir, 'report.sarif');
    writeFileSync(report, JSON.stringify({ runs: [{ results: [] }] }));

    expect(summarizeFindings(report)).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });
});

/* -------------------------------------------------------------------------- */
/*  Bộ rule thật, chạy bằng engine thật                                          */
/* -------------------------------------------------------------------------- */

describe("the repository's own rules, scanned by the engine the hook runs", () => {
  it('detects a real violation in .ts and .tsx, and in neither .mts nor .cts nor .vue', () => {
    // Bảo đảm danh sách extension trong `semgrep-scan.ts` là ĐÚNG với khả năng
    // thật của engine, chứ không phải với điều ta hy vọng. Cùng một vi phạm,
    // cấy vào từng extension: nếu sau này semgrep bắt đầu quét `.mts`, test
    // này đỏ và buộc phải cập nhật danh sách — đúng hướng, vì lỗ hổng được
    // nói ra thay vì để im.
    const repo = initRepo('semgrep-ext-');
    installRules(repo);
    mkdirSync(join(repo, 'apps/probe/src'), { recursive: true });

    const payloads: Record<string, string> = {
      'a.ts': REAL_VIOLATION,
      'a.tsx': REAL_VIOLATION,
      'a.mts': REAL_VIOLATION,
      'a.cts': REAL_VIOLATION,
      'a.vue':
        '<script setup lang="ts">\nfunction f(authorization: string, userId: string) {\n  console.log(`t=${authorization} u=${userId}`);\n}\n</script>\n',
    };
    for (const [name, contents] of Object.entries(payloads)) {
      writeFileSync(join(repo, 'apps/probe/src', name), contents);
    }
    commitAll(repo, 'probe');

    const reportDir = join(process.env.SEMGREP_TEST_TMP ?? '/tmp', `semgrep-out-${process.pid}`);
    rmSync(reportDir, { recursive: true, force: true });
    mkdirSync(reportDir, { recursive: true });

    const out = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--volume',
        `${repo}:/src`,
        '--volume',
        `${reportDir}:/out`,
        '--workdir',
        '/src',
        SEMGREP_IMAGE,
        'bash',
        '-c',
        'semgrep scan --config .github/semgrep --exclude .github/semgrep --sarif --output /out/semgrep.sarif --quiet',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() },
    );

    const findings = summarizeFindings(join(reportDir, 'semgrep.sarif'));
    const hit = (name: string): boolean =>
      findings.some((finding) => finding.path === `apps/probe/src/${name}`);

    // Các extension mà danh sách trong `semgrep-scan.ts` hứa là sẽ bắt được.
    expect(hit('a.ts')).toBe(true);
    expect(hit('a.tsx')).toBe(true);

    // Các extension CHƯA được quét. Đây là lỗ hổng đã biết của bộ rule, được
    // ghi thành khẳng định để nó không biến mất trong im lặng: khi rule phủ
    // được chúng, test đỏ và bắt người sửa danh sách + báo lại.
    expect(hit('a.mts')).toBe(false);
    expect(hit('a.cts')).toBe(false);
    expect(hit('a.vue')).toBe(false);

    expect(out).toBeDefined();
    rmSync(reportDir, { recursive: true, force: true });
  }, 300_000);

  it('catches the wrangler.jsonc ownership violation through the generic rule', () => {
    // Rule `generic` + `pattern-regex` là lý do `wrangler.jsonc` nằm trong
    // danh sách dù nó không phải `.ts`/`.yml`: không có nó thì một app mới mở
    // D1 mà không sở hữu sẽ lọt khỏi cả hook lẫn CI.
    const repo = initRepo('semgrep-wrangler-');
    installRules(repo);
    mkdirSync(join(repo, 'apps/probe'), { recursive: true });
    writeFileSync(
      join(repo, 'apps/probe/wrangler.jsonc'),
      '{\n  "name": "probe",\n  "database_name": "probe-db"\n}\n',
    );
    commitAll(repo, 'probe');

    const reportDir = join(process.env.SEMGREP_TEST_TMP ?? '/tmp', `semgrep-wr-${process.pid}`);
    rmSync(reportDir, { recursive: true, force: true });
    mkdirSync(reportDir, { recursive: true });

    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--volume',
        `${repo}:/src`,
        '--volume',
        `${reportDir}:/out`,
        '--workdir',
        '/src',
        SEMGREP_IMAGE,
        'bash',
        '-c',
        'semgrep scan --config .github/semgrep --exclude .github/semgrep --sarif --output /out/semgrep.sarif --quiet',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() },
    );

    const findings = summarizeFindings(join(reportDir, 'semgrep.sarif'));

    expect(findings.some((finding) => finding.path === 'apps/probe/wrangler.jsonc')).toBe(true);

    rmSync(reportDir, { recursive: true, force: true });
  }, 300_000);
});

/* -------------------------------------------------------------------------- */
/*  Wiring: hook và CI phải dùng cùng một gate                                 */
/* -------------------------------------------------------------------------- */

describe('wiring', () => {
  it('runs the semgrep gate from pre-push', () => {
    const hook = readFileSync(LEFTHOOK, 'utf8');

    expect(hook).toContain('pnpm dx semgrep-scan-local');
    expect(hook).not.toContain('pnpm dx semgrep-scan-ci');
  });

  it('tests the rules against their fixtures before a commit that touches the rules', () => {
    // `semgrep-test-local` chỉ hữu ích nếu hook thật sự gọi nó khi bộ rule đổi;
    // một lệnh đúng nhưng không nối vào đâu là một lệnh không chạy.
    const hook = readFileSync(LEFTHOOK, 'utf8');
    const preCommit = hook.slice(0, hook.indexOf('post-commit:'));

    expect(preCommit).toContain("glob: '.github/semgrep/**'");
    expect(preCommit).toContain('pnpm dx semgrep-test-local');
    expect(preCommit).not.toContain('pnpm dx semgrep-test-ci');
  });

  it('declares the workflow files it reads as Nx inputs so a workflow-only change still runs these tests', () => {
    // Các test wiring đọc `code-analysis.yml` và `lefthook.yml` qua
    // `fs.readFileSync` — dependency runtime vô hình với project graph, nên
    // trước khi có `namedInputs` này, một PR chỉ sửa workflow file cho
    // `nx affected` 0 task (tái hiện thật: `nx show projects --affected` trả
    // `[]` trên main) và test dưới đây không hề chạy ở CI. Assert này đọc lại
    // chính `package.json` của project: nếu ai xoá input (hoặc Nx đổi cách kế
    // thừa `default` ở project level) thì test đỏ ngay trong lần chạy còn lại.
    // Một test chỉ assert bản thân nó chạy được là ít — nhưng kết hợp với input
    // khai trên, invariant "workflow-only change ⇒ test wiring chạy" được giữ
    // bởi chính Nx, còn assert này chặn việc cấu hình bị gỡ bỏ âm thầm.
    const project = JSON.parse(readFileSync(join(DX_ROOT, 'package.json'), 'utf8')) as {
      nx?: { namedInputs?: { default?: string[] } };
    };
    const inputs = project.nx?.namedInputs?.default ?? [];

    for (const required of [
      '{workspaceRoot}/.github/workflows/code-analysis.yml',
      '{workspaceRoot}/lefthook.yml',
    ]) {
      expect(inputs).toContain(required);
    }
    // Caller `deploys/backoffice-deploy/index.ts` mà `shell-quote.spec.ts`
    // (nay ở `libs/deployment`) ghim đã RỜI named-input của DX: spec đó theo
    // lib `@ecoma-io/deployment` đi, và lib đọc caller trực tiếp nên input
    // `{projectRoot}/**/*` của lib đã phủ file caller. Khai lại ở đây là input
    // nghịch hướng (dx đọc deploy source) — bị chặn trong review vòng này.
    expect(inputs).not.toContain('{workspaceRoot}/deploys/backoffice-deploy/index.ts');
    // `{projectRoot}/**/*` phải còn ở đầu: xoá nó là mất toàn bộ source files
    // khỏi hash — test/lint/typecheck sẽ cache-hit sai trên mọi thay đổi code.
    expect(inputs).toContain('{projectRoot}/**/*');
  });

  it('uses the same pinned image as CI', () => {
    // Nâng version ở DX mà quên ở lock file / workflow là một trong hai bên
    // kiểm bộ rule cũ — đúng loại im lặng mà assert này chặn.
    expect(SEMGREP_IMAGE).toBe(CI_IMAGE);
  });

  it('runs semgrep via dx instead of raw binary in CI', () => {
    const workflow = readFileSync(CODE_ANALYSIS, 'utf8');

    expect(workflow).toContain('pnpm dx semgrep-test-ci');
    expect(workflow).toContain('pnpm dx semgrep-scan-ci');
    // CI không có điều kiện chạy: một lần scan bị bỏ qua ở đây là required check
    // xanh trong khi chưa quét gì, nên lệnh local không được xuất hiện ở đây.
    expect(workflow).not.toContain('pnpm dx semgrep-scan-local');
    // Đã bỏ container image: job chạy trên runner mặc định, dx tự pull image qua docker.
    expect(workflow).not.toContain('container:');
  });

  it('gates on the same script CI gates on', () => {
    // Không dùng `--error`: `filter-accepted.py` là điểm chế duy nhất cho cả
    // gate lẫn SARIF (xem JSDoc của nó). Một gate riêng ở hook nghĩa là hai nơi
    // quyết định "finding này được chấp nhận".
    expect(existsSync(join(REPO_ROOT, '.github/semgrep/filter-accepted.py'))).toBe(true);
    expect(readFileSync(CODE_ANALYSIS, 'utf8')).toContain('filter-accepted.py gate');
  });

  it('mounts the source at /src, which semgrep requires inside a container', () => {
    // Mount chỗ khác thì semgrep ném `Detected Docker environment without a code
    // volume`. Đây là điều kiện tiên quyết của lệnh, không phải lựa chọn style —
    // và nó KHÁC với hook gitleaks, vốn mount `/repo`.
    const args = buildDockerArgs({ rootDir: '/repo', reportDir: '/out' });
    const sourceIndex = args.indexOf('/repo:/src');

    expect(sourceIndex).toBeGreaterThan(-1);
    expect(args.indexOf('--workdir')).toBeGreaterThan(-1);
    expect(args[args.indexOf('--workdir') + 1]).toBe('/src');
  });

  it('mounts the git directory read-only with --mount, never a same-path -v volume', () => {
    // Hai lỗi đã đo, cả hai đều làm semgrep quét một tập file khác CI:
    //  * không mount git dir → trong worktree, `.git` trỏ ra ngoài `/src` và
    //    semgrep mất git integration, quét cả file bị `.gitignore` loại;
    //  * mount bằng `-v <dir>:<dir>:ro` → trên Docker 29.5.3 rootless mount ra
    //    rỗng 10/10 lần, tức mất git y như không mount.
    const gitDir = '/home/runner/repo/.git';
    const args = buildDockerArgs({ rootDir: '/repo', reportDir: '/out', gitDirs: [gitDir] });
    const mountIndex = args.indexOf(`type=bind,src=${gitDir},dst=${gitDir},readonly`);

    expect(mountIndex).toBeGreaterThan(-1);
    expect(args[mountIndex - 1]).toBe('--mount');
    // Read-only volume dạng `-v` không được xuất hiện cho git dir.
    expect(args).not.toContain(`${gitDir}:${gitDir}:ro`);
  });

  it('does not pass GIT_* into the container', () => {
    // Truyền GIT_DIR trỏ ra ngoài container làm semgrep quét cả các worktree
    // dưới .claude/worktrees/ → hàng chục finding giả. Docker mặc định không
    // chuyển env của host vào, nên điều kiện để giữ là: không thêm `-e GIT_`.
    // Mount git dir read-only không vi phạm điều này: nó truyền đường dẫn, không
    // truyền biến môi trường.
    const args = buildDockerArgs({ rootDir: '/repo', reportDir: '/out', gitDirs: ['/repo/.git'] });

    expect(args).not.toContain('GIT_DIR');
    expect(args).not.toContain('GIT_WORK_TREE');
    expect(args.some((arg) => arg.startsWith('GIT_'))).toBe(false);
  });

  it('never narrows the scan itself, only whether it runs', () => {
    // `filter-accepted.py` fail-closed hai chiều: entry allowlist không khớp
    // result nào thì báo stale. Quét một tập con làm các entry không liên quan
    // bị coi là stale — đo trên repo này, quét một file làm 2/3 entry "biến
    // mất" và gate đỏ. Điều kiện chạy KHÔNG được trở thành điều kiện quét.
    for (const file of ['apps/account/src/a.ts', 'wrangler.jsonc']) {
      const args = buildDockerArgs({ rootDir: '/repo', reportDir: '/out' });
      const command = args[args.length - 1] ?? '';

      expect(command).toContain('semgrep scan --config .github/semgrep --exclude .github/semgrep');
      expect(command).not.toContain(file);
    }
  });
});

/** Bắt các dòng log mà `localSkipReason` in ra, để assert thông điệp. */
function collectLines(): { log: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (message) => lines.push(message), lines };
}

describe('localSkipReason', () => {
  it('skips when no changed file is in scope, and says so rather than "passed"', () => {
    const { log, lines } = collectLines();

    const reason = localSkipReason({ ok: true, files: ['docs/a.md', 'README.md'] }, log);

    expect(reason).toContain('Semgrep scan skipped');
    expect(reason).not.toMatch(/passed/u);
    expect(lines).toEqual([]);
  });

  it('runs when a changed file is in scope, and reports the scope decision', () => {
    const { log, lines } = collectLines();

    const reason = localSkipReason(
      { ok: true, files: ['apps/account/src/a.ts', 'README.md'] },
      log,
    );

    expect(reason).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1 of 2 changed file(s) are in scope');
  });

  it('runs a full scan instead of skipping when the base cannot be diffed', () => {
    // Một base hỏng không phải "không có gì đổi" — hiểu như vậy là bỏ gate.
    const { log, lines } = collectLines();

    const reason = localSkipReason({ ok: false, reason: 'git could not diff' }, log);

    expect(reason).toBeNull();
    expect(lines[0]).toContain('Falling back to a full scan');
  });
});

describe('reportScanResult', () => {
  // Hook xanh khi gate đỏ là lỗi tệ nhất của cả cơ chế này: người dùng thấy log
  // "failed" nhưng push vẫn đi, còn CI thì đỏ sau khi đã push. Assert exit code
  // chứ không assert chuỗi log, vì chuỗi log không quyết định exit status.
  it('sets a failing exit code when the gate rejects a finding', () => {
    const previous = process.exitCode;
    process.exitCode = 0;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      reportScanResult(
        {
          ok: false,
          reason: 'docker exited with code 1. See the semgrep output above for the findings.',
          findings: [{ rule: 'r', path: 'apps/a.ts', line: 3, message: 'm' }],
        },
        'Semgrep scan',
      );

      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
      process.exitCode = previous;
    }
  });

  it('sets a failing exit code when docker cannot run at all', () => {
    // Scanner không chạy được KHÔNG phải "không có finding" — nếu hàm này im
    // lặng trả 0 thì mọi lần docker hỏng đều trở thành một lần push xanh.
    const previous = process.exitCode;
    process.exitCode = 0;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      reportScanResult(
        { ok: false, reason: 'could not run docker: ENOENT', findings: [] },
        'Semgrep scan',
      );

      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
      process.exitCode = previous;
    }
  });

  it('leaves the exit code alone when the gate is clean', () => {
    const previous = process.exitCode;
    process.exitCode = 0;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      reportScanResult({ ok: true, findings: [] }, 'Semgrep scan');

      expect(process.exitCode).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('passed'));
    } finally {
      log.mockRestore();
      process.exitCode = previous;
    }
  });
});

describe('resolveGitDirMounts', () => {
  it('resolves the git directories outside the checkout root', () => {
    const repo = initRepo('semgrep-gitdir-');
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    commitAll(repo, 'base');

    const mounts = resolveGitDirMounts(repo);

    expect(mounts.ok).toBe(true);
    // Clone thường: `.git` nằm trong root nên đã được `/src` phủ; không mount lại.
    expect(mounts.ok && mounts.dirs).toEqual([]);
  });

  it('resolves the main git directory for a linked worktree', () => {
    // Đây là hình dạng đã gây lỗi thật: `.git` của worktree là một file trỏ tới
    // `<main>/.git/worktrees/<id>`, nằm ngoài checkout. Test tạo worktree thật
    // bằng git thay vì giả lập, vì điều đang kiểm là git trả gì.
    const repo = initRepo('semgrep-gitwt-');
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    commitAll(repo, 'base');
    const worktree = join(process.env.SEMGREP_TEST_TMP ?? '/tmp', `semgrep-wt-${process.pid}`);
    rmSync(worktree, { recursive: true, force: true });
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'wt');

    try {
      const mounts = resolveGitDirMounts(worktree);

      expect(mounts.ok).toBe(true);
      // Một mount cho common dir là đủ: nó chứa `worktrees/<id>/`.
      expect(mounts.ok && mounts.dirs).toEqual([join(repo, '.git')]);
    } finally {
      git(repo, 'worktree', 'remove', '--force', worktree);
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('fails closed when git cannot resolve the directories', () => {
    const dir = join(process.env.SEMGREP_TEST_TMP ?? '/tmp', `semgrep-nogit-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      const mounts = resolveGitDirMounts(dir);

      expect(mounts.ok).toBe(false);
      expect(mounts.ok === false && mounts.reason).toContain('git could not resolve');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
