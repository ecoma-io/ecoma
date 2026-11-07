import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { gitEnv, ROOT_DIR } from '../utils.js';

const PROBE_PATH = resolve(ROOT_DIR, 'tools/dx/scripts/ocr-selection-probe.mjs');
const PIN = '1.12.12';

/**
 * Workflow giả tối thiểu: đúng hai pin mà probe đối chiếu (`OCR_VERSION_PIN` ở
 * bước preflight, `ocr_version` ở input của action). Thiếu hoặc lệch một trong
 * hai thì probe phải từ chối chạy, nên fixture chỉnh được từng vế. `quotePin` và
 * `pinComment` chỉnh cách viết YAML quanh giá trị — một thay đổi YAML hợp lệ,
 * không đổi contract, không được làm probe từ chối.
 */
function fixtureWorkflow({
  pin = PIN,
  actionPin = PIN,
  quotePin = "'",
  pinComment = '',
}: { pin?: string; actionPin?: string; quotePin?: string; pinComment?: string } = {}) {
  return `      env:\n        OCR_VERSION_PIN: ${quotePin}${pin}${quotePin}${pinComment}\n      uses: alibaba/open-code-review@deadbeef\n        with:\n          ocr_version: ${actionPin}\n`;
}

/**
 * CLI giả cho probe: cùng hợp đồng dòng lệnh với `ocr` thật (`version`, và
 * `review --preview ... --format json`) nhưng hành vi selection do `FAKE_OCR_MODE`
 * quyết định. Nhờ vậy spec này ghim được **phán quyết của probe** trong những ca
 * mà CLI thật không thể tạo ra — đặc biệt ca `secret-leak`, tức một bản CLI để
 * `include` vượt qua bộ lọc secret. Đó đúng là regression mà §3(4) cấm, và nó
 * phải làm probe đỏ chứ không được lặng lẽ xanh.
 *
 * Mô hình selection phản chiếu CLI pinned `1.12.12`: `.md` chỉ được chọn khi
 * rule include glob markdown (ca 2 ra `unsupported_ext` khi không), và file
 * test (`.spec.ts` / `.test.ts` / `_test.py`) chỉ được chọn khi rule include
 * glob tương ứng (ngược lại `default_path` — issue #399). Đường `.env.*` —
 * markdown lẫn file test — bị bộ lọc secret bắt bất kể include (ca 3 và ca 6).
 * Rule thật của repo được copy vào repo thí nghiệm, nên `ruleIncludesSpec`
 * theo đúng rule đang ship.
 */
const FAKE_OCR = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const args = process.argv.slice(2);
const mode = process.env.FAKE_OCR_MODE || 'compliant';

if (args[0] === 'version') {
  process.stdout.write('open-code-review v${PIN} (deadbeef) linux/amd64\\n');
  process.exit(0);
}

const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const from = flag('--from');
const to = flag('--to');
const git = (...a) =>
  execFileSync('git', a, { cwd: process.cwd(), encoding: 'utf8' }).trim();

let changed = [];
if (from === to) {
  changed = [];
} else {
  changed = git('diff', '--name-only', from, to).split('\\n').filter(Boolean);
}

// Project rule của repo, đã move sang .github/ocr-rules.json. Đường dẫn
// $HOME/.opencodereview/rule.json bên dưới là thứ KHÁC: đó là rule cấp người
// dùng mà CLI đọc thêm, nên nó không đổi theo.
const ruleFile = join(process.cwd(), '.opencodereview/rule.json');
let ruleIncludesMd = false;
let ruleIncludesSpec = false;
if (existsSync(ruleFile)) {
  try {
    const rule = JSON.parse(readFileSync(ruleFile, 'utf8'));
    ruleIncludesMd = Array.isArray(rule.include) && rule.include.some((p) => /\\*\\.md$/.test(p));
    ruleIncludesSpec = Array.isArray(rule.include) && rule.include.some((p) => /\\*\\.spec\\.\\{/.test(p));
  } catch {
    ruleIncludesMd = false;
    ruleIncludesSpec = false;
  }
}

// Bản CLI thật đọc thêm rule ở cấp người dùng từ \`$HOME/.opencodereview/rule.json\`
// (đo trên 1.12.12: repo không có rule vẫn cho will_review=true nếu HOME có rule).
// CLI giả mô phỏng đúng fallback đó — nếu không, ca "probe cô lập HOME" sẽ không
// chạm tới hành vi thật và test sẽ xanh giả.
if (!ruleIncludesMd) {
  const home = process.env.HOME;
  if (home) {
    const userRule = join(home, '.opencodereview/rule.json');
    if (existsSync(userRule)) {
      try {
        const rule = JSON.parse(readFileSync(userRule, 'utf8'));
        ruleIncludesMd =
          Array.isArray(rule.include) && rule.include.some((p) => /\\*\\.md$/.test(p));
        if (!ruleIncludesSpec) {
          ruleIncludesSpec =
            Array.isArray(rule.include) && rule.include.some((p) => /\\*\\.spec\\.\\{/.test(p));
        }
      } catch {
        ruleIncludesMd = false;
        ruleIncludesSpec = false;
      }
    }
  }
}

// Chế độ "mọi biến home đều đáng ngờ": nếu **bất kỳ** biến nào trong nhóm home
// còn trỏ về FAKE_HOME_DIR (thư mục mang rule), CLI giả coi rule đã lộ và ca 2
// chọn .md — probe đỏ. Probe phải ghi đè **cả nhóm** về thư mục rỗng của nó,
// khi đó không biến nào còn bằng FAKE_HOME_DIR và ca 2 ra unsupported_ext.
if (!ruleIncludesMd && process.env.FAKE_HOME_DIR) {
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
    if (process.env[key] === process.env.FAKE_HOME_DIR) {
      ruleIncludesMd = true;
    }
  }
}

// Các mode mô phỏng lỗi **vận chuyển** (không phải lỗi lựa chọn file): probe phải
// xếp chúng vào nhóm "chưa đo được" (exit 2), không được quy cho rule (exit 1).
if (mode === 'crash') {
  process.stderr.write('fake ocr crashed\\n');
  process.exit(3);
}
if (mode === 'crash-oom') {
  // Mô phỏng đúng ca "OOM giết CLI": stderr có manh mối và tiến trình chết
  // bằng signal. Probe phải giữ được dòng stderr này trong thông báo lỗi.
  process.stderr.write('FATAL ERROR: JavaScript heap out of memory\\n');
  process.kill(process.pid, 'SIGKILL');
}
if (mode === 'crash-oom-huge') {
  // Ca stderr khổng lồ: ~3 MB log trước manh mối, để ghim việc probe cắt giữ
  // phần cuối thay vì đổ nguyên bản vào một dòng log workflow. Manh mối ghi
  // đồng bộ (writeSync) vì process.exit không đợi các write đã buffer.
  require('node:fs').writeSync(2, 'filler '.repeat(400_000));
  require('node:fs').writeSync(2, 'FATAL ERROR: JavaScript heap out of memory\\n');
  process.exit(3);
}
if (mode === 'non-json') {
  process.stdout.write('log line, not json\\n');
  process.exit(0);
}
if (mode === 'suicide') {
  process.kill(process.pid, 'SIGKILL');
}

const decide = (path) => {
  if (path.endsWith('.env.md') || path.endsWith('.env.spec.ts')) {
    return mode === 'secret-leak'
      ? { will_review: true }
      : { will_review: false, exclude_reason: 'secret_exclude' };
  }
  if (path.startsWith('testdata/')) {
    return { will_review: false, exclude_reason: 'user_exclude' };
  }
  if (path.endsWith('.md')) {
    return mode === 'rule-ignored' || !ruleIncludesMd
      ? { will_review: false, exclude_reason: 'unsupported_ext' }
      : { will_review: true };
  }
  // CLI thật loại mọi file test với exclude_reason "default_path" khi rule
  // không include glob tương ứng (đo trên 1.12.12); rule thật của repo có
  // include nên file test được chọn. CLI giả phản chiếu đúng nhị phân đó, cho
  // cả ba hình dạng test file mà ca 6 ghim (.spec.ts / .test.ts / _test.py).
  if (path.endsWith('.spec.ts') || path.endsWith('.test.ts') || path.endsWith('_test.py')) {
    return ruleIncludesSpec
      ? { will_review: true }
      : { will_review: false, exclude_reason: 'default_path' };
  }
  return { will_review: true };
};

const files = changed.map((path) => ({ path, ...decide(path) }));
process.stdout.write(
  JSON.stringify({
    files,
    total_files: files.length,
    reviewable_count: files.filter((f) => f.will_review).length,
    excluded_count: files.filter((f) => !f.will_review).length,
  }),
);
`;

interface ProbeRun {
  status: number;
  stdout: string;
  stderr: string;
}

interface ProbeRunOptions {
  mode?: string;
  pin?: string;
  actionPin?: string;
  quotePin?: string;
  pinComment?: string;
  workflowPath?: string;
  keep?: boolean;
  gitShim?: string;
  env?: NodeJS.ProcessEnv;
  /** Thư mục chạy probe; dùng để kiểm đường dẫn tương đối resolve theo cwd. */
  cwd?: string;
  /** Truyền `--workflow` dạng tương đối (mặc định tương đối theo mặc định của probe). */
  relativeWorkflow?: boolean;
}

/**
 * `git` giả: chuyển tiếp mọi lệnh cho `git` thật, trừ lệnh commit có message
 * khớp `marker`. Dùng để tạo ra ca "commit thất bại" mà git thật không tạo được.
 * Chọn được commit nào hỏng để kiểm được cả trường hợp lỗi môi trường xảy ra
 * **sau** một vi phạm contract đã đo được.
 */
function gitShim(realGit: string, marker: string): string {
  return `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "${marker}" ]; then
    echo "shim: commit refused" >&2
    exit 1
  fi
done
exec "${realGit}" "$@"
`;
}

/**
 * Dựng một sandbox: workflow giả mang version pin, CLI giả, rule thật của repo
 * (nhờ vậy rule nào đang ship thì probe kiểm đúng rule đó), và chạy probe.
 */
function runProbe(options: ProbeRunOptions = {}): ProbeRun {
  const { mode = 'compliant', pin, actionPin, quotePin, pinComment, workflowPath, env } = options;
  const sandbox = mkdtempSync(join(tmpdir(), 'probe-sbx-'));
  const fake = join(sandbox, 'ocr');
  writeFileSync(fake, FAKE_OCR, 'utf8');
  chmodSync(fake, 0o755);
  const workflow = join(sandbox, 'code-review.yml');
  writeFileSync(workflow, fixtureWorkflow({ pin, actionPin, quotePin, pinComment }), 'utf8');

  let pathOverride: NodeJS.ProcessEnv = {};
  if (options.gitShim) {
    const shimDir = join(sandbox, 'shim');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, 'git'), gitShim(realGit, options.gitShim), 'utf8');
    chmodSync(join(shimDir, 'git'), 0o755);
    pathOverride = { PATH: `${shimDir}:${process.env.PATH ?? ''}` };
  }

  const ruleArg = join(ROOT_DIR, '.github/ocr-rules.json');
  const workflowArg = options.relativeWorkflow
    ? '.github/workflows/code-review.yml'
    : (workflowPath ?? workflow);
  const argv = [PROBE_PATH, '--ocr', fake, '--rule', ruleArg, '--workflow', workflowArg];
  if (options.keep) {
    argv.push('--keep');
  }

  const result = spawnSync('node', argv, {
    encoding: 'utf8',
    cwd: options.cwd,
    env: { ...gitEnv(), FAKE_OCR_MODE: mode, ...pathOverride, ...env },
    timeout: 120_000,
  });
  rmSync(sandbox, { recursive: true, force: true });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('OpenCodeReview selection probe', () => {
  it('accepts a CLI that selects markdown and test files under the rule and filters secrets', () => {
    const run = runProbe({ mode: 'compliant' });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).toContain('secret_exclude');
    expect(output).toContain('unsupported_ext');
    expect(output).toContain('user_exclude');
    // Ca 6: rule include glob file test phải đưa cả ba hình dạng vào phạm vi —
    // mỗi glob một đại diện, một regression trên bất kỳ glob nào phải đỏ ca 6.
    expect(run.stdout).toContain('src/auth/login.spec.ts');
    expect(run.stdout).toContain('src/auth/session.test.ts');
    expect(run.stdout).toContain('tests/login_test.py');
    // Ca 6 (cùng ca 3): include không vượt được bộ lọc secret, kể cả cho file test.
    expect(run.stdout).toContain('.env.spec.ts');
    expect(run.status).toBe(0);
  });

  it('rejects a CLI that ignores the rule and drops markdown as unsupported_ext', () => {
    const run = runProbe({ mode: 'rule-ignored' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('case 1:');
    expect(run.stderr).toContain('must be selected when the project rule is in effect');
  });

  it('rejects a CLI whose secret filter no longer overrides include', () => {
    const run = runProbe({ mode: 'secret-leak' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('case 3:');
    expect(run.stderr).toContain('include must NOT bypass the CLI secret filter');
  });
});

/**
 * Exit code phải phân biệt "contract sai" với "chưa đo được gì": một lần chạy
 * hỏng vì thiếu điều kiện môi trường mà trả exit 1 sẽ bị đọc như phán quyết
 * "markdown không được chọn", tức một cảnh báo sai về rule.
 */
describe('OpenCodeReview selection probe environment contract', () => {
  it('reports an unreadable workflow as an environment error, never as a violation', () => {
    const run = runProbe({ workflowPath: '/nonexistent/code-review.yml' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('REFUSED');
    expect(run.stderr).not.toContain('VERDICT');
    expect(run.stderr).not.toContain('case 1:');
  });

  it('refuses to run when the two CLI pins disagree', () => {
    const run = runProbe({ pin: PIN, actionPin: '1.13.0' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('disagrees with OCR_VERSION_PIN');
  });

  it('refuses to run when the review action pin is missing', () => {
    const run = runProbe({ actionPin: '' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('has no pinned ocr_version');
  });

  it('reports a failed fixture commit as an environment error, not as a dropped markdown', () => {
    // Fixture không commit được thì HEAD đứng nguyên, `--from` bằng `--to`, và
    // preview trả về range rỗng. Nếu probe bỏ qua exit status của `git` thì ca 1
    // báo "docs/guide.md is missing from preview files" — đổ lỗi cho rule — còn
    // ca 5 lại xanh vì đúng hình dạng nó đang ghim.
    const run = runProbe({ gitShim: 'add ordinary markdown' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('ENVIRONMENT_ERROR');
    expect(run.stderr).toContain('git commit');
    expect(run.stderr).not.toContain('missing from preview files');
    expect(run.stderr).not.toContain('the selection contract is broken');
    expect(run.stderr).toContain('could not measure');
  });

  it('keeps a measured violation apart from a later environment error and still fails closed', () => {
    // Ca 1 đo được vi phạm (CLI bỏ qua rule), rồi ca 3/4 không commit được. Kết
    // luận đúng là "contract sai" kèm lỗi môi trường — không phải "chưa đo được
    // gì", vì thế sẽ vứt đúng bằng chứng mà probe sinh ra để thu.
    const run = runProbe({
      mode: 'rule-ignored',
      gitShim: 'add secret and excluded markdown',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('case 1:');
    expect(run.stderr).toContain('the selection contract is broken');
    expect(run.stderr).toContain('ENVIRONMENT_ERROR');
    expect(run.stderr).toContain('could not be measured');
  });

  it.each([
    ['a crashing CLI', 'crash'],
    ['a CLI that prints non-JSON', 'non-json'],
    ['a CLI killed by a signal', 'suicide'],
  ])('treats %s as an environment error, never as a contract violation', (_label, mode) => {
    // Lỗi **vận chuyển** không phải lỗi lựa chọn file: nếu chúng bị quy cho
    // `rule.json`, một runner chậm hoặc một lần OOM sẽ đỏ job với thông điệp chỉ
    // người đọc đi sửa contract đang đúng.
    const run = runProbe({ mode });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('ENVIRONMENT_ERROR');
    expect(run.stderr).toContain('could not measure');
    expect(run.stderr).not.toContain('the selection contract is broken');
  });

  it('names the signal when the CLI dies without an exit code', () => {
    const run = runProbe({ mode: 'suicide' });
    expect(run.stderr).toContain('killed by SIGKILL');
    expect(run.stderr).toContain('ocr review --preview failed');
    expect(run.stderr).not.toMatch(/preview exit /u);
    expect(run.stderr).not.toMatch(/: \n/u);
  });

  it('keeps the stderr clue when the CLI is killed after writing diagnostics', () => {
    // stderr là nơi chứa manh mối quý nhất cho ca bị kill (`JavaScript heap out
    // of memory`): nếu hàm mô tả lỗi bỏ stderr khi `status === null`, một CLI
    // bị OOM chỉ còn lại "killed by SIGKILL" — không ai biết phải sửa gì.
    const run = runProbe({ mode: 'crash-oom' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('killed by SIGKILL');
    expect(run.stderr).toContain('JavaScript heap out of memory');
    expect(run.stderr).not.toContain('the selection contract is broken');
  });

  it('keeps the exit code in the failure message even when stderr has text', () => {
    // Taxonomy của probe được xây quanh exit code của CLI (`crash` exit 3):
    // nếu stderr khác rỗng mà thay thế hẳn con số, người đọc log chỉ thấy nội
    // dung stderr mà không biết tiến trình thoát với mã nào.
    const run = runProbe({ mode: 'crash' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('exit 3');
    expect(run.stderr).toContain('fake ocr crashed');
  });

  it('truncates a huge stderr to its tail', () => {
    // Một lần OOM có thể đổ tới 8 MB stderr vào một dòng log workflow; manh mối
    // (`heap out of memory`) luôn ở phần cuối, nên cắt giữ 2 KB cuối là đủ.
    const run = runProbe({ mode: 'crash-oom-huge' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('FATAL ERROR: JavaScript heap out of memory');
    expect(run.stderr).toContain('stderr: ...');
    // ~3 MB stderr không được đổ trọn vào log: mỗi ca hỏng in một bản cắt 2 KB
    // (5 ca ⇒ tối đa ~10 KB + các dòng verdict), khác hẳn mức megabyte.
    expect(run.stderr.length).toBeLessThan(20_000);
  });

  it('names the case that aborted and the cases that never ran', () => {
    const run = runProbe({ gitShim: 'add ordinary markdown' });
    expect(run.stderr).toContain('aborted after starting case 1');
    expect(run.stderr).toContain('case(s) 2-6 never ran');
  });

  it('isolates the CLI user-level rule in $HOME from the probe', () => {
    // Bản CLI thật đọc `$HOME/.opencodereview/rule.json`. Nếu probe không cô lập
    // HOME, một máy đã cấu hình `ocr` toàn cục làm ca 2 (không rule → phải là
    // unsupported_ext) báo "contract sai", đổ lỗi cho rule của repo.
    const home = mkdtempSync(join(tmpdir(), 'probe-home-'));
    mkdirSync(join(home, '.opencodereview'), { recursive: true });
    writeFileSync(
      join(home, '.opencodereview/rule.json'),
      JSON.stringify({ include: ['**/*.md'] }),
      'utf8',
    );
    try {
      const run = runProbe({ mode: 'compliant', env: { HOME: home } });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('unsupported_ext');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('neutralises every home-style env var, not only HOME', () => {
    // HOME là biến phổ biến nhưng không phải duy nhất: USERPROFILE/APPDATA
    // (Windows), XDG_DATA_HOME/XDG_CACHE_HOME (đường dẫn tuyệt đối từ máy thật)
    // đều là đường về cấu hình của người dùng. FAKE_OCR ở chế độ này đọc
    // rule.json từ biến nào trong nhóm đó mà còn trỏ về home thật thì sẽ chọn
    // .md ở ca 2 và làm probe đỏ — test xanh nghĩa là cả nhóm đã bị ghi đè.
    const home = mkdtempSync(join(tmpdir(), 'probe-home-all-'));
    mkdirSync(join(home, '.opencodereview'), { recursive: true });
    writeFileSync(
      join(home, '.opencodereview/rule.json'),
      JSON.stringify({ include: ['**/*.md'] }),
      'utf8',
    );
    try {
      const run = runProbe({
        mode: 'home-var',
        env: {
          HOME: home,
          USERPROFILE: home,
          APPDATA: home,
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: home,
          XDG_CACHE_HOME: home,
          FAKE_HOME_DIR: home,
        },
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('unsupported_ext');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolves the workflow path against the working directory and says so on failure', () => {
    // `--rule` đã được `resolve()`, còn `--workflow` thì không: chạy từ thư mục
    // con với đường dẫn tương đối trả một thông báo "workflow not found" trông
    // như lỗi cấu hình pin, trong khi nguyên nhân chỉ là cwd. Phải chỉ rõ cwd và
    // đường dẫn đã resolve để người chạy tự sửa được.
    const elsewhere = mkdtempSync(join(tmpdir(), 'probe-cwd-'));
    try {
      const run = runProbe({ mode: 'compliant', cwd: elsewhere, relativeWorkflow: true });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('workflow not found');
      expect(run.stderr).toContain('cwd:');
      expect(run.stderr).toContain(join(elsewhere, '.github/workflows/code-review.yml'));
      expect(run.stderr).not.toContain('REFUSED: CLI version');
      expect(run.stderr).not.toContain('the selection contract is broken');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.each([
    ['double quotes', { quotePin: '"' }],
    ['no quotes', { quotePin: '' }],
    ['a trailing comment', { pinComment: ' # pinned by Renovate' }],
  ])('accepts an equivalent YAML pin spelling (%s) instead of refusing', (_label, extra) => {
    const run = runProbe({ mode: 'compliant', ...extra });
    expect(run.status).toBe(0);
  });

  it('survives a closed stdout with an exit inside the taxonomy and a clean HOME', () => {
    // `| head -1` đóng stdout sớm: lần `console.log` kế tiếp của probe phát
    // EPIPE **bất đồng bộ**, không đi qua `try/catch` nào. Đây là ca kích hoạt
    // được duy nhất của lớp bảo vệ stream cuối — không listener thì Node thoát
    // exit 1 ("contract sai") và bỏ qua `finally` dọn HOME cô lập.
    const sandbox = mkdtempSync(join(tmpdir(), 'probe-epipe-'));
    const fake = join(sandbox, 'ocr');
    writeFileSync(fake, FAKE_OCR, 'utf8');
    chmodSync(fake, 0o755);
    const workflow = join(sandbox, 'code-review.yml');
    writeFileSync(workflow, fixtureWorkflow(), 'utf8');
    const home = mkdtempSync(join(tmpdir(), 'probe-epipe-home-'));
    try {
      const result = spawnSync(
        'sh',
        [
          '-c',
          `FAKE_OCR_MODE=compliant node "${PROBE_PATH}" --ocr "${fake}" --rule "${join(ROOT_DIR, '.github/ocr-rules.json')}" --workflow "${workflow}" | head -1; echo "exit=$?"`,
        ],
        { encoding: 'utf8', env: { ...gitEnv(), HOME: home }, timeout: 120_000 },
      );
      // Exit phải nằm trong taxonomy {0,1,2}, không phải exit 1-mặc-định của
      // uncaughtException lẫn crash khác.
      expect(result.stdout).toMatch(/exit=[012]\n?$/u);
      expect(result.stderr).toContain('ENVIRONMENT_ERROR');
      expect(result.stderr).toContain('output stream error');
      // `finally` phải chạy hết: HOME cô lập được dọn, thư mục về rỗng.
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('code-review workflow wiring', () => {
  const workflow = readFileSync(resolve(ROOT_DIR, '.github/workflows/code-review.yml'), 'utf8');

  it('runs the probe from a dedicated checkout, not from the workspace root', () => {
    // Job không có checkout nào trước bước review, nên `$GITHUB_WORKSPACE` rỗng
    // tại thời điểm probe chạy; trỏ vào workspace root là một bước luôn đỏ.
    expect(workflow).toContain('path: ocr-probe');
    expect(workflow).toContain(
      '$GITHUB_WORKSPACE/ocr-probe/tools/dx/scripts/ocr-selection-probe.mjs',
    );
  });

  it('keeps the checkout trusted: base on pull_request_target, dispatched ref on dispatch', () => {
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' && github.sha || steps.pr.outputs.base_ref",
    );
  });

  it('resolves the ocr binary into a variable before use', () => {
    // `set -e` không áp dụng cho command substitution nằm trong danh sách tham
    // số: `--ocr "$(command -v ocr)"` thiếu `ocr` sẽ truyền chuỗi rỗng và probe
    // báo lỗi phiên bản khó hiểu thay vì nói `ocr` không có trên PATH.
    expect(workflow).toContain('OCR_BIN="$(command -v ocr)"');
    expect(workflow).not.toContain('--ocr "$(command -v ocr)"');
  });

  it('removes the probe checkout before the review action runs', () => {
    // Action review tự checkout vào workspace root ở bước sau; để lại một repo
    // lồng nhau ở đó là thay đổi tiền đề môi trường của action bên thứ ba.
    expect(workflow).toContain('rm -rf "$GITHUB_WORKSPACE/ocr-probe"');
  });

  it('widens no permission and adds no secret when wiring the probe', () => {
    const permissions = /^permissions:\n(?:[ \t]+.+\n)*/mu.exec(workflow)?.[0] ?? '';
    expect(permissions.trim()).toBe('permissions:\n  contents: write\n  pull-requests: write');
    // Only the wiring this PR adds is in scope: the action itself already reads
    // llm_* secrets, and those references must not be treated as a new secret.
    const start = workflow.indexOf('- name: Check out the trusted ref for the selection probe');
    const end = workflow.indexOf('- name: Review the pull request');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(workflow.slice(start, end)).not.toContain('secrets.');
  });
});
