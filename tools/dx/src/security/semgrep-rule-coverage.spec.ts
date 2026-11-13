import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gitEnv } from '../utils.js';

const DX_ROOT = resolve(import.meta.dirname, '../..');
const REPO_ROOT = resolve(DX_ROOT, '../..');
const LEFTHOOK = join(REPO_ROOT, 'lefthook.yml');
/**
 * Mọi thư mục tạm suite này tạo ra, để `afterAll` dọn đúng những gì đã dựng —
 * không dựa vào việc đoán lại tên prefix.
 */
const createdDirs: string[] = [];

/**
 * Image đọc trực tiếp từ `lefthook.yml` — hook là một trong hai nơi chạy engine.
 *
 * Suite này không ghim chuỗi image (việc đó thuộc `security-tool-pins.spec.ts`);
 * nó dùng image mà hook thật sẽ chạy để đảm bảo phép đo độ phủ đúng engine thật.
 */
const SEMGREP_IMAGE =
  readFileSync(LEFTHOOK, 'utf8').match(/'(semgrep\/semgrep:[^']+)'/u)?.[1] ?? '';
if (!SEMGREP_IMAGE) {
  throw new Error('could not read the pinned semgrep image from lefthook.yml');
}

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
  // Suffix random: hai lần chạy song song (hoặc PID được tái sử dụng) không thể
  // chỉ vào cùng một thư mục và xoá repo của test đang chạy.
  const repo = join(
    process.env.SEMGREP_TEST_TMP ?? '/tmp',
    `${prefix}${process.pid}-${randomUUID()}`,
  );
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  createdDirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'semgrep-test@example.com');
  git(repo, 'config', 'user.name', 'semgrep test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  return repo;
}

/** Thư mục bứng SARIF trên host, đăng ký với `afterAll` cùng các repo tạm. */
function makeReportDir(prefix: string): string {
  const dir = join(
    process.env.SEMGREP_TEST_TMP ?? '/tmp',
    `${prefix}${process.pid}-${randomUUID()}`,
  );
  mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

function commitAll(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--no-verify', '-m', message);
  return git(repo, 'rev-parse', 'HEAD').trim();
}

/**
 * Cài bộ rule thật của repository vào một repo tạm.
 *
 * Test chạy đúng rule của repo này chứ không phải rule nhàu, vì điều đang kiểm
 * là "danh sách extension trong điều kiện chạy của hook khớp với cái engine
 * thật quét được" — một rule nhàu sẽ cho khả năng quét khác và kết luận sai.
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

interface Finding {
  rule: string;
  path: string;
  line: number;
}

/** Đọc rule, path, line từ báo cáo SARIF mà lệnh scan ghi ra. */
function summarize(report: string): Finding[] {
  const document = JSON.parse(readFileSync(report, 'utf8')) as {
    runs?: {
      results?: {
        ruleId?: string;
        locations?: {
          physicalLocation?: {
            artifactLocation?: { uri?: string };
            region?: { startLine?: number };
          };
        }[];
      }[];
    }[];
  };
  const results = document.runs?.[0]?.results ?? [];
  const findings: Finding[] = [];
  for (const raw of results) {
    const physical = raw.locations?.[0]?.physicalLocation;
    const uri = physical?.artifactLocation?.uri;
    if (raw.ruleId === undefined || uri === undefined) {
      continue;
    }
    findings.push({
      rule: raw.ruleId,
      path: uri,
      line: physical?.region?.startLine ?? 0,
    });
  }
  return findings;
}

/** Chạy lệnh scan đúng mà hook pre-push và CI dùng (trừ gate), trả về findings. */
function scanRules(repo: string, reportDir: string): Finding[] {
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
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() },
  );
  return summarize(join(reportDir, 'semgrep.sarif'));
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
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/*  Bộ rule thật, chạy bằng engine thật                                          */
/* -------------------------------------------------------------------------- */
describe("the repository's own rules, scanned by the engine the hook runs", () => {
  it('detects a real violation in .ts and .tsx, and in neither .mts nor .cts nor .vue', () => {
    // Bảo đảm danh sách extension trong điều kiện chạy của hook pre-push là ĐÚNG
    // với khả năng thật của engine, chứ không phải với điều ta hy vọng (chiều
    // regex được ghim ở `security-tool-pins.spec.ts`). Cùng một vi phạm, cấy
    // vào từng extension: nếu sau này semgrep bắt đầu quét `.mts`, test này đỏ
    // và buộc phải cập nhật danh sách — đúng hướng, vì lỗ hổng được nói ra thay
    // vì để im.
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
    const reportDir = makeReportDir('semgrep-out-');
    const findings = scanRules(repo, reportDir);
    const hit = (name: string): boolean =>
      findings.some((finding) => finding.path === `apps/probe/src/${name}`);
    // Các extension mà danh sách trong hook hứa là sẽ bắt được.
    expect(hit('a.ts')).toBe(true);
    expect(hit('a.tsx')).toBe(true);
    // Các extension CHƯA được quét. Đây là lỗ hổng đã biết của bộ rule, được
    // ghi thành khẳng định để nó không biến mất trong im lặng: khi rule phủ
    // được chúng, test đỏ và bắt người sửa danh sách + báo lại.
    expect(hit('a.mts')).toBe(false);
    expect(hit('a.cts')).toBe(false);
    expect(hit('a.vue')).toBe(false);
  }, 300_000);

  it('catches the wrangler.jsonc ownership violation through the generic rule', () => {
    // Rule `generic` + `pattern-regex` là lý do `wrangler.jsonc` nằm trong danh
    // sách dù nó không phải `.ts`/`.yml`: không có nó thì một app mới mở D1 mà
    // không sở hữu sẽ lọt khỏi cả hook lẫn CI.
    const repo = initRepo('semgrep-wrangler-');
    installRules(repo);
    mkdirSync(join(repo, 'apps/probe'), { recursive: true });
    writeFileSync(
      join(repo, 'apps/probe/wrangler.jsonc'),
      '{\n  "name": "probe",\n  "database_name": "probe-db"\n}\n',
    );
    commitAll(repo, 'probe');
    const reportDir = makeReportDir('semgrep-wr-');
    const findings = scanRules(repo, reportDir);
    expect(findings.some((finding) => finding.path === 'apps/probe/wrangler.jsonc')).toBe(true);
  }, 300_000);
});
