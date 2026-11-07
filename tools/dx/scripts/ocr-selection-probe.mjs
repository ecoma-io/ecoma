#!/usr/bin/env node
/**
 * Probe xác nhận contract selection của OpenCodeReview trên **CLI pinned**.
 *
 * Vì sao cần probe này: `.github/ocr-rules.json` chỉ là một mảng glob trong
 * JSON. Assert shape của JSON (rule có include glob mọi file `.md` và file
 * test) **không** chứng minh
 * được điều quan trọng: CLI pinned có thật sự chọn file `.md` và file test khi
 * đọc rule đó hay không, và `include` có đang **vượt qua** bộ lọc secret của
 * CLI hay không. Issue #239 đúng là một lỗi ở mức đó — rule sai/hỏng khiến
 * docs-only PR ra `status: skipped`, `files_reviewed: 0`, và job vẫn xanh.
 * Probe này chạy chính `ocr review --preview` (không gọi LLM) trên một repo
 * thí nghiệm và kiểm từng đường dẫn, nên một regression ở CLI hoặc ở rule đều
 * bị bắt trước khi tốn một lần review thật.
 *
 * Nguồn dữ liệu:
 * - `ocr review --preview --format json --audience agent` là nguồn duy nhất:
 *   mỗi phần tử `files[]` mang `will_review` và, khi bị loại, `exclude_reason`.
 *   Không suy diễn từ `reviewable_count`/`excluded_count` tổng hợp — hai con số
 *   đó không cho biết **file nào** bị loại và **vì sao**.
 * - `.github/ocr-rules.json` do tham số `--rule` chỉ định: probe dùng đúng
 *   rule thật của repo (không phải một bản sao hard-code), nên khi ai đó sửa
 *   include/exclude thì probe kiểm chính thay đổi đó.
 * - Version pin đọc từ `.github/workflows/code-review.yml`
 *   (`OCR_VERSION_PIN`) — cùng một nguồn mà workflow dùng để cài CLI, để một
 *   lần chạy lokal với bản CLI khác không thể bị coi là bằng chứng.
 *
 * Sáu ca kiểm tra (mỗi ca một repo thí nghiệm riêng, không đụng repo thật):
 * 1. Có rule: file `.md` thường được chọn (`will_review: true`).
 * 2. Không rule: đúng file đó bị loại với `exclude_reason: "unsupported_ext"`
 *    — đó là chữ ký của chính lỗi #239, và nó chứng minh rule là thứ làm file
 *    `.md` được chọn chứ không phải CLI tự chọn. Ca này chỉ đúng khi không có
 *    rule **ở cấp người dùng** nữa: CLI đọc thêm `$HOME/.opencodereview/rule.json`
 *    (đo trên bản `1.12.12`), nên mọi lệnh con chạy với cả nhóm biến home
 *    (`HOME`, `USERPROFILE`, `APPDATA`, `XDG_*`) trỏ về thư mục rỗng do probe
 *    tự tạo — nếu không, một máy đã cấu hình `ocr` toàn cục sẽ cho
 *    `will_review: true` ở đây và probe kết luận sai rằng contract đã vỡ.
 * 3. Có rule: file `.md` trên đường dẫn bí mật (`.env.md`) vẫn bị loại với
 *    `secret_exclude` — `include` **không** vượt qua secret filtering.
 * 4. Có rule: `.md` khớp `exclude` của chính rule (`testdata/`, tên private key)
 *    bị loại với `user_exclude`.
 * 5. Range rỗng (`from == to`): `total_files: 0`, `reviewable_count: 0`,
 *    `files: []` — cùng hình dạng với "mọi file bị loại", nên người đọc kết
 *    quả **không** được coi đây là một review sạch.
 * 6. Có rule: file test (`src/auth/login.spec.ts`) được chọn (`will_review:
 *    true`) — CLI mặc định loại mọi file test với `exclude_reason:
 *    "default_path"` (đo trên bản `1.12.12`), nên chỉ `include` của rule mới
 *    đưa chúng vào (issue #399). Ca này phải dùng đường dẫn sạch, không khớp
 *    `exclude` nào của rule (không `fixtures/`, không `testdata/`, không
 *    `__tests__/`).
 *
 * Hợp đồng exit code — ba trạng thái tách bạch, vì một phán đoán sai về rule
 * đắt hơn nhiều so với một lần không đo được:
 * - `0` = contract đúng trên đúng bản CLI pinned.
 * - `1` = contract **sai**: một assertion trên `files[]` (`will_review`,
 *   `exclude_reason`, hoặc con số tổng) không giữ.
 * - `2` = **chưa đo được**: thiếu git, sai tham số, binary không có, sai phiên
 *   bản CLI, CLI không chạy được / bị kill bằng signal / quá thời gian / stdout
 *   không phải JSON, hoặc setup repo thí nghiệm hỏng.
 *
 * Khi có **cả** vi phạm contract lẫn lỗi môi trường, in cả hai nhưng kết luận
 * exit 1: một vi phạm đã đo được là thông tin hành động được, còn lỗi môi
 * trường có thể chỉ là hệ quả của việc dừng sớm. Một lần chạy exit 2 **không**
 * được đọc là "markdown không được chọn".
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const EXIT_CONTRACT_OK = 0;
const EXIT_CONTRACT_VIOLATED = 1;
const EXIT_ENVIRONMENT = 2;

/** Giới hạn thời gian cho một lần `ocr review --preview`; chỉ đọc diff nên phải nhanh. */
const PREVIEW_TIMEOUT_MS = 60_000;
const PREVIEW_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Đuôi file `.md` mà contract yêu cầu. Cố ý chỉ có `md`: probe này ghim hành vi
 * của **rule hiện tại** (include ba đuôi markdown và ba glob file test). Nếu
 * rule đổi, ca 1 (markdown) và ca 6 (file test) sẽ đỏ và probe phải được cập
 * nhật cùng lúc.
 */
const ORDINARY_MARKDOWN = 'docs/guide.md';
/** Đường dẫn mà bộ lọc secret builtin của CLI bắt được (đo được, không suy đoán). */
const SECRET_PATH_MARKDOWN = '.env.md';
/** Đường dẫn khớp `exclude` của rule thật; đổi rule thì phải đổi ca này. */
const RULE_EXCLUDED_MARKDOWN = 'testdata/fixture.md';
/**
 * Ba file test mà rule mở rộng phạm vi cho (issue #399) — mỗi glob `include`
 * một đại diện, để một regression của CLI trên bất kỳ glob nào cũng làm ca 6 đỏ
 * thay vì lọt qua nhờ hai glob còn lại (findings OCR của PR #404, run
 * 40863940984). Đường dẫn sạch — không khớp `exclude` nào của rule — để ca này
 * đo đúng `include`, không phải ca `user_exclude` vốn đã do ca 3/4 phụ trách.
 * Glob python khớp hậu tố nên fixture là `login_test.py`, không phải
 * `test_login.py`.
 */
const ORDINARY_TEST_FILES = [
  'src/auth/login.spec.ts',
  'src/auth/session.test.ts',
  'tests/login_test.py',
];
/**
 * File test trên đường dẫn secret builtin (`findings` cùng run): `include`
 * của rule KHÔNG được vượt qua bộ lọc secret của CLI — cùng hợp đồng với ca 3,
 * nhưng đo cho hình dạng file test.
 */
const SECRET_PATH_TEST_FILE = '.env.spec.ts';

class UsageError extends Error {}

/**
 * Đọc tham số dòng lệnh; chỉ nhận các cờ đường dẫn và một cờ bật/tắt.
 * @param {string[]} argv
 * @returns {{ ocrBin: string, rulePath: string, workflowPath: string, keep: boolean }}
 */
function parseArgs(argv) {
  let ocrBin = 'ocr';
  let rulePath = '.github/ocr-rules.json';
  let workflowPath = '.github/workflows/code-review.yml';
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') {
      keep = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag !== '--ocr' && flag !== '--rule' && flag !== '--workflow') {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} needs a value`);
    }
    if (flag === '--ocr') {
      ocrBin = value;
    } else if (flag === '--rule') {
      rulePath = value;
    } else {
      workflowPath = value;
    }
    index += 1;
  }
  return { ocrBin, rulePath, workflowPath, keep };
}

/**
 * Thư mục `HOME` riêng cho tiến trình con, tạo lười đúng một lần.
 *
 * Cần thiết vì CLI đọc rule ở **cấp người dùng**: đo trên bản `1.12.12`, một repo
 * thí nghiệm **không** có `.opencodereview/rule.json` vẫn cho
 * `docs/guide.md → will_review: true` nếu máy đang chạy có
 * `$HOME/.opencodereview/rule.json` (và ra `unsupported_ext` khi `HOME` rỗng).
 * Hệ quả nếu bỏ qua: ca 2 báo "contract sai" và đổ lỗi cho rule của repo trong
 * khi nguyên nhân là cấu hình máy — một phán đoán sai, đúng loại kết luận mà
 * probe sinh ra để chống. CI không thấy vì `HOME` của runner sạch, nhưng đây
 * đúng là use case "chạy độc lập trên máy người dùng" mà tài liệu nói tới.
 * @returns {string}
 */
let isolatedHome;
function isolatedHomeDir() {
  isolatedHome ??= mkdtempSync(join(tmpdir(), 'ocr-probe-home-'));
  return isolatedHome;
}

/** Dọn thư mục `HOME` riêng, nếu đã tạo. Dọn hỏng không được che kết quả contract. */
function disposeIsolatedHome() {
  if (isolatedHome === undefined) {
    return;
  }
  try {
    rmSync(isolatedHome, { recursive: true, force: true });
  } catch {
    // Bỏ qua: thư mục nằm trong tmpdir của chính lần chạy này.
  }
  isolatedHome = undefined;
}

/**
 * Môi trường cho các lệnh con: loại mọi biến `GIT_*` kế thừa (lefthook xuất
 * `GIT_DIR` vào hook, và `GIT_DIR` thắng `cwd` — một lần chạy trong worktree có
 * thể chỉnh nhầm repo thật), tắt config git global/system, và ghi đè toàn bộ
 * nhóm biến "home" (`HOME`, `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME`,
 * `XDG_DATA_HOME`, `XDG_CACHE_HOME`) về thư mục rỗng của probe (xem
 * `isolatedHomeDir`) để repo thí nghiệm không kế thừa cấu hình máy — kể cả rule
 * user-level của chính CLI, mà CLI có thể đọc qua biến nào trong nhóm đó tùy
 * nền tảng, không chỉ `HOME`. Ba thư mục XDG được tạo sẵn để lần chạy không
 * phụ thuộc vào việc CLI có tự `mkdir` hay không.
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
function childEnv(base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('GIT_')));
  const home = isolatedHomeDir();
  const config = join(home, '.config');
  const data = join(home, '.local/share');
  const cache = join(home, '.cache');
  // Ba thư mục XDG đều được tạo sẵn: nếu CLI đọc/ghi state mà không tự `mkdir`
  // thì lần chạy hỏng thành "chưa đo được" — thông điệp chỉ ra máy chứ không
  // rule, đúng loại phán đoán sai mà probe sinh ra để chống.
  mkdirSync(config, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(cache, { recursive: true });
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    OCR_NO_UPDATE: '1',
  };
}

/**
 * Mô tả ngắn một lần chạy thất bại. Mọi nhánh đều giữ lại **exit code** của
 * tiến trình khi có (chính taxonomy của file này phân loại theo nó), và ghép
 * `stderr` (cắt còn 2 KB cuối) khi khác rỗng: đó là nơi chứa manh mối quý nhất
 * (`JavaScript heap out of memory`, thông báo `abort` của wrapper binary…),
 * kể cả khi tiến trình bị kill bằng signal hay quá thời gian — bỏ nó thì đúng
 * ca "không có manh mối nào" mà hàm sinh ra để tránh.
 * @param {{ status: number | null, signal?: NodeJS.Signals | null, stderr: string, error?: string }} result
 * @returns {string}
 */
function describeRunFailure(result) {
  const stderr = truncateTail(result.stderr.trim());
  const cause = stderr !== '' ? `; stderr: ${stderr}` : '';
  if (result.error) {
    return `${result.error}${cause}`;
  }
  if (result.status === null) {
    if (result.signal) {
      return `killed by ${result.signal}${cause}`;
    }
    return cause !== ''
      ? `no exit status and no signal${cause}`
      : 'no exit status, no signal and no stderr (the process did not start cleanly)';
  }
  return stderr !== '' ? `exit ${result.status}${cause}` : `exit ${result.status} with no stderr`;
}

/**
 * Giữ phần cuối của một chuỗi chẩn đoán: một lần OOM có thể đổ tới
 * `PREVIEW_MAX_BUFFER` (8 MB) stderr vào một dòng log của workflow, trong khi
 * manh mối (`JavaScript heap out of memory`) luôn nằm ở phần cuối.
 * @param {string} text
 * @returns {string}
 */
function truncateTail(text) {
  if (text.length <= 2048) {
    return text;
  }
  return `...${text.slice(-2048)}`;
}

/**
 * Chạy một lệnh và trả stdout/stderr; không ném, để từng ca tự quyết định mức
 * nghiêm trọng.
 * @param {string} bin
 * @param {string[]} args
 * @param {{ cwd?: string, timeout?: number }} [options]
 * @returns {{ status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string, error?: string }}
 */
function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: childEnv(),
    timeout: options.timeout ?? PREVIEW_TIMEOUT_MS,
    maxBuffer: PREVIEW_MAX_BUFFER,
  });
  if (result.error) {
    return {
      status: null,
      signal: null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error.code === 'ETIMEDOUT' ? `${bin} timed out` : result.error.message,
    };
  }
  return {
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Chạy một lệnh `git` trong repo thí nghiệm và ném khi thất bại.
 *
 * Một helper cho cả `createRepo` lẫn `commitAll`: nếu hai chỗ tự kiểm exit
 * status riêng thì chúng trôi lệch nhau và thông điệp lỗi về `git` mất nhất
 * quán. Ném (thay vì trả `{ ok }`) vì mọi lỗi ở đây đều là "chưa đo được gì".
 * @param {string} dir
 * @param {...string} args
 * @returns {string}
 */
function gitOrThrow(dir, ...args) {
  const result = run('git', args, { cwd: dir, timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${describeRunFailure(result)}`);
  }
  return result.stdout.trim();
}

/**
 * Đọc pin phiên bản CLI từ workflow — nguồn duy nhất mà cả hai đường đều dùng.
 *
 * Workflow khai **hai** pin cho cùng một CLI, ở hai chỗ khác nhau:
 * `OCR_VERSION_PIN` (bước preflight dùng để `npm install -g`) và `ocr_version`
 * (input của action `alibaba/open-code-review`, tức bản CLI mà lần review thật
 * chạy). Chỉ đối chiếu một nguồn thì hai pin trôi lệch nhau vẫn cho probe xanh,
 * trong khi bằng chứng lại mô tả một bản CLI khác với bản đã review. Thiếu hẳn
 * `ocr_version` cũng là lỗi: input đó mặc định `latest`, tức review chạy một bản
 * không pin. Vì vậy hàm này đòi cả hai và đòi chúng bằng nhau.
 * @param {string} workflowPath
 * @returns {string}
 */
function readVersionPin(workflowPath) {
  if (!existsSync(workflowPath)) {
    throw new UsageError(
      `workflow not found: ${workflowPath} — path resolves against the current working ` +
        `directory (cwd: ${process.cwd()}); pass an absolute --workflow to run from elsewhere`,
    );
  }
  const text = readFileSync(workflowPath, 'utf8');
  // Nhận cả `'1.2.3'`, `"1.2.3"` và `1.2.3`, kèm comment cuối dòng: một thay đổi
  // YAML hợp lệ và không đổi contract không được làm probe `REFUSED` (exit 2) rồi
  // chặn CI. Quanh giá trị chỉ dùng space/tab — `\s` sẽ nuốt cả newline và cho
  // phép khớp vắt qua dòng.
  const pinValue = String.raw`["']?(?<version>\d+\.\d+\.\d+)["']?[ \t]*(?:#.*)?$`;
  const match = new RegExp(String.raw`^[ \t]*OCR_VERSION_PIN:[ \t]*${pinValue}`, 'mu').exec(text);
  if (match?.groups?.version === undefined) {
    throw new UsageError(`OCR_VERSION_PIN not found in ${workflowPath}`);
  }
  const actionPin = new RegExp(String.raw`^[ \t]+ocr_version:[ \t]*${pinValue}`, 'mu').exec(text)
    ?.groups?.version;
  if (actionPin === undefined) {
    throw new UsageError(`the review action has no pinned ocr_version in ${workflowPath}`);
  }
  if (actionPin !== match.groups.version) {
    throw new UsageError(
      `ocr_version (${actionPin}) disagrees with OCR_VERSION_PIN (${match.groups.version}) ` +
        `in ${workflowPath}`,
    );
  }
  return match.groups.version;
}

/**
 * Đối chiếu phiên bản CLI thực tế với pin. Không khớp thì dừng ở exit 2: mọi
 * số liệu thu được từ một bản CLI khác đều không phải bằng chứng cho bản pinned.
 * @param {string} ocrBin
 * @param {string} expected
 * @returns {{ ok: boolean, detail: string }}
 */
function checkVersion(ocrBin, expected) {
  const probe = run(ocrBin, ['version'], { timeout: 30_000 });
  if (probe.status !== 0) {
    return {
      ok: false,
      detail: `cannot run '${ocrBin} version': ${describeRunFailure(probe)}`,
    };
  }
  const line = probe.stdout.trim();
  const match = /open-code-review\s+v?(?<version>\d+\.\d+\.\d+)/u.exec(line);
  const actual = match?.groups?.version;
  if (actual === undefined) {
    return { ok: false, detail: `cannot parse version from: ${line}` };
  }
  return actual === expected
    ? { ok: true, detail: `open-code-review v${actual}` }
    : { ok: false, detail: `CLI version is v${actual}, pin is v${expected}` };
}

/**
 * Tạo một repo thí nghiệm: init, một commit nền, và (tùy chọn) bản sao rule.
 *
 * Thư mục tạm được đăng ký với `track` **trước** lệnh có thể ném lỗi đầu tiên
 * (`git` không có trên máy, `git init` thất bại...): đăng ký sau thì một lần
 * chạy hỏng để lại thư mục rác, vì `finally` chỉ dọn những gì đã được đăng ký.
 *
 * @param {string} ruleSourcePath
 * @param {{ withRule: boolean }} options
 * @param {(repo: { dir: string, dispose: () => void }) => void} track
 * @returns {{ dir: string, base: string }}
 */
function createRepo(ruleSourcePath, { withRule }, track) {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-probe-'));
  track({ dir, dispose: () => rmSync(dir, { recursive: true, force: true }) });
  gitOrThrow(dir, 'init', '-q', '-b', 'main');
  gitOrThrow(dir, 'config', 'user.email', 'probe@ecoma.io');
  gitOrThrow(dir, 'config', 'user.name', 'ocr-selection-probe');
  writeFileSync(join(dir, 'README.md'), '# probe fixture\n', 'utf8');
  if (withRule) {
    mkdirSync(join(dir, '.opencodereview'), { recursive: true });
    copyFileSync(ruleSourcePath, join(dir, '.opencodereview/rule.json'));
  }
  gitOrThrow(dir, 'add', '-A');
  gitOrThrow(dir, 'commit', '-q', '-m', 'baseline');
  return { dir, base: gitOrThrow(dir, 'rev-parse', 'HEAD') };
}

/**
 * Commit toàn bộ thay đổi trong repo thí nghiệm và trả về SHA mới.
 *
 * Kiểm exit status ở đây là bắt buộc, không phải trang trí: một `git commit`
 * thất bại để `HEAD` nguyên chỗ, nên `--from` và `--to` bằng nhau, `preview()`
 * chạy trên range **rỗng** và ca 1/3 báo "markdown bị CLI bỏ sót" — sai bản
 * chất, trong khi ca 5 (range rỗng) lại xanh vì đúng đặc điểm nó đang ghim.
 * Ném lỗi để lần chạy kết thúc ở `EXIT_ENVIRONMENT` (chưa đo được gì) thay vì
 * một phán quyết về contract.
 */
function commitAll(dir, message) {
  gitOrThrow(dir, 'add', '-A');
  gitOrThrow(dir, 'commit', '-q', '-m', message);
  const head = gitOrThrow(dir, 'rev-parse', 'HEAD');
  if (head === '') {
    throw new Error('git rev-parse HEAD returned an empty sha');
  }
  return head;
}

/**
 * Ghi một file thí nghiệm, tự tạo thư mục cha (`docs/`, `testdata/` chưa tồn
 * tại trong repo vừa init).
 * @param {string} dir
 * @param {string} relativePath
 * @param {string} content
 */
function writeFixture(dir, relativePath, content) {
  const target = join(dir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

/**
 * Chạy preview cho một range và trả về object JSON đã parse.
 *
 * `ok: false` **luôn** là "chưa đo được", không phải vi phạm contract: exit code
 * khác 0, bị kill bằng signal, quá thời gian, hoặc stdout không phải JSON (CLI
 * in log lẫn vào JSON) đều là lỗi của CLI/môi trường, không phải của `rule.json`.
 * Chỉ các assertion trên `files[]` mới được tính là vi phạm — vì vậy phần tử
 * `ok: false` ở đây đi vào nhóm lỗi môi trường của `runCases`.
 * @param {string} ocrBin
 * @param {string} dir
 * @param {string} from
 * @param {string} to
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
function preview(ocrBin, dir, from, to) {
  const result = run(
    ocrBin,
    ['review', '--preview', '--from', from, '--to', to, '--format', 'json', '--audience', 'agent'],
    { cwd: dir },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      error: `ocr review --preview failed — ${describeRunFailure(result)}`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `preview is not JSON: ${error.message}` };
  }
}

/**
 * In bảng đường dẫn cho một ca, để kết quả kiểm được đọc lại thay vì chỉ tin
 * vào exit code.
 * @param {string} title
 * @param {{ files?: Array<{ path: string, will_review: boolean, exclude_reason?: string }> }} value
 */
function printFiles(title, value) {
  console.log(`\n${title}`);
  const files = Array.isArray(value?.files) ? value.files : [];
  if (files.length === 0) {
    console.log('  (no files)');
  }
  for (const file of files) {
    const reason = file.exclude_reason ? String(file.exclude_reason) : '-';
    console.log(
      `  ${String(Boolean(file.will_review)).padEnd(6)} ${reason.padEnd(28)} ${String(file.path)}`,
    );
  }
  console.log(
    `  total_files=${String(value?.total_files)} reviewable_count=${String(value?.reviewable_count)}`,
  );
}

/**
 * Tìm một phần tử theo đường dẫn trong `files[]`.
 * @param {any} value
 * @param {string} path
 */
function findFile(value, path) {
  return Array.isArray(value?.files) ? value.files.find((file) => file?.path === path) : undefined;
}

/**
 * Chạy cả sáu ca và trả về hai danh sách **tách biệt**:
 * - `failures`: vi phạm contract đã đo được (assertion trên `files[]`) → exit 1.
 * - `environmentErrors`: ca không đo được (setup hỏng, CLI chết, preview không
 *   phải JSON) → exit 2 nếu không có vi phạm nào.
 *
 * Hàm **không ném**: một lỗi môi trường ở ca sau không được xoá kết quả đã đo
 * được ở ca trước. Nếu ca 1 đã phát hiện rule hỏng rồi ca 3 mới hỏng vì hết đĩa,
 * kết luận đúng là "contract sai" (kèm lỗi môi trường), không phải "chưa đo được
 * gì" — ném lỗi ra ngoài sẽ vứt đúng bằng chứng mà probe sinh ra để thu.
 *
 * Hàm đồng bộ: không có I/O bất đồng bộ nào trong thân hàm, nên `async` chỉ gợi
 * ý sai rằng các ca chạy song song.
 * @param {{ ocrBin: string, rulePath: string, keep: boolean }} options
 * @returns {{ failures: string[], environmentErrors: string[] }}
 */
function runCases({ ocrBin, rulePath, keep }) {
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const environmentErrors = [];
  /** @type {Array<{ dir: string, dispose: () => void }>} */
  const repos = [];
  // Đăng ký ngay khi thư mục tồn tại, và in đường dẫn khi `--keep` để người chạy
  // soi được ca đỏ mà không phải tự dò `/tmp/ocr-probe-*`.
  const track = (repo) => {
    repos.push(repo);
    if (keep) {
      console.log(`[ocr-probe] kept ${repo.dir}`);
    }
  };
  let caseCount = 0;
  try {
    // Ca 1 + 2: cùng một file, cùng một range, chỉ khác sự hiện diện của rule.
    // Tách hai repo để ca 2 không phụ thuộc trạng thái của ca 1.
    caseCount = 1;
    const withRule = createRepo(rulePath, { withRule: true }, track);
    writeFixture(withRule.dir, ORDINARY_MARKDOWN, '# tài liệu\n\nnội dung\n');
    const headWithRule = commitAll(withRule.dir, 'add ordinary markdown');
    const case1 = preview(ocrBin, withRule.dir, withRule.base, headWithRule);
    if (!case1.ok) {
      environmentErrors.push(`case 1: ${case1.error}`);
    } else {
      printFiles('case 1 — rule present, ordinary markdown', case1.value);
      const file = findFile(case1.value, ORDINARY_MARKDOWN);
      if (file === undefined) {
        failures.push(`case 1: ${ORDINARY_MARKDOWN} is missing from preview files`);
      } else if (file.will_review !== true) {
        failures.push(
          `case 1: ${ORDINARY_MARKDOWN} must be selected when the project rule is in effect ` +
            `(got will_review=${JSON.stringify(file.will_review)}, ` +
            `exclude_reason=${JSON.stringify(file.exclude_reason)})`,
        );
      }
    }

    caseCount = 2;
    const noRule = createRepo(rulePath, { withRule: false }, track);
    writeFixture(noRule.dir, ORDINARY_MARKDOWN, '# tài liệu\n\nnội dung\n');
    const headNoRule = commitAll(noRule.dir, 'add ordinary markdown');
    const case2 = preview(ocrBin, noRule.dir, noRule.base, headNoRule);
    if (!case2.ok) {
      environmentErrors.push(`case 2: ${case2.error}`);
    } else {
      printFiles('case 2 — rule absent, same markdown', case2.value);
      const file = findFile(case2.value, ORDINARY_MARKDOWN);
      if (file === undefined) {
        failures.push(`case 2: ${ORDINARY_MARKDOWN} is missing from preview files`);
      } else if (file.will_review !== false || file.exclude_reason !== 'unsupported_ext') {
        failures.push(
          `case 2: ${ORDINARY_MARKDOWN} must be dropped as 'unsupported_ext' without the rule ` +
            `(got will_review=${JSON.stringify(file.will_review)}, ` +
            `exclude_reason=${JSON.stringify(file.exclude_reason)}) — if the CLI now selects ` +
            `.md by default, the rule is no longer what selects it and this probe must be updated`,
        );
      }
      if (case2.value?.reviewable_count !== 0) {
        failures.push(
          `case 2: reviewable_count must be 0 without the rule (got ${JSON.stringify(case2.value?.reviewable_count)})`,
        );
      }
    }

    // Ca 3 + 4: một repo chung, hai commit, để secret_exclude và user_exclude
    // được đo trên đúng rule thật mà repo đang ship.
    caseCount = 3;
    const filtered = createRepo(rulePath, { withRule: true }, track);
    writeFixture(filtered.dir, SECRET_PATH_MARKDOWN, '# pretend secret material\n');
    writeFixture(filtered.dir, RULE_EXCLUDED_MARKDOWN, '# fixture\n');
    writeFixture(filtered.dir, ORDINARY_MARKDOWN, '# tài liệu\n\nnội dung\n');
    const headFiltered = commitAll(filtered.dir, 'add secret and excluded markdown');
    const case3 = preview(ocrBin, filtered.dir, filtered.base, headFiltered);
    if (!case3.ok) {
      environmentErrors.push(`case 3/4: ${case3.error}`);
    } else {
      printFiles('case 3/4 — rule present, secret path and rule-excluded markdown', case3.value);
      const secret = findFile(case3.value, SECRET_PATH_MARKDOWN);
      if (secret === undefined) {
        failures.push(`case 3: ${SECRET_PATH_MARKDOWN} is missing from preview files`);
      } else if (secret.will_review !== false || secret.exclude_reason !== 'secret_exclude') {
        failures.push(
          `case 3: include must NOT bypass the CLI secret filter — ` +
            `${SECRET_PATH_MARKDOWN} must be excluded as 'secret_exclude' ` +
            `(got will_review=${JSON.stringify(secret.will_review)}, ` +
            `exclude_reason=${JSON.stringify(secret.exclude_reason)})`,
        );
      }
      const excluded = findFile(case3.value, RULE_EXCLUDED_MARKDOWN);
      // Ca 4 chạy chung preview với ca 3 nhưng có khối assertion riêng, nên từ
      // đây một throw phải báo đúng ca 4, không phải ca 3.
      caseCount = 4;
      if (excluded === undefined) {
        failures.push(`case 4: ${RULE_EXCLUDED_MARKDOWN} is missing from preview files`);
      } else if (excluded.will_review !== false || excluded.exclude_reason !== 'user_exclude') {
        failures.push(
          `case 4: a path matching the rule's own exclude must be dropped as 'user_exclude' — ` +
            `${RULE_EXCLUDED_MARKDOWN} (got will_review=${JSON.stringify(excluded.will_review)}, ` +
            `exclude_reason=${JSON.stringify(excluded.exclude_reason)}); if the rule's exclude ` +
            `list no longer covers this path, update this probe together with the rule`,
        );
      }
      const ordinary = findFile(case3.value, ORDINARY_MARKDOWN);
      if (ordinary === undefined || ordinary.will_review !== true) {
        failures.push(
          `case 3/4: ${ORDINARY_MARKDOWN} must stay selected while the others are excluded ` +
            `(got ${JSON.stringify(ordinary)})`,
        );
      }
    }

    caseCount = 5;
    const case5 = preview(ocrBin, filtered.dir, headFiltered, headFiltered);
    if (!case5.ok) {
      environmentErrors.push(`case 5: ${case5.error}`);
    } else {
      printFiles('case 5 — empty range (from == to)', case5.value);
      const filesEmpty = Array.isArray(case5.value?.files) && case5.value.files.length === 0;
      if (!filesEmpty || case5.value?.total_files !== 0 || case5.value?.reviewable_count !== 0) {
        failures.push(
          `case 5: an empty range must report no files at all, not a review of nothing ` +
            `(got files=${JSON.stringify(case5.value?.files)}, ` +
            `total_files=${JSON.stringify(case5.value?.total_files)}, ` +
            `reviewable_count=${JSON.stringify(case5.value?.reviewable_count)})`,
        );
      }
    }

    // Ca 6 dùng repo riêng: rule có include glob file test là tiền đề của ca,
    // còn đường dẫn phải sạch (không khớp `exclude`) để đo đúng `include`.
    caseCount = 6;
    const withTestRule = createRepo(rulePath, { withRule: true }, track);
    for (const testFile of ORDINARY_TEST_FILES) {
      writeFixture(
        withTestRule.dir,
        testFile,
        "describe('login', () => {\n  it('rejects a bad password', () => {});\n});\n",
      );
    }
    writeFixture(withTestRule.dir, SECRET_PATH_TEST_FILE, '# pretend secret material\n');
    const headWithTestRule = commitAll(withTestRule.dir, 'add ordinary test files');
    const case6 = preview(ocrBin, withTestRule.dir, withTestRule.base, headWithTestRule);
    if (!case6.ok) {
      environmentErrors.push(`case 6: ${case6.error}`);
    } else {
      printFiles(
        'case 6 — rule present, ordinary test files and secret-path test file',
        case6.value,
      );
      for (const testFile of ORDINARY_TEST_FILES) {
        const file = findFile(case6.value, testFile);
        if (file === undefined) {
          failures.push(`case 6: ${testFile} is missing from preview files`);
        } else if (file.will_review !== true) {
          failures.push(
            `case 6: ${testFile} must be selected by the rule include — the CLI drops ` +
              `test files by default (exclude_reason 'default_path') and only the project rule ` +
              `(.github/ocr-rules.json, include globs **/*.spec.{js,jsx,ts,tsx}, ` +
              `**/*.test.{js,jsx,ts,tsx}, **/*_test.py) brings them into review scope (issue #399) ` +
              `(got will_review=${JSON.stringify(file.will_review)}, ` +
              `exclude_reason=${JSON.stringify(file.exclude_reason)})`,
          );
        }
      }
      const secretTest = findFile(case6.value, SECRET_PATH_TEST_FILE);
      if (secretTest === undefined) {
        failures.push(`case 6: ${SECRET_PATH_TEST_FILE} is missing from preview files`);
      } else if (
        secretTest.will_review !== false ||
        secretTest.exclude_reason !== 'secret_exclude'
      ) {
        failures.push(
          `case 6: include must NOT bypass the CLI secret filter for test files — ` +
            `${SECRET_PATH_TEST_FILE} must be excluded as 'secret_exclude' ` +
            `(got will_review=${JSON.stringify(secretTest.will_review)}, ` +
            `exclude_reason=${JSON.stringify(secretTest.exclude_reason)})`,
        );
      }
    }
  } catch (error) {
    // Ném ra khỏi một ca là lỗi môi trường, không phải phán quyết về contract:
    // các ca chưa chạy phải được nêu tên, vì "3 environment error(s)" nghe như
    // cả sáu ca đã được thử trong khi thực ra không.
    const rest = caseCount < 6 ? `; case(s) ${caseCount + 1}-6 never ran` : '';
    environmentErrors.push(
      `aborted after starting case ${caseCount}: ${String(error instanceof Error ? error.message : error)}${rest}`,
    );
  } finally {
    if (!keep) {
      for (const repo of repos) {
        try {
          repo.dispose();
        } catch {
          // Dọn dẹp thất bại không được che mất kết quả contract.
        }
      }
    }
  }
  return { failures, environmentErrors };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `usage: ocr-selection-probe.mjs [--ocr <path>] [--rule <path>] [--workflow <path>] [--keep]`,
    );
    console.error(String(error instanceof Error ? error.message : error));
    return EXIT_ENVIRONMENT;
  }
  if (args.ocrBin === '') {
    console.error('[ocr-probe] REFUSED: --ocr is empty; pass the path to the ocr executable');
    return EXIT_ENVIRONMENT;
  }
  // Resolve cả hai đường dẫn theo cwd — `resolve()` không tìm được file chạy từ
  // thư mục con với đường dẫn mặc định, nhưng khi nó tìm được thì thông báo lỗi
  // dưới đây phải nói rõ cwd và đường dẫn đã resolve để người chạy tự phân biệt
  // "lỗi cấu hình pin" với "đứng sai thư mục".
  const rulePath = resolve(args.rulePath);
  const workflowPath = resolve(args.workflowPath);
  if (!existsSync(rulePath)) {
    console.error(
      `project rule not found: ${rulePath} — path resolves against the current working ` +
        `directory (cwd: ${process.cwd()}); pass an absolute --rule to run from elsewhere`,
    );
    return EXIT_ENVIRONMENT;
  }
  let version;
  try {
    version = checkVersion(args.ocrBin, readVersionPin(workflowPath));
  } catch (error) {
    console.error(`[ocr-probe] REFUSED: ${String(error instanceof Error ? error.message : error)}`);
    return EXIT_ENVIRONMENT;
  }
  if (!version.ok) {
    console.error(`[ocr-probe] REFUSED: ${version.detail}`);
    return EXIT_ENVIRONMENT;
  }
  console.log(`[ocr-probe] cli=${version.detail} rule=${rulePath}`);

  const { failures, environmentErrors } = runCases({ ...args, rulePath });
  for (const failure of failures) {
    console.error(`[ocr-probe] FAILED: ${failure}`);
  }
  for (const error of environmentErrors) {
    console.error(`[ocr-probe] ENVIRONMENT_ERROR: ${error}`);
  }
  // Vi phạm contract thắng: một vi phạm đã đo được là thông tin hành động được,
  // còn lỗi môi trường có thể chỉ là hệ quả của việc dừng sớm.
  if (failures.length > 0) {
    console.error(
      `[ocr-probe] VERDICT: the selection contract is broken (${failures.length} violation(s))` +
        (environmentErrors.length > 0
          ? `; ${environmentErrors.length} case(s) could not be measured`
          : ''),
    );
    return EXIT_CONTRACT_VIOLATED;
  }
  if (environmentErrors.length > 0) {
    console.error(
      `[ocr-probe] VERDICT: could not measure the contract (${environmentErrors.length} environment error(s)) — no claim about the rule`,
    );
    return EXIT_ENVIRONMENT;
  }
  console.log(
    '[ocr-probe] VERDICT: markdown and test files are selected by the rule, secret filtering is intact',
  );
  return EXIT_CONTRACT_OK;
}

// Lớp bảo vệ cuối cùng của hợp đồng exit code:
//
// Lỗi `EPIPE` là **bất đồng bộ**: `console.log` vào pipe đã đóng phát `error`
// trên stream, không ném đồng bộ ra khỏi `main()`, nên `try/catch` không chặn
// được. Không listener thì uncaughtException làm Node thoát exit 1 — đúng mã
// định nghĩa "contract sai", khiến người đọc quy lỗi sai cho rule. Listener
// **log rồi hạ exit về `EXIT_ENVIRONMENT` cho mọi lỗi stream** (không re-emit:
// `throw` trong listener là một tick khác, không đi qua `try/catch` nào dưới
// đây, sẽ thành uncaughtException exit 1 và bỏ qua `finally` dọn `HOME`).
//
// Thứ tự: `main()` đồng bộ, nên `exitCode` đã được gán phán quyết trước khi
// listener kịp chạy. Handler **chỉ hạ** về `EXIT_ENVIRONMENT` khi chưa có phán
// quyết nào (sentinel `null`), không đè exit 1 của một vi phạm đã đo được —
// "vi phạm đã đo được là thông tin hành động được".
//
// Cờ `streamErrorReported`: nếu chính stderr đang hỏng, lần `console.error`
// trong handler phát lại `EPIPE` và tái nhập handler — vòng lặp giữ tiến trình
// sống thay vì kết thúc. Chỉ báo cáo một lần.
let streamErrorReported = false;
let verdictAssigned = false;
function onStreamError(error) {
  if (streamErrorReported) {
    process.exitCode = EXIT_ENVIRONMENT;
    return;
  }
  streamErrorReported = true;
  const code = /** @type {NodeJS.ErrnoException} */ (error)?.code ?? 'unknown';
  console.error(`[ocr-probe] ENVIRONMENT_ERROR: output stream error (${code})`);
  if (!verdictAssigned) {
    process.exitCode = EXIT_ENVIRONMENT;
  }
}
process.stdout.on('error', onStreamError);
process.stderr.on('error', onStreamError);

try {
  const outcome = main();
  // Fallback `typeof` bắt nhánh `main()` quên `return` (`undefined` ⇒ exit 0 ⇒
  // "xanh" trong khi chưa đo được gì — ngược nguyên tắc ở đầu file).
  process.exitCode = typeof outcome === 'number' ? outcome : EXIT_ENVIRONMENT;
  verdictAssigned = true;
} catch (error) {
  // Một throw đồng bộ thoát khỏi `main()` (lỗi lập trình) cũng phải exit 2,
  // kèm **stack** — đây chính là ca lỗi lập trình, nơi stack giá trị nhất.
  const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[ocr-probe] ENVIRONMENT_ERROR: unhandled failure: ${stack}`);
  process.exitCode = EXIT_ENVIRONMENT;
  verdictAssigned = true;
} finally {
  disposeIsolatedHome();
}
