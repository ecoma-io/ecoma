/**
 * Bề mặt D1 tối thiểu mà tầng infrastructure dùng.
 *
 * ⚠️ **Vì sao định nghĩa lại thay vì dùng `D1Database` của `@cloudflare/workers-types`.** Ba
 * lý do, và cả ba đều là lý do kiểm thử:
 *
 * 1. `batch()` trả `D1Result[]`, không có generic trên **từng phần tử** — kiểu của
 *    workers-types là `batch<T>(...): Promise<D1Result<T>[]>` với `T` áp cho **mọi** phần tử.
 *    `applyPublisherSuccess` cần kết quả có shape `OutboxRow` ở lệnh đầu và một shape khác ở
 *    lệnh sau; định nghĩa lại `batch<T>` cho phép gọi site tự kiểm **số lượng** kết quả, thay
 *    vì phải `as` ở mọi nơi.
 * 2. Test chạy repository trên D1 thật qua `getPlatformProxy()`; khai báo kiểu ở đây giữ adapter
 *    test và adapter production dùng **cùng một** interface.
 * 3. `D1PreparedStatement` của workers-types không cho `.bind()` trả lại một statement với kiểu
 *    đầy đủ sau `.first()`/`.run()`; ở đây chuỗi đó được giữ đúng kiểu.
 *
 * ⚠️ Interface này **thu hẹp** D1, không mở rộng: không có `exec`, không có `dump`, không có
 * `withSession`. Một method không dùng thì không có ở đây, nên một repository không thể vô tình
 * phụ thuộc vào nó.
 */

/// <reference types="@cloudflare/workers-types" />

/**
 * Metadata của một câu lệnh.
 *
 * ⚠️ `changes` là **trường quan trọng nhất** của cả tầng infrastructure: mọi guarded
 * conditional write quyết định thắng/thua bằng `meta.changes === 1`
 * (`docs/architecture/04-platform-facts.md` DB3). Không có `changes` thì "thắng/thua trong
 * statement" biến thành read-then-write, đúng thứ mà §5.6 và §6.1 cấm.
 */
export interface D1ResultMeta {
  /** Số hàng **thực sự bị đổi**. `0` nghĩa là predicate của `UPDATE` không khớp hàng nào. */
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

/**
 * Statement — chưa bind cũng chạy được, giống hệt D1 thật (một `SELECT` không có tham số không
 * cần `bind()`).
 *
 * ⚠️ **`run()` và `all()` trả CÙNG một kiểu, và đó là điểm cố ý giữ lại từ D1**: `run()` trên một
 * `UPDATE … RETURNING` trả `results` chứa các hàng vừa được ghi, y hệt `all()`. Vì vậy một
 * guarded conditional write có thể quyết định thắng/thua bằng `results` rỗng **hoặc** bằng
 * `meta.changes === 0`, và hai cách cho cùng một câu trả lời. `d1-delivery-repositories.ts`
 * dùng `results` vì nó cần **hàng đã ghi** (generation mới, status mới), không chỉ một con số.
 */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  /** `UPDATE`/`DELETE`/`INSERT`: `meta.changes` quyết định thắng/thua. */
  run<T = Record<string, unknown>>(): Promise<D1ResultSet<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultSet<T>>;
}

/**
 * Bề mặt D1 của `push-notification`.
 *
 * ⚠️ `batch()` là **transaction duy nhất** của D1 (`docs/architecture/04-platform-facts.md` DB2):
 * không có `BEGIN`/`COMMIT`/`ROLLBACK` tường minh. Mọi ghi "nhiều hàng phải cùng đúng hoặc
 * cùng sai" đều phải đi qua đây — và nó **không** cho phép một network call xen giữa các lệnh,
 * đó là lý do publisher phải `send()` **ngoài** batch (§6.2).
 */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;

  /**
   * Chạy một loạt câu lệnh **nguyên tử**.
   *
   * ⚠️ `T` là kiểu của **một phần tử** của `results` — cùng ngữ nghĩa với `run`/`all`. Đặt nó
   * vào đây khiến sai hình dạng là lỗi compile tại call site, thay vì một giá trị `undefined` lúc
   * runtime.
   */
  batch<T = Record<string, unknown>>(
    statements: readonly D1PreparedStatement[],
  ): Promise<D1ResultSet<T>[]>;
}
