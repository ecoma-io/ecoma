/**
 * Unit test tầng unit (fake ports) cho `administrativeRetry` và `republishDelivery` — §5.6.1, §5.6.3.
 *
 * ⚠️ **Hai đường phục hồi được phân biệt theo state của delivery, và ranh giới đó là điều test
 * này giữ.** Retry `failed → queued` **tăng** generation (execution cũ không ghi đè được);
 * republish **giữ nguyên** generation (chưa execution nào chạy để fence). Một use case gộp hoặc
 * tự tăng generation sẽ xanh với một test chỉ nhìn "thành công" — test dưới đây assert từng
 * trường được truyền vào statement ghi, nên lệch một trường là đỏ.
 *
 * ⚠️ **Thứ tự state-write → outbox intent → audit là hợp đồng, không phải chi tiết.** Intent
 * chỉ được tạo khi delivery đã thực sự `queued` (không sinh intent mồ côi), audit chỉ ghi sau
 * khi state persist (pattern audit-sau-state-write của toàn codebase). Fixture ở đây dùng
 * `unused()` cho mọi port không mong đợi, nên một lời gọi sai thứ tự hoặc thừa là test đỏ.
 */

import { describe, expect, it } from 'vitest';

import { administrativeRetry, republishDelivery } from './admin-delivery';
import { ADMIN_REJECTION } from './admin-provider';
import {
  APP,
  T0,
  adminFixture,
  deliveryRecord,
  outboxRecord,
  providerRecord,
  subscriptionRecord,
  unused,
  type AdminFixture,
} from './fixture-ports';
import type { AdminDeps } from './admin-provider';
import type { DeliveryRecord, OutboxRecord } from './records';

/** Command chuẩn của operator — `reason`/`actor` bắt buộc (FR-020). */
const COMMAND = { app: APP, deliveryId: 'deliv-1', reason: 'ops replay', actor: 'backoffice' };

/** Precondition đủ để domain chấp nhận: subscription active, provider không hold. */
function eligibleDependencies(fixture: AdminDeps['ports'], delivery: DeliveryRecord): void {
  fixture.subscriptions.findById = async () =>
    subscriptionRecord({ subscriptionId: delivery.subscriptionId, status: 'active' });
  fixture.providers.findById = async () => providerRecord({ providerId: delivery.providerId });
}

/** Fixture dùng chung: delivery `pending` eligible, intent tạo được, chưa có intent open. */
function pendingScenario(
  f: AdminFixture,
  intent: OutboxRecord | null,
): {
  createdIntents: { deliveryId: string; availableAt: number }[];
} {
  const target = deliveryRecord({
    deliveryId: 'deliv-1',
    status: 'pending',
    dispatchGeneration: 7,
  });
  f.ports.deliveries.findById = async () => target;
  eligibleDependencies(f.ports, target);
  // Precondition read của republish: luôn đọc trước khi domain quyết định.
  f.ports.outbox.hasOpenIntent = async () => false;
  const createdIntents: { deliveryId: string; availableAt: number }[] = [];
  f.ports.outbox.createIntent = async (input) => {
    createdIntents.push({ deliveryId: input.deliveryId, availableAt: input.availableAt });
    return intent;
  };
  return { createdIntents };
}

describe('administrativeRetry — the guarded recovery path of §5.6.1', () => {
  it('requeues a failed delivery with the next generation from the domain and one intent', async () => {
    const f = adminFixture();
    const target = deliveryRecord({
      deliveryId: 'deliv-1',
      status: 'failed',
      dispatchGeneration: 3,
    });
    f.ports.deliveries.findById = async () => target;
    eligibleDependencies(f.ports, target);
    const retried = target; // statement trả hàng đã `queued` — ở đây chỉ cần record
    f.ports.deliveries.retryFailed = async (input) => {
      // Domain tính generation mới = 3 + 1; use case KHÔNG được tự tăng.
      expect(input.dispatchGeneration).toBe(4);
      expect(input.now).toBe(T0);
      return { ...retried, status: 'queued', dispatchGeneration: input.dispatchGeneration };
    };
    f.ports.outbox.createIntent = async (input) =>
      outboxRecord({ outboxId: input.outboxId, deliveryId: input.deliveryId });

    const result = await administrativeRetry(f, COMMAND);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('mong đợi kết quả thành công');
    }
    expect(result.value.status).toBe('queued');
    expect(result.value.dispatchGeneration).toBe(4);
    // Đúng một intent, đúng delivery, id từ generator.
    expect(f.idCalls()).toBe(1);
  });

  it('writes the delivery_retried audit with actor, reason and new generation', async () => {
    const f = adminFixture();
    const target = deliveryRecord({
      deliveryId: 'deliv-1',
      status: 'failed',
      dispatchGeneration: 0,
    });
    f.ports.deliveries.findById = async () => target;
    eligibleDependencies(f.ports, target);
    f.ports.deliveries.retryFailed = async (input) => ({
      ...target,
      status: 'queued',
      dispatchGeneration: input.dispatchGeneration,
    });
    f.ports.outbox.createIntent = async (input) =>
      outboxRecord({ outboxId: input.outboxId, deliveryId: input.deliveryId });

    await administrativeRetry(f, COMMAND);

    const audit = f.audit.last();
    expect(audit?.event).toBe('delivery_retried');
    expect(audit?.actor).toBe('backoffice');
    expect(audit?.entityType).toBe('push_delivery');
    expect(audit?.entityId).toBe('deliv-1');
    expect(audit?.detail).toMatchObject({
      app: APP,
      reason: 'ops replay',
      status_before: 'failed',
      dispatch_generation: 1,
    });
  });

  it('returns delivery_not_found without reading preconditions when the delivery is absent', async () => {
    const f = adminFixture();
    f.ports.deliveries.findById = async () => null;

    const result = await administrativeRetry(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.DeliveryNotFound });
    expect(f.audit.records).toHaveLength(0);
  });

  it('returns app_mismatch for a delivery of another app (FR-007)', async () => {
    const f = adminFixture();
    f.ports.deliveries.findById = async () =>
      deliveryRecord({ deliveryId: 'deliv-1', status: 'failed', app: 'other-app' });

    const result = await administrativeRetry(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.AppMismatch });
    expect(f.audit.records).toHaveLength(0);
  });

  it('refuses a delivery that is not failed with recovery_precondition_failed', async () => {
    const f = adminFixture();
    // `pending` là non-terminal — đường của nó là republish, không phải retry.
    const target = deliveryRecord({ deliveryId: 'deliv-1', status: 'pending' });
    f.ports.deliveries.findById = async () => target;
    eligibleDependencies(f.ports, target);

    const result = await administrativeRetry(f, COMMAND);

    expect(result).toMatchObject({
      ok: false,
      reason: ADMIN_REJECTION.RecoveryPreconditionFailed,
    });
    expect(f.audit.records).toHaveLength(0);
  });

  it('treats a missing subscription as ineligible instead of eligible (fail closed)', async () => {
    const f = adminFixture();
    const target = deliveryRecord({ deliveryId: 'deliv-1', status: 'failed' });
    f.ports.deliveries.findById = async () => target;
    // Subscription bị xoá — application chiếu `null` thành `disabled` cho domain.
    f.ports.subscriptions.findById = async () => null;
    f.ports.providers.findById = async () => providerRecord({});

    const result = await administrativeRetry(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.RecoveryPreconditionFailed });
    expect(f.ports.deliveries.retryFailed).toBeDefined();
    expect(f.audit.records).toHaveLength(0);
  });

  it('treats a missing provider as on emergency hold (fail closed)', async () => {
    const f = adminFixture();
    const target = deliveryRecord({ deliveryId: 'deliv-1', status: 'failed' });
    f.ports.deliveries.findById = async () => target;
    f.ports.subscriptions.findById = async () =>
      subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' });
    f.ports.providers.findById = async () => null;

    const result = await administrativeRetry(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.RecoveryPreconditionFailed });
    expect(f.audit.records).toHaveLength(0);
  });

  it('refuses an expired notification with recovery_precondition_failed', async () => {
    const f = adminFixture();
    const target = deliveryRecord({ deliveryId: 'deliv-1', status: 'failed', expiresAt: T0 - 1 });
    f.ports.deliveries.findById = async () => target;
    eligibleDependencies(f.ports, target);

    const result = await administrativeRetry(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.RecoveryPreconditionFailed });
  });

  it('returns state_mismatch when the guarded statement loses a race and writes nothing else', async () => {
    const f = adminFixture();
    const target = deliveryRecord({ deliveryId: 'deliv-1', status: 'failed' });
    f.ports.deliveries.findById = async () => target;
    eligibleDependencies(f.ports, target);
    // `retryFailed` trả `null` = `meta.changes == 0` — một admin khác đã requeue trước.
    f.ports.deliveries.retryFailed = async () => null;

    const result = await administrativeRetry(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.StateMismatch });
    // Không intent, không audit: delivery chưa thực sự `queued`.
    expect(f.idCalls()).toBe(0);
    expect(f.audit.records).toHaveLength(0);
  });

  it('fails closed with storage_failure when no intent was created and none is open', async () => {
    const f = adminFixture();
    const target = deliveryRecord({ deliveryId: 'deliv-1', status: 'failed' });
    f.ports.deliveries.findById = async () => target;
    eligibleDependencies(f.ports, target);
    f.ports.deliveries.retryFailed = async (input) => ({
      ...target,
      status: 'queued',
      dispatchGeneration: input.dispatchGeneration,
    });
    // Index chặn (trả `null`) và không có intent open nào — delivery `queued` sẽ không bao
    // giờ được publish nếu trả `200` ở đây.
    f.ports.outbox.createIntent = async () => null;
    f.ports.outbox.hasOpenIntent = async () => false;

    const result = await administrativeRetry(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.StorageFailure });
    expect(f.audit.records).toHaveLength(0);
  });

  it('succeeds when the intent insert is blocked but an open intent already exists', async () => {
    const f = adminFixture();
    const target = deliveryRecord({ deliveryId: 'deliv-1', status: 'failed' });
    f.ports.deliveries.findById = async () => target;
    eligibleDependencies(f.ports, target);
    f.ports.deliveries.retryFailed = async (input) => ({
      ...target,
      status: 'queued',
      dispatchGeneration: input.dispatchGeneration,
    });
    f.ports.outbox.createIntent = async () => null;
    f.ports.outbox.hasOpenIntent = async () => true;

    const result = await administrativeRetry(f, COMMAND);

    expect(result.ok).toBe(true);
    // Path này vẫn kết thúc bằng audit — delivery có intent open để publish.
    expect(f.audit.last()?.event).toBe('delivery_retried');
  });
});

describe('republishDelivery — the non-terminal recovery path of §5.6.3', () => {
  it('creates exactly one intent without touching delivery state or generation', async () => {
    const f = adminFixture();
    const { createdIntents } = pendingScenario(
      f,
      outboxRecord({ outboxId: 'id-1', deliveryId: 'deliv-1' }),
    );

    const result = await republishDelivery(f, COMMAND);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('mong đợi kết quả thành công');
    }
    // §5.6.3: delivery giữ nguyên state và generation — republish không phải một execution.
    expect(result.value.delivery.status).toBe('pending');
    expect(result.value.delivery.dispatchGeneration).toBe(7);
    expect(result.value.intent.outboxId).toBe('id-1');
    expect(createdIntents).toHaveLength(1);
    expect(createdIntents[0]?.availableAt).toBe(T0);
  });

  it('never calls retryFailed — republish does not write delivery state', async () => {
    const f = adminFixture();
    pendingScenario(f, outboxRecord({ outboxId: 'id-1', deliveryId: 'deliv-1' }));
    f.ports.deliveries.retryFailed = async () => unused('deliveries.retryFailed');

    const result = await republishDelivery(f, COMMAND);

    expect(result.ok).toBe(true);
  });

  it('writes the delivery_republished audit with the outbox id', async () => {
    const f = adminFixture();
    pendingScenario(f, outboxRecord({ outboxId: 'id-1', deliveryId: 'deliv-1' }));

    await republishDelivery(f, COMMAND);

    const audit = f.audit.last();
    expect(audit?.event).toBe('delivery_republished');
    expect(audit?.detail).toMatchObject({ app: APP, reason: 'ops replay', outbox_id: 'id-1' });
  });

  it('refuses a terminal delivery with recovery_precondition_failed', async () => {
    const f = adminFixture();
    const target = deliveryRecord({ deliveryId: 'deliv-1', status: 'delivered' });
    f.ports.deliveries.findById = async () => target;
    eligibleDependencies(f.ports, target);
    f.ports.outbox.hasOpenIntent = async () => false;

    const result = await republishDelivery(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.RecoveryPreconditionFailed });
    expect(f.idCalls()).toBe(0);
    expect(f.audit.records).toHaveLength(0);
  });

  it('surfaces the domain open_outbox_intent rejection through the precondition reason', async () => {
    const f = adminFixture();
    const target = deliveryRecord({ deliveryId: 'deliv-1', status: 'pending' });
    f.ports.deliveries.findById = async () => target;
    eligibleDependencies(f.ports, target);
    f.ports.outbox.hasOpenIntent = async () => true;

    const result = await republishDelivery(f, COMMAND);

    // Đọc `hasOpenIntent` không phải quyết định — nó chỉ nuôi `detail` của domain. Lý do
    // `open_outbox_intent` của domain đi qua `recovery_precondition_failed`; nhãn
    // `open_outbox_intent` riêng chỉ xuất hiện khi chính statement insert bị index chặn.
    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.RecoveryPreconditionFailed });
    if (result.ok) {
      throw new Error('mong đợi một rejection');
    }
    expect(result.detail).toContain('open_outbox_intent');
    expect(f.idCalls()).toBe(0);
  });

  it('returns open_outbox_intent when the guarded insert loses the index race', async () => {
    const f = adminFixture();
    // Domain thấy chưa có intent (hasOpenIntent = false) nhưng index chặn lúc insert —
    // race hợp lệ của §4.2, trả `open_outbox_intent` chứ không phải lỗi cần alert.
    pendingScenario(f, null);

    const result = await republishDelivery(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.OpenOutboxIntent });
    expect(f.audit.records).toHaveLength(0);
  });

  it('refuses an expired notification even when non-terminal', async () => {
    const f = adminFixture();
    const target = deliveryRecord({
      deliveryId: 'deliv-1',
      status: 'pending',
      expiresAt: T0 - 1,
    });
    f.ports.deliveries.findById = async () => target;
    eligibleDependencies(f.ports, target);
    f.ports.outbox.hasOpenIntent = async () => false;

    const result = await republishDelivery(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.RecoveryPreconditionFailed });
    expect(f.idCalls()).toBe(0);
  });
});
