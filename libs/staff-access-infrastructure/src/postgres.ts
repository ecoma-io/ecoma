import postgresJs from 'postgres';

import { StaffAccessConfigurationError } from './configuration-error';

/**
 * Duong vao PostgreSQL cua `staff-access` qua Hyperdrive binding
 * `DB_STAFF_ACCESS` (database `db-staff-access`).
 *
 * Ba luat ma module nay buoc phai theo — cung ba luat cua
 * `libs/auth-infrastructure/src/postgres.ts` (pattern tham chieu):
 *
 * 1. **Chi qua Hyperdrive binding.** `staff-access` khong duoc nam
 *    host/port/user cua `db-staff-access`; no chi duoc nhan binding object co
 *    `connectionString`. Mot connection string tu xuong PostgreSQL public la
 *    vi pham invariant database boundary — va viec nay bi chan o day chu khong
 *    o luc deploy, vi loi nem ra som, luc Worker khoi dong.
 * 2. **`prepare: false` bat buoc** (HD6: Hyperdrive khong ho tro SQL-level
 *    `PREPARE`/`EXECUTE`/`DEALLOCATE`). Khoong phai tinh chinh hieu nang — la
 *    dieu kien an toan cua duong chay; comment tai call site giai thich day du.
 * 3. **Khong giu client qua request.** postgres.js tren workerd mo TCP socket
 *    qua polyfill `cloudflare:sockets`; socket gan voi request context da tao
 *    no (issue #289), tai dung cheo request la loi workerd. Vong doi client
 *    nam o `withStaffAccessClient`: `end()` trong `finally`, moi request mot
 *    client.
 *
 * ⚠️ **Hyperdrive query cache phai OFF** cho `db-staff-access` — cache khong
 * invalidate khi ghi, nen mot assignment da revoke van co the tra ve tu cache.
 * provision khong duoc bat caching cho Hyperdrive config nay (ADR-0001 tuan
 * tu A5/invariant 14, ap dung nguyen van cho ownership moi theo ADR-0013).
 */

/**
 * Hyperdrive binding: object do Worker runtime cap, co `connectionString`.
 *
 * ⚠️ Day KHONG phai mot connection string toi database. No la mot object ma
 * driver phai di qua; ta truyen thang `connectionString` xuong `postgres()`
 * chu khong tu dung URL tu binding.
 */
export interface StaffAccessHyperdriveBinding {
  readonly connectionString: string;
}

/**
 * API THAT ma `postgres@3.4.9` cung cap cho mot client hay mot transaction —
 * giong `Queryable` cua auth-infrastructure. Postgres.js KHONG co
 * `tx.query(sql, params)`; muon truyen tham so dang mang phai di qua `unsafe`
 * (tham so van di qua bind protocol, khong co SQL injection).
 */
export interface StaffAccessQueryable {
  unsafe<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/**
 * Brand danh nghia cho transaction — pattern `NONCE_CLAIM_TARGET` cua
 * auth-infrastructure.
 *
 * ⚠️ Co y **khong export**: mot `unique symbol` chi `declare` duoc o dung
 * module nay, nen khong module nao khac tao duoc gia tri khop
 * {@link StaffAccessTransaction} bang structural typing. Day la rang doi cua
 * invariant A8 (issue #437): repository ghi entitlement nhan **chi** tx nay,
 * nen mot duong goi `upsertEntitlement(client, ...)` vo tinh (ghi state +
 * event ngoai mot transaction) khong bien dich — thay vi bien dich roi commit
 * nua viec. `declare` (khong phai `const ... = Symbol()`) la bat buoc: khong
 * co gia tri runtime nao mang thuoc tinh nay, khong ton mot byte trong bundle.
 */
declare const STAFF_ACCESS_TRANSACTION: unique symbol;

/**
 * Mot transaction DA BAT DAU — doi tuong ma `begin` truyen cho callback.
 *
 * Vi brand, no KHONG khop {@link StaffAccessClient} (client co `begin`/`end`
 * nhung thieu thuoc tinh brand), nen repository ghi khong the nham nhan mot
 * client va tu mo transaction "ngam" ben trong: nguoi goi phai mo transaction
 * truoc, va viec commit/rollback nam o duong `begin` duy nhat do.
 */
export interface StaffAccessTransaction extends StaffAccessQueryable {
  /** Brand danh nghia — xem JSDoc cua {@link STAFF_ACCESS_TRANSACTION}. */
  readonly [STAFF_ACCESS_TRANSACTION]: true;
}

/**
 * Ket noi toi `db-staff-access` — client cap do cua `postgres()`, khong phai
 * mot transaction. Chua `begin` de duong transaction cua repo co type an;
 * khong co brand danh nghia nhu auth-infrastructure vi serving path cua
 * `staff-access` o Milestone A chua co duong "transaction khong duoc dung lam
 * pool" can chan — repo hien tai chi can `unsafe`.
 */
export interface StaffAccessClient extends StaffAccessQueryable {
  /**
   * Mot transaction da BAT DAU.
   *
   * ⚠️ `fn` PHAI nem de rollback. Nuot loi roi `return` se `COMMIT` mot
   * transaction chi da lam nua viec — voi audit/assignment do la mot ghi
   * audit mat vet hoac mot grant roi vao trang thai leo thang.
   *
   * Callback nhan {@link StaffAccessTransaction} (co brand): repository ghi
   * entitlement nhan chi tx nay de invariant A8 (state + outbox cung mot
   * transaction) duoc giu o muc type, khong phai hua loi bang comment.
   */
  begin<T>(fn: (tx: StaffAccessTransaction) => Promise<T>): Promise<T>;
  /**
   * Dong pool.
   *
   * ⚠️ Bat buoc o ca test lan Worker: mot client khong `end()` la mot socket
   * ro theo request (issue #289). Serving path khong goi truc tiep — boc
   * thao tac trong `withStaffAccessClient`, noi `end()` da nam trong `finally`.
   */
  end(options?: { timeout?: number }): Promise<void>;
}

/**
 * Tran tren cua {@link StaffAccessClientOptions.connectTimeoutSeconds}.
 *
 * Option nay chi dung cho probe ngan (readiness dat 3s). Mot tran khong co
 * canh tren bien mot tham so "timeout ngan" thanh mot tham so co the treo
 * request lau — dung dieu option sinh ra de ngan. 300s la gioi han rong rai
 * cho moi gia tri hop ly cua mot probe readiness, dong thoi la mot nguong co
 * the kiem bang so sanh. No KHONG duoc chon theo thoi han request cua Worker:
 * platform fact WK1 dat proxy read timeout HTTP mac dinh o 125s, nen mot probe
 * that su giu lau hon nguong do da bi cat truoc khi timeout nay kich hoat —
 * tran nay chan gia tri vo ly, khong thay the mot ngan sach probe dung.
 */
const MAX_CONNECT_TIMEOUT_SECONDS = 300;

/** Tuy chon cua {@link createStaffAccessPostgresClient}. */
export interface StaffAccessClientOptions {
  /**
   * Tran cho pha **mo** connection (giay) — mac dinh cua `postgres.js` la 30s.
   *
   * Chi readiness truyen gia tri ngan: mot origin khong mo duoc connection
   * phai hoa thanh loi nhanh (`db_unreachable`) thay vi giu probe toi het
   * thoi han Worker. Gia tri phai huu han, duong va khong vuot
   * {@link MAX_CONNECT_TIMEOUT_SECONDS}; bo qua option de giu mac dinh driver.
   */
  readonly connectTimeoutSeconds?: number;
}

/**
 * Tao client postgres.js moi tu Hyperdrive binding.
 *
 * `max: 3` la muc chinh `postgres.js` chon cho Cloudflare
 * (`globalThis.Cloudflare ? 3 : 10`), va Hyperdrive da co pool rieng o phia
 * origin (HD9). Khong phai co che single-winner — cac isolate chay song
 * song; tinh single-winner (neu co) den tu constraint SQL, khong tu pool.
 *
 * @throws {StaffAccessConfigurationError} Khi binding thieu `connectionString`
 *   — fail-closed truoc khi mo connection, cung luat message-khong-neu-gia-tri
 *   voi moi config check khac cua repo.
 * @throws {StaffAccessConfigurationError} Khi `connectTimeoutSeconds` khong
 *   phai so huu han trong khoang `(0, 300]` — mot timeout sai am tham lam
 *   probe treo vo han, va mot timeout qua lon vo hieu hoa chinh y do ngan.
 */
export function createStaffAccessPostgresClient(
  binding: StaffAccessHyperdriveBinding,
  options?: StaffAccessClientOptions,
): StaffAccessClient {
  // `binding` co the la undefined/null tu duong config fail: truy cap
  // `connectionString` tren null nem TypeError khong co message config —
  // kiem truoc de ca nam hinh dang sai deu ra dung loi fail-closed.
  //
  // Thu tu kiem co y: binding TRUOC timeout. Khi ca hai cung sai, loi binding
  // moi la nguyen nhan goc (binding do Worker runtime cap, timeout do code
  // readiness dat) — bao loi timeout truoc se che mat nguyen nhan quan trong
  // hon va lam mot su co binding tro thanh kho debug. Ca hai van fail-closed.
  if (
    binding === null ||
    typeof binding !== 'object' ||
    typeof binding.connectionString !== 'string' ||
    binding.connectionString === ''
  ) {
    throw new StaffAccessConfigurationError(
      'Hyperdrive binding DB_STAFF_ACCESS has no connectionString; staff-access fails closed',
    );
  }
  const connectTimeoutSeconds = options?.connectTimeoutSeconds;
  if (
    connectTimeoutSeconds !== undefined &&
    (typeof connectTimeoutSeconds !== 'number' ||
      !Number.isFinite(connectTimeoutSeconds) ||
      connectTimeoutSeconds <= 0 ||
      connectTimeoutSeconds > MAX_CONNECT_TIMEOUT_SECONDS)
  ) {
    throw new StaffAccessConfigurationError(
      `connectTimeoutSeconds must be a finite number of seconds greater than 0 and at most ${MAX_CONNECT_TIMEOUT_SECONDS}; omit it to keep the driver default`,
    );
  }

  // ⚠️ `binding.connectionString`, KHONG phai `binding`: postgres.js chi doc
  // URL tu tham so kieu string (`parseUrl` tra rong cho input khac string) —
  // truyen nguyen object lam driver lang le roi ve `localhost:5432` (loi
  // ECONNREFUSED ma acceptance test cua auth da bat duoc). Hyperdrive docs
  // cung chi dinh `env.<BINDING>.connectionString`.
  const client = postgresJs(binding.connectionString, {
    max: 3,
    /**
     * ⚠️ `prepare: false` — HD6 (platform facts): Hyperdrive khong ho tro
     * SQL-level PREPARE, va duong transaction cua postgres.js mac dinh phat
     * ra `prepare transaction` khi ket thuc. Day la bat buoc, khong phai
     * tinh chinh — comment day du nam o `libs/auth-infrastructure/src/postgres.ts`
     * (pattern tham chieu, do luong va do ly do tren driver 3.4.9).
     */
    prepare: false,
    ...(connectTimeoutSeconds === undefined ? {} : { connect_timeout: connectTimeoutSeconds }),
  });

  return client as unknown as StaffAccessClient;
}

/**
 * Tham so dung client cua `withStaffAccessClient` — mot config THUAN, an toan
 * cache theo isolate (khong giu socket, pool hay state nao cua driver).
 */
export interface StaffAccessClientConfig {
  /** Hyperdrive binding — truyen thang xuong `createStaffAccessPostgresClient`. */
  readonly hyperdrive: StaffAccessHyperdriveBinding;
  /** Tran mo connection — chi readiness dung; xem {@link StaffAccessClientOptions}. */
  readonly connectTimeoutSeconds?: number;
}

/**
 * SQLSTATE cua nhom "database tra loi nhung cau lenh bi tu choi" — khac hoan
 * toan voi "khong mo duoc connection".
 *
 * Danh sach co y NGAN va chi gom ma ma readiness thuc su co the gap: thieu
 * grant (`42501`), thieu bang (`42P01`), thieu cot (`42703`). Dung chung mot
 * nhan `db_unreachable` cho ca nhom nay dan nguoi van hanh di kiem tra ket noi
 * trong khi su co la migration/grant — dung lop loi ma probe readiness sinh ra
 * de bat.
 */
const SCHEMA_SQLSTATES: ReadonlySet<string> = new Set(['42501', '42P01', '42703']);

/**
 * `true` khi `error` mang **hinh dang** loi PostgreSQL cua `postgres.js` va
 * SQLSTATE cua no thuoc nhom schema/grant — khong phai database khong toi duoc.
 *
 * Doc theo **cau truc**, khong theo `instanceof`: `postgres` la package CJS nen
 * `PostgresError` chi ton tai nhu thuoc tinh cua default export (mot
 * `instanceof` vao do chi co hieu luc khi mo hinh module cua bundler khop), va
 * mot `Error` di qua realm khac (structured clone giua isolate, hoac vat mang
 * sang tu host) khong con nguyen prototype cua `Error` — `instanceof Error`
 * tra `false` trong khi `name`/`code` van con. Nhan dang hinh dang giu duoc
 * hai duong do ma van fail-closed: mot gia tri khong phai object, khong co
 * `name` dung, hoac co `code` ngoai allowlist deu tra `false`.
 *
 * Loi tang driver — `ECONNREFUSED`, `ENOTFOUND`, `CONNECT_TIMEOUT` — la `Error`
 * thuong voi `name` khac (`Error`) va `code` khong phai SQLSTATE, nen khong
 * bao gio khop du chung co mang `code`. Mot loi khong nhan dang duoc van
 * fail-closed theo huong "khong toi duoc".
 */
export function isStaffAccessSchemaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === 'PostgresError' && typeof code === 'string' && SCHEMA_SQLSTATES.has(code);
}

/**
 * Chay `fn` tren MOT client postgres.js moi roi dong client — don vi vong doi
 * cua serving path (issue #289).
 *
 * ⚠️ **Mot transaction la MOT lan mo.** Toan bo khoi `client.begin(...)` phai
 * nam trong `fn` cua MOT loi goi nay — transaction-mode pooling cua Hyperdrive
 * gan statement voi connection; hai lan mo la hai pool khac nhau va khoi
 * `begin/commit` se vo.
 *
 * ⚠️ **`end()` chay trong `finally`, ke ca khi `fn` nem.** Khong dong ⇒ socket
 * ro theo moi request. Loi cua chinh `end()` bi nuot khi `fn` da nem (loi goc
 * thang — dong that bai khong duoc che loi nghiep vu cua request), va duoc
 * nem ra khi `fn` thanh cong.
 */
export async function withStaffAccessClient<T>(
  config: StaffAccessClientConfig,
  fn: (client: StaffAccessClient) => Promise<T>,
): Promise<T> {
  // Mot loi goi duy nhat: factory da xu ly `undefined` bang cach KHONG them
  // key `connect_timeout` vao driver options (khong phai dat key = undefined —
  // key co mat voi gia tri undefined van la mot option duoc truyen).
  const client = createStaffAccessPostgresClient(config.hyperdrive, {
    connectTimeoutSeconds: config.connectTimeoutSeconds,
  });
  let result: T;
  try {
    result = await fn(client);
  } catch (fnError) {
    // Loi goc thang: mot `end()` nem them o day chi la tieng on cua teardown.
    await client.end({ timeout: 1 }).catch(() => undefined);
    throw fnError;
  }
  // Duong thanh cong: loi dong la loi that cua request nay.
  await client.end({ timeout: 1 });
  return result;
}
