/**
 * Bảng quyết định **a1–a6** của reconciliation (c) chạy trên D1 thật (`§4.2` của
 * `docs/applications/push-notification/03-operations.md`).
 *
 * ⚠️ **Vì sao file này gọi `d1-harness.ts` và không dựng vào `d1-repositories.spec.ts`.** Bảng
 * a1–a6 là **policy** của use case — nó quyết định *làm gì* với một delivery kẹt, và mỗi
 * hành động đều là một lệnh ghi có guard ở tầng database. Test ở tầng repository chỉ chứng
 * minh **guard** viết đúng; nó không chứng minh use case **chọn đúng** hành động. Thiếu bảng
 * này thì một `switch` đảo hai nhánh a3/a4 vẫn xanh hoàn toàn.
 *
 * ⚠️ **Vì sao spec của application lib nằm ở `tests/` của app chứ không ở trong
 * `libs/push-notification-application/`.** Vì nó chạy trên **D1 thật**, tức nó cần
 * `D1OutboxRepository`/`D1DeliveryRepository` — mà Nx suy ra task-graph edge từ **import thật**,
 * và chiều phụ thuộc đúng là `infrastructure → application`. Đặt spec ở lib application sẽ tạo
 * vòng `application:test → infrastructure:test → application:test` và `run-many` dừng với
 * `circular dependency`. App là composition root — nơi **duy nhất** biết cả hai tầng — nên
 * đây là nơi duy nhất một spec dùng chung cả hai mà không tạo vòng. Xem ghi chú ở `APP_DIR` của
 * `d1-harness.ts` để biết vì sao cả harness cũng ở đây.
 *
 * ⚠️ **Sáu nhánh, sáu hành động, và thứ tự là bất biến của tài liệu.** a1 đứng trước vì một
 * delivery hết hạn không được publish lại dù còn mọi điều kiện khác; a6 ở giữa vì nó là
 * điều kiện **loại**, không phải hành động. Vì vậy có một test riêng chứng minh a1 thắng trước
 * cả khi delivery `queued` và không còn intent — tức thứ tự kiểm tra, không chỉ tập hành động.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RECONCILE_ACTION,
  reconcileDeliveries,
  reconcileOutbox,
  type OutboxRecord,
  type ReconcileAction,
} from '@ecoma-io/push-notification-application';

import {
  T0,
  createTestDatabase,
  seedScope,
  type SeededScope,
  type TestDatabase,
} from './d1-harness';

import { buildPorts, testConfig, type PortFixture } from './fixture-ports';

import type { D1OutboxRepository } from '@ecoma-io/push-notification-infrastructure';

/**
 * Mốc thời gian của **lượt quét**.
 *
 * ⚠️ Fixture seed mọi delivery với `created_at = T0` và `expires_at = T0 + 3.6M` (đúng
 * **một giờ**). `listAgedNonTerminal` lọc `created_at <= now - delivery_reconciliation_age`
 * với `delivery_reconciliation_age = 30 phút`. Nên `now` phải thỏa **cả hai**:
 *
 * - `now - 30 phút >= T0` để delivery seeded đủ già (nếu không, không hàng nào khớp và mọi
 *   test đỏ bằng một danh sách rỗng — thất lạng dễ gặp nhất ở một predicate tuổi);
 * - `now < T0 + 1 giờ` để `expires_at` **chưa** qua, nếu không a1 nổ trước mọi nhánh
 *   còn lại và chúng đều không bao giờ được chạy tới.
 *
 * ⚠️ Khoảng hở giữa hai ràng buộc là **30 phút** (`T0 + 30m` … `T0 + 1h`), và test a1 đẩy
 * `expires_at` xuống dưới mốc quét để kiểm nhánh hết hạn — đó là lý do hai con số này phải
 * là hai hằng riêng chứ không phải một "thời gian" chung.
 */
const AGE_THRESHOLD = T0 + 45 * 60_000;

/** `created_at` đẩy ra quá xa để một delivery **không** được coi là già. */
const NOT_AGED_AT = T0 + 7_200_000;

/**
 * Quyết định của **một** delivery, bỏ `deliveryId` để assertion chỉ tập trung vào hành động.
 *
 * ⚠️ `toHaveLength(1)` là một phần của hợp đồng, không phải tiện lợi: mỗi test dựng đúng một
 * delivery trong lượt quét, nên "nhiều hơn một quyết định" nghĩa là lượt quét đã quét dư hàng —
 * một lỗi fixture mà `decisions[0]` sẽ giấu mất.
 */
function decisionFor(
  decisions: readonly { readonly action: ReconcileAction; readonly reason: string }[],
): { action: ReconcileAction; reason: string } {
  expect(decisions).toHaveLength(1);
  return { action: decisions[0]?.action ?? '', reason: decisions[0]?.reason ?? '' };
}

describe('reconcileDeliveries — the a1..a6 decision table on a real D1', () => {
  let db: TestDatabase;
  let fixture: PortFixture;
  let scope: SeededScope;

  const run = (): ReturnType<typeof reconcileDeliveries> =>
    reconcileDeliveries(
      { config: testConfig(), ports: fixture.ports, ids: fixture.ids },
      AGE_THRESHOLD,
    );

  beforeEach(async () => {
    db = await createTestDatabase();
    fixture = buildPorts(db);
    scope = await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  it('a1: marks expired only after expires_at has passed', async () => {
    // ⚠️ `expires_at` của fixture là `T0 + 3.6M`; `AGE_THRESHOLD` là `T0 + 60s` nên chưa hết
    // hạn. Đẩy `expires_at` về trước mốc quét thì a1 phải nổ — và **không** tạo intent, vì một
    // delivery hết hạn không được gửi lại dù còn mọi điều kiện khác (§4.2 a1).
    await db.run(
      `UPDATE push_deliveries SET status = 'queued' WHERE delivery_id = ?1`,
      scope.deliveryId,
    );
    await db.run(
      `UPDATE push_deliveries SET expires_at = ?1 WHERE delivery_id = ?2`,
      AGE_THRESHOLD - 1,
      scope.deliveryId,
    );

    const result = await run();

    expect(decisionFor(result.decisions)).toEqual({
      action: RECONCILE_ACTION.MarkExpired,
      reason: 'expires_at_reached',
    });
    expect(result.expired).toBe(1);
    expect(result.intentsCreated).toBe(0);
    // ⚠️ Assert **cả hai**: `expired = 1` mà `markExpired` không ghi sẽ vẫn xanh.
    const rows = await db.rows<{ status: string }>(
      `SELECT status FROM push_deliveries WHERE delivery_id = ?1`,
      scope.deliveryId,
    );
    expect(rows[0]?.status).toBe('expired');
    expect(await db.count(`SELECT COUNT(*) AS n FROM push_outbox`)).toBe(0);
  });

  it('a2: a pending delivery with an open intent is left to outbox reconciliation', async () => {
    // ⚠️ a2 là "còn intent thì **không** làm gì" — thuộc cơ chế (a), và (c) `MUST NOT` tự tạo
    // intent hay tự chuyển `pending → queued` ở đây. Assert `intentSuppressedByIndex = 0` và
    // `intentsCreated = 0`: một nhánh a4 nhảy vào đây sẽ tạo intent thứ hai và bị index chặn,
    // nên chỉ kiểm `action` sẽ bỏ sót.
    await db.run(
      `UPDATE push_deliveries SET status = 'pending' WHERE delivery_id = ?1`,
      scope.deliveryId,
    );
    await fixture.outbox.createIntent({
      outboxId: 'outbox-open',
      deliveryId: scope.deliveryId,
      availableAt: T0,
      createdAt: T0,
    });

    const result = await run();

    expect(decisionFor(result.decisions)).toEqual({
      action: RECONCILE_ACTION.DeferredToOutboxReconciliation,
      reason: 'outbox_intent_open',
    });
    expect(result.intentsCreated).toBe(0);
    expect(result.intentsSuppressedByIndex).toBe(0);
    expect(result.expired).toBe(0);
  });

  it('a3: a pending delivery with no usable intent asks an operator instead of self-healing', async () => {
    // ⚠️ **Đây là ranh giới quan trọng nhất của a3**: control plane `MUST NOT` tự phục hồi
    // (`03-operations.md` §4.2 a3). Test này khẳng định **cả hai** vế: hành động là
    // `operator_action_required`, và **không** có intent nào được tạo.
    await db.run(
      `UPDATE push_deliveries SET status = 'pending' WHERE delivery_id = ?1`,
      scope.deliveryId,
    );

    const result = await run();

    expect(decisionFor(result.decisions)).toEqual({
      action: RECONCILE_ACTION.OperatorActionRequired,
      reason: 'no_usable_outbox_intent_republish_required',
    });
    expect(result.intentsCreated).toBe(0);
    expect(await db.count(`SELECT COUNT(*) AS n FROM push_outbox`)).toBe(0);
    // ⚠️ State **không** đổi: (c) `MUST NOT` tự chuyển `pending → queued`.
    const rows = await db.rows<{ status: string }>(
      `SELECT status FROM push_deliveries WHERE delivery_id = ?1`,
      scope.deliveryId,
    );
    expect(rows[0]?.status).toBe('pending');
  });

  it('a4: a queued delivery without an intent gets exactly one new intent for the same delivery', async () => {
    // ⚠️ a4 là hành động ghi duy nhất của (c). Assert **cả** `intentsCreated` và hàng trong
    // `push_outbox`, vì `action = re_dispatched` mà `createIntent` trả `null` sẽ vẫn cho một
    // kết quả trông đúng.
    await db.run(
      `UPDATE push_deliveries SET status = 'queued' WHERE delivery_id = ?1`,
      scope.deliveryId,
    );

    const result = await run();

    expect(decisionFor(result.decisions)).toEqual({
      action: RECONCILE_ACTION.ReDispatched,
      reason: 'queued_without_open_intent',
    });
    expect(result.intentsCreated).toBe(1);
    expect(result.intentsSuppressedByIndex).toBe(0);
    const intents = await db.rows<{ delivery_id: string; status: string; outbox_id: string }>(
      `SELECT delivery_id, status, outbox_id FROM push_outbox`,
    );
    // ⚠️ **Cùng `delivery_id`** — §4.2 a4 cấm tạo `notification_id`/`delivery_id` mới; một
    // intent re-dispatch mang id mới là một notification mới, tức gửi trùng.
    expect(intents).toHaveLength(1);
    expect(intents[0]?.delivery_id).toBe(scope.deliveryId);
    expect(intents[0]?.status).toBe('pending');
    // ⚠️ State giữ `queued`: publisher mới là actor của `pending → queued` (§6.2).
    const rows = await db.rows<{ status: string }>(
      `SELECT status FROM push_deliveries WHERE delivery_id = ?1`,
      scope.deliveryId,
    );
    expect(rows[0]?.status).toBe('queued');
  });

  it('a4: counts a race-losing scan separately instead of reporting it as created', async () => {
    // ⚠️ §4.2 nói rõ "reconciler thua ghi intent nhận lỗi unique-constraint và bỏ qua (**không
    // phải lỗi cần alert**)" — nhưng nó vẫn phải **đếm** được, nếu không thì "không có lỗi" và
    // "chưa chạy" trùng nhau trong số liệu. Test này mô phỏng đúng race đó: một intent `open`
    // được tạo **giữa** lúc `hasOpenIntent` trả `false` và lúc `createIntent` chạy.
    await db.run(
      `UPDATE push_deliveries SET status = 'queued' WHERE delivery_id = ?1`,
      scope.deliveryId,
    );
    // Intent của "lượt quét khác" phải **còn** mở tới đúng lúc lượt quét này ghi — nếu nó đã
    // `published` thì index `push_outbox_one_open_intent` không chặn gì và `createIntent`
    // thành công bình thường, tức test đo nhánh khác.
    await fixture.outbox.createIntent({
      outboxId: 'outbox-race',
      deliveryId: scope.deliveryId,
      availableAt: T0,
      createdAt: T0,
    });

    // Mô phỏng lượt quét **thua**: ngay trước khi `createIntent` chạy, một lượt khác commit
    // một intent `open` cho cùng `delivery_id`. Lượt quét này đã đọc `hasOpenIntent` là
    // `false` từ trước, nên nó đi tới `createIntent` và **đây** là lúc index chặn.
    //
    // ⚠️ **`Proxy`, không `{ ...fixture.outbox, createIntent }`.** `D1OutboxRepository` là
    // class: `countOpenIntents`/`createIntent` nằm trên prototype, và object spread chỉ copy
    // **thuộc tính riêng** — bản spread vì vậy mất hai method đó và `reconcileQueued` ném
    // `countOpenIntents is not a function`. `Proxy` giữ nguyên prototype và chỉ chặn đúng
    // một method, nên nó là cách duy nhất bọc được một repository mà không viết lại cả bề mặt.
    let published = false;
    const createIntentOnTarget = fixture.outbox.createIntent.bind(fixture.outbox) as (
      value: Parameters<D1OutboxRepository['createIntent']>[0],
    ) => Promise<OutboxRecord | null>;
    const racingOutbox = new Proxy(fixture.outbox, {
      get(target, property): unknown {
        if (property === 'hasOpenIntent') {
          return async (): Promise<boolean> => {
            if (!published) {
              published = true;
              // Intent của lượt quét khác vừa được publish: index
              // `push_outbox_one_open_intent` **nhả** chỗ nên `hasOpenIntent` trả `false`, và
              // lượt quét này đi tới `createIntent` — đúng điểm lượt quét phải thua.
              //
              // ⚠️ `status = 'published'` đi kèm `published_at` bắt buộc
              // (`push_outbox_published_at_parity_check`), nên hai cột phải đi cùng một lệnh.
              await db.run(
                `UPDATE push_outbox SET status = 'published', published_at = ?1 WHERE outbox_id = 'outbox-race'`,
                T0,
              );
            }
            return false;
          };
        }
        if (property === 'createIntent') {
          return async (input: Parameters<D1OutboxRepository['createIntent']>[0]) => {
            // Intent mới của lượt quét khác, vẫn `open`, commit **trước** lệnh của lượt quét
            // này. **Phải `await`**: một `void promise` để index chưa có hàng khi `INSERT` kia
            // chạy, và hai lệnh lại tranh nhau trên cùng một connection.
            await fixture.outbox.createIntent({
              outboxId: 'outbox-winner',
              deliveryId: scope.deliveryId,
              availableAt: T0,
              createdAt: T0,
            });
            // Gọi `INSERT OR IGNORE` thật trên repository thật: index sẽ chặn và nó trả
            // `null` — đúng hợp đồng mà `reconcileQueued` dựa vào.
            return createIntentOnTarget(input);
          };
        }
        // ⚠️ **Bind vào `target`, không dùng `Reflect.get(…, receiver)`.** `D1OutboxRepository`
        // đọc D1 qua private field `#db`; khi `this` là **proxy** thì private field không được
        // tra cứu trên proxy và Node ném `Cannot read private member #db`. Truyền `receiver`
        // cho `Reflect.get` là cách viết "giữ `this` là proxy" — sai ở đây.
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await reconcileDeliveries(
      {
        config: testConfig(),
        ports: { ...fixture.ports, outbox: racingOutbox },
        ids: fixture.ids,
      },
      AGE_THRESHOLD,
    );

    expect(result.intentsCreated).toBe(0);
    expect(result.intentsSuppressedByIndex).toBe(1);
    expect(decisionFor(result.decisions)).toEqual({
      action: RECONCILE_ACTION.DeferredToOutboxReconciliation,
      reason: 'index_suppressed_concurrent_intent',
    });
  });

  it.each([
    ['an expired lease', AGE_THRESHOLD - 1, 'lease_expired_awaiting_redelivery'],
    ['a live lease', AGE_THRESHOLD + 60_000, 'lease_still_held_by_execution'],
  ])('a5: leaves a processing delivery alone with %s', async (_label, leaseAt, reason) => {
    // ⚠️ a5 là "**không** làm gì" ở **cả hai** vế — lease hết hạn cũng vậy, vì §5.6 cấm reaper
    // chuyển state và a4 chỉ áp dụng cho `queued`. Vì vậy assert **cả** `action` (một trong hai
    // lý do phân biệt được) và việc **không** có intent nào được tạo.
    // ⚠️ Ba cột phải đi **cùng một** lệnh: CHECK `push_deliveries_lease_parity_check` bắt
    // buộc `(status = 'processing') = (lease_expires_at IS NOT NULL)`, nên đặt `status`
    // trước rồi mới đặt lease ở một lệnh khác sẽ đi qua một trạng thái trung gian vi phạm
    // CHECK và D1 từ chối. Đây chính là loại lỗi mà một `db.run` từng gây ra cho chính bộ
    // test này — nó chỉ ra CHECK đang làm việc, không phải CHECK sai.
    await db.run(
      `UPDATE push_deliveries
          SET status = 'processing', dispatch_generation = 1, lease_expires_at = ?1
        WHERE delivery_id = ?2`,
      leaseAt,
      scope.deliveryId,
    );

    const result = await run();

    expect(decisionFor(result.decisions)).toEqual({
      action: RECONCILE_ACTION.AwaitingRedelivery,
      reason,
    });
    expect(result.expired).toBe(0);
    expect(result.intentsCreated).toBe(0);
    expect(await db.count(`SELECT COUNT(*) AS n FROM push_outbox`)).toBe(0);
  });

  it.each(['delivered', 'failed', 'cancelled', 'expired'])(
    'a6: never touches a %s delivery',
    async (status) => {
      // ⚠️ a6 là điều kiện **loại** và nó đứng **trước** a1: một delivery terminal không được hồi
      // sinh kể cả khi `expires_at` đã qua. Bốn trạng thái terminal được duyệt hết vì đây là
      // bất biến §17.19, không phải chi tiết của một trạng thái.
      await db.run(
        // ⚠️ `expired ⇔ expired_at NOT NULL` (`push_deliveries_expired_at_parity_check`), nên
        // trạng thái `expired` phải đi kèm `expired_at` trong **cùng** lệnh. Bốn trạng thái
        // terminal được viết bằng một template chung, nên `expired_at` là **null** cho ba
        // trạng thái còn lại — và CHECK đúng là bắt buộc điều đó.
        `UPDATE push_deliveries
          SET status = ?1, expires_at = ?2, expired_at = ?3
        WHERE delivery_id = ?4`,
        status,
        AGE_THRESHOLD - 1,
        status === 'expired' ? AGE_THRESHOLD - 1 : null,
        scope.deliveryId,
      );

      const result = await run();

      // ⚠️ `scanned = 0` chứ không phải `decisions[0].action = terminal_untouched`: predicate
      // `listAgedNonTerminal` **đã** lọc terminal ở tầng SQL, nên use case không bao giờ nhìn
      // thấy chúng. Assert `scanned` chứng minh việc lọc xảy ra **trước** khi quyết định — và
      // nhánh `terminal_untouched` trong `applyDecision` là defense cho một state lạ, không phải
      // đường đi bình thường.
      expect(result.scanned).toBe(0);
      expect(result.decisions).toEqual([]);
      expect(result.expired).toBe(0);
      const rows = await db.rows<{ status: string }>(
        `SELECT status FROM push_deliveries WHERE delivery_id = ?1`,
        scope.deliveryId,
      );
      expect(rows[0]?.status).toBe(status);
    },
  );

  it('a1 wins over a4 for a queued delivery that is both expired and intent-less', async () => {
    // ⚠️ **Test thứ tự, không test tập hành động.** §4.2 nói a1 đứng trước vì một delivery hết
    // hạn không được publish lại dù còn mọi điều kiện khác. Nếu `switch` kiểm `status` trước
    // `expires_at` thì delivery này nhận `re_dispatched` và **một intent mới** — tức gửi lại
    // một notification đã quá hạn. Cả hai assertion đều cần: `action` và việc bảng
    // `push_outbox` vẫn rỗng.
    await db.run(
      `UPDATE push_deliveries SET status = 'queued', expires_at = ?1 WHERE delivery_id = ?2`,
      AGE_THRESHOLD - 1,
      scope.deliveryId,
    );

    const result = await run();

    expect(decisionFor(result.decisions).action).toBe(RECONCILE_ACTION.MarkExpired);
    expect(await db.count(`SELECT COUNT(*) AS n FROM push_outbox`)).toBe(0);
  });

  it('reports a null result when a scan finds nothing', async () => {
    // ⚠️ `scanned = 0` với danh sách rỗng — đường bình thường của một database khoẻ, và nó
    // phải trả **con số 0** chứ không phải `undefined`. `oldestOpenCreatedAt` của (a) cũng vậy
    // (xem test dưới).
    await db.run(
      `UPDATE push_deliveries SET created_at = ?1 WHERE delivery_id = ?2`,
      NOT_AGED_AT,
      scope.deliveryId,
    );

    const result = await run();

    expect(result).toEqual({
      scanned: 0,
      decisions: [],
      expired: 0,
      intentsCreated: 0,
      intentsSuppressedByIndex: 0,
    });
  });
});

describe('reconcileOutbox — (a) only counts, never self-repairs', () => {
  let db: TestDatabase;
  let fixture: PortFixture;
  let scope: SeededScope;

  beforeEach(async () => {
    db = await createTestDatabase();
    fixture = buildPorts(db);
    scope = await seedScope(db);
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
  });

  it('counts an orphaned pending delivery that no longer has a usable intent', async () => {
    // ⚠️ Đây là **SLA bắt buộc** của §4.2: mỗi delivery `pending` mồ côi phải được phát hiện
    // trong `outbox_recovery_sla`. Fixture seed delivery `pending` và **không** có intent, nên
    // nó đúng là một mồ côi — và con số này là thứ đo được (phần "alert" thuộc lớp
    // observability, không thuộc use case).
    const result = await reconcileOutbox(
      { config: testConfig(), ports: fixture.ports, ids: fixture.ids },
      AGE_THRESHOLD,
    );

    expect(result.orphanedPendingDeliveries).toBe(1);
  });

  it('does not count a pending delivery that still has an open intent', async () => {
    await fixture.outbox.createIntent({
      outboxId: 'outbox-open',
      deliveryId: scope.deliveryId,
      availableAt: T0,
      createdAt: T0,
    });

    const result = await reconcileOutbox(
      { config: testConfig(), ports: fixture.ports, ids: fixture.ids },
      AGE_THRESHOLD,
    );

    expect(result.orphanedPendingDeliveries).toBe(0);
  });

  it('writes nothing — reconciliation (a) MUST NOT self-recover', async () => {
    // ⚠️ §4.2: (a) xử lý ba trạng thái bằng hành động **đã có** — publisher claim lại lease hết
    // hạn, publisher tự catch up backlog, operator quyết định `failed`. Một reconciliation tự
    // sửa sẽ phá ranh giới a3. Test này đo bằng **đếm hàng** trước/sau, không bằng cách đọc
    // code: một use case ghi rồi ghi đè về cùng giá trị sẽ không đổi hàng nào.
    const before = {
      deliveries: await db.count(`SELECT COUNT(*) AS n FROM push_deliveries`),
      outbox: await db.count(`SELECT COUNT(*) AS n FROM push_outbox`),
    };

    await reconcileOutbox(
      { config: testConfig(), ports: fixture.ports, ids: fixture.ids },
      AGE_THRESHOLD,
    );

    expect({
      deliveries: await db.count(`SELECT COUNT(*) AS n FROM push_deliveries`),
      outbox: await db.count(`SELECT COUNT(*) AS n FROM push_outbox`),
    }).toEqual(before);
  });

  it('reports the oldest aged open intent so a backlog alert has a real age', async () => {
    // ⚠️ `oldestOpenCreatedAt` là **đầu vào** của alert "backlog quá hạn" của §11. `null` khi
    // không có hàng nào, và bằng `null` khi rỗng là hai thứ khác nhau — nên test cả hai vế.
    const empty = await reconcileOutbox(
      { config: testConfig(), ports: fixture.ports, ids: fixture.ids },
      AGE_THRESHOLD,
    );
    expect(empty.oldestOpenCreatedAt).toBeNull();
    expect(empty.agedOpen).toBe(0);

    await fixture.outbox.createIntent({
      outboxId: 'outbox-old',
      deliveryId: scope.deliveryId,
      availableAt: T0,
      // Giữa hai mốc của lượt quét: mốc recovery SLA là `T0 + 15 phút`, mốc quét là
      // `T0 + 60 giây` — nên `createdAt` nằm **sau** ngưỡng và record **không** bị tính là
      // aged. Đẩy xuống `T0` để đo nhánh có hàng.
      createdAt: T0 - 60 * 60_000,
    });

    const aged = await reconcileOutbox(
      { config: testConfig(), ports: fixture.ports, ids: fixture.ids },
      AGE_THRESHOLD,
    );
    expect(aged.agedOpen).toBe(1);
    expect(aged.oldestOpenCreatedAt).toBe(T0 - 60 * 60_000);
  });

  it('counts failed intents for the operator without acting on them', async () => {
    // ⚠️ a3: `failed` thuộc **operator**, reconciliation chỉ alert. Assert `failed = 1` và
    // trạng thái hàng **không** đổi — đó là ranh giới giữa "báo cáo" và "tự phục hồi".
    await fixture.outbox.createIntent({
      outboxId: 'outbox-failed',
      deliveryId: scope.deliveryId,
      availableAt: T0,
      createdAt: T0,
    });
    await db.run(
      `UPDATE push_outbox SET status = 'failed', last_error = 'queue refused', attempts = 5 WHERE outbox_id = ?1`,
      'outbox-failed',
    );

    const result = await reconcileOutbox(
      { config: testConfig(), ports: fixture.ports, ids: fixture.ids },
      AGE_THRESHOLD,
    );

    expect(result.failed).toBe(1);
    const rows = await db.rows<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM push_outbox WHERE outbox_id = ?1`,
      'outbox-failed',
    );
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.last_error).toBe('queue refused');
  });

  it('counts orphaned pending deliveries across every app, because the SLA is system-wide', async () => {
    // ⚠️ **Không phải `MUST` của tài liệu — đây là hành vi đang có, và test ghim nó lại.**
    // `push_outbox` cố ý **không** lưu `app` (§6.1: `delivery_id` là tham chiếu duy nhất),
    // và `listAgedNonTerminal` cũng không lọc `app` — nên `reconcileOutbox` đếm trên **toàn
    // hệ thống**. Hai lý do khiến điều đó đúng: (a) `listFailed` là danh sách **cho operator**
    // theo mức độ hỏng, nên nó cố ý toàn hệ thống (xem ghi chú ở `D1OutboxRepository`); và
    // (b) một Worker duy nhất phục vụ mọi app của scope, nên tách theo app sẽ cần join delivery
    // — một query khác hẳn về hình dạng chỉ để tách một con số mà operator đọc toàn.
    //
    // ⚠️ **Vì sao ghim lại điều này.** Một test viết `expect(...).toBe(1)` khi thực tế là `2`
    // sẽ đỏ và buộc phải quyết định: đó là bug hay là quyết định? Ghi rõ ở đây để lần sửa
    // sau **tự ý thêm** `AND app = ?` vào SQL sẽ phải đối mặt với câu hỏi này, thay vì
    // làm một SLA vô nghĩa đi qua im lặng.
    await seedScope(db, { app: 'other-app' });

    const result = await reconcileOutbox(
      { config: testConfig(), ports: fixture.ports, ids: fixture.ids },
      AGE_THRESHOLD,
    );

    // Hai scope, mỗi scope một delivery `pending` không có intent.
    expect(result.orphanedPendingDeliveries).toBe(2);
  });
});
