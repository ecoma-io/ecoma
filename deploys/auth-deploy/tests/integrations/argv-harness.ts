/**
 * Harness của suite argv-hygiene (`argv-hygiene.spec.ts`) — mọi đường docker
 * mà suite đi qua được BỌC bởi shim ghi argv, và MỘT watcher quét
 * `/proc/<pid>/cmdline` suốt luồng chạy.
 *
 * Hai kênh bắt argv, bắt đủ hai phía:
 * 1. **Shim `docker`** đứng ĐẦU `PATH` của mọi script chạy trong luồng test:
 *    mỗi lời gọi ghi TOÀN BỘ argv (NUL-separated) ra file log rồi `exec` sang
 *    docker thật — `exec` giữ nguyên stdin/stdout/stderr, nên pipe của
 *    `docker exec -i` và env passthrough của `docker run -e NAME` vẫn chạy đúng.
 * 2. **Watcher `/proc`**: vòng lặp ~120ms đọc `cmdline` của mọi process trên
 *    host (gồm cả process BÊN TRONG container — chúng là process thật của
 *    kernel), tìm byte-exact từng giá trị sentinel. Watcher nhận giá trị cần
 *    tìm từ FILE (không argv, không env) — chính watcher không được trở thành
 *    process mang secret trong argv.
 *
 * ⚠️ Thư mục làm việc của harness nằm ở `os.tmpdir()`, KHÔNG trong repo: log
 * argv và file pattern là artifact chạy test, không được bẩn working tree.
 * Giá trị sentinel là dữ liệu GIẢ (không phải secret thật) nhưng vẫn được dọn
 * sạch sau khi chạy.
 *
 * Bản copy package-local của pattern `deploys/account-deploy/tests/integrations/
 * argv-harness.ts` (06-testing.md §6: không shared test-support giữa các deploy
 * unit — mỗi unit tự sở hữu harness của mình).
 */

import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Kết quả một lần chạy script qua shim-PATH. */
export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Tên kênh → giá trị cần tìm trong argv của MỌI process trong luồng chạy. */
export type WatchPatterns = Record<string, string>;

export interface ArgvHarness {
  /** Tên container PostgreSQL một-shot của suite. */
  readonly containerName: string;
  /** Docker network riêng của suite — alias `ecoma-postgres` chỉ hợp lệ trong nó. */
  readonly networkName: string;
  /**
   * `PATH` cho luồng test: thư mục shim đứng ĐẦU — mọi `docker` mà script sinh
   * ra đi qua shim ghi argv trước khi chạm docker thật.
   */
  readonly flowPath: string;
  /** Ghi các giá trị cần quét rồi khởi động watcher (phải gọi trước luồng chạy). */
  startWatcher(patterns: WatchPatterns): Promise<void>;
  /** Dựng container PostgreSQL một-shot trên network riêng, chờ sẵn sàng. */
  startPostgres(postgresImage: string): Promise<void>;
  /** Chạy script text bằng `/bin/sh -c` với PATH đã bọc shim + env bổ sung. */
  runScript(scriptText: string, env?: Record<string, string>): Promise<RunResult>;
  /** Nội dung log argv của shim (bytes NUL-separated — tìm bằng byte). */
  readArgvLog(): Promise<Buffer>;
  /** Toàn bộ hit của watcher, mỗi dòng `channel pid=<pid>` (KHÔNG chứa giá trị). */
  readWatcherHits(): Promise<string>;
  /** Dọn mọi thứ: watcher, container, network, thư mục tmp. Best-effort từng bước. */
  stop(): Promise<void>;
}

/** Hình mẫu shim: tham số `REAL_DOCKER` được thay lúc ghi file. */
const SHIM_TEMPLATE = `#!/bin/sh
# Shim ghi argv của MỌI lời gọi docker trong luồng test argv-hygiene: toàn bộ
# argv (NUL-separated) vào file log rồi exec sang docker thật. exec giữ nguyên
# stdin/stdout/stderr — pipe \`docker exec -i\` và env passthrough vẫn đúng.
printf '%s\\0' "$0" "$@" >> "\${ECOMA_ARGV_LOG:?ECOMA_ARGV_LOG must be set}" || exit 90
printf '\\n' >> "$ECOMA_ARGV_LOG" || exit 90
exec '__REAL_DOCKER__' "$@"
`;

/** Hình mẫu watcher: chạy bằng `node watcher.mjs <patternsFile> <hitsFile>`. */
const WATCHER_TEMPLATE = `// Watcher /proc/*/cmdline của suite argv-hygiene: giá trị cần tìm đọc từ FILE
// (không argv/env) — watcher không được trở thành process mang secret trong
// argv của chính nó. Mỗi hit ghi MỘT dòng \`<channel> pid=<pid>\`, không bao giờ
// ghi cmdline (nó chứa giá trị).
import { appendFile, readFile, readdir } from 'node:fs/promises';

const [, , patternsFile, hitsFile] = process.argv;
const patterns = (await readFile(patternsFile, 'utf8'))
  .split('\\n')
  .filter((line) => line.length > 0)
  .map((line) => {
    const separator = line.indexOf(' ');
    return {
      channel: line.slice(0, separator),
      needle: Buffer.from(line.slice(separator + 1), 'utf8'),
    };
  });
if (patterns.length === 0) {
  console.error('watcher: empty pattern file');
  process.exit(91);
}
// Mạng an toàn: watcher tự thoát sau 10 phút kể cả khi bị bỏ rơi (worker chết
// cứng trước khi kịp kill) — không để vòng lặp sống mãi trên máy developer.
setTimeout(() => process.exit(0), 600_000).unref();

for (;;) {
  let pids = [];
  try {
    pids = (await readdir('/proc')).filter((name) => /^\\d+$/.test(name));
  } catch {
    // /proc nhất thời không đọc được (namespace đổi...) — bỏ qua vòng này.
  }
  for (const pid of pids) {
    let cmdline;
    try {
      cmdline = await readFile('/proc/' + pid + '/cmdline');
    } catch {
      continue; // process chết giữa chừng — bình thường.
    }
    for (const { channel, needle } of patterns) {
      if (cmdline.includes(needle)) {
        await appendFile(hitsFile, channel + ' pid=' + pid + '\\n').catch(() => undefined);
        break; // một process chỉ ghi MỘT dòng mỗi vòng — đủ để bắt vi phạm.
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
}
`;

/**
 * Resolve đường dẫn docker THẬT trước khi PATH bị chèn shim lên đầu — shim
 * `exec` sang đúng binary này, không đệ quy vào chính nó.
 */
function resolveRealDocker(): string {
  const probe = spawnSync('/bin/sh', ['-c', 'command -v docker'], { encoding: 'utf8' });
  const resolved = probe.stdout?.trim();
  if (probe.status !== 0 || !resolved) {
    throw new Error(
      'docker binary not found on PATH: the argv-hygiene suite cannot run without Docker.',
    );
  }
  return resolved;
}

/** Helper execFile promise hoá, encoding utf8, không shell. */
function exec(
  file: string,
  args: string[],
  options: { env?: Record<string, string>; timeout?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: options.timeout ?? 120_000, env: options.env },
      (error, stdout, stderr) => {
        // exit non-zero là KẾT QUẢ trả về cho caller quyết định (docker run báo
        // lỗi ứng dụng, pg_isready báo chưa sẵn sàng...) — chỉ spawn-failure
        // (ENOENT, EACCES: error.code là string) mới là lỗi của harness.
        if (error !== null && typeof (error as { code?: unknown }).code !== 'number') {
          reject(error);
          return;
        }
        resolve({
          code: error !== null ? ((error as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

/** Tạo harness: thư mục tmp, shim docker, watcher script (CHƯA start). */
export async function createArgvHarness(): Promise<ArgvHarness> {
  const realDocker = resolveRealDocker();
  const rootDir = await mkdtemp(join(tmpdir(), 'auth-deploy-argv-hygiene-'));
  const suffix = randomUUID().slice(0, 8);

  const shimDir = join(rootDir, 'shim');
  await mkdir(shimDir, { recursive: true });
  const shimPath = join(shimDir, 'docker');
  await writeFile(shimPath, SHIM_TEMPLATE.replace('__REAL_DOCKER__', realDocker), {
    mode: 0o755,
  });
  await chmod(shimPath, 0o755);

  const watcherPath = join(rootDir, 'watcher.mjs');
  await writeFile(watcherPath, WATCHER_TEMPLATE);
  const patternsPath = join(rootDir, 'watch-patterns.txt');
  const hitsPath = join(rootDir, 'watcher-hits.log');
  const argvLogPath = join(rootDir, 'docker-argv.log');

  const containerName = `ecoma-argv-${suffix}-pg`;
  const networkName = `ecoma-argv-${suffix}-net`;

  let watcher: ReturnType<typeof spawn> | undefined;
  let watcherStarted = false;

  const harness: ArgvHarness = {
    containerName,
    networkName,
    flowPath: `${shimDir}:${process.env.PATH ?? ''}`,

    async startWatcher(patterns: WatchPatterns): Promise<void> {
      const body = Object.entries(patterns)
        .map(([channel, value]) => `${channel} ${value}`)
        .join('\n');
      await writeFile(patternsPath, `${body}\n`);
      watcher = spawn(process.execPath, [watcherPath, patternsPath, hitsPath], {
        stdio: 'ignore',
      });
      watcherStarted = true;
      // Cho watcher một vòng quát đầu tiên; exit ngay trong window này là lỗi
      // dựng harness (script hỏng, patterns rỗng...) — phải đỏ ngay từ setup.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      if (watcher.exitCode !== null) {
        throw new Error(`argv-hygiene watcher exited during startup with code ${watcher.exitCode}`);
      }
    },

    async startPostgres(postgresImage: string): Promise<void> {
      // Network + container dùng docker THẬT (setup, không phải luồng được
      // assert): log argv của shim chỉ chứa lời gọi của script provision/migrate.
      await exec(realDocker, ['network', 'create', networkName]);
      // POSTGRES_PASSWORD truyền qua env passthrough (chỉ TÊN biến trong argv)
      // — đúng kỷ luật mà suite này assert, kể cả với mật khẩu bootstrap giả.
      // POSTGRES_HOST_AUTH_METHOD=scram-sha-256: entrypoint APPEND dòng
      // `host all all all scram-sha-256` vào pg_hba — các dòng loopback trust
      // mặc định của initdb đứng TRƯỚC (first-match wins), nên verify mật khẩu
      // thật chỉ áp dụng cho kết nối TỪ address khác loopback. Suite lợi dụng
      // đúng hình này: migrate nối qua network nội bộ (scram — DATABASE_URL
      // được verify thật), còn login check nối tới IP eth0 của container
      // (không 127.0.0.1) để rơi vào dòng scram — xem argv-hygiene.spec.ts.
      const started = await exec(
        realDocker,
        [
          'run',
          '-d',
          '--name',
          containerName,
          '--network',
          networkName,
          '--network-alias',
          'ecoma-postgres',
          '-e',
          'POSTGRES_USER=ecoma_local',
          '-e',
          'POSTGRES_DB=ecoma_local',
          '-e',
          'POSTGRES_PASSWORD',
          '-e',
          'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
          postgresImage,
        ],
        {
          env: { ...process.env, POSTGRES_PASSWORD: 'ecoma-argv-hygiene-bootstrap' },
          timeout: 600_000, // docker tự pull khi thiếu image — pull lần đầu có thể lâu.
        },
      );
      if (started.code !== 0) {
        throw new Error(`postgres container failed to start:\n${started.stderr}`);
      }
      // Chờ sẵn sàng qua TCP (`-h 127.0.0.1`): lần boot ĐẦU của image, entrypoint
      // chạy một server TẠM chỉ nghe unix socket, rồi dừng nó (kill connection
      // đang sống bằng "administrator command") trước khi mở server thật nghe
      // TCP — pg_isready qua socket có thể "sẵn sàng" nhầm ở pha tạm. TCP ready
      // = server thật đã mở cổng. Bỏ quá 60s là lỗi dựng harness, phải đỏ.
      const deadline = Date.now() + 60_000;
      for (;;) {
        const ready = await exec(realDocker, [
          'exec',
          containerName,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'ecoma_local',
          '-d',
          'postgres',
        ]);
        if (ready.code === 0) break;
        if (Date.now() > deadline) {
          throw new Error(`postgres container never became ready:\n${ready.stderr}`);
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
      }
    },

    async runScript(scriptText: string, env?: Record<string, string>): Promise<RunResult> {
      return new Promise<RunResult>((resolve, reject) => {
        // `/bin/sh -c <script>` — cùng hình mà provider của command.local.Command
        // dùng (default interpreter ["/bin/sh", "-c"]). PATH bọc shim ĐẦU và
        // ECOMA_ARGV_LOG ghi đè lên mọi env caller truyền vào: bất biến của
        // harness là MỌI `docker` trong luồng phải đi qua shim ghi argv.
        const child = spawn('/bin/sh', ['-c', scriptText], {
          env: {
            ...env,
            PATH: harness.flowPath,
            ECOMA_ARGV_LOG: argvLogPath,
          },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += String(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },

    async readArgvLog(): Promise<Buffer> {
      return readFile(argvLogPath).catch(() => Buffer.alloc(0));
    },

    async readWatcherHits(): Promise<string> {
      return readFile(hitsPath, 'utf8').catch(() => '');
    },

    async stop(): Promise<void> {
      // Alias cục bộ: TS không giữ narrowing cho biến `let` ở scope ngoài khi
      // dùng bên trong closure của method.
      const watcherProcess = watcher;
      if (watcherProcess !== undefined && watcherStarted) {
        // SIGTERM trước, SIGKILL sau 2s — vòng lặp watcher không được sống sót
        // sau suite dưới bất kỳ hình thức nào.
        watcherProcess.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            watcherProcess.kill('SIGKILL');
            resolve();
          }, 2_000);
          timer.unref();
          watcherProcess.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      await exec(realDocker, ['rm', '-f', containerName], { timeout: 30_000 }).catch(
        () => undefined,
      );
      await exec(realDocker, ['network', 'rm', networkName], { timeout: 30_000 }).catch(
        () => undefined,
      );
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };

  return harness;
}
