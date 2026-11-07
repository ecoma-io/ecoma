/**
 * Application API — vòng đời `Device` và `Push Subscription` (FR-002, FR-003, FR-004, FR-006).
 *
 * Canonical: `docs/applications/push-notification/02-requirements.md` FR-002 (device dưới một
 * `User`), FR-003 (đăng ký subscription + endpoint validation chống SSRF + tránh trùng),
 * FR-004 (lifecycle `active`/`disabled`/`expired`), FR-006 (`vapid_key_id` của subscription),
 * FR-019 (authorization scope theo `App`), §4.1 (danh sách endpoint) ·
 * `01-architecture.md` §5.1 (device identity), §5.2 (state machine), §8.2 (`app` derive từ
 * principal), §9 (ba loại secret) · `03-operations.md` §7.2 (VAPID rotation, key mới phục
 * vụ subscription MỚI; key `compromised` không tạo subscription mới).
 *
 * ⚠️ **Vì sao đây là một use case chứ không phải một route wrapper.** Ba quy tắc ở đây mà
 * composition root **không** được tự quyết là: dedupe theo `endpoint_hash` với quy tắc
 * "trùng thì cập nhật secret chứ không tạo mới", "chỉ một update secret **tường minh** mới
 * được hồi sinh subscription `disabled`" (FR-004), và `vapid_key_id` phải là key mà `App`
 * thật sự phục vụ. Compose ba thứ đó ở tầng HTTP là viết business rule không có guard,
 * không có audit, không có domain transition — đúng thứ kiến trúc cấm.
 *
 * ⚠️ **Không có business rule nào ở route layer.** Route chỉ đọc body, gọi use case, và ánh
 * xạ `reason` → status qua một `switch` **cầu nối**. Xem header của `wire.ts`.
 *
 * ⚠️ **Không có audit event cho việc *tạo* device/subscription, và đó là khoảng trống thật
 * của tài liệu chứ không phải một lựa chọn.** FR-020 audit "thao tác quản trị **quan
 * trọng**" và liệt kê 12 event — không có event nào cho `device_created` hay
 * `subscription_created`, và `audit_records_event_check` trong
 * `apps/push-notification/migrations/0001_push_core.sql` chốt đúng 12 giá trị đó. Vì vậy:
 *
 * - Các transition **có** event trong FR-020 (`subscription_disabled`, `subscription_removed`)
 *   được audit ở đây, và đó là toàn bộ điều FR-020 đòi.
 * - Việc **tạo** device/subscription không ghi audit, vì ghi nó đòi **thêm** một event vào
 *   FR-020 **và** nới CHECK của schema — một thay đổi tài liệu + migration mà implementation
 *   không tự quyết (`AGENTS.md`: không biến một quyết định chưa chốt thành implementation).
 *   Báo cáo giao việc nêu khoảng trống này.
 */

/* -------------------------------------------------------------------------------------- */
/* Imports                                                                                      */
/* -------------------------------------------------------------------------------------- */

import {
  SUBSCRIPTION_DISABLE_CAUSE,
  SUBSCRIPTION_STATUS,
  V1_EXECUTABLE_TRANSPORT,
  disableSubscription,
  isNonEmptyString,
  type Transport,
} from '@ecoma-io/push-notification-domain';

import type { PushNotificationConfig } from './config-port';
import type { IdGenerator, RequestHasher } from './create-notification';
import { validatePushEndpoint } from './endpoint-validation';
import type { PushNotificationPorts } from './ports';
import { AUDIT_EVENT, type DeviceRecord, type SubscriptionRecord } from './records';
// ⚠️ `SubscriptionView` được **tái sử dụng** từ `admin-delivery.ts` thay vì khai một projection
// thứ hai: cả hai đường đều trả về cùng một tập field cho cùng một bảng, và hai projection
// trôi khỏi nhau là hai nơi phải sửa khi shape đổi. Projection đó **không** có
// `endpoint`/`p256dh`/`auth`/`endpoint_hash` — §9 loại secret 2.
import type { SubscriptionView } from './admin-delivery';

/* -------------------------------------------------------------------------------------- */
/* Dependency và kết quả                                                                        */
/* -------------------------------------------------------------------------------------- */

/**
 * Dependency của use case inventory — `hasher` dùng để tạo `endpoint_hash`.
 *
 * ⚠️ `hasher` là **cùng** `RequestHasher` mà `createNotification` dùng cho canonical request
 * hash, và đó là chủ ý: đó chỉ là `hash(string): Promise<string>` và giá trị của nó **mờ**
 * với mọi tầng — repository chỉ `WHERE endpoint_hash = ?` và schema chỉ unique theo nó. Một
 * hàm hash thứ hai cho endpoint là một nguồn sự thật thứ hai cho cùng một thứ, và nó phải xuất
 * hiện trong `endpoint_hash` của **mọi** hàng đã ghi — nghĩa là một hàm hash đổi là hỏng dữ
 * liệu, không phải một refactor.
 */
export interface InventoryDeps {
  readonly config: PushNotificationConfig;
  readonly ports: PushNotificationPorts;
  readonly ids: IdGenerator;
  readonly hasher: RequestHasher;
}

/**
 * Lý do từ chối một use case inventory — vocabulary **đóng**, tách khỏi `ADMIN_REJECTION`
 * (Admin API) và `REQUEST_REJECTION` (`createNotification`).
 *
 * ⚠️ Ba tập `reason` là ba **hợp đồng** với ba consumer khác nhau; xem lý do tách ở
 * `admin-provider.ts` (`ADMIN_REJECTION`). Ở đây các nhánh là những thứ **chỉ** tồn tại ở
 * vòng đời inventory: một `device_id` thuộc user khác, một subscription `expired` không hồi
 * sinh được, một `App` chưa có provider primary.
 */
export const INVENTORY_REJECTION = {
  /** Body thiếu/sai shape — ghi trước khi chạm D1. */
  InvalidPayload: 'invalid_payload',
  /** `App` của request khác `App` derive từ principal (§8.2, FR-007). */
  AppMismatch: 'app_mismatch',
  /** Endpoint không qua validation FR-003 (SSRF) — chưa chạm D1. */
  EndpointRejected: 'endpoint_rejected',
  /** `device_id` không tồn tại trong `App` của caller. */
  DeviceNotFound: 'device_not_found',
  /** `subscription_id` không tồn tại trong `App` của caller. */
  SubscriptionNotFound: 'subscription_not_found',
  /** `device_id` đã thuộc `User` khác — không cho chiếm đoạt. */
  DeviceOwnedByAnotherUser: 'device_owned_by_another_user',
  /** Endpoint đã thuộc một `Device` khác của cùng `App`. */
  EndpointOwnedByAnotherDevice: 'endpoint_owned_by_another_device',
  /** Subscription `expired` không có transition đi ra (§5.2) — phải đăng ký endpoint mới. */
  SubscriptionExpired: 'subscription_expired',
  /** `App` chưa có provider primary cho scope → subscription sẽ không bao giờ nhận delivery. */
  NoProviderForScope: 'no_provider_for_scope',
  /** `vapid_key_id` không phải key mà `App` phục vụ, hoặc key đó `compromised` (§7.2). */
  VapidKeyUnavailable: 'vapid_key_unavailable',
  /** Ghi D1/audit thất bại — thao tác chưa xảy ra hoàn chỉnh nên không trả `2xx`. */
  StorageFailure: 'storage_failure',
} as const;

export type InventoryRejection = (typeof INVENTORY_REJECTION)[keyof typeof INVENTORY_REJECTION];

/** Kết quả use case inventory — thành công có dữ liệu, hoặc từ chối với `reason` đóng. */
export type InventoryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: InventoryRejection; readonly detail: string };

/* -------------------------------------------------------------------------------------- */
/* Device (FR-002)                                                                              */
/* -------------------------------------------------------------------------------------- */

/** Input của `POST /v1/devices`. */
export interface RegisterDeviceCommand {
  /**
   * `App` **derive từ authenticated principal**, không lấy từ body (§8.2). Route truyền
   * `caller.principal` vào đây; một body mang `app` khác chỉ là dữ liệu caller kiểm soát.
   */
  readonly authenticatedApp: string;
  /** Principal đã xác thực — đi vào `actor` của audit record. */
  readonly principalId: string;
  /** `device_id` do **client** sinh và giữ qua các session (§5.1). */
  readonly deviceId: string;
  readonly userId: string;
  readonly displayName?: string | null;
}

/**
 * `POST /v1/devices` — đăng ký `Device` của một `User` (FR-002).
 *
 * ⚠️ **Đăng ký lại cùng `device_id` là idempotent, không phải lỗi.** §5.1 nói client tạo
 * `device_id` một lần và **mọi** request đăng ký/ghi subscription sau đó gửi kèm nó — nên
 * trả `409` cho lần đăng ký thứ hai sẽ hỏng một client đúng. Vì vậy `device_id` tồn tại và
 * thuộc đúng `(app, user)` → trả record hiện có.
 *
 * ⚠️ **`device_id` thuộc `User` khác bị từ chối, không bị gán lại.** `device_id` là định
 * danh do client sinh và nó là khoá chính của bảng `devices`; nếu `User` B gửi
 * `device_id` của `User` A thì "đăng ký lại" sẽ âm thầm chuyển device — kèm mọi subscription
 * `active` của nó — sang user của người gọi. Đó là một đường chiếm đoạt, không phải một
 * request idempotent.
 *
 * ⚠️ **`display_name` chỉ được ghi ở lần đăng ký đầu.** Không có requirement nào yêu cầu sửa
 * nó sau đó, và "last writer wins" trên một field mà nhiều session cùng ghi là một quyết định
 * không ai chốt. Việc đổi tên hiển thị cần một operation riêng, không phải một nhánh ngầm
 * trong đăng ký lại.
 */
export async function registerDevice(
  deps: InventoryDeps,
  command: RegisterDeviceCommand,
): Promise<InventoryResult<{ readonly device: DeviceRecord; readonly created: boolean }>> {
  const now = deps.ports.clock.now();
  const shape = validateDeviceShape(command);
  if (shape !== null) {
    return shape;
  }

  const existing = await deps.ports.devices.findById(command.deviceId);
  if (existing !== null) {
    if (existing.app !== command.authenticatedApp) {
      return {
        ok: false,
        reason: INVENTORY_REJECTION.AppMismatch,
        detail: 'Device thuộc app khác — FR-001/FR-007 cấm dùng chéo app.',
      };
    }
    if (existing.userId !== command.userId) {
      return {
        ok: false,
        reason: INVENTORY_REJECTION.DeviceOwnedByAnotherUser,
        detail: 'Device đã thuộc user khác — một device không đổi chủ qua đăng ký lại.',
      };
    }
    // Idempotent: `created: false` để route trả `200` thay vì `201`.
    return { ok: true, value: { device: existing, created: false } };
  }

  const device: DeviceRecord = {
    deviceId: command.deviceId,
    userId: command.userId,
    app: command.authenticatedApp,
    createdAt: now,
  };
  try {
    const inserted = await deps.ports.devices.insert(device, command.displayName ?? null);
    return { ok: true, value: { device: inserted, created: true } };
  } catch {
    // ⚠️ D1 từ chối `devices_pkey` khi hai request đăng ký cùng `device_id` chạy đồng thời.
    // Đó **không** phải lỗi của caller: cả hai đều là một request hợp lệ và kết quả mong muốn
    // là cùng một device. Nhánh này đọc lại để trả kết quả đúng thay vì `503`.
    const raced = await deps.ports.devices.findById(command.deviceId);
    if (raced !== null && raced.app === command.authenticatedApp) {
      return { ok: true, value: { device: raced, created: false } };
    }
    return {
      ok: false,
      reason: INVENTORY_REJECTION.StorageFailure,
      detail: 'Không ghi được device.',
    };
  }
}

/**
 * `GET /v1/devices/:id` — đọc device **của chính caller**.
 *
 * ⚠️ **Kiểm `app` trên record trả về, không lọc `app` trong query.** `DeviceRepository.findById`
 * cố ý không lọc `app` (xem lý do ở `ports.ts`); ở đâng caller đã xác thực và đã biết `app`
 * hợp lệ của mình, nên so sánh trên record là đủ và cho hai lý do tách biệt được.
 *
 * ⚠️ **Ranh giới scope của Application API là `App`, không phải `User`.** FR-019 nói
 * application chỉ quản lý được thứ thuộc scope mình; ở v1 Application API có đúng một
 * application token (`03-operations.md` §11), nên `App` **là** scope và `user_id` trong
 * request là dữ liệu của chính caller. Đọc device của user khác **cùng app** là hợp lệ ở
 * đây — nó là đường mà một ứng dụng web cần để hiển thị danh sách thiết bị đã đăng ký.
 */
export async function getDevice(
  deps: InventoryDeps,
  command: { readonly authenticatedApp: string; readonly deviceId: string },
): Promise<InventoryResult<DeviceRecord>> {
  if (!isNonEmptyString(command.deviceId)) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.InvalidPayload,
      detail: 'Thiếu `deviceId`.',
    };
  }
  const device = await deps.ports.devices.findById(command.deviceId);
  if (device === null) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.DeviceNotFound,
      detail: 'Device không tồn tại.',
    };
  }
  if (device.app !== command.authenticatedApp) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.AppMismatch,
      detail: 'Device thuộc app khác — FR-001/FR-007 cấm dùng chéo app.',
    };
  }
  return { ok: true, value: device };
}

/**
 * `DELETE /v1/devices/:id` — **logical revoke**: disable mọi subscription của device.
 *
 * ⚠️ **Không xoá dòng `devices`.** §4.3: physical deletion chỉ theo retention/cleanup policy,
 * và historical references cần cho audit/delivery history `MUST NOT` bị xoá trước retention.
 * Bảng `devices` cũng **không có cột status** — không có trạng thái "đã xoá" để ghi, và thêm
 * một cột chỉ để phục vụ một `DELETE` là một thay đổi schema mà không requirement nào đòi.
 * `DELETE` ở đây có nghĩa đúng một thứ: device này không còn nhận delivery nào nữa.
 *
 * ⚠️ **Cascade chỉ disable `active`, và chỉ audit khi thật sự đổi.** `disableById` guard
 * `status = 'active'` nên một subscription đã `disabled` trả `null`; ghi audit cho nó là một
 * bằng chứng nói dối (không có thay đổi nào ứng với) — cùng lý do `invalidateSubscription`
 * chỉ audit khi `changed: true`.
 *
 * ⚠️ **`expired` không cần xử lý.** `disableById` trả `null` cho nó, và `expired` vốn đã
 * không nhận delivery mới (§5.2) — nên kết quả mong muốn đã đúng sẵn.
 */
export async function unregisterDevice(
  deps: InventoryDeps,
  command: {
    readonly authenticatedApp: string;
    readonly principalId: string;
    readonly deviceId: string;
  },
): Promise<
  InventoryResult<{
    readonly deviceId: string;
    readonly disabledSubscriptions: readonly string[];
  }>
> {
  const now = deps.ports.clock.now();
  if (!isNonEmptyString(command.deviceId)) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.InvalidPayload,
      detail: 'Thiếu `deviceId`.',
    };
  }

  const device = await deps.ports.devices.findById(command.deviceId);
  if (device === null) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.DeviceNotFound,
      detail: 'Device không tồn tại.',
    };
  }
  if (device.app !== command.authenticatedApp) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.AppMismatch,
      detail: 'Device thuộc app khác — FR-001/FR-007 cấm dùng chéo app.',
    };
  }

  const subscriptions = await deps.ports.subscriptions.listByDevice(
    command.authenticatedApp,
    command.deviceId,
  );
  const disabled: string[] = [];
  for (const subscription of subscriptions) {
    // Chỉ transition những cái còn `active`: domain là nơi quyết định, không phải một
    // `if (status === 'active')` lặp lại ở đây.
    const decision = disableSubscription(
      subscription.status,
      SUBSCRIPTION_DISABLE_CAUSE.UserUnregister,
    );
    if (!decision.ok || !decision.changed) {
      continue;
    }
    try {
      const updated = await deps.ports.subscriptions.disableById({
        app: command.authenticatedApp,
        subscriptionId: subscription.subscriptionId,
        cause: SUBSCRIPTION_DISABLE_CAUSE.UserUnregister,
        now,
      });
      if (updated === null) {
        // Thua race: một writer khác đã disable nó trước. Đó **không** phải lỗi — kết quả
        // mong muốn đã đạt, và `disableById` giữ nguyên nguyên nhân của lần disable đầu.
        continue;
      }
      disabled.push(updated.subscriptionId);
      await deps.ports.audit.append({
        auditId: subscriptionAuditId(AUDIT_EVENT.SubscriptionDisabled, updated.subscriptionId, now),
        event: AUDIT_EVENT.SubscriptionDisabled,
        actor: command.principalId,
        entityType: 'push_subscription',
        entityId: updated.subscriptionId,
        detail: {
          app: command.authenticatedApp,
          cause: SUBSCRIPTION_DISABLE_CAUSE.UserUnregister,
          // Ghi lại device để đọc audit không cần join bảng khác: một admin hỏi "subscription
          // này bị khoá vì lý do gì" cần thấy nó đến từ thao tác unregister device nào.
          device_id: command.deviceId,
        },
        now,
      });
    } catch {
      return {
        ok: false,
        reason: INVENTORY_REJECTION.StorageFailure,
        detail: 'Không disable được subscription của device.',
      };
    }
  }

  return { ok: true, value: { deviceId: command.deviceId, disabledSubscriptions: disabled } };
}

/* -------------------------------------------------------------------------------------- */
/* Subscription: đăng ký (FR-003)                                                               */
/* -------------------------------------------------------------------------------------- */

/** Input của `POST /v1/subscriptions`. */
export interface RegisterSubscriptionCommand {
  /** `App` derive từ authenticated principal (§8.2) — không lấy từ body. */
  readonly authenticatedApp: string;
  readonly principalId: string;
  readonly deviceId: string;
  readonly userId: string;
  /** Endpoint do browser tạo (`PushSubscription.endpoint`) — validate theo FR-003. */
  readonly endpoint: string;
  /** `PushSubscription.keys.p256dh`. */
  readonly p256dh: string;
  /** `PushSubscription.keys.auth`. */
  readonly auth: string;
  /**
   * `vapid_key_id` mà client đã dùng khi tạo subscription.
   *
   * ⚠️ Caller **phải** gửi nó, và nó **được kiểm** chứ không tin: xem `resolveVapidKeyId`.
   * Suy ra từ "key hiện tại của `App`" là đúng lý do làm hỏng delivery âm thầm (FR-006).
   */
  readonly vapidKeyId: string;
  /** `Transport`; v1 chỉ `web` chạy được — `app` bị từ chối (§2.2 non-goal). */
  readonly transport?: Transport;
}

/** Kết quả `POST /v1/subscriptions` — phân biệt tạo mới với đăng ký lại. */
export type RegisterSubscriptionResult =
  | {
      readonly ok: true;
      readonly value: { readonly subscription: SubscriptionView; readonly created: boolean };
    }
  | { readonly ok: false; readonly reason: InventoryRejection; readonly detail: string };

/**
 * `POST /v1/subscriptions` — đăng ký hoặc cập nhật secret của một subscription (FR-003).
 *
 * ⚠️ **Validate endpoint TRƯỚC mọi lần chạm D1.** FR-003 chống SSRF, và một endpoint sai không
 * nên tốn một round-trip storage. Thứ tự cũng là thứ tự chẩn đoán: shape thiếu → endpoint sai
 * → device sai → dedupe → ghi.
 *
 * ⚠️ **Dedupe theo `endpoint_hash`, và ba nhánh state là ba quyết định khác nhau** (xem
 * `resolveRegistration`): `active` → trả về hiện có, `disabled` → `reactivateWithNewSecret`,
 * `expired` → từ chối. Ba nhánh đó là **FR-004**: "chỉ một update secret **tường minh** của
 * client mới đưa subscription về `active`", và §5.2 không có transition nào đi ra từ
 * `expired`.
 *
 * ⚠️ **Endpoint thuộc `App` khác bị từ chối, không bị chiếm đoạt.** `endpoint_hash` unique
 * **toàn cục** (schema: `push_subscriptions_endpoint_unique`) vì một endpoint là một định
 * danh duy nhất của Browser Push Service. `App` B gửi endpoint của `App` A mà ta ghi đè
 * secret thì B chiếm endpoint đó và A mất khả năng gửi — namespace FR-001 bị vi phạm âm
 * thầm, đúng cái `createNotification` cấm ở phía gửi.
 *
 * ⚠️ **Trả projection, không trả material.** `endpoint`/`p256dh`/`auth`/`endpoint_hash` không
 * lọt ra response: chúng là secret loại 2 của §9, và client vừa gửi lên chúng nên không cần
 * nhận về.
 */
export async function registerSubscription(
  deps: InventoryDeps,
  command: RegisterSubscriptionCommand,
): Promise<RegisterSubscriptionResult> {
  const now = deps.ports.clock.now();

  const shape = validateSubscriptionShape(command);
  if (shape !== null) {
    return shape;
  }

  // ⚠️ `transport` không bắt buộc và mặc định là transport **chạy được** ở v1. Bắt caller khai
  // `transport` sẽ đi ngược tinh thần FR-008 ("caller MUST NOT cần biết transport") — và với
  // v1, `web` là câu trả lời duy nhất có ý nghĩa.
  const transport = command.transport ?? V1_EXECUTABLE_TRANSPORT;
  if (transport !== V1_EXECUTABLE_TRANSPORT) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.InvalidPayload,
      detail: `Transport \`${transport}\` chưa triển khai ở v1 (§2.2 non-goal).`,
    };
  }

  const endpoint = validatePushEndpoint(command.endpoint, deps.config.pushEndpointHostAllowlist);
  if (!endpoint.ok) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.EndpointRejected,
      detail: `Endpoint không hợp lệ (${endpoint.reason}).`,
    };
  }
  if (!isNonEmptyString(command.p256dh) || !isNonEmptyString(command.auth)) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.InvalidPayload,
      detail: 'Cần `p256dh` và `auth` không rỗng.',
    };
  }

  const device = await deps.ports.devices.findById(command.deviceId);
  if (device === null) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.DeviceNotFound,
      detail:
        'Device chưa được đăng ký — §5.1: không có device_id hợp lệ thì không tạo subscription.',
    };
  }
  if (device.app !== command.authenticatedApp) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.AppMismatch,
      detail: 'Device thuộc app khác — FR-001/FR-007 cấm dùng chéo app.',
    };
  }
  // ⚠️ `push_subscriptions` mang **cả** `user_id` và `device_id`, và routing đi
  // `device → subscription` nhưng lấy `user_id` từ **subscription** (`createNotification`).
  // Hai cột lệch nhau là một subscription được route tới một user không sở hữu device đó —
  // một hỏng dữ liệu âm thầm, và rẻ nhất để chặn là ngay ở đăng ký.
  if (device.userId !== command.userId) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.DeviceOwnedByAnotherUser,
      detail: 'Device thuộc user khác — subscription phải gắn vào user sở hữu device.',
    };
  }

  const endpointHash = await deps.hasher.hash(endpoint.value.endpoint);

  const vapidKeyId = await resolveVapidKeyId(deps, command.authenticatedApp, transport, {
    vapidKeyId: command.vapidKeyId,
    endpointHash,
  });
  if (typeof vapidKeyId !== 'string') {
    return vapidKeyId;
  }

  const resolved = await resolveRegistration(deps, {
    authenticatedApp: command.authenticatedApp,
    deviceId: command.deviceId,
    userId: command.userId,
    transport,
    endpoint: endpoint.value.endpoint,
    endpointHash,
    p256dh: command.p256dh,
    auth: command.auth,
    vapidKeyId,
    now,
  });
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true,
    value: { subscription: toSubscriptionView(resolved.value), created: resolved.created },
  };
}

/* -------------------------------------------------------------------------------------- */
/* Subscription: disable (FR-004)                                                               */
/* -------------------------------------------------------------------------------------- */

/** Input của `PATCH`/`DELETE /v1/subscriptions/:id`. */
export interface SubscriptionCommand {
  readonly authenticatedApp: string;
  /** Principal đã xác thực — đi vào `actor` của audit record (FR-020/FR-019). */
  readonly principalId: string;
  readonly subscriptionId: string;
}

/**
 * `PATCH /v1/subscriptions/:id` — user tự disable subscription của mình.
 *
 * ⚠️ **`PATCH` chỉ nhận `status: 'disabled'`.** §5.2 khai hai transition xuất phát từ `active`
 * (`→ disabled` và `→ expired`), và `expired` là chính sách lifecycle thu hồi theo thời hạn —
 * không phải một lựa chọn của client. Cho client gửi bất kỳ giá trị nào khác là một bề mặt
 * không tài liệu mô tả; nó bị từ chối thay vì bị bỏ qua.
 *
 * ⚠️ **Idempotent trên `disabled`** (FR-004 + §8.1): `disableSubscription` trả `changed: false`
 * và use case trả `200` với record hiện tại. Báo lỗi ở đây biến một lời gọi lặp thành lỗi.
 */
export async function disableSubscriptionByApplication(
  deps: InventoryDeps,
  command: SubscriptionCommand,
  event: typeof AUDIT_EVENT.SubscriptionDisabled | typeof AUDIT_EVENT.SubscriptionRemoved,
): Promise<InventoryResult<SubscriptionView>> {
  const now = deps.ports.clock.now();
  const target = await findSubscriptionInScope(deps, command);
  if (!target.ok) {
    return target;
  }
  return applyDisable(deps, target.value, command.principalId, now, event);
}

/**
 * `DELETE /v1/subscriptions/:id` — user unregister subscription.
 *
 * ⚠️ **Cùng transition, audit event khác.** FR-020 liệt kê `subscription_disabled` và
 * `subscription_removed` như hai event, và chúng trả lời hai câu hỏi khác nhau khi đọc lại
 * audit: "ai đã khoá subscription này" (`PATCH`) và "ai đã gỡ nó khỏi app của mình" (`DELETE`).
 * Cùng lý do `removeSubscriptionByAdmin` tách hai event cho cùng một transition.
 *
 * ⚠️ **Không xoá dòng.** §4.3: `DELETE` là logical revoke; physical deletion chỉ theo
 * retention/cleanup policy.
 */
export async function unregisterSubscription(
  deps: InventoryDeps,
  command: SubscriptionCommand,
): Promise<InventoryResult<SubscriptionView>> {
  return disableSubscriptionByApplication(deps, command, AUDIT_EVENT.SubscriptionRemoved);
}

/* -------------------------------------------------------------------------------------- */
/* Helpers — shape, scope, transition                                                            */
/* -------------------------------------------------------------------------------------- */

function validateDeviceShape(
  command: RegisterDeviceCommand,
): { readonly ok: false; readonly reason: InventoryRejection; readonly detail: string } | null {
  if (!isNonEmptyString(command.authenticatedApp)) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.AppMismatch,
      detail: 'Chưa xác thực được `app` — không có principal thì không có namespace.',
    };
  }
  if (!isNonEmptyString(command.deviceId)) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.InvalidPayload,
      detail: 'Thiếu `device_id` — §5.1: client tạo và giữ định danh này.',
    };
  }
  if (!isNonEmptyString(command.userId)) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.InvalidPayload,
      detail: 'Thiếu `user_id` — FR-002: device luôn dưới một user.',
    };
  }
  return null;
}

function validateSubscriptionShape(
  command: RegisterSubscriptionCommand,
): { readonly ok: false; readonly reason: InventoryRejection; readonly detail: string } | null {
  if (!isNonEmptyString(command.authenticatedApp)) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.AppMismatch,
      detail: 'Chưa xác thực được `app` — không có principal thì không có namespace.',
    };
  }
  if (!isNonEmptyString(command.deviceId) || !isNonEmptyString(command.userId)) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.InvalidPayload,
      detail: 'Cần `device_id` và `user_id` không rỗng.',
    };
  }
  if (!isNonEmptyString(command.vapidKeyId)) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.InvalidPayload,
      detail: 'Thiếu `vapid_key_id` — FR-006: subscription gắn với key pair dùng lúc tạo.',
    };
  }
  return null;
}

/**
 * Kiểm `vapid_key_id` của client có phải key mà `App` thật sự phục vụ cho subscription **mới**.
 *
 * ⚠️ **Hai điều kiện, và cả hai đều là MUST của tài liệu:**
 *
 * 1. Key phải thuộc provider **primary** của `(app, transport)`. Không có provider thì
 *    subscription vừa tạo sẽ không bao giờ nhận delivery — và client sẽ tin là đã đăng ký
 *    xong. FR-005 yêu cầu fail-safe; ở đường đăng ký fail-safe nghĩa là **từ chối**.
 * 2. Key `compromised` **không** được phục vụ subscription mới (§7.2) — subscription cũ thì
 *    vẫn được phục vụ theo policy, nhưng một subscription mới trên key đó sẽ không bao giờ
 *    gửi được.
 *
 * ⚠️ **`vapid_key_id` không còn lấy từ "key hiện tại của `App``.** Đó là hẹn giờ của
 * `resolveSubscriptionSigningKeyId` ở domain — một hàm dành cho **claim** (đọc lại key của
 * một subscription đã tồn tại), không phải cho đăng ký mới. Dùng nó ở đây là chọn key theo
 * key của *App* thay vì key của *client*, đúng cái hỏng delivery âm thầm FR-006 cấm.
 */
async function resolveVapidKeyId(
  deps: InventoryDeps,
  app: string,
  transport: Transport,
  key: { readonly vapidKeyId: string; readonly endpointHash: string },
): Promise<
  string | { readonly ok: false; readonly reason: InventoryRejection; readonly detail: string }
> {
  const mapping = await deps.ports.providers.findPrimaryMapping(app, transport);
  if (mapping === null) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.NoProviderForScope,
      detail:
        'App chưa có provider primary cho transport này — subscription sẽ không nhận delivery.',
    };
  }
  // Tên `credentialRecord` (không phải `credential`) là có chủ đích: giá trị là
  // một hàng `ProviderCredentialRecord` đọc từ storage — record metadata có
  // `vapidKeyId`/`status`, không phải credential thô; cái hàm này trả ra caller là
  // `vapidKeyId` (mã nhận dạng công khai trên wire FR-006), không phải ciphertext
  // hay private key. rule Semgrep `.github/semgrep/security.yml` coi identifier
  // khớp tên nhạy cảm rồi `return` là rò credential — tên record nói đúng loại
  // giá trị, và `return credentialCiphertext` ở một đường khác vẫn bị flag như cũ.
  const credentialRecord = await deps.ports.providerCredentials.findByVapidKeyId(
    app,
    mapping.providerId,
    key.vapidKeyId,
  );
  if (credentialRecord === null) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.VapidKeyUnavailable,
      detail:
        'VAPID key không thuộc provider primary của app — không thể đăng ký subscription trên key này.',
    };
  }
  if (credentialRecord.status !== 'active') {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.VapidKeyUnavailable,
      detail: `VAPID key đang \`${credentialRecord.status}\` — §7.2: không tạo subscription mới trên key này.`,
    };
  }
  return credentialRecord.vapidKeyId;
}

/** Ba nhánh dedupe của FR-003/FR-004 — xem header `registerSubscription`. */
async function resolveRegistration(
  deps: InventoryDeps,
  input: {
    readonly authenticatedApp: string;
    readonly deviceId: string;
    readonly userId: string;
    readonly transport: Transport;
    readonly endpoint: string;
    readonly endpointHash: string;
    readonly p256dh: string;
    readonly auth: string;
    readonly vapidKeyId: string;
    readonly now: number;
  },
): Promise<
  | { readonly ok: true; readonly value: SubscriptionRecord; readonly created: boolean }
  | { readonly ok: false; readonly reason: InventoryRejection; readonly detail: string }
> {
  const existing = await deps.ports.subscriptions.findByEndpointHash(input.endpointHash);
  if (existing === null) {
    try {
      const inserted = await deps.ports.subscriptions.insert({
        subscriptionId: deps.ids.next(),
        deviceId: input.deviceId,
        userId: input.userId,
        app: input.authenticatedApp,
        transport: input.transport,
        endpoint: input.endpoint,
        endpointHash: input.endpointHash,
        p256dh: input.p256dh,
        auth: input.auth,
        vapidKeyId: input.vapidKeyId,
        now: input.now,
      });
      return { ok: true, value: inserted, created: true };
    } catch {
      return {
        ok: false,
        reason: INVENTORY_REJECTION.StorageFailure,
        detail: 'Không ghi được subscription.',
      };
    }
  }

  if (existing.app !== input.authenticatedApp) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.AppMismatch,
      detail: 'Endpoint đã thuộc app khác — một endpoint là một định danh duy nhất.',
    };
  }
  // ⚠️ Endpoint đã ở trên một device khác **cùng app**. `reactivateWithNewSecret` chỉ ghi
  // endpoint/p256dh/auth/vapid_key_id — nó **không** đổi `device_id`/`user_id` — nên gọi nó ở
  // đây sẽ hồi sinh một subscription vẫn gắn với device cũ trong khi request nói device mới.
  // Đó là một liên kết sai mà không có test nào khác phát hiện được.
  if (existing.deviceId !== input.deviceId) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.EndpointOwnedByAnotherDevice,
      detail:
        'Endpoint đã thuộc device khác của cùng app — subscription gắn với device đã đăng ký.',
    };
  }

  if (existing.status === SUBSCRIPTION_STATUS.Active) {
    // ⚠️ **Không ghi secret mới lên một subscription `active`.** `reactivateWithNewSecret` guard
    // `status = 'disabled'` cố ý — FR-004 không có transition `active → active`, và delivery
    // đang chờ claim giữ `p256dh`/`auth` của hàng hiện tại. Ghi đè chúng là thay secret **giữa
    // chừng** một delivery đã materialize. Đăng ký lại với endpoint đã `active` là idempotent.
    return { ok: true, value: existing, created: false };
  }

  if (existing.status === SUBSCRIPTION_STATUS.Expired) {
    // §5.2 chỉ khai transition **xuất phát từ** `active`; `expired` là trạng thái đóng và
    // `reactivateWithNewSecret` từ chối nó ở trong statement. Browser sinh endpoint **mới** khi
    // subscribe lại, nên đường thật của client là đăng ký endpoint mới — nói rõ điều đó thay vì
    // trả một lỗi chung chung.
    return {
      ok: false,
      reason: INVENTORY_REJECTION.SubscriptionExpired,
      detail:
        'Subscription đã hết hạn (expired) — không hồi sinh được (§5.2). Client phải subscribe lại để có endpoint mới.',
    };
  }

  try {
    const reactivated = await deps.ports.subscriptions.reactivateWithNewSecret({
      subscriptionId: existing.subscriptionId,
      deviceId: existing.deviceId,
      userId: existing.userId,
      app: existing.app,
      transport: input.transport,
      endpoint: input.endpoint,
      endpointHash: input.endpointHash,
      p256dh: input.p256dh,
      auth: input.auth,
      vapidKeyId: input.vapidKeyId,
      now: input.now,
    });
    if (reactivated !== null) {
      return { ok: true, value: reactivated, created: false };
    }
    // Thua race: một request trùng khác đã hồi sinh trước (guard nằm trong statement, nên chỉ
    // một lệnh thắng). Đọc lại và trả kết quả **của** lệnh thắng — không dựng record từ input.
    const raced = await deps.ports.subscriptions.findByEndpointHash(input.endpointHash);
    if (raced !== null && raced.status === SUBSCRIPTION_STATUS.Active) {
      return { ok: true, value: raced, created: false };
    }
    return {
      ok: false,
      reason: INVENTORY_REJECTION.StorageFailure,
      detail: 'Không hồi sinh được subscription — trạng thái đã đổi sau khi đọc.',
    };
  } catch {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.StorageFailure,
      detail: 'Không hồi sinh được subscription.',
    };
  }
}

async function findSubscriptionInScope(
  deps: InventoryDeps,
  command: SubscriptionCommand,
): Promise<InventoryResult<SubscriptionRecord>> {
  if (!isNonEmptyString(command.subscriptionId)) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.InvalidPayload,
      detail: 'Thiếu `subscriptionId`.',
    };
  }
  // Cố ý tra **không** lọc `app` (xem `DeviceRepository.findById`), rồi kiểm trên record: hai
  // lý do tách biệt được là "không tồn tại" và "thuộc app khác" — và câu trả lời thứ hai là
  // thứ operator cần để chẩn đoán một client bị cấu hình sai.
  const subscription = await deps.ports.subscriptions.findById(command.subscriptionId);
  if (subscription === null) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.SubscriptionNotFound,
      detail: 'Subscription không tồn tại.',
    };
  }
  if (subscription.app !== command.authenticatedApp) {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.AppMismatch,
      detail: 'Subscription thuộc app khác — FR-001/FR-007 cấm dùng chéo app.',
    };
  }
  return { ok: true, value: subscription };
}

async function applyDisable(
  deps: InventoryDeps,
  target: SubscriptionRecord,
  actor: string,
  now: number,
  event: typeof AUDIT_EVENT.SubscriptionDisabled | typeof AUDIT_EVENT.SubscriptionRemoved,
): Promise<InventoryResult<SubscriptionView>> {
  const decision = disableSubscription(target.status, SUBSCRIPTION_DISABLE_CAUSE.UserUnregister);
  if (!decision.ok) {
    // `expired` không có transition sang `disabled` (§5.2) — đây là kết quả hợp lệ của một
    // use case idempotent, không phải lỗi: client đã ở trạng thái mà nó muốn.
    return {
      ok: false,
      reason: INVENTORY_REJECTION.SubscriptionExpired,
      detail: `Subscription đã ở trạng thái không thể disable (${target.status}).`,
    };
  }

  let updated = target;
  if (decision.changed) {
    try {
      const written = await deps.ports.subscriptions.disableById({
        app: target.app,
        subscriptionId: target.subscriptionId,
        cause: SUBSCRIPTION_DISABLE_CAUSE.UserUnregister,
        now,
      });
      if (written === null) {
        // Thua race — `disableById` guard `status = 'active'`. Đọc lại để trả **kết quả
        // thật**, không dựng record từ input.
        const raced = await deps.ports.subscriptions.findById(target.subscriptionId);
        if (raced === null) {
          return {
            ok: false,
            reason: INVENTORY_REJECTION.SubscriptionNotFound,
            detail: 'Subscription không còn tồn tại sau khi đọc.',
          };
        }
        updated = raced;
      } else {
        updated = written;
      }
    } catch {
      return {
        ok: false,
        reason: INVENTORY_REJECTION.StorageFailure,
        detail: 'Không disable được subscription.',
      };
    }
  }

  // ⚠️ Audit kể cả khi `changed: false`. Ở đây khác `invalidateSubscription`: đó là worker
  // gọi lại một policy idempotent, còn đây là **một lời gọi của application** — và FR-020 đòi
  // `subscription_disabled` cho thao tác disable, không phải cho *kết quả* của thao tác. Một
  // lần bấm nút hai lần vẫn là hai thao tác quản lý có dấu vết.
  try {
    await deps.ports.audit.append({
      auditId: subscriptionAuditId(event, updated.subscriptionId, now),
      event,
      actor,
      entityType: 'push_subscription',
      entityId: updated.subscriptionId,
      detail: {
        app: updated.app,
        cause: SUBSCRIPTION_DISABLE_CAUSE.UserUnregister,
        previous_status: target.status,
        changed: decision.changed,
      },
      now,
    });
  } catch {
    return {
      ok: false,
      reason: INVENTORY_REJECTION.StorageFailure,
      detail: 'Không ghi được audit cho thao tác disable.',
    };
  }
  return { ok: true, value: toSubscriptionView(updated) };
}

/**
 * Id audit suy ra từ `(subscription, event, now)` — không sinh id thêm cho một record mà nội
 * dung là xác định. Cùng lý do `invalidateSubscription` làm: hai lần chạy của cùng một mốc thời
 * gian không tạo hai audit record khác nhau, và id đọc lại được mà không cần bảng sinh số.
 */
function subscriptionAuditId(event: string, subscriptionId: string, now: number): string {
  return `push_subscription:${event}:${subscriptionId}:${now}`;
}

/** Loại material của Web Push khỏi bất kỳ thứ gì lọt ra ngoài (§9 loại secret 2). */
function toSubscriptionView(subscription: SubscriptionRecord): SubscriptionView {
  return {
    subscriptionId: subscription.subscriptionId,
    deviceId: subscription.deviceId,
    userId: subscription.userId,
    app: subscription.app,
    transport: subscription.transport,
    vapidKeyId: subscription.vapidKeyId,
    providerId: subscription.providerId,
    status: subscription.status,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}
