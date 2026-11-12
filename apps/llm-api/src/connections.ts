/**
 * Kết nối PostgreSQL của runtime TypeScript `llm-api` — MỘT `pg.Client` MỖI
 * PHÉP GỌI SQL (connect → query → end), KHÔNG pool, KHÔNG state module-level.
 *
 * ⚠️ Lệch có chủ đích so với pattern cached-Pool per isolate của
 * `pact-broker-api` (PERF-06): pg Pool tái dùng client idle qua workerd bị
 * vỡ ở tầng platform — đo trực tiếp trên một worker thí nghiệm tối giản
 * (chỉ `new Pool` + `pool.query('SELECT 1')`, không code app, không deadline
 * race): request đầu OK ~11ms, request kế tiếp bị workerd giết vì "code had
 * hung and would never generate a response", mô hình lặp lại xen kẽ rồi pool
 * kẹt hẳn ở connect-timeout 5s từ request thứ bảy. Với `pg.Client` mới mỗi
 * lần gọi: 20/20 lần liên tiếp OK, 5-16ms/lần. Runtime Rust đang bị thay thế
 * CŨNG mở một socket mới cho MỖI câu SQL rồi đóng ngay sau khi query xong
 * (`binding_simple_query`, `src/readiness.rs`) — lifecycle per-operation là
 * bản port trung thực của artifact, không phải workaround tạm.
 *
 * Hệ quả chấp nhận: mỗi câu SQL trả một lần TCP connect + auth (~vài chục ms
 * qua Hyperdrive thật); bù lại KHÔNG có kết nối idle phải giữ/reset, lỗi
 * connection chết theo từng phép gọi (fail-closed đúng hợp đồng 503), và
 * restart database không để lại pool hỏng phải phục hồi.
 *
 * ⚠️ Migration KHÔNG đi qua đường này (Hyperdrive không hỗ trợ advisory
 * lock); migration chạy từ CI runner bằng `db/apply.mts` với credential
 * migrator.
 *
 * Bất biến platform: KHÔNG BAO GIỜ log connection string hay credential.
 */

/*
 * BA giá trị timeout RIÊNG NHAU, mỗi giá trị một nghĩa — không gộp một knob:
 *
 * 1. `CONNECTION_TIMEOUT_MS` — timeout mở connection (TCP connect + auth).
 *    Chặn request treo chờ database không trả lời.
 * 2. `STATEMENT_TIMEOUT_MS` — `statement_timeout` phía server: trần thời gian
 *    cho MỌI statement, kể cả catalogue `SELECT` (Rust không có trần này —
 *    driver thêm lớp an toàn, không đổi hợp đồng 200/503).
 * 3. `READINESS_DEADLINE_MS` (định nghĩa ở `readiness.ts`) — deadline
 *    per-operation của probe readiness, per-binding: giữ đúng semantics Rust
 *    (3s, `src/readiness.rs`), ngắn hơn hai giá trị trên một cách chủ đích
 *    nên `/ready` không bao giờ treo chờ database chết.
 */

/** Timeout mở connection (TCP + auth) của một `pg.Client`. */
export const CONNECTION_TIMEOUT_MS = 5_000;

/** `statement_timeout` phía server cho statement chạy qua client này. */
export const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Chạy `run` trên một client pg mới cho đúng một phép gọi SQL. Client bị
 * đóng ở mọi đường ra (`finally`) — không có client nào sống sót qua request,
 * nên không có kết nối idle phải dọn và số kết nối đồng thời tối đa chỉ bằng
 * số query đang bay (ba probe song song của `/ready`, hai query tuần tự của
 * catalogue).
 */
export async function withClient<T>(
  connectionString: string,
  run: (client: import('pg').Client) => Promise<T>,
): Promise<T> {
  const { Client } = await import('pg');
  const client = new Client({
    connectionString,
    // Hyperdrive khuyến nghị tắt keepalive dài hạn trên Workers.
    keepAlive: false,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  // Bắt buộc có listener `error` (cùng lý do `createPool` của Pact Broker):
  // connection chết giữa chừng (VD database restart gửi FATAL 57P01) phát
  // sự kiện `error` trên EventEmitter — không listener là uncaught exception
  // trong isolate. Lỗi của PHÉP GỌI đã đi qua rejection của `run` (fail-closed
  // đúng hợp đồng); listener chỉ giữ isolate không chết vì sự kiện lẻ.
  client.on('error', () => undefined);
  // `connect()` nằm NGOÀI try/`end()`: khi connect timeout/lỗi, pg tự hủy
  // stream của nó (timer connect-timeout trong client.js của pg) — không cần
  // `end()` trên đường này, không leak connection.
  await client.connect();
  try {
    return await run(client);
  } finally {
    // Lỗi khi đóng không được che lỗi thật của `run`; client hỏng sẽ tự chết
    // theo request context, lần gọi kế mở client mới.
    await client.end().catch(() => undefined);
  }
}
