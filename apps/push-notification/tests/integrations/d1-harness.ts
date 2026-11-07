/**
 * Harness cho test D1 thật của `push-notification`.
 *
 * ⚠️ **Vì sao D1 thật chứ không phải SQLite in-memory hay một fake.** Toàn bộ thiết kế của
 * service dựa trên ba cơ chế mà **chỉ** engine SQL thật mới chứng minh được:
 *
 * 1. **Guarded conditional write**: `UPDATE … RETURNING` trả **zero rows** khi predicate
 *    không khớp. Đây là cơ chế duy nhất quyết định thắng/thua của claim, của release/outcome
 *    và của outbox claim — `meta.changes` là điểm quyết định, không có read-then-write ở đâu.
 * 2. **`db.batch()` là transaction duy nhất** (không `BEGIN`/`COMMIT`, không row locking —
 *    `docs/architecture/04-platform-facts.md` DB2/DB11). Một fake sẽ cho ta một transaction giả
 *    và che mất việc một lệnh trong batch đang vi sai.
 * 3. **Partial UNIQUE index** (`push_outbox_one_open_intent`, `push_app_provider_mappings_one_primary`)
 *    là guard chống dồn intent và chống hai primary. Một fake không có index nên không thể
 *    chứng minh index có *thật* và có đúng predicate.
 *
 * Vì vậy test chạy trên một D1 **thật** của `wrangler` qua `getPlatformProxy` với
 * `persist: false`: không có network call ra ngoài, không đụng resource Cloudflare thật.
 *
 * ⚠️ **Schema được nạp từ `migrations/*.sql` thật**, không viết lại trong test. Một schema
 * viết tay trong test là một schema có thể trôi khỏi migration, và mọi assertion về guard
 * rồi kiểm tra một thứ không tồn tại trong production.
 */

import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getPlatformProxy, unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

import { rootKeyCipherK1 } from './credential-root-key';
import { vapidTestKeyPair } from './vapid-test-keys';

/**
 * Thư mục `migrations/` của app — nằm cạnh `src/`, **đọc từ file thật**, không viết lại schema
 * trong test.
 *
 * ⚠️ **Vì sao harness nằm trong `tests/` của app chứ không phải trong lib nào.** Nx suy ra
 * task-graph edge từ **import thật**, và chiều phụ thuộc đúng là `infrastructure →
 * application` (infrastructure hiện thực interface của application). Đặt harness vào một lib
 * rồi cho lib khác import nó sẽ dựng vòng và `run-many` dừng với `circular dependency`. App là
 * nơi **duy nhất** được phép biết cả hai tầng dưới — nó là composition root — nên đây là nơi
 * duy nhất mà một test harness dùng chung cho cả hai tầng không tạo vòng.
 *
 * ⚠️ Chiều này cũng là lý do exemption của `.oxlintrc.json` cho `tests` bên trong app tồn tại:
 * harness chạy trên Node runner (Vitest) nên được phép `node:fs`/`node:path`, và nó đọc file
 * thật để assert trên schema của production thay vì trên một schema viết tay trong test.
 */
const APP_DIR = join(import.meta.dirname, '..', '..');

/** Thư mục migration — nằm cạnh `src/` của app. */
const MIGRATIONS_DIR = join(APP_DIR, 'migrations');

/** `wrangler.jsonc` của app: nguồn **duy nhất** cho tên binding và database. */
const WRANGLER_CONFIG_PATH = join(APP_DIR, 'wrangler.jsonc');

/**
 * Parse JSONC bằng `jsonc-parser` mà **nx** đã mang vào tree.
 *
 * ⚠️ **Vì sao không tự bóc comment rồi `JSON.parse`.** Bản bóc-comment đầu tiên của file này
 * chỉ lọc comment trên **cả dòng**, và nó chạy xanh với một `wrangler.jsonc` không có comment
 * cuối dòng — rồi đỏ ngay khi file thật có `"observability": { "enabled": true, }`. Trailing
 * comma là JSONC hợp lệ và `wrangler` chấp nhận nó, nên một parser JSONC tự viết sẽ luôn kém
 * hơn parser thật: nó bỏ sót **đúng** những cấu hình hợp lệ mà production dùng.
 *
 * ⚠️ **Không thêm dependency mới.** `jsonc-parser` là dependency gián tiếp của `nx`, và
 * `tools/dx/src/architecture/arch-tags.spec.ts` đã dùng đúng cách này để đọc `.oxlintrc.json` (JSONC).
 * Truy qua `createRequire` từ context của `nx` giữ đúng precedent đó.
 */
function parseJsonc(text: string): unknown {
  const requireFromNx = createRequire(
    resolve(import.meta.dirname, '../../../../node_modules/nx/package.json'),
  );
  const jsoncParse: (input: string) => unknown = requireFromNx('jsonc-parser').parse;
  return jsoncParse(text);
}

/**
 * Danh sách migration theo thứ tự áp dụng, mỗi phần tử là **một statement** kèm tên file gốc.
 *
 * ⚠️ **Thứ tự là `sorted()` trên tên file** chứ không phải thứ tự khai trong một manifest: prefix
 * `0001_`/`0002_`/`0003_` chính là thứ tự áp dụng, và thêm file mới không cần sửa danh sách ở
 * đây. Đây là điểm khác biệt thật với một danh sách cứng.
 */
function readMigrations(): readonly { readonly name: string; readonly sql: string }[] {
  return (
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      // ⚠️ `toSorted` chứ không `sort`: `unicorn/no-array-sort` của repo cấm `Array#sort`, và
      // ở đây thứ tự là **tất định theo spec** (prefix `0001_`/`0002_`/`0003_` chính là thứ tự
      // áp dụng) nên phải giữ, không thể bỏ. `toSorted` chỉ có trong `lib` es2023 — cấu hình
      // `lib` của chính `tsconfig.spec.json` này đã nâng lên, đúng precedent của
      // `apps/auth/tsconfig.spec.json`; `tsconfig.base.json` toàn repo giữ nguyên `es2022`.
      // `target` vẫn là `es2022` nên không phát sinh cú pháp mới trong output.
      .toSorted()
      .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }))
  );
}

/** Một statement đã tách, kèm file gốc để thông điệp lỗi nói đúng chỗ hỏng. */
interface MigrationStatement {
  readonly migration: string;
  readonly statement: string;
}

/**
 * Tách mọi migration thành từng statement bằng **chính splitter của `wrangler`**.
 *
 * ⚠️ **Vì sao không `db.exec(cả file)`.** `db.exec` của miniflare **không** hiểu comment SQL:
 * nó cắt chuỗi theo `;` một cách mù và từ chối bất kỳ đoạn nào chỉ chứa comment
 * (`SQL code did not contain a statement`). Migration của app này có header comment dài —
 * đúng thứ tài liệu yêu cầu — nên `exec` cả file hỏng ngay ở header.
 *
 * ⚠️ **Vì sao đây KHÔNG phải một bug của migration.** `wrangler d1 migrations apply` tách SQL
 * **client-side** bằng `unstable_splitSqlQuery`, và hàm đó có máy trạng thái hiểu comment
 * `--`, comment khối, và quote `'`. Tức đường **production** xử lý comment đúng; chỉ `exec` của
 * miniflare không có máy trạng thái. Test dùng đúng bộ tách của đường production, nên một comment trong migration không
 * thể làm test đỏ trong khi `migrations apply` vẫn chạy — và ngược lại.
 *
 * ⚠️ `unstable_*` là bề mặt chưa ổn định của wrangler, và đây là lý do file này **bỏ hẳn**
 * việc tự viết một bộ tách: một bộ tách tự viết sẽ phải lặp lại máy trạng thái của wrangler
 * (comment, quote, escape) và sẽ trôi khỏi nó. Nếu wrangler đổi hành vi, test đỏ — và đó là
 * tín hiệu đúng, vì lúc đó đường production đã đổi theo.
 */
function readMigrationStatements(): readonly MigrationStatement[] {
  const statements: MigrationStatement[] = [];
  for (const { name, sql } of readMigrations()) {
    for (const statement of splitSqlQuery(sql)) {
      statements.push({ migration: name, statement });
    }
  }
  return statements;
}

/**
 * Tên binding D1 trong `wrangler.jsonc`.
 *
 * ⚠️ Đọc từ file cấu hình thay vì hardcode `push`: đây là điểm mà test và deployment lệch nhau
 * thì mọi test D1 vẫn xanh (chạy trên một database khác) trong khi production không có dữ
 * liệu. Đọc từ cùng một file làm cho lệch đó thành lỗi ngay ở test.
 */
function readD1BindingName(): string {
  const config = parseJsonc(readFileSync(WRANGLER_CONFIG_PATH, 'utf8')) as {
    d1_databases?: readonly { binding: string; database_name: string }[];
  };
  const first = config.d1_databases?.[0];
  if (first === undefined) {
    throw new Error(
      'wrangler.jsonc không khai `d1_databases` — test không biết dùng database nào.',
    );
  }
  // ⚠️ Assert **một** binding: một app với hai D1 nghĩa là test chọn nhầm database và mọi
  // assertion vẫn xanh trong khi chạy trên storage không phải storage của control plane.
  if ((config.d1_databases?.length ?? 0) > 1) {
    throw new Error(
      `wrangler.jsonc khai ${config.d1_databases?.length} D1; test chỉ hỗ trợ đúng một.`,
    );
  }
  return first.binding;
}

/** Bề mặt D1 tối thiểu mà harness cần — `exec` không nằm trong `D1DatabaseLike` của lib. */
export interface HarnessPreparedStatement {
  bind(...values: unknown[]): HarnessPreparedStatement;
  run<T>(): Promise<{ readonly results: T[]; readonly meta: { readonly changes: number } }>;
  all<T>(): Promise<{ readonly results: T[] }>;
  first<T>(): Promise<T | null>;
}

export interface HarnessDatabase {
  prepare(query: string): HarnessPreparedStatement;
  exec(query: string): Promise<unknown>;
  batch<T>(
    statements: readonly HarnessPreparedStatement[],
  ): Promise<readonly { readonly results: T[] }[]>;
}

/** Một D1 thật, đã nạp schema, cùng đường dẫn tới D1DatabaseLike của adapter. */
export interface TestDatabase {
  readonly db: HarnessDatabase;
  /**
   * Bọc `db` bằng bộ đếm lệnh — dùng cho test chứng minh một thứ **không** chạm D1 (ví dụ
   * `401` trước lookup). Xem `countQueries`.
   */
  readonly probe: QueryProbe & { readonly database: HarnessDatabase };
  /** Đọc một bảng thành mảng object — cho assertion trực tiếp về state của D1. */
  rows<T>(sql: string, ...bindings: readonly unknown[]): Promise<readonly T[]>;
  /** Đếm số row khớp — cho assertion về guard (index, unique constraint). */
  count(sql: string, ...bindings: readonly unknown[]): Promise<number>;
  /** Chạy một lệnh ghi không cần kết quả. */
  run(sql: string, ...bindings: readonly unknown[]): Promise<void>;
  /** Huỷ instance workerd cục bộ của database này — gọi trong `afterEach` (06-testing.md §6). */
  dispose(): Promise<void>;
}

/**
 * Dựng một D1 thật với schema của `migrations/` đã áp dụng.
 *
 * ⚠️ Mỗi lần gọi tạo một database **riêng**: `getPlatformProxy` với `persist: false` trả một
 * instance mới mỗi lần, nên test này cô lập hoàn toàn với test khác và có thể chạy song song
 * mà không cần reset chung. Đổi lại caller **phải** gọi `dispose` (trong `afterEach`) — mỗi
 * instance là một tiến trình workerd; không huỷ là rò tiến trình suốt lần chạy.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const binding = readD1BindingName();
  const proxy = await getPlatformProxy<Record<string, HarnessDatabase>>({
    configPath: WRANGLER_CONFIG_PATH,
    persist: false,
    // ⚠️ `remoteBindings: false` — không cho phép bất kỳ binding nào của platform proxy đi
    // ra Cloudflare thật. Test này chỉ được chạm D1 local; một binding remote vô tình được
    // bật sẽ biến một "unit test" thành một network call trong CI.
    remoteBindings: false,
  });
  const db = proxy.env[binding];
  if (db === undefined) {
    await proxy.dispose();
    throw new Error(`wrangler.jsonc khai binding \`${binding}\` nhưng proxy không cấp binding đó.`);
  }

  // ⚠️ `batch` — **không** `exec` từng statement: `db.batch()` là transaction duy nhất của
  // D1 (`docs/architecture/04-platform-facts.md` DB2), và áp toàn bộ schema trong **một** batch
  // nghĩa là database của test hoặc có đủ schema hoặc không có gì. Lỗi schema ném ở đây và
  // làm **mọi** test đỏ bằng một thông điệp schema, thay vì mỗi test đỏ bằng một assertion
  // không liên quan — đó là hành vi ta muốn.
  await db.batch(readMigrationStatements().map(({ statement }) => db.prepare(statement)));

  /** Đọc một bảng — hàm riêng thay vì `this.rows` (xem ghi chú bên dưới). */
  const readRows = async <T>(
    sql: string,
    ...bindings: readonly unknown[]
  ): Promise<readonly T[]> => {
    const statement = bindings.length > 0 ? db.prepare(sql).bind(...bindings) : db.prepare(sql);
    const result = await statement.all<T>();
    return result.results;
  };
  const write = async (sql: string, ...bindings: readonly unknown[]): Promise<void> => {
    const statement = bindings.length > 0 ? db.prepare(sql).bind(...bindings) : db.prepare(sql);
    await statement.run();
  };

  return {
    db,
    probe: countQueries(db),
    rows: readRows,
    // ⚠️ `getPlatformProxy` khởi động một instance workerd riêng cho mỗi lần gọi, và harness
    // trước đây không bao giờ trả proxy về cho caller — tức mỗi `createTestDatabase` để lại
    // một workerd không được huỷ, và một file suite với N test là N instance sống đến hết
    // lần chạy. `dispose` bọc `proxy.dispose()` để suite tự dọn trong `afterEach`
    // (06-testing.md §6: suite tự dọn sau khi chạy), đúng mô hình `dispose` của
    // `tests/integrations/d1-harness.ts` của `web-push-notification-job`.
    dispose: () => proxy.dispose(),
    // ⚠️ Không dùng `this.rows`: một object literal trả về từ hàm được TypeScript suy rộng
    // thành `TestDatabase | PromiseLike<TestDatabase>` ở vị trí có kiểu context, và `this` mất
    // kiểu. Gọi hàm cục bộ `readRows` là cách đúng và tránh được cả việc đó.
    async count(sql: string, ...bindings: readonly unknown[]): Promise<number> {
      const rows = await readRows<{ n: number }>(sql, ...bindings);
      return rows[0]?.n ?? 0;
    },
    run: write,
  };
}

/* -------------------------------------------------------------------------------------- */
/* Query probe — quan sát "có chạm D1 không"                                                    */
/* -------------------------------------------------------------------------------------- */

/**
 * Bộ đếm câu lệnh D1 đã đi qua binding.
 *
 * ⚠️ **Vì sao cần một probe thay vì suy luận.** Yêu cầu "`401` **trước** mọi lookup" (§8.1) là
 * một khẳng định về **thứ tự**, và thứ tự không nhìn thấy được từ response: một route xác thực
 * sau khi đã `SELECT` vẫn trả đúng `401` với đúng body. Chỉ một cách đo được nó — đếm số câu
 * lệnh thật sự tới D1. Đây là một `Proxy` chứ không phải một fake: nó **bọc** D1 thật và đếm,
 * nên mọi hành vi của engine (index, `RETURNING`, `meta.changes`) còn nguyên.
 *
 * ⚠️ **Đếm cả `exec` lẫn `prepare`.** `prepare` không có side effect, nhưng đếm nó giữ probe
 * trung thực nếu một repository sau này chuẩn bị statement rồi bỏ không dùng — đó vẫn là một
 * lần chạm storage, và `sqlite_master` của D1 local có thể được cache, nên chỉ đếm `exec`/
 * `run`/`all`/`first` sẽ bỏ sót một lần chạm.
 */
export interface QueryProbe {
  /** Số lệnh đã **thực thi** (`run`/`all`/`first`/`exec`) kể từ lần `reset`. */
  executed(): number;
  /** Số lần `prepare` kể từ lần `reset` — kể cả statement chưa chạy. */
  prepared(): number;
  /** Số `batch()` kể từ lần `reset` — một batch là **một** transaction, không phải N lệnh. */
  batches(): number;
  /** Đặt lại cả ba bộ đếm. */
  reset(): void;
}

/**
 * Bọc một D1 thật bằng probe đếm lệnh.
 *
 * ⚠️ Dùng `Proxy` thay vì một object viết tay vì `Proxy` giữ nguyên **mọi** thứ khác của D1:
 * một object viết tay phải liệt kê `exec`/`dump`/`withSession`/… và sẽ âm thầm làm hỏng
 * một test theo đúng cách nó hỏng — bằng cách thiếu method. `get` bắt mọi thuộc tính, trả về
 * chính nó cho hàm không cần đếm, và chỉ chèn đếm vào bốn method thực thi.
 */
export function countQueries(
  db: HarnessDatabase,
): QueryProbe & { readonly database: HarnessDatabase } {
  let executed = 0;
  let prepared = 0;
  let batched = 0;

  /**
   * Bọc **mọi** statement, kể cả statement mà `bind()` trả về.
   *
   * ⚠️ **Đây là chỗ bản đầu tiên của probe hỏng, và nó hỏng theo cách nguy hiểm nhất.** `bind()`
   * của D1 trả một statement **mới**, không sửa statement cũ. Bản đầu chỉ bọc giá trị trả về
   * của `prepare`, nên `prepare(...).bind(...).all()` gọi `all()` trên một statement **không
   * được bọc** — và `executed` vẫn bằng 0. Mọi khẳng định "0 lệnh" ở trên lúc đó đều **xanh sai**.
   *
   * Vì vậy `bind` ở đây bọc kết quả của nó, và việc kiểm chứng là hai test `touches D1` ở
   * `tests/auth-boundary.spec.ts` — chúng là hàng rào chống lại đúng lớp lỗi này, chứ không
   * phải một chi tiết phụ.
   */
  const wrapStatement = (statement: HarnessPreparedStatement): HarnessPreparedStatement =>
    new Proxy<HarnessPreparedStatement>(statement, {
      get(source, property, receiver) {
        if (property === 'bind') {
          // ⚠️ `bind()` phải bọc **kết quả của nó**, không trả statement thô. Đây là chỗ
          // bản đầu tiên của probe hỏng, và nó hỏng theo cách nguy hiểm nhất: mọi repository
          // đều `prepare(sql).bind(...).all()`, nên probe trả `0` cho **mọi** request — kể cả
          // những cái đã xác thực và đã đọc D1 thật. Mọi khẳng định "0 lệnh" ở trên lúc đó đều
          // **xanh sai**: chúng đang đo một probe không đếm gì.
          return (...args: readonly unknown[]): HarnessPreparedStatement =>
            wrapStatement(source.bind(...args));
        }
        if (property === 'run' || property === 'all' || property === 'first') {
          const original = Reflect.get(source, property, receiver) as (
            ...values: readonly unknown[]
          ) => unknown;
          return (...args: readonly unknown[]): unknown => {
            executed += 1;
            return Reflect.apply(original, source, args);
          };
        }
        const value = Reflect.get(source, property, receiver);
        // ⚠️ Method khác (vd `raw`) phải giữ `this` là **statement thật**, không phải proxy —
        // `Reflect.apply` với `receiver` sẽ khiến một method nào đó nhận `this` là proxy.
        return typeof value === 'function' ? value.bind(source) : value;
      },
    });

  const database: HarnessDatabase = new Proxy(db, {
    get(source, property, receiver) {
      if (property === 'prepare') {
        return (query: string): HarnessPreparedStatement => {
          prepared += 1;
          return wrapStatement(source.prepare(query));
        };
      }
      if (property === 'batch' || property === 'exec') {
        const original = Reflect.get(source, property, receiver) as (
          ...values: readonly unknown[]
        ) => unknown;
        return (...args: readonly unknown[]): unknown => {
          if (property === 'batch') {
            batched += 1;
          } else {
            executed += 1;
          }
          return Reflect.apply(original, source, args);
        };
      }
      return Reflect.get(source, property, receiver);
    },
  }) as HarnessDatabase;

  return {
    database,
    executed: () => executed,
    prepared: () => prepared,
    batches: () => batched,
    reset: () => {
      executed = 0;
      prepared = 0;
      batched = 0;
    },
  };
}

/* -------------------------------------------------------------------------------------- */
/* Fixture D1 — dữ liệu nền cho các test khác                                                   */
/* -------------------------------------------------------------------------------------- */

/** Mốc thời gian cố định cho mọi fixture — một hằng, không phải `Date.now()`. */
export const T0 = 1_800_000_000_000;

/** `app` scope duy nhất dùng trong test. */
export const APP = 'ecoma-io';

/** `App` thứ hai — dùng để chứng minh FR-001 (namespace) và chống dùng chéo app (FR-007). */
export const OTHER_APP = 'other-app';

/** Endpoint hợp lệ của Browser Push Service (FR-003 — host trong allowlist mặc định). */
export const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123XYZ';

/** Fixture trả về — định danh của mọi thực thể mà `seedScope` tạo. */
export interface SeededScope {
  readonly app: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly subscriptionId: string;
  readonly providerId: string;
  readonly vapidKeyId: string;
  readonly notificationId: string;
  readonly deliveryId: string;
}

/**
 * Seed một scope đầy đủ: device + subscription `active` + provider `enabled` + primary
 * mapping + routing policy + credential `active` + notification + delivery `pending`.
 *
 * ⚠️ **Credential seed là một provider credential CÓ THẬT**: private key VAPID P-256 derive
 * lúc chạy (`vapid-test-keys.ts`), mã hoá bằng root key `K1` của **composition root**
 * (`credential-root-key.ts`) và version ghi trên record là `K1` — đúng version trong keyring
 * của app. Cổng chặn enable (`checkEnablePreconditions`) giải mã credential này, nên một
 * fixture không giải mã được là một fixture **không đại diện** một provider đang phục vụ.
 *
 * @param options.app Scope cần seed; mặc định `APP`.
 * @param options.subscriptionStatus Cho phép tạo một subscription `disabled` để test
 *   eligibility (bảng a `ineligible_subscription` của §8.1).
 * @param options.emergencyHold Đặt provider vào emergency hold — kiểm tra eligibility
 *   (`ineligible_provider_hold`) mà **không** đụng `status`.
 * @param options.providerStatus Trạng thái provider; mặc định `enabled`.
 * @param options.withPolicy `false` để không seed `push_routing_policy` — dùng để chứng minh
 *   một `App` không có policy thì dùng mặc định tài liệu thay vì lỗi.
 */
export async function seedScope(
  testDb: TestDatabase,
  options: {
    readonly app?: string;
    readonly subscriptionStatus?: 'active' | 'disabled';
    readonly emergencyHold?: boolean;
    readonly providerStatus?: 'enabled' | 'disabled';
    readonly withPolicy?: boolean;
    readonly now?: number;
  } = {},
): Promise<SeededScope> {
  const app = options.app ?? APP;
  const now = options.now ?? T0;
  const suffix = app === APP ? '' : `-${app}`;
  const userId = `user${suffix}`;
  const deviceId = `device${suffix}`;
  const subscriptionId = `sub${suffix}`;
  const providerId = `prov${suffix}`;
  const vapidKeyId = `vapid-k1${suffix}`;
  const notificationId = `notif${suffix}`;
  const deliveryId = `deliv${suffix}`;
  const subscriptionStatus = options.subscriptionStatus ?? 'active';
  const providerStatus = options.providerStatus ?? 'enabled';

  // ⚠️ **Credential seed phải là ciphertext THẬT, mã hoá bằng đúng root key mà app đang
  // chạy** (`PUSH_CREDENTIAL_ROOT_KEY_K1` của `app-env.ts`) và mang đúng **version** `K1`.
  //
  // Lý do: cổng chặn enable của provider (`checkEnablePreconditions`) **giải mã** credential
  // `active` trước khi cho `disabled → enabled`. Một fixture với ciphertext rác (bản đầu là
  // `new Uint8Array([1, 2, 3, 4])` — ngắn hơn IV 12 byte của AES-GCM, và version `'k1'` viết
  // thường trong khi keyring khai `K1`) khiến **mọi** lời gọi enable trả
  // `credential_decryption_failed` — một fixture sai làm đỏ test bằng lý do không liên quan.
  //
  // ⚠️ `encrypt` là **async** còn `db.batch()` nhận statement đã bind sẵn, nên phần mã hoá
  // chạy **trước** batch và ciphertext/version được bind vào statement.
  const keyPair = await vapidTestKeyPair(app);
  const sealedCredential = await rootKeyCipherK1().encrypt(keyPair.privateKeyDerBase64Url);

  await testDb.db.batch([
    testDb.db
      .prepare(
        `INSERT INTO devices (device_id, user_id, app, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(deviceId, userId, app, now, now),
    testDb.db
      .prepare(
        `INSERT INTO push_subscriptions
           (subscription_id, device_id, user_id, app, transport, endpoint, endpoint_hash,
            p256dh, auth, vapid_key_id, provider_id, status, disabled_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        subscriptionId,
        deviceId,
        userId,
        app,
        ENDPOINT,
        `hash-${app}`,
        `p256dh-${app}`,
        `auth-${app}`,
        vapidKeyId,
        providerId,
        subscriptionStatus,
        // CHECK `status_reason_parity` bắt buộc: `active` ⇔ không lý do, còn lại thì có.
        subscriptionStatus === 'active' ? null : 'admin_disable',
        now,
        now,
      ),
    testDb.db
      .prepare(
        `INSERT INTO push_providers
           (provider_id, app, transport, type, name, configuration_json, status, emergency_hold,
            created_at, updated_at)
         VALUES (?, ?, 'web', 'web-push', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        providerId,
        app,
        `provider${suffix}`,
        JSON.stringify({ subject: 'mailto:ops@ecoma.io' }),
        providerStatus,
        options.emergencyHold === true ? 1 : 0,
        now,
        now,
      ),
    testDb.db
      .prepare(
        `INSERT INTO push_app_provider_mappings
           (mapping_id, app, transport, provider_id, is_primary, created_at, updated_at)
         VALUES (?, ?, 'web', ?, 1, ?, ?)`,
      )
      .bind(`map${suffix}`, app, providerId, now, now),
    testDb.db
      .prepare(
        `INSERT INTO push_provider_credentials
           (credential_id, provider_id, app, vapid_key_id, public_key, credential_ciphertext,
            credential_encryption_version, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(
        `cred${suffix}`,
        providerId,
        app,
        vapidKeyId,
        `public-${app}`,
        sealedCredential.ciphertext,
        sealedCredential.version,
        now,
        now,
      ),
    testDb.db
      .prepare(
        `INSERT INTO push_notifications
           (notification_id, app, principal_id, payload_json, payload_bytes, expires_at,
            created_at, updated_at)
         VALUES (?, ?, 'principal-1', ?, ?, ?, ?, ?)`,
      )
      .bind(
        notificationId,
        app,
        JSON.stringify({ title: 't', body: 'b' }),
        24,
        now + 3_600_000,
        now,
        now,
      ),
    testDb.db
      .prepare(
        `INSERT INTO push_deliveries
           (delivery_id, notification_id, subscription_id, provider_id, user_id, device_id, app,
            transport, status, dispatch_generation, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'web', 'pending', 0, ?, ?, ?)`,
      )
      .bind(
        deliveryId,
        notificationId,
        subscriptionId,
        providerId,
        userId,
        deviceId,
        app,
        now + 3_600_000,
        now,
        now,
      ),
  ]);

  if (options.withPolicy !== false) {
    await testDb.run(
      `INSERT INTO push_routing_policy (app, transport_priority, max_deliveries_per_notification, created_at, updated_at)
       VALUES (?, 'app,web', 100, ?, ?)`,
      app,
      now,
      now,
    );
  }

  return {
    app,
    userId,
    deviceId,
    subscriptionId,
    providerId,
    vapidKeyId,
    notificationId,
    deliveryId,
  };
}

/** Đưa một delivery về `queued` — trạng thái mà claim predicate chấp nhận. */
export async function markDeliveryQueued(
  testDb: TestDatabase,
  deliveryId: string,
  now = T0,
): Promise<void> {
  await testDb.run(
    `UPDATE push_deliveries SET status = 'queued', updated_at = ? WHERE delivery_id = ?`,
    now,
    deliveryId,
  );
}
