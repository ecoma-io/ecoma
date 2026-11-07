/**
 * Unit test tầng unit (fake ports) cho ba use case quản lý subscription/provider của
 * `admin-subscription.ts` — FR-017, §4.3.
 *
 * ⚠️ **DELETE là logical revoke, không phải xoá dòng** — điều này được giữ bằng việc fixture
 * **không có** method xoá nào để gọi: một use case gọi `remove`/`delete` sẽ vấp `unused()`
 * ngay. Các transition đều đi qua `disableById`/`setStatus` guarded.
 *
 * ⚠️ **Hai event audit cho hai hành động cùng transition.** Disable (`subscription_disabled`)
 * và remove (`subscription_removed`) cùng ghi `status = 'disabled'`, nhưng chúng trả lời hai
 * câu hỏi khác nhau khi đọc lại audit. Test dưới đây ghim event + id + detail cho từng path,
 * nên một lần "đơn giản hoá" gộp hai event lại là đỏ.
 */

import { describe, expect, it } from 'vitest';

import {
  deleteProviderByAdmin,
  disableSubscriptionByAdmin,
  removeSubscriptionByAdmin,
} from './admin-subscription';
import { ADMIN_REJECTION } from './admin-provider';
import { APP, T0, adminFixture, providerRecord, subscriptionRecord, unused } from './fixture-ports';
const COMMAND = {
  app: APP,
  subscriptionId: 'sub-1',
  reason: 'ops cleanup',
  actor: 'backoffice',
};

/** Disable statement trả hàng đã `disabled` — giá trị `cause` được assert từng case. */
function disableStatement(f: ReturnType<typeof adminFixture>): {
  calls: { app: string; cause: string; now: number }[];
} {
  const calls: { app: string; cause: string; now: number }[] = [];
  f.ports.subscriptions.disableById = async (input) => {
    calls.push({ app: input.app, cause: input.cause, now: input.now });
    // Predicate thật của D1 là `status = 'active'`; hàng trả về là hàng đã `disabled`.
    expect(input.cause).toBe('admin_disable');
    return subscriptionRecord({ subscriptionId: input.subscriptionId, status: 'disabled' });
  };
  return { calls };
}

describe('disableSubscriptionByAdmin — admin disable with FR-020 audit', () => {
  it('disables an active subscription with the admin_disable cause and writes the audit', async () => {
    const f = adminFixture();
    f.ports.subscriptions.findById = async () =>
      subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' });
    const statement = disableStatement(f);

    const result = await disableSubscriptionByAdmin(f, COMMAND);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('mong đợi kết quả thành công');
    }
    expect(result.value.status).toBe('disabled');
    expect(statement.calls).toEqual([{ app: APP, cause: 'admin_disable', now: T0 }]);
    const audit = f.audit.last();
    expect(audit?.event).toBe('subscription_disabled');
    // Id suy ra được từ (entity, event, now) — hai lần chạy cùng lời gọi không tạo hai id.
    expect(audit?.auditId).toBe(`push_subscription:subscription_disabled:sub-1:${T0}`);
    expect(audit?.detail).toMatchObject({
      app: APP,
      reason: 'ops cleanup',
      previous_status: 'active',
    });
  });

  it('rejects an expired subscription with state_mismatch before any write', async () => {
    const f = adminFixture();
    // `expired` không có transition sang `disabled` theo model (FR-004) — domain từ chối.
    f.ports.subscriptions.findById = async () =>
      subscriptionRecord({ subscriptionId: 'sub-1', status: 'expired' });
    f.ports.subscriptions.disableById = async () => unused('subscriptions.disableById');

    const result = await disableSubscriptionByAdmin(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.StateMismatch });
    expect(f.audit.records).toHaveLength(0);
  });

  it('returns state_mismatch when the guarded statement loses a race', async () => {
    const f = adminFixture();
    f.ports.subscriptions.findById = async () =>
      subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' });
    f.ports.subscriptions.disableById = async () => null;

    const result = await disableSubscriptionByAdmin(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.StateMismatch });
    expect(f.audit.records).toHaveLength(0);
  });

  it('returns subscription_not_found without writing or auditing', async () => {
    const f = adminFixture();
    f.ports.subscriptions.findById = async () => null;
    f.ports.subscriptions.disableById = async () => unused('subscriptions.disableById');

    const result = await disableSubscriptionByAdmin(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.SubscriptionNotFound });
    expect(f.audit.records).toHaveLength(0);
  });

  it('returns app_mismatch for a subscription of another app (FR-007)', async () => {
    const f = adminFixture();
    f.ports.subscriptions.findById = async () =>
      subscriptionRecord({ subscriptionId: 'sub-1', status: 'active', app: 'other-app' });
    f.ports.subscriptions.disableById = async () => unused('subscriptions.disableById');

    const result = await disableSubscriptionByAdmin(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.AppMismatch });
    expect(f.audit.records).toHaveLength(0);
  });
});

describe('removeSubscriptionByAdmin — logical revoke with its own audit event', () => {
  it('removes via disableById and audits subscription_removed, not subscription_disabled', async () => {
    const f = adminFixture();
    f.ports.subscriptions.findById = async () =>
      subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' });
    const statement = disableStatement(f);

    const result = await removeSubscriptionByAdmin(f, COMMAND);

    expect(result.ok).toBe(true);
    // Cùng transition `active → disabled` với disable — khác ở **event audit**.
    expect(statement.calls).toEqual([{ app: APP, cause: 'admin_disable', now: T0 }]);
    const audit = f.audit.last();
    expect(audit?.event).toBe('subscription_removed');
    expect(audit?.auditId).toBe(`push_subscription:subscription_removed:sub-1:${T0}`);
    expect(audit?.detail).toMatchObject({ previous_status: 'active' });
  });

  it('returns state_mismatch when nothing was disabled and writes no audit', async () => {
    const f = adminFixture();
    f.ports.subscriptions.findById = async () =>
      subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' });
    f.ports.subscriptions.disableById = async () => null;

    const result = await removeSubscriptionByAdmin(f, COMMAND);

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.StateMismatch });
    expect(f.audit.records).toHaveLength(0);
  });
});

describe('deleteProviderByAdmin — provider logical revoke', () => {
  it('disables the provider with expected=status and audits logical_revoke', async () => {
    const f = adminFixture();
    const target = providerRecord({ providerId: 'prov-1', status: 'enabled' });
    f.ports.providers.findById = async () => target;
    f.ports.providers.setStatus = async (input) => {
      // `expected` là guard optimistic: state phải còn là cái đã đọc.
      expect(input.expected).toBe('enabled');
      expect(input.status).toBe('disabled');
      return { ...target, status: 'disabled' };
    };

    const result = await deleteProviderByAdmin(f, { ...COMMAND, providerId: 'prov-1' });

    expect(result.ok).toBe(true);
    const audit = f.audit.last();
    expect(audit?.event).toBe('provider_disabled');
    expect(audit?.auditId).toBe(`push_provider:provider_disabled:prov-1:${T0}`);
    expect(audit?.detail).toMatchObject({
      app: APP,
      reason: 'ops cleanup',
      change: 'logical_revoke',
    });
  });

  it('returns provider_not_found without touching setStatus', async () => {
    const f = adminFixture();
    f.ports.providers.findById = async () => null;
    f.ports.providers.setStatus = async () => unused('providers.setStatus');

    const result = await deleteProviderByAdmin(f, { ...COMMAND, providerId: 'prov-1' });

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.ProviderNotFound });
    expect(f.audit.records).toHaveLength(0);
  });

  it('returns state_mismatch when setStatus returns null and writes no audit', async () => {
    const f = adminFixture();
    f.ports.providers.findById = async () => providerRecord({ providerId: 'prov-1' });
    f.ports.providers.setStatus = async () => null;

    const result = await deleteProviderByAdmin(f, { ...COMMAND, providerId: 'prov-1' });

    expect(result).toMatchObject({ ok: false, reason: ADMIN_REJECTION.StateMismatch });
    expect(f.audit.records).toHaveLength(0);
  });

  it('declares no deletion port — the fixture bundle has no remove method to call', () => {
    const f = adminFixture();
    // §4.3: physical deletion chỉ theo retention policy. Bundle port không có method xoá,
    // nên "DELETE = xoá dòng" là bất khả thi theo hình dạng port, không chỉ theo quy ước.
    expect(f.ports.providers).not.toHaveProperty('remove');
    expect(f.ports.providers).not.toHaveProperty('delete');
  });
});
