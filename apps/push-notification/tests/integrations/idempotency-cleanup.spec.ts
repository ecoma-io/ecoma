/**
 * Cleanup idempotency record theo **đúng ba điều kiện canonical của FR-008** — chạy trên
 * D1 thật qua **ranh giới HTTP thật** (`POST /internal/idempotency/cleanup`, admin boundary).
 *
 * ⚠️ **Vì sao qua route chứ không gọi use case/repository.** Ba điều kiện là một bất biến
 * của **hành vi end-to-end**: một test gọi `deleteEligible` trực tiếp sẽ không phát hiện
 * được route chưa tồn tại, route dùng nhầm `queue_retention`, hay route xác thực sau khi đã
 * chạm D1. Assertion "401 trước lookup" của hai test đầu đến từ cùng requirement của mọi
 * route internal (`docs/applications/push-notification/01-architecture.md` §8.2/FR-019).
 *
 * ⚠️ Canonical điều kiện (`docs/applications/push-notification/02-requirements.md` FR-008):
 *  (i) mọi `Push Delivery` của notification đó đã terminal (`delivered`/`failed`/`expired`
 *      /`cancelled`);
 *  (ii) không còn outbox record `pending`/`publishing` nào cho bất kỳ delivery nào của
 *      notification đó;
 *  (iii) `now > created_at + idempotency_retention`.
 * Thiếu bất kỳ điều kiện nào → giữ. Record của notification có nhiều delivery chỉ được xoá
 * khi **tất cả** delivery terminal (không xoá theo từng delivery).
 *
 * ⚠️ **Retention là giá trị test do harness chọn** (`IDEMPOTENCY_RETENTION_MS: '7000007'` của
 * `completeEnv`), không phải giá trị đã chốt — launch gate ở `03-operations.md` §11. Test đọc
 * điều kiện (iii) bằng chính config đó.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetConfigCacheForTest } from '../../src/config';

import {
  T0,
  createTestDatabase,
  seedScope,
  type SeededScope,
  type TestDatabase,
} from './d1-harness';
import { callRoute } from './app-env';

/** Header admin — cùng token với `completeEnv` (`ADMIN_API_TOKEN: 'admin-token'`). */
function adminHeaders(): Record<string, string> {
  return { authorization: 'Bearer admin-token' };
}

/** Đường route cleanup — POST-only như mọi route internal khác. */
const CLEANUP_PATH = '/internal/idempotency/cleanup';

/** Idempotency record seed — principal của `seedScope` là `principal-1`. */
const PRINCIPAL = 'principal-1';
const KEY = 'cleanup-key-1';

/**
 * `now` của lượt cleanup — **đồng hồ thật**, không phải `T0`.
 *
 * ⚠️ **Vì sao không dùng `T0` của harness.** `T0 = 1_800_000_000_000` là một hằng cố định để
 * fixture có tuổi *tương đối* ổn định, nhưng nó nằm ở **tương lai** so với đồng hồ thật —
 * nên một record seed với `created_at` quanh `T0` **chưa bao giờ** đủ tuổi theo điều kiện
 * (iii), và mọi test "đủ cả ba điều kiện" sẽ đỏ với `deleted = 0`. Lượt cleanup đọc
 * `ports.clock.now()`, và ở đường HTTP thật clock là `systemClock` = `Date.now()` — nên test
 * phải dùng **cùng một đồng hồ** để điều kiện (iii) có nghĩa.
 *
 * ⚠️ Biên `RIPE_OFFSET` (10.000.000 ms) lớn hơn `idempotency_retention` của `completeEnv`
 * (7.000.007 ms) với biên an toàn vài giây — lệch thời gian giữa lúc test đọc `Date.now()`
 * và lúc route chạy không được làm một record "đủ tuổi" trở thành "chưa đủ tuổi".
 */
const NOW = Date.now();
const RIPE_OFFSET = 10_000_000;
/** Trong cửa sổ `idempotency_retention` (7.000.007 ms) — điều kiện (iii) phải **giữ**. */
const YOUNG_OFFSET = 1_000_000;

/** Đọc sự tồn tại của idempotency record để assert giữ/xoá. */
async function recordExists(
  db: TestDatabase,
  principalId: string,
  idempotencyKey: string,
): Promise<boolean> {
  return (
    (await db.count(
      `SELECT COUNT(*) AS n FROM notification_idempotency
       WHERE principal_id = ?1 AND idempotency_key = ?2`,
      principalId,
      idempotencyKey,
    )) > 0
  );
}

/** Seed một idempotency record trỏ tới notification đã có, với `created_at` do test chọn. */
async function seedIdempotency(
  db: TestDatabase,
  scope: SeededScope,
  options: { readonly createdAt?: number; readonly key?: string } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO notification_idempotency
       (app, principal_id, idempotency_key, request_hash, notification_id, created_at)
     VALUES ('ecoma-io', ?1, ?2, ?3, ?4, ?5)`,
    PRINCIPAL,
    options.key ?? KEY,
    `hash:${options.createdAt}`,
    scope.notificationId,
    options.createdAt ?? NOW - RIPE_OFFSET,
  );
}

/** Gọi route và trả về status + số record route báo đã xoá. */
async function callAndCount(
  db: TestDatabase,
): Promise<{ readonly status: number; readonly deleted: number }> {
  const response = await callRoute(db, CLEANUP_PATH, adminHeaders(), { method: 'POST' });
  const body = (await response.json()) as { deleted?: number };
  return { status: response.status, deleted: body.deleted ?? 0 };
}

describe('POST /internal/idempotency/cleanup — FR-008 canonical delete conditions', () => {
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

  it('answers 401 without touching D1 when the admin token is missing', async () => {
    db.probe.reset();
    const response = await callRoute(db, CLEANUP_PATH, {}, { method: 'POST' });

    expect(response.status).toBe(401);
    // ⚠️ Khẳng định cốt lõi của các route internal: xác thực **trước** mọi lookup.
    expect(db.probe.executed()).toBe(0);
    expect(db.probe.prepared()).toBe(0);
    expect(db.probe.batches()).toBe(0);
  });

  it('answers 401 without touching D1 when the admin token is wrong', async () => {
    db.probe.reset();
    const response = await callRoute(
      db,
      CLEANUP_PATH,
      { authorization: 'Bearer wrong-token' },
      { method: 'POST' },
    );

    expect(response.status).toBe(401);
    expect(db.probe.executed()).toBe(0);
    expect(db.probe.prepared()).toBe(0);
    expect(db.probe.batches()).toBe(0);
  });

  it('deletes nothing with a wrong token even though the record is ripe', async () => {
    // Record đã đủ tuổi — sai token thì không được xoá gì: auth đứng trước, và một caller
    // không xác thực không được đổi state nào.
    await seedIdempotency(db, scope, { createdAt: NOW - RIPE_OFFSET });

    const response = await callRoute(
      db,
      CLEANUP_PATH,
      { authorization: 'Bearer wrong-token' },
      { method: 'POST' },
    );

    expect(response.status).toBe(401);
    expect(await recordExists(db, PRINCIPAL, KEY)).toBe(true);
  });

  it('keeps the record while any delivery of the notification is non-terminal (i)', async () => {
    // Fixture seed delivery `pending` (non-terminal); (iii) thoả nhờ `created_at` quá xa —
    // như vậy **chỉ** (i) là điều đang bị kiểm.
    await seedIdempotency(db, scope, { createdAt: NOW - RIPE_OFFSET });

    const result = await callAndCount(db);

    expect(result.status).toBe(200);
    expect(result.deleted).toBe(0);
    expect(await recordExists(db, PRINCIPAL, KEY)).toBe(true);
  });

  it('keeps the record while an outbox intent is still pending (ii)', async () => {
    // Delivery `queued` + outbox record `pending` — (ii) chặn: intent vẫn còn đường publish.
    await db.run(
      `UPDATE push_deliveries SET status = 'queued', updated_at = ?1 WHERE delivery_id = ?2`,
      T0,
      scope.deliveryId,
    );
    await db.run(
      `INSERT INTO push_outbox
         (outbox_id, delivery_id, status, attempts, available_at, created_at, updated_at)
       VALUES ('ob-cleanup', ?1, 'pending', 1, ?2, ?3, ?3)`,
      scope.deliveryId,
      T0,
      T0 - 10_000,
    );
    await seedIdempotency(db, scope, { createdAt: NOW - RIPE_OFFSET });

    const result = await callAndCount(db);

    expect(result.status).toBe(200);
    expect(result.deleted).toBe(0);
    expect(await recordExists(db, PRINCIPAL, KEY)).toBe(true);
  });

  it('keeps the record while an outbox intent is still publishing with a live lease (ii)', async () => {
    // `publishing` là nhánh open intent thứ hai của (ii) — record đang giữ lease publisher.
    await db.run(
      `UPDATE push_deliveries SET status = 'queued', updated_at = ?1 WHERE delivery_id = ?2`,
      T0,
      scope.deliveryId,
    );
    await db.run(
      `INSERT INTO push_outbox
         (outbox_id, delivery_id, status, attempts, available_at, lease_expires_at,
          claimed_at, claimed_by, created_at, updated_at)
       VALUES ('ob-cleanup', ?1, 'publishing', 1, ?2, ?3, ?2, 'pub-1', ?4, ?4)`,
      scope.deliveryId,
      T0,
      T0 + 60_000,
      T0 - 10_000,
    );
    await seedIdempotency(db, scope, { createdAt: NOW - RIPE_OFFSET });

    const result = await callAndCount(db);

    expect(result.status).toBe(200);
    expect(result.deleted).toBe(0);
    expect(await recordExists(db, PRINCIPAL, KEY)).toBe(true);
  });

  it('keeps the record younger than idempotency_retention (iii)', async () => {
    // Đưa delivery về `delivered` (terminal) — như vậy **chỉ** (iii) là điều đang bị kiểm:
    // `created_at` vẫn trong cửa sổ `idempotency_retention` của `completeEnv` (7000007 ms).
    await db.run(
      `UPDATE push_deliveries SET status = 'delivered', delivered_at = ?1, updated_at = ?1
       WHERE delivery_id = ?2`,
      T0,
      scope.deliveryId,
    );
    await seedIdempotency(db, scope, { createdAt: NOW - YOUNG_OFFSET });

    const result = await callAndCount(db);

    expect(result.status).toBe(200);
    expect(result.deleted).toBe(0);
    expect(await recordExists(db, PRINCIPAL, KEY)).toBe(true);
  });

  it('deletes the record exactly when all three conditions hold', async () => {
    // Delivery `delivered` (terminal), không outbox record nào, `created_at` quá xa.
    await db.run(
      `UPDATE push_deliveries SET status = 'delivered', delivered_at = ?1, updated_at = ?1
       WHERE delivery_id = ?2`,
      T0,
      scope.deliveryId,
    );
    await seedIdempotency(db, scope, { createdAt: NOW - RIPE_OFFSET });

    const result = await callAndCount(db);

    expect(result.status).toBe(200);
    expect(result.deleted).toBe(1);
    expect(await recordExists(db, PRINCIPAL, KEY)).toBe(false);
  });

  it.each(['delivered', 'failed', 'cancelled', 'expired'])(
    'deletes the record when every delivery is %s and the other two conditions hold',
    async (status) => {
      await db.run(
        // ⚠️ `expired ⇔ expired_at NOT NULL` (`push_deliveries_expired_at_parity_check`) —
        // parity CHECK là lý do các cột timestamp terminal phải đi cùng một lệnh.
        `UPDATE push_deliveries
           SET status = ?1, expires_at = ?2, expired_at = ?3, delivered_at = ?4, failed_at = ?5,
               updated_at = ?2
         WHERE delivery_id = ?6`,
        status,
        T0,
        status === 'expired' ? T0 : null,
        status === 'delivered' ? T0 : null,
        status === 'failed' ? T0 : null,
        scope.deliveryId,
      );
      await seedIdempotency(db, scope, { createdAt: NOW - RIPE_OFFSET });

      const result = await callAndCount(db);

      expect(result.status).toBe(200);
      expect(result.deleted).toBe(1);
      expect(await recordExists(db, PRINCIPAL, KEY)).toBe(false);
    },
  );

  it('keeps a multi-delivery notification until every delivery is terminal', async () => {
    // Thêm delivery thứ hai **cùng notification**: record idempotency chỉ xoá được khi
    // **tất cả** delivery terminal (FR-008 — không xoá theo từng delivery).
    await db.run(
      `UPDATE push_deliveries SET status = 'delivered', delivered_at = ?1, updated_at = ?1
       WHERE delivery_id = ?2`,
      T0,
      scope.deliveryId,
    );
    await db.run(
      `INSERT INTO push_deliveries
         (delivery_id, notification_id, subscription_id, provider_id, user_id, device_id, app,
          transport, status, dispatch_generation, lease_expires_at, expires_at, created_at,
          updated_at)
       VALUES ('deliv-2', ?1, ?2, ?3, ?4, ?5, ?6, 'web', 'queued', 0, NULL, ?7, ?8, ?8)`,
      scope.notificationId,
      scope.subscriptionId,
      scope.providerId,
      scope.userId,
      scope.deviceId,
      scope.app,
      T0 + 3_600_000,
      T0,
    );
    await seedIdempotency(db, scope, { createdAt: NOW - RIPE_OFFSET });

    // Một terminal, một `queued`: giữ.
    const first = await callAndCount(db);
    expect(first.status).toBe(200);
    expect(first.deleted).toBe(0);
    expect(await recordExists(db, PRINCIPAL, KEY)).toBe(true);

    // Delivery cuối cùng terminal: bây giờ mới xoá.
    await db.run(
      `UPDATE push_deliveries SET status = 'delivered', delivered_at = ?1, updated_at = ?1
       WHERE delivery_id = 'deliv-2'`,
      T0,
    );
    const second = await callAndCount(db);
    expect(second.status).toBe(200);
    expect(second.deleted).toBe(1);
    expect(await recordExists(db, PRINCIPAL, KEY)).toBe(false);
  });

  it('keeps a multi-delivery notification while an outbox intent of any delivery is open', async () => {
    // Hai delivery đều terminal nhưng delivery 2 có outbox record `pending` — điều kiện (ii)
    // là "cho bất kỳ delivery nào", nên record phải được giữ.
    await db.run(
      `UPDATE push_deliveries SET status = 'delivered', delivered_at = ?1, updated_at = ?1
       WHERE delivery_id = ?2`,
      T0,
      scope.deliveryId,
    );
    await db.run(
      `INSERT INTO push_deliveries
         (delivery_id, notification_id, subscription_id, provider_id, user_id, device_id, app,
          transport, status, dispatch_generation, lease_expires_at, expires_at, created_at,
          updated_at)
       VALUES ('deliv-2', ?1, ?2, ?3, ?4, ?5, ?6, 'web', 'delivered', 0, NULL, ?7, ?8, ?8)`,
      scope.notificationId,
      scope.subscriptionId,
      scope.providerId,
      scope.userId,
      scope.deviceId,
      scope.app,
      T0 + 3_600_000,
      T0,
    );
    await db.run(
      `INSERT INTO push_outbox
         (outbox_id, delivery_id, status, attempts, available_at, created_at, updated_at)
       VALUES ('ob-cleanup', 'deliv-2', 'pending', 1, ?1, ?1, ?1)`,
      T0,
    );
    await seedIdempotency(db, scope, { createdAt: NOW - RIPE_OFFSET });

    const result = await callAndCount(db);

    expect(result.status).toBe(200);
    expect(result.deleted).toBe(0);
    expect(await recordExists(db, PRINCIPAL, KEY)).toBe(true);
  });

  it('is idempotent — a second call deletes nothing more and leaves other tables intact', async () => {
    await db.run(
      `UPDATE push_deliveries SET status = 'delivered', delivered_at = ?1, updated_at = ?1
       WHERE delivery_id = ?2`,
      T0,
      scope.deliveryId,
    );
    await seedIdempotency(db, scope, { createdAt: NOW - RIPE_OFFSET });

    const first = await callAndCount(db);
    expect(first.deleted).toBe(1);

    // Lượt thứ hai: không còn record nào thoả — trả 0 và không đổi gì. State unchanged.
    const before = await db.count(`SELECT COUNT(*) AS n FROM push_deliveries`);
    const second = await callAndCount(db);
    expect(second.deleted).toBe(0);
    expect(await db.count(`SELECT COUNT(*) AS n FROM push_deliveries`)).toBe(before);
  });

  it('does not resurrect or mutate a terminal delivery when deleting its idempotency record', async () => {
    await db.run(
      `UPDATE push_deliveries SET status = 'delivered', delivered_at = ?1, updated_at = ?1
       WHERE delivery_id = ?2`,
      T0,
      scope.deliveryId,
    );
    await seedIdempotency(db, scope, { createdAt: NOW - RIPE_OFFSET });

    const result = await callAndCount(db);

    expect(result.deleted).toBe(1);
    const rows = await db.rows<{ status: string; delivered_at: number | null }>(
      `SELECT status, delivered_at FROM push_deliveries WHERE delivery_id = ?1`,
      scope.deliveryId,
    );
    expect(rows[0]).toMatchObject({ status: 'delivered', delivered_at: T0 });
  });

  it('sweeps only ripe records — a not-yet-ripe record in the same table survives', async () => {
    // Hai record: một đủ tuổi (xoá), một trẻ (giữ) — chứng minh lượt quét lọc theo điều
    // kiện tuổi thay vì xoá toàn bảng.
    await db.run(
      `UPDATE push_deliveries SET status = 'delivered', delivered_at = ?1, updated_at = ?1
       WHERE delivery_id = ?2`,
      T0,
      scope.deliveryId,
    );
    await seedIdempotency(db, scope, { createdAt: NOW - RIPE_OFFSET });
    await seedIdempotency(db, scope, { createdAt: NOW - YOUNG_OFFSET, key: 'cleanup-key-young' });

    const result = await callAndCount(db);

    expect(result.status).toBe(200);
    expect(result.deleted).toBe(1);
    expect(await recordExists(db, PRINCIPAL, KEY)).toBe(false);
    expect(await recordExists(db, PRINCIPAL, 'cleanup-key-young')).toBe(true);
  });
});
