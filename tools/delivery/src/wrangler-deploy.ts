/**
 * Lớp bọc `wrangler deploy` cho lane staging với retry backoff có phân loại
 * (hợp đồng `02-delivery.md` §7.4 "Retry quanh `wrangler deploy`"):
 *
 * - Tối đa 3 lần thử, backoff 15s rồi 30s, trần 4 phút mỗi lần thử.
 * - Retry CHỈ khi lỗi được phân loại là tạm thời: HTTP 5xx/429, malformed
 *   response của Cloudflare API, và lớp lỗi transport/undici (fetch failed,
 *   socket hang up, ECONNRESET, ETIMEDOUT...). Cloudflare đã quan sát thật là
 *   trả 504 kèm body HTML hoặc đóng socket giữa chừng.
 * - Lỗi cấu hình hoặc quyền (403, 401, thiếu biến môi trường, config sai)
 *   ABORT ngay lần thử đầu: thử lại chỉ che nguyên nhân thật và thêm phút chờ
 *   vô nghĩa. Mọi chữ ký không nằm trong danh sách transient là fatal —
 *   fail-closed, không đoán thêm chữ ký nào.
 *
 * Điều kiện để retry an toàn: đường lỗi nằm ngoài state mà lần thử lại có thể
 * làm hỏng. Wrangler chỉ trả exit 0 khi deployment đã trỏ sang version vừa
 * upload, nên một lần thử lại chỉ ghi đè bằng đúng version của cùng artifact —
 * Worker đang phục vụ không bị bỏ ở trạng thái dở dang.
 *
 * Hết lần thử (hoặc gặp lỗi fatal) thì ném lỗi với nguyên nhân thật — call-site
 * (workflow) đi đường failure: ghi `release/staging-verified/<slug>` = failure
 * rồi exit khác 0, không đụng tag hay release nào.
 */

import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

import type { ExecResult } from '@ecoma-io/deployment';

/** Trần số lần thử — §7.4: tối đa 3 (1 lần thật + 2 retry). */
export const WRANGLER_DEPLOY_MAX_ATTEMPTS = 3;

/** Backoff giữa các lần thử — §7.4: 15s rồi 30s (độ dài = attempts - 1). */
export const WRANGLER_DEPLOY_BACKOFF_MS: readonly number[] = [15_000, 30_000];

/** Trần thời gian MỘT lần thử — §7.4: 4 phút; vượt là lần thử đó chết bởi timeout. */
export const WRANGLER_ATTEMPT_TIMEOUT_MS = 240_000;

/** Deps inject để spec chạy không cần `wrangler` thật và không ngủ thật. */
export interface WranglerDeployDeps {
  execFn: (
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    options: { timeout: number },
  ) => ExecResult;
  sleepFn: (ms: number) => Promise<void>;
}

const defaultDeps: WranglerDeployDeps = {
  execFn: (command, args, cwd, env, options) => {
    // Bản exec cục bộ với `timeout`: helper `exec` của lib dùng chung không có
    // trần thời gian, còn §7.4 bắt buộc trần 4 phút mỗi lần thử. Không sửa lib
    // cho một consumer — wrapper tự giữ đúng một bản spawnSync có timeout.
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      env,
      timeout: options.timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
      signal: result.signal,
    };
  },
  sleepFn: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/**
 * Phân loại một lần thử thất bại: `'transient'` được phép retry, `'fatal'`
 * abort ngay. Chuỗi đầu vào là TOÀN BỘ text lỗi của lần thử (stderr + lỗi
 * transport) — phân loại trên text tổng nên không bỏ sót lỗi ở nguồn nào.
 */
export function classifyWranglerFailure(text: string): 'transient' | 'fatal' {
  // HTTP status mà Cloudflare API trả kèm trong stderr của wrangler: 5xx và
  // 429 là tạm thời; 4xx còn lại (401/403/404...) là cấu hình/quyền — fatal.
  const statusMatch = /HTTP (\d{3})/u.exec(text);
  if (statusMatch !== null) {
    const status = Number(statusMatch[1]);
    if (status >= 500 || status === 429) return 'transient';
    return 'fatal';
  }
  const TRANSIENT_SIGNATURES = [
    // Thông báo malformed response Cloudflare đã quan sát thật (§7.4).
    'Received a malformed response from the API',
    // Lớp transport undici/socket — timeout do chính wrapper đặt (SIGTERM khi
    // spawnSync `timeout` giết) cũng tính: một lần thử treo là lỗi tạm thời,
    // không phải lỗi cấu hình.
    'fetch failed',
    'SocketError',
    'other side closed',
    'socket hang up',
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EPIPE',
    'killed by signal SIGTERM',
  ] as const;
  for (const signature of TRANSIENT_SIGNATURES) {
    if (text.includes(signature)) return 'transient';
  }
  // Mọi chữ ký khác — kể cả stderr rỗng — là fatal: retry những gì không phân
  // loại được là fail-open.
  return 'fatal';
}

/**
 * Đối số `wrangler deploy` cho env staging — `--env staging` tường minh là
 * ranh giới Worker identity (§6.12), và CẢ HAI cờ `--experimental-provision=false`
 * + `--experimental-auto-create=false` là lớp bảo đảm chống Wrangler tự tạo
 * resource khai thiếu (§5.2: đo được rằng khai `bucket_name`/`queue` không đủ
 * để Wrangler coi binding là fully specified).
 */
export function buildWranglerDeployArgs(configPath: string): string[] {
  return [
    'deploy',
    '--config',
    configPath,
    '--env',
    'staging',
    '--experimental-provision=false',
    '--experimental-auto-create=false',
  ];
}

/** Tham số một lần deploy: config tuyệt đối + env tối thiểu có token. */
export interface DeployStagingWorkerOptions {
  configPath: string;
  env: NodeJS.ProcessEnv;
}

export interface DeployStagingWorkerResult {
  attempts: number;
  stdoutTail: string;
}

/**
 * Chạy `wrangler deploy` với retry §7.4. Ném lỗi sau lần thử cuối hoặc ngay ở
 * lỗi fatal — message giữ nguyên nhân thật của lần thử CHẤM DỤT (không nối
 * lịch sử các lần thử: người đọc cần chữ ký lỗi cuối, không cần log nhân bản).
 */
export async function deployStagingWorker(
  options: DeployStagingWorkerOptions,
  deps: WranglerDeployDeps = defaultDeps,
): Promise<DeployStagingWorkerResult> {
  const args = buildWranglerDeployArgs(options.configPath);
  let lastFailure: ExecResult | undefined;
  for (let attempt = 1; attempt <= WRANGLER_DEPLOY_MAX_ATTEMPTS; attempt += 1) {
    const result = deps.execFn(
      'npx',
      ['wrangler', ...args],
      dirname(options.configPath),
      options.env,
      { timeout: WRANGLER_ATTEMPT_TIMEOUT_MS },
    );
    if (result.status === 0) {
      return { attempts: attempt, stdoutTail: result.stdout.trim().slice(-2000) };
    }
    lastFailure = result;
    const reason = describeAttemptFailure(result);
    if (classifyWranglerFailure(reason) === 'fatal') {
      throw new Error(`wrangler deploy failed (attempt ${attempt}): ${reason}`);
    }
    if (attempt < WRANGLER_DEPLOY_MAX_ATTEMPTS) {
      const backoff = WRANGLER_DEPLOY_BACKOFF_MS[attempt - 1] ?? 0;
      await deps.sleepFn(backoff);
    }
  }
  throw new Error(
    `wrangler deploy failed after ${WRANGLER_DEPLOY_MAX_ATTEMPTS} attempts: ` +
      describeAttemptFailure(lastFailure as ExecResult),
  );
}

/** Nguyên nhân một lần thử thất bại — signal/error/executability trước, stderr sau. */
function describeAttemptFailure(result: ExecResult): string {
  if (result.error !== undefined && result.error !== null) return result.error.message;
  if (result.signal !== undefined && result.signal !== null) {
    return `killed by signal ${result.signal}`;
  }
  if (result.stderr.trim() === '') return 'no output';
  return result.stderr.trim();
}
