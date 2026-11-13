import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DX_ROOT = resolve(import.meta.dirname, '../..');
const REPO_ROOT = resolve(DX_ROOT, '../..');
const LEFTHOOK = join(REPO_ROOT, 'lefthook.yml');
const CODE_ANALYSIS = join(REPO_ROOT, '.github/workflows/code-analysis.yml');
const RENOVATE = join(REPO_ROOT, '.github/renovate.json');

/**
 * Image và script gate phải là ĐÚNG CÁI hook lẫn CI đang chạy.
 *
 * Từ issue #217, scanner không còn đi qua `security-tools.lock.json` nữa: image
 * được ghim theo digest ngay tại nơi gọi, trong `lefthook.yml` và
 * `code-analysis.yml`. Ghim ở hai nơi tạo ra rủi ro mới — nâng một bên quên
 * bên kia thì một phía vẫn kiểm bộ rule cũ mà không ai biết. Suite này đọc cả
 * hai file và assert chúng bằng nhau, nên mọi sự lệch là đỏ ngay trong PR.
 */
const PIN_PATTERN = /(zricethezav\/gitleaks|semgrep\/semgrep):([^@"'\s]+)@(sha256:[0-9a-f]{64})/gu;

/** Bỏ dòng comment để assert phủ định chỉ nhìn lệnh thật, không nhìn chú thích. */
function commands(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * Regex phạm vi file của hook pre-push, đọc từ chính `lefthook.yml`.
 *
 * Trước đây danh sách extension nằm trong `semgrep-scan.ts` và được unit test
 * trực tiếp; nay nó là một chuỗi shell trong YAML, nên test đọc chuỗi đó và
 * biên dịch thành RegExp để assert hành vi accept/reject.
 */
function scannablePattern(): RegExp {
  const hook = readFileSync(LEFTHOOK, 'utf8');
  const match = hook.match(/scannable_pattern='([^']+)'/u);
  expect(match, 'lefthook pre-push must define scannable_pattern').not.toBeNull();
  return new RegExp(match?.[1] ?? '', 'u');
}

/** Ghim image đọc trực tiếp từ `lefthook.yml` — source of truth của hook. */
function pinsInLefthook(): { image: string; dep: string }[] {
  const hook = readFileSync(LEFTHOOK, 'utf8');
  return [...hook.matchAll(PIN_PATTERN)].map((match) => ({
    image: `${match[1]}:${match[2]}@${match[3]}`,
    dep: match[1] ?? '',
  }));
}

/** Ghim image đọc trực tiếp từ `code-analysis.yml` — source of truth của CI. */
function pinsInWorkflow(): { image: string; dep: string }[] {
  const workflow = readFileSync(CODE_ANALYSIS, 'utf8');
  return [...workflow.matchAll(PIN_PATTERN)].map((match) => ({
    image: `${match[1]}:${match[2]}@${match[3]}`,
    dep: match[1] ?? '',
  }));
}

describe('security tool pins', () => {
  it('pins gitleaks and semgrep identically in lefthook.yml and code-analysis.yml', () => {
    // "Push xanh ở local là bằng chứng cho CI xanh" chỉ đúng khi hai nơi chạy
    // cùng một image. Mỗi dep phải xuất hiện ở cả hai file với cùng chuỗi pin.
    const hook = pinsInLefthook();
    const workflow = pinsInWorkflow();
    for (const dep of ['zricethezav/gitleaks', 'semgrep/semgrep']) {
      const hookImages = new Set(hook.filter((pin) => pin.dep === dep).map((pin) => pin.image));
      const workflowImages = new Set(
        workflow.filter((pin) => pin.dep === dep).map((pin) => pin.image),
      );
      expect(hookImages.size, `${dep} should be pinned in lefthook.yml`).toBe(1);
      expect(workflowImages.size, `${dep} should be pinned in code-analysis.yml`).toBe(1);
      expect([...hookImages], `${dep} must use the same tag+digest in both files`).toEqual([
        ...workflowImages,
      ]);
    }
  });

  it('keeps the Renovate regex manager pointed at exactly the two pinning files', () => {
    // Renovate là cơ chế bump phiên bản duy nhất còn lại sau khi xoá lock file;
    // nếu `managerFilePatterns` lệch khỏi nơi pin thực sự nằm thì bump im lặng
    // không diễn ra nữa — không có test nào khác phát hiện điều đó.
    const renovate = JSON.parse(readFileSync(RENOVATE, 'utf8')) as {
      customManagers?: {
        customType?: string;
        managerFilePatterns?: string[];
        matchStrings?: string[];
        datasourceTemplate?: string;
        versioningTemplate?: string;
      }[];
    };
    const manager = (renovate.customManagers ?? []).find((m) => m.customType === 'regex');
    expect(manager).toBeDefined();
    expect(manager?.managerFilePatterns).toEqual([
      '/^(lefthook\\.yml|\\.github\\/workflows\\/code-analysis\\.yml)$/',
    ]);
    // Pattern của mỗi entry phải khớp đúng hai file đó và KHÔNG khớp file khác
    // (kẻo Renovate quét một YAML nào đó chứa chuỗi image ngẫu nhiên).
    const patterns = (manager?.managerFilePatterns ?? []).map((raw) => {
      expect(raw.startsWith('/')).toBe(true);
      return new RegExp(raw.slice(1, -1), 'u');
    });
    const matches = (path: string): boolean => patterns.some((p) => p.test(path));
    expect(matches('lefthook.yml')).toBe(true);
    expect(matches('.github/workflows/code-analysis.yml')).toBe(true);
    for (const path of [
      '.github/workflows/ci.yaml',
      'lefthook.lock',
      'apps/foo/lefthook.yml',
      'tools/dx/README.md',
    ]) {
      expect(matches(path), `${path} must not be scanned by the regex manager`).toBe(false);
    }
    expect(manager?.datasourceTemplate).toBe('docker');
    expect(manager?.versioningTemplate).toBe('docker');
  });

  it('lets the Renovate matchStrings find every pin currently in the two files', () => {
    // Mô phỏng đúng những gì Renovate làm: chạy `matchStrings` lên nội dung file
    // và thu depName/currentValue/currentDigest. Một pin viết theo cú pháp mà
    // regex không bắt được (vd. đổi tag, thêm tham số giữa image và digest) sẽ
    // được bump ở một nơi và bỏ sót ở nơi kia — test này đỏ trước khi PR bump.
    const renovate = JSON.parse(readFileSync(RENOVATE, 'utf8')) as {
      customManagers?: { matchStrings?: string[] }[];
    };
    const matchStrings = (renovate.customManagers ?? []).flatMap((m) => m.matchStrings ?? []);
    expect(matchStrings).toHaveLength(1);
    const renovateRegex = new RegExp(matchStrings[0] ?? '', 'gu');
    for (const [file, pins] of [
      ['lefthook.yml', pinsInLefthook()],
      ['.github/workflows/code-analysis.yml', pinsInWorkflow()],
    ] as const) {
      const content = readFileSync(join(REPO_ROOT, file), 'utf8');
      const found = [...content.matchAll(renovateRegex)].map(
        (m) =>
          `${m.groups?.['depName']}:${m.groups?.['currentValue']}@${m.groups?.['currentDigest']}`,
      );
      expect(
        new Set(found),
        `Renovate must see the same pins in ${file} as this spec does`,
      ).toEqual(new Set(pins.map((pin) => pin.image)));
    }
    // Hai packageRule nhóm update của image bảo mật vẫn phải trỏ đúng hai dep —
    // gỡ nhầm rule là bump tách PR hoặc mất review bảo mật bắt buộc.
    const rules = JSON.parse(readFileSync(RENOVATE, 'utf8')) as {
      packageRules?: { matchManagers?: string[]; matchPackageNames?: string[] }[];
    };
    const grouped = (rules.packageRules ?? []).filter((rule) =>
      (rule.matchPackageNames ?? []).includes('zricethezav/gitleaks'),
    );
    expect(grouped.length).toBeGreaterThanOrEqual(1);
    for (const rule of grouped) {
      expect(rule.matchManagers).toContain('custom.regex');
      expect(rule.matchPackageNames).toContain('semgrep/semgrep');
    }
  });
});

describe('semgrep scan scope', () => {
  it('treats only the extensions the rules actually scan as in scope', () => {
    // Đây là phép đo, không phải phỏng đoán: các extension ngoài danh sách dưới
    // đây ĐÃ THỬ CỐ TÌNH và cho 0 finding trên engine thật (xem
    // `semgrep-rule-coverage.spec.ts` chạy engine thật để ghim chiều ngược lại).
    // Thêm extension rỗng vào danh sách thì hook tốn thời gian quét rồi không
    // tìm được gì; bỏ thiếu extension thì file đổi không kích hoạt gate.
    const pattern = scannablePattern();
    for (const path of [
      'apps/foo/src/a.ts',
      'apps/foo/src/a.tsx',
      '.github/workflows/ci.yml',
      'apps/foo/ci.yaml',
      'apps/foo/wrangler.jsonc',
    ]) {
      expect(pattern.test(path), `${path} must be in scan scope`).toBe(true);
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
      expect(pattern.test(path), `${path} must be out of scan scope`).toBe(false);
    }
  });
});

describe('wiring', () => {
  const hook = readFileSync(LEFTHOOK, 'utf8');
  const workflow = readFileSync(CODE_ANALYSIS, 'utf8');
  // Các assert phủ định (không được chứa X) phải nhìn vào lệnh thật, không nhìn
  // vào comment — chính các comment trong hook giải thích ràng buộc bằng cách
  // trích `-v …:ro` và `-e GIT_DIR` làm ví dụ lỡ khớp regex phủ định.
  const prePush = commands(hook.slice(hook.indexOf('pre-push:')));
  const preCommit = hook.slice(0, hook.indexOf('pre-push:'));
  const wfCommands = commands(workflow);

  it('tests the rules against their fixtures before a commit that touches the rules', () => {
    // `semgrep --test` chỉ hữu ích nếu hook thật sự chạy nó khi bộ rule đổi;
    // một lệnh đúng nhưng không nối vào đâu là một lệnh không chạy.
    expect(preCommit).toContain("glob: '.github/semgrep/**'");
    expect(preCommit).toContain('semgrep --test --config .github/semgrep .github/semgrep');
  });

  it('runs the pre-push semgrep scan with the same gate and scope rules as CI', () => {
    // Hai nơi phải dùng chung một điểm chế: gate `filter-accepted.py` và lệnh
    // scan không bao giờ bị thu hẹp theo file (gate fail-closed hai chiều — quét
    // một tập con làm entry allowlist trở nên stale và đỏ một cách giả tạo).
    for (const token of [
      'semgrep scan --config .github/semgrep --exclude .github/semgrep --timeout 60',
      'filter-accepted.py gate',
    ]) {
      expect(prePush, `pre-push must contain: ${token}`).toContain(token);
      expect(wfCommands, `code-analysis.yml must contain: ${token}`).toContain(token);
    }
    // Scan luôn quét toàn repo ở cả hai nơi — không có cờ giới hạn file nào.
    expect(prePush).not.toMatch(/semgrep scan[^\n]*--include/u);
  });

  it('keeps the pre-push skip condition fail-open against origin/HEAD', () => {
    // Điều kiện skip chỉ quyết định CÓ chạy hay không, không bao giờ thu hẹp
    // phạm vi; base không diff được phải rơi vào quét toàn bộ chứ không phải
    // "không có gì đổi" — hiểu ngược lại là im lặng bỏ gate.
    expect(prePush).toContain("git diff --name-only 'origin/HEAD..HEAD'");
    expect(prePush).toContain('Falling back to a full scan');
    expect(prePush).toContain('Semgrep scan skipped');
  });

  it('mounts the source at /src and the git directory read-only through --mount', () => {
    // Mount chỗ khác thì semgrep ném `Detected Docker environment without a code
    // volume`. Git dir phải qua `--mount type=bind,…,readonly` vì `-v
    // <dir>:<dir>:ro` mount ra rỗng 10/10 lần trên Docker 29.5.3 rootless — cả
    // hai đều là điều kiện đã đo, không phải lựa chọn style.
    expect(prePush).toContain('--volume "$root:/src"');
    expect(wfCommands).toContain('--volume "$GITHUB_WORKSPACE:/src"');
    expect(prePush).toContain('--mount type=bind,src=$d,dst=$d,readonly');
    expect(prePush).not.toMatch(/-v [^\n]*:[^\n]*:ro/u);
  });

  it('does not pass GIT_* environment into the semgrep container', () => {
    // Truyền GIT_DIR trỏ ra ngoài container làm semgrep quét cả các worktree
    // khác → hàng chục finding giả. Ngược lại, hook phải tự scrub GIT_* mà
    // lefthook export trước khi gọi git — lại là điều kiện hook thật.
    expect(prePush).toContain('unset GIT_DIR');
    expect(prePush).not.toMatch(/--env ['"]?GIT_/u);
    expect(prePush).not.toMatch(/-e ['"]?GIT_/u);
    expect(wfCommands).not.toMatch(/--env ['"]?GIT_/u);
  });

  it('resolves the gitleaks scan scope fail-closed before docker runs', () => {
    // gitleaks 8.30.1 trả exit 0 cho cả range rỗng lẫn range không tồn tại, tức
    // "quét sai phạm vi" và "không có secret" cùng ra một tín hiệu xanh. CI phải
    // xác minh range có commit bằng `git rev-list --count` TRƯỚC khi scanner chạy.
    const scope = commands(
      workflow.slice(
        workflow.indexOf('Resolve the scan scope'),
        workflow.indexOf('Scan for secrets'),
      ),
    );
    for (const token of [
      'git rev-list --count',
      'contains no commits',
      '^[0-9a-f]{40}([0-9a-f]{24})?$',
      '^0+$',
      'is not a full commit id',
    ]) {
      expect(scope, `scope resolution must contain: ${token}`).toContain(token);
    }
  });

  it('runs the gitleaks scan with the repository config and no PR-supplied ignore', () => {
    // `GITLEAKS_CONFIG_TOML` ép rule về mặc định của gitleaks (bỏ qua mọi
    // `.gitleaks.toml` PR mang vào); xoá `.gitleaksignore` khỏi worktree là cách
    // chặn còn lại. Exit 2 là tín hiệu "có leak" của gitleaks.
    const scan = commands(workflow.slice(workflow.indexOf('Scan for secrets')));
    for (const token of [
      'rm -f "$GITHUB_WORKSPACE/.gitleaksignore"',
      '--env GITLEAKS_CONFIG_TOML=',
      '--exit-code=2',
      '--log-opts="$SCAN_LOG_OPTS"',
      'dir --config gitleaks.toml',
    ]) {
      expect(scan.includes(token) || prePush.includes(token), `must contain: ${token}`).toBe(true);
    }
    // CI dùng chế độ `detect` với SARIF; hook local dùng chế độ `dir`.
    expect(scan).toContain('detect --source=/repo');
    expect(prePush).toContain('dir --config gitleaks.toml');
    expect(prePush).toContain('--exit-code 1');
  });

  it('declares the workflow files it reads as Nx inputs so a workflow-only change still runs these tests', () => {
    // Các test wiring đọc `code-analysis.yml` và `lefthook.yml` qua
    // `fs.readFileSync` — dependency runtime vô hình với project graph, nên
    // trước khi có `namedInputs` này, một PR chỉ sửa workflow file cho
    // `nx affected` 0 task và test dưới đây không hề chạy ở CI. Assert này đọc
    // lại chính `package.json` của project: nếu ai xoá input (hoặc Nx đổi cách
    // kế thừa `default` ở project level) thì test đỏ ngay trong lần chạy còn lại.
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
    // nghịch hướng (dx đọc deploy source) — bị chặn trong review trước đây.
    expect(inputs).not.toContain('{workspaceRoot}/deploys/backoffice-deploy/index.ts');
    // `{projectRoot}/**/*` phải còn ở đầu: xoá nó là mất toàn bộ source files
    // khỏi hash — test/lint/typecheck sẽ cache-hit sai trên mọi thay đổi code.
    expect(inputs).toContain('{projectRoot}/**/*');
  });
});
