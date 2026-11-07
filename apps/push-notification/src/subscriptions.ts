/**
 * Application API — `Push Subscription` (FR-003, FR-004, §4.1).
 *
 * ⚠️ **Ba route này có đường serve thật, và business rule nằm ở
 * `@ecoma-io/push-notification-application` chứ không ở đây.** File này làm đúng ba việc mà
 * mọi route của service đều làm: xác thực, đọc body/path, và ánh xạ `reason` → status. Ba
 * quy tắc mà composition root **không** được tự quyết — dedupe theo `endpoint_hash`, "chỉ một
 * update secret tường minh mới hồi sinh subscription `disabled`" (FR-004), và `vapid_key_id`
 * phải là key mà `App` thật sự phục vụ — nằm trong `registerSubscription`
 * (`libs/push-notification-application/src/inventory-api.ts`).
 *
 * ⚠️ **Xác thực TRƯỚC khi đọc body.** Body là dữ liệu caller kiểm soát; đọc nó trước khi xác
 * thực làm lỗi parse (`400`) đến trước lỗi quyền (`401`) và lộ ra rằng route đã đọc body.
 * `tests/auth-boundary.spec.ts` đo thứ tự này bằng cách đếm lệnh D1 thật.
 *
 * ⚠️ **`app` lấy từ `caller.principal`, không lấy từ body** (§8.2). Các route ở đây **không**
 * nhận `app` nào từ body — nên không có dữ liệu nào để so sánh sai. Đây là khác biệt có chủ
 * đích với `POST /v1/notifications`, nơi body **có** `app` và use case so sánh nó với
 * principal: `02-requirements.md` §4.1 liệt kê `app` là field bắt buộc của request tạo
 * notification, không phải của request đăng ký device/subscription.
 *
 * ⚠️ **Không có `?reason=` ở các route này, và đó là khác biệt với Admin API.** Admin bắt
 * buộc `reason` vì một operator có thể gọi nhầm để dọn dữ liệu; ở Application API thì actor là
 * chính application đang quản lý namespace của nó, và bắt nó ghi lý do tự bảo vệ mình là một
 * hợp đồng không có trong FR-020.
 */

import type { Hono } from 'hono';

import {
  disableSubscriptionByApplication,
  registerSubscription,
  unregisterSubscription,
  type InventoryDeps,
} from '@ecoma-io/push-notification-application';

import type { RequireApplication } from './application-routes';
import {
  inventoryRejectionStatus,
  json,
  problem,
  readJsonObject,
  readNonEmptyString,
  readRequiredString,
} from './wire';

/**
 * Đăng ký ba route subscription của Application API.
 *
 * @param app App Hono đang dựng; route được gắn vào đúng instance mà `main.ts` export.
 * @param requireAuth Xác thực bearer token của Application API **và** trả về
 *   `{ deps, principal }`. Truyền vào như tham số (thay vì import) để file này **không** phụ
 *   thuộc config/D1 — nó chỉ cần biết "xác thực trước, rồi mới đọc body".
 */
export function applicationSubscriptionRoutes(app: Hono, requireAuth: RequireApplication): void {
  app.post('/v1/subscriptions', async (context) => {
    const authenticated = requireAuth(context);
    if (authenticated instanceof Response) {
      return authenticated;
    }

    const body = await readJsonObject(context.req.raw);
    if (!body.ok) {
      return problem(400, 'invalid_payload', body.detail);
    }

    const deviceId = readRequiredString(body.value, 'device_id');
    const userId = readRequiredString(body.value, 'user_id');
    const p256dh = readRequiredString(body.value, 'p256dh');
    const auth = readRequiredString(body.value, 'auth');
    const vapidKeyId = readRequiredString(body.value, 'vapid_key_id');
    const endpoint = body.value.endpoint;
    const transport = body.value.transport;
    if (
      deviceId === null ||
      userId === null ||
      p256dh === null ||
      auth === null ||
      vapidKeyId === null
    ) {
      return problem(
        400,
        'invalid_payload',
        'Cần `device_id` · `user_id` · `endpoint` · `p256dh` · `auth` · `vapid_key_id`.',
      );
    }

    const result = await registerSubscription(authenticated.deps, {
      // ⚠️ `app` **derive từ principal** (§8.2) — route này không đọc `app` từ body.
      authenticatedApp: authenticated.principal,
      principalId: authenticated.principal,
      deviceId,
      userId,
      // ⚠️ `endpoint` không ép kiểu ở đây: một giá trị không phải chuỗi phải đi tới
      // `validatePushEndpoint` để trả `endpoint_type` — ép `String(...)` ở biên là một
      // chuẩn hoá mà không tài liệu nào yêu cầu, và nó biến `42` thành `"42"`.
      endpoint: endpoint as string,
      p256dh,
      auth,
      vapidKeyId,
      // ⚠️ `transport` **không** ép kiểu `Transport`: giá trị ngoài vocabulary phải tới
      // use case để bị từ chối có lý do, không bị `as` biến thành hợp lệ.
      ...(transport === undefined ? {} : { transport: transport as never }),
    });

    if (!result.ok) {
      return problem(inventoryRejectionStatus(result.reason), result.reason, result.detail);
    }
    const { subscription, created } = result.value;
    return json(
      {
        subscription_id: subscription.subscriptionId,
        device_id: subscription.deviceId,
        app: subscription.app,
        transport: subscription.transport,
        status: subscription.status,
        vapid_key_id: subscription.vapidKeyId,
        created_at: toIso(subscription.createdAt),
      },
      // Đăng ký lại endpoint đã có là `200`, không phải `201` — client dùng status để biết
      // có phải nó vừa tạo ra một subscription hay không.
      created ? 201 : 200,
    );
  });

  app.patch('/v1/subscriptions/:subscriptionId', async (context) => {
    const authenticated = requireAuth(context);
    if (authenticated instanceof Response) {
      return authenticated;
    }

    const subscriptionId = readNonEmptyString(context.req.param('subscriptionId'));
    if (subscriptionId === null) {
      return problem(400, 'invalid_payload', 'Thiếu path param `subscriptionId`.');
    }
    const body = await readJsonObject(context.req.raw);
    if (!body.ok) {
      return problem(400, 'invalid_payload', body.detail);
    }
    // ⚠️ `PATCH` chỉ nhận `status: 'disabled'` (xem `disableSubscriptionByApplication`). Body
    // rỗng **không** phải "disable" — nếu nó là, một `PATCH` gõ nhầm sẽ vô hiệu hoá một
    // subscription thật.
    if (body.value.status !== 'disabled') {
      return problem(
        400,
        'invalid_payload',
        'Chỉ nhận `status: "disabled"` — §5.2 không có transition nào khác do client yêu cầu.',
      );
    }

    const result = await disableSubscriptionByApplication(
      authenticated.deps,
      {
        authenticatedApp: authenticated.principal,
        principalId: authenticated.principal,
        subscriptionId,
      },
      // ⚠️ Tên event là hằng của **route**, không phải tham số của caller: `PATCH` là "khoá" nên
      // ghi `subscription_disabled`; route `DELETE` bên dưới ghi `subscription_removed`.
      'subscription_disabled',
    );

    if (!result.ok) {
      return problem(inventoryRejectionStatus(result.reason), result.reason, result.detail);
    }
    return json({
      subscription_id: result.value.subscriptionId,
      status: result.value.status,
      updated_at: toIso(result.value.updatedAt),
    });
  });

  app.delete('/v1/subscriptions/:subscriptionId', async (context) => {
    const authenticated = requireAuth(context);
    if (authenticated instanceof Response) {
      return authenticated;
    }

    const subscriptionId = readNonEmptyString(context.req.param('subscriptionId'));
    if (subscriptionId === null) {
      return problem(400, 'invalid_payload', 'Thiếu path param `subscriptionId`.');
    }

    const result = await unregisterSubscription(authenticated.deps, {
      authenticatedApp: authenticated.principal,
      principalId: authenticated.principal,
      subscriptionId,
    });

    if (!result.ok) {
      return problem(inventoryRejectionStatus(result.reason), result.reason, result.detail);
    }
    return json({
      subscription_id: result.value.subscriptionId,
      status: result.value.status,
      // ⚠️ `removed: true` **không** nói "dòng đã bị xoá". §4.3: `DELETE` là logical revoke;
      // câu trả lời đúng là "không còn nhận delivery nữa".
      revoked: true,
    });
  });
}

/** Bọc epoch millis thành RFC 3339 — cùng cách `POST /v1/notifications` trả timestamp. */
function toIso(epochMillis: number): string {
  return new Date(epochMillis).toISOString();
}

/** Dùng lại để `main.ts` không phải khai một `InventoryDeps` thủ công. */
export type { InventoryDeps };
