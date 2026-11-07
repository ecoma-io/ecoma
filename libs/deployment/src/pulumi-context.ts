/**
 * Pulumi CLI/backend context cô lập theo worktree — nền tảng cho mọi lệnh Pulumi
 * của local deployment (up/preview/destroy/output/status).
 *
 * Bài toán: nhiều worktree cùng chạy local deployment trên một host. Pulumi
 * CLI giữ hai trạng thái chia sẻ trong CLI home mặc định (`~/.pulumi`): backend
 * đang login (credentials.json) và workspace file theo project
 * (`workspaces/<project>-<sha1(Pulumi.yaml path)>-workspace.json` — đã kiểm thực
 * nghiệm: hash là sha1 của **đường dẫn file Pulumi.yaml**, dự đoán khớp 100%).
 * Trước thay đổi này, orchestration phải `pulumi login file://<state>` trước mỗi
 * lệnh — clobber backend selection toàn cục và race giữa các worktree.
 *
 * Cơ chế thay thế (đã KIỂM THỰC NGHIỆM trên CLI v3.267/3.270, ghi ở
 * `docs/architecture/04-platform-facts.md` §2.16 PU12–PU13):
 *
 * 1. `PULUMI_BACKEND_URL=file://<worktree>/.pulumi-local-state` — trỏ backend
 *    trực tiếp, KHÔNG cần `pulumi login` và KHÔNG đụng credentials.json.
 * 2. `--stack organization/<project>/<stack>` tường minh trên MỌI lệnh — không
 *    lệnh nào PHỤ THUỘC selected-stack; lưu ý `stack select` trong `ensureStack`
 *    vẫn GHI workspace file (PU13) nhưng file đó key theo đường dẫn project nên
 *    hai worktree không xung đột.
 * 3. KHÔNG đặt `PULUMI_HOME`: nó di chuyển CẢ plugin cache (~508MB), mỗi worktree
 *    phải tải lại toàn bộ provider plugin. Plugin cache và credentials home để
 *    chia sẻ là đúng — chúng là read-only đối với các lệnh này.
 *
 * Không có biến nào ở đây chứa secret: passphrase đi qua `PULUMI_CONFIG_PASSPHRASE`
 * do caller truyền, chỉ sống trong env của subprocess.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeWorktreeRoot, pulumiStackName, worktreeNamespace } from './deploy-namespace.js';

/**
 * Root checkout mặc định khi caller không truyền `--worktree-root`.
 *
 * Lib không import `ROOT_DIR` của `tools/dx` (hướng phụ thuộc tooling→lib là
 * chiều DUY NHẤT được phép; lib import ngược tooling là cycle): tự suy từ vị
 * trí file này — `libs/deployment/src` lên BA mức là workspace root. Sai một
 * mức là namespace lệch (`we6044…` = hash của `libs/`) và cả lane up thành
 * một stack khác — đã đo thật trên PR #424. Cùng giá trị với `ROOT_DIR` của
 * DX trên checkout chuẩn, mà không kéo CLI tooling vào runtime của deploy unit.
 */
const DEFAULT_WORKTREE_ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Thư mục state `file://` của một worktree — VỐN đã là contract (ngoài Git,
 * theo worktree), giờ cũng là backend URL duy nhất mà mọi lệnh Pulumi thấy.
 */
export function localStateDir(worktreeRoot: string): string {
  return join(worktreeRoot, '.pulumi-local-state');
}

/**
 * Kiểm tra worktree đã có Pulumi state thật sự (đã init stack) hay chưa.
 *
 * Chỉ thư mục rỗng (chưa init) hoặc artifact không liên quan không được coi là
 * state: một `mkdir` của `ensureStack` tạo thư mục rỗng, và stack init mới sinh
 * file `.json` trong `.pulumi/stacks/<project>/`. Vì vậy phải có ít nhất một file
 * stack `.json` (không tính `.bak`) mới coi là state đã init.
 */
export function hasPulumiState(worktreeRoot: string): boolean {
  const stateDir = localStateDir(worktreeRoot);
  const stacksDir = join(stateDir, '.pulumi', 'stacks');
  if (!existsSync(stacksDir)) return false;
  try {
    for (const project of readdirSync(stacksDir)) {
      const projectDir = join(stacksDir, project);
      let stat;
      try {
        stat = statSync(projectDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const files = readdirSync(projectDir);
      if (files.some((f) => f.endsWith('.json') && !f.endsWith('.bak'))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Kết quả một bước exec shell — fail-closed: caller phải kiểm `status`.
 *
 * Một bản duy nhất dùng chung cho mọi caller Pulumi (import từ đây): nhiều bản
 * tự dựng là chỗ trôi lệch — một bên thêm `error`/`signal` thì bên kia không.
 * Các trường `error`/`signal` báo "process chưa chạy được/bị kill"
 * (`status === null`), caller phân loại lỗi dựa vào chúng.
 */
export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** `spawnSync` tự báo lỗi qua `error` (ENOENT — không có binary, EACCES...) — `status` là `null` lúc đó. */
  error?: Error;
  /** Non-null khi process bị signal kill (OOM...) — `status` là `null` lúc đó. */
  signal?: NodeJS.Signals | null;
}

/**
 * Tuỳ chọn cho `exec`.
 *
 * `input` — ghi vào stdin của process. Cần thiết khi giá trị phải KHÔNG nằm
 * trong argv: argv của một process khác đọc được qua `/proc/<pid>/cmdline`
 * (cùng user) và qua `ps`. `pulumi config set` đọc giá trị từ stdin khi
 * không có argument value — đo thật trên CLI 3.270.
 */
export interface ExecOptions {
  input?: string;
}

export function exec(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: ExecOptions = {},
): ExecResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
    signal: result.signal,
  };
}

/**
 * Diễn giải vì sao một `spawnSync` không sinh ra exit code (`status === null`):
 * process CHẠY CHƯA ĐƯỢC (binary không tồn tại — ENOENT, không executable —
 * EACCES) hoặc bị SIGNAL kill (OOM). Lúc đó stdout/stderr rỗng, nguyên nhân
 * thật chỉ nằm trong `error`/`signal`.
 */
export function describeSpawnFailure(result: ExecResult): string {
  if (result.error !== undefined && result.error !== null) return result.error.message;
  if (result.signal !== undefined && result.signal !== null) {
    return `process killed by signal: ${result.signal}`;
  }
  return 'unknown reason';
}

/**
 * Chạy lệnh dài với output STREAM trực tiếp ra terminal của caller.
 *
 * `spawnSync` trong `exec` giữ toàn bộ output trong pipe cho tới khi lệnh kết
 * thúc — với `pulumi up` (build image home có thể mất vài phút) người dùng nhìn
 * màn hình đứng im rồi mới thấy kết quả. Ở đây `stdio: 'inherit'` cho stdout:
 * tiến trình Pulumi tự vẽ progress và terminal của developer thấy ngay từng
 * bước. stderr vẫn bắt về chuỗi — thông điệp lỗi phải vào error thrown, không
 * trôi qua console giữa chừng. Stdout không còn capture được, nên hàm này
 * KHÔNG trả stdout — chỉ dùng cho lệnh mà caller không cần đọc output.
 *
 * `label` là tên lệnh xuất hiện trong thông báo lỗi — caller phải truyền
 * subcommand thật (`up`, `preview`...), KHÔNG suy từ `args[0]`: qua `pulumiRun`
 * thì `args[0]` luôn là `--stack`, và lỗi `pulumi --stack thất bại` mất đúng
 * thông tin cần nhất khi debug.
 */
export function execStreaming(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label = command,
): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'inherit', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (result.status === null) {
      throw new Error(`${command} ${label} could not run: ${describeSpawnFailure(result)}`);
    }
    throw new Error(`${command} ${label} failed:\n${result.stderr ?? ''}`);
  }
}

/**
 * Context chạy của một worktree: mọi lệnh Pulumi đều suy từ ba giá trị này.
 * Giữ một chỗ để platform và home dùng ĐÚNG cùng một backend và stack — lệch
 * một chữ là hai stack khác nhau và isolation vỡ.
 */
export interface LocalDeployContext {
  worktreeRoot: string;
  namespace: string;
  stackName: string;
  stateUrl: string;
}

export function resolveContext(worktreeRootInput?: string): LocalDeployContext {
  const worktreeRoot = normalizeWorktreeRoot(worktreeRootInput ?? DEFAULT_WORKTREE_ROOT);
  const namespace = worktreeNamespace(worktreeRoot);
  return {
    worktreeRoot,
    namespace,
    stackName: pulumiStackName(namespace),
    // `pathToFileURL` chứ không phải nối chuỗi: `PULUMI_BACKEND_URL` là URL thật
    // mà Pulumi CLI parse — path chứa `%`, space hay là drive Windows (`C:\...`)
    // bị nối chuỗi sẽ parse sai hoặc lỗi ngay, tệ hơn là backend trỏ sang thư
    // mục khác. Trên POSIX không dấu, `pathToFileURL(...).href` cho cùng
    // `file://<root>` nên hành vi hiện tại không đổi.
    stateUrl: pathToFileURL(localStateDir(worktreeRoot)).href,
  };
}

/**
 * Tên file passphrase local, nằm cạnh state dir trong worktree.
 *
 * File này KHÔNG được track: `.gitignore` chặn `.pulumi-local-passphrase` tường
 * minh (entry tường minh giữ contract — đổi tên file không âm thầm đưa
 * encryption material vào Git).
 */
export const LOCAL_PASSPHRASE_FILE = '.pulumi-local-passphrase';

/**
 * Passphrase dùng cho local Pulumi stack của một worktree.
 *
 * `inline` — biến `PULUMI_CONFIG_PASSPHRASE` của môi trường.
 * `file`   — biến `PULUMI_CONFIG_PASSPHRASE_FILE`; CLI tự đọc file, orchestration
 *            chỉ biết "đã có đường cung".
 * `worktree` — passphrase do chính công cụ sinh, lưu ở
 *            `<worktree>/.pulumi-local-passphrase` (ngoài Git).
 * `none`   — không có passphrase nào.
 */
export type LocalPassphrase =
  | { kind: 'inline'; value: string }
  | { kind: 'file' }
  | { kind: 'worktree'; value: string }
  | { kind: 'none' };

/** Đường dẫn file passphrase local của một worktree. */
export function localPassphrasePath(worktreeRoot: string): string {
  return join(worktreeRoot, LOCAL_PASSPHRASE_FILE);
}

/**
 * Sinh passphrase local bằng nguồn ngẫu nhiên mật mã an toàn.
 *
 * `randomBytes` của `node:crypto` — KHÔNG dùng `Math.random`, timestamp hay
 * giá trị đoán được: passphrase là encryption material của state local.
 */
function generatePassphrase(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Đọc passphrase đã lưu trong worktree.
 *
 * Trả `undefined` khi file không tồn tại hoặc rỗng — file rỗng tương đương
 * "chưa có" (một passphrase rỗng là encryption material yếu, không phải
 * passphrase hợp lệ).
 */
function readWorktreePassphrase(worktreeRoot: string): string | undefined {
  const path = localPassphrasePath(worktreeRoot);
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // File tồn tại nhưng không đọc được — coi như "chưa có" ở đây; caller fail
    // closed nếu state đã init (xem resolveLocalPassphrase).
    return undefined;
  }
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Lưu passphrase local của worktree, chỉ ghi khi file chưa có.
 *
 * Quyền file `0600`: passphrase là encryption material, không cần ai khác đọc.
 * Ghi kiểu "chỉ khi chưa có" phải là NGUYÊN TỬ (`openSync` cờ `wx` — fail với
 * `EEXIST` khi file đã có): kiểm `existsSync` rồi ghi là hai bước, hai tiến
 * trình cùng deploy có thể cùng vượt qua bước kiểm rồi ghi đè lẫn nhau —
 * process giữ passphrase trong bộ nhớ của mình sẽ không khớp file trên đĩa và
 * mọi lệnh sau của nó fail "incorrect passphrase". Với `wx`, giá trị đầu tiên
 * ghi xuống thắng, process thua cuộc đọc lại file được giá trị đúng ở lần
 * `resolve` kế tiếp.
 */
export function writeWorktreePassphrase(worktreeRoot: string, value: string): string {
  const path = localPassphrasePath(worktreeRoot);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeSync(fd, `${value}\n`, 0, 'utf8');
    created = true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EEXIST'
    ) {
      // Race: file đã được process khác tạo. Đọc lại và dùng giá trị persisted
      // nếu hợp lệ; file rỗng/malformed/unreadable là lỗi tường minh — không
      // được tiếp tục với giá trị generated chưa được persist.
      let persisted: string;
      try {
        persisted = readFileSync(path, 'utf8').trim();
      } catch (readError) {
        throw new Error(
          `Passphrase file ${path} exists but cannot be read — unable to resolve a passphrase safely.`,
          { cause: readError },
        );
      }
      if (persisted.length === 0) {
        throw new Error(
          `Passphrase file ${path} exists but is empty/malformed — unable to resolve a passphrase safely.`,
          { cause: error },
        );
      }
      try {
        chmodSync(path, 0o600);
      } catch {
        // ignore
      }
      return persisted;
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (created) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // FS không hỗ trợ chmod (một số mount) — bỏ qua.
    }
  }
  return value;
}

/**
 * Ép quyền `0600` cho file secret ghi bằng `writeFileSync` với `mode` — cần
 * vì `mode` chỉ áp dụng lúc TẠO MỚI: khi file đã tồn tại `writeFileSync` bỏ
 * qua `mode`, nên một файл `.env`/passphrase tạo trước bởi process khác (hoặc
 * lần chạy cũ) có thể mang quyền rộng hơn. FS không hỗ trợ chmod (một số
 * mount) thì bỏ qua — file vẫn ngoài Git, quyền file là lớp phụ.
 */
export function chmodFilePrivate(path: string, mode: 0o600): void {
  try {
    chmodSync(path, mode);
  } catch {
    // FS không hỗ trợ chmod (một số mount) — bỏ qua, xem JSDoc.
  }
}

/**
 * Xác định passphrase cho local Pulumi stack của một worktree.
 *
 * Vì sao KHÔNG bỏ hẳn passphrase: Pulumi CLI 3.270 trên DIY backend (`file://`)
 * **luôn** đòi passphrase — `stack init` fail với "could not create secrets
 * manager for new stack: passphrase must be set with PULUMI_CONFIG_PASSPHRASE or
 * PULUMI_CONFIG_PASSPHRASE_FILE", và mọi lệnh nạp stack config (`up`,
 * `preview`, `destroy`) fail tương tự. Không có cờ nào tắt được: `--secrets-provider`
 * chỉ nhận `default|passphrase|awskms|azurekeyvault|gcpkms|hashivault`, mà
 * `default` trên DIY backend vẫn là passphrase provider, và CLI còn kiểm
 * passphrase với salt của stack kể cả khi stack không có secret nào (sai →
 * "incorrect passphrase"). Đây là ràng buộc đo được của CLI, không phải lựa
 * chọn của repo.
 *
 * Vì vậy yêu cầu "developer không phải tự đặt passphrase" được giải ở tầng
 * orchestration: passphrase của local stack do công cụ sinh, lưu ngoài Git, và
 * truyền vào env của subprocess Pulumi. Developer không cần biết nó tồn tại.
 *
 * Thứ tự ưu tiên — file của worktree TRƯỚC biến môi trường: stack local đã
 * được tạo bằng passphrase trong file đó, nên file luôn khớp state. Biến môi
 * trường chỉ là fallback cho stack tạo trước khi có file (passphrase của
 * developer) — và khi lấy từ biến môi trường, giá trị đó được ghi vào file để
 * stack tự chứa từ lần chạy sau.
 *
 * `create: false` = không tạo file (đường read-only như `local-status`); thiếu
 * passphrase thì trả `{ kind: 'none' }` để caller quyết định, thay vì âm thầm
 * sinh file trong lệnh không được phép mutate.
 */
export function resolveLocalPassphrase(
  worktreeRoot: string,
  options: { create: boolean },
): LocalPassphrase {
  const stored = readWorktreePassphrase(worktreeRoot);
  if (stored !== undefined) return { kind: 'worktree', value: stored };

  const inline = process.env.PULUMI_CONFIG_PASSPHRASE;
  if (typeof inline === 'string' && inline.length > 0) {
    // Passphrase của developer (stack tạo trước khi có file) — ghi vào file để
    // stack tự chứa từ lần chạy sau, kể cả khi biến môi trường đổi.
    if (options.create) {
      const persisted = writeWorktreePassphrase(worktreeRoot, inline);
      if (persisted !== inline) {
        // EEXIST race: dùng giá trị canonical đã persist, không dùng inline.
        return { kind: 'worktree', value: persisted };
      }
    }
    return { kind: 'inline', value: inline };
  }

  const passphraseFile = process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
  if (typeof passphraseFile === 'string' && passphraseFile.length > 0) {
    return { kind: 'file' };
  }

  if (options.create) {
    // Fail closed: nếu state Pulumi đã init nhưng không resolve được passphrase,
    // KHÔNG được sinh passphrase mới (sẽ không unlock state cũ). Yêu cầu
    // developer cung cấp passphrase qua biến môi trường.
    if (hasPulumiState(worktreeRoot)) {
      throw new Error(
        'This worktree already has local Pulumi state but no passphrase was found ' +
          '(no .pulumi-local-passphrase file and no ' +
          'PULUMI_CONFIG_PASSPHRASE/PULUMI_CONFIG_PASSPHRASE_FILE). Generating a new ' +
          'passphrase will not unlock the old state. Supply the correct passphrase again via ' +
          'PULUMI_CONFIG_PASSPHRASE (or PULUMI_CONFIG_PASSPHRASE_FILE), or delete the ' +
          'state + volume to start over.',
      );
    }
    const generated = generatePassphrase();
    const persisted = writeWorktreePassphrase(worktreeRoot, generated);
    return { kind: 'worktree', value: persisted };
  }

  return { kind: 'none' };
}

/**
 * Env dùng chung cho mọi lệnh Pulumi trong luồng này.
 *
 * `pulumiEnv(ctx)` không cần `pulumi login`: `PULUMI_BACKEND_URL` chỉ thẳng
 * backend. Passphrase truyền vào qua `LocalPassphrase`:
 *
 * - `inline`/`worktree` → set `PULUMI_CONFIG_PASSPHRASE`.
 * - `file` → XOÁ biến `PULUMI_CONFIG_PASSPHRASE` khỏi env thay vì set — set
 *   chuỗi (kể cả rỗng) đặt biến ở vị trí ưu tiên cao nhất của thứ tự giải
 *   passphrase và chặn CLI đọc `PULUMI_CONFIG_PASSPHRASE_FILE`.
 * - `none` → xoá **cả hai** biến: CLI phải báo đúng lý do ("passphrase must be
 *   set with PULUMI_CONFIG_PASSPHRASE or PULUMI_CONFIG_PASSPHRASE_FILE") thay vì
 *   im lặng đọc một file mà môi trường còn sót lại.
 */
export function pulumiEnv(ctx: LocalDeployContext, passphrase: LocalPassphrase): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PULUMI_BACKEND_URL: ctx.stateUrl,
    PULUMI_SKIP_UPDATE_CHECK: '1',
  };
  switch (passphrase.kind) {
    case 'inline':
    case 'worktree':
      env.PULUMI_CONFIG_PASSPHRASE = passphrase.value;
      break;
    case 'file':
      delete env.PULUMI_CONFIG_PASSPHRASE;
      break;
    case 'none':
      delete env.PULUMI_CONFIG_PASSPHRASE;
      delete env.PULUMI_CONFIG_PASSPHRASE_FILE;
      break;
  }
  return env;
}

/**
 * Stack name ĐẦY ĐỦ cho một lệnh Pulumi trong một deploy project.
 *
 * Trên backend `file://`, stack name đầy đủ là `organization/<project>/<stack>`
 * (org literal `organization` — backend này chỉ chấp nhận org đó). Dạng ngắn
 * `local-<ns>` vẫn dùng cho `stack init`/`select` vì CLI tự bổ sung org hiện
 * hành, nhưng mọi lệnh KHÁC phải dùng dạng đầy đủ qua `--stack` để không phụ
 * thuộc selected-stack toàn cục.
 */
export function fullStackRef(projectName: string, ctx: LocalDeployContext): string {
  return `organization/${projectName}/${ctx.stackName}`;
}

/**
 * Chuẩn bị backend + stack cho một project TRƯỚC khi chạy lệnh đọc/ghi state.
 *
 * Hai bước, mỗi bước an toàn khi chạy lại (idempotent):
 * 1. `mkdir` state dir — backend `file://` đòi thư mục tồn tại trước (PU11).
 * 2. `stack init <short-name>` — exit 0 khi vừa tạo; exit != 0 khi stack đã có
 *    (hoặc lỗi thật) — phân biệt bằng `stack select`: select thành công nghĩa là
 *    "đã có sẵn", select fail nghĩa là lỗi thật.
 *
 * KHÔNG có `pulumi login` ở đây: backend được chọn qua env
 * `PULUMI_BACKEND_URL` của từng lệnh, không có selected backend toàn cục nào
 * bị ghi.
 *
 * Lưu ý: `stack init` trả exit 0 nhưng CÓ THỂ in stderr warning — không kiểm
 * stderr, chỉ kiểm status.
 */
export function ensureStack(
  projectDir: string,
  projectName: string,
  ctx: LocalDeployContext,
  env: NodeJS.ProcessEnv,
): void {
  mkdirSync(localStateDir(ctx.worktreeRoot), { recursive: true });
  const init = exec('pulumi', ['stack', 'init', ctx.stackName], projectDir, env);
  if (init.status !== 0) {
    const select = exec(
      'pulumi',
      ['stack', 'select', fullStackRef(projectName, ctx)],
      projectDir,
      env,
    );
    if (select.status !== 0) {
      throw new Error(
        `pulumi stack init/select ${ctx.stackName} failed:\n${init.stderr}\n${select.stderr}`,
      );
    }
  }
}

/**
 * Chạy một lệnh Pulumi với context ĐÚNG worktree — `--stack` đầy đủ, env backend
 * tường minh. Lỗi (exit != 0) → throw kèm stderr; KHÔNG in secret (Pulumi tự
 * redact secret trong stderr/stdout của nó, và message chỉ echo *lệnh*, không
 * echo giá trị arg sau `--secret`).
 *
 * `ensureStack` chỉ chạy khi `prepareStack === true`: mặc định là KHÔNG đụng
 * state — lệnh `destroy`/`stack output` kiểu "đọc/teardown" KHÔNG được tạo state
 * trên worktree chưa từng deploy (mkdir + stack init biến teardown thành
 * mutation là sai ngữ nghĩa). Lệnh `up`/`config set` truyền `prepareStack:
 * true`; caller của lệnh đọc/teardown chịu trách nhiệm tự xử lý "chưa có gì
 * để đọc/xoá" (xem `resolveEntryFoundation` ở `local-entry.ts`).
 */
export function pulumiRun(
  projectDir: string,
  projectName: string,
  args: string[],
  ctx: LocalDeployContext,
  env: NodeJS.ProcessEnv,
  options: { prepareStack?: boolean; stream?: boolean } = {},
): string | undefined {
  const fullArgs = ['--stack', fullStackRef(projectName, ctx), ...args];
  if (options.prepareStack === true) {
    ensureStack(projectDir, projectName, ctx, env);
  }
  if (options.stream === true) {
    // `up`/`preview` chạy hàng phút (build image home) — stream progress ra
    // terminal thay vì giữ trong pipe đến khi xong. stdout không còn bắt được,
    // caller không được cần nó ở chế độ này. `args[0]` là subcommand thật
    // (`up`, `preview`...) — execStreaming dùng nó làm nhãn lỗi, vì `fullArgs[0]`
    // luôn là `--stack` và lỗi `pulumi --stack thất bại` không cho biết lệnh nào
    // hỏng.
    execStreaming('pulumi', fullArgs, projectDir, env, args[0] ?? 'pulumi');
    return undefined;
  }
  const run = exec('pulumi', fullArgs, projectDir, env);
  if (run.status !== 0) {
    if (run.status === null) {
      // spawnSync không chạy được process (ENOENT, EACCES) hoặc process bị
      // signal kill (OOM) — stdout/stderr rỗng, phải báo từ `error`/`signal`.
      throw new Error(`pulumi ${args[0] ?? ''} could not run: ${describeSpawnFailure(run)}`);
    }
    throw new Error(`pulumi ${args[0] ?? ''} failed:\n${run.stderr || run.stdout}`);
  }
  return run.stdout;
}
