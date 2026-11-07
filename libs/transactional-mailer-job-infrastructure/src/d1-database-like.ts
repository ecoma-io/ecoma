/**
 * Interface cấu trúc tối thiểu cho D1 binding, đúng phần repository dùng.
 *
 * ## Vì sao tự khai báo thay vì import `@cloudflare/workers-types`
 *
 * D1 là binding của Cloudflare Workers. `@ecoma-io/transactional-mailer-job-infrastructure`
 * là `runtime:edge`; khai báo ở đây đúng subset member mà repository cần (`prepare`,
 * `bind`, `run`, `first`, `all`) — bề mặt type hẹp đúng mức dùng, giữ lib chạy được trên
 * edge mà không thêm dependency runtime nào (CR-001: worker không được thêm runtime
 * dependency).
 *
 * Interface này **cấu trúc** (structural), nên binding D1 thật của Workers khớp với nó
 * mà không cần adapter; test harness (D1 thật qua `wrangler getPlatformProxy`) cũng khớp.
 *
 * Nguồn canonical cho hành vi: `docs/applications/transactional-mailer-job/01-architecture.md`
 * §9.2.1 (conditional UPDATE là nguồn duy nhất), `docs/architecture/04-platform-facts.md` DB3
 * (`meta.changes` = số hàng **thực sự** thay đổi).
 */

/** Kết quả một câu lệnh ghi. `meta.changes` là số hàng thực sự bị thay đổi. */
export type D1ResultMeta = {
  /** Số hàng **thực sự** thay đổi bởi câu lệnh (không phải số hàng khớp WHERE). */
  readonly changes?: number;
  readonly last_row_id?: number;
  readonly rows_written?: number;
};

/** Kết quả trả về đầy đủ của `run()`/`all()`: `results` + metadata. */
export type D1RunResult<Row> = {
  readonly results?: readonly Row[];
  readonly success?: boolean;
  readonly meta?: D1ResultMeta;
};

/** Statement đã bind tham số. */
export type D1BoundStatement<Row> = {
  /** Chạy statement, trả về `results` + `meta.changes`. */
  run(): Promise<D1RunResult<Row>>;
  /** Chạy statement và trả về các dòng kết quả. */
  all(): Promise<D1RunResult<Row>>;
  /** Chạy statement và trả về dòng đầu tiên (hoặc `null`). */
  first(columnName?: string): Promise<Row | null>;
};

/** Statement chưa bind — cần gọi `.bind(...)` trước khi chạy. */
export type D1PreparedStatement<Row> = {
  /**
   * Gắn tham số vào statement.
   *
   * Repository **luôn** dùng `?` + `bind(...)` cho mọi giá trị động — không bao giờ
   * nội suy chuỗi vào SQL text (ràng buộc an toàn §6).
   */
  bind(...values: readonly unknown[]): D1BoundStatement<Row>;
  /** Chạy statement không tham số (chỉ dùng cho SQL không có placeholder động nào). */
  run(): Promise<D1RunResult<Row>>;
  all(): Promise<D1RunResult<Row>>;
  first(columnName?: string): Promise<Row | null>;
};

/** Database binding tối thiểu repository cần. */
export type D1DatabaseLike = {
  prepare<Row = Record<string, unknown>>(sql: string): D1PreparedStatement<Row>;
  /**
   * Chạy **một batch** nhiều statement — D1 thực thi batch trong một transaction ngầm,
   * fail statement nào rollback cả batch.
   *
   * Khai ở đúng subset mà `D1LifecycleEventStore` dùng (persist event + correlate là
   * hai statement phải đi cùng); binding D1 thật khớp cấu trúc, không cần adapter.
   */
  batch<Row = Record<string, unknown>>(
    statements: readonly D1BoundStatement<Row>[],
  ): Promise<readonly D1RunResult<Row>[]>;
};

/**
 * Đọc `meta.changes` từ kết quả `run()`.
 *
 * `meta.changes` là số hàng **thực sự** thay đổi — nguồn chuẩn để biết một
 * conditional UPDATE có áp dụng hay không (DB3). Trả `null` nếu platform không
 * cung cấp `changes`, để repository **fail closed** thay vì coi thiếu dữ liệu
 * là "thành công".
 */
export function readChanges(result: D1RunResult<unknown>): number | null {
  const changes = result.meta?.changes;
  return typeof changes === 'number' ? changes : null;
}
