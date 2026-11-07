/**
 * Admin API — quản lý `Push Subscription` và `Device` (FR-017 inspect/disable/remove).
 *
 * ⚠️ **`DELETE` là logical revoke, không phải xoá dòng.** §4.3 nói rõ: physical deletion chỉ theo
 * retention/cleanup policy, và historical references cần cho audit/delivery history `MUST NOT`
 * bị xoá trước retention. Vì vậy ở v1:
 *
 * - `DELETE /admin/v1/subscriptions/:id` → `disableSubscription` với cause `admin_disable`.
 * - `DELETE /admin/v1/providers/:id` → `setProviderStatus(..., 'disabled')`.
 *
 * Cả hai đều là **transition state**, có audit, và có thể đảo ngược bằng một operation khác
 * (enable). Không có đường nào xoá dòng — một service không có lịch retention vẫn có thể làm
 * việc đó sai.
 *
 * ⚠️ **Subscription không có "re-enable" ở Admin API.** FR-004 nói chỉ một update secret
 * **tường minh** của client mới đưa subscription về `active`, và đó là
 * `POST /v1/subscriptions` của Application API (`reactivateWithNewSecret`). Admin bật lại bằng
 * cách sửa state sẽ tạo một subscription active với secret đã bị provider từ chối — tức là
 * khôi phục một lỗi mà disable vừa gỡ.
 */

import {
  disableSubscription,
  SUBSCRIPTION_DISABLE_CAUSE,
} from '@ecoma-io/push-notification-domain';

import type { AdminDeps, AdminResult } from './admin-provider';
import { ADMIN_REJECTION } from './admin-provider';
import { AUDIT_EVENT, type SubscriptionRecord } from './records';

/** Input của `PATCH`/`DELETE /admin/v1/subscriptions/:id`. */
export interface SubscriptionAdminCommand {
  readonly app: string;
  readonly subscriptionId: string;
  /** Vì sao operator thao tác — đi vào audit (FR-020: audit chứa actor và timestamp). */
  readonly reason: string;
  readonly actor: string;
}

/**
 * `PATCH /admin/v1/subscriptions/:id` với `status: 'disabled'` — vô hiệu hoá một subscription.
 *
 * ⚠️ Nguyên nhân disable là **`admin_disable`**, và nó được truyền vào **statement** chứ không
 * phải đọc rồi chọn: một subscription đã `disabled` vì `provider_invalidation` rồi tới
 * `admin_disable` phải **giữ** nguyên nguyên nhân đầu — nguyên nhân đầu là thứ giải thích
 * vì sao endpoint chết, và nó quyết định operator có cần invalidate hay chỉ chờ client
 * đăng ký lại. Ghi đè nó bằng nguyên nhân của lần disable sau là mất thông tin đó.
 *
 * ⚠️ Idempotent trên `disabled`: `disableById` guard `status = 'active'` nên lần gọi lại trả
 * `changed = false`. Use case trả `200` với record hiện tại và ghi audit — khác `holdProvider`,
 * nơi một audit record cho một thay đổi không xảy ra là bằng chứng sai. Lý do: ở đây lời gọi
 * lặp **là** một admin operation thật (Backoffice bấm nút hai lần), và FR-020 đòi
 * `subscription_disabled` cho mọi thao tác quản trị quan trọng. Bỏ audit ở đây sẽ để một
 * session admin không có dấu vết.
 */
export async function disableSubscriptionByAdmin(
  deps: AdminDeps,
  command: SubscriptionAdminCommand,
  nowOverride?: number,
): Promise<AdminResult<SubscriptionRecord>> {
  const { ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const subscription = await ports.subscriptions.findById(command.subscriptionId);
  const scope = checkScope(subscription, command.app);
  if (scope !== null) {
    return scope;
  }
  const target = subscription as SubscriptionRecord;

  const outcome = disableSubscription(target.status, SUBSCRIPTION_DISABLE_CAUSE.AdminDisable);
  if (!outcome.ok) {
    // Domain từ chối vì subscription không ở trạng thái có thể disable (đã closed). Đây là
    // **kết quả hợp lệ** — `disableById` cũng guard `status = 'active'` — nên đây là
    // `state_mismatch` chứ không phải lỗi: client đã đi tới một trạng thái mà admin không
    // định vận hành tới.
    return {
      ok: false,
      reason: ADMIN_REJECTION.StateMismatch,
      detail: `${outcome.reason}: ${outcome.detail}`,
    };
  }

  const updated = await ports.subscriptions.disableById({
    app: command.app,
    subscriptionId: target.subscriptionId,
    cause: SUBSCRIPTION_DISABLE_CAUSE.AdminDisable,
    now,
  });
  if (updated === null) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.StateMismatch,
      detail: 'Trạng thái subscription đã đổi sau khi đọc — thao tác không được áp dụng.',
    };
  }

  await deps.ports.audit.append({
    auditId: `push_subscription:${AUDIT_EVENT.SubscriptionDisabled}:${target.subscriptionId}:${now}`,
    event: AUDIT_EVENT.SubscriptionDisabled,
    actor: command.actor,
    entityType: 'push_subscription',
    entityId: target.subscriptionId,
    detail: { app: command.app, reason: command.reason, previous_status: target.status },
    now,
  });
  return { ok: true, value: updated };
}

/**
 * `DELETE /admin/v1/subscriptions/:id` — **logical revoke** (FR-017, §4.3).
 *
 * ⚠️ Audit là `subscription_removed`, **không** phải `subscription_disabled` — dù hai hành
 * động có cùng transition. FR-020 liệt kê cả hai như hai event, và chúng trả lời hai câu hỏi
 * khác nhau khi đọc lại audit: "ai đã khoá subscription này" và "ai đã xoá nó". Gộp làm mất
 * câu trả lời thứ hai.
 *
 * ⚠️ `reason` là **bắt buộc** ở đây. Đây là operation mà một người có thể gọi nhầm để dọn dữ
 * liệu, và dữ liệu bị mất là delivery history — thứ tài liệu nói `MUST NOT` xoá. Không có
 * `reason` thì không có gì để phân biệt một quyết định có chủ ý với một thao tác nhầm.
 */
export async function removeSubscriptionByAdmin(
  deps: AdminDeps,
  command: SubscriptionAdminCommand,
  nowOverride?: number,
): Promise<AdminResult<SubscriptionRecord>> {
  const { ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const subscription = await ports.subscriptions.findById(command.subscriptionId);
  const scope = checkScope(subscription, command.app);
  if (scope !== null) {
    return scope;
  }
  const target = subscription as SubscriptionRecord;

  const updated = await ports.subscriptions.disableById({
    app: command.app,
    subscriptionId: target.subscriptionId,
    cause: SUBSCRIPTION_DISABLE_CAUSE.AdminDisable,
    now,
  });
  if (updated === null) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.StateMismatch,
      detail:
        'Subscription không ở trạng thái có thể revoke — có thể đã bị disable bởi nguyên nhân khác.',
    };
  }

  await ports.audit.append({
    auditId: `push_subscription:${AUDIT_EVENT.SubscriptionRemoved}:${target.subscriptionId}:${now}`,
    event: AUDIT_EVENT.SubscriptionRemoved,
    actor: command.actor,
    entityType: 'push_subscription',
    entityId: target.subscriptionId,
    detail: { app: command.app, reason: command.reason, previous_status: target.status },
    now,
  });
  return { ok: true, value: updated };
}

/** `DELETE /admin/v1/providers/:id` — logical revoke của provider (FR-017, §4.3). */
export async function deleteProviderByAdmin(
  deps: AdminDeps,
  input: {
    readonly app: string;
    readonly providerId: string;
    readonly reason: string;
    readonly actor: string;
  },
  nowOverride?: number,
): Promise<AdminResult<void>> {
  const { ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const provider = await ports.providers.findById(input.providerId);
  if (provider === null) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.ProviderNotFound,
      detail: 'Provider không tồn tại.',
    };
  }
  if (provider.app !== input.app) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.AppMismatch,
      detail: 'Provider thuộc app khác — FR-007 cấm dùng chéo app.',
    };
  }

  // `DELETE` = disable, **không** = emergency hold. Hold là một thao tác vận hành khẩn cấp với
  // audit `provider_held`; disable là thu hồi chính thức. Gộp chúng khiến một `DELETE` đơn
  // giản tạo ra một trạng thái mà §6.5 yêu cầu runbook riêng để gỡ.
  const updated = await ports.providers.setStatus({
    app: input.app,
    providerId: input.providerId,
    status: 'disabled',
    expected: provider.status,
    now,
  });
  if (updated === null) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.StateMismatch,
      detail: 'Trạng thái provider đã đổi sau khi đọc — thao tác không được áp dụng.',
    };
  }

  await ports.audit.append({
    auditId: `push_provider:${AUDIT_EVENT.ProviderDisabled}:${input.providerId}:${now}`,
    event: AUDIT_EVENT.ProviderDisabled,
    actor: input.actor,
    entityType: 'push_provider',
    entityId: input.providerId,
    detail: { app: input.app, reason: input.reason, change: 'logical_revoke' },
    now,
  });
  return { ok: true, value: undefined };
}

function checkScope(
  subscription: SubscriptionRecord | null,
  app: string,
): {
  readonly ok: false;
  readonly reason: (typeof ADMIN_REJECTION)[keyof typeof ADMIN_REJECTION];
  readonly detail: string;
} | null {
  if (subscription === null) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.SubscriptionNotFound,
      detail: 'Subscription không tồn tại.',
    };
  }
  if (subscription.app !== app) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.AppMismatch,
      detail: 'Subscription thuộc app khác — FR-007 cấm dùng chéo app.',
    };
  }
  return null;
}
