/**
 * Truy vấn `db-account` qua Hyperdrive.
 *
 * ## Vì sao driver là `pg` chứ không phải Postgres.js
 *
 * HD15: với Postgres.js, transaction mode pooling **không hỗ trợ đáng tin cậy**
 * `prepare: false` — có thể khiến query treo hoặc fail gián đoạn. Hyperdrive
 * dùng transaction mode pooling (HD5), nên Postgres.js nằm đúng vào trường hợp đó.
 * `pg` không có tầng prepared statement mặc định nên đường đó không tồn tại.
 *
 * ## Hyperdrive transaction mode pooling — invariant 13
 *
 * HD5: `SET` chỉ sống trong transaction/query và bị `RESET` khi connection trả về
 * pool. Vì vậy module này **không** `SET` ở cấp connection và **không** giữ bất kỳ
 * session state nào ngoài một query. Cũng không dùng advisory lock (`pg_advisory_lock`)
 * và không dùng SQL-level `PREPARE`/`EXECUTE` — HD6 nói Hyperdrive không hỗ trợ,
 * và invariant 13 cấm chúng trên mọi client Hyperdrive.
 *
 * Mỗi lần gọi {@link selectAccountStatus} lấy connection từ pool của Hyperdrive, chạy
 * đúng một câu lệnh rồi trả về — không có `CONNECT`/`RELEASE` thủ công để làm rò
 * connection.
 */

/**
 * Kiểu binding Hyperdrive — chỉ phần `pg` cần cho Workers.
 *
 * ⚠️ Không import `node:*` ở đây: `.oxlintrc.json` cấm Node builtin trong project
 * `runtime:edge`. `pg` tự dùng shim Node của `nodejs_compat` mà `wrangler.jsonc` bật,
 * còn **code của app** không được import trực tiếp.
 */
import type { Hyperdrive } from '@cloudflare/workers-types';
import { assertNonceExpirySeconds } from '@ecoma-io/internal-auth-contracts';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { writeLog } from './logger';

/** Ràng buộc của connection string Hyperdrive. */
interface ConnectionOptions {
  /** Connection string của Hyperdrive binding. */
  readonly connectionString: string;
}

/**
 * Cấu hình `pg` theo Hyperdrive.
 *
 * ⚠️ `ssl` **không** được đặt: Hyperdrive đã kết nối tới origin bằng TLS bắt buộc
 * (HD2) và Hyperdrive tự quản lý phần đó. Đặt `ssl` ở đây có thể phá đúng phần đó.
 *
 * ⚠️ Chỉ dùng {@link createPool} ở production — đó là đường duy nhất dựng pool.
 * Hàm này export riêng chỉ để unit test kiểm các con số; gọi trực tiếp ở nơi khác
 * là bỏ qua {@link attachPoolErrorHandler} và biến idle-client error thành crash
 * isolate đúng lúc origin flapping.
 */
export function buildPoolOptions(options: ConnectionOptions): {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
} {
  return {
    connectionString: options.connectionString,
    // Pool nhỏ: HD9 giới hạn ~20 origin connection mỗi config (Free) / ~100 (Paid),
    // và đó là **soft limit**. Một Worker có thể có nhiều isolate cùng giữ pool, nên
    // `max` phải nhỏ để tổng nằm dưới trần — không phải để tối ưu throughput.
    max: 4,
    // HD10: idle timeout của Hyperdrive là 10 phút; đặt ngang mốc đó để `pg` tự đóng
    // connection đã chết thay vì giữ connection mà Hyperdrive đã hủy.
    idleTimeoutMillis: 600_000,
    // HD10: initial connect timeout là 15s. Đặt ngắn hơn để `/ready` fail nhanh
    // thay vì treo — readiness fail-closed phải **trả lời** là không sẵn sàng.
    connectionTimeoutMillis: 15_000,
  };
}

/**
 * Chạy một callback với connection lấy từ pool, và luôn trả connection về pool.
 *
 * `pool.connect()` **phải** có `release()` trong `finally` — bỏ nó là rò connection
 * cho tới khi pool cạn, và pool cạn là toàn bộ endpoint DB chết.
 */
async function withClient<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    // `release()` không ném, nên không cần bọc thêm ở đây.
    client.release();
  }
}

/**
 * Đọc `status` của một `sub` từ `db-account`.
 *
 * ⚠️ FR-011e: đọc **trực tiếp**, không projection cache, không stale read — mỗi lần
 * gọi đều là một lần đọc authority. Vì vậy hàm này không có tham số nào để tắt cache
 * và không có đường nào để gọi nó "không tươi".
 *
 * ⚠️ Query chỉ chọn **một** cột `status`. Chọn `SELECT *` ở đây là cách nhanh nhất
 * để biến FR-011b thành lỗi: một cột `email` bị thêm vào `users` sẽ đi vào response
 * nếu ai đó đổi thành `*`. Danh sách cột là allowlist, không phải `*`.
 *
 * @returns `null` khi không có row nào khớp `sub` — người gọi ánh xạ thành
 *   `not_found`, một **trạng thái hợp lệ** chứ không phải lỗi (FR-011b).
 */
export async function selectAccountStatus(pool: Pool, sub: string): Promise<string | null> {
  const result = await withClient(pool, (client) =>
    client.query<{ status: string }>(
      // Tham số hoá: `sub` đến từ query string của caller, nên **không** được nối vào
      // SQL bằng string interpolation.
      //
      // ⚠️ `account.users` **phải** được chỉ định đầy đủ. `search_path` mặc định là
      // `"$user", public`, và `0002_roles_and_grants.sql` rút `USAGE` khỏi `public`
      // khỏi `PUBLIC`; bảng nằm ở schema `account`, không nằm trong `search_path`
      // của role runtime. Đo trên PostgreSQL 17 với credential `ecoma_account_runtime`
      // thật: `SELECT status FROM users` cho `relation "users" does not exist`, còn
      // `SELECT status FROM account.users` thì chạy. Test integration chỉ assert
      // câu có schema, nên chỉ unit test với mock mới bắt được — và nó đã không bắt.
      'SELECT status FROM account.users WHERE sub = $1',
      [sub],
    ),
  );

  const row: QueryResultRow | undefined = result.rows[0];
  return row === undefined ? null : String(row.status);
}

/**
 * Đọc `displayName` theo batch cho một danh sách `sub` từ `account.user_profiles`.
 *
 * Contract `GET /internal/account/profiles` (issue #325): `displayName` là dữ liệu
 * hồ sơ cho **tên hiển thị** — mục đích trình bày trong backoffice, không phải dữ
 * liệu định danh. Vì vậy query này chỉ chọn **hai** cột `user_sub` + `display_name`
 * (allowlist, không `SELECT *`), cùng lý do với {@link selectAccountStatus}: một cột
 * `email`/`avatar_url` thêm vào sau sẽ không tự đi vào response.
 *
 * ## Ý nghĩa của NULL
 *
 * `NULL` = sub đó **chưa đặt tên** (giữ nguyên nghĩa cột trong `0008_data_domain_v1.sql`,
 * CHECK `length > 0` nên không tồn tại chuỗi rỗng). `sub` không có row profile cũng
 * dùng chung nghĩa đó — caller không phân biệt "chưa có row" với "có row nhưng
 * display_name NULL", và **không** trả `sub` nào ngoài danh sách được hỏi.
 *
 * ⚠️ Truy vấn bằng `= ANY($1)` với mảng tham số hoá — danh sách `sub` đến từ query
 * string của caller, không được nối vào SQL.
 *
 * @returns Map `sub -> displayName` cho **tối đa** các sub được hỏi; sub không có
 *   dữ liệu vắng mặt khỏi map.
 */
export async function selectDisplayNames(
  pool: Pool,
  subs: readonly string[],
): Promise<Map<string, string | null>> {
  const result = await withClient(pool, (client) =>
    client.query<{ user_sub: string; display_name: string | null }>(
      'SELECT user_sub, display_name FROM account.user_profiles WHERE user_sub = ANY($1)',
      [[...subs]],
    ),
  );

  const names = new Map<string, string | null>();
  for (const row of result.rows) {
    names.set(row.user_sub, row.display_name);
  }
  return names;
}

/**
 * Ghi một nonce đã xác thực vào kho bền; trả `true` khi nonce **đã** tồn tại.
 *
 * ⚠️ Đây là hình thức `claimNonce` mà `verifyRequest` cần: **kiểm tra và ghi trong
 * một câu**, không phải `SELECT` rồi `INSERT` ở câu khác. Đọc-rồi-ghi mất tính
 * nguyên tử dưới tải đồng thời, và hai request mang cùng nonce sẽ cùng thắng —
 * tức là replay guard không chống được replay. `ON CONFLICT DO NOTHING` rồi đếm
 * `rowCount` là một câu lệnh nên PostgreSQL quyết định thắng thua bằng ràng buộc
 * UNIQUE, bất kể bao nhiêu Worker cùng tranh.
 *
 * ⚠️ **Tham số là `Pool`, không phải `PoolClient`.** Bản ghi nonce **phải** sống
 * ngoài transaction nghiệp vụ: tính nguyên tử đến từ `ON CONFLICT`, nhưng hàng chỉ
 * tồn tại sau `COMMIT`. Một caller truyền `PoolClient` của một transaction rồi để
 * transaction đó `ROLLBACK` (vì nghiệp vụ phía sau thất bại) sẽ **xoá** bản ghi
 * nonce trong khi `verifyRequest` đã trả `ok` và request đã được xử lý — phát lại
 * đúng envelope đó trong cửa sổ skew lại chiếm được nonce, và replay guard bị vô
 * hiệu trong im lặng. Kiểu ở đây là ràng buộc thật chứ không phải lời khuyên:
 * `PoolClient` **không** gán được cho `Pool`, còn `Pool` thì có.
 *
 * `expires_at` do **caller tính** và truyền vào — cột cố ý **không** có `DEFAULT`
 * trong `0003_internal_nonces.sql`. Nếu database tự điền thì nonce sống mãi và
 * guard vô hiệu hoá. Caller (hiện tại là `makeNonceGuard` của middleware
 * internal-auth) phải neo mốc hết hạn theo **timestamp của envelope**:
 * `timestamp + skew + buffer` (`INTERNAL_NONCE_BUFFER_SECONDS`). `verifyRequest`
 * chấp nhận khi `|now − timestamp| ≤ skew`, nên cửa sổ replay của envelope kết
 * thúc đúng tại `timestamp + skew` — TTL đó sống qua cửa sổ đúng bằng buffer
 * (prune chạy theo lô), và neo theo envelope thì không phụ thuộc việc hai đồng hồ
 * caller/verifier có lệch nhau hay không.
 *
 * ⚠️ **Kiểm TTL ở đúng tầng ghi, không tin người gọi.** `expires_at` là dữ liệu
 * *caller* quyết định, và một giá trị sai ở đây không đỏ ở đâu cả:
 * `to_timestamp(NaN)` ném từ driver (khó đọc), còn `to_timestamp(<epoch mili giây>)`
 * **lặng lẽ** tạo một nonce sống tới năm 57000 — tức một hàng không bao giờ được
 * prune, một nonce "bền" theo nghĩa hỏng. Chiều còn lại nguy hiểm hơn: TTL ngắn hơn
 * `skew` khiến prune xoá một nonce còn hiệu lực, mở lại cửa sổ replay mà kho này
 * tồn tại để đóng. Dùng chung {@link assertNonceExpirySeconds} của lib canonical
 * nghĩa là hai service áp **đúng một luật** thay vì hai bản chép tay trôi khỏi nhau
 * — bất biến của cột là bất biến của hàm ghi, không phải của `runtimeConfig` hay của
 * call site, nên một call site mới (test, script vận hành, đường khác) không thừa
 * hưởng một kho nonce không còn chống replay.
 *
 * Lỗi ném ra **không** kèm giá trị: xem JSDoc của `assertNonceExpirySeconds`.
 *
 * @param expiryEpochSeconds Mốc hết hạn caller chọn, theo quy tắc phía trên —
 *   hằng số giao thức nằm ở caller, không ở đây.
 * @throws {RangeError} Khi `expiryEpochSeconds` không phải epoch giây hợp lệ. Ném ở
 *   đây là **fail closed**: `withClient` không chạy, không có hàng nào được ghi, và
 *   middleware dịch nó thành `503` chứ không thành một lần ghi sai.
 */
export async function recordNonce(
  pool: Pool,
  nonce: string,
  expiryEpochSeconds: number,
): Promise<boolean> {
  assertNonceExpirySeconds(expiryEpochSeconds);
  const result = await withClient(pool, (client) =>
    client.query(
      `INSERT INTO account.internal_nonces (nonce, expires_at)
       VALUES ($1, to_timestamp($2))
       ON CONFLICT (nonce) DO NOTHING`,
      [nonce, expiryEpochSeconds],
    ),
  );
  // `rowCount === 0` nghĩa là đụng conflict ⇒ nonce đã có ⇒ đã thấy trước đó.
  return result.rowCount === 0;
}

/**
 * Lấy connection string của Hyperdrive binding.
 *
 * Hyperdrive binding expose `connectionString` — chuỗi mà driver nhận thẳng — cùng
 * `host`/`port` cho driver tự ghép. Chọn `connectionString` vì nó không yêu cầu ghép
 * chuỗi ở app, và vì ghép tay là chỗ dễ rò `host`/`port` ra code (invariant 4 chỉ cho
 * phép **tên** binding trong application code).
 */
export function connectionStringFrom(hyperdrive: Hyperdrive): string {
  return hyperdrive.connectionString;
}

/**
 * Gắn listener `error` cho pool — **bắt buộc** với mọi pool sống qua `idle`.
 *
 * `pg-pool` phát sự kiện `error` khi một idle client chết; **không** có listener
 * nào cho sự kiện `error` của EventEmitter là crash process (ở Workers: kill
 * isolate). Đây không phải lý thuyết: HD10 nói Hyperdrive đóng idle connection
 * sau 10 phút, đúng mốc mà `idleTimeoutMillis` của {@link buildPoolOptions}
 * đặt — cứ mỗi lần idle connection chết đúng mốc là một lần `error` phát trên
 * idle client.
 *
 * Handler **log redacted rồi nuốt lỗi**, không re-throw: `error` trên idle
 * client không thuộc về request nào — không có caller để trả lỗi, và ném vào
 * giữa event handler của EventEmitter là crash. Request kế tiếp lấy connection
 * mới từ pool (đúng cơ chế tự phục hồi của `pg`); contract internal thiếu
 * database thì nhận 401/503 từ lớp của chính nó.
 *
 * ⚠️ Chỉ ghi **mã sự kiện cố định**, không ghi message của driver: message của
 * `pg` có thể chứa connection string — đúng thứ SR-001 và invariant 9 cấm vào
 * log. Phân loại sự cố đủ bằng tên event.
 */
export function attachPoolErrorHandler(pool: Pool): void {
  pool.on('error', () => {
    writeLog({ event: 'db_pool.idle_client_error', error_code: 'idle_client_error' });
  });
}

/**
 * Dựng một pool cho một Hyperdrive — **đường duy nhất** production dựng pool.
 *
 * Mọi nơi cần pool (`withRequestPool`, probe readiness của `/ready`) đi qua đây
 * để {@link attachPoolErrorHandler} **luôn** được gắn: `pg-pool` phát `error` cho
 * idle client bị Hyperdrive đóng (HD10 — đúng mốc `idleTimeoutMillis`), và một
 * pool dựng tay `new Pool(...)` không có listener là crash isolate. Gom về một
 * factory là cách làm điều đó không thể quên ở call site mới.
 *
 * ⚠️ Không giữ pool ở module scope: state sống lâu hơn một request và phụ thuộc
 * vòng đời isolate — loại state mà non-negotiable architecture cấm.
 */
export function createPool(hyperdrive: Hyperdrive): Pool {
  const pool = new Pool(buildPoolOptions({ connectionString: connectionStringFrom(hyperdrive) }));
  attachPoolErrorHandler(pool);
  return pool;
}

/**
 * Dựng pool cho một request, và luôn `end()` sau khi dùng.
 *
 * ⚠️ **Không** giữ pool ở module scope hay trong `event.context`: Hyperdrive có
 * `max: 4` nên một pool sống lâu sẽ giữ connection vô ích giữa các request không
 * chạm DB, và `runtime:edge` cấm node-local state. `callback` nhận pool và tự
 * `end()` nó trong `finally` — hàm này chỉ gom phần dựng cho một chỗ.
 *
 * Callback trả `null` khi callback ném lỗi là điều **không xảy ra**: lỗi luôn
 * bay ra khỏi hàm sau khi pool đã `end()`, nên không có đường nào trả `null` mà
 * không có `throw` đi kèm. Kiểu trả về `Promise<never>` là để điều đó nói thẳng.
 */
export async function withRequestPool<T>(
  hyperdrive: Hyperdrive,
  callback: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = createPool(hyperdrive);
  try {
    return await callback(pool);
  } finally {
    await pool.end();
  }
}
