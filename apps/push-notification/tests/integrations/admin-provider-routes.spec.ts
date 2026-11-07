/**
 * Functional tests của Admin API provider lifecycle — create, update, enable/disable,
 * hold/release, rotate-credential, logical revoke (FR-005, FR-006, FR-017, FR-018, FR-020).
 *
 * ⚠️ **Vì sao file này tồn tại.** `auth-boundary.spec.ts` chỉ đo "401 trước lookup" của các
 * route admin; hành vi **sau** boundary — đúng transition, đúng audit event, đúng invariant
 * primary/retire — phải được đo bằng request đã xác thực đi qua `worker.fetch` thật, đọc lại
 * D1 sau mỗi request. Không có file này thì FR-017/FR-020 có implementation nhưng không có
 * test tương ứng, vi phạm chính DoD của task.
 *
 * ⚠️ **`provider_id` và `credential_id` do server sinh** (`deps.ids.next()`): caller không
 * gửi ID trong body, nên test đọc ID từ response JSON thay vì đoán trước.
 *
 * ⚠️ **Route `/test` (FR-018) không nằm ở đây.** Probe của control plane cố ý luôn trả
 * `configuration_invalid` (CP không có provider SDK — xem comment trong `main.ts`); hành vi
 * đó là hằng số đã ghim ở use-case level trong `admin-provider.ts`, một test HTTP chỉ lặp lại
 * hằng số đó. Mọi route còn lại của lifecycle có hành vi state thật trên D1 nên đo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetConfigCacheForTest } from '../../src/config';

import { callRoute } from './app-env';
import { APP, createTestDatabase, seedScope, type TestDatabase } from './d1-harness';
import { vapidTestKeyPair } from './vapid-test-keys';

/** Header của một caller Admin API đã xác thực — cùng token với `app-env.ts`. */
function adminHeaders(): Record<string, string> {
  return { authorization: 'Bearer admin-token', 'content-type': 'application/json' };
}

interface ProviderRow {
  readonly provider_id: string;
  readonly app: string;
  readonly status: string;
  readonly emergency_hold: number;
}

function readProvider(db: TestDatabase, providerId: string): Promise<ProviderRow | undefined> {
  return db
    .rows<ProviderRow>(
      'SELECT provider_id, app, status, emergency_hold FROM push_providers WHERE provider_id = ?',
      providerId,
    )
    .then((rows) => rows[0]);
}

/** Audit event của một entity, theo thứ tự ghi — seedScope không ghi audit nên khởi tạo rỗng. */
async function readAuditEvents(db: TestDatabase, entityId: string): Promise<string[]> {
  const rows = await db.rows<{ event: string }>(
    'SELECT event FROM audit_records WHERE entity_id = ? ORDER BY recorded_at',
    entityId,
  );
  return rows.map((row) => row.event);
}

/** Audit event theo tên — cho path mà entity ID do server sinh (rotation). */
async function readAuditByEvent(
  db: TestDatabase,
  event: string,
): Promise<readonly { detail_json: string }[]> {
  return db.rows<{ detail_json: string }>(
    'SELECT detail_json FROM audit_records WHERE event = ? ORDER BY recorded_at',
    event,
  );
}

/** Tạo một provider mới qua API và trả ID do server sinh. */
async function createProvider(db: TestDatabase, name: string): Promise<string> {
  const response = await callRoute(db, '/admin/v1/providers', adminHeaders(), {
    method: 'POST',
    body: {
      app: APP,
      name,
      configuration: { subject: 'mailto:ops@ecoma.io' },
      transport: 'web',
      type: 'web-push',
    },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { providerId: string };
  return body.providerId;
}

/**
 * Rotate một credential VAPID **thật** lên provider, qua đúng đường vận hành
 * (`POST /admin/v1/providers/:id/rotate-credential`).
 *
 * ⚠️ **Vì sao phải qua API thay vì ghi thẳng D1.** Cổng chặn enable giải mã credential đọc
 * từ D1, nên một credential ghi tay mà không mã hoá bằng root key của app sẽ không giải mã
 * được. Đường thật dùng cipher của composition root, nên credential sinh ra **chắc chắn** đọc
 * được — đó là điều một fixture "xanh giả" không đảm bảo được.
 *
 * @param label Nhãn biến thể của cặp khoá — cặp khác label là cặp khác hoàn toàn.
 */
async function rotateCredential(
  db: TestDatabase,
  providerId: string,
  vapidKeyId: string,
  options: { readonly label?: string; readonly retireVapidKeyId?: string | null } = {},
): Promise<Response> {
  const keyPair = await vapidTestKeyPair(options.label ?? 'default');
  return callRoute(db, `/admin/v1/providers/${providerId}/rotate-credential`, adminHeaders(), {
    method: 'POST',
    body: {
      app: APP,
      vapid_key_id: vapidKeyId,
      public_key: keyPair.publicPointBase64Url,
      private_key: keyPair.privateKeyDerBase64Url,
      retire_vapid_key_id: options.retireVapidKeyId ?? null,
    },
  });
}

describe('POST /admin/v1/providers — create (FR-005, §6.1)', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('creates a provider in disabled status and audits provider_created', async () => {
    const response = await callRoute(db, '/admin/v1/providers', adminHeaders(), {
      method: 'POST',
      body: {
        app: APP,
        name: 'New provider',
        configuration: { subject: 'mailto:ops@ecoma.io' },
        transport: 'web',
        type: 'web-push',
      },
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { providerId: string };
    const provider = await readProvider(db, created.providerId);
    // Provider mới sinh `disabled` — chỉ enable sau khi pass test (§6.1); sinh `enabled` sẽ
    // đưa một provider chưa credential vào routing production.
    expect(provider).toMatchObject({ app: APP, status: 'disabled', emergency_hold: 0 });
    // Audit ghi trên ID do server sinh — truy theo event vì caller không biết ID trước.
    const audits = await readAuditByEvent(db, 'provider_created');
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].detail_json)).toMatchObject({ app: APP, transport: 'web' });
  });

  it('rejects a create whose transport is not in the closed set with 400', async () => {
    const response = await callRoute(db, '/admin/v1/providers', adminHeaders(), {
      method: 'POST',
      body: {
        app: APP,
        name: 'Bad transport',
        configuration: {},
        transport: 'sms',
        type: 'web-push',
      },
    });

    expect(response.status).toBe(400);
    // Không có audit: thao tác chưa xảy ra.
    expect(await readAuditByEvent(db, 'provider_created')).toHaveLength(0);
  });
});

describe('PATCH /admin/v1/providers/:providerId — update and enable/disable (FR-005)', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('updates name/configuration and audits provider_updated', async () => {
    const response = await callRoute(db, '/admin/v1/providers/prov?app=ecoma-io', adminHeaders(), {
      method: 'PATCH',
      body: { name: 'Renamed', configuration: { subject: 'mailto:new@ecoma.io' } },
    });

    expect(response.status).toBe(200);
    const row = await db.rows<{ name: string }>(
      'SELECT name FROM push_providers WHERE provider_id = ?',
      'prov',
    );
    expect(row[0].name).toBe('Renamed');
    expect(await readAuditEvents(db, 'prov')).toEqual(['provider_updated']);
  });

  it('enables a fresh disabled provider when expected matches and audits provider_enabled', async () => {
    const providerId = await createProvider(db, 'To enable');
    expect(await readProvider(db, providerId)).toMatchObject({ status: 'disabled' });

    // ⚠️ **Enable đòi credential `active` giải mã được** (§6.1 — `credential availability` ·
    // `credential validity` là cổng chặn fail-closed của API). Provider vừa tạo qua API chưa
    // có credential nào, nên bước rotate là **điều kiện** của enable — không phải thừa.
    const rotated = await rotateCredential(db, providerId, 'vapid-k2');
    expect(rotated.status).toBe(200);

    const response = await callRoute(
      db,
      `/admin/v1/providers/${providerId}?app=ecoma-io`,
      adminHeaders(),
      { method: 'PATCH', body: { status: 'enabled', expected: 'disabled' } },
    );

    expect(response.status).toBe(200);
    expect(await readProvider(db, providerId)).toMatchObject({ status: 'enabled' });
    // ⚠️ Audit của rotation nằm trên entity `push_provider_credential` (ID do server sinh),
    // **không** trên `provider_id` — nên danh sách audit của provider vẫn đúng hai event.
    expect(await readAuditEvents(db, providerId)).toEqual(['provider_created', 'provider_enabled']);
  });

  it('refuses an enable whose expected status does not match with 409 state_mismatch and no audit', async () => {
    // `prov` của fixture đã `enabled`; enable với expected=disabled phải bị chặn —
    // `expected` nằm trong statement ghi (guarded conditional write), không phải lịch sử đọc.
    const response = await callRoute(db, '/admin/v1/providers/prov?app=ecoma-io', adminHeaders(), {
      method: 'PATCH',
      body: { status: 'enabled', expected: 'disabled' },
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('state_mismatch');
    // Một audit record cho một thay đổi không xảy ra là bằng chứng sai (FR-020).
    expect(await readAuditEvents(db, 'prov')).toEqual([]);
  });

  it('refuses an enable while emergency hold is set with 409 provider_held', async () => {
    // §6.1: release hold là bước độc lập — enable qua mặt hold tạo một trạng thái mà routing
    // chấp nhận nhưng claim chặn.
    await callRoute(db, '/admin/v1/providers/prov/hold?app=ecoma-io', adminHeaders(), {
      method: 'POST',
    });

    const response = await callRoute(db, '/admin/v1/providers/prov?app=ecoma-io', adminHeaders(), {
      method: 'PATCH',
      body: { status: 'enabled', expected: 'enabled' },
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('provider_held');
  });

  it('disables an enabled provider and audits provider_disabled', async () => {
    const response = await callRoute(db, '/admin/v1/providers/prov?app=ecoma-io', adminHeaders(), {
      method: 'PATCH',
      body: { status: 'disabled', expected: 'enabled' },
    });

    expect(response.status).toBe(200);
    expect(await readProvider(db, 'prov')).toMatchObject({ status: 'disabled' });
    expect(await readAuditEvents(db, 'prov')).toEqual(['provider_disabled']);
  });
});

/**
 * Cổng chặn enable của provider — fail-closed trước `disabled → enabled` (§6.1).
 *
 * ⚠️ **Ba điều kiện API-side**: `configuration schema` · `credential availability` ·
 * `credential validity`. `provider connectivity` và `test delivery` là bước **runbook của
 * operator** (§6.4, qua `POST /admin/v1/providers/:id/test`), không phải cổng chặn của API —
 * control plane không có provider SDK nên không thể tự kiểm tra connectivity.
 *
 * ⚠️ **Mỗi test ở đây đi qua `worker.fetch` thật** và đọc lại D1 sau request: một cổng chặn
 * chỉ có ý nghĩa khi nó chặn **cả** ghi state **và** ghi audit — một `provider_enabled` cho
 * một provider chưa đủ điều kiện là bằng chứng sai (FR-020).
 */
describe('PATCH enable — fail-closed preconditions (§6.1)', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('enables a provider whose only active credential is the one among retired and compromised ones', async () => {
    // ⚠️ **Vì sao test này tồn tại**: cổng chặn enable chọn credential `active` bằng một
    // predicate **có tên** (`isActiveProviderRecord`) thay vì arrow function inline — thay đổi
    // hình dạng để gỡ false positive của rule Semgrep
    // `security-sensitive-value-in-http-response`, KHÔNG phải để đổi hành vi. Test này ghim
    // hành vi: với nhiều credential lẫn lộn status, cổng phải chọn đúng credential `active`.
    const providerId = await createProvider(db, 'Mixed credential statuses');

    // Ba credential trên **cùng** provider, mỗi credential một cặp khoá VAPID thật (đường
    // rotate thật, nên ciphertext giải mã được bằng root key `K1` của app).
    for (const vapidKeyId of ['vapid-k1', 'vapid-k2', 'vapid-k3']) {
      const rotated = await rotateCredential(db, providerId, vapidKeyId);
      expect(rotated.status).toBe(200);
    }

    // Rồi đổi status của hai credential — `retired` và `compromised`. Ghi trực tiếp vì
    // không có đường vận hành nào đưa một credential vào `compromised` (FR-017 chỉ disable
    // provider). Giá trị `status` nằm trong CHECK constraint của bảng nên D1 từ chối giá trị
    // lạ — `retired`/`compromised` là hai giá trị hợp lệ còn lại.
    await db.run(
      "UPDATE push_provider_credentials SET status = 'retired' WHERE provider_id = ? AND vapid_key_id = ?",
      providerId,
      'vapid-k1',
    );
    await db.run(
      "UPDATE push_provider_credentials SET status = 'compromised' WHERE provider_id = ? AND vapid_key_id = ?",
      providerId,
      'vapid-k2',
    );

    // ⚠️ **Hai credential không `active` phải KHÔNG giải mã được** — đây là chỗ làm test
    // **phân biệt được** hành vi, chứ không chỉ ghi trạng thái. `listByProvider` trả về
    // theo `created_at ASC, credential_id ASC`, và `credential_id` là ID ngẫu nhiên nên
    // "credential đầu tiên" **không xác định** — nếu cả ba credential đều giải mã được thì
    // một predicate chọn sai credential vẫn cho kết quả 200 và test vẫn xanh.
    //
    // Đặt version của hai credential đó thành `K9` — version **không có trong keyring** của
    // app (`CREDENTIAL_SERVING_VERSIONS: 'K1'`), nên `decrypt` fail-closed và cổng trả
    // `credential_decryption_failed`. Chỉ còn credential `active` là giải mã được, nên
    // enable đi qua được **chỉ khi** predicate chọn đúng nó.
    await db.run(
      "UPDATE push_provider_credentials SET credential_encryption_version = 'K9' WHERE provider_id = ? AND vapid_key_id IN ('vapid-k1', 'vapid-k2')",
      providerId,
    );

    const credentials = await db.rows<{
      vapid_key_id: string;
      status: string;
      credential_encryption_version: string;
    }>(
      'SELECT vapid_key_id, status, credential_encryption_version FROM push_provider_credentials WHERE provider_id = ? ORDER BY vapid_key_id',
      providerId,
    );
    expect(credentials).toEqual([
      { vapid_key_id: 'vapid-k1', status: 'retired', credential_encryption_version: 'K9' },
      { vapid_key_id: 'vapid-k2', status: 'compromised', credential_encryption_version: 'K9' },
      { vapid_key_id: 'vapid-k3', status: 'active', credential_encryption_version: 'K1' },
    ]);

    const response = await callRoute(
      db,
      `/admin/v1/providers/${providerId}?app=ecoma-io`,
      adminHeaders(),
      { method: 'PATCH', body: { status: 'enabled', expected: 'disabled' } },
    );

    // Cổng đi qua được ⇒ predicate chọn đúng credential `active` (và nó giải mã được).
    expect(response.status).toBe(200);
    expect(await readProvider(db, providerId)).toMatchObject({ status: 'enabled' });
  });

  it('refuses to enable a provider without an active credential with 400 credential_missing', async () => {
    const providerId = await createProvider(db, 'No credential');

    const response = await callRoute(
      db,
      `/admin/v1/providers/${providerId}?app=ecoma-io`,
      adminHeaders(),
      { method: 'PATCH', body: { status: 'enabled', expected: 'disabled' } },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('credential_missing');
    // Provider vẫn `disabled` — cổng chặn phải chặn **cả** state, không chỉ trả lỗi.
    expect(await readProvider(db, providerId)).toMatchObject({ status: 'disabled' });
    // Và không có `provider_enabled` cho một thay đổi không xảy ra (FR-020).
    expect(await readAuditEvents(db, providerId)).toEqual(['provider_created']);
  });

  it('refuses to enable a provider whose credential cannot be decrypted with 400 credential_decryption_failed', async () => {
    const providerId = await createProvider(db, 'Broken credential');
    const rotated = await rotateCredential(db, providerId, 'vapid-k2');
    expect(rotated.status).toBe(200);

    // ⚠️ Version `K9` **không có trong keyring** của app (`CREDENTIAL_SERVING_VERSIONS: 'K1'`):
    // đây là hình dạng thật của keyring lệch sau một lần rotate secret, và nó phải bị chặn
    // ở enable — không phải lúc claim (lúc đó provider đã nhận traffic).
    await db.run(
      'UPDATE push_provider_credentials SET credential_encryption_version = ? WHERE provider_id = ?',
      'K9',
      providerId,
    );

    const response = await callRoute(
      db,
      `/admin/v1/providers/${providerId}?app=ecoma-io`,
      adminHeaders(),
      { method: 'PATCH', body: { status: 'enabled', expected: 'disabled' } },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('credential_decryption_failed');
    expect(await readProvider(db, providerId)).toMatchObject({ status: 'disabled' });
    expect(await readAuditEvents(db, providerId)).toEqual(['provider_created']);
  });

  it('refuses to write a provider configuration that has no VAPID subject with 400 configuration_invalid', async () => {
    // ⚠️ **B-3**: `updateProvider` giờ validate `configuration` trước khi ghi — cấu hình hỏng
    // không còn đi vào D1 qua `PATCH`. Cổng enable vẫn kiểm lại (defense in depth), nhưng đường
    // PATCH là nơi cấu hình bị từ chối trước.
    const providerId = await createProvider(db, 'Bad configuration');
    const rotated = await rotateCredential(db, providerId, 'vapid-k2');
    expect(rotated.status).toBe(200);

    const patched = await callRoute(
      db,
      `/admin/v1/providers/${providerId}?app=ecoma-io`,
      adminHeaders(),
      { method: 'PATCH', body: { name: 'Bad configuration', configuration: {} } },
    );
    expect(patched.status).toBe(400);
    const body = (await patched.json()) as { error: string };
    expect(body.error).toBe('configuration_invalid');
    expect(await readProvider(db, providerId)).toMatchObject({ status: 'disabled' });
    expect(await readAuditEvents(db, providerId)).toEqual(['provider_created']);
  });
});

describe('POST hold / release — emergency hold (§6.5)', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('sets emergency_hold keeping status, audits once, and release clears it', async () => {
    const hold = await callRoute(db, '/admin/v1/providers/prov/hold?app=ecoma-io', adminHeaders(), {
      method: 'POST',
    });
    expect(hold.status).toBe(200);
    // Hold giữ nguyên `status` — khác `disable`; nó chặn delivery **đã materialize** chưa
    // bắt đầu trong khi disable chỉ dừng routing mới (§6.5).
    expect(await readProvider(db, 'prov')).toMatchObject({ status: 'enabled', emergency_hold: 1 });
    expect(await readAuditEvents(db, 'prov')).toEqual(['provider_held']);

    // Hold idempotent: lời gọi lặp trả 200 và **không** ghi audit thứ hai — runbook §15.7
    // chạy lại được mà không tạo bằng chứng sai.
    const holdAgain = await callRoute(
      db,
      '/admin/v1/providers/prov/hold?app=ecoma-io',
      adminHeaders(),
      { method: 'POST' },
    );
    expect(holdAgain.status).toBe(200);
    expect(await readAuditEvents(db, 'prov')).toEqual(['provider_held']);

    const release = await callRoute(
      db,
      '/admin/v1/providers/prov/release?app=ecoma-io',
      adminHeaders(),
      { method: 'POST' },
    );
    expect(release.status).toBe(200);
    // Release **không** bỏ disable ngầm — ở đây status chưa từng disable nên vẫn enabled.
    expect(await readProvider(db, 'prov')).toMatchObject({ status: 'enabled', emergency_hold: 0 });
    expect(await readAuditEvents(db, 'prov')).toEqual(['provider_held', 'provider_released']);
  });
});

describe('POST /admin/v1/providers/:providerId/rotate-credential — rotation (FR-006, §7.2)', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('inserts the new credential active and keeps the old one when it is still referenced', async () => {
    // seedScope tạo subscription `sub` `active` tham chiếu `vapid-k1` — §7.2 cấm retire key
    // cũ khi còn subscription tham chiếu: rotation vẫn thành công, chỉ là không retire.
    //
    // ⚠️ **Cặp VAPID phải thật** (`verifyVapidKeyPair` ký và verify trước khi ghi): material
    // giả không import được PKCS#8/điểm EC và bị trả `vapid_key_pair_mismatch` — đó là cổng
    // chặn đúng, không phải lỗi fixture. Cặp thật derive lúc chạy từ `vapid-test-keys`.
    const response = await rotateCredential(db, 'prov', 'vapid-k2', {
      retireVapidKeyId: 'vapid-k1',
    });

    expect(response.status).toBe(200);
    // Route trả value của use case nguyên trạng — camelCase, không qua projection snake_case.
    const body = (await response.json()) as {
      vapidKeyId: string;
      retiredVapidKeyId: string | null;
    };
    expect(body.vapidKeyId).toBe('vapid-k2');
    expect(body.retiredVapidKeyId).toBeNull();

    const credentials = await db.rows<{ vapid_key_id: string; status: string }>(
      // ⚠️ Không ORDER BY created_at: clock fixture cho cả hai row cùng `now`, thứ tự theo
      // timestamp là bất định. `vapid_key_id` là thứ tự xác định, và set kết quả không đổi.
      'SELECT vapid_key_id, status FROM push_provider_credentials WHERE provider_id = ? ORDER BY vapid_key_id',
      'prov',
    );
    // Key cũ vẫn `active` — retirement là một bước **sau** khi đếm được 0 tham chiếu.
    expect(credentials).toEqual([
      { vapid_key_id: 'vapid-k1', status: 'active' },
      { vapid_key_id: 'vapid-k2', status: 'active' },
    ]);

    // Audit ghi trên entity `push_provider_credential` với ID do server sinh; detail phải
    // phân biệt "chưa retire vì còn tham chiếu" với "đã retire" — ghi `"none"` cho cả hai
    // sẽ làm người đọc audit kết luận sai.
    const audits = await readAuditByEvent(db, 'credential_rotated');
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].detail_json)).toMatchObject({
      app: APP,
      provider_id: 'prov',
      new_vapid_key_id: 'vapid-k2',
      retired_vapid_key_id: 'skipped_still_referenced',
    });
  });

  it('retires the old credential when no active subscription references it', async () => {
    // Hết tham chiếu: xoá subscription `sub` (cách duy nhất trong fixture tham chiếu key cũ),
    // rotate kèm `retire_vapid_key_id` thì key cũ được retire đúng thứ tự §7.2.
    await db.run('DELETE FROM push_subscriptions WHERE subscription_id = ?', 'sub');

    const response = await rotateCredential(db, 'prov', 'vapid-k2', {
      retireVapidKeyId: 'vapid-k1',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { retiredVapidKeyId: string | null };
    expect(body.retiredVapidKeyId).toBe('vapid-k1');

    const credentials = await db.rows<{ vapid_key_id: string; status: string }>(
      // Cùng lý do với test trên: ORDER BY vapid_key_id vì created_at trùng nhau.
      'SELECT vapid_key_id, status FROM push_provider_credentials WHERE provider_id = ? ORDER BY vapid_key_id',
      'prov',
    );
    expect(credentials).toEqual([
      { vapid_key_id: 'vapid-k1', status: 'retired' },
      { vapid_key_id: 'vapid-k2', status: 'active' },
    ]);
  });

  it('refuses to rotate a credential whose public key does not match the private key with 400 vapid_key_pair_mismatch', async () => {
    // ⚠️ **Hai cặp khoá THẬT, lệch nhau** — private key của cặp `default` đi cùng public
    // point của cặp `mismatch`. Cả hai đều import được (PKCS#8 hợp lệ, điểm EC 65 octet
    // hợp lệ) nên đây **không** phải lỗi định dạng: nó là đúng hình dạng "public key sai
    // được nhầm" mà `verifyVapidKeyPair` phải chặn — một cặp lệch vẫn ký được JWT VAPID
    // nhưng push service sẽ từ chối, tức mọi delivery hỏng trong khi rotate trả `200`.
    const privatePair = await vapidTestKeyPair('default');
    const otherPair = await vapidTestKeyPair('mismatch');

    const response = await callRoute(
      db,
      '/admin/v1/providers/prov/rotate-credential',
      adminHeaders(),
      {
        method: 'POST',
        body: {
          app: APP,
          vapid_key_id: 'vapid-k2',
          public_key: otherPair.publicPointBase64Url,
          private_key: privatePair.privateKeyDerBase64Url,
        },
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('vapid_key_pair_mismatch');
    // Cổng chặn phải chặn **trước khi ghi**: không được để lại credential `active` thiếu
    // ciphertext — cùng hình dạng mà test thiếu `private_key` bên dưới khẳng định.
    const count = await db.rows<{ n: number }>(
      'SELECT COUNT(*) AS n FROM push_provider_credentials WHERE provider_id = ?',
      'prov',
    );
    expect(count[0].n).toBe(1);
    expect(await readAuditByEvent(db, 'credential_rotated')).toHaveLength(0);
  });

  it('rejects a rotation missing private_key with 400 and no credential row', async () => {
    const response = await callRoute(
      db,
      '/admin/v1/providers/prov/rotate-credential',
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, vapid_key_id: 'vapid-k2', public_key: 'new-public-key' },
      },
    );

    expect(response.status).toBe(400);
    const count = await db.rows<{ n: number }>(
      'SELECT COUNT(*) AS n FROM push_provider_credentials WHERE provider_id = ?',
      'prov',
    );
    // Mã hoá **trước** khi ghi: không được để lại credential `active` thiếu ciphertext.
    expect(count[0].n).toBe(1);
    expect(await readAuditByEvent(db, 'credential_rotated')).toHaveLength(0);
  });
});

describe('DELETE /admin/v1/providers/:providerId — logical revoke (FR-017)', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('disables the provider logically, keeps the row, and audits provider_disabled', async () => {
    // `reason` bắt buộc ở query: DELETE thu hồi một provider production, không có gì phân
    // biệt quyết định có chủ ý với thao tác nhầm.
    const response = await callRoute(
      db,
      '/admin/v1/providers/prov?app=ecoma-io&reason=offboarding',
      adminHeaders(),
      { method: 'DELETE' },
    );

    expect(response.status).toBe(200);
    // Row **giữ lại** — retention sở hữu physical deletion, DELETE chỉ là logical revoke.
    expect(await readProvider(db, 'prov')).toMatchObject({ status: 'disabled' });
    expect(await readAuditEvents(db, 'prov')).toEqual(['provider_disabled']);
  });

  it('requires the reason query parameter with 400', async () => {
    const response = await callRoute(db, '/admin/v1/providers/prov?app=ecoma-io', adminHeaders(), {
      method: 'DELETE',
    });

    expect(response.status).toBe(400);
    expect(await readProvider(db, 'prov')).toMatchObject({ status: 'enabled' });
  });
});

describe('POST /admin/v1/deliveries/:deliveryId/retry — failed → queued (§5.6.1)', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    await seedScope(db);
    // seedScope tạo delivery `deliv` `pending` (chưa claim); retry đòi terminal `failed` —
    // đưa nó vào đúng trạng thái terminal trước mỗi test của block này.
    await db.run(
      "UPDATE push_deliveries SET status = 'failed', dispatch_generation = 1 WHERE delivery_id = ?",
      'deliv',
    );
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('requeues a failed delivery with a bumped generation and audits delivery_retried', async () => {
    const response = await callRoute(db, '/admin/v1/deliveries/deliv/retry', adminHeaders(), {
      method: 'POST',
      body: { app: APP, reason: 'operator-requeue' },
    });

    expect(response.status).toBe(200);
    const row = await db.rows<{ status: string; dispatch_generation: number }>(
      'SELECT status, dispatch_generation FROM push_deliveries WHERE delivery_id = ?',
      'deliv',
    );
    // §5.6.1: requeue tăng `dispatch_generation` — không tái dùng generation cũ, generation
    // mới fence mọi execution cũ của lease trước.
    expect(row[0]).toEqual({ status: 'queued', dispatch_generation: 2 });
    expect(await readAuditEvents(db, 'deliv')).toEqual(['delivery_retried']);
  });

  it('creates an outbox intent for the requeued delivery that the publisher can publish', async () => {
    const response = await callRoute(db, '/admin/v1/deliveries/deliv/retry', adminHeaders(), {
      method: 'POST',
      body: { app: APP, reason: 'operator-requeue' },
    });

    expect(response.status).toBe(200);

    const intents = await db.rows<{ outbox_id: string; status: string }>(
      'SELECT outbox_id, status FROM push_outbox WHERE delivery_id = ?',
      'deliv',
    );
    // §5.6.1: requeue phải đi kèm **đúng một** outbox intent — không có intent thì publisher
    // không nhặt được gì (predicate claim chỉ đọc `push_outbox`) và delivery nằm `queued` mãi.
    expect(intents).toHaveLength(1);
    expect(intents[0]?.status).toBe('pending');

    // Và intent đó phải đi qua được publisher: message thật sự publish lên Queue.
    const publish = await callRoute(db, '/internal/outbox/publish', adminHeaders(), {
      method: 'POST',
      body: {},
    });
    expect(publish.status).toBe(200);
    const run = (await publish.json()) as {
      readonly published: number;
      readonly send_calls: number;
    };
    expect(run).toMatchObject({ published: 1, send_calls: 1 });
    expect(
      await db.rows<{ status: string }>(
        'SELECT status FROM push_outbox WHERE delivery_id = ?',
        'deliv',
      ),
    ).toEqual([{ status: 'published' }]);
  });

  it('refuses a non-terminal delivery with 409 recovery_precondition_failed', async () => {
    await db.run(
      "UPDATE push_deliveries SET status = 'pending', dispatch_generation = 0 WHERE delivery_id = ?",
      'deliv',
    );

    const response = await callRoute(db, '/admin/v1/deliveries/deliv/retry', adminHeaders(), {
      method: 'POST',
      body: { app: APP, reason: 'operator-requeue' },
    });

    // `failed → queued` là transition **duy nhất** rời terminal; delivery `pending` chưa từng
    // ở terminal nên không có gì để hồi sinh — đường của nó là republish (§5.6.1).
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('recovery_precondition_failed');
    expect(await readAuditEvents(db, 'deliv')).toEqual([]);
  });

  it('refuses a retry whose reason is missing with 400', async () => {
    const response = await callRoute(db, '/admin/v1/deliveries/deliv/retry', adminHeaders(), {
      method: 'POST',
      body: { app: APP },
    });

    expect(response.status).toBe(400);
    expect(
      await db.rows<{ status: string }>(
        'SELECT status FROM push_deliveries WHERE delivery_id = ?',
        'deliv',
      ),
    ).toEqual([{ status: 'failed' }]);
  });
});

describe('POST /admin/v1/deliveries/:deliveryId/republish — a new intent without changing state (§5.6.3)', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('creates exactly one outbox intent for a stuck pending delivery and audits delivery_republished', async () => {
    const response = await callRoute(db, '/admin/v1/deliveries/deliv/republish', adminHeaders(), {
      method: 'POST',
      body: { app: APP, reason: 'stuck-pending' },
    });

    expect(response.status).toBe(200);
    // §5.6.3: republish **không** đổi delivery state và **không** tăng generation — chưa có
    // execution nào từng chạy nên không có gì cần fence; publisher mới là actor của
    // `pending → queued`.
    const row = await db.rows<{ status: string; dispatch_generation: number }>(
      'SELECT status, dispatch_generation FROM push_deliveries WHERE delivery_id = ?',
      'deliv',
    );
    expect(row[0]).toEqual({ status: 'pending', dispatch_generation: 0 });

    const intents = await db.rows<{ outbox_id: string }>(
      'SELECT outbox_id FROM push_outbox WHERE delivery_id = ?',
      'deliv',
    );
    // "Đúng một intent" là toàn bộ mục đích của republish — index partial chặn intent thứ hai.
    expect(intents).toHaveLength(1);
    expect(await readAuditEvents(db, 'deliv')).toEqual(['delivery_republished']);
  });

  it('refuses a republish for a terminal failed delivery with 409', async () => {
    await db.run(
      "UPDATE push_deliveries SET status = 'failed', dispatch_generation = 1 WHERE delivery_id = ?",
      'deliv',
    );

    const response = await callRoute(db, '/admin/v1/deliveries/deliv/republish', adminHeaders(), {
      method: 'POST',
      body: { app: APP, reason: 'stuck-pending' },
    });

    // Hai đường phục hồi tách theo tính terminal: `failed` đi retry, non-terminal đi
    // republish — gộp chúng là mất guard của cả hai (§5.6.1 vs §5.6.3).
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('recovery_precondition_failed');
  });
});

/**
 * Header của caller runtime API — secret nguyên văn (không Bearer) + principal tự khai.
 * Module scope: helper không capture gì từ scope cha, và một bản duy nhất là một cơ hội ít hơn
 * để các block lệch nhau về credential (lint `consistent-function-scoping` chặn đúng điều đó).
 */
function runtimeHeaders(): Record<string, string> {
  return {
    authorization: 'runtime-secret',
    'x-ecoma-principal': 'svc.web-push-notification-job',
    'content-type': 'application/json',
  };
}

/**
 * Đưa delivery vào trạng thái mà fence trả `terminal` với generation khớp:
 * `deliv` đã terminal ở generation 1, caller vẫn cầm generation 1.
 */
async function setDeliveredAtGeneration1(db: TestDatabase): Promise<void> {
  await db.run(
    "UPDATE push_deliveries SET status = 'delivered', dispatch_generation = 1 WHERE delivery_id = ?",
    'deliv',
  );
}

describe('POST /internal/deliveries/:deliveryId/{release,outcome} — fenced 409 body (FR-022)', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('release returns 409 terminal WITH state, satisfying the client-side contract validator', async () => {
    await setDeliveredAtGeneration1(db);

    const response = await callRoute(db, '/internal/deliveries/deliv/release', runtimeHeaders(), {
      method: 'POST',
      body: { dispatch_generation: 1 },
    });

    // ⚠️ Regression: body cũ là `{ reason }` không `state`, nên `validateLeaseFencedRejection`
    // bên delivery worker trả `RuntimeContractError('state_required')` — một conflict lành
    // thành một chuỗi bounded retry thừa trước khi claim kế trả đúng terminal-ACK.
    expect(response.status).toBe(409);
    const body = (await response.json()) as { reason: string; state: string };
    expect(body).toEqual({ reason: 'terminal', state: 'delivered' });
  });

  it('outcome returns 409 terminal WITH the real terminal state, not a constant', async () => {
    // Dùng `cancelled` — một terminal state khác `delivered` — để chứng minh body mang state
    // thật của delivery, không phải hằng của route.
    await db.run(
      "UPDATE push_deliveries SET status = 'cancelled', dispatch_generation = 1 WHERE delivery_id = ?",
      'deliv',
    );

    const response = await callRoute(db, '/internal/deliveries/deliv/outcome', runtimeHeaders(), {
      method: 'POST',
      body: { dispatch_generation: 1, outcome: 'delivered' },
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { reason: string; state: string };
    expect(body).toEqual({ reason: 'terminal', state: 'cancelled' });
  });

  it('release returns 409 stale_write without state, as the contract forbids state outside terminal', async () => {
    // Caller cầm generation 1 nhưng delivery đã claim ở generation 2 — `stale_write`.
    await db.run(
      "UPDATE push_deliveries SET status = 'processing', dispatch_generation = 2, lease_expires_at = 99999999999 WHERE delivery_id = ?",
      'deliv',
    );

    const response = await callRoute(db, '/internal/deliveries/deliv/release', runtimeHeaders(), {
      method: 'POST',
      body: { dispatch_generation: 1 },
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { reason: string; state?: string };
    expect(body.reason).toBe('stale_write');
    // Hợp đồng đóng: `state` CHỈ được kèm khi `reason = 'terminal'`.
    expect(body).not.toHaveProperty('state');
  });
});
