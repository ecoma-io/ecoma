/**
 * Làm ấm CLI `pulumi` TRƯỚC khi Automation API (`LocalWorkspace`) dựng
 * workspace — dùng chung cho các suite integration gọi Automation API thật
 * (issues #154, #250).
 *
 * Hai cơ chế đã đo được trên runner cache lạnh:
 *
 * 1. Root `package.json` khai devDependency npm `pulumi` (shim `run.js`). Lần
 *   gọi đầu, shim tự tải và cài CLI qua `get.pulumi.com/install.sh` với
 *   `stdio: "inherit"` — banner cài đặt đi ra **stdout** cùng `v3.x.y`, nên
 *   `PulumiCommand.get` của Automation API (parse TOÀN BỘ `stdout.trim()` làm
 *   semver) thất bại hoặc trả version `undefined` (nuốt lặng lẽ) và getter
 *   `workspace.pulumiVersion` ném sau đó.
 *
 * 2. Shim cài CLI bằng cách **ghi đè binary đích tại chỗ** (`cp -r … bin/`,
 *   không phải ghi ra temp rồi rename), nên trong khoảnh khắc binary còn mở
 *   để ghi, một tiến trình khác `exec` binary đó nhận `ETXTBSY` ("text file
 *   busy") — shim bắt và in `pulumi: spawn ETXTBSY` rồi exit 1 (issue #250:
 *   `account-deploy` đỏ flake ở `stack init`, attempt sau cùng SHA lại xanh).
 *
 * Probe này gọi lại đúng lệnh Automation API sẽ gọi (`pulumi version` qua
 * PATH) và CHỈ trả khi `stdout.trim()` khớp **toàn phần** semver — cùng ngữ
 * nghĩa parse với `PulumiCommand.get`. Retry là điều kiện hội tụ, không phải
 * che lỗi: hết số lần thử vẫn fail loud với thông báo actionable.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CLI_VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/u;
const WARMUP_ATTEMPTS = 30;
const WARMUP_RETRY_DELAY_MS = 2_000;

export type WarmPulumiCliOptions = {
  attempts?: number;
  retryDelayMs?: number;
  /** Sei cho probe — unit test bơm thay vì gọi CLI thật. */
  probe?: () => Promise<{ stdout: string }>;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultProbe = (): Promise<{ stdout: string }> =>
  execFileAsync('pulumi', ['version'], {
    env: { ...process.env, PULUMI_SKIP_UPDATE_CHECK: 'true' },
  });

let warmupPromise: Promise<void> | null = null;

/**
 * Idempotent trong một process vitest worker — an toàn gọi ở mọi `beforeAll`.
 *
 * Đường mặc định (`options` rỗng) cache promise: một process chỉ probe một
 * lần. Gọi kèm `options` là YÊU CẦU RÕ một lượt warm-up mới với tham số riêng
 * — KHÔNG đi qua cache, mỗi lần gọi chạy `warmPulumiCliOnce(options)` đầy đủ
 * (cùng ngữ nghĩa gọi thẳng `warmPulumiCliOnce`). Caller cần tự kiểm soát
 * lần thử/delay nhưng vẫn muốn cache dùng `warmupPromise` pattern tự quản.
 */
export function warmPulumiCli(options?: WarmPulumiCliOptions): Promise<void> {
  if (options) return warmPulumiCliOnce(options);
  // Một lần warm-up fail KHÔNG được nhiễm cache vĩnh viễn: xoá cache khi
  // reject để lần gọi sau retry từ đầu — nếu không, một lần ETXTBSY/cài đặt
  // dang dở sẽ truyền lại cùng lỗi mãi mãi và phủ định cơ chế retry của module.
  if (!warmupPromise) {
    warmupPromise = warmPulumiCliOnce().catch((error: unknown) => {
      warmupPromise = null;
      throw error;
    });
  }
  return warmupPromise;
}

/** Một lượt warm-up đầy đủ với số lần thử có giới hạn. */
export async function warmPulumiCliOnce(options?: WarmPulumiCliOptions): Promise<void> {
  const attempts = options?.attempts ?? WARMUP_ATTEMPTS;
  const retryDelayMs = options?.retryDelayMs ?? WARMUP_RETRY_DELAY_MS;
  const probe = options?.probe ?? defaultProbe;
  const sleep = options?.sleep ?? defaultSleep;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { stdout } = await probe();
      if (CLI_VERSION_PATTERN.test(stdout.trim())) return;
    } catch (error) {
      // Binary đang giữa chừng cài/ghi (ETXTBSY cửa sổ hẹp) hoặc banner chưa
      // hết — thử lại. Lỗi cuối được giữ lại để báo nguyên nhân gốc khi hết
      // lượt thay vì nuốt vào void.
      lastError = error;
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  throw new Error(
    `pulumi CLI did not return a parseable version after ${attempts} attempts — ` +
      'automation preview requires a resolvable CLI version; inspect the pulumi npm shim cache',
    { cause: lastError },
  );
}
