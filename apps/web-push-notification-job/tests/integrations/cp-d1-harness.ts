/**
 * Harness D1 thật cho **control plane** (`apps/push-notification`, D1 `push`) — bản sao độc lập
 * của `apps/push-notification/tests/d1-harness.ts`, phục vụ riêng cho integration cross-plane.
 *
 * ⚠️ **Vì sao bản sao chứ không import.** Test nằm trong app job nhưng cần database của app
 * push. Import harness từ app push là một dependency chạy-test chéo **deploy unit** — cấm theo
 * bảng depConstraints (`type:composition` chỉ compose bốn type lib), và một lib nào đó làm
 * trung gian sẽ dựng vòng trên project graph. Bản sao là thứ duy nhất bắt được việc hai bên lệ
 * `wrangler.jsonc`: harness này đọc **file cấu hình thật của app push**, nên nếu control plane
 * đổi binding hay migration mà integration test không theo kịp thì test đỏ — thay vì xanh trên
 * một schema viết tay đã trôi.
 *
 * ⚠️ **D1 thật, persist: false.** Correctness của control plane dựa trên guarded conditional
 * write (`UPDATE … RETURNING` + `meta.changes`), `db.batch()` là transaction duy nhất, và
 * partial UNIQUE index — cả ba chỉ có ý nghĩa trên engine SQL thật với migration thật
 * (`apps/push-notification/tests/d1-harness.ts` mở đầu bằng đúng ba lập luận này). Proxy local
 * không có network call ra ngoài và không đụng resource Cloudflare thật.
 */

import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getPlatformProxy, unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

// Không gửi telemetri khi spawn workerd trong test — phải chạy TRƯỚC lần spawn workerd đầu
// tiên (lời gọi `getPlatformProxy` ở dưới), nhưng SAU các import để tuân `import/first`.
process.env['WRANGLER_SEND_METRICS'] = 'false';

/**
 * Thư mục migration của **app push** — neo bằng `import.meta.url` của file này, không phải cwd
 * của runner: vitest chạy với `root` là thư mục project, và điều hướng bằng `import.meta.dirname`
 * ở vị trí sai từng trỏ đường dẫn vào thư mục không tồn tại (xem `tests/integrations/d1-harness.ts`).
 */
const CP_APP_DIR = join(import.meta.dirname, '..', '..', '..', 'push-notification');

/** `wrangler.jsonc` của control plane — nguồn duy nhất cho tên binding và database. */
const CP_WRANGLER_CONFIG_PATH = join(CP_APP_DIR, 'wrangler.jsonc');

/** Thư mục migration của control plane. */
const CP_MIGRATIONS_DIR = join(CP_APP_DIR, 'migrations');

/**
 * Parse JSONC bằng `jsonc-parser` mà **nx** mang vào tree — cùng precedent với
 * `apps/push-notification/tests/d1-harness.ts`: parser JSONC tự viết chỉ lọc comment cả dòng và
 * chết ở trailing comma, còn `wrangler` chấp nhận JSONC đầy đủ.
 */
function parseJsonc(text: string): unknown {
  const requireFromNx = createRequire(
    resolve(import.meta.dirname, '../../../../node_modules/nx/package.json'),
  );
  const jsoncParse: (input: string) => unknown = requireFromNx('jsonc-parser').parse;
  return jsoncParse(text);
}

/** Đọc mọi file migration theo thứ tự tên file — prefix `0001_`/`0002_`/`0003_` là thứ tự áp. */
function readMigrations(): readonly { readonly name: string; readonly sql: string }[] {
  return (
    readdirSync(CP_MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      // ⚠️ `toSorted` chứ không `sort`: repo cấm `Array#sort` (unicorn/no-array-sort), và thứ tự
      // ở đây là tất định theo prefix tên file.
      .toSorted()
      .map((name) => ({ name, sql: readFileSync(join(CP_MIGRATIONS_DIR, name), 'utf8') }))
  );
}

/** Một statement đã tách bằng splitter của `wrangler` — đường production tách SQL cùng cách. */
interface MigrationStatement {
  readonly migration: string;
  readonly statement: string;
}

/**
 * Tách từng migration thành statement bằng `unstable_splitSqlQuery`.
 *
 * ⚠️ `db.exec` của miniflare cắt chuỗi theo `;` một cách mù và từ chối đoạn chỉ chứa comment;
 * migration của control plane có header comment dài nên `exec` cả file hỏng ngay ở header.
 * `wrangler d1 migrations apply` tách SQL **client-side** bằng hàm này, nên dùng đúng bộ tách
 * của đường production làm một comment trong migration không thể làm test đỏ trong khi
 * `migrations apply` vẫn chạy.
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
 * Tên binding D1 của control plane — đọc từ `wrangler.jsonc` thay vì hardcode `push`.
 *
 * ⚠️ Một app với hai D1 nghĩa là test chọn nhầm database; assert **một** binding giữ cho lệch
 * cấu hình trở thành lỗi ngay ở test thay vì hành vi im lặng.
 */
function readD1BindingName(): string {
  const config = parseJsonc(readFileSync(CP_WRANGLER_CONFIG_PATH, 'utf8')) as {
    d1_databases?: readonly { binding: string }[];
  };
  const first = config.d1_databases?.[0];
  if (first === undefined) {
    throw new Error('wrangler.jsonc của control plane không khai `d1_databases`.');
  }
  if ((config.d1_databases?.length ?? 0) > 1) {
    throw new Error(
      `wrangler.jsonc khai ${config.d1_databases?.length} D1; harness chỉ hỗ trợ đúng một.`,
    );
  }
  return first.binding;
}

/** Bề mặt D1 tối thiểu mà harness cần — khớp `D1DatabaseLike` của cả hai adapter. */
export interface CpPreparedStatement {
  bind(...values: unknown[]): CpPreparedStatement;
  run<T>(): Promise<{ readonly results: T[]; readonly meta: { readonly changes: number } }>;
  all<T>(): Promise<{ readonly results: T[] }>;
  first<T>(): Promise<T | null>;
}

export interface CpDatabase {
  prepare(query: string): CpPreparedStatement;
  batch<T>(
    statements: readonly CpPreparedStatement[],
  ): Promise<readonly { readonly results: T[] }[]>;
}

/** Một D1 thật của control plane, đã nạp schema từ `apps/push-notification/migrations/`. */
export interface CpTestDatabase {
  readonly db: CpDatabase;
  /** Đọc các row khớp — cho assertion trực tiếp về state của D1 `push`. */
  rows<T>(sql: string, ...bindings: readonly unknown[]): Promise<readonly T[]>;
  /** Chạy một lệnh ghi không cần kết quả. */
  run(sql: string, ...bindings: readonly unknown[]): Promise<void>;
  /** Huỷ instance workerd cục bộ — gọi trong `afterAll`. */
  dispose(): Promise<void>;
}

/**
 * Dựng D1 `push` của control plane với schema thật.
 *
 * ⚠️ Toàn bộ schema nạp trong **một** `db.batch()` — `db.batch()` là transaction duy nhất của
 * D1, nên database của test hoặc có đủ schema hoặc không có gì; lỗi schema ném ở đây và làm
 * **mọi** test đỏ bằng một thông điệp schema thay vì mỗi test đỏ bằng một assertion lệch.
 */
export async function createCpTestDatabase(): Promise<CpTestDatabase> {
  const binding = readD1BindingName();
  const proxy = await getPlatformProxy<Record<string, CpDatabase>>({
    configPath: CP_WRANGLER_CONFIG_PATH,
    persist: false,
    // Không cho binding nào của platform proxy đi ra Cloudflare thật — test chỉ được chạm D1
    // local; một binding remote vô tình được bật biến unit test thành network call trong CI.
    remoteBindings: false,
  });
  const db = proxy.env[binding];
  if (db === undefined) {
    await proxy.dispose();
    throw new Error(
      `wrangler.jsonc của control plane khai binding \`${binding}\` nhưng proxy không cấp.`,
    );
  }

  await db.batch(readMigrationStatements().map(({ statement }) => db.prepare(statement)));

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
    rows: readRows,
    run: write,
    dispose: () => proxy.dispose(),
  };
}

/* -------------------------------------------------------------------------------------- */
/* Fixture scope — dữ liệu nền cho một subscription "gửi được"                                 */
/* -------------------------------------------------------------------------------------- */

/** `app` scope duy nhất của test này — trùng `APPLICATION_API_PRINCIPAL` của env. */
export const CP_TEST_APP = 'ecoma-io';

/**
 * Endpoint trỏ **provider bị chặn**, không phải host thật: mọi request Web Push trong test đi
 * qua `globalThis.fetch` đã stub, nên giá trị này chỉ phải là một URL HTTPS hợp lệ về hình thức
 * (đủ để sender parse, build `aud` của VAPID) — không một byte nào rời máy.
 */
export const CP_TEST_ENDPOINT = 'https://push.example-fcm.invalid/fcm/send/abc123XYZ';

/**
 * Cặp material client Web Push **thật** (P-256) — fixture đóng băng, không thuộc môi trường nào.
 *
 * ⚠️ Sender **thật** mã hoá payload bằng `p256dh`/`auth` này (RFC 8291); một chuỗi placeholder
 * làm `encryptPushPayload` ném và sender phân loại thành `transient` before-send — tức test vẫn
 * "xanh" mà không một byte nào được mã hoá. Fixture phải là điểm EC P-256 thật 65 byte để đường
 * mã hoá chạy hoàn chỉnh trong test.
 */
export const CP_TEST_P256DH =
  'BL9m6DmDEzo8fntKX1g3g2ngEnU3foRVlKpgVrphp2ybWJrOxQ-UQuh0KEYkRvYDHD2MUyC5scA7nAFsQXQHXPk';
export const CP_TEST_AUTH = '_q2OtNUNx4PKMWjjjXKB-Q'; // gitleaks:allow (fake secret trong test)

/** Định danh của mọi thực thể mà `seedCpScope` tạo — hậu tố `-<app>` khi app khác mặc định. */
export interface CpSeededScope {
  readonly app: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly subscriptionId: string;
  readonly providerId: string;
  readonly vapidKeyId: string;
}

/**
 * Seed một scope đủ để `POST /v1/notifications` route thành công tới delivery: device +
 * subscription `active` + provider `web-push` `enabled` + primary mapping + routing policy.
 *
 * ⚠️ **Không** seed notification/delivery/outbox: ba thực thể đó là **kết quả** của use case
 * `createNotification`, và toàn bộ điểm của golden path cross-plane là chứng minh use case đó
 * tạo chúng đúng trên D1 thật. Seed sẵn sẽ che chính đường cần kiểm.
 *
 * ⚠️ **Không** seed credential: credential đúng phải là ciphertext thật của VAPID private key
 * (mã hoá bằng cipher K1 thật) — control plane **giải mã** nó khi claim, và payload rác khiến
 * claim trả `409 terminal` fail-closed thay vì material. Spec seed credential riêng bằng
 * `seedEncryptedCredential` sau khi biết cặp khoá VAPID của kịch bản.
 *
 * ⚠️ Thời gian: **đồng hồ thật** — composition root dùng `Date.now()` và không có seam đồng hồ,
 * nên mọi `expires_at`/`available_at` sinh trong use case lấy mốc thật; fixture không cần (và
 * không được) ghim T0 nào.
 */
export async function seedCpScope(
  testDb: CpTestDatabase,
  options: { readonly app?: string } = {},
): Promise<CpSeededScope> {
  const app = options.app ?? CP_TEST_APP;
  const suffix = app === CP_TEST_APP ? '' : `-${app}`;
  const userId = `user${suffix}`;
  const deviceId = `device${suffix}`;
  const subscriptionId = `sub${suffix}`;
  const providerId = `prov${suffix}`;
  const vapidKeyId = `vapid-k1${suffix}`;
  const now = Date.now();

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
         VALUES (?, ?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
      )
      .bind(
        subscriptionId,
        deviceId,
        userId,
        app,
        CP_TEST_ENDPOINT,
        `hash-${app}`,
        CP_TEST_P256DH,
        CP_TEST_AUTH,
        vapidKeyId,
        providerId,
        now,
        now,
      ),
    testDb.db
      .prepare(
        `INSERT INTO push_providers
           (provider_id, app, transport, type, name, configuration_json, status, emergency_hold,
            created_at, updated_at)
         VALUES (?, ?, 'web', 'web-push', ?, ?, 'enabled', 0, ?, ?)`,
      )
      .bind(
        providerId,
        app,
        `provider${suffix}`,
        JSON.stringify({ subject: 'mailto:ops@ecoma.io' }),
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
  ]);
  // Routing policy: không có row thì routing dùng default tài liệu; seed tường minh để test
  // không phụ thuộc một default nào có thể đổi — và `transport_priority` khớp cách `App` thật
  // cấu hình: ưu tiên transport của app trước, `web` là transport duy nhất của scope này.
  await testDb.run(
    `INSERT INTO push_routing_policy (app, transport_priority, max_deliveries_per_notification, created_at, updated_at)
     VALUES (?, 'app,web', 100, ?, ?)`,
    app,
    now,
    now,
  );

  return { app, userId, deviceId, subscriptionId, providerId, vapidKeyId };
}
