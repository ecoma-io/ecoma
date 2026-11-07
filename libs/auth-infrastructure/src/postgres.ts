import postgresJs from 'postgres';

import { AuthConfigurationError } from '@ecoma-io/auth-domain';
import { assertNonceExpirySeconds } from '@ecoma-io/internal-auth-contracts';

/**
 * Brand danh nghĩa cho {@link PostgresClientLike}.
 *
 * ⚠️ Cố ý **không export**: một `unique symbol` chỉ `declare` được ở đúng module này, nên
 * không module nào khác (kể cả `postgres.js`) tạo được một giá trị khớp `PostgresClientLike`
 * bằng structural typing. Đó là toàn bộ mục đích: `begin` truyền cho callback một
 * `TransactionSql` **có đủ** `unsafe`/`begin`/`end` để khớp interface này nếu nó chỉ là
 * structural — và như vậy `recordNonce(tx, …)` sẽ biên dịch trôi chảy, để rồi một `ROLLBACK`
 * phía sau xoá mất bản ghi nonce của một request đã được chấp nhận.
 *
 * `declare` (không phải `const … = Symbol()`) là bắt buộc: không có giá trị runtime nào mang
 * thuộc tính này, nên không có gì để quên khởi tạo và không tốn một byte trong bundle.
 */
declare const NONCE_CLAIM_TARGET: unique symbol;

/**
 * Kho nonce trả về hình dạng khác hợp đồng của adapter — lỗi **runtime**, không phải lỗi cấu hình.
 *
 * ⚠️ **Vì sao không dùng `AuthConfigurationError`.** Class đó được định nghĩa là lỗi
 * "fail-fast lúc khởi động hoặc lúc dựng dependency" (`auth-domain/src/errors.ts`).
 * Một `Queryable` trả `{ rows }` thay vì mảng hàng thì cấu hình vẫn đúng — nó là một vi phạm
 * hợp đồng của **adapter lúc chạy**, và trộn hai loại đó vào một class khiến một lỗi tích hợp
 * trông như một lỗi cấu hình nếu về sau có chỗ phân nhánh theo class (log mức khác, retry khác).
 *
 * ⚠️ Hai call site hiện tại (`account-client.ts`, middleware của `account`) đều `catch` không
 * phân biệt nên chỉ khác nhau ở tên lỗi trong log — nhưng "chưa lộ vì cả hai catch-all" là may
 * mắn, không phải thiết kế. Phân loại đúng ngay từ đầu rẻ hơn sửa một nhánh phân loại đã ghi
 * cứng giả định sai.
 */
export class NonceStoreContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonceStoreContractError';
  }
}

/**
 * Đường vào PostgreSQL của `auth` (FR-020..FR-022).
 *
 * Ba luật mà module này buộc phải theo:
 *
 * 1. **Chỉ qua Hyperdrive binding.** `auth` không được nắm host/port/user của
 *    `db-auth`; nó chỉ được nhận `env.HYPERDRIVE`. Một connection string tới
 *    PostgreSQL public là vi phạm invariant ở `01-architecture.md`, và việc này
 *    bị chặn ở đây chứ không ở lúc deploy — vì lỗi ném ra sớm, lúc Worker khởi
 *    động, chứ không phải lúc có query đầu tiên.
 * 2. **Query cache OFF.** Xem `assertQueryCacheDisabled`. Đây là điều kiện an
 *    toàn của chính dữ liệu này: một authorization code đã bị tiêu thụ mà vẫn
 *    trả về từ cache là một lần cấp token thứ hai.
 * 3. **Không giữ state có ý nghĩa bảo mật trong process — và không giữ client
 *    qua request.** `postgres` giữ connection pool, và pool của một request
 *    chỉ thuộc về request đó: socket mà driver mở qua polyfill
 *    `cloudflare:sockets` gắn với request context đã tạo nó, tái dùng chéo
 *    request là lỗi workerd (issue #289). Không có biến nào ở đây mang nghĩa
 *    bảo mật — single-winner đến từ SQL, không đến từ việc serialize; vòng đời
 *    client nằm ở {@link withPostgresClient} và các call site của nó.
 */

/**
 * Hyperdrive binding: object do Worker runtime cấp, có `connectionString`.
 *
 * ⚠️ Đây KHÔNG phải một connection string tới database. Nó là một object mà
 * driver phải đi qua; ta truyền thẳng binding xuống `postgres()` chứ không tự
 * dựng URL từ nó.
 */
export interface HyperdriveBinding {
  readonly connectionString: string;
}

/**
 * ⚠️ Interface này KHỚP với API THẬT của `postgres@3.4.9`, và điều đó là bắt
 * buộc — không phải chi tiết cho gọn.
 *
 * Postgres.js KHÔNG có `tx.query(sql, params)`. Callback mà `begin` nhận được
 * một **tagged-template function** (`src/index.js`: `fn(sql)` với `sql` là
 * `Sql(handler)`), và muốn truyền tham số ở dạng mảng thì phải gọi `unsafe`.
 * Một interface tưởng tượng kiểu `{ query() }` sẽ biên dịch trôi chảy và ném
 * `TypeError: tx.query is not a function` ở runtime — đúng như nó đã làm. Vì
 * vậy `Queryable` ở đây là thứ driver thật sự cung cấp.
 */
export interface Queryable {
  /**
   * Query với tham số dạng mảng.
   *
   * ⚠️ Dùng `unsafe` với tham số hoá (`$1`, `$2`) là ĐÚNG, không phải lách:
   * `unsafe` chỉ nói rằng chuỗi SQL do ta viết chứ không qua builder của thư
   * viện. Tham số vẫn đi qua bind protocol, nên không có SQL injection. Đừng
   * bao giờ nối chuỗi tham số vào `sql` ở đây.
   */
  unsafe<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/** Kết nối tới `db-auth`. */
export interface PostgresClientLike extends Queryable {
  /**
   * Brand danh nghĩa — xem JSDoc của {@link NONCE_CLAIM_TARGET}.
   *
   * ⚠️ Không có giá trị runtime. Nó tồn tại để một **transaction** không bao giờ khớp được
   * interface này, dù `postgres.js` trang bị cho transaction đúng ba method dưới đây.
   */
  readonly [NONCE_CLAIM_TARGET]: true;
  /**
   * Một transaction đã BẮT ĐẦU.
   *
   * ⚠️ `fn` PHẢI ném để rollback. Nuốt lỗi rồi `return` sẽ `COMMIT` một
   * transaction chỉ đã làm nửa việc — và trong đường tiêu thụ code, nửa việc
   * nghĩa là một code bị đánh dấu đã dùng mà token không được cấp.
   */
  begin<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /**
   * Đóng pool.
   *
   * ⚠️ Bắt buộc ở cả test lẫn Worker: một client không `end()` là một socket rò
   * theo request (issue #289). Serving path không gọi trực tiếp — bọc thao tác
   * trong {@link withPostgresClient}, nơi `end()` đã nằm trong `finally`.
   */
  end(options?: { timeout?: number }): Promise<void>;
}

/**
 * Kết nối bằng Hyperdrive binding.
 *
 * ⚠️ `max` KHÔNG phải cơ chế single-winner. Mỗi Worker isolate có client riêng
 * và các isolate chạy song song; một giới hạn `max` chỉ giới hạn số connection
 * của isolate đó, không làm hai request đồng thời trở thành tuần tự. Việc một
 * authorization code chỉ được tiêu thụ một lần đến từ
 * `UPDATE ... WHERE consumed_at IS NULL` trong `authorization-code-cas`, không
 * đến từ đây — và một comment ghi sai điều đó sẽ khiến người đọc tin rằng giới
 * hạn pool là một điều khiển an toàn.
 *
 * `max: 3` là mức chính `postgres.js` chọn cho Cloudflare
 * (`globalThis.Cloudflare ? 3 : 10` trong bảng `defaults`), và Hyperdrive đã có
 * pool của riêng nó ở phía origin (HD9/HD13: ~20 connection/config). Ghi tường
 * minh để giá trị này là một quyết định đọc được, không phải một mặc định ẩn.
 *
 * @param options.connectTimeoutSeconds Thời gian chờ tối đa để **mở** connection.
 *   Mặc định của `postgres.js` là 30 giây (`defaults.connect_timeout`), lâu hơn
 *   nhiều so với một request đã được phục vụ; đường chống replay (claim nonce) truyền
 *   một giá trị ngắn để một origin không kết nối được hoá thành lỗi nhanh ⇒
 *   `db_unreachable` ⇒ 503, thay vì giữ request tới hết thời hạn Worker.
 *   Bỏ trống ⇒ giữ mặc định của driver.
 *   ⚠️ Giá trị nêu ra phải là số **hữu hạn và dương** — xem {@link assertConnectTimeoutSeconds}.
 *
 *   ⚠️⚠️ **Phạm vi thật của tham số này: chỉ pha MỞ connection, KHÔNG phải pha chạy câu lệnh.**
 *   `connect_timeout` là một option của driver đi vào bước TCP/handshake; một origin **nhận
 *   xong connection rồi** ngập (hoặc Hyperdrive kẹt sau khi đã proxy được) vẫn giữ promise của
 *   `recordNonce` treo tới hết thời hạn của Worker. Comment ở đây từng đọc như thể tham số này
 *   đóng cả hai pha, và đó là một tuyên bố sai: nó chỉ đóng pha mở. Pha **thực thi** hiện
 *   **không** được bó ở tầng driver trong module này — `makeNonceGuard` dựng pool mới cho mỗi
 *   lần claim rồi `end()`, nên mỗi request treo lại thêm một connection vào trần ~20 origin
 *   connection của Hyperdrive (HD9).
 *
 *   Hướng bó pha thực thi (chưa làm ở PR này, và **không** nên làm bằng `SET` ở mức connection —
 *   HD5: transaction-mode pooling RESET `SET` khi trả connection về pool) là `statement_timeout`
 *   truyền qua **startup parameter**. Việc đó chưa được chốt ở đây vì hành vi của Hyperdrive với
 *   startup parameter dưới transaction pooling **chưa được xác minh** từ tài liệu chính thức
 *   (spec repo: không dựa vào một capability nền tảng khi chưa kiểm chứng). Ghi thẳng phần chưa
 *   bó thay vì để một comment đọc như đã đóng.
 */
export function createPostgresClient(
  binding: HyperdriveBinding,
  options?: { readonly connectTimeoutSeconds?: number },
): PostgresClientLike {
  if (typeof binding.connectionString !== 'string' || binding.connectionString === '') {
    throw new AuthConfigurationError('Hyperdrive binding khong co connectionString');
  }
  assertConnectTimeoutSeconds(options?.connectTimeoutSeconds);

  // ⚠️ `binding.connectionString`, KHÔNG phải `binding`: postgres.js chỉ đọc URL
  // từ tham số kiểu string (`parseUrl` trả rỗng cho input không phải string) —
  // truyền nguyên object làm driver lặng lẽ rơi về `localhost:5432` (đúng lỗi
  // ECONNREFUSED ::1:5432 mà acceptance test full-flow bắt được). Hyperdrive docs
  // (developers.cloudflare.com/hyperdrive) cũng chỉ định `env.HYPERDRIVE.connectionString`.
  const client = postgresJs(binding.connectionString, {
    max: 3,
    /**
     * ⚠️ `prepare: false` — LÝ DO ĐO ĐƯỢC, không phải suy đoán.
     *
     * Mặc định của `postgres@3.4.9` là `prepare: true` (bảng `defaults` trong
     * `src/index.js`). Trong một transaction, đường đó phát ra SQL-level
     * PREPARE:
     *
     *   prepare ? await sql`prepare transaction '${…}'` : await sql`commit`
     *   (`src/index.js:276-278`)
     *
     * HD6 nói Hyperdrive không hỗ trợ SQL-level
     * `PREPARE`/`EXECUTE`/`DEALLOCATE`/`DISCARD`. Nên `prepare: false` là bắt
     * buộc, không phải tinh chỉnh hiệu năng.
     *
     * Phân biệt điều dễ nhầm: driver vẫn dùng extended query protocol
     * (Parse/Bind/Describe/Execute) ở CẢ HAI nhánh — `prepared(q)` và
     * `unnamed(q)` đều gọi `Bind`/`Execute`. `prepare` chỉ quyết định có khai
     * báo tên statement bằng SQL-level PREPARE hay không. `prepare: false` đi
     * nhánh `unnamed(q)`, nơi không có `prepare transaction` nào.
     *
     * (HD15 ghi "transaction pooling không hỗ trợ đáng tin cậy `prepare: false`"
     * — đọc xuôi câu đó ra ý ngược với hành vi thật của driver; xem ghi chú ở
     * `04-platform-facts.md`.)
     */
    prepare: false,
    // Bỏ trống ⇒ giữ mặc định của driver (30 giây). Chỉ ghi đè khi caller nêu,
    // để đường authorization-code không đổi hành vi ngoài ý muốn.
    ...(options?.connectTimeoutSeconds === undefined
      ? {}
      : { connect_timeout: options.connectTimeoutSeconds }),
  });

  return client as unknown as PostgresClientLike;
}

/**
 * Tham số dựng client của {@link withPostgresClient} — cùng hình dạng với hai tham
 * số của {@link createPostgresClient}, gói trong MỘT object để một config có thể
 * được vận chuyển như một giá trị (composition root dựng MỘT lần, các component
 * mở client từ đó khi cần).
 *
 * ⚠️ Config là giá trị THUẦN, an toàn để cache theo isolate — khác với client:
 * client gắn request context của workerd (issue #289), config thì không giữ
 * socket, pool hay state nào của driver.
 */
export interface PostgresClientConfig {
  /** Hyperdrive binding — truyền thẳng xuống {@link createPostgresClient}. */
  readonly hyperdrive: HyperdriveBinding;
  /** Bỏ trống ⇒ giữ mặc định `connect_timeout` của driver. */
  readonly connectTimeoutSeconds?: number;
}

/**
 * Chạy `fn` trên MỘT client postgres.js mới rồi đóng client — đơn vị vòng đời
 * của serving path (`#289`).
 *
 * ⚠️ **Vì sao không cache client theo isolate nữa.** postgres.js trên workerd mở
 * TCP socket qua polyfill `cloudflare:sockets`; socket gắn với request context
 * của request tạo ra nó (issue #289 — stack `postgres/cf/polyfills.js:182`).
 * Một client sống theo isolate biến MỌI request sau thành người dùng chéo-request
 * của socket đó: xen kẽ 500/302, restart mới hết. `createPostgresClient` cho
 * mỗi lần chạy rồi `end()` ngay trong request — cùng hình dạng mà `probeDatabase`
 * của `main.ts` đã dùng từ trước và không bao giờ dính lỗi này.
 *
 * ⚠️ **Một transaction là MỘT lần mở.** Toàn bộ khối `client.begin(...)` phải
 * nằm trong `fn` của MỘT lời gọi này — transaction-mode pooling của Hyperdrive
 * gắn statement với connection; hai lần mở là hai pool khác nhau và khối
 * `begin/commit` sẽ vỡ. Ngược lại, các thao tác ĐỨNG GIỮA hai khối transaction
 * (một câu gọi HTTP tới account, ví dụ) nên nằm ngoài `fn` — không giữ client
 * mở qua một phép I/O không phải DB.
 *
 * ⚠️ **`end()` chạy trong `finally`, kể cả khi `fn` ném.** Không đóng ⇒ socket
 * rò theo mỗi request. Lỗi của chính `end()` bị nuốt khi `fn` đã ném (lỗi gốc
 * thắng — đóng thất bại không được che lỗi nghiệp vụ của request), và được ném
 * ra khi `fn` thành công (người gọi cần biết đường đóng hỏng). Hợp đồng này được
 * ghim bởi `postgres.spec.ts`.
 *
 * @throws {AuthConfigurationError} Trước khi mở client, với config sai (thiếu
 *   `connectionString`, `connectTimeoutSeconds` không hữu hạn dương) — cùng
 *   validation với {@link createPostgresClient} vì cùng hàm đó chạy.
 */
export async function withPostgresClient<T>(
  config: PostgresClientConfig,
  fn: (client: PostgresClientLike) => Promise<T>,
): Promise<T> {
  const client = createPostgresClient(config.hyperdrive, {
    connectTimeoutSeconds: config.connectTimeoutSeconds,
  });
  let result: T;
  try {
    result = await fn(client);
  } catch (fnError) {
    // Lỗi gốc thắng: một `end()` ném thêm ở đây chỉ là tiếng ồn của teardown.
    await client.end({ timeout: 1 }).catch(() => undefined);
    throw fnError;
  }
  // Đường thành công: lỗi đóng là lỗi thật của request này.
  await client.end({ timeout: 1 });
  return result;
}

/**
 * Kiểm `connectTimeoutSeconds` trước khi đưa cho driver.
 *
 * ⚠️ Vì sao không thả thẳng xuống `postgres.js`: tham số này đi vào `connect_timeout`
 * của driver, và mọi giá trị **không phải** số hữu hạn dương đều là một cách tắt
 * timeout. `connect_timeout: 0`, `NaN` hay số âm khiến driver không giới hạn việc mở
 * connection — đúng thứ mà tham số này tồn tại để chặn, và nó fail **open** (request
 * treo tới hết thời hạn Worker thay vì lỗi nhanh), nên nó không thể tự lộ ra ở test
 * nào hỏi "có kết nối được không".
 *
 * Bỏ trống là hợp lệ và **giữ nguyên mặc định của driver** — đó là hành vi hiện tại của
 * đường authorization-code, và thay nó lặng lẽ là đổi một đường không liên quan.
 *
 * ⚠️ Không kèm giá trị vào message: cùng quy tắc với mọi phép kiểm cấu hình khác trong
 * repo — message nói *tham số nào* sai, không nói *giá trị nào*. Một chuỗi cấu hình có
 * thể là thứ không nên nằm trong log, và ở đây kiểu đã là `number` nên chỉ cần một ngoại
 * lệ nhỏ là quy tắc thôi đúng.
 */
function assertConnectTimeoutSeconds(value: number | undefined): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AuthConfigurationError(
      'connectTimeoutSeconds phai la so huu han duong (giay); bo trong de giu mac dinh cua driver',
    );
  }
}

/**
 * HD3/HD4: query cache mặc định bật, và **không** invalidate khi ghi.
 *
 * Hàm này không bật/tắt được gì — Hyperdrive cache ở phía Cloudflare, nên việc
 * tắt là một thuộc tính của config do vận hành đặt. Hàm tồn tại để nơi kiểm tra
 * có một cái gì để kiểm, và để lỗi cấu hình này bị bắt sớm thay vì thành một
 * lần cấp token thứ hai trong production.
 */
export function assertQueryCacheDisabled(configCachingEnabled: boolean): void {
  if (configCachingEnabled) {
    throw new AuthConfigurationError(
      'Hyperdrive query cache phai OFF: cache khong invalidate khi ghi, nen authorization code da tieu thu van tra ve tu cache',
    );
  }
}

/**
 * Ghi một nonce đã xác thực vào kho bền của `auth`.
 *
 * ⚠️ **Quy ước trả về, đọc kỹ trước khi dùng:** trả `true` khi nonce **ĐÃ TỒN TẠI** (tức là
 * request bị từ chối), `false` khi đây là lần chiếm đầu tiên (được đi tiếp). Đây là cực ngược
 * với cách đọc tên hàm theo trực giác ("ghi thành công ⇒ `true`"), và đó là chủ ý: giá trị trả
 * về được truyền thẳng vào `claimNonce` của `verifyRequest`, nơi `true` nghĩa là "đã thấy rồi".
 * Call site phải viết `if (await recordNonce(...)) return replayed`. Một call site hiểu ngược
 * sẽ hoặc chặn mọi request hợp lệ, hoặc tắt hẳn replay guard — và cả hai đều không làm test nào
 * đỏ ngoài bộ test của chính đường này.
 *
 * ⚠️ Đây là hình thức `claimNonce` mà `verifyRequest` cần: **kiểm tra và ghi trong một
 * câu**, không phải `SELECT` rồi `INSERT` ở câu khác. Đọc-rồi-ghi mất tính nguyên tử
 * dưới tải đồng thời, và hai request mang cùng nonce sẽ cùng thắng — tức là replay
 * guard không chống được replay. `ON CONFLICT DO NOTHING` rồi đếm số hàng trả về là một câu
 * lệnh nên PostgreSQL quyết định thắng thua bằng ràng buộc UNIQUE, bất kể bao nhiêu Worker
 * cùng tranh.
 *
 * `expires_at` do **caller tính** và truyền vào — cột cố ý **không** có `DEFAULT` trong
 * `0010_internal_nonces.sql`. Nếu database tự điền thì nonce sống mãi và guard vô hiệu
 * hóa. Caller phải neo mốc hết hạn theo **timestamp của envelope**:
 * `timestamp + skew + buffer` — `verifyRequest` chấp nhận khi `|now − timestamp| ≤ skew`,
 * nên cửa sổ replay của envelope kết thúc đúng tại `timestamp + skew`, và TTL đó sống qua
 * cửa sổ đúng bằng buffer (prune chạy theo lô). Neo theo envelope thì không phụ thuộc việc
 * hai đồng hồ caller/verifier có lệch nhau hay không.
 *
 * ⚠️ **Nhưng còn một đồng hồ thứ ba, và nó không nằm trong công thức: đồng hồ của database.**
 * Prune so `expires_at < now()` — `now()` là thời gian của **server PostgreSQL**, không phải của
 * verifier và không phải giá trị trong envelope. Nếu đồng hồ DB chạy nhanh hơn đồng hồ verifier
 * nhiều hơn `NONCE_TTL_BUFFER_SECONDS`, prune xoá một nonce vẫn còn trong cửa sổ skew của
 * verifier ⇒ replay trong cửa sổ đó thành công. Đây đúng là kịch bản mà `0010_internal_nonces.sql`
 * gọi là "TTL ngắn hơn skew là hỏng", chỉ khác nguồn gốc. Hệ quả bắt buộc khi chỉnh buffer:
 * `NONCE_TTL_BUFFER_SECONDS` phải **≥ lệch đồng hồ verifier↔DB tối đa chấp nhận được**, và buffer
 * tuyệt đối **không** được nhỏ đến mức chỉ dành cho độ trễ của lô prune. Neo theo envelope loại bỏ
 * cặp lệch caller/verifier, **không** loại bỏ lệch verifier/DB — hai câu khác nhau.
 *
 * ⚠️ **Bản chép của `account.internal_nonces`** (`apps/account/server/utils/db.ts`), cùng
 * lý do với `authorization-code-cas.ts`: adapter là nơi dùng schema, schema là nơi khai
 * ràng buộc. Lệch tên cột ở đây chỉ lộ ra khi chạy với schema thật.
 *
 * Tham số là {@link Queryable} chứ không phải {@link PostgresClientLike}: hàm chỉ cần
 * chạy **một** câu lệnh, nên nhận cả pool lẫn một transaction đang mở.
 *
 * ⚠️ **Bền vững chỉ khi ghi NGOÀI transaction nghiệp vụ.** Tính nguyên tử đến từ `ON CONFLICT`,
 * nhưng bản ghi chỉ tồn tại sau `COMMIT`: một caller truyền transaction rồi `ROLLBACK` về sau
 * (vì nghiệp vụ phía sau thất bại) sẽ **xoá** bản ghi nonce, trong khi request đó đã được
 * `verifyRequest` trả `ok` và có thể đã được xử lý — nên phát lại đúng envelope đó trong cửa
 * sổ skew lại chiếm được nonce, và replay guard đã bị vô hiệu trong im lặng.
 *
 * ⚠️ **Vì vậy tham số là {@link PostgresClientLike}, không phải {@link Queryable}, và đó là một
 * ràng buộc của kiểu chứ không phải một lời khuyên.** Trước đây hàm nhận `Queryable` — đúng
 * bằng kiểu mà callback của `begin` nhận — nên `client.begin((tx) => recordNonce(tx, …))` biên
 * dịch trôi chảy, và `recordNonce` có đúng một cách dùng sai mà không có gì chặn. Bỏ `begin`
 * khỏi kiểu cũng **không đủ**: `postgres.js` cho `TransactionSql` đủ `unsafe`/`begin`/`end` để
 * khớp một interface thuần structural, nên transaction vẫn lọt qua được. Chỉ brand danh nghĩa
 * {@link NONCE_CLAIM_TARGET} mới chặn thật, và nó chặn ở **compile time**: truyền transaction
 * là lỗi biên dịch, không phải một comment cảnh báo.
 *
 * Test atomicity dùng hai **pool** riêng chạy song song (mỗi pool một connection), không dùng
 * transaction — xem `internal-nonces.spec.ts`. Đó cũng đúng bằng đường chạy thật: `makeNonceGuard`
 * gọi hàm này trên một pool trần.
 *
 * @param expiryEpochSeconds Mốc hết hạn caller chọn, theo quy tắc phía trên — hằng số
 *   giao thức nằm ở caller, không ở đây.
 * @throws {AuthConfigurationError} Khi `expiryEpochSeconds` không phải một mốc epoch giây hợp
 *   lệ (xem {@link assertNonceExpirySeconds}).
 * @throws {NonceStoreContractError} Khi kho trả về hình dạng khác hợp đồng — lỗi runtime của
 *   adapter, không phải lỗi cấu hình (xem {@link NonceStoreContractError}).
 *   Cả hai đều là **fail closed**: người gọi dịch chúng thành `db_unreachable` ⇒ 503.
 */
export async function recordNonce(
  client: PostgresClientLike,
  nonce: string,
  expiryEpochSeconds: number,
): Promise<boolean> {
  // ⚠️ **Kiểm TTL ở đúng tầng ghi, không tin người gọi.** `expires_at` là dữ liệu mà *caller*
  // quyết định, và một giá trị sai ở đây không đỏ ở đâu cả: `to_timestamp(NaN)` ném từ driver
  // (khó đọc), còn `to_timestamp(<epoch mili giây>)` **lặng lẽ** tạo một nonce sống tới năm
  // 57000 — tức là một hàng không bao giờ được prune, và một nonce "bền" theo nghĩa hỏng. Chiều
  // còn lại nguy hiểm hơn: TTL ngắn hơn `skew` khiến prune xoá một nonce còn hiệu lực, mở lại
  // cửa sổ replay mà kho này tồn tại để đóng. Bất biến của cột là bất biến của hàm ghi, không
  // phải của `config.ts` hay của call site — một call site mới (test, script vận hành, đường
  // khác) không được thừa hưởng một kho nonce không còn chống replay.
  //
  // Không kèm giá trị vào message: xem JSDoc của `assertNonceExpirySeconds`.
  assertNonceExpirySeconds(expiryEpochSeconds, (message) => new AuthConfigurationError(message));
  const inserted = await client.unsafe<{ nonce: string }>(
    `INSERT INTO auth.internal_nonces (nonce, expires_at)
       VALUES ($1, to_timestamp($2))
       ON CONFLICT (nonce) DO NOTHING
     RETURNING nonce`,
    [nonce, expiryEpochSeconds],
  );
  // ⚠️ **`RETURNING` là bắt buộc, không phải cho đẹp.** `ON CONFLICT DO NOTHING`
  // chỉ nói "đã tồn tại" qua **số hàng trả về**: chèn được ⇒ một hàng; đụng UNIQUE ⇒
  // không hàng nào. Không có `RETURNING`, câu lệnh không trả hàng trong MỌI trường
  // hợp, và một phép đếm hàng thuần tuý sẽ trả `true` (đã thấy) cho cả nonce mới —
  // tức là từ chối mọi request nội bộ hợp lệ. Đó đúng là lỗi đã có ở đây, và test
  // `internal-nonces.spec.ts` bắt được nó ngay lần chạy đầu trên PostgreSQL thật.
  //
  // ⚠️ **Fail closed khi hình dạng kết quả không như hợp đồng.** `Queryable` là API thật của
  // `postgres.js` và luôn trả **mảng** hàng, nên `.length` ở đây đúng. Nhưng một client khác
  // (ví dụ `QueryResult` của `pg`, chỉ có `rows`/`rowCount`) cho `inserted.length` là
  // `undefined`, và `undefined === 0` là `false` — mà `false` nghĩa là "nonce **chưa từng
  // thấy**", tức là **mọi** request đã dùng đều đi qua: replay guard tắt hẳn, trong im lặng.
  // (Hướng ngược — trả `true` cho mọi request — cũng hỏng im lặng, nhưng chặn cả request hợp
  // lệ.) Cả hai đều là **diễn giải** một hình dạng sai, nên hình dạng sai phải ném thay vì
  // được diễn giải.
  if (!Array.isArray(inserted)) {
    throw new NonceStoreContractError(
      'Queryable phai tra ve mang hang (postgres.js); hinh dang khac lam replay guard sai im lang',
    );
  }
  return inserted.length === 0;
}
