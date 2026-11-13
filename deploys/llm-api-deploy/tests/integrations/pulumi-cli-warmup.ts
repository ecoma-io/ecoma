import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Làm ấm CLI `pulumi` TRƯỚC khi Automation API dựng workspace — điều kiện
 * chạy của suite engine-level (issue #154).
 *
 * Cơ chế đã đo được: root `package.json` khai devDependency npm `pulumi`
 * (shim `run.js`). Lần gọi đầu trên runner có cache lạnh, shim chạy
 * `get.pulumi.com/install.sh` với `stdio: "inherit"` — banner cài đặt
 * ("=== Installing Pulumi ===", "=== Pulumi is now installed! ===") đi ra
 * **stdout** cùng `v3.274.1`. `PulumiCommand.get` của Automation API parse
 * TOÀN BỘ `stdout.trim()` làm semver → thất bại; với
 * `PULUMI_AUTOMATION_API_SKIP_VERSION_CHECK` việc này chỉ được NUỐT LẶNG LẼ
 * (version = undefined) — nhưng getter `workspace.pulumiVersion` (đường dựng
 * `preview`) ném `Error: Failed to get Pulumi version`. Đó là failure thực
 * tế trên CI (job `integration-test` của PR #172): các bước `up` sau đó vẫn
 * chạy tốt vì không đọc getter, chỉ `preview` trong test đầu tiên gục.
 *
 * Probe này gọi lại đúng lệnh Automation API sẽ gọi (`pulumi version` qua
 * PATH) và CHỈ trả khi `stdout.trim()` khớp **toàn phần** semver — cùng ngữ
 * nghĩa parse với `PulumiCommand.get`. Lần thử đầu tự kích hoạt download
 * (stdout bẩn); lần kế sau cache ấm trả đúng một dòng sạch. Retry là điều
 * kiện hội tụ, không phải che lỗi: hết hạn số lần thử vẫn fail loud với
 * thông báo actionable. Không assertion nào của suite bị nới lỏng — probe
 * chỉ làm môi trường xác định trước khi workspace dựng.
 */

const CLI_VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/u;
const WARMUP_ATTEMPTS = 30;
const WARMUP_RETRY_DELAY_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

let warmupPromise: Promise<void> | null = null;

/** Idempotent trong một process vitest worker — an toàn gọi ở mọi `beforeAll`. */
export function warmPulumiCli(): Promise<void> {
  warmupPromise ??= (async (): Promise<void> => {
    for (let attempt = 1; attempt <= WARMUP_ATTEMPTS; attempt++) {
      try {
        const { stdout } = await execFileAsync('pulumi', ['version'], {
          env: { ...process.env, PULUMI_SKIP_UPDATE_CHECK: 'true' },
        });
        if (CLI_VERSION_PATTERN.test(stdout.trim())) return;
      } catch {
        // Binary đang giữa chừng extract hoặc install.sh lỗi tạm thời — thử lại.
      }
      if (attempt < WARMUP_ATTEMPTS) await sleep(WARMUP_RETRY_DELAY_MS);
    }
    throw new Error(
      `pulumi CLI did not return a parseable version after ${WARMUP_ATTEMPTS} attempts — ` +
        'automation preview requires a resolvable CLI version; inspect the pulumi npm shim cache',
    );
  })();
  return warmupPromise;
}
