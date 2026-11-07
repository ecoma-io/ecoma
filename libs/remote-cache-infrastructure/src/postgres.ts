import postgresJs from 'postgres';

import { RemoteCacheConfigurationError } from './configuration-error';

/**
 * Duong vao PostgreSQL cua `remote-cache` qua Hyperdrive binding
 * `DB_REMOTE_CACHE` (database `db-remote-cache`, ADR-0015).
 *
 * Ba luat ma module nay buoc phai theo — cung ba luat cua
 * `libs/staff-access-infrastructure/src/postgres.ts` (pattern tham chieu):
 *
 * 1. **Chi qua Hyperdrive binding.** `remote-cache` khong duoc nam
 *    host/port/user cua `db-remote-cache`; no chi duoc nhan binding object co
 *    `connectionString`. Mot connection string tu xuong PostgreSQL public la
 *    vi pham invariant database boundary — va viec nay bi chan o day chu
 *    khong o luc deploy.
 * 2. **`prepare: false` bat buoc** (HD6: Hyperdrive khong ho tro SQL-level
 *    `PREPARE`/`EXECUTE`/`DEALLOCATE`). Khong phai tinh chinh hieu nang — la
 *    dieu kien an toan cua duong chay.
 * 3. **Khong giu client qua request.** postgres.js tren workerd mo TCP socket
 *    qua polyfill `cloudflare:sockets`; socket gan voi request context da tao
 *    no (issue #289), tai dung cheo request la loi workerd. Vong doi client
 *    nam o `withRemoteCacheClient`: `end()` trong `finally`, moi request mot
 *    client.
 *
 * ⚠️ **Hyperdrive query cache phai OFF** cho `db-remote-cache` — cache khong
 * invalidate khi ghi; data plane (P4.2) doc trang thai credential/revoke nen
 * mot key da revoke van tra ve tu cache la loi bao mat thay vi hien ke.
 * Provision khong duoc bat caching cho Hyperdrive config nay (ADR-0015 tuan
 * tu A5/invariant 14 theo pattern ADR-0001/ADR-0013).
 */

/**
 * Hyperdrive binding: object do Worker runtime cap, co `connectionString`.
 *
 * ⚠️ Day KHONG phai mot connection string toi database. No la mot object ma
 * driver phai di qua; ta truyen thang `connectionString` xuong `postgres()`
 * chu khong tu dung URL tu binding.
 */
export interface RemoteCacheHyperdriveBinding {
  readonly connectionString: string;
}

/**
 * API THAT ma `postgres@3.4.9` cung cap cho mot client hay mot transaction —
 * giong `Queryable` cua staff-access-infrastructure. Postgres.js KHONG co
 * `tx.query(sql, params)`; muon truyen tham so dang mang phai di qua `unsafe`
 * (tham so van di qua bind protocol, khong co SQL injection).
 */
export interface RemoteCacheQueryable {
  unsafe<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/**
 * Ket noi toi `db-remote-cache` — client cap do cua `postgres()`, khong phai
 * mot transaction. Chua `begin` de duong transaction cua repo co type an
 * (skeleton P4.1 dung transaction khi tao project kem API key dau tien).
 */
export interface RemoteCacheClient extends RemoteCacheQueryable {
  /**
   * Mot transaction da BAT DAU.
   *
   * ⚠️ `fn` PHAI nem de rollback. Nuot loi roi `return` se `COMMIT` mot
   * transaction chi da lam nua viec — voi control plane do la mot project
   * khong co key nao hoac mot key ma khong thuoc project nao.
   */
  begin<T>(fn: (tx: RemoteCacheQueryable) => Promise<T>): Promise<T>;
  /**
   * Dong pool.
   *
   * ⚠️ Bat buoc o ca test lan Worker: mot client khong `end()` la mot socket
   * ro theo request (issue #289). Serving path khong goi truc tiep — boc
   * thao tac trong `withRemoteCacheClient`, noi `end()` da nam trong `finally`.
   */
  end(options?: { timeout?: number }): Promise<void>;
}

/**
 * Tao client postgres.js moi tu Hyperdrive binding.
 *
 * `max: 3` la muc chinh `postgres.js` chon cho Cloudflare
 * (`globalThis.Cloudflare ? 3 : 10`), va Hyperdrive da co pool rieng o phia
 * origin (HD9).
 *
 * @throws {RemoteCacheConfigurationError} Khi binding thieu `connectionString`
 *   — fail-closed truoc khi mo connection, cung luat message-khong-neu-gia-tri
 *   voi moi config check khac cua repo.
 */
export function createRemoteCachePostgresClient(
  binding: RemoteCacheHyperdriveBinding,
): RemoteCacheClient {
  // `binding` co the la undefined/null tu duong config fail: truy cap
  // `connectionString` tren null nem TypeError khong co message config —
  // kiem truoc de ca nam hinh dang sai deu ra dung loi fail-closed.
  if (
    binding === null ||
    typeof binding !== 'object' ||
    typeof binding.connectionString !== 'string' ||
    binding.connectionString === ''
  ) {
    throw new RemoteCacheConfigurationError(
      'Hyperdrive binding DB_REMOTE_CACHE has no connectionString; remote-cache fails closed',
    );
  }

  // ⚠️ `binding.connectionString`, KHONG phai `binding`: postgres.js chi doc
  // URL tu tham so kieu string (`parseUrl` tra rong cho input khac string) —
  // truyen nguyen object lam driver lang le roi ve `localhost:5432`.
  const client = postgresJs(binding.connectionString, {
    max: 3,
    /**
     * ⚠️ `prepare: false` — HD6 (platform facts): Hyperdrive khong ho tro
     * SQL-level PREPARE, va duong transaction cua postgres.js mac dinh phat
     * ra `prepare transaction` khi ket thuc. Day la bat buoc, khong phai
     * tinh chinh — comment day du nam o
     * `libs/staff-access-infrastructure/src/postgres.ts` (pattern tham chieu).
     */
    prepare: false,
  });

  return client as unknown as RemoteCacheClient;
}

/**
 * Tham so dung client cua `withRemoteCacheClient` — mot config THUAN, an toan
 * cache theo isolate (khong giu socket, pool hay state nao cua driver).
 */
export interface RemoteCacheClientConfig {
  /** Hyperdrive binding — truyen thang xuong `createRemoteCachePostgresClient`. */
  readonly hyperdrive: RemoteCacheHyperdriveBinding;
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
export async function withRemoteCacheClient<T>(
  config: RemoteCacheClientConfig,
  fn: (client: RemoteCacheClient) => Promise<T>,
): Promise<T> {
  const client = createRemoteCachePostgresClient(config.hyperdrive);
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
