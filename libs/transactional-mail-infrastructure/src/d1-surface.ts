/**
 * Subset của `D1Database` mà persistence của C1 thật sự dùng — **chỉ** `prepare`, `bind`,
 * `all` và `batch`.
 *
 * Vì sao không khai cả `D1Database`:
 *
 * - Danh sách này là **census** những capability mà implementation gọi. Bất kỳ method nào của
 *   D1 mà code không gọi đều nằm ngoài subset, nên không có đường nào vô tình dùng `exec`,
 *   `withSession` hay `dump` mà không nhìn thấy.
 * - Implementation nằm sau một interface nhỏ nên chạy được trên harness thật (miniflare qua
 *   `getPlatformProxy`) mà không cần adapter trung gian.
 *
 * Đây là interface **infrastructure**, không phải application port: `@ecoma-io/
 * transactional-mail-application` không import file này và không biết chữ ký D1.
 *
 * Suite integration `mail-d1.spec` (app transactional-mail) khẳng định compile-time rằng
 * `D1Database` của `@cloudflare/workers-types`
 * **extends** được từng type ở đây — tức là production code truyền `env.mail` vào factory sẽ
 * typecheck, chứ không phải subset là một ước đoán.
 */

/**
 * Kết quả một statement. Chỉ khai `results` — đúng field duy nhất mà implementation đọc.
 *
 * Cố ý **không** khai `meta.changes`: `docs/architecture/04-platform-facts.md` DB3 ghi `meta.changes`
 * là số hàng thật sự đổi, nhưng bản local `wrangler d1 execute --file` không điền field đó, còn
 * `getPlatformProxy` thì có. Một implementation dựa vào `meta.changes` sẽ hoạt động trên một
 * harness và sai im lặng trên harness kia. Mọi quyết định "có ghi hay không" ở đây đi qua
 * `RETURNING`: row trả về = đã ghi, không row = đã bị guard chặn. Cả hai harness đều đúng.
 */
export interface D1SubsetResult<T = unknown> {
  readonly results: T[];
}

/** PreparedStatement của subset. `bind` trả statement mới, không sửa statement gốc (giống D1). */
export interface D1SubsetPreparedStatement {
  bind(...values: unknown[]): D1SubsetPreparedStatement;

  /**
   * Chạy và trả **tất cả** hàng trả về.
   *
   * Với `INSERT/UPDATE/DELETE … RETURNING` thì đó là số hàng **đã ghi**; với statement không
   * có `RETURNING` thì là mảng rỗng. Không dùng `first()`/`run()` để cả hai loại statement đi
   * qua đúng một đường — nếu có nhánh nào đó "chỉ chạy, không đọc kết quả" thì guard của nhánh
   * đó sẽ không được ai kiểm.
   */
  all<T = unknown>(): Promise<D1SubsetResult<T>>;
}

/** `D1Database` ở đúng mức mà implementation cần. Xem JSDoc của file. */
export interface D1SubsetDatabase {
  prepare(query: string): D1SubsetPreparedStatement;

  /**
   * Một transaction: hoặc toàn bộ statement thành công, hoặc không có gì được ghi
   * (`docs/architecture/04-platform-facts.md` DB2).
   *
   * Dùng **chỉ** ở hai chỗ mà hai bảng phải đổi cùng nhau: tạo message + outbox, và đóng
   * outbox + đặt message `queued`. Mọi conditional update còn lại là **một** statement, nên
   * không cần transaction và không có gì để mất nếu statement trả 0 hàng.
   *
   * Không network call nào được nằm trong batch — `QUEUE.send()` luôn chạy **sau** khi claim
   * commit (`01-architecture.md` §6.2).
   */
  batch<T = unknown>(statements: D1SubsetPreparedStatement[]): Promise<D1SubsetResult<T>[]>;
}
