/**
 * PostgreSQL client factory — mỗi isolate một Pool từ Hyperdrive connection
 * string. Không node-local state nào khác: Pool sống theo isolate, có thể mất
 * bất cứ lúc nào, mọi truy vấn tự chịu retry phía caller.
 *
 * ⚠️ Migration KHÔNG đi qua client này (Hyperdrive không hỗ trợ advisory
 * lock); migration chạy từ CI runner bằng `db/apply.mts` với chuỗi kết nối
 * trực tiếp.
 */
import { Pool } from 'pg';

/**
 * Mã lỗi của `pg` mang tính "connection đã bị chấm dứt" — pool phải được
 * reset (lazy re-create) khi gặp các lỗi này, thay vì giữ một pool hỏng.
 *
 * Danh sách bám SQLSTATE connection/operation-failure class + errno hệ thống
 * (đo trên PostgreSQL 17 / Node). Không exhaustively — chỉ đủ để phân biệt
 * "connection chết" với "statement fail bình thường".
 */
const CONNECTION_TERMINATED_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08003',
  '08006',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
]);

/**
 * Kiểm tra một lỗi có phải lỗi "connection đã bị chấm dứt" hay không — dùng
 * để quyết định reset `cachedPool` (lazy re-create) thay vì giữ pool hỏng.
 */
export function isConnectionTerminatedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_TERMINATED_CODES.has(code)) {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  if (
    typeof message === 'string' &&
    /terminating connection|connection terminated|connection reset/iu.test(message)
  ) {
    return true;
  }
  return false;
}

/**
 * Tạo Pool cho một isolate. Worker mỗi lần cold start gọi một lần; binding
 * Hyperdrive đổi connection string theo deploy.
 */
export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    // Workers không có timer dài hạn: socket idle bị đóng là chuyện bình
    // thường, pg tự mở lại khi query kế tiếp. Max 5 kết nối/isolate là đủ cho
    // broker (mọi query đều ngắn).
    max: 5,
    // Hyperdrive khuyến nghị tắt keepalive dài hạn trên Workers.
    keepAlive: false,
    // statement_timeout chặn query treo làm isolate kẹt. 15s dư cho mọi query
    // broker (đều là index lookup/insert nhỏ).
    statement_timeout: 15_000,
    // PERF-05: không để `pg-pool` chờ connection vô hạn (default 0). Khi pool
    // cạn (5 concurrent) phải fail nhanh ~5s thay vì deadlock vô hạn.
    connectionTimeoutMillis: 5_000,
    // PERF-05: đóng connection idle sau 10s để pool tự phục hồi khi Hyperdrive
    // đóng idle connection (HD10) — tránh giữ connection đã chết.
    idleTimeoutMillis: 10_000,
  });

  // PERF-06: listener `error` bắt buộc — idle client chết phát `error` trên
  // EventEmitter; không listener là crash isolate. Log mã sự kiện cố định,
  // không log prompt/response body (và không log connection string).
  pool.on('error', (error: Error) => {
    // oxlint-disable-next-line no-console
    console.error(
      JSON.stringify({
        code: 'pool_error',
        errorName: error?.name,
        errorMessage: error?.message,
      }),
    );
  });

  return pool;
}
