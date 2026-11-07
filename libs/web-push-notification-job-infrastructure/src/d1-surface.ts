/**
 * Bề mặt D1 tối thiểu mà tầng infrastructure của job dùng.
 *
 * ⚠️ **Vì sao định nghĩa lại thay vì dùng `D1Database` của `@cloudflare/workers-types`.** Ba
 * lý do, giống hệt lý do của `libs/push-notification-infrastructure/src/d1-surface.ts`:
 *
 * 1. `run()`/`all()` cùng trả một kiểu ở đây, nên một guarded conditional write có thể quyết
 *    định thắng/thua bằng `results` rỗng **hoặc** `meta.changes === 0` — hai câu trả lời cho
 *    cùng một câu hỏi. Repository ở đây dùng `results` khi cần **hàng đã ghi** và `changes` khi
 *    chỉ cần đếm.
 * 2. Test chạy repository trên D1 thật qua `getPlatformProxy()`, nên adapter test và adapter
 *    production dùng **cùng một** interface.
 * 3. Interface **thu hẹp** D1: không `exec`, không `dump`, không `withSession`. Một method không
 *    dùng thì không có ở đây, nên repository không vô tình phụ thuộc nó.
 *
 * ⚠️ **Không import** `D1DatabaseLike` của `push-notification-infrastructure`: đó là tầng dưới
 * của **service khác** — một dependency vào infrastructure của control plane từ delivery plane
 * là đường phụ thuộc sai (và Nx graph sẽ ghi nhận nó). Bản sao nhỏ ở đây là chủ đích.
 */

/// <reference types="@cloudflare/workers-types" />

/** Metadata của một câu lệnh — `changes` là số hàng **thực sự** bị đổi. */
export interface D1ResultMeta {
  readonly changes: number;
  readonly last_row_id?: number;
  readonly duration?: number;
  readonly rows_read?: number;
  readonly rows_written?: number;
  readonly changed_db?: boolean;
}

/** Một tập hàng kết quả của `SELECT`, `all()` hoặc `run()` trên `… RETURNING`. */
export interface D1ResultSet<T> {
  readonly results: T[];
  readonly success: boolean;
  readonly meta: D1ResultMeta;
}

/** Statement — chưa bind cũng chạy được, giống D1 thật. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = Record<string, unknown>>(): Promise<D1ResultSet<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultSet<T>>;
}

/**
 * Bề mặt D1 của `push-job`.
 *
 * ⚠️ **Không** có `batch()`. Job state ghi ở đây là **từng** write độc lập theo phím idempotency
 * riêng, và đường ghi quan trọng nhất (processed marker) xảy ra **sau** một network call tới
 * control plane — tức không thể nằm trong cùng transaction. Có `batch()` trong interface mà
 * không dùng là một API thừa dễ bị dùng nhầm để ghi nhiều bản ghi trong một transaction rồi
 * phá vỡ idempotency.
 */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
}

/** Số hàng **thực sự** bị đổi — nguồn duy nhất của thắng/thua trong một statement. */
export function readChanges<T>(result: D1ResultSet<T>): number {
  return result.meta.changes;
}
