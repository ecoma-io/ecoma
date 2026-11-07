/**
 * Truy cập PostgreSQL của bounded context `backoffice` — đọc hình dạng binding
 * Hyperdrive và dựng pool `pg` theo giới hạn Hyperdrive.
 *
 * Module này là **framework-agnostic**: nó nhận giá trị đã đọc (env của Worker,
 * connection string) từ caller — với `apps/backoffice`, `readWorkerEnv`
 * (`apps/backoffice/server/db.ts`) là đường đọc `env` ra khỏi `H3Event`, và
 * caller truyền kết quả vào {@link backofficeHyperdrive}/{@link withBackofficePool}.
 * Pattern tham chiếu là `apps/account/server/utils/db.ts` + `bindings.ts` —
 * cùng hình thức (pool nhỏ, không giữ state ở module scope, listener `error`
 * bắt buộc). Hai app vành đai chung **pattern** chứ không chung code.
 */

import { Pool } from 'pg';

/**
 * Tên binding Hyperdrive tới `db-backoffice`.
 *
 * Khớp `apps/backoffice/wrangler.jsonc`. Code chỉ chứa **tên** binding — không
 * host, không port, không user, không password (invariant 4 của
 * `docs/domains/staff-access/domain-model.md`): connection string thật lấy ở
 * runtime qua `binding.connectionString`, do Cloudflare Hyperdrive cấp cho
 * config đã provision. Credential của runtime role không bao giờ xuất hiện ở
 * đây — nó thuộc `wrangler secret` / tầng deploy riêng.
 */
export const DB_BACKOFFICE_BINDING = 'DB_BACKOFFICE';

/** Hình dạng tối thiểu của binding mà module này đọc. */
export interface HyperdriveBinding {
  readonly connectionString: string;
}

/**
 * Đọc binding Hyperdrive `DB_BACKOFFICE` ra khỏi `env` của Worker.
 *
 * ⚠️ Nhận `unknown` thay vì khai kiểu cho `env`: binding phụ thuộc hạ tầng,
 * `wrangler.jsonc` và code deploy không bảo đảm cùng nhịp — kiểm hình dạng
 * **thật** thay vì tin kiểu.
 *
 * @param env `env` của Worker — đọc ra khỏi request context bởi caller (vd
 *   `readWorkerEnv` phía app); giữ `unknown` để lib này không ràng buộc cách
 *   đọc.
 * @returns Binding, hoặc `null` khi env chưa khai báo (hoặc khai sai hình
 *   dạng). `null` **không** phải "chạy được không cần DB": caller fail closed —
 *   route trả `503` thay vì rơi về một đường không xác thực.
 */
export function backofficeHyperdrive(env: unknown): HyperdriveBinding | null {
  if (typeof env !== 'object' || env === null) {
    return null;
  }
  const binding = (env as Record<string, unknown>)[DB_BACKOFFICE_BINDING];
  // Không dùng `instanceof` hay duck-type sâu: object binding của Workers đi
  // qua shim nên không có prototype ổn định; kiểm `connectionString` là chuỗi
  // không rỗng là đủ.
  if (typeof binding !== 'object' || binding === null) {
    return null;
  }
  const connectionString = (binding as HyperdriveBinding).connectionString;
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    return null;
  }
  return binding as HyperdriveBinding;
}

/**
 * Cấu hình `pg` theo Hyperdrive.
 *
 * Con số bám giới hạn nền tảng (đối chiếu `docs/architecture/04-platform-facts.md`,
 * HD9/HD10) — cùng mốc mà `account` đã chọn:
 * - `max: 4` — HD9: ~20 origin connection mỗi config (Free) là **soft limit**;
 *   nhiều isolate có thể cùng giữ pool, nên `max` nhỏ để tổng nằm dưới trần.
 * - `idleTimeoutMillis: 600_000` — HD10: Hyperdrive đóng idle connection sau
 *   10 phút; đặt ngang mốc để `pg` tự đóng connection đã chết.
 * - `connectionTimeoutMillis: 15_000` — HD10: initial connect 15s; fail nhanh
 *   thay vì treo request.
 *
 * ⚠️ `ssl` **không** đặt: Hyperdrive kết nối origin bằng TLS bắt buộc (HD2) và
 * tự quản phần đó; đặt `ssl` ở client có thể phá đúng phần đó.
 *
 * ⚠️ Chỉ dùng qua {@link createPool} ở serving path — dựng tay `new Pool(...)`
 * là bỏ qua {@link attachPoolErrorHandler}.
 */
export function buildPoolOptions(options: { connectionString: string }): {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
} {
  return {
    connectionString: options.connectionString,
    max: 4,
    idleTimeoutMillis: 600_000,
    connectionTimeoutMillis: 15_000,
  };
}

/**
 * Gắn listener `error` cho pool — **bắt buộc** với mọi pool sống qua `idle`.
 *
 * `pg-pool` phát `error` khi một idle client chết; một EventEmitter thiếu
 * listener `error` là crash isolate đúng lúc origin flapping (HD10 — cùng mốc
 * {@link buildPoolOptions}). Handler **nuốt** lỗi: `error` của idle client
 * không thuộc về request nào, không có caller để trả, và ném vào giữa handler
 * của EventEmitter là crash. Request kế tiếp lấy connection mới từ pool.
 *
 * ⚠️ Chỉ ghi **mã sự kiện cố định**, không ghi message của driver: message của
 * `pg` có thể chứa connection string — không được vào log. Đây là dòng
 * `console.*` có chủ đích duy nhất của adapter (cùng ngoại lệ với
 * `apps/account/server/utils/logger.ts`): `no-console` của `.oxlintrc.json`
 * được tắt inline ở đúng dòng này vì Workers log (`wrangler tail`) đọc được
 * dòng này.
 */
export function attachPoolErrorHandler(pool: {
  on(event: string, listener: () => void): unknown;
}): void {
  pool.on('error', () => {
    // oxlint-disable-next-line no-console
    console.log('event=db_pool_idle_client_error error_code=idle_client_error');
  });
}

/**
 * Dựng một pool cho một Hyperdrive — **đường duy nhất** production dựng pool.
 *
 * Mọi caller đi qua đây để {@link attachPoolErrorHandler} luôn được gắn.
 * ⚠️ Không giữ pool ở scope nào ngoài một request: pool sống đúng một lần gọi
 * {@link withBackofficePool} rồi `end()` — cùng nguyên tắc "no node-local
 * application state" của repo.
 */
export function createPool(hyperdrive: HyperdriveBinding): Pool {
  const pool = new Pool(buildPoolOptions({ connectionString: hyperdrive.connectionString }));
  attachPoolErrorHandler(pool);
  return pool;
}

/**
 * Dựng pool cho một request, chạy callback rồi luôn `end()` pool trong
 * `finally` — kể cả khi callback ném (bỏ điều đó là rò connection tới khi pool
 * cạn, và pool cạn là toàn bộ endpoint DB chết).
 *
 * ⚠️ Lỗi của `end()` bị **nuốt** (chỉ log mã sự kiện cố định — cùng luật với
 * {@link attachPoolErrorHandler}): `finally` mà `await` một `end()` reject là
 * lỗi gốc của callback bị thay bằng lỗi dọn dẹp — caller (route handler) thấy
 * chẩn đoán sai và lỗi thật mất. Lỗi của callback luôn là cái propagate.
 *
 * Lỗi của callback luôn bay ra khỏi hàm sau khi pool đã `end()` — không có
 * đường nào trả kết quả mà không có `throw` đi kèm.
 */
export async function withBackofficePool<T>(
  hyperdrive: HyperdriveBinding,
  callback: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = createPool(hyperdrive);
  try {
    return await callback(pool);
  } finally {
    await pool.end().catch(() => {
      // oxlint-disable-next-line no-console
      console.log('event=db_pool_end_failed error_code=pool_end_failed');
    });
  }
}

/**
 * Nguồn kết nối PostgreSQL cho container Node local (`node-server` preset) —
 * song song với Hyperdrive binding `DB_BACKOFFICE` của Workers.
 *
 * ## Vì sao có đường thứ hai
 *
 * Workers đọc connection string từ binding Hyperdrive (invariant 4: application
 * code chỉ chứa **tên** binding). Container Docker local không có Hyperdrive:
 * nó nối thẳng tới PostgreSQL của platform qua network nội bộ, và connection
 * string nằm ở `runtimeConfig` **private** (`backofficeDatabaseUrl`), được phủ
 * từ biến môi trường `NITRO_BACKOFFICE_DATABASE_URL` qua `applyEnv` của Nitro.
 *
 * ⚠️ Connection string **không** được vào `runtimeConfig.public` hay client
 * bundle hay log: key nằm ở nhánh private của `nuxt.config.ts` (không có
 * tiền tố `public`), nên Nitro không serialize nó vào payload hydrate.
 */
export function backofficeNodeDatabaseUrl(runtimeConfig: unknown): string | null {
  if (typeof runtimeConfig !== 'object' || runtimeConfig === null) {
    return null;
  }
  const value = (runtimeConfig as { backofficeDatabaseUrl?: unknown }).backofficeDatabaseUrl;
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}

/**
 * Dựng pool cho một connection string PostgreSQL trực tiếp (container Node local).
 *
 * Dùng chung {@link buildPoolOptions} và {@link attachPoolErrorHandler} với
 * đường Hyperdrive — cùng giới hạn pool và cùng listener `error` cho idle client.
 * `ssl` không đặt: kết nối trong network nội bộ của platform là plaintext
 * (TLS do Hyperdrive quản lý chỉ ở Workers).
 */
export function createNodePool(connectionString: string): Pool {
  const pool = new Pool(buildPoolOptions({ connectionString }));
  attachPoolErrorHandler(pool);
  return pool;
}
