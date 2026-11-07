/**
 * Application API — `Device` (FR-002, §4.1).
 *
 * ⚠️ **Route `/v1/devices` trước đây không tồn tại** — `02-requirements.md` §4.1 liệt kê
 * `POST /v1/devices` và `GET/DELETE /v1/devices/:id`, nhưng chỉ có `/admin/v1/devices` trong
 * Admin API. Đó là một khoảng trống của interface chứ không phải một thứ bị bỏ sót có chủ đích:
 * không có device thì FR-002 không thành, và §5.1 yêu cầu "không có `device_id` hợp lệ thì
 * không tạo subscription" — mà `device_id` hợp lệ chỉ có sau khi nó được đăng ký.
 *
 * ⚠️ **Ba việc, không business rule** — cùng nguyên tắc với `subscriptions.ts`: xác thực,
 * đọc input, ánh xạ `reason` → status. `registerDevice` / `getDevice` / `unregisterDevice`
 * nằm ở `libs/push-notification-application/src/inventory-api.ts`.
 *
 * ⚠️ **`DELETE /v1/devices/:id` là logical revoke, không xoá dòng** — §4.3: physical
 * deletion chỉ theo retention/cleanup policy. Bảng `devices` cũng không có cột status, nên
 * "disable device" ở v1 có nghĩa đúng một thứ: **không còn subscription `active`** nào của
 * device đó. Đó là điều mà FR-004 đòi, và use case trả về danh sách đã disable để caller biết
 * chính xác điều gì đã đổi.
 */

import type { Hono } from 'hono';

import {
  getDevice,
  registerDevice,
  unregisterDevice,
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
 * Đăng ký ba route device của Application API.
 *
 * @param app App Hono đang dựng; route được gắn vào đúng instance mà `main.ts` export.
 * @param requireAuth Cùng callback với `applicationSubscriptionRoutes` — xác thực trước, rồi
 *   mới đọc body hay lookup.
 */
export function applicationDeviceRoutes(app: Hono, requireAuth: RequireApplication): void {
  app.post('/v1/devices', async (context) => {
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
    if (deviceId === null || userId === null) {
      return problem(400, 'invalid_payload', 'Cần `device_id` và `user_id` không rỗng.');
    }
    // ⚠️ `display_name` là **tuỳ chọn**: nó không có requirement nào bắt buộc, và một
    // `display_name: ""` không phải là một cái tên — nó chỉ là một chuỗi rỗng mà browser không
    // sinh ra. `undefined` và `null` được giữ nguyên để use case quyết định, còn chuỗi rỗng
    // được chuẩn hoá thành `null` (không có tên) thay vì lưu một chuỗi rỗng.
    const displayName = readDisplayName(body.value.display_name);

    const result = await registerDevice(authenticated.deps, {
      // ⚠️ `app` **derive từ principal** (§8.2) — không có `app` trong body của route này.
      authenticatedApp: authenticated.principal,
      principalId: authenticated.principal,
      deviceId,
      userId,
      ...(displayName === undefined ? {} : { displayName }),
    });

    if (!result.ok) {
      return problem(inventoryRejectionStatus(result.reason), result.reason, result.detail);
    }
    return json(
      {
        device_id: result.value.device.deviceId,
        user_id: result.value.device.userId,
        app: result.value.device.app,
        created_at: toIso(result.value.device.createdAt),
      },
      // Đăng ký lại cùng `device_id` là idempotent (`200`), không phải `201` — §5.1 nói client
      // giữ `device_id` qua mọi session nên lần đăng ký thứ hai là chuyện thường, không phải lỗi.
      result.value.created ? 201 : 200,
    );
  });

  app.get('/v1/devices/:deviceId', async (context) => {
    const authenticated = requireAuth(context);
    if (authenticated instanceof Response) {
      return authenticated;
    }

    const deviceId = readNonEmptyString(context.req.param('deviceId'));
    if (deviceId === null) {
      return problem(400, 'invalid_payload', 'Thiếu path param `deviceId`.');
    }

    const result = await getDevice(authenticated.deps, {
      authenticatedApp: authenticated.principal,
      deviceId,
    });

    if (!result.ok) {
      return problem(inventoryRejectionStatus(result.reason), result.reason, result.detail);
    }
    return json({
      device_id: result.value.deviceId,
      user_id: result.value.userId,
      app: result.value.app,
      created_at: toIso(result.value.createdAt),
    });
  });

  app.delete('/v1/devices/:deviceId', async (context) => {
    const authenticated = requireAuth(context);
    if (authenticated instanceof Response) {
      return authenticated;
    }

    const deviceId = readNonEmptyString(context.req.param('deviceId'));
    if (deviceId === null) {
      return problem(400, 'invalid_payload', 'Thiếu path param `deviceId`.');
    }

    const result = await unregisterDevice(authenticated.deps, {
      authenticatedApp: authenticated.principal,
      principalId: authenticated.principal,
      deviceId,
    });

    if (!result.ok) {
      return problem(inventoryRejectionStatus(result.reason), result.reason, result.detail);
    }
    return json({
      device_id: result.value.deviceId,
      // Danh sách những subscription thật sự đã đổi trạng thái. Một device vốn đã không còn
      // subscription `active` trả `[]` — đó là kết quả mong muốn của một `DELETE` idempotent,
      // và nó phân biệt được với trường hợp cascade đã chạy.
      disabled_subscriptions: result.value.disabledSubscriptions,
      revoked: true,
    });
  });
}

/** `display_name` → `string | null | undefined` (`undefined` = không có trường trong body). */
function readDisplayName(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Bọc epoch millis thành RFC 3339. */
function toIso(epochMillis: number): string {
  return new Date(epochMillis).toISOString();
}
