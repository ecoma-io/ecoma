/**
 * Vòng đời process Worker local — nền tảng cho PR3 (generated config) và PR4
 * (orchestration deploy/status/destroy).
 *
 * Bài toán: một worktree cần chạy nhiều process `wrangler dev` (mỗi Worker một
 * process — topology hai process đã đo trong PR1, chia sẻ `--persist-to`).
 * Mỗi process là child của tool dx; tool phải biết process nào còn sống, process
 * nào chết đột ngột, và phải dọn được process mồ côi sau crash mà KHÔNG giết
 * nhầm process của worktree khác hay process không liên quan.
 *
 * Nguyên tắc PID liveness fail-closed (EPERM → coi như còn sống):
 *
 * 1. **Metadata survive qua crash** — file JSON `<stateDir>/<name>.json` ghi PID,
 *    argv (argv array, KHÔNG shell-string), startedAt. Process chết đột ngột
 *    vẫn để lại file; reader phải tự kiểm PID liveness trước khi tin metadata,
 *    và mọi hành vi destructive (kill) phải khớp thêm identity.
 * 2. **PID không phải identity.** `kill(pid, 0)` thành công chỉ chứng minh "có
 *    process nào đó sống ở PID đó" — PID được OS tái sử dụng. Vì vậy kill entry
 *    ở đây so khớp **argv record** trong file metadata với argv caller truyền:
 *    lệch argv → từ chối kill, báo lỗi rõ, KHÔNG dừng.
 * 3. **Kill luôn qua `process.kill(pid, 'SIGTERM')`**, sau timeout lùi sang
 *    SIGKILL. Không dùng shell-string (`pkill -f ...`) — pattern match như vậy
 *    trúng process không liên quan.
 * 4. **`spawn` với argv array + `env` object tường minh** — không shell-string,
 *    argument và environment đi nguyên vẹn, không quoting.
 * 5. **Readiness thuộc về caller** (PR4): hàm này chỉ quản lý process — cách
 *    kiểm "đã phục vụ" (probe `/health`, Explorer API...) phụ thuộc từng Worker
 *    nên không nằm ở đây.
 *
 * Cấp phục hồi (recovery): `scanWorkerProcesses` đọc toàn bộ metadata trong
 * stateDir của worktree, phân loại `alive`/`stale`/`unspawned`/`invalid` bằng
 * PID liveness + identity, và `terminateStaleWorker` (số ít) kill CHỈ khi metadata
 * hợp lệ + argv identity khớp + PID đã chết được chứng minh — chuẩn fail-closed.
 * Không có khái niệm duplicate trong code;
 * entry cùng `name` bị từ chối spawn đè (xem `startWorkerProcess`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';

/** Phiên bản shape của file metadata — đổi shape phải đổi số này, loader cũ từ chối đọc. */
const METADATA_VERSION = 1;

/** Thư mục state mặc định cho process tracking trong worktree (ngoài Git). */
export const WORKER_STATE_DIR_NAME = '.worker-local-state';

export function workerProcessStateDir(worktreeRoot: string): string {
  return join(worktreeRoot, WORKER_STATE_DIR_NAME);
}

/** Record của file metadata — nguồn truth của một process đã spawn. */
export interface WorkerProcessMetadata {
  version: number;
  name: string;
  pid: number;
  argv: string[];
  /** sha256 đầu 16 hex của argv — so identity nhanh hơn so ghép từng phần tử. */
  identityHash: string;
  startedAt: number;
}

/** Kết quả của `startWorkerProcess` — handle điều khiển một process con. */
export interface WorkerProcessHandle {
  /** PID thật sau event `spawn`; -1 khi spawn chưa chắc chắn hoặc đã lỗi. */
  pid: number;
  /** Đã exit chưa — 'error' event KHÔNG đặt cờ này (spawn fail ≠ exit). */
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  /** Lỗi spawn từ event `error` (ENOENT, EACCES...) — không qua exit code. */
  spawnError?: string;
  /** Lỗi ghi metadata (ENOSPC, EACCES...) trong event handler — không crash tool. */
  metadataError?: string;
  metadataPath: string;
  /** Stream stdout/stderr của process — caller drain hoặc pipe vào log file. */
  stdout: Readable | null;
  stderr: Readable | null;
  /** True khi PID còn sống — poll `kill(pid, 0)`, chuẩn fail-closed. */
  alive(): boolean;
  /** Promise resolve đúng một lần khi process exit (không resolve khi spawn fail). */
  onExit: Promise<void>;
  /** SIGTERM → đợi timeoutMs → SIGKILL fallback. Lỗi gửi signal không nuốt. */
  stop(timeoutMs?: number, options?: StopOptions): Promise<void>;
  /** Xoá file metadata — dùng trong register giúp caller quản lý dọn dẹp. */
  removeMetadata(): void;
}

interface StopOptions {
  /** Bỏ SIGKILL fallback (test khống chế mạnh mẽ rejection). */
  escalationWaitMs?: number;
}

/**
 * Validate tên entry — chống path traversal (`name` được nối thẳng vào đường
 * dẫn file metadata). Chỉ chấp nhận `[A-Za-z0-9._-]`, từ chối `..` và toString
 * rỗng, nên `name` không thể vượt ra ngoài `stateDir`.
 */
export function isValidEntryName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/u.test(name) && name !== '.' && name !== '..';
}

/** Đường dẫn file metadata của một entry. */
export function metadataPathOf(stateDir: string, name: string): string {
  if (!isValidEntryName(name)) {
    throw new Error(
      `invalid worker entry name '${name}' — only [A-Za-z0-9._-] is accepted, cannot escape the stateDir`,
    );
  }
  return join(stateDir, `${name}.json`);
}

/** Identity hash của argv — dư 16 hex là đủ phân biệt trong thực tế. */
export function identityHashOf(argv: string[]): string {
  return createHash('sha256').update(argv.join('\u0000')).digest('hex').slice(0, 16);
}

/** So hai argv — trước khi kill phải khớp identity. */
export function sameIdentity(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Đọc file metadata. Fail-closed: file thiếu, sai shape, sai version → `null`
 * (không phải "metadata rác cũng tin"). Loader của orchestration gọi hàm này
 * trước khi quyết định kill: metadata `null` ⇒ không có identity khớp ⇒ không kill.
 */
export function readMetadata(path: string): WorkerProcessMetadata | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorkerProcessMetadata>;
    if (parsed.version !== METADATA_VERSION) return null;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    if (!Array.isArray(parsed.argv) || parsed.argv.length === 0) return null;
    if (parsed.argv.some((arg) => typeof arg !== 'string')) return null;
    if (typeof parsed.identityHash !== 'string' || parsed.identityHash.length === 0) return null;
    // identityHash phải khớp argv — bắt file corrupt một phần.
    if (parsed.identityHash !== identityHashOf(parsed.argv)) return null;
    if (typeof parsed.startedAt !== 'number' || parsed.startedAt <= 0) return null;
    return parsed as WorkerProcessMetadata;
  } catch {
    return null;
  }
}

/** PID liveness (EPERM → coi như còn sống, fail-closed). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM/khác: không chứng minh được chết → còn sống (fail-closed, không kill).
    return true;
  }
}

/**
 * Xoá file chỉ khi nội dung vẫn đúng với snapshot đã inspect — bảo vệ race
 * stale-recovery: giữa inspect và unlink, process khác có thể ghi/xoá file.
 * Worker runtime là user duy nhất của hàm này sau khi khóa lane toàn cục bị
 * xoá (PR #424).
 */
export function safeUnlinkIfSame(path: string, expected: string): boolean {
  try {
    const current = readFileSync(path, 'utf8');
    if (current !== expected) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function writeMetadata(path: string, metadata: WorkerProcessMetadata): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(metadata, null, 2), 'utf8');
}

/**
 * Khóa entry-level (per metadata file) để bọc check→write→spawn thành atomic:
 * hai caller spawn cùng `name` không thể cùng vượt qua guard và cùng ghi metadata.
 * Dùng `openSync('wx')` + stale-recovery qua PID (process.pid của acquirer),
 * chuẩn fail-closed. Lock mồ côi (process chết) được xoá tự
 * động qua PID liveness; lock còn sống KHÔNG bị steal.
 */
const ENTRY_LOCK_MAX_ATTEMPTS = 50;
const ENTRY_LOCK_RETRY_MS = 10;

function acquireWorkerEntryLock(metadataPath: string, name: string): () => void {
  const lockPath = `${metadataPath}.lock`;
  for (let attempt = 0; attempt < ENTRY_LOCK_MAX_ATTEMPTS; attempt += 1) {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      // Lock đã tồn tại — kiểm stale qua PID owner.
      let content: string;
      try {
        content = readFileSync(lockPath, 'utf8');
      } catch (readError) {
        const rc = (readError as NodeJS.ErrnoException).code;
        if (rc === 'ENOENT') continue; // file biến mất giữa chừng — retry
        // Lỗi IO khác: không chứng minh được stale → không steal, retry.
        const waitUntil = Date.now() + ENTRY_LOCK_RETRY_MS;
        while (Date.now() < waitUntil) {
          /* busy-wait nhỏ, bounded */
        }
        continue;
      }
      const lines = content.split('\n');
      const ownerPid = Number.parseInt(lines[0] ?? '', 10);
      if (Number.isInteger(ownerPid) && ownerPid > 0 && isPidAlive(ownerPid)) {
        // Còn sống → chờ rồi retry; không steal.
        const waitUntil = Date.now() + ENTRY_LOCK_RETRY_MS;
        while (Date.now() < waitUntil) {
          /* busy-wait nhỏ, bounded */
        }
        continue;
      }
      // Owner chết hoặc content malformed → stale recovery, chỉ xoá nếu nội dung
      // không đổi (race protection) — qua `safeUnlinkIfSame` cùng module.
      safeUnlinkIfSame(lockPath, content);
      continue;
    }
    try {
      writeSync(fd, `${process.pid}\n${token}\n${Date.now()}\n`, 0, 'utf8');
    } finally {
      closeSync(fd);
    }
    // Acquired.
    const release = (): void => {
      try {
        const current = readFileSync(lockPath, 'utf8');
        const parsed = current.split('\n');
        if (parsed[1] === token) {
          unlinkSync(lockPath);
        }
      } catch {
        // ENOENT: đã bị xoá — không sao.
      }
    };
    return release;
  }
  throw new Error(
    `worker process '${name}' is being spawned by another caller (entry lock held) — retry later`,
  );
}

interface StartOptions {
  /** Tên entry ở stateDir — là `metadataPath` của handle. */
  name: string;
  /** ARGV ARRAY — argv[0] là executable, phần còn lại là flags. KHÔNG shell string. */
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  /** Test seam — thay `node:child_process.spawn` bằng fake theo kịch bản test. */
  spawnImpl?: typeof spawn;
}

/**
 * Start một Worker process và ghi file metadata.
 *
 * Metadata được viết 2 lần: lần đầu TRƯỚC spawn (pid tạm `0`, version đầy đủ
 * argv/identityHash — để crash giữa spawn và event `spawn` vẫn để lại bằng chứng
 * identity), lần hai SAU event `spawn` khi PID thật đã có. File pid-`0` bị
 * loader từ chối (`pid <= 0`), đúng mục đích: không PID thì không kill gì được.
 * Entry pid-`0` còn sót được scan phân loại `unspawned` và dọn qua
 * `deleteStaleWorkerMetadata` — không còn là file không rõ nguồn.
 *
 * Không ghi đè metadata của process đang sống: entry cùng `name` với PID còn
 * sống bị từ chối spawn (identity lệch hay khớp đều không đè — identity khớp
 * nghĩa là process đó vẫn chạy). PID đã chết (metadata stale) được ghi đè an
 * toàn — đây là path recovery.
 *
 * **CẢNH BÁO SECRET**: argv được lưu plaintext vào file metadata (stateDir,
 * ngoài Git) — KHÔNG bao giờ truyền secret/token/password qua argv. Secrets
 * thuộc về env object (Worker Secrets, native runtime) và không bao giờ đi qua
 * file này.
 *
 * KHÔNG có readiness/startup timeout ở đây — đó là trách nhiệm của caller.
 */
export function startWorkerProcess(options: StartOptions): WorkerProcessHandle {
  if (!Array.isArray(options.argv) || options.argv.length === 0) {
    throw new Error(
      'startWorkerProcess: argv must be a non-empty array (argv[0] is the executable)',
    );
  }
  if (typeof options.argv[0] !== 'string' || options.argv[0].length === 0) {
    throw new Error('startWorkerProcess: argv[0] must be a non-empty executable path string');
  }
  const metadataPath = metadataPathOf(options.stateDir, options.name);

  // Bọc check→write→spawn trong entry lock để hai caller không cùng vượt guard
  // (OCR finding high: TOCTOU giữa readMetadata → isPidAlive → writeMetadata).
  const releaseEntryLock = acquireWorkerEntryLock(metadataPath, options.name);
  try {
    // Không ghi đè metadata của process còn sống — tránh orphan mất bằng chứng PID.
    // Ngoại lệ: PID sống nhưng takeover (cmdline lệch/trống trên Linux) — PID bị
    // OS tái sử dụng cho process không liên quan. isPidAlive một mình sẽ khoá
    // entry vĩnh cửu (scan phân loại 'alive' và giữ nó mãi mãi), nên đây được
    // coi là stale recovery — path ghi đè như JSDoc của hàm này mô tả.
    const existing = readMetadata(metadataPath);
    if (
      existing !== null &&
      isPidAlive(existing.pid) &&
      !pidTakenOver(existing.pid, existing.argv)
    ) {
      if (sameIdentity(existing.argv, options.argv)) {
        throw new Error(
          `worker process '${options.name}' is already running (pid ${existing.pid}) — not spawning over it`,
        );
      }
      throw new Error(
        `stateDir already has entry '${options.name}' with a different identity (pid ${existing.pid}) — not overwriting`,
      );
    }
  } catch (error) {
    releaseEntryLock();
    throw error;
  }

  const identityHash = identityHashOf(options.argv);
  const initialMetadata: WorkerProcessMetadata = {
    version: METADATA_VERSION,
    name: options.name,
    pid: 0,
    argv: options.argv,
    identityHash,
    startedAt: Date.now(),
  };
  try {
    writeMetadata(metadataPath, initialMetadata);
  } catch (error) {
    releaseEntryLock();
    throw error;
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnImpl(options.argv[0], options.argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      // process group riêng: kill cả workerd con qua -pid (PR1 topology: wrangler + workerd).
      detached: true,
      // stdin đóng ngay; stdout/stderr drain bên dưới để tránh deadlock pipe OS.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // spawn throw đồng bộ thì không có event `spawn`/`error` nào bắn — không
    // giải phóng entry lock thì lock còn sót với owner pid đang sống,
    // stale-recovery không bao giờ kích hoạt và mọi lần spawn sau cùng `name`
    // đều chờ hết attempts rồi throw. Dọn luôn metadata pid-0 vừa ghi để
    // stateDir không tích rác `unspawned`.
    releaseEntryLock();
    try {
      rmSync(metadataPath, { force: true });
    } catch {
      // ignore — metadata có thể chưa kịp ghi
    }
    throw error;
  }

  const handle: WorkerProcessHandle = {
    pid: -1,
    exited: false,
    exitCode: null,
    exitSignal: null,
    metadataPath,
    spawnError: undefined,
    metadataError: undefined,
    stdout: (child.stdout as Readable | null) ?? null,
    stderr: (child.stderr as Readable | null) ?? null,
    alive: () => !handle.exited && isPidAlive(handle.pid),
    onExit: undefined as unknown as Promise<void>,
    removeMetadata(): void {
      try {
        rmSync(metadataPath, { force: true });
      } catch {
        // ENOENT bình thường; lỗi khác vẫn được bỏ qua — file metadata không
        // đủ quan trọng để fail một teardown.
      }
    },
    async stop(timeoutMs = 10_000, optionsOverride: StopOptions = {}): Promise<void> {
      if (handle.pid <= 0 || handle.exited || !isPidAlive(handle.pid)) return;
      // Kill process group trước; fallback single pid khi group kill không áp dụng.
      const send = (signal: NodeJS.Signals): void => {
        try {
          process.kill(-handle.pid, signal);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ESRCH' || code === 'EPERM') {
            try {
              process.kill(handle.pid, signal);
            } catch (inner) {
              const innerCode = (inner as NodeJS.ErrnoException).code;
              if (innerCode !== 'ESRCH') throw inner;
            }
          } else {
            throw error;
          }
        }
      };
      try {
        send('SIGTERM');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') throw error;
        return; // process đã chết giữa chừng — kill không cần thiết
      }
      const waitEscalate = optionsOverride.escalationWaitMs ?? timeoutMs;
      if (waitEscalate <= 0) return;
      const deadline = Date.now() + waitEscalate;
      while (!handle.exited && isPidAlive(handle.pid) && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      if (!handle.exited && isPidAlive(handle.pid)) {
        try {
          send('SIGKILL');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') throw error;
        }
        // Chờ reap sau SIGKILL — zombie vẫn `kill(pid,0)` thành công cho tới
        // khi parent reap, nên phải đợi 'exit' event thực sự bắn.
        const reapDeadline = Date.now() + 1000;
        while (!handle.exited && Date.now() < reapDeadline) {
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
        }
      }
      if (!handle.exited) {
        throw new Error(`worker process '${options.name}' (pid ${handle.pid}) did not terminate`);
      }
    },
  };

  // Drain pipe để process không block khi ghi stdout/stderr liên tục (wrangler dev).
  try {
    child.stdout?.resume();
    child.stderr?.resume();
  } catch {
    // ignore
  }

  let resolveExit: (() => void) | null = null;
  child.on('spawn', () => {
    handle.pid = child.pid ?? -1;
    if (handle.pid > 0) {
      try {
        writeMetadata(metadataPath, { ...initialMetadata, pid: handle.pid });
      } catch (error) {
        handle.metadataError = (error as NodeJS.ErrnoException).message ?? String(error);
        // Fail-closed: metadata thất bại nghĩa là process sống không còn bằng
        // chứng PID — spawn đè sẽ bị từ chối nhưng `deleteStaleWorkerMetadata`
        // phân loại pid-0 là `unspawned` và có thể dọn. Kill ngay để không rò
        // process/port khuyết bằng chứng; metadata pid-0 còn sót được dọn an
        // toàn qua path scan chuẩn.
        try {
          process.kill(handle.pid, 'SIGKILL');
        } catch {
          // ignore — process có thể đã exit
        }
        handle.spawnError = `metadata write failed: ${handle.metadataError}`;
      }
    }
    try {
      releaseEntryLock();
    } catch {
      // ignore
    }
  });

  child.on('error', (error: Error) => {
    // spawnError KHÔNG đặt `exited` hay resolve `onExit` — spawn fail nghĩa là
    // process chưa hề có vòng đời nào; caller vẫn dọn metadata qua
    // `removeMetadata()`.
    handle.spawnError = `${error.name}: ${error.message}`;
    try {
      releaseEntryLock();
    } catch {
      // ignore
    }
  });

  child.on('exit', (code, signal) => {
    handle.exited = true;
    handle.exitCode = code;
    handle.exitSignal = signal;
    resolveExit?.();
  });

  // Gán promise SAU khi đã đăng ký mọi listener: executor của `new Promise`
  // chạy đồng bộ ngay lúc construct, nên closure `resolveExit` phải có giá trị
  // trước khi 'exit' event có thể bắn. Gán `handle.onExit` sau cùng giúp mọi
  // listener đã đăng ký trước khi promise tồn tại — không có race "promise
  // resolve trước khi caller gán".
  handle.onExit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  return handle;
}

export type { StopOptions };

// ---------- Kill bằng bằng chứng từ file metadata (API PR4, additive) ----------

/** Kiểu kết quả Kill-from-metadata — caller render row theo nhánh còn lại. */
export type KillWorkerByMetadataResult =
  | { result: 'done' }
  | { result: 'not-provable'; reason: string }
  | { result: 'error'; reason: string };

/**
 * Kill process group của entry được đọc từ FILE metadata — dùng cho PR4
 * `down`, nơi caller không còn handle trong tay mà chỉ có stateDir + argv
 * của entry chuẩn (đối chiếu identity từ argv record trong file metadata).
 *
 * Bốn guard fail-closed trước khi tới được lệnh kill, cùng chuẩn với
 * `terminateStaleWorker` nhưng NÂNG CẤP cho PID SỐNG (process đang chạy):
 *
 * 1. metadata phải đọc được (shape + version + identityHash khớp argv);
 * 2. argv record phải khớp argv caller truyền (`sameIdentity`);
 * 3. `pidCmdlineMatches` phải khớp — cmdline lệch/trống (Linux) là PID bị
 *    OS tái sử dụng cho process không liên quan → KHÔNG kill (trên
 *    non-Linux kiểm tra này skipped documented, và hàng rào chính vẫn là
 *    argv identity + metadata);
 * 4. PID phải còn sống — PID chết không có gì để kill (caller xử lý stale
 *    file bằng `deleteStaleWorkerMetadata`, KHÔNG phải hàm này).
 *
 * Sau SIGTERM process group, đợi `timeoutMs` rồi SIGKILL group tương tự cách
 * `handle.stop` làm (fall back về single pid trên ESRCH/EPERM). Trả về kết
 * quả từng entry thay vì throw giữa chừng — một entry lỗi không cản được
 * caller teardown các entry còn lại.
 */
export async function killWorkerProcessByMetadata(options: {
  metadataPath: string;
  expectedArgv: string[];
  timeoutMs?: number;
}): Promise<KillWorkerByMetadataResult> {
  const metadata = readMetadata(options.metadataPath);
  if (metadata === null) {
    // Không đủ bằng chứng identity → không touch process nào; caller phải
    // nhìn thấy quy tắc này trong output của mình.
    return { result: 'not-provable', reason: 'metadata invalid' };
  }
  if (!sameIdentity(metadata.argv, options.expectedArgv)) {
    return { result: 'not-provable', reason: 'argv identity mismatch' };
  }
  if (!pidCmdlineMatches(metadata.pid, metadata.argv)) {
    return { result: 'not-provable', reason: 'cmdline mismatch — possible PID reuse' };
  }
  if (!isPidAlive(metadata.pid)) {
    return { result: 'not-provable', reason: 'pid not alive' };
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const send = (signal: NodeJS.Signals): 'sent' | 'dead' | 'forbidden' => {
    try {
      process.kill(-metadata.pid, signal);
      return 'sent';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return 'dead';
      // EPERM: khớp chuẩn `handle.stop` — fall back gửi single pid; nếu cũng
      // không được thì coi như bị chặn (không kill gì được).
      if (code === 'EPERM') {
        try {
          process.kill(metadata.pid, signal);
          return 'sent';
        } catch (inner) {
          const innerCode = (inner as NodeJS.ErrnoException).code;
          if (innerCode === 'ESRCH') return 'dead';
          return 'forbidden';
        }
      }
      throw error;
    }
  };

  let term;
  try {
    term = send('SIGTERM');
  } catch (error) {
    return { result: 'error', reason: (error as Error).message };
  }
  if (term === 'dead') return { result: 'done' };
  if (term === 'forbidden') {
    return { result: 'not-provable', reason: 'cannot kill (EPERM)' };
  }

  // Đợi SIGTERM có hiệu lực: PID chết, hoặc hết deadline rồi lùi sang
  // SIGKILL. Cùng chiến lược polling của handle.stop.
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(metadata.pid) && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  if (!isPidAlive(metadata.pid)) return { result: 'done' };
  let kill;
  try {
    kill = send('SIGKILL');
  } catch (error) {
    return { result: 'error', reason: (error as Error).message };
  }
  if (kill === 'dead') return { result: 'done' };
  if (kill === 'forbidden') {
    return { result: 'not-provable', reason: 'cannot SIGKILL (EPERM)' };
  }
  const reapDeadline = Date.now() + 1000;
  while (isPidAlive(metadata.pid) && Date.now() < reapDeadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  if (isPidAlive(metadata.pid)) {
    return { result: 'error', reason: `pid ${metadata.pid} did not terminate` };
  }
  return { result: 'done' };
}

/** Phân loại của một metadata entry sau khi quét stateDir. */
export type WorkerProcessState =
  | 'alive' // PID còn sống — process thật đang chạy, không đụng
  | 'stale' // PID đã chết — metadata mồ côi, an toàn dọn
  | 'unspawned' // metadata pid≤0 hợp lệ (spawn thất bại) — dọn an toàn
  | 'invalid'; // file sai shape/version — không đủ bằng chứng identity

export interface WorkerProcessScanEntry {
  name: string;
  metadataPath: string;
  metadata: WorkerProcessMetadata | null;
  state: WorkerProcessState;
  /** Raw nội dung lúc scan — dùng cho safe-unlink so sánh. */
  rawContent?: string;
}

/**
 * Quét stateDir và phân loại mọi file `*.json` metadata.
 *
 * **Invariant an toàn**: metadata `null` (corrupt, version lạ, pid ≤ 0) KHÔNG
 * BAO GIỜ bị coi là stale để kill — nó chỉ được gắn `invalid` và chỉ dọn được
 * qua `deleteStaleWorkerMetadata` (xoá file, không kill). Kill chỉ dành cho
 * entry có PID chết **và** identity đầy đủ, tức là có đủ bằng chứng process đó
 * đã từng chạy từ file này.
 */
export function scanWorkerProcesses(stateDir: string): WorkerProcessScanEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return []; // stateDir chưa tồn tại — chưa có process nào được spawn
  }
  const results: WorkerProcessScanEntry[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const metadataPath = join(stateDir, file);
    // Snapshot raw ngay từ đầu — dùng vừa để phân loại unspawned, vừa làm
    // snapshot so sánh trước khi unlink trong `deleteStaleWorkerMetadata`.
    let raw: string | undefined;
    try {
      raw = readFileSync(metadataPath, 'utf8');
    } catch {
      // File biến mất giữa chừng — metadata cũng đọc được null về sau.
    }
    const metadata = readMetadata(metadataPath);
    const name = file.replace(/\.json$/u, '');
    if (metadata === null) {
      // Phân biệt pid≤0 hợp lệ (spawn chưa hề thành công) vs corrupt: pid≤0 bị
      // readMetadata từ chối, nhưng nếu các trường còn lại đầy đủ + identityHash
      // khớp argv thì đây là bằng chứng "spawn failed" — dọn được an toàn.
      let isUnspawned = false;
      if (raw !== undefined) {
        try {
          const p = JSON.parse(raw) as {
            pid?: unknown;
            argv?: unknown;
            identityHash?: unknown;
            version?: unknown;
          };
          if (
            p.version === METADATA_VERSION &&
            typeof p.pid === 'number' &&
            p.pid <= 0 &&
            Array.isArray(p.argv) &&
            p.argv.length > 0 &&
            p.argv.every((a) => typeof a === 'string') &&
            typeof p.identityHash === 'string' &&
            p.identityHash.length > 0 &&
            p.identityHash === identityHashOf(p.argv)
          ) {
            isUnspawned = true;
          }
        } catch {
          isUnspawned = false;
        }
      }
      results.push({
        name,
        metadataPath,
        metadata: null,
        state: isUnspawned ? 'unspawned' : 'invalid',
        rawContent: raw,
      });
      continue;
    }
    results.push({
      name,
      metadataPath,
      metadata,
      // 'stale' bao gồm cả takeover: PID sống nhưng cmdline lệch/trống (Linux)
      // — PID bị OS tái sử dụng, metadata mồ côi. pidTakenOver fail-closed cho
      // PID sống nhưng không chứng minh được identity; PID chết là stale bình
      // thường. Trên non-Linux guard này không hoạt động (documented).
      state: pidTakenOver(metadata.pid, metadata.argv)
        ? 'stale'
        : isPidAlive(metadata.pid)
          ? 'alive'
          : 'stale',
      rawContent: raw,
    });
  }
  return results;
}

/** Kết quả xoá metadata mồ côi — báo cáo từng entry thay vì throw giữa chừng. */
export interface StaleRemovalReport {
  /** File đã xoá (stale + unspawned) — metadata mồ côi/không còn process, không bằng chứng sống. */
  removed: string[];
  /** File giữ lại (alive + invalid) — process thật đang chạy, hoặc bằng chứng điều tra. */
  kept: string[];
  /** Lỗi IO xoá từng file — caller quyết định fail hay tiếp tục. */
  errors: { name: string; message: string }[];
}

/**
 * Xoá metadata mồ côi trong stateDir — chỉ FILE, không kill process nào.
 *
 * Kill process mồ côi (PID chết rồi OS tái sử dụng) nằm ở PR4 orchestration và
 * dùng `sameIdentity` của caller; PR2 chỉ đơn "metadata không còn tương ứng
 * process sống thì xoá file, để lần deploy sau start sạch". Entry `alive` và
 * `invalid` KHÔNG bị đụng: `invalid` giữ lại làm bằng chứng điều tra (caller
 * muốn xoá hẳn dùng `rmSync` trực tiếp). Entry `stale` và `unspawned` bị xoá
 * theo safe-unlink pattern (snapshot lúc scan + `safeUnlinkIfSame` re-read trước
 * khi xoá) — file bị ghi đè giữa scan và xoá không bị dọn nhầm.
 */
export function deleteStaleWorkerMetadata(stateDir: string): StaleRemovalReport {
  const report: StaleRemovalReport = { removed: [], kept: [], errors: [] };
  for (const entry of scanWorkerProcesses(stateDir)) {
    if (entry.state === 'alive' || entry.state === 'invalid') {
      report.kept.push(entry.name);
      continue;
    }
    // state 'stale' hoặc 'unspawned' → xoá file nếu nội dung không đổi giữa
    // scan và unlink (safe-unlink pattern): re-read trước khi
    // xoá, chỉ unlink khi snapshot khớp — một metadata bị ghi đè giữa chừng
    // (spawn mới cùng name) không bị xoá nhầm.
    const snapshot = entry.rawContent;
    if (snapshot === undefined) {
      report.kept.push(entry.name);
      continue;
    }
    try {
      // safeUnlinkIfSame tự re-read và so trước khi unlink; ENOENT ở lần
      // re-read coi như đã dọn xong (một process khác đã xoá) — báo removed.
      if (safeUnlinkIfSame(entry.metadataPath, snapshot)) {
        report.removed.push(entry.name);
      } else if (!existsSync(entry.metadataPath)) {
        report.removed.push(entry.name);
      } else {
        // Bị ghi đè giữa chừng — không xoá nhầm.
        report.kept.push(entry.name);
      }
    } catch (error) {
      report.errors.push({
        name: entry.name,
        message: (error as NodeJS.ErrnoException).message ?? String(error),
      });
    }
  }
  return report;
}

/**
 * Kiểm tra PID (best-effort, Linux `/proc/<pid>/cmdline`) có phải process mà
 * argv metadata ghi lại không — giảm race PID-reuse trước khi kill. Trên OS
 * không có /proc (hoặc không đọc được) thì KHÔNG chặn (fail-open ở bước này,
 * vì guard chính vẫn là identity + isPidAlive; PID-reuse race không thể khử
 * hoàn toàn không có /proc — documented).
 */
export function pidCmdlineMatches(pid: number, expectedArgv: string[]): boolean {
  if (process.platform !== 'linux') return true; // non-Linux → allow (documented)
  let raw: Buffer;
  try {
    raw = readFileSync(`/proc/${pid}/cmdline`);
  } catch {
    return true; // không đọc được → allow (documented)
  }
  if (!raw || raw.length === 0) return true;
  const parts = raw
    .toString('utf8')
    .split('\u0000')
    .filter((part) => part.length > 0);
  if (parts.length === 0) return true;
  // So basename của argv[0] (executable) — chỉ cần executive khớp: phân biệt
  // node/wrangler/workerd, đủ phát hiện PID bị takeover bởi binary khác.
  const expectedBase = basename(expectedArgv[0] ?? '');
  if (expectedBase === '') return true;
  return parts.some((part) => basename(part) === expectedBase);
}

/**
 * Phát hiện PID tiếp tục sống NHƯNG không còn là process mà metadata ghi —
 * PID bị OS tái sử dụng cho binary khác (takeover). Khác `pidCmdlineMatches`
 * (fail-open khi cmdline không đọc được), hàm này fail-CLOSED trên Linux khi
 * cmdline trống (kernel thread) hoặc không đọc được nhưng PID được isPidAlive
 * xác nhận sống: không có bằng chứng identity cho một PID sống là takeover
 * theo nghĩa metadata (metadata ghi argv binary user-space, một kernel thread
 * hay process che cmdline chắc chắn không khớp). Trên non-Linux → không phát
 * hiện được (documented — guard chính vẫn là identity + liveness).
 */
export function pidTakenOver(pid: number, expectedArgv: string[]): boolean {
  if (!isPidAlive(pid)) return false; // PID chết — stale bình thường, không phải takeover
  if (process.platform !== 'linux') return false; // không có /proc — không chứng minh được
  return !pidCmdlineMatches(pid, expectedArgv);
}

/**
 * Recovery một entry mồ côi CỤ THỂ — kill khi PID đã tái sử dụng được chứng
 * minh. Đây là duy nhất nơi thực hiện kill với entry đọc từ file: bốn guard
 * (metadata hợp lệ + metadata argv khớp argv caller + /proc cmdline khớp +
 * PID chết) phải ĐỦ cả tư mới tới được lệnh kill. Thứ tự: cmdline TRƯỚC
 * isPidAlive — khi PID còn sống, /proc/cmdline phát hiện takeover (binary
 * khác chiếm PID); khi PID đã chết, /proc không còn → guard fail-open
 * documented và killing CHỈ nhắm single PID (leader đã chết, không có bằng
 * chứng identity cho các thành viên group — group kill vào pgid có thể bị
 * chiếm dụng bởi nhóm process khác, vi phạm nguyên tắc "không kill không
 * bằng chứng").
 *
 * Trả về `null` khi không đủ điều kiện kill (metadata null, identity lệch,
 * PID chưa chết, cmdline lệch); `true` khi SIGTERM đã gửi; `false` khi
 * SIGTERM thất bại. Caller quyết định cách xử lý từng kết quả — hàm này không
 * throw cho các trường hợp "không đủ", chỉ throw khi IO file thật sự lỗi.
 */
export function terminateStaleWorker(
  stateDir: string,
  name: string,
  expectedArgv: string[],
): boolean | null {
  const metadata = readMetadata(metadataPathOf(stateDir, name));
  if (metadata === null) return null; // không đủ bằng chứng identity
  if (!sameIdentity(metadata.argv, expectedArgv)) return null; // lệch argv — từ chối
  // Guard cmdline chạy TRƯỚC isPidAlive: khi PID còn sống, /proc/cmdline là
  // cách duy nhất phát hiện PID bị takeover (binary khác chiếm PID). Khi PID
  // đã chết, /proc/<pid>/cmdline ENOENT → fail-open documented.
  if (!pidCmdlineMatches(metadata.pid, metadata.argv)) return null;
  if (isPidAlive(metadata.pid)) return null; // PID sống — không phải stale
  try {
    // Chỉ kill single PID: leader đã chết, group members không có identity
    // evidence — group kill vào pgid tái sử dụng là kill không bằng chứng.
    process.kill(metadata.pid, 'SIGTERM');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true; // đã chết giữa inspect và kill — coi xong
    if (code === 'EPERM') return false; // process sống nhưng khác owner — bỏ
    throw error; // lỗi khác — caller xử lý
  }
}
