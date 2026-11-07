import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkScanRange, resolveScanScope } from './gitleaks-scope.js';
import { gitEnv } from '../utils.js';

const DX_ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOW = resolve(DX_ROOT, '../../.github/workflows/code-analysis.yml');
const GATE_ACTION = resolve(DX_ROOT, '../../.github/actions/aggregate-gate/action.yml');

/**
 * Checksum của binary gitleaks đúng phiên bản CI dùng.
 *
 * Test chạy binary THẬT chứ không mô phỏng: các hành vi quan trọng nhất ở đây —
 * range rỗng trả exit 0, SHA sai trả exit 0 — đều là chi tiết của chính binary,
 * và một bản mô phỏng chỉ chứng minh được bản thân nó.
 */
const GITLEAKS_VERSION = '8.30.1';
const GITLEAKS_SHA256 = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';
const GITLEAKS_URL = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;

/**
 * Hai nửa của từ khoá PEM, ghép lại lúc chạy.
 *
 * Source cố tình không chứa bất kỳ chuỗi `-----BEGIN`/`-----END` hoàn chỉnh
 * nào: rule `private-key` của gitleaks quét theo *dòng*, ghép một dòng `BEGIN`
 * với một dòng `END` nào đó ở dưới rồi bắt phần *giữa hai dòng*. Giữ token ở
 * dạng vừa đủ để ghép lại nghĩa là các fixture dưới đây tái dựng đúng PEM ở
 * runtime mà không tự sinh ra một cặp khóa giả ngay trong file này.
 */
const BEGIN_MARKER = ['BEGIN'].join(' ');
const END_MARKER = ['END'].join(' ');

/** Header PEM một dòng, dựng từ marker + label. */
function header(label: string): string {
  return `-----${BEGIN_MARKER} ${label}-----`;
}

/** Khối PEM nhiều dòng, dựng từ marker + label + body. */
function pem(label: string, body: string): string {
  return `${header(label)}\\n${body}\\n-----${END_MARKER} ${label}-----`;
}

/**
 * Khóa RSA hợp lệ về mặt cú pháp, sinh cho test này và không có giá trị.
 *
 * Chuỗi `BEGIN`/`END` được ghép từ marker ở trên thay vì viết literal. Lý do
 * không phải thẩm mỹ: một header `BEGIN` trần (fixture ReDoS chẳng hạn) sẽ ăn
 * cặp với `END` của khối PEM nào đứng trước nó trong cùng file. Đó chính là cơ
 * chế sinh ra false positive mà issue #177 nêu — và chính file test này dínng nó
 * nếu viết literal. Ghép từ marker giữ nội dung runtime y hệt mà không để lại
 * cặp `BEGIN`/`END` nào trong source.
 *
 * Chỉ dùng trong repo tạm dưới `/tmp`; không bao giờ đưa vào lịch sử repo thật —
 * đó chính là loại nội dung mà job gitleaks phải bắt.
 */
const FAKE_RSA_KEY = [
  `-----${BEGIN_MARKER} RSA PRIVATE KEY-----`,
  'MIIEowIBAAKCAQEAmZfakefakefakefakefakefakefakefakefakefakefakefake',
  `-----${END_MARKER} RSA PRIVATE KEY-----`,
  '',
].join('\n');

/**
 * Fixture PEM dùng để dựng lại hành vi false positive mà issue #177 nêu.
 *
 * Ba fixture này là nguyên nhân thật (xem `describe` bên dưới). Chúng phải giữ
 * nguyên giá trị runtime — đó là điều test của PR #175 khẳng định — nên ở đây
 * chúng cũng được dựng từ mảnh, với lý do kỹ thuật giống `FAKE_RSA_KEY` ở trên.
 */
const FIXTURE_SEC1 = pem('EC PRIVATE KEY', 'MHcCAQEE');
const FIXTURE_MALFORMED = pem('PRIVATE KEY', 'khong-phai-base64-hop-le');
const FIXTURE_REDOS = `${header('PRIVATE KEY')}\n`.repeat(4);

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);

  return dir;
}

/** Git trong repo tạm, với `GIT_*` scrub để không ghim vào repo workspace. */
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() });
}

/**
 * File chứa đúng ba fixture như test của PR #175, nguyên bản.
 *
 * Ba chuỗi literal này là nguyên nhân thật của false positive (xem describe bên
 * dưới): rule `private-key` ghép một dòng `BEGIN` với một dòng `END` ở dưới nó,
 * nên khối PEM và chuỗi header lặp của test ReDoS trong cùng file trở thành một
 * cặp "khóa" giả.
 */
function writeFixtureFile(repo: string): void {
  writeFile(
    repo,
    'signing-key.spec.ts',
    [
      "describe('SigningKeyProvider.fromPem', () => {",
      "  it('rejects a non-PKCS#8 key', async () => {",
      `    const pem = '${FIXTURE_SEC1}';`,
      '  });',
      "  it('rejects a malformed PEM', async () => {",
      `    const pem = '${FIXTURE_MALFORMED}';`,
      '  });',
      "  it('never backtracks catastrophically', () => {",
      `    const hostile = '${FIXTURE_REDOS}'.repeat(4);`,
      '  });',
      '});',
      '',
    ].join('\n'),
  );
}

function initRepo(prefix = 'gl-repo-'): string {
  const repo = tempDir(prefix);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'gitleaks-test@example.com');
  git(repo, 'config', 'user.name', 'gitleaks test');
  git(repo, 'config', 'commit.gpgsign', 'false');

  return repo;
}

/** Commit mọi thay đổi đang có; trả về SHA của commit vừa tạo. */
function commitAll(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--no-verify', '-m', message);

  return git(repo, 'rev-parse', 'HEAD').trim();
}

function writeFile(repo: string, name: string, contents: string): void {
  writeFileSync(join(repo, name), contents, 'utf8');
}

/** Repo tạm với một commit nền; trả về `{ repo, base }`. */
function repoWithBase(): { repo: string; base: string } {
  const repo = initRepo();
  writeFile(repo, 'README.md', 'base\n');
  const base = commitAll(repo, 'base');

  return { repo, base };
}

/* -------------------------------------------------------------------------- */
/*  Binary gitleaks thật                                                       */
/* -------------------------------------------------------------------------- */

let gitleaks: string;
let gitleaksUnavailable: string | undefined;

/** Tải binary đúng phiên bản CI, kiểm checksum, giải nén ra cache. */
function installGitleaks(): string | undefined {
  const cache = join(DX_ROOT, '../../node_modules/.cache/gitleaks-test');
  const binary = join(cache, 'gitleaks');

  if (existsSync(binary)) {
    return binary;
  }

  mkdirSync(cache, { recursive: true });
  const archive = join(cache, 'gitleaks.tar.gz');

  const download = spawnSync(
    'curl',
    ['--fail', '--silent', '--show-error', '--location', GITLEAKS_URL, '--output', archive],
    { encoding: 'utf8', timeout: 120_000 },
  );

  if (download.status !== 0) {
    gitleaksUnavailable = `curl could not download gitleaks: ${download.stderr.trim()}`;

    return undefined;
  }

  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (digest !== GITLEAKS_SHA256) {
    gitleaksUnavailable = `gitleaks ${GITLEAKS_VERSION} archive has checksum ${digest}, expected ${GITLEAKS_SHA256}`;

    return undefined;
  }

  const extracted = spawnSync(
    'tar',
    ['--extract', '--gzip', '--file', archive, '--directory', cache, 'gitleaks'],
    {
      encoding: 'utf8',
    },
  );
  if (extracted.status !== 0) {
    gitleaksUnavailable = `tar could not extract gitleaks: ${extracted.stderr.trim()}`;

    return undefined;
  }

  return binary;
}

interface ScanOutcome {
  status: number | null;
  /** `leaks found: N` hay `no leaks found`, chính là verdict của binary. */
  verdict: string;
  stdout: string;
}

/**
 * Chạy đúng lệnh CI chạy: `gitleaks detect` với `--log-opts` đã resolve,
 * cấu hình bị ghim về bộ rule mặc định, và `.gitleaksignore` bị gỡ khỏi
 * worktree — hai biện pháp chống việc PR tự tắt rule của chính nó.
 */
function scan(repo: string, logOpts: string): ScanOutcome {
  rmSync(join(repo, '.gitleaksignore'), { force: true });

  const result = spawnSync(
    gitleaks,
    [
      'detect',
      `--source=${repo}`,
      `--log-opts=${logOpts}`,
      '--redact',
      '--exit-code=2',
      '--report-format=json',
      `--report-path=${join(repo, 'findings.json')}`,
      '--no-banner',
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      // Bắt đầu từ env ĐÃ scrub, không phải `process.env`: spread `gitEnv()` vào
      // sau `process.env` chỉ ghi đè key trùng, không xoá được `GIT_DIR` mà
      // lefthook export lúc pre-push — binary gitleaks sẽ ghim vào repo workspace
      // thay vì repo tạm, và mọi test thật ở dưới fail (exit 0 thay vì 2).
      env: { ...gitEnv(), GITLEAKS_CONFIG_TOML: '[extend]\nuseDefault = true\n' },
    },
  );

  const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const verdict =
    /leaks found: (\d+)/u.exec(stdout)?.[0] ??
    (/no leaks found/u.test(stdout) ? 'no leaks found' : 'unrecognized');

  return { status: result.status, verdict, stdout };
}

/** Số finding trong report JSON mà binary vừa ghi. */
function findingCount(repo: string): number {
  const path = join(repo, 'findings.json');
  if (!existsSync(path)) {
    return 0;
  }

  return (JSON.parse(readFileSync(path, 'utf8')) as unknown[]).length;
}

beforeAll(() => {
  const installed = installGitleaks();

  // Không hạ xuống "bỏ qua assert" được: một test bỏ qua im lặng chính là
  // false positive mà issue #177 đang xử lý. Thiếu binary thì phải đỏ, và nói
  // rõ là lỗi môi trường chứ không phải hành vi của gitleaks.
  if (!installed) {
    throw new Error(`these tests need the pinned gitleaks binary: ${gitleaksUnavailable}`);
  }

  gitleaks = installed;
}, 300_000);

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */

describe('resolveScanScope', () => {
  it('scans only the commits a pull request adds', () => {
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);

    const result = resolveScanScope({
      eventName: 'pull_request',
      baseSha: base,
      headSha: head,
    });

    expect(result).toEqual({
      ok: true,
      scope: { logOpts: `${base}..${head}`, description: 'the commits this pull request adds' },
    });
  });

  it('rejects a pull request whose SHAs are missing or are not full commit ids', () => {
    for (const env of [
      { eventName: 'pull_request', headSha: 'b'.repeat(40) },
      { eventName: 'pull_request', baseSha: 'a'.repeat(40) },
      { eventName: 'pull_request', baseSha: 'main', headSha: 'b'.repeat(40) },
      { eventName: 'pull_request', baseSha: 'a'.repeat(40), headSha: 'HEAD' },
    ]) {
      expect(resolveScanScope(env).ok).toBe(false);
    }
  });

  it('scans only the commits a push adds', () => {
    const before = 'a'.repeat(40);
    const after = 'b'.repeat(40);

    const result = resolveScanScope({ eventName: 'push', before, after });

    expect(result.ok).toBe(true);
    expect(result.ok && result.scope.logOpts).toBe(`${before}..${after}`);
  });

  it('falls back to full history when a push has no previous commit', () => {
    // Branch vừa tạo: `before` là toàn số 0, và `git log 000…0..HEAD` lỗi.
    for (const before of ['0'.repeat(40), undefined]) {
      const result = resolveScanScope({ eventName: 'push', before, after: 'b'.repeat(40) });

      expect(result.ok && result.scope.logOpts).toBe('--all');
    }
  });

  it('keeps scheduled and manual runs scanning the full history', () => {
    for (const eventName of ['schedule', 'workflow_dispatch']) {
      const result = resolveScanScope({ eventName });

      expect(result.ok && result.scope.logOpts).toBe('--all');
    }
  });

  it('refuses to guess a scope for an event it does not model', () => {
    // `merge_group` phải bị job bỏ qua, không phải được quét âm thầm bằng
    // một range mà không ai định nghĩa.
    for (const eventName of ['merge_group', 'unknown', undefined]) {
      expect(resolveScanScope({ eventName }).ok).toBe(false);
    }
  });
});

describe('checkScanRange', () => {
  it('accepts a range with commits', () => {
    const { repo, base } = repoWithBase();
    writeFile(repo, 'a.txt', 'more\n');
    const head = commitAll(repo, 'second');

    const scope = resolveScanScope({ eventName: 'pull_request', baseSha: base, headSha: head });

    expect(scope.ok && checkScanRange(scope.scope, repo)).toEqual({ ok: true, commits: 1 });
  });

  it('fails closed on an empty range instead of reporting a clean scan', () => {
    // Gitleaks 8.30.1 trả exit 0 cho range rỗng. Nếu ta im lặng, một lần quét
    // rỗng sẽ thành một `analysis-gate` xanh mà không có gì được quét.
    const { repo, base } = repoWithBase();
    const head = base;

    const result = checkScanRange({ logOpts: `${base}..${head}`, description: 'empty' }, repo);

    expect(result.ok).toBe(false);
  });

  it('fails closed on a range git cannot resolve', () => {
    // Cùng lý do: SHA không có trong checkout cho exit 0 và "0 commits scanned".
    const { repo, base } = repoWithBase();

    const result = checkScanRange(
      { logOpts: `${'0'.repeat(40)}..${base}`, description: 'bogus' },
      repo,
    );

    expect(result.ok).toBe(false);
  });

  it('accepts full history when the checkout has commits', () => {
    const { repo } = repoWithBase();

    expect(checkScanRange({ logOpts: '--all', description: 'full' }, repo).ok).toBe(true);
  });
});

describe('gitleaks scan scope', () => {
  it('does not fail a clean pull request over a secret in an unrelated branch', () => {
    const repo = initRepo();
    writeFile(repo, 'README.md', 'base\n');
    const base = commitAll(repo, 'base');

    // Nhánh hoàn toàn không liên quan mang secret.
    git(repo, 'checkout', '-q', '-b', 'unrelated-branch');
    writeFile(repo, 'keys.txt', `${FAKE_RSA_KEY}\n`);
    commitAll(repo, 'unrelated secret');
    git(repo, 'checkout', '-q', 'main');

    // PR sạch: chỉ thêm một file vô hại.
    git(repo, 'checkout', '-q', '-b', 'pr-branch');
    writeFile(repo, 'feature.txt', 'harmless\n');
    const head = commitAll(repo, 'harmless change');

    const scoped = resolveScanScope({ eventName: 'pull_request', baseSha: base, headSha: head });
    expect(scoped.ok).toBe(true);
    const outcome = scan(repo, scoped.ok ? scoped.scope.logOpts : '');

    expect(outcome.verdict).toBe('no leaks found');

    // Bảo đảm test này có ý nghĩa: phạm vi cũ (`--all`) thật sự đỏ.
    expect(scan(repo, '--all').status).toBe(2);
  });

  it('fails a pull request that introduces a detectable private key', () => {
    const repo = initRepo();
    writeFile(repo, 'README.md', 'base\n');
    const base = commitAll(repo, 'base');

    git(repo, 'checkout', '-q', '-b', 'pr-branch');
    writeFile(repo, 'leak.txt', `${FAKE_RSA_KEY}\n`);
    const head = commitAll(repo, 'add key');

    const scoped = resolveScanScope({ eventName: 'pull_request', baseSha: base, headSha: head });
    const outcome = scan(repo, scoped.ok ? scoped.scope.logOpts : '');

    expect(outcome.status).toBe(2);
    expect(findingCount(repo)).toBe(1);
  });

  it('keeps scanning the temp repo when a hook leaves GIT_DIR in the environment', () => {
    // lefthook export GIT_DIR lúc pre-push; nếu env không được scrub đúng thì
    // binary gitleaks đọc repo workspace thay vì repo tạm — sáu test thật trong
    // describe này từng fail đúng kiểu đó. Tự set biến để tái hiện đủ điều kiện
    // ngay cả khi chạy ngoài hook.
    const repo = initRepo();
    writeFile(repo, 'README.md', 'base\n');
    commitAll(repo, 'base');
    writeFile(repo, 'leak.txt', `${FAKE_RSA_KEY}\n`);
    commitAll(repo, 'add key');

    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(repo, '.git-does-not-exist');
    try {
      expect(scan(repo, 'HEAD~1..HEAD').status).toBe(2);
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previous;
      }
    }
  });

  it('detects a secret introduced by a push range', () => {
    const repo = initRepo();
    writeFile(repo, 'README.md', 'base\n');
    const before = commitAll(repo, 'base');

    writeFile(repo, 'leak.txt', `${FAKE_RSA_KEY}\n`);
    const after = commitAll(repo, 'add key');

    const scoped = resolveScanScope({ eventName: 'push', before, after });
    expect(scoped.ok).toBe(true);
    const outcome = scan(repo, scoped.ok ? scoped.scope.logOpts : '');

    expect(outcome.status).toBe(2);
  });

  it('does not report a clean scan over a range that resolves to nothing', () => {
    const { repo, base } = repoWithBase();
    writeFile(repo, 'second.txt', 'second\n');
    const head = commitAll(repo, 'second commit');

    const bogus = resolveScanScope({
      eventName: 'pull_request',
      baseSha: '0'.repeat(40),
      headSha: head,
    });

    expect(bogus.ok).toBe(true);
    // Chính binary: range không tồn tại vẫn ra exit 0. Vì vậy `checkScanRange`
    // phải chặn trước, và đây là bằng chứng cho lý do đó.
    expect(scan(repo, bogus.ok ? bogus.scope.logOpts : '').status).toBe(0);
    expect(
      checkScanRange(bogus.ok ? bogus.scope : { logOpts: '--all', description: '' }, repo).ok,
    ).toBe(false);
    expect(base).not.toBe(head);
  });
});

describe('gitleaks false positive from the intentional PEM fixtures', () => {
  it('reproduces the false positive and clears it without weakening detection', () => {
    const repo = initRepo();
    writeFile(repo, 'README.md', 'base\n');
    const base = commitAll(repo, 'base');

    // Bản gốc: cả ba fixture dạng literal trong một file.
    writeFixtureFile(repo);
    const withFixtures = commitAll(repo, 'fixtures as written');

    expect(scan(repo, `${base}..${withFixtures}`).status).toBe(2);

    // Bản đã gộp label: không còn chuỗi literal `BEGIN … PRIVATE KEY` nào.
    writeFile(
      repo,
      'signing-key.spec.ts',
      [
        'function invalidSec1Pem(): string {',
        "  const label = 'EC PRIVATE KEY';",
        '  return `-----BEGIN ${label}-----\\nMHcCAQEE\\n-----END ${label}-----`;',
        '}',
        'function malformedPkcs8Pem(): string {',
        "  const label = 'PRIVATE KEY';",
        '  return `-----BEGIN ${label}-----\\nkhong-phai-base64-hop-le\\n-----END ${label}-----`;',
        '}',
        'const hostileLabel = "PRIVATE KEY";',
        'const hostile = `-----BEGIN ${hostileLabel}-----\\n`.repeat(4);',
        '',
      ].join('\n'),
    );
    const withFix = commitAll(repo, 'fixtures with labels');

    expect(scan(repo, `${withFixtures}..${withFix}`).verdict).toBe('no leaks found');

    // Và cùng cây đó vẫn phải bắt được khóa thật.
    writeFile(repo, 'real-key.txt', `${FAKE_RSA_KEY}\n`);
    const withKey = commitAll(repo, 'a genuine key');

    expect(scan(repo, `${withFix}..${withKey}`).status).toBe(2);
  });
});

describe('gitleaks must trust its own rules, not the pull request', () => {
  it('does not let a pull request whitelist its own secret', () => {
    const repo = initRepo();
    writeFile(repo, 'README.md', 'base\n');
    const base = commitAll(repo, 'base');
    writeFile(repo, 'leak.txt', `${FAKE_RSA_KEY}\n`);
    const head = commitAll(repo, 'add key');

    // Fingerprint mà gitleaks sẽ gán cho finding này.
    const first = scan(repo, `${base}..${head}`);
    expect(first.status).toBe(2);
    const fingerprint = (
      JSON.parse(readFileSync(join(repo, 'findings.json'), 'utf8')) as {
        Fingerprint: string;
      }[]
    )[0].Fingerprint;

    // PR tự thêm `.gitleaksignore` chứa đúng fingerprint đó.
    writeFile(repo, '.gitleaksignore', `${fingerprint}\n`);
    commitAll(repo, 'ignore my own finding');

    // Chính lệnh CI chạy (đã ghim config, đã gỡ file khỏi worktree) vẫn đỏ.
    expect(scan(repo, `${base}..HEAD`).status).toBe(2);
  });

  it('does not let a pull request disable the private-key rule', () => {
    const repo = initRepo();
    writeFile(repo, 'README.md', 'base\n');
    const base = commitAll(repo, 'base');
    writeFile(repo, 'leak.txt', `${FAKE_RSA_KEY}\n`);
    writeFile(repo, '.gitleaks.toml', '[extend]\ndisableRules = ["private-key"]\n');
    commitAll(repo, 'add key and a config that hides it');

    expect(scan(repo, `${base}..HEAD`).status).toBe(2);
  });
});

describe('workflow wiring', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');

  it('passes the resolved scope to gitleak-ci instead of scanning every ref', () => {
    expect(workflow).toContain('--git-log-opts="$SCAN_LOG_OPTS"');

    // `--all` chỉ được dành cho audit lịch sử, không phải mặc định của PR.
    const scanStep = workflow.slice(workflow.indexOf('Scan for secrets'));
    expect(scanStep.slice(0, scanStep.indexOf('Upload the findings'))).not.toMatch(/^ +--all/mu);
  });

  it('keeps the pinned version, checksum, redaction and SARIF reporting', () => {
    // Bước cài binary gitleaks đã được gỡ: gitleak-ci đọc image từ lock file.
    expect(workflow).toContain('pnpm dx gitleak-ci --git-log-opts="$SCAN_LOG_OPTS"');
    expect(workflow).not.toContain(`gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`);
    expect(workflow).not.toContain(GITLEAKS_SHA256);

    // gitleak-ci.ts giữ fail-closed, redaction, SARIF reporting và exit-code=2.
    const gitleakCi = readFileSync(resolve(DX_ROOT, 'src/security/gitleak-ci.ts'), 'utf8');
    expect(gitleakCi).toContain('--redact');
    expect(gitleakCi).toContain('--report-format=sarif');
    expect(gitleakCi).toContain('--exit-code=2');
  });

  it('keeps gitleaks as a dependency of analysis-gate', () => {
    expect(workflow).toMatch(/analysis-gate:[\s\S]*needs: \[[^\]]*gitleaks/u);
  });

  it('still skips the analysis jobs for merge_group and says so in the gate', () => {
    // merge_group bị skip có chủ ý; gate phải nói rõ là skip chứ không báo xanh
    // như thể đã quét.
    expect(workflow).toMatch(/gitleaks:[\s\S]*?if: github\.event_name != 'merge_group'/u);
    expect(workflow).toContain('Analysis intentionally skipped for merge_group');
  });

  it('keeps the gate strict about anything other than success', () => {
    const gate = readFileSync(GATE_ACTION, 'utf8');

    expect(gate).toContain('if [ -z "$RESULTS" ]');
    expect(gate).toContain('if [ "$result" != "success" ]');
  });
});
