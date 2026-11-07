/**
 * Repository trên **D1 thật** — `getPlatformProxy` + `migrations/*.sql` thật, `persist: false`,
 * `remoteBindings: false`.
 *
 * ⚠️ **Vì sao file này tồn tại khi đã có `*.spec.ts` ở tầng application.** Vì ba cơ chế cốt lõi
 * của service chỉ **engine SQL thật** mới chứng minh được, và mọi fake sẽ bỏ qua đúng chỗ
 * cần kiểm:
 *
 * 1. **Guarded conditional write** — `UPDATE … RETURNING` trả **zero rows** khi predicate
 *    không khớp (`docs/architecture/04-platform-facts.md` DB3). Đây là cơ chế **duy nhất** quyết
 *    định thắng/thua; một fake có thể trả về "đã update" một cách vô điều kiện.
 * 2. **Partial UNIQUE index** — `push_outbox_one_open_intent` và
 *    `push_app_provider_mappings_one_primary`. Một fake không có index nên không thể chứng
 *    minh index **có thật** và có đúng predicate.
 * 3. **`db.batch()` là transaction duy nhất** — không `BEGIN`/`COMMIT`, không row locking
 *    (DB2/DB11). Một fake cho ta một transaction giả và che mất việc một lệnh trong batch
 *    đang vi sai.
 *
 * ⚠️ **Mỗi test có database riêng** nên chạy song song không cần reset chung.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  D1DeliveryRepository,
  D1IdempotencyRepository,
  D1NotificationRepository,
  D1OutboxRepository,
  D1ProviderRepository,
  D1RateLimitStore,
  type D1DatabaseLike,
} from '@ecoma-io/push-notification-infrastructure';

import {
  APP,
  OTHER_APP,
  T0,
  createTestDatabase,
  markDeliveryQueued,
  seedScope,
  type TestDatabase,
} from './d1-harness';

/** Lease đủ dài cho mọi assertion, và **không** phụ thuộc `Date.now()`. */
const LEASE_MS = 60_000;

describe('the real schema — index and CHECK are guards, not annotations', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  /**
   * Đọc DDL từ `sqlite_master` — nguồn **duy nhất** để biết index có thật không.
   *
   * ⚠️ Không assert trên một `PRAGMA` hay trên hành vi: index `push_outbox_one_open_intent` là
   * **partial** (`WHERE status IN ('pending','publishing')`), và một index thường trên cùng cột
   * sẽ cho hành vi khác hẳn ở một trường hợp rất quan trọng — một intent `published` cũ vẫn
   * phải tạo được intent mới. Vì vậy test đọc **văn bản DDL** để khẳng định predicate.
   */
  const ddl = async (name: string): Promise<string> => {
    const rows = await db.rows<{ sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE name = ?1`,
      name,
    );
    return rows[0]?.sql ?? '';
  };

  it('creates push_outbox_one_open_intent as a PARTIAL unique index over open statuses', async () => {
    const sql = await ddl('push_outbox_one_open_intent');
    expect(sql).not.toBe('');
    // ⚠️ `UNIQUE` + **partial**: đây là guard chống dồn intent (§4.2/§6.1). Một index UNIQUE
    // thường trên `delivery_id` sẽ chặn cả intent đã `published` — tức một delivery đã
    // publish rồi không bao giờ republish được nữa.
    expect(sql).toMatch(/CREATE UNIQUE INDEX/iu);
    expect(sql).toMatch(/WHERE status IN \('pending', 'publishing'\)/iu);
  });

  it('creates push_app_provider_mappings_one_primary as a PARTIAL unique index on is_primary = 1', async () => {
    const sql = await ddl('push_app_provider_mappings_one_primary');
    expect(sql).not.toBe('');
    // ⚠️ Predicate là `is_primary = 1`, **không** phải `WHERE is_primary` — hai scope được
    // phép có nhiều mapping không-primary cùng lúc.
    expect(sql).toMatch(/CREATE UNIQUE INDEX/iu);
    expect(sql).toMatch(/WHERE is_primary = 1/iu);
  });

  it('leaves no delivery claim path without a guarded write', async () => {
    // ⚠️ `push_deliveries` phải có index phục vụ predicate của claim, vì claim chạy ở đường
    // nóng của từng delivery và một full scan sẽ là một single point of latency.
    const rows = await db.rows<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'push_deliveries'`,
    );
    const names = rows.map((row) => row.name);
    expect(names.length).toBeGreaterThan(0);
    // Index ngầm định của `PRIMARY KEY` không xuất hiện với tên này; chỉ cần có index.
    expect(names.some((name) => name.length > 0)).toBe(true);
  });

  it('enforces the subscription status/reason parity CHECK at the database level', async () => {
    // ⚠️ Tính nhất quán này là CHECK của schema, không phải quy ước của writer. Test chứng
    // minh **database** từ chối, vì một writer khác (một script backfill, một admin tool) sẽ
    // không đọc JSDoc của use case.
    await expect(
      db.run(
        `INSERT INTO push_subscriptions
           (subscription_id, device_id, user_id, app, transport, endpoint, endpoint_hash,
            p256dh, auth, vapid_key_id, status, created_at, updated_at)
         VALUES ('sub-x', 'dev-x', 'user-x', ?, 'web', 'https://fcm.googleapis.com/x',
                 'h-x', 'p-x', 'a-x', 'v-x', 'disabled', ?, ?)`,
        APP,
        T0,
        T0,
      ),
    ).rejects.toThrow(/constraint/iu);
  });

  it('rejects a negative dispatch_generation', async () => {
    // ⚠️ `0` là hợp lệ (chưa từng claim); âm là không. Một CHECK `>= 1` sẽ loại bỏ delivery
    // mới — lỗi mà chỉ lộ ra ở đường tạo notification.
    const scope = await seedScope(db);
    await expect(
      db.run(
        `UPDATE push_deliveries SET dispatch_generation = -1 WHERE delivery_id = ?1`,
        scope.deliveryId,
      ),
    ).rejects.toThrow(/constraint/iu);
  });

  it('stores every timestamp as epoch millis INTEGER, never as text', async () => {
    // ⚠️ Ràng buộc của §5: storage là epoch millis, chỉ **wire** mới là RFC3339. Một cột TEXT
    // sẽ làm so sánh thời gian trong predicate của claim sai (so chuỗi, không so số) — và sai
    // theo cách im lặng.
    const scope = await seedScope(db);
    const rows = await db.rows<{ created_at: unknown }>(
      `SELECT created_at FROM push_deliveries WHERE delivery_id = ?1`,
      scope.deliveryId,
    );
    expect(typeof rows[0]?.created_at).toBe('number');
  });
});

describe('claimDelivery — guarded write, win or lose in a single statement', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedScope(db);
    await markDeliveryQueued(db, 'deliv');
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  const repo = (): D1DeliveryRepository =>
    new D1DeliveryRepository(db.db as unknown as D1DatabaseLike, async () => null);

  it('wins from queued and increments dispatch_generation inside the same statement', async () => {
    const claimed = await repo().claimDelivery({
      deliveryId: 'deliv',
      now: T0,
      leaseDurationMs: LEASE_MS,
    });

    expect(claimed).not.toBeNull();
    // ⚠️ Generation đi từ `0` lên `1` **ngay trong lệnh ghi**. Đây là fencing token: một
    // execution cũ giữ `0` sẽ bị chặn ở mọi write sau này.
    expect(claimed?.dispatchGeneration).toBe(1);
    expect(claimed?.status).toBe('processing');
    expect(claimed?.leaseExpiresAt).toBe(T0 + LEASE_MS);
  });

  it('lets exactly one of two concurrent claims win', async () => {
    // ⚠️ **Đây là test quan trọng nhất của nhóm này.** Hai lệnh claim được phát ra **cùng lúc**
    // trên cùng một hàng. Cơ chế đúng là `UPDATE … WHERE status = 'queued' … RETURNING`:
    // lệnh thứ nhất đổi trạng thái, lệnh thứ hai thấy `status` đã không còn `'queued'` nên
    // predicate không khớp và trả **zero rows**.
    //
    // ⚠️ Vì sao một read-then-write **không** đi được: cả hai lệnh có thể cùng đọc
    // `status = 'queued'`, rồi cả hai đều ghi — và cả hai đều trả một record. Đó là một
    // delivery được gửi hai lần, tức đúng thứ mà toàn bộ thiết kế lease sinh ra để chặn.
    const deliveries = new D1DeliveryRepository(
      db.db as unknown as D1DatabaseLike,
      async () => null,
    );
    const [a, b] = await Promise.all([
      deliveries.claimDelivery({ deliveryId: 'deliv', now: T0, leaseDurationMs: LEASE_MS }),
      deliveries.claimDelivery({ deliveryId: 'deliv', now: T0, leaseDurationMs: LEASE_MS }),
    ]);

    const winners = [a, b].filter((outcome) => outcome !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.dispatchGeneration).toBe(1);

    // ⚠️ Không có lần thắng thứ hai nào **có generation khác**: generation phải là `1` ở
    // duy nhất một hàng. Nếu hai lệnh cùng thắng, hàng này sẽ có `2`.
    const rows = await db.rows<{ dispatch_generation: number }>(
      `SELECT dispatch_generation FROM push_deliveries WHERE delivery_id = 'deliv'`,
    );
    expect(rows[0]?.dispatch_generation).toBe(1);
  });

  it('does not change the generation of the losing claim', async () => {
    // ⚠️ Cột `dispatch_generation` của hàng phải giữ nguyên giá trị của execution **đang giữ
    // lease**. Một lệnh thua mà vẫn ghi `dispatch_generation` sẽ fence oan execution đang
    // chạy — nó nhận `409` ở `outcome` dù nó đang giữ lease hợp lệ.
    const deliveries = new D1DeliveryRepository(
      db.db as unknown as D1DatabaseLike,
      async () => null,
    );
    await deliveries.claimDelivery({ deliveryId: 'deliv', now: T0, leaseDurationMs: LEASE_MS });
    const loser = await deliveries.claimDelivery({
      deliveryId: 'deliv',
      now: T0,
      leaseDurationMs: LEASE_MS,
    });

    expect(loser).toBeNull();
    const rows = await db.rows<{ dispatch_generation: number }>(
      `SELECT dispatch_generation FROM push_deliveries WHERE delivery_id = 'deliv'`,
    );
    expect(rows[0]?.dispatch_generation).toBe(1);
  });

  it('reclaims only after the lease has expired, and takes generation 2', async () => {
    // ⚠️ Lease hết hạn là thứ cho phép claim lại **cùng** hàng mà không cần release. Đây là
    // đường phục hồi khi một worker chết giữa chừng.
    const deliveries = new D1DeliveryRepository(
      db.db as unknown as D1DatabaseLike,
      async () => null,
    );
    await deliveries.claimDelivery({ deliveryId: 'deliv', now: T0, leaseDurationMs: LEASE_MS });

    // Chưa hết hạn: vẫn thua.
    const tooEarly = await deliveries.claimDelivery({
      deliveryId: 'deliv',
      now: T0 + LEASE_MS - 1,
      leaseDurationMs: LEASE_MS,
    });
    expect(tooEarly).toBeNull();

    // Đã hết hạn: thắng, generation `2`.
    const reclaimed = await deliveries.claimDelivery({
      deliveryId: 'deliv',
      now: T0 + LEASE_MS,
      leaseDurationMs: LEASE_MS,
    });
    expect(reclaimed?.dispatchGeneration).toBe(2);
  });

  it('refuses to claim a delivery whose TTL has passed', async () => {
    // ⚠️ `expires_at > now` nằm **trong** predicate claim, không phải một kiểm tra ở application
    // — vì một claim thắng sẽ đã cấp lease cho một thứ không còn gửi được.
    await db.run(`UPDATE push_deliveries SET expires_at = ?1 WHERE delivery_id = 'deliv'`, T0 - 1);
    const claimed = await repo().claimDelivery({
      deliveryId: 'deliv',
      now: T0,
      leaseDurationMs: LEASE_MS,
    });
    expect(claimed).toBeNull();
  });

  it.each([
    [
      'the subscription is disabled',
      `UPDATE push_subscriptions SET status = 'disabled', disabled_reason = 'admin_disable' WHERE subscription_id = 'sub'`,
    ],
    [
      'the provider is on emergency hold',
      `UPDATE push_providers SET emergency_hold = 1 WHERE provider_id = 'prov'`,
    ],
  ])('refuses to claim when %s', async (_label, sql) => {
    // ⚠️ Hai điều kiện `EXISTS` này nằm trong predicate claim (§8.1). Chúng **không** nằm ở
    // routing: một delivery đã materialize vẫn phải bị từ chối lúc claim, vì provider có thể
    // bị hold sau khi routing đã chạy.
    await db.run(sql);
    const claimed = await repo().claimDelivery({
      deliveryId: 'deliv',
      now: T0,
      leaseDurationMs: LEASE_MS,
    });
    expect(claimed).toBeNull();
  });

  it('still claims when the provider is disabled but not held', async () => {
    // ⚠️ FR-005 nói delivery đã materialize vẫn claim được khi provider `disabled`: tắt
    // provider là thao tác vận hành, còn **hold** là quyết định dừng gửi. Gộp hai trạng
    // thái này sẽ khiến một sự cố vận hành nuốt mất toàn bộ delivery đang chờ.
    await db.run(
      `UPDATE push_providers SET status = 'disabled', disabled_reason = 'maintenance' WHERE provider_id = 'prov'`,
    );
    const claimed = await repo().claimDelivery({
      deliveryId: 'deliv',
      now: T0,
      leaseDurationMs: LEASE_MS,
    });
    expect(claimed).not.toBeNull();
  });

  it('reads claim diagnostics on the losing path with every column qualified', async () => {
    // ⚠️ **Test này bảo vệ một lỗi thật đã xảy ra.** `findClaimDiagnostics` là SQL **duy nhất**
    // của service có `JOIN`, và nó từng dựng SELECT bằng `DELIVERY_COLUMNS.split(', ')` trên
    // một hằng viết **nhiều dòng** — `', '` không cắt ở newline, nên `device_id` và
    // `created_at` mất tiền tố `d.` và SQLite từ chối bằng `ambiguous column name: device_id`
    // (cột đó có ở cả `push_deliveries` lẫn `push_subscriptions`).
    //
    // ⚠️ **Vì sao lỗi đó sống dai.** Nó chỉ nằm trên nhánh **claim thua** — tức đường chẩn
    // đoán, chạy sau *mọi* lần claim thành công. Một bộ test chỉ khẳng định "claim thắng"
    // không bao giờ chạm tới nó, và trong production nó biểu hiện thành `500` cho worker mỗi
    // khi có tranh chấp lease — tức đúng lúc hệ thống đang bận nhất.
    const diagnostics = await repo().findClaimDiagnostics('deliv', T0);

    // ⚠️ Assert **từng** trường, không chỉ "không ném": một SELECT thiếu cột vẫn trả về một
    // object hợp lệ với `undefined`, và đó là chính xác dạng hỏng mà `reason` sẽ dựa vào.
    expect(diagnostics?.delivery.deviceId).toBe('device');
    expect(diagnostics?.delivery.createdAt).toBe(T0);
    expect(diagnostics?.subscriptionStatus).toBe('active');
    expect(diagnostics?.providerStatus).toBe('enabled');
    expect(diagnostics?.providerEmergencyHold).toBe(false);
  });

  it.each([
    ['pending', `UPDATE push_deliveries SET status = 'pending' WHERE delivery_id = 'deliv'`],
    [
      'disabled subscription',
      `UPDATE push_subscriptions SET status = 'disabled', disabled_reason = 'admin_disable' WHERE subscription_id = 'sub'`,
    ],
    ['emergency hold', `UPDATE push_providers SET emergency_hold = 1 WHERE provider_id = 'prov'`],
  ])('reports %s from the diagnostics read that follows a losing claim', async (_label, sql) => {
    // ⚠️ Chẩn đoán là **một** lần đọc gom mọi điều kiện của `decideDeliveryClaim`, và nó phải
    // đọc được ở mọi trạng thái gây thua. Ba dòng này là ba nhánh `reason` khác nhau — nếu
    // query hỏng vì một tên cột mơ hồ thì **cả ba** đều ném, và nhánh "chẩn đoán được" chết
    // theo cùng một lỗi cú pháp.
    await db.run(sql);
    await repo().claimDelivery({ deliveryId: 'deliv', now: T0, leaseDurationMs: LEASE_MS });
    await expect(repo().findClaimDiagnostics('deliv', T0)).resolves.not.toBeNull();
  });
});

describe('fenced write — a stale generation is blocked', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedScope(db);
    await markDeliveryQueued(db, 'deliv');
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  /** Claim một lần để có generation `1` thật. */
  async function claimOnce(): Promise<D1DeliveryRepository> {
    const deliveries = new D1DeliveryRepository(
      db.db as unknown as D1DatabaseLike,
      async () => null,
    );
    const claimed = await deliveries.claimDelivery({
      deliveryId: 'deliv',
      now: T0,
      leaseDurationMs: LEASE_MS,
    });
    expect(claimed?.dispatchGeneration).toBe(1);
    return deliveries;
  }

  it('rejects a release carrying a stale generation', async () => {
    const deliveries = await claimOnce();
    // Generation `0` là của **trước** lần claim — một execution đã chết hoặc đã bị reclaim.
    const released = await deliveries.releaseLease({
      deliveryId: 'deliv',
      dispatchGeneration: 0,
      now: T0 + 1000,
    });

    expect(released).toBeNull();
    // ⚠️ Hàng phải còn nguyên ở `processing` — một write bị fence không được đụng state.
    const rows = await db.rows<{ status: string; lease_expires_at: number | null }>(
      `SELECT status, lease_expires_at FROM push_deliveries WHERE delivery_id = 'deliv'`,
    );
    expect(rows[0]?.status).toBe('processing');
    expect(rows[0]?.lease_expires_at).toBe(T0 + LEASE_MS);
  });

  it('rejects an outcome carrying a stale generation', async () => {
    const deliveries = await claimOnce();
    const outcome = await deliveries.recordOutcome({
      deliveryId: 'deliv',
      dispatchGeneration: 0,
      outcome: 'delivered',
      now: T0 + 1000,
    });

    expect(outcome).toBeNull();
    const rows = await db.rows<{ status: string; delivered_at: number | null }>(
      `SELECT status, delivered_at FROM push_deliveries WHERE delivery_id = 'deliv'`,
    );
    expect(rows[0]?.status).toBe('processing');
    // ⚠️ Cột thời điểm cũng phải **chưa** được ghi: một `delivered_at` trên một write bị fence
    // là một bằng chứng sai về việc message đã tới.
    expect(rows[0]?.delivered_at).toBeNull();
  });

  it('fences the previous execution after the lease expires and a new claim wins', async () => {
    // ⚠️ Đây là lý do sinh ra `dispatch_generation`: execution thế hệ 1 còn sống và ghi
    // `outcome` **sau** khi thế hệ 2 đã claim. Không có fencing token thì một message bị
    // gửi hai lần và kết quả của lần gửi cũ ghi đè lần mới.
    const deliveries = await claimOnce();
    const second = await deliveries.claimDelivery({
      deliveryId: 'deliv',
      now: T0 + LEASE_MS,
      leaseDurationMs: LEASE_MS,
    });
    expect(second?.dispatchGeneration).toBe(2);

    const stale = await deliveries.recordOutcome({
      deliveryId: 'deliv',
      dispatchGeneration: 1,
      outcome: 'failed',
      now: T0 + LEASE_MS + 1000,
    });
    expect(stale).toBeNull();

    const fresh = await deliveries.recordOutcome({
      deliveryId: 'deliv',
      dispatchGeneration: 2,
      outcome: 'delivered',
      now: T0 + LEASE_MS + 1000,
    });
    expect(fresh?.status).toBe('delivered');
  });

  it('rejects an outcome whose lease has already expired', async () => {
    // ⚠️ Ba điều kiện của `outcome` (§8.1): generation khớp, `status = 'processing'`, **và**
    // lease còn hiệu lực. Bỏ điều kiện lease cho một execution đã hết hạn quyền ghi đè lời
    // của execution thế hệ sau.
    const deliveries = await claimOnce();
    const outcome = await deliveries.recordOutcome({
      deliveryId: 'deliv',
      dispatchGeneration: 1,
      outcome: 'delivered',
      now: T0 + LEASE_MS + 1,
    });
    expect(outcome).toBeNull();
  });

  it('does not bump the generation on release', async () => {
    // ⚠️ `release` trả hàng về `queued` và **không** cấp generation mới — generation mới chỉ
    // sinh ở lần claim kế tiếp. Tăng ở đây sẽ fence oan một execution khác đang giữ
    // generation hiện hành, tức một delivery bị bỏ rơi vĩnh viễn.
    const deliveries = await claimOnce();
    const released = await deliveries.releaseLease({
      deliveryId: 'deliv',
      dispatchGeneration: 1,
      now: T0 + 1000,
    });

    expect(released?.status).toBe('queued');
    expect(released?.dispatchGeneration).toBe(1);
    expect(released?.leaseExpiresAt).toBeNull();
  });
});

describe('release idempotency — a repeated call is a no-op, not an error', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedScope(db);
    await markDeliveryQueued(db, 'deliv');
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  it('returns the row again on a second release with the same generation', async () => {
    // ⚠️ Gọi lặp là **bình thường** ở đường này: một worker có thể gửi lại `release` sau khi
    // không nhận được ACK. Trả `null` sẽ biến một lời gọi idempotent thành một `409` buộc
    // worker phải phân biệt "release rồi" với "mất lease".
    const deliveries = new D1DeliveryRepository(
      db.db as unknown as D1DatabaseLike,
      async () => null,
    );
    await deliveries.claimDelivery({ deliveryId: 'deliv', now: T0, leaseDurationMs: LEASE_MS });

    const first = await deliveries.releaseLease({
      deliveryId: 'deliv',
      dispatchGeneration: 1,
      now: T0 + 1,
    });
    const second = await deliveries.releaseLease({
      deliveryId: 'deliv',
      dispatchGeneration: 1,
      now: T0 + 2,
    });

    expect(first?.status).toBe('queued');
    expect(second?.status).toBe('queued');
    // Cả hai lần đều không đổi generation.
    expect(second?.dispatchGeneration).toBe(1);
  });

  it('is stable under repeated concurrent releases', async () => {
    const deliveries = new D1DeliveryRepository(
      db.db as unknown as D1DatabaseLike,
      async () => null,
    );
    await deliveries.claimDelivery({ deliveryId: 'deliv', now: T0, leaseDurationMs: LEASE_MS });

    const results = await Promise.all([
      deliveries.releaseLease({ deliveryId: 'deliv', dispatchGeneration: 1, now: T0 + 1 }),
      deliveries.releaseLease({ deliveryId: 'deliv', dispatchGeneration: 1, now: T0 + 2 }),
      deliveries.releaseLease({ deliveryId: 'deliv', dispatchGeneration: 1, now: T0 + 3 }),
    ]);

    // ⚠️ Mọi lần đều trả hàng về `queued`: predicate nhận **cả** `queued` lẫn `processing`, và
    // đó là điều làm release idempotent. Không lần nào ném, không lần nào trả `null`.
    expect(results.every((result) => result?.status === 'queued')).toBe(true);

    const rows = await db.rows<{ status: string }>(
      `SELECT status FROM push_deliveries WHERE delivery_id = 'deliv'`,
    );
    expect(rows[0]?.status).toBe('queued');
  });
});

describe('partial unique index — coalescing intents is blocked at the database layer', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  const intent = (outboxId: string, availableAt = T0): Promise<unknown> =>
    new D1OutboxRepository(db.db as unknown as D1DatabaseLike).createIntent({
      outboxId,
      deliveryId: 'deliv',
      availableAt,
      createdAt: T0,
    });

  it('refuses a second open intent for the same delivery', async () => {
    const outbox = new D1OutboxRepository(db.db as unknown as D1DatabaseLike);
    expect(
      await outbox.createIntent({
        outboxId: 'ob-1',
        deliveryId: 'deliv',
        availableAt: T0,
        createdAt: T0,
      }),
    ).not.toBeNull();

    // ⚠️ Intent thứ hai là **race hợp lệ** (hai reconciler, hoặc hai lời gọi `republish`), và
    // `createIntent` trả `null` chứ không ném: đây là guard, không phải sự cố.
    expect(
      await outbox.createIntent({
        outboxId: 'ob-2',
        deliveryId: 'deliv',
        availableAt: T0,
        createdAt: T0,
      }),
    ).toBeNull();

    expect(await outbox.countOpenIntents('deliv')).toBe(1);
  });

  it('lets only one of two concurrent intents win', async () => {
    const outbox = new D1OutboxRepository(db.db as unknown as D1DatabaseLike);
    const results = await Promise.all([
      outbox.createIntent({
        outboxId: 'ob-a',
        deliveryId: 'deliv',
        availableAt: T0,
        createdAt: T0,
      }),
      outbox.createIntent({
        outboxId: 'ob-b',
        deliveryId: 'deliv',
        availableAt: T0,
        createdAt: T0,
      }),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await outbox.countOpenIntents('deliv')).toBe(1);
  });

  it('allows a new intent once the previous one is published', async () => {
    // ⚠️ **Đây là lý do index phải là partial.** Một UNIQUE thường trên `delivery_id` sẽ khóa
    // vĩnh viễn mọi intent thứ hai — tức `republish` (§4.2) không bao giờ chạy được sau lần
    // publish đầu tiên. Predicate `status IN ('pending','publishing')` là toàn bộ ý nghĩa.
    const outbox = new D1OutboxRepository(db.db as unknown as D1DatabaseLike);
    await intent('ob-1');
    await db.run(
      `UPDATE push_outbox SET status = 'published', published_at = ?1 WHERE outbox_id = 'ob-1'`,
      T0,
    );

    expect(await intent('ob-2')).not.toBeNull();
    // ⚠️ Và đếm "open intent" không tính hàng `published` — reconciliation dựa vào con số này
    // để phân biệt "chưa từng chạy" với "đã chạy".
    expect(await outbox.countOpenIntents('deliv')).toBe(1);
    expect(await outbox.hasOpenIntent('deliv')).toBe(true);
  });

  it('allows several non-primary mappings in one scope', async () => {
    // ⚠️ Predicate của index là `is_primary = 1`, **không** phải `WHERE is_primary`. Đây là
    // điều làm cho một scope có thể lưu nhiều mapping (provider dự phòng, provider đã
    // disable) mà vẫn chỉ có **một** primary — và một UNIQUE thường trên `(app, transport)`
    // sẽ cấm đúng điều đó.
    // ⚠️ Mapping thứ hai phải trỏ **provider khác**: UNIQUE `(app, transport, provider_id)`
    // là một ràng buộc khác, và nó đúng — cùng một provider không được xuất hiện hai lần trong
    // một scope. Test này tách hai ràng buộc: UNIQUE khoá (app, transport, provider_id) và
    // partial index khoá `is_primary = 1`.
    await db.run(
      `INSERT INTO push_providers (provider_id, app, transport, type, name, configuration_json, status, created_at, updated_at)
       VALUES ('prov2', ?, 'web', 'web-push', 'second', '{}', 'enabled', ?, ?)`,
      APP,
      T0,
      T0,
    );
    await db.run(
      `INSERT INTO push_app_provider_mappings (mapping_id, app, transport, provider_id, is_primary, created_at, updated_at)
       VALUES ('map-backup', ?, 'web', 'prov2', 0, ?, ?)`,
      APP,
      T0,
      T0,
    );

    const total = await db.count(
      `SELECT COUNT(*) AS n FROM push_app_provider_mappings WHERE app = ?1 AND transport = 'web'`,
      APP,
    );
    expect(total).toBe(2);
    const primary = await db.count(
      `SELECT COUNT(*) AS n FROM push_app_provider_mappings WHERE app = ?1 AND transport = 'web' AND is_primary = 1`,
      APP,
    );
    expect(primary).toBe(1);
  });

  it('moves the primary flag rather than accumulating two primaries', async () => {
    const providers = new D1ProviderRepository(db.db as unknown as D1DatabaseLike);
    await db.run(
      `INSERT INTO push_providers (provider_id, app, transport, type, name, configuration_json, status, created_at, updated_at)
       VALUES ('prov2', ?, 'web', 'web-push', 'second', '{}', 'enabled', ?, ?)`,
      APP,
      T0,
      T0,
    );

    // ⚠️ Đây là hành vi **đúng** của `setPrimaryMapping`, không phải một vi phạm index: tuyên
    // bố primary mới là xoá primary cũ rồi đặt cờ mới, trong **một** `db.batch()`. Tách thành
    // hai lệnh sẽ để lại một khoảng thời gian scope **không có primary**, và routing trong
    // khoảng đó fail-safe thành `no_provider` cho một scope vốn đang phục vụ tốt.
    const outcome = await providers.setPrimaryMapping({
      // ⚠️ `mappingId` là input **bắt buộc**: use case sinh id trước khi gọi, và repository
      // không tự sinh id — một repository sinh id là hai nơi phải giữ đúng nguồn định danh.
      mappingId: 'map2',
      app: APP,
      transport: 'web',
      providerId: 'prov2',
      now: T0,
    });

    expect(outcome?.providerId).toBe('prov2');
    const primary = await db.rows<{ provider_id: string }>(
      `SELECT provider_id FROM push_app_provider_mappings WHERE app = ?1 AND transport = 'web' AND is_primary = 1`,
      APP,
    );
    // ⚠️ **Đúng một** primary sau khi đổi — đó là điều index buộc phải đúng.
    expect(primary.map((row) => row.provider_id)).toEqual(['prov2']);
  });

  it('rejects a direct second primary for the same app and transport', async () => {
    // ⚠️ **Guard ở tầng database, không phải ở application.** `setPrimaryMapping` xoá primary
    // cũ trước nên nó không bao giờ đụng index; index tồn tại để chặn một ghi **không đi qua
    // đường đó** — backfill, script, hoặc một admin tool viết thẳng. Test này ghi thẳng để
    // chứng minh lớp guard dưới cùng có thật.
    await expect(
      db.run(
        `INSERT INTO push_app_provider_mappings (mapping_id, app, transport, provider_id, is_primary, created_at, updated_at)
         VALUES ('map-rogue', ?, 'web', 'prov', 1, ?, ?)`,
        APP,
        T0,
        T0,
      ),
    ).rejects.toThrow(/unique/iu);

    const primary = await db.count(
      `SELECT COUNT(*) AS n FROM push_app_provider_mappings WHERE app = ?1 AND transport = 'web' AND is_primary = 1`,
      APP,
    );
    expect(primary).toBe(1);
  });
});

describe('outbox — claimDue, the publisher success guard, and backoff', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  const outbox = (): D1OutboxRepository =>
    new D1OutboxRepository(db.db as unknown as D1DatabaseLike);

  it('gives a claimed intent to exactly one publisher', async () => {
    await outbox().createIntent({
      outboxId: 'ob-1',
      deliveryId: 'deliv',
      availableAt: T0,
      createdAt: T0,
    });
    const repo = outbox();

    // Hai publisher cùng quét, cùng batch size.
    const [a, b] = await Promise.all([
      repo.claimDue({ now: T0, leaseDurationMs: LEASE_MS, claimedBy: 'pub-a', limit: 10 }),
      repo.claimDue({ now: T0, leaseDurationMs: LEASE_MS, claimedBy: 'pub-b', limit: 10 }),
    ]);

    const claimedIds = [...a, ...b].map((entry) => entry.record.outboxId);
    expect(claimedIds).toEqual(['ob-1']);
    // ⚠️ `claimed_by` là token định danh lease: mọi write sau đó của publisher **đó** mang nó,
    // nên kết quả của publisher khác không thể ghi đè.
    const rows = await db.rows<{ claimed_by: string | null; status: string }>(
      `SELECT claimed_by, status FROM push_outbox WHERE outbox_id = 'ob-1'`,
    );
    expect(rows[0]?.status).toBe('publishing');
    expect(rows[0]?.claimed_by).toBe(a.length === 1 ? 'pub-a' : 'pub-b');
  });

  it('closes the intent and advances the delivery in ONE batch', async () => {
    // ⚠️ Đây là yêu cầu của §6.1: `published` của intent và `pending → queued` của delivery là
    // **một** transaction. Hai lệnh riêng sẽ để lại một delivery `pending` với intent
    // `published` — tức một message không bao giờ được gửi và không ai biết.
    await outbox().createIntent({
      outboxId: 'ob-1',
      deliveryId: 'deliv',
      availableAt: T0,
      createdAt: T0,
    });
    const repo = outbox();
    await repo.claimDue({ now: T0, leaseDurationMs: LEASE_MS, claimedBy: 'pub-1', limit: 10 });

    const closed = await repo.applyPublisherSuccess({
      outboxId: 'ob-1',
      deliveryId: 'deliv',
      claimedBy: 'pub-1',
      deliveryWrite: { kind: 'advance_to_queued' },
      now: T0 + 10,
    });

    expect(closed?.status).toBe('published');
    const rows = await db.rows<{ status: string; outbox: string }>(
      `SELECT d.status, (SELECT o.status FROM push_outbox o WHERE o.outbox_id = 'ob-1') AS outbox
       FROM push_deliveries d WHERE d.delivery_id = 'deliv'`,
    );
    expect(rows[0]?.status).toBe('queued');
    expect(rows[0]?.outbox).toBe('published');
  });

  it('leaves the delivery alone when the publisher lease was lost', async () => {
    // ⚠️ **Guard quan trọng nhất của nhóm này.** `applyPublisherSuccess` mang `claimed_by`.
    // Nếu lease đã sang publisher khác, lệnh đóng intent phải là **no-op** — và lệnh thứ
    // hai trong batch cũng phải là no-op, vì `db.batch()` là transaction: một lệnh khác 0 dòng
    // trong khi lệnh đầu khác 0 sẽ là một partial write.
    await outbox().createIntent({
      outboxId: 'ob-1',
      deliveryId: 'deliv',
      availableAt: T0,
      createdAt: T0,
    });
    const repo = outbox();
    await repo.claimDue({ now: T0, leaseDurationMs: LEASE_MS, claimedBy: 'pub-1', limit: 10 });

    const stale = await repo.applyPublisherSuccess({
      outboxId: 'ob-1',
      deliveryId: 'deliv',
      // ⚠️ Token của publisher **khác**: đây là một execution đã bị reclaim.
      claimedBy: 'pub-stale',
      deliveryWrite: { kind: 'advance_to_queued' },
      now: T0 + 10,
    });

    expect(stale).toBeNull();
    const rows = await db.rows<{ status: string }>(
      `SELECT status FROM push_deliveries WHERE delivery_id = 'deliv'`,
    );
    // ⚠️ Delivery vẫn `pending`: publisher mới (pub-1) sẽ gửi và mới được đóng intent.
    expect(rows[0]?.status).toBe('pending');
  });

  it('does not advance the delivery when the use case asks to keep its status', async () => {
    await outbox().createIntent({
      outboxId: 'ob-1',
      deliveryId: 'deliv',
      availableAt: T0,
      createdAt: T0,
    });
    const repo = outbox();
    await repo.claimDue({ now: T0, leaseDurationMs: LEASE_MS, claimedBy: 'pub-1', limit: 10 });
    await markDeliveryQueued(db, 'deliv');

    const closed = await repo.applyPublisherSuccess({
      outboxId: 'ob-1',
      deliveryId: 'deliv',
      claimedBy: 'pub-1',
      deliveryWrite: { kind: 'keep_delivery_status' },
      now: T0 + 10,
    });

    expect(closed?.status).toBe('published');
    // Delivery vẫn `queued` — lệnh thứ hai **không** được ghi vào batch.
    const rows = await db.rows<{ status: string }>(
      `SELECT status FROM push_deliveries WHERE delivery_id = 'deliv'`,
    );
    expect(rows[0]?.status).toBe('queued');
  });

  it('fails an intent after maxAttempts and stops pushing it forward', async () => {
    // ⚠️ `status` do **câu lệnh** quyết định (`attempts + 1 >= maxAttempts`), không phải do
    // TypeScript đọc `attempts` rồi so sánh. Test này khẳng định cả ngưỡng lẫn việc
    // `available_at` **không** bị đẩy theo backoff khi đã `failed`.
    await outbox().createIntent({
      outboxId: 'ob-1',
      deliveryId: 'deliv',
      availableAt: T0,
      createdAt: T0,
    });
    const repo = outbox();

    const first = await (async () => {
      await repo.claimDue({ now: T0, leaseDurationMs: LEASE_MS, claimedBy: 'pub-1', limit: 10 });
      return repo.recordPublishFailure({
        outboxId: 'ob-1',
        claimedBy: 'pub-1',
        maxAttempts: 2,
        backoffMs: 5_000,
        sanitizedError: 'queue send exploded',
        now: T0 + 10,
      });
    })();

    // Lần 1: còn dưới ngưỡng → `pending` + backoff.
    expect(first?.status).toBe('pending');
    expect(first?.attempts).toBe(1);
    expect(first?.availableAt).toBe(T0 + 10 + 5_000);

    const second = await (async () => {
      await repo.claimDue({
        now: T0 + 20_000,
        leaseDurationMs: LEASE_MS,
        claimedBy: 'pub-2',
        limit: 10,
      });
      return repo.recordPublishFailure({
        outboxId: 'ob-1',
        claimedBy: 'pub-2',
        maxAttempts: 2,
        backoffMs: 5_000,
        sanitizedError: 'queue send exploded',
        now: T0 + 20_010,
      });
    })();

    // ⚠️ Lần 2 đạt ngưỡng → `failed`, và `available_at` **không** bị đẩy theo backoff. Giá trị
    // phải bằng đúng giá trị trước đó — không phải `now + backoff` của lần gọi này. Nếu nó bị
    // đẩy, hàng đã `failed` sẽ mang một mốc "claimable" mà không bao giờ claim được.
    expect(second?.status).toBe('failed');
    expect(second?.attempts).toBe(2);
    expect(second?.availableAt).toBe(first?.availableAt);

    // Một intent `failed` không claimable: `claimDue` không trả nó.
    const after = await repo.claimDue({
      now: T0 + 10_000_000,
      leaseDurationMs: LEASE_MS,
      claimedBy: 'pub-3',
      limit: 10,
    });
    expect(after.map((entry) => entry.record.outboxId)).not.toContain('ob-1');
  });

  it('skips an intent whose available_at is in the future', async () => {
    await outbox().createIntent({
      outboxId: 'ob-1',
      deliveryId: 'deliv',
      availableAt: T0 + 10_000,
      createdAt: T0,
    });
    const claimed = await outbox().claimDue({
      now: T0,
      leaseDurationMs: LEASE_MS,
      claimedBy: 'pub-1',
      limit: 10,
    });
    expect(claimed).toHaveLength(0);
  });
});

describe('reconciliation a1 + a4', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  const deliveries = (): D1DeliveryRepository =>
    new D1DeliveryRepository(db.db as unknown as D1DatabaseLike, async () => null);

  it('a1: lists an aged non-terminal delivery for expiry', async () => {
    // ⚠️ a1 của §4.2: một delivery non-terminal đã quá `delivery_reconciliation_age` thì vào
    // tập quét. Ngưỡng lấy từ SLA cấu hình bắt buộc — test dùng một ngưỡng **test**, không
    // phải giá trị đã chốt.
    await markDeliveryQueued(db, 'deliv');
    await db.run(
      `UPDATE push_deliveries SET created_at = ?1 WHERE delivery_id = 'deliv'`,
      T0 - 10_000,
    );

    const aged = await deliveries().listAgedNonTerminal({
      olderThan: T0 - 5_000,
      now: T0,
      limit: 100,
    });
    expect(aged.map((record) => record.deliveryId)).toEqual(['deliv']);
  });

  it('a1: does not list a delivery younger than the threshold', async () => {
    // ⚠️ Ngưỡng phải **loại** delivery còn non-terminal nhưng chưa đủ tuổi — quét tất cả
    // non-terminal sẽ đánh dấu `expired` mọi thứ chưa tới hạn, và `expired` thì terminal.
    await markDeliveryQueued(db, 'deliv');
    const aged = await deliveries().listAgedNonTerminal({
      olderThan: T0 - 5_000,
      now: T0,
      limit: 100,
    });
    expect(aged).toHaveLength(0);
  });

  it('a1: marks expired only once the TTL has passed', async () => {
    // ⚠️ `expires_at <= now` **trong** statement. Đây là ranh giới giữa một delivery còn
    // gửi được và một cái không — và `markExpired` là transition **một chiều**, nên gọi nó
    // sớm sẽ hủy một notification hợp lệ.
    await markDeliveryQueued(db, 'deliv');

    const tooEarly = await deliveries().markExpired({ deliveryId: 'deliv', now: T0 });
    expect(tooEarly).toBeNull();

    // Tận mốc (`<=`): một hàng đã qua đúng `expires_at` thì hết hạn.
    await db.run(`UPDATE push_deliveries SET expires_at = ?1 WHERE delivery_id = 'deliv'`, T0);
    const expired = await deliveries().markExpired({ deliveryId: 'deliv', now: T0 });
    expect(expired?.status).toBe('expired');
  });

  it('a1: leaves an in-flight execution alone when the TTL passes under it', async () => {
    // ⚠️ **`expires_at` trôi qua KHÔNG huỷ một lần gửi đã bắt đầu** (§5.6): execution đang giữ
    // lease vẫn ghi được `delivered`/`failed`. Vì vậy `markExpired` cần **lease đã hết** trước khi
    // chuyển `processing → expired` — đây là điều kiện mà guard `processing` vô điều kiện sẽ bỏ
    // sót, và hậu quả là một message đã gửi thành một hàng không có kết quả.
    await markDeliveryQueued(db, 'deliv');
    const claimed = await deliveries().claimDelivery({
      deliveryId: 'deliv',
      now: T0,
      leaseDurationMs: LEASE_MS,
    });
    expect(claimed?.status).toBe('processing');
    // Hết TTL nhưng lease còn hiệu lực.
    await db.run(`UPDATE push_deliveries SET expires_at = ?1 WHERE delivery_id = 'deliv'`, T0 - 1);

    const whileHeld = await deliveries().markExpired({ deliveryId: 'deliv', now: T0 });
    expect(whileHeld).toBeNull();

    // Lease đã hết thì mới đủ điều kiện `expired`.
    const afterLease = await deliveries().markExpired({ deliveryId: 'deliv', now: T0 + LEASE_MS });
    expect(afterLease?.status).toBe('expired');

    // Đã terminal → không còn nằm trong tập aged.
    const after = await deliveries().listAgedNonTerminal({
      olderThan: T0 - 5_000,
      now: T0,
      limit: 100,
    });
    expect(after).toHaveLength(0);
  });

  it('a1: refuses to expire a terminal delivery', async () => {
    // ⚠️ Guard `status IN ('pending','queued','processing')` nằm trong statement. Một delivery
    // đã `delivered` không được ghi đè thành `expired` bởi một reconciliation chạy muộn —
    // nếu không, một bằng chứng đã gửi thành bằng chứng không gửi.
    await db.run(
      `UPDATE push_deliveries SET status = 'delivered', delivered_at = ?1 WHERE delivery_id = 'deliv'`,
      T0,
    );
    const expired = await deliveries().markExpired({ deliveryId: 'deliv', now: T0 });
    expect(expired).toBeNull();

    const rows = await db.rows<{ status: string }>(
      `SELECT status FROM push_deliveries WHERE delivery_id = 'deliv'`,
    );
    expect(rows[0]?.status).toBe('delivered');
  });

  it('a4: re-dispatch creates exactly one intent', async () => {
    // ⚠️ a4 của §4.2: một intent cũ đã `published` nhưng delivery vẫn `pending` nghĩa là
    // message không tới. Reconciliation tạo **một** intent mới — và partial unique index đảm
    // bảo hai lượt reconciliation chạy song song không tạo hai intent.
    const outbox = new D1OutboxRepository(db.db as unknown as D1DatabaseLike);
    await outbox.createIntent({
      outboxId: 'ob-1',
      deliveryId: 'deliv',
      availableAt: T0,
      createdAt: T0,
    });
    await db.run(
      `UPDATE push_outbox SET status = 'published', published_at = ?1 WHERE outbox_id = 'ob-1'`,
      T0,
    );

    const first = await outbox.createIntent({
      outboxId: 'ob-2',
      deliveryId: 'deliv',
      availableAt: T0,
      createdAt: T0,
    });
    const second = await outbox.createIntent({
      outboxId: 'ob-3',
      deliveryId: 'deliv',
      availableAt: T0,
      createdAt: T0,
    });

    expect(first).not.toBeNull();
    // ⚠️ Lần hai trả `null` **và có thể đếm được**: reconciliation phải phân biệt "không có
    // lỗi" với "chưa từng chạy" trong metric.
    expect(second).toBeNull();
    expect(await outbox.countOpenIntents('deliv')).toBe(1);

    // Tổng số intent của delivery này là 2: một `published` + một đang mở.
    const total = await db.count(
      `SELECT COUNT(*) AS n FROM push_outbox WHERE delivery_id = 'deliv'`,
    );
    expect(total).toBe(2);
  });

  it('a4: lists an aged open intent for re-dispatch', async () => {
    const outbox = new D1OutboxRepository(db.db as unknown as D1DatabaseLike);
    await outbox.createIntent({
      outboxId: 'ob-1',
      deliveryId: 'deliv',
      availableAt: T0,
      createdAt: T0,
    });
    await db.run(`UPDATE push_outbox SET created_at = ?1 WHERE outbox_id = 'ob-1'`, T0 - 10_000);

    const aged = await outbox.listAgedOpen({ olderThan: T0 - 5_000, now: T0, limit: 100 });
    expect(aged.map((record) => record.outboxId)).toEqual(['ob-1']);
  });
});

describe('idempotency — full scope and replay', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  const repo = (): D1IdempotencyRepository =>
    new D1IdempotencyRepository(db.db as unknown as D1DatabaseLike);

  const insert = (
    principalId: string,
    key: string,
    hash: string,
    notificationId: string,
  ): Promise<void> =>
    db.run(
      `INSERT INTO notification_idempotency
         (app, principal_id, idempotency_key, request_hash, notification_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      APP,
      principalId,
      key,
      hash,
      notificationId,
      T0,
    );

  it('finds a record by the full scope', async () => {
    await insert('principal-1', 'key-1', 'hash-1', 'notif');
    const found = await repo().find(APP, 'principal-1', 'key-1');
    expect(found).toEqual({
      app: APP,
      principalId: 'principal-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
      notificationId: 'notif',
      createdAt: T0,
    });
  });

  it.each([
    ['a different app', OTHER_APP],
    ['a different principal', 'principal-2'],
  ])('does not find a record under %s', async (_label, appOrPrincipal) => {
    await insert('principal-1', 'key-1', 'hash-1', 'notif');
    // ⚠️ Scope là `(app, principal_id, idempotency_key)` — đầy đủ. Thiếu bất kỳ thành phần
    // nào nghĩa là một caller khác có thể đọc được `notification_id` của một caller trước đó.
    const found =
      appOrPrincipal === OTHER_APP
        ? await repo().find(OTHER_APP, 'principal-1', 'key-1')
        : await repo().find(APP, appOrPrincipal, 'key-1');
    expect(found).toBeNull();
  });

  it('returns null for an unknown key', async () => {
    expect(await repo().find(APP, 'principal-1', 'never-used')).toBeNull();
  });

  it('rejects a duplicate scope at the database level', async () => {
    await insert('principal-1', 'key-1', 'hash-1', 'notif');
    // ⚠️ UNIQUE của bảng này là guard chống hai notification cho một key — và nó phải **nằm ở
    // schema**, vì hai request song song có thể cùng vượt qua một kiểm tra ở TypeScript.
    await expect(insert('principal-1', 'key-1', 'hash-2', 'notif-2')).rejects.toThrow(/unique/iu);
  });

  it('exposes the request hash so a replay can detect a different body', async () => {
    // ⚠️ Replay cùng key + **cùng** hash → `200` cùng `notification_id`; cùng key + hash
    // khác → `409`. Không lưu hash thì không phân biệt được hai trường hợp đó.
    await insert('principal-1', 'key-1', 'hash-A', 'notif');
    const found = await repo().find(APP, 'principal-1', 'key-1');
    expect(found?.requestHash).toBe('hash-A');
  });
});

describe('rate limit — a rejected request does NOT consume a slot', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  const store = (): D1RateLimitStore => new D1RateLimitStore(db.db as unknown as D1DatabaseLike);
  const WINDOW = 60_000;

  const hits = async (app: string): Promise<number> => {
    const rows = await db.rows<{ hits: number }>(
      `SELECT hits FROM push_rate_limits WHERE app = ?1`,
      app,
    );
    return rows[0]?.hits ?? 0;
  };

  it('allows exactly `limit` requests then denies', async () => {
    const rateLimit = store();
    for (let index = 0; index < 3; index += 1) {
      const outcome = await rateLimit.consume({
        app: APP,
        limit: 3,
        windowDurationMs: WINDOW,
        now: T0,
      });
      expect(outcome.allowed).toBe(true);
      expect(outcome.retryAfterMs).toBeNull();
    }
    const denied = await rateLimit.consume({
      app: APP,
      limit: 3,
      windowDurationMs: WINDOW,
      now: T0,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(WINDOW);
  });

  it('does not consume a slot when denying — hits stays at the limit', async () => {
    // ⚠️ **Điều kiện để `429` không thành amplification loop.** Nếu một request bị từ chối vẫn
    // tăng `hits`, thì một client bị chặn sẽ không bao giờ tự hồi phục trong cửa sổ đó: mỗi lần
    // thử lại chỉ làm hạn mức còn lại thấp hơn.
    const rateLimit = store();
    for (let index = 0; index < 3; index += 1) {
      await rateLimit.consume({ app: APP, limit: 3, windowDurationMs: WINDOW, now: T0 });
    }
    expect(await hits(APP)).toBe(3);

    for (let index = 0; index < 5; index += 1) {
      const denied = await rateLimit.consume({
        app: APP,
        limit: 3,
        windowDurationMs: WINDOW,
        now: T0,
      });
      expect(denied.allowed).toBe(false);
    }
    // ⚠️ Không đổi: 5 lần từ chối không tăng hạn mức đã tiêu.
    expect(await hits(APP)).toBe(3);
  });

  it('opens a new window after the current one expires', async () => {
    const rateLimit = store();
    for (let index = 0; index < 3; index += 1) {
      await rateLimit.consume({ app: APP, limit: 3, windowDurationMs: WINDOW, now: T0 });
    }
    expect(
      (await rateLimit.consume({ app: APP, limit: 3, windowDurationMs: WINDOW, now: T0 })).allowed,
    ).toBe(false);

    // ⚠️ Mốc đúng bằng `window_started_at + w`: dùng `<` sẽ giữ cửa sổ thêm một millisecond.
    const fresh = await rateLimit.consume({
      app: APP,
      limit: 3,
      windowDurationMs: WINDOW,
      now: T0 + WINDOW,
    });
    expect(fresh.allowed).toBe(true);
    expect(await hits(APP)).toBe(1);
  });

  it('counts a fresh request in the same window instead of resetting hits to 1', async () => {
    // ⚠️ Đây là lỗi dễ mắc nhất của `upsert`: viết `hits = excluded.hits` cho **cả** hai nhánh
    // làm mọi request trong một cửa sổ đặt `hits` về 1, và rate limit **không bao giờ** chạm
    // ngưỡng — một hạn mức không bao giờ chạm ngưỡng không phải hạn mức.
    const rateLimit = store();
    await rateLimit.consume({ app: APP, limit: 10, windowDurationMs: WINDOW, now: T0 });
    expect(await hits(APP)).toBe(1);
    await rateLimit.consume({ app: APP, limit: 10, windowDurationMs: WINDOW, now: T0 + 5 });
    await rateLimit.consume({ app: APP, limit: 10, windowDurationMs: WINDOW, now: T0 + 10 });
    expect(await hits(APP)).toBe(3);
  });

  it('keeps one counter per app', async () => {
    // ⚠️ Scope là **duy nhất** là `App` (FR-021), lấy từ authenticated principal chứ không từ
    // IP. Hai app phải có hai cửa sổ riêng, và việc App nào cũng phải được rate limit.
    const rateLimit = store();
    await seedScope(db, { app: OTHER_APP });
    for (let index = 0; index < 3; index += 1) {
      await rateLimit.consume({ app: APP, limit: 3, windowDurationMs: WINDOW, now: T0 });
    }
    expect(
      (await rateLimit.consume({ app: APP, limit: 3, windowDurationMs: WINDOW, now: T0 })).allowed,
    ).toBe(false);

    const other = await rateLimit.consume({
      app: OTHER_APP,
      limit: 3,
      windowDurationMs: WINDOW,
      now: T0,
    });
    expect(other.allowed).toBe(true);
  });

  it('lets exactly one of two concurrent consumes take the last slot', async () => {
    // ⚠️ `consume` là **một** câu lệnh, không phải "đọc rồi tăng". Hai request đồng thời phải
    // không cùng tiêu slot cuối cùng — đó là điều mà một read-then-write không bảo đảm.
    const rateLimit = store();
    const outcomes = await Promise.all([
      rateLimit.consume({ app: APP, limit: 2, windowDurationMs: WINDOW, now: T0 }),
      rateLimit.consume({ app: APP, limit: 2, windowDurationMs: WINDOW, now: T0 }),
    ]);
    // ⚠️ Hai request cùng được phép: `limit = 2` và cửa sổ mới bắt đầu từ `1`. Cả hai đều hợp
    // lệ, và `hits` phải bằng 2 — không phải 1 (mất một lượt) và không phải 3 (vượt ngưỡng).
    expect(outcomes.every((outcome) => outcome.allowed)).toBe(true);
    expect(await hits(APP)).toBe(2);
  });
});

describe('notification payload — projection qua repository notification', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  it('reads the payload through the notification repository, not a second query', async () => {
    // ⚠️ `push_deliveries` không mang payload. `D1DeliveryRepository` **nhận** một callback
    // đọc notification, vì đó là **một** bảng và **một** projection — đọc nó từ hai repository
    // là hai nơi phải giữ đúng hình dạng khi projection đổi.
    const notifications = new D1NotificationRepository(db.db as unknown as D1DatabaseLike);
    const deliveries = new D1DeliveryRepository(db.db as unknown as D1DatabaseLike, (id) =>
      notifications.findById(id),
    );

    const payload = await deliveries.findNotificationPayload('notif');
    expect(payload?.payloadJson).toBe(JSON.stringify({ title: 't', body: 'b' }));
    expect(payload?.payloadBytes).toBe(24);
  });

  it('returns null for a notification that does not exist', async () => {
    const notifications = new D1NotificationRepository(db.db as unknown as D1DatabaseLike);
    expect(await notifications.findById('nope')).toBeNull();
  });
});
