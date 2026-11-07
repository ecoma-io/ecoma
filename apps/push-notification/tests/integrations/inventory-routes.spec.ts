/**
 * Sáu route Application API của inventory — `POST/GET/DELETE /v1/devices` và
 * `POST/PATCH/DELETE /v1/subscriptions` (FR-002, FR-003, FR-004, FR-020; §4.1).
 *
 * ⚠️ **Vì sao file này ở `apps/push-notification/tests/integrations/` chứ không ở lib.** Nó gọi `worker.fetch`
 * thật (`../src/main`), nên nó chạm **cả** application lẫn infrastructure. Hướng phụ thuộc ở đây
 * là `infrastructure → application` (adapter hiện thực port của application), nên một test
 * trong `libs/push-notification-application` mà import infrastructure sẽ **đóng vòng** Nx và
 * `run-many` abort. `tests/` là composition root — nơi duy nhất được phép chạm hai tầng.
 *
 * ⚠️ **Test ở đây đo hành vi quan sát được từ ngoài: HTTP + trạng thái D1.** Không stub use case.
 * Một route có thể trả `200` với `detail` sai, hoặc ghi một hàng `disabled` mà không ghi
 * audit — hai lỗi đó chỉ thấy được khi đọc D1 sau request. Vì vậy file này luôn khẳng định
 * **hai** mặt: response **và** hàng/audit record mà nó nên tạo ra.
 *
 * ⚠️ **`auth-boundary.spec.ts` giữ phần "401 trước lookup".** Không lặp lại ở đây: đó là một
 * bất biến của boundary, đo bằng probe, và nó đã có bộ test riêng cho cả sáu route. File này
 * bắt đầu từ **sau** boundary — mọi request ở đây đều đã xác thực.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetConfigCacheForTest, type PushWorkerEnv } from '../../src/config';

import worker from '../../src/main';
import { applicationHeaders, callRoute, completeEnv, type WorkerExecutionContext } from './app-env';
import {
  APP,
  ENDPOINT,
  OTHER_APP,
  T0,
  createTestDatabase,
  seedScope,
  type SeededScope,
  type TestDatabase,
} from './d1-harness';

/* -------------------------------------------------------------------------------------- */
/* Fixture helpers                                                                             */
/* -------------------------------------------------------------------------------------- */

/** Endpoint thứ hai trong allowlist — dùng cho case "một endpoint là một định danh duy nhất". */
const MOZILLA_ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/xyz987';

/** Body hợp lệ của `POST /v1/subscriptions` — sửa từng field cho từng case. */
function subscriptionBody(
  deviceId: string,
  userId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    device_id: deviceId,
    user_id: userId,
    endpoint: ENDPOINT,
    p256dh: 'client-p256dh',
    auth: 'client-auth',
    vapid_key_id: 'vapid-k1',
    ...overrides,
  };
}

/** Đọc một subscription từ D1 — assertion state, không assert response. */
interface SubscriptionRow {
  readonly subscription_id: string;
  readonly device_id: string;
  readonly user_id: string;
  readonly app: string;
  readonly status: string;
  readonly disabled_reason: string | null;
  readonly p256dh: string;
  readonly auth: string;
}

/**
 * Hash SHA-256 hex của một endpoint — **cùng** hàm `sha256HexHasher` của `main.ts`.
 *
 * ⚠️ Vì sao test tự băm thay vì để use case băm: fixture `seedScope` ghi
 * `endpoint_hash` là chuỗi giả (`hash-ecoma-io`), nên chỉ có endpoint **thật** mới tìm được
 * hàng do chính request này tạo. Hàm băm phải giống hệt — một thuật toán khác sẽ cho một
 * `endpoint_hash` khác và mọi khẳng định dedupe bên dưới sẽ nhìn vào một hàng không tồn tại.
 */
async function hashOf(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readSubscriptions(
  db: TestDatabase,
  endpointHash: string,
): Promise<readonly SubscriptionRow[]> {
  return db.rows<SubscriptionRow>(
    `SELECT subscription_id, device_id, user_id, app, status, disabled_reason, p256dh, auth
     FROM push_subscriptions WHERE endpoint_hash = ?`,
    endpointHash,
  );
}

/** Audit record của một entity — dùng để chứng minh FR-020 được thực thi, không chỉ khai. */
interface AuditRow {
  readonly event: string;
  readonly actor: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly detail_json: string;
}

/**
 * Header của một caller Admin API đã xác thực — cùng token với `app-env.ts`.
 *
 * ⚠️ Một bản **module scope** duy nhất: ba describe của file này đều gọi cùng một route admin,
 * và một bản mỗi describe là một cơ hội để một bản trôi token so với hai bản còn lại mà không
 * test nào phát hiện (lint `consistent-function-scoping` chặn đúng điều đó).
 */
function adminHeaders(): Record<string, string> {
  return { authorization: 'Bearer admin-token' };
}

function readAudit(db: TestDatabase, entityId: string): Promise<readonly AuditRow[]> {
  return db.rows<AuditRow>(
    `SELECT event, actor, entity_type, entity_id, detail_json
     FROM audit_records WHERE entity_id = ? ORDER BY recorded_at`,
    entityId,
  );
}

/* -------------------------------------------------------------------------------------- */
/* POST /v1/devices — FR-002                                                                   */
/* -------------------------------------------------------------------------------------- */

describe('POST /v1/devices — device registration (FR-002)', () => {
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

  it('creates a device and returns 201 with app derived from the principal', async () => {
    const response = await callRoute(db, '/v1/devices', applicationHeaders(), {
      method: 'POST',
      body: { device_id: 'device-new', user_id: 'user-new' },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      device_id: 'device-new',
      user_id: 'user-new',
      // ⚠️ `app` lấy từ `APPLICATION_API_PRINCIPAL`, **không** từ body — nên body không có
      // trường `app` và giá trị trả về vẫn là `ecoma-io`. Đó là §8.2: namespace đến từ
      // credential, không từ dữ liệu caller kiểm soát.
      app: APP,
      created_at: expect.any(String) as unknown as string,
    });
    const rows = await db.rows<{ app: string; user_id: string }>(
      'SELECT app, user_id FROM devices WHERE device_id = ?',
      'device-new',
    );
    expect(rows).toEqual([{ app: APP, user_id: 'user-new' }]);
  });

  it('ignores an app field in the body, because the principal owns the namespace', async () => {
    const response = await callRoute(db, '/v1/devices', applicationHeaders(), {
      method: 'POST',
      body: { device_id: 'device-claimed', user_id: 'user-new', app: OTHER_APP },
    });

    expect(response.status).toBe(201);
    // Nếu route lấy `app` từ body thì hàng này sẽ thuộc `other-app` và test này đỏ — đó
    // chính là điều cần khẳng định, không phải chi tiết tuỳ thuộc.
    const rows = await db.rows<{ app: string }>(
      'SELECT app FROM devices WHERE device_id = ?',
      'device-claimed',
    );
    expect(rows).toEqual([{ app: APP }]);
  });

  it('re-registers the same device idempotently with 200, not 409', async () => {
    // ⚠️ §5.1: client giữ `device_id` qua mọi session, nên lần đăng ký thứ hai là chuyện
    // thường — `409` sẽ hỏng một client đúng. `seedScope` đã tạo `device` cho `APP`.
    const response = await callRoute(db, '/v1/devices', applicationHeaders(), {
      method: 'POST',
      body: { device_id: 'device', user_id: 'user' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ device_id: 'device' });
    expect(await db.count('SELECT COUNT(*) AS n FROM devices')).toBe(1);
  });

  it('refuses to reassign a device that already belongs to another user', async () => {
    const response = await callRoute(db, '/v1/devices', applicationHeaders(), {
      method: 'POST',
      body: { device_id: 'device', user_id: 'user-attacker' },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'device_owned_by_another_user' });
    // ⚠️ Phải khẳng định state, không chỉ status: một implementation "gán lại" sẽ trả `201`
    // và hàng này sẽ đổi chủ.
    const rows = await db.rows<{ user_id: string }>(
      'SELECT user_id FROM devices WHERE device_id = ?',
      'device',
    );
    expect(rows).toEqual([{ user_id: 'user' }]);
  });

  it('refuses a device_id that belongs to another app', async () => {
    await seedScope(db, { app: OTHER_APP });

    const response = await callRoute(db, '/v1/devices', applicationHeaders(), {
      method: 'POST',
      body: { device_id: 'device-other-app', user_id: 'user-other-app' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'app_mismatch' });
  });

  it.each([
    ['a missing device_id', { user_id: 'user-new' }],
    ['a missing user_id', { device_id: 'device-new' }],
    ['an empty device_id', { device_id: '', user_id: 'user-new' }],
    ['an empty user_id', { device_id: 'device-new', user_id: '' }],
    ['a numeric device_id', { device_id: 42, user_id: 'user-new' }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const response = await callRoute(db, '/v1/devices', applicationHeaders(), {
      method: 'POST',
      body,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_payload' });
    expect(await db.count('SELECT COUNT(*) AS n FROM devices')).toBe(1);
  });
});

/* -------------------------------------------------------------------------------------- */
/* GET /v1/devices/:id — FR-002                                                                 */
/* -------------------------------------------------------------------------------------- */

describe('GET /v1/devices/:id — reading a device (FR-002)', () => {
  let db: TestDatabase;
  let scope: SeededScope;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    scope = await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('returns the device of the caller app', async () => {
    const response = await callRoute(db, `/v1/devices/${scope.deviceId}`, applicationHeaders());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      device_id: scope.deviceId,
      user_id: scope.userId,
      app: scope.app,
      created_at: new Date(T0).toISOString(),
    });
  });

  it('returns 404 for a device that does not exist', async () => {
    const response = await callRoute(db, '/v1/devices/device-nope', applicationHeaders());

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'device_not_found' });
  });

  it('returns 403 rather than the record for a device of another app', async () => {
    await seedScope(db, { app: OTHER_APP });

    const response = await callRoute(db, '/v1/devices/device-other-app', applicationHeaders());

    // ⚠️ `403` chứ không phải `404`: hai câu trả lời trả lời hai câu hỏi khác nhau, và câu
    // thứ hai ("nó thuộc app nào") là thứ operator cần để chẩn đoán client cấu hình sai.
    // Quan trọng hơn: `403` **không** trả nội dung record.
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'app_mismatch' });
    expect(JSON.stringify(body)).not.toContain('user-other-app');
  });
});

/* -------------------------------------------------------------------------------------- */
/* DELETE /v1/devices/:id — cascade disable (FR-004)                                            */
/* -------------------------------------------------------------------------------------- */

describe('DELETE /v1/devices/:id — logical revoke with cascade (FR-004)', () => {
  let db: TestDatabase;
  let scope: SeededScope;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    scope = await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('disables the active subscription of the device and audits it', async () => {
    const response = await callRoute(db, `/v1/devices/${scope.deviceId}`, applicationHeaders(), {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      device_id: scope.deviceId,
      disabled_subscriptions: [scope.subscriptionId],
      revoked: true,
    });

    const rows = await readSubscriptions(db, 'hash-ecoma-io');
    expect(rows).toEqual([
      expect.objectContaining({
        subscription_id: scope.subscriptionId,
        status: 'disabled',
        // ⚠️ `user_unregister` là **mã nguyên nhân**, không phải body của provider — CHECK
        // `push_subscriptions_disabled_reason_check` chỉ nhận đúng bốn mã này.
        disabled_reason: 'user_unregister',
      }),
    ]);

    // ⚠️ FR-020: cascade **không** được là một thay đổi không dấu vết. Nếu use case bỏ
    // `audit.append` thì các assertion ở trên vẫn xanh — chỉ dòng này đỏ.
    const audit = await readAudit(db, scope.subscriptionId);
    expect(audit).toEqual([
      expect.objectContaining({
        event: 'subscription_disabled',
        // ⚠️ `actor` là principal **đã xác thực** (`ecoma-io`), không phải `app` tự khai
        // trong body — FR-019/SR-004.
        actor: APP,
        entity_type: 'push_subscription',
        entity_id: scope.subscriptionId,
      }),
    ]);
    expect(JSON.parse(audit[0].detail_json)).toMatchObject({
      app: APP,
      cause: 'user_unregister',
      device_id: scope.deviceId,
    });
  });

  it('keeps the device row — physical deletion belongs to the retention policy', async () => {
    await callRoute(db, `/v1/devices/${scope.deviceId}`, applicationHeaders(), {
      method: 'DELETE',
    });

    // §4.3: historical references cần cho audit/delivery history. Bảng `devices` còn không có
    // cột status, nên "xoá device" ở v1 chỉ có nghĩa là không còn delivery nào.
    expect(await db.count('SELECT COUNT(*) AS n FROM devices')).toBe(1);
  });

  it('is idempotent — a second DELETE changes nothing and writes no second audit', async () => {
    await callRoute(db, `/v1/devices/${scope.deviceId}`, applicationHeaders(), {
      method: 'DELETE',
    });
    const second = await callRoute(db, `/v1/devices/${scope.deviceId}`, applicationHeaders(), {
      method: 'DELETE',
    });

    // Danh sách rỗng là câu trả lời "không còn gì để đổi", và nó phân biệt được với lần đầu.
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ disabled_subscriptions: [], revoked: true });
    // ⚠️ `disableById` guard `status = 'active'` nên lần hai không ghi thêm audit record: một
    // audit record cho một thay đổi không xảy ra là bằng chứng nói dối (cùng lý do
    // `invalidateSubscription` chỉ audit khi `changed`).
    expect(await readAudit(db, scope.subscriptionId)).toHaveLength(1);
  });

  it('leaves a subscription that was already disabled alone', async () => {
    await db.run(
      `UPDATE push_subscriptions SET status = 'disabled', disabled_reason = 'admin_disable'
       WHERE subscription_id = ?`,
      scope.subscriptionId,
    );

    const response = await callRoute(db, `/v1/devices/${scope.deviceId}`, applicationHeaders(), {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ disabled_subscriptions: [] });
    // Nguyên nhân **đầu tiên** thắng: `disableById` đặt `cause` trong `UPDATE`, không phải
    // trong `SELECT`, nên một disable về sau không ghi đè lý do của lần trước.
    const rows = await readSubscriptions(db, 'hash-ecoma-io');
    expect(rows[0].disabled_reason).toBe('admin_disable');
  });

  it('returns 404 for an unknown device', async () => {
    const response = await callRoute(db, '/v1/devices/device-nope', applicationHeaders(), {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'device_not_found' });
  });

  it('does not touch a device of another app', async () => {
    const other = await seedScope(db, { app: OTHER_APP });

    const response = await callRoute(db, `/v1/devices/${other.deviceId}`, applicationHeaders(), {
      method: 'DELETE',
    });

    expect(response.status).toBe(403);
    const rows = await readSubscriptions(db, `hash-${OTHER_APP}`);
    expect(rows).toEqual([expect.objectContaining({ status: 'active' })]);
  });
});

/* -------------------------------------------------------------------------------------- */
/* POST /v1/subscriptions — FR-003                                                               */
/* -------------------------------------------------------------------------------------- */

describe('POST /v1/subscriptions — registration and endpoint validation (FR-003)', () => {
  let db: TestDatabase;
  let scope: SeededScope;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    scope = await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('creates a subscription on a registered device and returns 201', async () => {
    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      device_id: scope.deviceId,
      app: APP,
      transport: 'web',
      status: 'active',
      vapid_key_id: scope.vapidKeyId,
      subscription_id: expect.any(String) as unknown as string,
    });
    expect(await db.count('SELECT COUNT(*) AS n FROM push_subscriptions')).toBe(2);
  });

  it('never echoes endpoint material back to the caller', async () => {
    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId),
    });

    // ⚠️ §9 loại secret 2: `endpoint`/`p256dh`/`auth`/`endpoint_hash` không lọt ra response.
    // Client vừa gửi lên chúng nên không cần nhận về, và một response chứa chúng là một
    // kênh rò đi qua log/proxy của người đọc response.
    const raw = await response.text();
    for (const secret of [ENDPOINT, 'client-p256dh', 'client-auth']) {
      expect(raw).not.toContain(secret);
    }
  });

  it.each([
    ['a non-https scheme', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['a host outside the allowlist', 'https://attacker.example.com/push/abc'],
    [
      'a host that only suffix-matches the allowlist',
      'https://evil-fcm.googleapis.com.attacker.test/push',
    ],
    ['a userinfo prefix', 'https://user:pass@fcm.googleapis.com/fcm/send/abc'],
    ['an IP literal', 'https://127.0.0.1/push/abc'],
    ['a private address literal', 'https://10.0.0.1/push/abc'],
  ])('rejects %s with 400 endpoint_rejected and writes nothing', async (_label, endpoint) => {
    const before = await db.count('SELECT COUNT(*) AS n FROM push_subscriptions');

    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, { endpoint }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'endpoint_rejected' });
    expect(await db.count('SELECT COUNT(*) AS n FROM push_subscriptions')).toBe(before);
  });

  it('validates the endpoint before touching D1, so a bad endpoint costs no storage call', async () => {
    // ⚠️ FR-003 chống SSRF và một endpoint sai không nên tốn một round-trip. Đo thứ tự bằng
    // probe: shape hợp lệ nhưng endpoint sai → `0` lệnh D1.
    db.probe.reset();

    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, {
        endpoint: 'https://attacker.example.com/push/abc',
      }),
    });

    expect(response.status).toBe(400);
    expect(db.probe.executed()).toBe(0);
  });

  it('rejects a missing device_id before looking anything up', async () => {
    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody('', scope.userId),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_payload' });
  });

  it('rejects a device_id that was never registered', async () => {
    // §5.1: không có `device_id` hợp lệ thì không tạo subscription.
    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody('device-nope', scope.userId),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'device_not_found' });
    expect(await db.count('SELECT COUNT(*) AS n FROM push_subscriptions')).toBe(1);
  });

  it('rejects a user_id that does not own the device', async () => {
    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, 'user-attacker'),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'device_owned_by_another_user' });
    // ⚠️ Phải kiểm state: hai cột `user_id`/`device_id` lệch nhau là một subscription được
    // route tới một user không sở hữu device đó — hỏng dữ liệu âm thầm.
    expect(await db.count('SELECT COUNT(*) AS n FROM push_subscriptions')).toBe(1);
  });

  it('rejects a transport that is not executable in v1', async () => {
    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, { transport: 'app' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_payload' });
  });

  it('rejects a vapid_key_id the app does not actually serve', async () => {
    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, {
        vapid_key_id: 'vapid-key-of-another-app',
      }),
    });

    // ⚠️ FR-006: subscription gắn với key pair dùng lúc tạo, và suy ra key từ "key hiện tại
    // của App" là hỏng delivery âm thầm. Nên nó phải bị **từ chối** chứ không được sửa.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'vapid_key_unavailable' });
    expect(await db.count('SELECT COUNT(*) AS n FROM push_subscriptions')).toBe(1);
  });

  it('refuses to register a subscription when the app has no primary provider', async () => {
    // FR-005 fail-safe ở đường đăng ký nghĩa là **từ chối**: một subscription vừa tạo mà
    // không có provider sẽ không bao giờ nhận delivery, còn client sẽ tin là đã xong.
    await db.run('DELETE FROM push_app_provider_mappings WHERE app = ?', APP);

    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'no_provider_for_scope' });
  });
});

/* -------------------------------------------------------------------------------------- */
/* Dedupe theo endpoint_hash — FR-003/FR-004                                                      */
/* -------------------------------------------------------------------------------------- */

describe('POST /v1/subscriptions — dedupe by endpoint_hash (FR-003, FR-004)', () => {
  let db: TestDatabase;
  let scope: SeededScope;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    scope = await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('does not rewrite the secret of a subscription that is already active', async () => {
    // ⚠️ FR-004 không có transition `active → active`. Delivery đã materialize giữ
    // `p256dh`/`auth` của hàng hiện tại, nên ghi đè chúng giữa chừng là một hỏng âm thầm.
    const endpoint = MOZILLA_ENDPOINT;
    const first = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, { endpoint }),
    });
    expect(first.status).toBe(201);
    const { subscription_id: subscriptionId } = (await first.json()) as {
      subscription_id: string;
    };

    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, {
        endpoint,
        p256dh: 'rotated-p256dh',
        auth: 'rotated-auth',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      subscription_id: subscriptionId,
      status: 'active',
    });
    const rows = await readSubscriptions(db, await hashOf(endpoint));
    expect(rows).toEqual([
      expect.objectContaining({
        subscription_id: subscriptionId,
        status: 'active',
        // ⚠️ Đây là khẳng định quan trọng nhất của test: secret **phải giữ nguyên**. Một
        // implementation gọi `reactivateWithNewSecret` ở đây sẽ trả `200` y hệt và chỉ đỏ ở
        // hai dòng này.
        p256dh: 'client-p256dh',
        auth: 'client-auth',
      }),
    ]);
  });

  it('returns 200 and creates nothing when the same endpoint is registered twice', async () => {
    const body = subscriptionBody(scope.deviceId, scope.userId);

    const first = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body,
    });
    const second = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, { p256dh: 'rotated-p256dh' }),
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    // ⚠️ `subscription_id` phải **giống nhau**: đó là bằng chứng lần hai là idempotent chứ không
    // phải tạo một hàng thứ hai. Chỉ so `200` là chưa đủ — một implementation trả `200` mà vẫn
    // insert hàng mới vẫn xanh.
    const created = (await first.json()) as { subscription_id: string };
    expect(await second.json()).toMatchObject({ subscription_id: created.subscription_id });
    // Một endpoint là **một** định danh duy nhất (CHECK `push_subscriptions_endpoint_unique`).
    expect(await db.count('SELECT COUNT(*) AS n FROM push_subscriptions')).toBe(2);

    const rows = await readSubscriptions(db, await hashOf(ENDPOINT));
    expect(rows).toHaveLength(1);
    // ⚠️ Lần hai đăng ký trên subscription `active` là idempotent, **không** phải một update
    // secret: `p256dh` phải giữ nguyên giá trị của lần đầu.
    expect(rows[0].p256dh).toBe('client-p256dh');
  });

  it('reactivates a disabled subscription with the new secret — the one explicit path (FR-004)', async () => {
    await db.run(
      `UPDATE push_subscriptions SET status = 'disabled', disabled_reason = 'admin_disable'
       WHERE subscription_id = ?`,
      scope.subscriptionId,
    );
    const endpoint = MOZILLA_ENDPOINT;
    const first = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, { endpoint }),
    });
    expect(first.status).toBe(201);
    const { subscription_id: subscriptionId } = (await first.json()) as {
      subscription_id: string;
    };
    await db.run(
      `UPDATE push_subscriptions SET status = 'disabled', disabled_reason = 'admin_disable'
       WHERE subscription_id = ?`,
      subscriptionId,
    );

    const revived = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, {
        endpoint,
        p256dh: 'rotated-p256dh',
        auth: 'rotated-auth',
      }),
    });

    // `200` chứ không phải `201`: đây là hồi sinh một subscription, không phải tạo mới.
    expect(revived.status).toBe(200);
    expect(await revived.json()).toMatchObject({
      subscription_id: subscriptionId,
      status: 'active',
    });

    const rows = await readSubscriptions(db, await hashOf(endpoint));
    expect(rows).toEqual([
      expect.objectContaining({
        subscription_id: subscriptionId,
        status: 'active',
        // ⚠️ CHECK `push_subscriptions_status_reason_parity`: `active` ⇔ không lý do disable.
        disabled_reason: null,
        p256dh: 'rotated-p256dh',
        auth: 'rotated-auth',
      }),
    ]);
  });

  it('refuses to revive an expired subscription, which has no exit transition (§5.2)', async () => {
    const endpoint = MOZILLA_ENDPOINT;
    const created = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, { endpoint }),
    });
    const { subscription_id: subscriptionId } = (await created.json()) as {
      subscription_id: string;
    };
    await db.run(
      `UPDATE push_subscriptions SET status = 'expired', disabled_reason = 'admin_disable'
       WHERE subscription_id = ?`,
      subscriptionId,
    );

    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, { endpoint, p256dh: 'x', auth: 'y' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'subscription_expired' });
    const rows = await readSubscriptions(db, await hashOf(endpoint));
    expect(rows).toEqual([expect.objectContaining({ status: 'expired' })]);
  });

  it('refuses an endpoint already registered on another device of the same app', async () => {
    await db.run(
      `INSERT INTO devices (device_id, user_id, app, created_at, updated_at)
       VALUES ('device-second', 'user-second', ?, ?, ?)`,
      APP,
      T0,
      T0,
    );
    const endpoint = MOZILLA_ENDPOINT;
    const first = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId, { endpoint }),
    });
    expect(first.status).toBe(201);

    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody('device-second', 'user-second', { endpoint }),
    });

    // ⚠️ `reactivateWithNewSecret` **không** cập nhật `device_id`/`user_id`, nên chấp nhận
    // sẽ hồi sinh một subscription vẫn gắn với device cũ trong khi request nói device mới —
    // một liên kết sai mà không test nào khác bắt được.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'endpoint_owned_by_another_device' });
    const rows = await readSubscriptions(db, await hashOf(endpoint));
    expect(rows).toEqual([expect.objectContaining({ device_id: scope.deviceId })]);
  });

  it('refuses to take over an endpoint that belongs to another app', async () => {
    // ⚠️ `endpoint_hash` unique **toàn cục**. Nếu App B ghi đè secret của endpoint thuộc App A
    // thì B chiếm endpoint đó và A mất khả năng gửi — namespace FR-001 bị vi phạm âm thầm.
    //
    // ⚠️ Fixture `seedScope(OTHER_APP)` ghi `endpoint_hash` là chuỗi giả (`hash-other-app`),
    // nên nó **không** thể là hàng mà dedupe tìm thấy: dedupe tra bằng hash thật của `endpoint`.
    // Bản đầu của test này dựa vào fixture đó và xanh **sai** (`201` — tạo hàng mới). Hàng
    // thật sự gây tranh chấp phải được ghi với hash thật, và đó là điều bản này làm.
    await seedScope(db, { app: OTHER_APP });
    await db.run(
      `INSERT INTO devices (device_id, user_id, app, created_at, updated_at)
       VALUES ('device-ours', 'user-ours', ?, ?, ?)`,
      APP,
      T0,
      T0,
    );
    const endpoint = MOZILLA_ENDPOINT;
    await db.run(
      `INSERT INTO push_subscriptions
         (subscription_id, device_id, user_id, app, transport, endpoint, endpoint_hash,
          p256dh, auth, vapid_key_id, status, created_at, updated_at)
       VALUES ('sub-theirs', 'device-other-app', 'user-other-app', ?, 'web', ?, ?,
               'their-p256dh', 'their-auth', 'vapid-key-other-app', 'active', ?, ?)`,
      OTHER_APP,
      endpoint,
      await hashOf(endpoint),
      T0,
      T0,
    );

    const response = await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody('device-ours', 'user-ours', { endpoint }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'app_mismatch' });
    // Secret của App kia phải còn nguyên — đó là điều mà một chiếm đoạt sẽ phá.
    const rows = await readSubscriptions(db, await hashOf(endpoint));
    expect(rows).toEqual([
      expect.objectContaining({
        app: OTHER_APP,
        device_id: 'device-other-app',
        p256dh: 'their-p256dh',
        auth: 'their-auth',
      }),
    ]);
  });
});

/* -------------------------------------------------------------------------------------- */
/* PATCH / DELETE /v1/subscriptions/:id — FR-004 + FR-020                                        */
/* -------------------------------------------------------------------------------------- */

describe('PATCH /v1/subscriptions/:id — user disable (FR-004)', () => {
  let db: TestDatabase;
  let scope: SeededScope;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    scope = await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('disables the subscription and audits subscription_disabled', async () => {
    const response = await callRoute(
      db,
      `/v1/subscriptions/${scope.subscriptionId}`,
      applicationHeaders(),
      { method: 'PATCH', body: { status: 'disabled' } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      subscription_id: scope.subscriptionId,
      status: 'disabled',
    });

    const rows = await readSubscriptions(db, 'hash-ecoma-io');
    expect(rows).toEqual([
      expect.objectContaining({ status: 'disabled', disabled_reason: 'user_unregister' }),
    ]);

    const audit = await readAudit(db, scope.subscriptionId);
    expect(audit).toEqual([
      expect.objectContaining({
        event: 'subscription_disabled',
        actor: APP,
        entity_id: scope.subscriptionId,
      }),
    ]);
    // ⚠️ `changed: false` phải nằm trong detail để đọc audit phân biệt được lần gọi có tác
    // động với lần gọi lặp — hai thứ trùng `event` và `entity_id`.
    expect(JSON.parse(audit[0].detail_json)).toMatchObject({
      cause: 'user_unregister',
      previous_status: 'active',
      changed: true,
    });
  });

  it('is idempotent on an already-disabled subscription and still records the attempt', async () => {
    const path = `/v1/subscriptions/${scope.subscriptionId}`;
    await callRoute(db, path, applicationHeaders(), {
      method: 'PATCH',
      body: { status: 'disabled' },
    });
    const second = await callRoute(db, path, applicationHeaders(), {
      method: 'PATCH',
      body: { status: 'disabled' },
    });

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: 'disabled' });
    // ⚠️ FR-020 đòi `subscription_disabled` cho **thao tác**, không phải cho *kết quả* của
    // thao tác: hai lần bấm nút là hai thao tác quản lý có dấu vết. Nhánh audit `changed:
    // false` ở trên tồn tại chính vì thế.
    const audit = await readAudit(db, scope.subscriptionId);
    expect(audit).toHaveLength(2);
    expect(JSON.parse(audit[1].detail_json)).toMatchObject({ changed: false });
  });

  it.each([
    ['a status other than disabled', { status: 'active' }],
    ['an expired transition requested by the client', { status: 'expired' }],
    ['an empty body', {}],
  ])('rejects %s with 400 and changes nothing', async (_label, body) => {
    const response = await callRoute(
      db,
      `/v1/subscriptions/${scope.subscriptionId}`,
      applicationHeaders(),
      { method: 'PATCH', body },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_payload' });
    const rows = await readSubscriptions(db, 'hash-ecoma-io');
    expect(rows).toEqual([expect.objectContaining({ status: 'active' })]);
    expect(await readAudit(db, scope.subscriptionId)).toHaveLength(0);
  });

  it('returns 404 for a subscription that does not exist', async () => {
    const response = await callRoute(db, '/v1/subscriptions/sub-nope', applicationHeaders(), {
      method: 'PATCH',
      body: { status: 'disabled' },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'subscription_not_found' });
  });

  it('returns 403 for a subscription of another app', async () => {
    const other = await seedScope(db, { app: OTHER_APP });

    const response = await callRoute(
      db,
      `/v1/subscriptions/${other.subscriptionId}`,
      applicationHeaders(),
      { method: 'PATCH', body: { status: 'disabled' } },
    );

    expect(response.status).toBe(403);
    const rows = await readSubscriptions(db, `hash-${OTHER_APP}`);
    expect(rows).toEqual([expect.objectContaining({ status: 'active' })]);
  });
});

describe('DELETE /v1/subscriptions/:id — user unregister (FR-004, FR-020)', () => {
  let db: TestDatabase;
  let scope: SeededScope;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    scope = await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  it('revokes the subscription and audits subscription_removed, not subscription_disabled', async () => {
    const response = await callRoute(
      db,
      `/v1/subscriptions/${scope.subscriptionId}`,
      applicationHeaders(),
      { method: 'DELETE' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      subscription_id: scope.subscriptionId,
      status: 'disabled',
      // ⚠️ `revoked: true` **không** nói dòng đã bị xoá — §4.3: `DELETE` là logical revoke.
      revoked: true,
    });

    const rows = await readSubscriptions(db, 'hash-ecoma-io');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('disabled');

    // ⚠️ Hai event, hai câu hỏi: "ai đã khoá subscription này" (`PATCH`) và "ai đã gỡ nó khỏi
    // app của mình" (`DELETE`). Dùng chung một event là mất một câu trả lời khi đọc audit.
    const audit = await readAudit(db, scope.subscriptionId);
    expect(audit).toEqual([expect.objectContaining({ event: 'subscription_removed', actor: APP })]);
  });

  it('does not delete the row — physical deletion belongs to the retention policy', async () => {
    await callRoute(db, `/v1/subscriptions/${scope.subscriptionId}`, applicationHeaders(), {
      method: 'DELETE',
    });

    expect(await db.count('SELECT COUNT(*) AS n FROM push_subscriptions')).toBe(1);
  });

  it('returns 404 for an unknown subscription', async () => {
    const response = await callRoute(db, '/v1/subscriptions/sub-nope', applicationHeaders(), {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'subscription_not_found' });
  });

  it('reports the client-facing reason, never the provider body, for a disabled_reason', async () => {
    await callRoute(db, `/v1/subscriptions/${scope.subscriptionId}`, applicationHeaders(), {
      method: 'DELETE',
    });

    const rows = await readSubscriptions(db, 'hash-ecoma-io');
    // CHECK `push_subscriptions_disabled_reason_check` chỉ nhận bốn mã; một response body
    // của provider không có chỗ nào để chui vào cột này.
    expect(rows[0].disabled_reason).toBe('user_unregister');
  });
});

/* -------------------------------------------------------------------------------------- */
/* FR-020 — tập audit event đóng                                                                */
/* -------------------------------------------------------------------------------------- */

describe('audit vocabulary stays inside the FR-020 closed set', () => {
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

  it('writes no audit record for a registration, because FR-020 names no create event', async () => {
    const scope: SeededScope = {
      app: APP,
      userId: 'user',
      deviceId: 'device',
      subscriptionId: 'sub',
      providerId: 'prov',
      vapidKeyId: 'vapid-k1',
      notificationId: 'notif',
      deliveryId: 'deliv',
    };
    await callRoute(db, '/v1/subscriptions', applicationHeaders(), {
      method: 'POST',
      body: subscriptionBody(scope.deviceId, scope.userId),
    });

    // ⚠️ Tập event của FR-020 là **đóng 12 giá trị** và CHECK của schema chốt đúng tập đó;
    // không có `device_created`/`subscription_created`. Một `INSERT` với event ngoài tập sẽ
    // **tự nổ lên** bằng CHECK — nên "không có audit record cho đăng ký" là hành vi đúng,
    // và test này ghim nó lại để một ai đó thêm event mới phải sửa FR-020 trước.
    expect(await db.count('SELECT COUNT(*) AS n FROM audit_records')).toBe(0);
  });

  it('records an audit row whose event is one of the twelve the schema accepts', async () => {
    await callRoute(db, '/v1/subscriptions/sub', applicationHeaders(), { method: 'DELETE' });

    const events = await db.rows<{ event: string }>('SELECT event FROM audit_records');
    expect(events).toHaveLength(1);
    // CHECK của schema đã bảo đảm điều này bằng cách nổ — assert ở đây là để **tài liệu**:
    // đọc được thấy rõ tập event mà service dùng.
    expect(events[0].event).toBe('subscription_removed');
  });
});

/* -------------------------------------------------------------------------------------- */
/* GET /admin/v1/providers/:id — provider read single (FR-017, §4.2)                           */
/* -------------------------------------------------------------------------------------- */

describe('GET /admin/v1/providers/:providerId — provider read single (FR-017)', () => {
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

  it('returns the provider record of the caller app', async () => {
    const response = await callRoute(db, '/admin/v1/providers/prov?app=ecoma-io', adminHeaders());

    expect(response.status).toBe(200);
    // ⚠️ Response giữ **đúng shape record** của use case (`ProviderRecord`, camelCase) — cùng
    // convention với mọi route admin khác của service; không tự đặt tên snake_case riêng.
    const body = (await response.json()) as {
      providerId: string;
      app: string;
      status: string;
      emergencyHold: boolean;
    };
    expect(body).toMatchObject({
      providerId: 'prov',
      app: 'ecoma-io',
      status: 'enabled',
      emergencyHold: false,
    });
  });

  it('answers 404 provider_not_found for a provider of another app, indistinguishably from a missing one', async () => {
    // Provider `prov` thuộc `ecoma-io`; đọc nó qua scope của app khác phải **trông như**
    // không tồn tại — FR-007 cấm lộ sự tồn tại của entity ngoài scope.
    const response = await callRoute(db, '/admin/v1/providers/prov?app=other-app', adminHeaders());

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('provider_not_found');
  });

  it('answers 404 provider_not_found for a provider that does not exist', async () => {
    const response = await callRoute(
      db,
      '/admin/v1/providers/no-such-provider?app=ecoma-io',
      adminHeaders(),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('provider_not_found');
  });

  it('writes no audit record, because a read changes no state (FR-020 names only state-changing events)', async () => {
    await callRoute(db, '/admin/v1/providers/prov?app=ecoma-io', adminHeaders());

    expect(await db.count('SELECT COUNT(*) AS n FROM audit_records')).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------- */
/* GET /admin/v1/providers/:id/credentials — public VAPID key distribution                    */
/* -------------------------------------------------------------------------------------- */

describe('GET /admin/v1/providers/:providerId/credentials — public VAPID key distribution', () => {
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

  it('returns the public key per vapid_key_id for the caller app', async () => {
    const response = await callRoute(
      db,
      '/admin/v1/providers/prov/credentials?app=ecoma-io',
      adminHeaders(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      credentials: { vapid_key_id: string; public_key: string; status: string }[];
    };
    expect(body.credentials).toEqual([
      { vapid_key_id: 'vapid-k1', public_key: 'public-ecoma-io', status: 'active' },
    ]);
  });

  it('answers 404 provider_not_found for a provider of another app', async () => {
    const response = await callRoute(
      db,
      '/admin/v1/providers/prov/credentials?app=other-app',
      adminHeaders(),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('provider_not_found');
  });

  it('never exposes ciphertext or any private-key material in the response', async () => {
    const response = await callRoute(
      db,
      '/admin/v1/providers/prov/credentials?app=ecoma-io',
      adminHeaders(),
    );
    const text = await response.text();

    // Credential seed của fixture có ciphertext là bytes [1,2,3,4] — assert tập field của
    // response là tập đóng ba field an toàn, nên không có field nào khác (ciphertext, version,
    // credential_id…) dù fixture hay record đổi.
    const body = JSON.parse(text) as { credentials: Record<string, unknown>[] };
    for (const credential of body.credentials) {
      expect(Object.keys(credential).toSorted()).toEqual(['public_key', 'status', 'vapid_key_id']);
    }
  });
});

/* -------------------------------------------------------------------------------------- */
/* POST /internal/revalidate-endpoints — endpoint revalidation sweep (FR-003)                  */
/* -------------------------------------------------------------------------------------- */

describe('POST /internal/revalidate-endpoints — revalidation sweep (FR-003)', () => {
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

  it('keeps every subscription when the stored endpoints still satisfy the allowlist', async () => {
    // Fixture endpoint là `fcm.googleapis.com` — nằm trong default allowlist, sweep không
    // đụng gì. Assertion "không đổi gì" cũng là một bất biến của FR-003: re-validate
    // **không** được disable subscription hợp lệ.
    const response = await callRoute(
      db,
      '/internal/revalidate-endpoints?app=ecoma-io',
      adminHeaders(),
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scanned: number;
      disabled: number;
      valid: number;
      skipped_corrupt: number;
    };
    expect(body.scanned).toBe(1);
    expect(body).toMatchObject({ disabled: 0, valid: 1, skipped_corrupt: 0 });

    const rows = await db.rows<{ status: string }>(
      'SELECT status FROM push_subscriptions WHERE subscription_id = ?',
      'sub',
    );
    expect(rows[0].status).toBe('active');
  });

  it('disables the subscription with cause endpoint_revalidation_failed when the allowlist no longer admits the host', async () => {
    // Thu hẹp allowlist xuống một host không khớp fixture endpoint — cùng cơ chế mà một
    // policy change ở production sẽ dùng (`PUSH_ENDPOINT_HOST_ALLOWLIST`).
    const narrowed = { ...completeEnv(db), PUSH_ENDPOINT_HOST_ALLOWLIST: '["other.example"]' };
    const requestInit: RequestInit = { method: 'POST', headers: adminHeaders() };
    const response = await worker.fetch(
      new Request(
        'https://push-notification.test/internal/revalidate-endpoints?app=ecoma-io',
        requestInit,
      ),
      narrowed as unknown as PushWorkerEnv,
      {} as WorkerExecutionContext,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scanned: number;
      disabled: number;
      disabled_subscription_ids: string[];
    };
    expect(body.scanned).toBe(1);
    expect(body.disabled).toBe(1);
    expect(body.disabled_subscription_ids).toEqual(['sub']);

    const rows = await db.rows<{ status: string; disabled_reason: string | null }>(
      'SELECT status, disabled_reason FROM push_subscriptions WHERE subscription_id = ?',
      'sub',
    );
    expect(rows[0]).toMatchObject({
      status: 'disabled',
      disabled_reason: 'endpoint_revalidation_failed',
    });
  });

  it('answers 400 when the app query is missing', async () => {
    const response = await callRoute(db, '/internal/revalidate-endpoints', adminHeaders(), {
      method: 'POST',
    });

    expect(response.status).toBe(400);
  });
});
