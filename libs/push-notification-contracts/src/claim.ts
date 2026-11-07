/**
 * `POST /internal/deliveries/:delivery_id/claim` — operation trả runtime material của
 * private delivery runtime API (`docs/applications/push-notification/01-architecture.md` §8.1).
 *
 * ⚠️ **`claim` là operation duy nhất cấp quyền thực thi *và* là operation duy nhất trả
 * runtime material.** Hai tính chất đó gắn chặt: nếu tồn tại một đường đọc material không
 * qua `claim` thì material sẽ không còn gắn với một lease đang giữ, và fencing
 * (`dispatch_generation`) mất hiệu lực. Vì vậy:
 *
 * - **Không** có `payload` trong response `200` — payload chỉ đến từ envelope Queue
 *   (`delivery-command.ts`). `payload_digest` **chỉ** để đối chiếu và là **optional**:
 *   thuật toán digest là open item, nên từ chối một response thiếu digest là sai contract.
 * - Response `409` là **body đóng**: chỉ `reason` (+ `state` **chỉ khi** `reason = 'terminal'`).
 *   Mọi runtime material trong `409` là vi phạm contract — caller chưa thắng lease không
 *   được nhận gì. Validator ở đây chặn điều đó bằng `FORBIDDEN_CLAIM_REJECTION_FIELDS`.
 *
 * File mô tả **hình dạng** của response; nó không quyết định thắng/thua (điều đó nằm ở
 * `meta.changes == 1` của guarded write ở control plane) và không chứa logic lease.
 */

import {
  FORBIDDEN_DELIVERY_MATERIAL_FIELDS,
  copyJsonCompatible,
  isNonEmptyString,
  isPlainObject,
  isPositiveInteger,
  isProviderType,
  isRfc3339Timestamp,
  isTerminalDeliveryStatus,
  isTransport,
  presenceProbeDetail,
  scanJsonDataObject,
  type ProviderType,
  type TerminalDeliveryStatus,
  type Transport,
} from './shared';

/** Tập `reason` của `409` claim — **đóng**. */
export const CLAIM_REJECTION_REASONS = [
  'pending',
  'lease_held',
  'terminal',
  'expired',
  'ineligible_subscription',
  'ineligible_provider_hold',
] as const;

/** Union `reason` từ chối claim. */
export type ClaimRejectionReason = (typeof CLAIM_REJECTION_REASONS)[number];

/**
 * `reason` mà một `409` **MUST** có `state` kèm theo — mọi `reason` khác **MUST NOT**.
 *
 * Chỉ nhánh `terminal` cần `state` để phân biệt state nào đã kết thúc; `reason` không suy
 * ra được nó. Các nhánh còn lại đã xác định điều kiện từ chối, nên `state` thêm vào chỉ mở
 * đường cho worker rẽ nhánh theo một field không thuộc contract.
 */
export const CLAIM_REJECTION_REASON_WITH_STATE = 'terminal' as const satisfies ClaimRejectionReason;

/**
 * Request claim — **rỗng**.
 *
 * `lease_duration` do control plane cấu hình và `now` do control plane xác định; worker
 * **MUST NOT** gửi tham số điều khiển state nào, vì làm vậy biến lease thành thứ caller
 * điều khiển được.
 */
export interface ClaimRequest {
  readonly [key: string]: never;
}

/** Subscription secret + VAPID key id của delivery — chỉ trả khi claim thắng. */
export interface ClaimedSubscription {
  /** Endpoint do `Browser Push Service` cấp. */
  readonly endpoint: string;
  /** Khoá công khai của client (Web Push protocol). */
  readonly p256dh: string;
  /** Secret xác thực của client (Web Push protocol). */
  readonly auth: string;
  /** Key version VAPID mà worker **MUST** dùng để ký cho subscription này. */
  readonly vapid_key_id: string;
}

/** Provider material của delivery — chỉ trả khi claim thắng. */
export interface ClaimedProvider {
  /** Provider type (`web-push` ở v1) — **không phải** `transport`. */
  readonly type: ProviderType;
  /** Cấu hình provider không phải secret. */
  readonly configuration: Readonly<Record<string, unknown>>;
  /** Credential provider (VAPID key pair); không bao giờ vào Queue/log/error. */
  readonly credential: Readonly<Record<string, unknown>>;
}

/**
 * Body `200` của claim — **tập field đóng** (khớp runtime material ở worker §7).
 *
 * Field duy nhất có thể vắng là `payload_digest`. Mọi field khác **MUST** có mặt; một
 * response `200` thiếu `dispatch_generation` hay `lease_expires_at` thì worker không có gì
 * để ghi kèm khi trả outcome, nên đó là response hỏng chứ không phải response tối giản.
 */
export interface DeliveryClaim {
  readonly delivery_id: string;
  readonly notification_id: string;
  /** Không có trong envelope — worker lấy từ đây cho metric/log. */
  readonly app: string;
  /** State sau khi claim thắng — literal `"processing"`. */
  readonly status: 'processing';
  /** Hạn nghiệp vụ của notification; worker kiểm **một lần** trước khi gọi provider. */
  readonly expires_at: string;
  /** Chỉ để đối chiếu payload của envelope; **không** dùng để gửi. */
  readonly payload_digest?: string;
  /** Fencing token worker gửi kèm mọi write. */
  readonly dispatch_generation: number;
  /** Control plane quản lý; worker chỉ đọc. */
  readonly lease_expires_at: string;
  /** Giá trị `Transport` của delivery — **không** phải provider type. */
  readonly transport: Transport;
  readonly provider_id: string;
  readonly subscription_id: string;
  readonly subscription: ClaimedSubscription;
  readonly provider: ClaimedProvider;
}

/** Body `409` của claim — **đóng**: `reason`, và `state` **chỉ khi** `reason = 'terminal'`. */
export interface ClaimRejection {
  readonly reason: ClaimRejectionReason;
  readonly state?: TerminalDeliveryStatus;
}

/**
 * Field mà `409` **MUST NOT** chứa.
 *
 * Gồm runtime material của `200` (payload/subscription/provider/credential/generation/lease)
 * và secret protocol — danh sách dùng chung `FORBIDDEN_DELIVERY_MATERIAL_FIELDS` để một
 * secret thêm sau này không thể bị quên khỏi response này trong khi có ở response khác
 * (từng là điểm trôi lệch giữa ba danh sách `409`/ack). Danh sách này là hàng kiểm để lỗi
 * "trả material trong nhánh từ chối" bị bắt ở consumer thay vì được tin.
 */
export const FORBIDDEN_CLAIM_REJECTION_FIELDS = FORBIDDEN_DELIVERY_MATERIAL_FIELDS;

/** Lý do từ chối một response claim (ở tầng parse, không phải `reason` của control plane). */
export type ClaimResponseRejectionReason =
  | 'invalid_payload'
  | 'unknown_reason'
  | 'unexpected_field'
  | 'missing_field'
  | 'invalid_field_type'
  | 'state_not_allowed'
  | 'state_required'
  | 'runtime_material_leak';

/** Kết quả validate body `200`. */
export type ClaimValidation =
  | { readonly ok: true; readonly claim: DeliveryClaim }
  | {
      readonly ok: false;
      readonly reason: ClaimResponseRejectionReason;
      readonly detail: string;
    };

/** Kết quả validate body `409`. */
export type ClaimRejectionValidation =
  | { readonly ok: true; readonly rejection: ClaimRejection }
  | {
      readonly ok: false;
      readonly reason: ClaimResponseRejectionReason;
      readonly detail: string;
    };

/**
 * Kết quả của một lần claim — **union phân biệt thắng/thua**.
 *
 * Kiểu này tồn tại để một response **không thể** mang đồng thời `reason` và runtime material:
 * nhánh `claim` và nhánh `rejection` là hai biến thể loại trừ nhau, nên `if (result.ok)` là
 * đủ để biết mình đang đọc cái gì.
 */
export type ClaimResult =
  | { readonly ok: true; readonly claim: DeliveryClaim }
  | { readonly ok: false; readonly rejection: ClaimRejection };

/** Kiểm tra một giá trị có phải `reason` từ chối hợp lệ. */
export function isClaimRejectionReason(value: unknown): value is ClaimRejectionReason {
  return (
    typeof value === 'string' && (CLAIM_REJECTION_REASONS as readonly string[]).includes(value)
  );
}

/** Kết quả validate request body (không mang payload trả về). */
export type EmptyRequestValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: ClaimResponseRejectionReason;
      readonly detail: string;
    };

/**
 * Validate request body của `claim` — **MUST** là object rỗng.
 *
 * Đây là một kiểm tra chứ không phải một sự tinh tế hình thức: nếu control plane chấp nhận
 * body có field, thì `now`/`lease_duration`/`dispatch_generation` trở thành tham số do caller
 * điều khiển, và lease mất tính "do control plane quyết định" — cũng là điều kiện để predicate
 * claim là nguồn duy nhất của việc thắng/thua.
 */
export function validateClaimRequest(payload: unknown): EmptyRequestValidation {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Claim request phải là object JSON.' };
  }
  const scan = scanJsonDataObject(payload, 'Claim request', []);
  if (!scan.ok) {
    return {
      ok: false,
      reason: scan.reason,
      detail:
        scan.reason === 'unexpected_field'
          ? `Claim request MUST rỗng; nhận field ngoài contract: ${scan.field}.`
          : scan.detail,
    };
  }
  return { ok: true };
}

/** Field bắt buộc của `200` (mọi field trừ `payload_digest`). */
const REQUIRED_CLAIM_FIELDS = [
  'delivery_id',
  'notification_id',
  'app',
  'status',
  'expires_at',
  'dispatch_generation',
  'lease_expires_at',
  'transport',
  'provider_id',
  'subscription_id',
  'subscription',
  'provider',
] as const;

/** Field được phép của `200`. */
const ALLOWED_CLAIM_FIELDS = [...REQUIRED_CLAIM_FIELDS, 'payload_digest'] as const;

/** Field bắt buộc của `subscription`. */
const REQUIRED_SUBSCRIPTION_FIELDS = ['endpoint', 'p256dh', 'auth', 'vapid_key_id'] as const;

/** Field bắt buộc của `provider`. */
const REQUIRED_PROVIDER_FIELDS = ['type', 'configuration', 'credential'] as const;

/**
 * Validate body `200` của claim.
 *
 * ⚠️ **Không** chấp nhận `payload` ở đây: nếu `payload` có mặt trong body thì đó là
 * `runtime_material_leak` — contract cấm nguồn payload thứ hai, nên field đó bị chặn như
 * một field lạ, không phải được chấp nhận thêm.
 *
 * ⚠️ `detail` chỉ nêu **tên** field, không nối giá trị — response này chứa endpoint và
 * secret protocol, và `detail` có thể bị log.
 *
 * Thứ tự kiểm (policy chung của thư viện): shape → khoá `payload` bị cấm (leak) → field lạ
 * (`scanJsonDataObject`: chặn symbol key/getter/non-enumerable, không kích hoạt getter) →
 * field bắt buộc (`Object.hasOwn`) → kiểu từng field; `subscription`/`provider` lồng bên
 * trong cũng đi đúng thứ tự đó ở cấp con — **khoá lạ trước, khoá thiếu sau, sai kiểu cuối**.
 */
export function validateDeliveryClaim(payload: unknown): ClaimValidation {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Claim response phải là object JSON.' };
  }
  const record = payload;

  const hostilePayloadPresence = presenceProbeDetail(record, 'Claim response', ['payload']);
  if (hostilePayloadPresence !== undefined) {
    return { ok: false, reason: 'invalid_payload', detail: hostilePayloadPresence };
  }
  if (Object.hasOwn(record, 'payload')) {
    return {
      ok: false,
      reason: 'runtime_material_leak',
      detail: 'Claim response chứa payload; payload chỉ đến từ envelope Queue.',
    };
  }

  const scan = scanJsonDataObject(record, 'Claim response', ALLOWED_CLAIM_FIELDS);
  if (!scan.ok) {
    return { ok: false, reason: scan.reason, detail: scan.detail };
  }

  for (const field of REQUIRED_CLAIM_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      return {
        ok: false,
        reason: 'missing_field',
        detail: `Claim response thiếu field: ${field}.`,
      };
    }
  }

  if (record.status !== 'processing') {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'status của claim thắng phải là "processing".',
    };
  }
  // Kiểm từng field bằng truy cập khoá tường minh (không qua vòng lặp): TypeScript chỉ thu
  // hẹp kiểu khi khoá là literal, và việc thu hẹp đó là thứ cho phép construction dưới đây
  // không cần ép kiểu — cùng idiom với `session-verified.ts`.
  if (!isNonEmptyString(record.delivery_id)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'delivery_id phải là chuỗi không rỗng.',
    };
  }
  if (!isNonEmptyString(record.notification_id)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'notification_id phải là chuỗi không rỗng.',
    };
  }
  if (!isNonEmptyString(record.app)) {
    return { ok: false, reason: 'invalid_field_type', detail: 'app phải là chuỗi không rỗng.' };
  }
  if (!isNonEmptyString(record.provider_id)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'provider_id phải là chuỗi không rỗng.',
    };
  }
  if (!isNonEmptyString(record.subscription_id)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'subscription_id phải là chuỗi không rỗng.',
    };
  }
  if (!isRfc3339Timestamp(record.expires_at)) {
    return { ok: false, reason: 'invalid_field_type', detail: 'expires_at phải là RFC3339.' };
  }
  if (!isRfc3339Timestamp(record.lease_expires_at)) {
    return { ok: false, reason: 'invalid_field_type', detail: 'lease_expires_at phải là RFC3339.' };
  }
  if (!isPositiveInteger(record.dispatch_generation)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'dispatch_generation phải là số nguyên dương.',
    };
  }
  if (Object.hasOwn(record, 'payload_digest') && !isNonEmptyString(record.payload_digest)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'payload_digest phải là chuỗi không rỗng khi có mặt.',
    };
  }
  if (!isTransport(record.transport)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'transport phải là giá trị Transport (web|app), không phải provider type.',
    };
  }

  const subscription = record.subscription;
  if (!isPlainObject(subscription)) {
    return { ok: false, reason: 'invalid_field_type', detail: 'subscription phải là object.' };
  }
  // `subscription` là tập ĐÓNG đúng bốn field (bảng §8.1): khoá thứ năm là field ngoài
  // contract, không phải field mở rộng — cùng policy unknown-field "reject" của envelope.
  // Thứ tự: khoá lạ → khoá thiếu → sai kiểu (báo `missing_field` khác với `invalid_field_type`).
  const subscriptionScan = scanJsonDataObject(
    subscription,
    'subscription',
    REQUIRED_SUBSCRIPTION_FIELDS,
  );
  if (!subscriptionScan.ok) {
    return { ok: false, reason: subscriptionScan.reason, detail: subscriptionScan.detail };
  }
  for (const field of REQUIRED_SUBSCRIPTION_FIELDS) {
    if (!Object.hasOwn(subscription, field)) {
      return {
        ok: false,
        reason: 'missing_field',
        detail: `subscription thiếu field: ${field}.`,
      };
    }
  }
  for (const field of REQUIRED_SUBSCRIPTION_FIELDS) {
    if (!isNonEmptyString(subscription[field])) {
      return {
        ok: false,
        reason: 'invalid_field_type',
        detail: `subscription.${field} phải là chuỗi không rỗng.`,
      };
    }
  }

  const provider = record.provider;
  if (!isPlainObject(provider)) {
    return { ok: false, reason: 'invalid_field_type', detail: 'provider phải là object.' };
  }
  // `provider` cũng là tập ĐÓNG đúng ba field; `configuration`/`credential` bên trong mới là
  // opaque (không kiểm khoá), nhưng bản thân `provider` không nhận field thứ tư.
  // Thứ tự: khoá lạ → khoá thiếu → sai kiểu (cùng policy với `subscription` và top-level).
  const providerScan = scanJsonDataObject(provider, 'provider', REQUIRED_PROVIDER_FIELDS);
  if (!providerScan.ok) {
    return { ok: false, reason: providerScan.reason, detail: providerScan.detail };
  }
  for (const field of REQUIRED_PROVIDER_FIELDS) {
    if (!Object.hasOwn(provider, field)) {
      return { ok: false, reason: 'missing_field', detail: `provider thiếu field: ${field}.` };
    }
  }
  if (!isProviderType(provider.type)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'provider.type phải là provider type (web-push|fcm|apns), không phải Transport.',
    };
  }
  if (!isPlainObject(provider.configuration)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'provider.configuration phải là object.',
    };
  }
  if (!isPlainObject(provider.credential)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'provider.credential phải là object.',
    };
  }

  // `configuration`/`credential` là **opaque** với contract (khoá bên trong không bị kiểm),
  // nhưng chúng vẫn là JSON trên wire và vẫn là **bản sao độc lập** (A4): trả nguyên tham
  // chiếu của caller thì sửa object nguồn sau khi validate sẽ đổi kết quả đã validate — và
  // theo chiều ngược lại, material của caller bị sửa qua kết quả trả về. Cùng một policy và
  // cùng một hàm với `data` của payload: getter không bị kích hoạt, field non-enumerable/
  // symbol key/giá trị không serialize được bị từ chối thay vì bỏ âm thầm.
  const configurationCopy = copyJsonCompatible(provider.configuration, new Set<object>([record]));
  if (!configurationCopy.ok) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: `provider.configuration chứa giá trị không tương thích JSON: ${configurationCopy.kind}.`,
    };
  }
  const credentialCopy = copyJsonCompatible(provider.credential, new Set<object>([record]));
  if (!credentialCopy.ok) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: `provider.credential chứa giá trị không tương thích JSON: ${credentialCopy.kind}.`,
    };
  }

  return {
    ok: true,
    claim: {
      delivery_id: record.delivery_id,
      notification_id: record.notification_id,
      app: record.app,
      status: 'processing',
      expires_at: record.expires_at,
      ...(Object.hasOwn(record, 'payload_digest')
        ? { payload_digest: record.payload_digest as string }
        : {}),
      dispatch_generation: record.dispatch_generation,
      lease_expires_at: record.lease_expires_at,
      transport: record.transport,
      provider_id: record.provider_id,
      subscription_id: record.subscription_id,
      subscription: {
        endpoint: subscription.endpoint as string,
        p256dh: subscription.p256dh as string,
        auth: subscription.auth as string,
        vapid_key_id: subscription.vapid_key_id as string,
      },
      provider: {
        type: provider.type,
        configuration: configurationCopy.value as Readonly<Record<string, unknown>>,
        credential: credentialCopy.value as Readonly<Record<string, unknown>>,
      },
    },
  };
}

/**
 * Validate body `409` của claim.
 *
 * Hai bất biến được kiểm ở đây, và cả hai đều là lỗi contract chứ không phải lỗi dữ liệu:
 *
 * 1. `reason` **MUST** thuộc tập đóng; một `reason` lạ làm worker không biết xử lý an toàn.
 * 2. `state` **CHỈ** có mặt khi `reason = 'terminal'`. Thiếu `state` ở `terminal` là lỗi
 *    (`state_required`) vì worker cần nó để ghi nhận; có `state` ở `reason` khác là lỗi
 *    (`state_not_allowed`) vì nó gợi ý một nhánh xử lý không thuộc contract.
 *
 * Field bị cấm trong `FORBIDDEN_CLAIM_REJECTION_FIELDS` bị chặn **trước** khi đọc `reason`,
 * để một `409` mang runtime material luôn bị báo là rò material.
 */
export function validateClaimRejection(payload: unknown): ClaimRejectionValidation {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Claim 409 phải là object JSON.' };
  }
  const record = payload;

  const hostilePresence = presenceProbeDetail(
    record,
    'Claim 409',
    FORBIDDEN_CLAIM_REJECTION_FIELDS,
  );
  if (hostilePresence !== undefined) {
    return { ok: false, reason: 'invalid_payload', detail: hostilePresence };
  }

  for (const field of FORBIDDEN_CLAIM_REJECTION_FIELDS) {
    if (Object.hasOwn(record, field)) {
      return {
        ok: false,
        reason: 'runtime_material_leak',
        detail: `Claim 409 chứa runtime material bị cấm: ${field}.`,
      };
    }
  }

  const scan = scanJsonDataObject(record, 'Claim 409', ['reason', 'state']);
  if (!scan.ok) {
    return { ok: false, reason: scan.reason, detail: scan.detail };
  }

  // `reason` là field **bắt buộc** và là enum **đóng**: ba lỗi khác nhau phải được báo khác
  // nhau — vắng hẳn (`missing_field`), sai kiểu (`invalid_field_type`), hay là chuỗi nằm
  // ngoài tập đóng (`unknown_reason`). Gộp cả ba vào `unknown_reason` làm metric/alert không
  // phân biệt được "peer gửi body thiếu field" với "peer lệch version vocabulary".
  if (!Object.hasOwn(record, 'reason')) {
    return { ok: false, reason: 'missing_field', detail: 'Claim 409 thiếu field: reason.' };
  }
  if (typeof record.reason !== 'string') {
    return { ok: false, reason: 'invalid_field_type', detail: 'reason phải là chuỗi.' };
  }
  if (!isClaimRejectionReason(record.reason)) {
    return {
      ok: false,
      reason: 'unknown_reason',
      detail: 'reason không thuộc tập đóng (closed reason set).',
    };
  }

  if (record.reason === CLAIM_REJECTION_REASON_WITH_STATE) {
    if (!Object.hasOwn(record, 'state')) {
      return {
        ok: false,
        reason: 'state_required',
        detail: 'Claim 409 với reason "terminal" phải kèm state.',
      };
    }
    if (!isTerminalDeliveryStatus(record.state)) {
      return {
        ok: false,
        reason: 'invalid_field_type',
        detail: 'state của reason "terminal" phải là terminal delivery state.',
      };
    }
    return { ok: true, rejection: { reason: 'terminal', state: record.state } };
  }

  if (Object.hasOwn(record, 'state')) {
    return {
      ok: false,
      reason: 'state_not_allowed',
      detail: 'Claim 409 chỉ được kèm state khi reason là "terminal".',
    };
  }

  return { ok: true, rejection: { reason: record.reason } };
}

/**
 * Dựng body `200` hợp lệ — buộc mọi response claim thắng đi qua một chỗ.
 *
 * Builder chạy **chính validator canonical** trên kết quả dựng được: input đến từ JSON/
 * storage là dữ liệu runtime (kiểu TypeScript không chặn được), nên một `DeliveryClaim` thiếu
 * field, sai kiểu hay mang `payload` đều làm builder **throw** thay vì trả body mà chính
 * library sẽ từ chối ở consumer.
 */
export function deliveryClaim(input: DeliveryClaim): DeliveryClaim {
  const candidate = {
    delivery_id: input.delivery_id,
    notification_id: input.notification_id,
    app: input.app,
    status: 'processing',
    expires_at: input.expires_at,
    ...(input.payload_digest !== undefined ? { payload_digest: input.payload_digest } : {}),
    dispatch_generation: input.dispatch_generation,
    lease_expires_at: input.lease_expires_at,
    transport: input.transport,
    provider_id: input.provider_id,
    subscription_id: input.subscription_id,
    // `subscription` và `provider` truyền nguyên object đã đóng kiểu; dựng lại từng field
    // ở đây chỉ nhân bản định nghĩa `SubscriptionMaterial`/`ProviderMaterial` mà không
    // thêm bảo đảm nào (kiểu đã đóng, validator đã chặn field lạ ở cả hai tầng).
    subscription: input.subscription,
    provider: input.provider,
  };
  const checked = validateDeliveryClaim(candidate);
  if (!checked.ok) {
    throw new Error(
      `deliveryClaim: body không qua validator (${checked.reason}): ${checked.detail}`,
    );
  }
  return checked.claim;
}

/**
 * Dựng body `409` hợp lệ — buộc `state` chỉ xuất hiện ở nhánh `terminal`.
 *
 * Hàm ném lỗi khi bất biến bị vi phạm thay vì im lặng sửa, vì đây là chỗ dựng response trên
 * đường từ chối: một `state` lạc chỗ ở đây là bug lập trình, không phải dữ liệu hỏng. Sau
 * các kiểm bất biến tường minh, body vẫn qua **validator canonical** — `reason` bị ép kiểu
 * từ JSON (`'bogus' as ClaimRejectionReason`) không thể lọt ra ngoài.
 */
export function claimRejection(
  reason: ClaimRejectionReason,
  state?: TerminalDeliveryStatus,
): ClaimRejection {
  // `reason` tới boundary này là runtime data (ép kiểu từ JSON hợp lệ trong mẫu của
  // library), nên kiểm tập ĐÓNG **trước** khi dùng nó trong thông điệp lỗi. Nhánh
  // `state !== undefined` bên dưới có nối `reason` vào message — nối chuỗi chưa kiểm
  // soát nghĩa là log injection: caller truyền `reason` chứa xuống dòng sẽ chèn dòng giả
  // vào log. Sau kiểm này `reason` là một hằng ASCII trong tập đóng nên nối an toàn.
  if (!isClaimRejectionReason(reason)) {
    throw new Error('claimRejection: reason phải thuộc tập đóng claim rejection.');
  }
  if (reason === CLAIM_REJECTION_REASON_WITH_STATE) {
    if (state === undefined) {
      throw new Error('claimRejection: reason "terminal" bắt buộc có state.');
    }
  } else if (state !== undefined) {
    throw new Error(`claimRejection: reason "${reason}" không được kèm state.`);
  }
  const candidate = reason === CLAIM_REJECTION_REASON_WITH_STATE ? { reason, state } : { reason };
  const checked = validateClaimRejection(candidate);
  if (!checked.ok) {
    throw new Error(
      `claimRejection: body không qua validator (${checked.reason}): ${checked.detail}`,
    );
  }
  return checked.rejection;
}
