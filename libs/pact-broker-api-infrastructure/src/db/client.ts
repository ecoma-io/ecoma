/**
 * PostgreSQL client factory — mỗi request MỘT Pool, lifecycle do caller sở
 * hữu. Không node-local state nào khác: Pool có thể mất bất cứ lúc nào, mọi
 * truy vấn tự chịu retry phía caller.
 *
 * ⚠️ Pool KHÔNG được cache ở module scope trong Worker: socket mà `pg` mở qua
 * `cloudflare:sockets` gắn với request context tạo ra nó — Pool cache xuyên
 * request tái sử dụng socket chết và treo vĩnh viễn, còn các timer nội bộ của
 * pool (idle reap, connect timeout) tạo ở context cũ không bao giờ chạy lại
 * (issue #118, controlled experiment 2026-11-13; Cloudflare cũng cảnh báo
 * trực tiếp: "Do not create database clients or connection pools in the
 * global scope"). Caller chuẩn: tạo pool khi bắt đầu request/batch, `end()`
 * trong `finally` khi invocation kết thúc. Hyperdrive đã pooling phía upstream
 * nên pool-per-request không mất hiệu năng pooling thật.
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
 * để caller phân loại lỗi connection-chết khi log/phản ứng (vd consumer ghi
 * log idle-client error). Với pool-per-request thì không còn "reset cache"
 * nào ở đây: pool chết theo invocation của nó.
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
 * Tạo Pool cho MỘT invocation (một request `fetch` hoặc một batch `queue`).
 * Caller gọi trong lifecycle của invocation mình sở hữu và `end()` trong
 * `finally`; connection string đến từ binding Hyperdrive, đổi theo deploy.
 */
export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    // Max 5 kết nối mỗi pool là đủ cho broker (mọi query đều ngắn); nhiều
    // pool đồng thời (nhiều request chạy song song) vẫn nằm dưới trần origin
    // connection của Hyperdrive (HD9, soft limit).
    max: 5,
    // Hyperdrive khuyến nghị tắt keepalive dài hạn trên Workers.
    keepAlive: false,
    // statement_timeout chặn query treo làm request kẹt. 15s dư cho mọi query
    // broker (đều là index lookup/insert nhỏ).
    statement_timeout: 15_000,
    // PERF-05: không để `pg-pool` chờ connection vô hạn (default 0). Khi pool
    // cạn (5 concurrent) phải fail nhanh ~5s thay vì deadlock vô hạn.
    connectionTimeoutMillis: 5_000,
    // PERF-05: giới hạn 10s thời gian giữ connection idle trong đời pool —
    // một pool sống đúng một invocation, mốc này chỉ rút ngắn thời gian giữ
    // socket rác trong cùng invocation thay vì giữ đến khi `end()`.
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
