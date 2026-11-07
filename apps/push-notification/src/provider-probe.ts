/**
 * Adapter `ProviderProbe` của composition root — nối port của use case `runProviderTest`
 * với client Web Push đã có sẵn của delivery plane.
 *
 * ⚠️ **Vì sao adapter nằm ở composition root, không nằm trong `libs/push-notification-application`.**
 *
 * - **Tags cho phép đúng ở đây:** `apps/push-notification` mang `type:composition` +
 *   `scope:notifications`; allowlist của `type:composition` là
 *   `["domain","application","contracts","infrastructure"]` và của `scope:notifications` là
 *   `["scope:notifications","scope:shared","scope:platform","type:contracts"]`.
 *   `libs/web-push-notification-job-infrastructure` mang `type:infrastructure` +
 *   `scope:notifications`, nên import ở composition root **hợp lệ theo cả hai chiều**. Tầng
 *   application thì ngược lại: `type:application` mang `notDependOnLibsWithTags:
 *   ["type:infrastructure", …]` — đẩy adapter xuống lib là vi phạm tag ngay.
 * - **§14.8 — invariant 8** (*"`push-notification` không thực hiện transport delivery"*) nhìn
 *   vào gần đúng: probe **gửi** một Web Push request thật. Ngoại lệ có chủ đích và được nói
 *   rõ (không im lặng): provider test là **operation quản trị** — đúng một delivery mỗi lời
 *   gọi, tới subscription được operator chọn, qua Admin API — trong khi bất biến đó đứng lên
 *   chống việc **đường serving fan-out** của delivery lệch khỏi control plane. CB-2 đã chốt
 *   hướng này ở Issue #104 và runbook §6.4 mô tả đúng hình dạng đó.
 */

import {
  PROVIDER_TEST_RESULT,
  type ProviderProbe,
  type ProviderTestResult,
} from '@ecoma-io/push-notification-application';
import type {
  WebPushSendRequest,
  WebPushSendResult,
} from '@ecoma-io/web-push-notification-job-application';
import { createWebPushSender } from '@ecoma-io/web-push-notification-job-infrastructure/web-push';

/**
 * Shape input của `ProviderProbe.sendTestDelivery` — khai **tường minh**, không trích qua
 * `Parameters<ProviderProbe['sendTestDelivery']>[0]`.
 *
 * ⚠️ `main.ts` đã ghi chú cùng lý do (node của lib được type theo `main: ./src/index.ts`, và
 * `Parameters<…>` suy ra thành `unknown` — một probe sai shape vẫn thỏa port về hình thức).
 * Khai lại ở đây là nơi thứ hai phải giữ đồng bộ với port — hai nơi phải **đổi cùng nhau**,
 * và typecheck của composition root đỏ trước khi một lệch nào đó tới được runtime.
 */
interface ProbeInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly vapidKeyId: string;
  readonly privateKey: string;
  readonly publicKey: string;
  readonly vapidSubject: string | null;
  readonly timeoutMs: number;
  readonly payloadJson: string;
}

/**
 * Mapping `WebPushSendResult` → `ProviderTestResult` của FR-018.
 *
 * ⚠️ Đây là **bảng HTTP → classification** của FR-018, và nó phải khớp error matrix canonical
 * (`03-operations.md` §5) đúng từng dòng. Hiện thực hoá vòng đời của một adapter:
 *
 * | HTTP / điều kiện                          | `classification`         |
 * | ----------------------------------------- | ------------------------ |
 * | `2xx`                                     | `delivery_accepted`      |
 * | `401` / `403`                             | `authentication_failed`  |
 * | `404` / `410`                             | `subscription_invalid`   |
 * | `413` (hoặc payload vượt trần pre-flight) | `configuration_invalid`  |
 * | `3xx` (redirect không được đi theo)       | `provider_rejected_request` |
 * | `429` / `5xx` / timeout / connection lost | `provider_rejected_request` |
 * | credential VAPID không ký được (pre-flight)| `configuration_invalid` |
 *
 * ⚠️ Mapping nằm ở **adapter**, không ở use case: use case chỉ mang vocabulary đóng của
 * FR-018 (`PROVIDER_TEST_RESULT`). Vị trí đúng của quyết định là nơi **gần kết quả thật**
 * nhất — adapter là nơi duy nhất thấy được `WebPushSendResult` trước nó rồi phân chia.
 */
function mapSendResult(send: WebPushSendResult): ProviderTestResult {
  if (send.outcome === 'delivered') {
    return PROVIDER_TEST_RESULT.DeliveryAccepted;
  }

  if (send.outcome === 'failed') {
    switch (send.failureClass) {
      // `endpoint_invalid` phát ra **chỉ** khi provider chứng minh endpoint chết — 404 hoặc 410
      // (X8 của `createWebPushSender`, port `WebPushPermanentFailureClass`). DT-1: cùng nhóm 404.
      // ⚠️ `httpStatus === null` = endpoint **không parse được** (không phải https / URL hỏng) —
      // đây là pre-flight của adapter, không phải provider chứng minh endpoint chết. FR-018 gộp
      // nhánh này vào `configuration_invalid` (subscription/target configuration sai), không phải
      // `subscription_invalid` (provider chứng minh endpoint chết).
      case 'endpoint_invalid':
        return send.httpStatus === 404 || send.httpStatus === 410
          ? PROVIDER_TEST_RESULT.SubscriptionInvalid
          : PROVIDER_TEST_RESULT.ConfigurationInvalid;
      case 'provider_auth':
        return PROVIDER_TEST_RESULT.AuthenticationFailed;
      case 'payload_too_large':
        // 413 (hoặc pre-flight budget) — FR-018 nhánh `configuration_invalid`.
        return PROVIDER_TEST_RESULT.ConfigurationInvalid;
      case 'redirect_not_followed':
        // 3xx — FR-018 gộp vào `provider_rejected_request` (bảng brief).
        return PROVIDER_TEST_RESULT.ProviderRejectedRequest;
      case 'vapid_key_missing':
        // Credential không ký được JWT — probe **chưa gọi được** provider.
        return PROVIDER_TEST_RESULT.ConfigurationInvalid;
      default:
        return PROVIDER_TEST_RESULT.ConfigurationInvalid;
    }
  }

  // Transient — 429 / 5xx / trước_fetch / timeout / connection lost. FR-018 không có nhánh
  // "unknown"; những trường hợp này "không chứng minh được gì về endpoint" — nhóm đúng là
  // `provider_rejected_request`.
  return PROVIDER_TEST_RESULT.ProviderRejectedRequest;
}

/**
 * Adapter thật cho `ProviderProbe` — mỗi `sendTestDelivery` là **một** Web Push request.
 *
 * ⚠️ **Không log ở đây** (SR-002/SR-003): mọi giá trị của input là secret, một `logger.warn`
 * bất kỳ đủ để kéo vào đường lọt secret. `runProviderTest` đã ghi audit đúng shape từ use
 * case (FR-018, DT-3 không thêm event), nên adapter **không** nhắc lại và **không** log.
 *
 * ⚠️ `createWebPushSender` thực thi `redirect: 'manual'` + AbortController timeout — đúng
 * những gì một provider test thật cần, và những gì docs §5 đòi一遍 hơn "HTTP matrix thuần".
 *
 * ⚠️ Cả các lớp pre-flight của sender (`endpoint_invalid` từ endpoint không parse được, và
 * `vapid_key_missing` khi credential không import được) đều **không** gọi `fetch` — đúng
 * hành vi FR-018 nhánh "không gọi được provider", và test ở spec của composition root khẳng
 * định điều đó.
 */
export function createProviderProbe(): ProviderProbe {
  // Sender không giữ state gì (RFC 8291 §2: ECDH key mới mỗi message; JWT ký mới mỗi lần),
  // nên một instance dùng được cho mọi lần gọi probe — một `createWebPushSender` cho một
  // adapter, không phải một instance mỗi request.
  const sender = createWebPushSender();

  return {
    async sendTestDelivery(input: ProbeInput) {
      // ⚠️ Shape `WebPushSendRequest` đúng từng field — tên field sai là lỗi compile, không
      // phải lỗi runtime nổ ở chính URL/secret khi decode đã đi qua tới runtime.
      const request: WebPushSendRequest = {
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        vapidPrivateKey: input.privateKey,
        vapidPublicKey: input.publicKey,
        vapidSubject: input.vapidSubject,
        payloadJson: input.payloadJson,
        // ⚠️ TTL của test delivery lấy từ `expires_at` của delivery thật của claim
        // (worker §16: không vượt thời gian còn lại); một probe không claim delivery
        // nào nên không có mốc đó. `TTL = 0` là giá trị nhỏ nhất hợp lệ (WP4: không
        // lưu message) — push service không giữ message, test chỉ cần một delivery
        // được nhận ngay.
        ttlSeconds: 0,
        timeoutMs: input.timeoutMs,
      };

      const send = await sender.send(request);

      if (send.outcome === 'delivered') {
        return { ok: true };
      }

      // ⚠️ `detail` chỉ mang **nguyên nhân** phân loại — KHÔNG chứa status số, endpoint,
      // không bất kỳ giá trị nào nào response. `runProviderTest` đưa nó thẳng vào `detail`
      // của outcome (rồi vào response + audit), nên bất biến không-rò-secret phải thỏa
      // kể cả ở branch có classification sai.
      return {
        ok: false,
        classification: mapSendResult(send),
        detail: detailOf(send),
      };
    },
  };
}

/**
 * Detail **đã sanitize** cho một kết quả fail — mang đúng nguyên nhân mà không mang giá trị.
 *
 * ⚠️ Mỗi class một chuỗi **hằng riêng**: một `=== httpStatus` nối chuỗi là một đường mở để
 * giá trị runtime lọt vào `detail` rồi vào audit. Chuỗi ở đây chỉ chứa code/HTTP như một
 * **khoảng nhắc** mà operator có thể đối chiếu đúng runbook — không giá trị động nào.
 */
function detailOf(send: WebPushSendResult): string {
  if (send.outcome === 'delivered') {
    return 'Provider nhận test delivery.';
  }
  // Transient không mang `failureClass` — nhánh riêng, đúng shape của port.
  if (send.outcome === 'transient') {
    return 'Provider chưa chứng minh được kết quả (429, 5xx, timeout hoặc connection lost).';
  }
  switch (send.failureClass) {
    case 'endpoint_invalid':
      return 'Provider trả 404 hoặc 410 — subscription không còn hợp lệ.';
    case 'provider_auth':
      return 'Provider trả 401 hoặc 403 — từ chối xác thực.';
    case 'payload_too_large':
      return 'Payload test vượt trần hoặc provider trả 413.';
    case 'redirect_not_followed':
      return 'Provider trả redirect (3xx) — test không đi theo redirect.';
    case 'vapid_key_missing':
      return 'Credential VAPID không ký được JWT — kiểm credential.';
    default:
      return 'Provider trả lỗi không phân loại được — kiểm runbook.';
  }
}
