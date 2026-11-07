/**
 * Re-validate endpoint **đã lưu** — FR-003: "Control plane MUST re-validate endpoint đã lưu
 * khi allowlist/policy thay đổi và theo định kỳ; endpoint không còn hợp lệ → subscription
 * disabled".
 *
 * ⚠️ **Đây là nửa thứ hai của SSRF policy mà `endpoint-validation.ts` chỉ làm một nửa.**
 * `validatePushEndpoint` chặn endpoint **mới** lúc subscribe; một allowlist siết lại thì
 * endpoint hợp lệ hôm qua có thể không hợp lệ hôm nay — và subscription cũ vẫn active cho
 * tới khi có một lượt quét nhìn lại. Use case này là lượt quét đó, và
 * `revalidateStoredEndpoint` là đúng hàm mà nó phải gọi: một bộ quy tắc thứ hai cho đường
 * revalidate là hai câu trả lời khác nhau cho cùng một câu hỏi.
 *
 * ⚠️ **Disable là kết quả, không phải quyết định của use case.** `revalidateStoredEndpoint`
 * trả `EndpointRejected` → `SUBSCRIPTION_DISABLE_CAUSE.EndpointRevalidationFailed` — cause
 * này đã có sẵn trong vocabulary đóng của domain (FR-003, FR-004) nên không cần event/cause
 * mới. `disableById` là guarded write (`status = 'active'` trong statement), nên một lượt quét
 * races với user disable là no-op an toàn, không phải lỗi.
 *
 * ⚠️ **Row hỏng (endpoint không đọc được) KHÔNG disable.** `revalidateStoredEndpoint` trả
 * `NotFound` cho case đó — không phải endpoint vi phạm policy mà là dữ liệu hỏng, và disable
 * vì dữ liệu hỏng sẽ khoá vĩnh viễn một subscription mà nguyên nhân không nằm ở endpoint.
 * Báo `skippedCorrupt` để operator thấy được đếm, đúng pattern "không tự sửa cái không chắc".
 */

import {
  SUBSCRIPTION_DISABLE_CAUSE,
  type SubscriptionDisableCause,
} from '@ecoma-io/push-notification-domain';
import type { PushNotificationConfig } from './config-port';
import { revalidateStoredEndpoint } from './endpoint-validation';
import type { PushNotificationPorts } from './ports';

/** Kết quả một lượt quét re-validate cho một app. */
export interface EndpointRevalidationResult {
  /** Số subscription `active` đã nhìn. */
  readonly scanned: number;
  /** Số subscription bị disable vì endpoint không còn hợp lệ. */
  readonly disabled: number;
  /** Số subscription còn hợp lệ. */
  readonly valid: number;
  /** Số row hỏng (endpoint không đọc được) — bỏ qua, không disable, để operator quyết. */
  readonly skippedCorrupt: number;
  /** `subscription_id` của các subscription bị disable — trace được mà không log endpoint. */
  readonly disabledSubscriptionIds: readonly string[];
}

/** Dependency của lượt quét — cùng shape với use case inventory, inject được. */
export interface EndpointRevalidationDeps {
  readonly config: PushNotificationConfig;
  readonly ports: PushNotificationPorts;
}

/**
 * Quét subscription `active` của **một** app, re-validate từng endpoint theo allowlist hiện
 * hành của config, disable cái vi phạm.
 *
 * ⚠️ **Giới hạn theo app là có chủ ý**: đường này chạy dưới một admin/internal trigger, và
 * một lượt quét toàn hệ thống cần một chiến lược phân trang xuyên app mà SLA chưa đòi hỏi.
 * `listByApp` với `status: 'active'` là đúng tập cần nhìn — subscription đã `disabled` không
 * bao giờ được delivery dùng lại (claim predicate chỉ nhận `active`), nên re-validate nó
 * chỉ tốn đọc.
 */
export async function revalidateSubscriptionEndpoints(
  deps: EndpointRevalidationDeps,
  input: { readonly app: string },
): Promise<EndpointRevalidationResult> {
  const { config, ports } = deps;
  const subscriptions = await ports.subscriptions.listByApp(input.app, {
    status: 'active',
    limit: config.engineering.reconciliationBatchSize,
  });

  let disabled = 0;
  let valid = 0;
  let skippedCorrupt = 0;
  const disabledSubscriptionIds: string[] = [];

  for (const subscription of subscriptions) {
    const outcome = revalidateStoredEndpoint(
      subscription.endpoint,
      config.pushEndpointHostAllowlist,
    );
    if (outcome.ok) {
      valid += 1;
      continue;
    }

    const cause: SubscriptionDisableCause | null =
      outcome.reason === 'endpoint_rejected'
        ? SUBSCRIPTION_DISABLE_CAUSE.EndpointRevalidationFailed
        : // `not_found` = row hỏng — xem JSDoc đầu file, không disable.
          null;
    if (cause === null) {
      skippedCorrupt += 1;
      continue;
    }

    const updated = await ports.subscriptions.disableById({
      app: input.app,
      subscriptionId: subscription.subscriptionId,
      cause,
      now: ports.clock.now(),
    });
    if (updated !== null) {
      disabled += 1;
      disabledSubscriptionIds.push(subscription.subscriptionId);
    } else {
      // Statement không ghi dòng nào — subscription đã đổi state giữa lúc đọc và ghi
      // (user/admin disable). Không phải lỗi của lượt quét, không đếm disabled.
      valid += 1;
    }
  }

  return {
    scanned: subscriptions.length,
    disabled,
    valid,
    skippedCorrupt,
    disabledSubscriptionIds,
  };
}
