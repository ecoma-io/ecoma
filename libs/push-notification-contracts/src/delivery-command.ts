/**
 * `DeliveryCommandV1` — envelope Queue `ecoma-push-delivery`, contract giữa control plane
 * (`push-notification`) và delivery plane (`web-push-notification-job`).
 *
 * Canonical → `docs/applications/push-notification/02-requirements.md` FR-013; mô tả phía worker
 * → `docs/applications/web-push-notification-job/01-architecture.md` §5.
 *
 * ⚠️ **Đây là contract mà cả hai plane phải đọc giống nhau, và nó là lớp bảo vệ duy nhất
 * cho hai bất biến:**
 *
 * 1. **Envelope là nguồn payload duy nhất.** Worker **MUST NOT** đọc lại payload từ runtime
 *    API; nếu payload có mặt ở hai nơi thì "immutable trong Queue" không còn nghĩa gì.
 * 2. **Không secret trong Queue.** Envelope **MUST NOT** mang `auth`, `p256dh`, VAPID private
 *    key, provider secret hay authorization header. Validator chặn nhóm này bằng
 *    `FORBIDDEN_DELIVERY_COMMAND_FIELDS` cho khoá **top-level** *và* cho khoá **lồng trong
 *    `payload`** (cùng danh sách, nhánh riêng vì `Object.hasOwn` top-level không với tới
 *    khoá lồng — mà `payload` chính là chỗ secret dễ chui vào nhất), và bằng schema payload
 *    canonical (FR-013) đóng bốn khoá cho mọi khoá lạ còn lại. Cả hai là hàng phòng thủ thứ
 *    hai sau khi envelope được materialize, để một envelope sai vẫn bị consumer từ chối thay
 *    vì bị gửi đi.
 *
 * Envelope là **closed schema** (reject field lạ) và **immutable**: validator không có tham
 * số nào để "chuẩn hoá" envelope, vì mọi thay đổi envelope là một delivery mới, không phải
 * một lần đọc.
 */

import {
  ENVELOPE_ADDITIONAL_FORBIDDEN_FIELDS,
  isNonEmptyString,
  isPlainObject,
  isTransport,
  presenceProbeDetail,
  readJsonDataProperty,
  scanJsonDataObject,
  SECRET_PROTOCOL_FIELDS,
  type Transport,
} from './shared';
import { validateNotificationPayload, type NotificationPayload } from './notification-payload';

/**
 * Schema version của envelope — số nguyên, giá trị duy nhất hợp lệ ở v1.
 *
 * `version` bao phủ **cả** schema `payload`, nên nó là đường nâng cấp payload: một envelope
 * `version > 1` có payload mang field mới mà consumer v1 không được phép đoán.
 */
export const DELIVERY_COMMAND_VERSION = 1;

/** Bảy field bắt buộc và duy nhất của envelope (FR-013). */
export const DELIVERY_COMMAND_FIELDS = [
  'version',
  'delivery_id',
  'notification_id',
  'subscription_id',
  'provider_id',
  'transport',
  'payload',
] as const;

/**
 * Nhóm field **không được phép** có mặt trên envelope.
 *
 * FR-013 (control plane) và SR-002 (worker) đều cấm secret trong Queue; danh sách này là
 * bản kiểm được ở consumer. Nó **không** thay thế việc control plane không đưa secret vào
 * envelope — nó bắt lỗi khi việc đó đã xảy ra.
 *
 * ⚠️ `subscription`/`provider` (object runtime material mang `auth`/`p256dh`/credential)
 * **cũng** nằm trong danh sách: chúng là material của claim, và một bản sao lọt vào Queue
 * chính là đường rò credential. Lưu ý `payload` **không** có mặt — nó là field hợp pháp của
 * envelope; secret **lồng trong** `payload` được kiểm bằng nhánh riêng bên dưới vì
 * `field in record`/`Object.hasOwn` ở đây chỉ soi top-level.
 */
export const FORBIDDEN_DELIVERY_COMMAND_FIELDS = [
  ...SECRET_PROTOCOL_FIELDS,
  ...ENVELOPE_ADDITIONAL_FORBIDDEN_FIELDS,
] as const;

/**
 * Nội dung payload của envelope — **chính** `NotificationPayload`, không phải một alias lỏng.
 *
 * Alias này từng là `Record<string, unknown>` và đó là một lỗ: kiểu nói payload là túi khoá mở
 * trong khi FR-013 nói nó đóng đúng bốn khoá. Kiểu và schema lệch nhau thì `tsc` xanh vẫn cho
 * một envelope mang `payload.auth` biên dịch được. Trỏ thẳng về `NotificationPayload` giữ một
 * định nghĩa duy nhất cho cả kiểu lẫn validator.
 */
export type DeliveryCommandPayload = NotificationPayload;

/**
 * Envelope `DeliveryCommandV1` — **đúng bảy field, không hơn**.
 *
 * `app`, `status`, `expires_at`, `dispatch_generation`, `lease_expires_at` **KHÔNG** nằm
 * trong envelope: chúng thuộc runtime material trả bởi `claim` (worker §7). Đưa chúng vào
 * envelope là mở đường cho một nguồn sự thật thứ hai cho `expires_at`/generation.
 */
export interface DeliveryCommandV1 {
  /** Schema version — hằng `DELIVERY_COMMAND_VERSION`. */
  readonly version: typeof DELIVERY_COMMAND_VERSION;
  /** Logical delivery identity — idempotency key ở tầng Queue (§7). */
  readonly delivery_id: string;
  /** Notification sinh ra delivery này. */
  readonly notification_id: string;
  /** Subscription đích; worker **KHÔNG** được thay bằng subscription khác. */
  readonly subscription_id: string;
  /** Provider đã chọn; worker **KHÔNG** được reroute. */
  readonly provider_id: string;
  /** `Transport` (§4.2) — **không phải** provider type. */
  readonly transport: Transport;
  /** Nội dung hiển thị đã materialize — nguồn payload duy nhất. */
  readonly payload: DeliveryCommandPayload;
}

/** Lý do từ chối envelope. */
export type DeliveryCommandRejectionReason =
  | 'invalid_payload'
  | 'unsupported_version'
  | 'forbidden_field'
  | 'unexpected_field'
  | 'missing_field'
  | 'invalid_field_type';

/** Kết quả validate envelope — discriminated union. */
export type DeliveryCommandValidation =
  | { readonly ok: true; readonly command: DeliveryCommandV1 }
  | {
      readonly ok: false;
      readonly reason: DeliveryCommandRejectionReason;
      readonly detail: string;
    };

/** Kiểm tra một giá trị có phải `version` hợp lệ của envelope. */
export function isSupportedDeliveryCommandVersion(value: unknown): boolean {
  // Lưu ý wire format: `1.0` không phân biệt được với `1` sau `JSON.parse` (`1.0 === 1`
  // và `Number.isInteger(1.0) === true`), nên validator **không thể** từ chối `1.0`.
  // FR-013 diễn đạt giới hạn này: `1.0` là cùng một số với `1`, không phải một giá trị khác.
  // Kiểm `Number.isInteger` tường minh để người đọc sau thấy ý định "số nguyên" là có chủ ý
  // chứ không phải hệ quả tình cờ của phép so sánh bằng.
  return value === DELIVERY_COMMAND_VERSION && Number.isInteger(value);
}

/**
 * Validate một Queue message là `DeliveryCommandV1` hợp lệ.
 *
 * Thứ tự kiểm có chủ đích:
 *
 * 1. **shape** — phải là plain object JSON (`isPlainObject`: không `Date`/`Map`/class instance).
 * 2. **`version`** — sai version dừng ngay, vì các field còn lại được định nghĩa *theo*
 *    version: đọc field của v2 bằng luật v1 là nguồn lỗi, không phải một lần bỏ qua.
 * 3. **field bị cấm** — secret/runtime material lọt vào envelope là lỗi nghiêm trọng nhất,
 *    nên được báo trước cả field thiếu. Áp cho **cả** khoá top-level lẫn khoá **lồng trong
 *    `payload`** (nhánh 3b): `FORBIDDEN_DELIVERY_COMMAND_FIELDS` soi top-level, mà
 *    `payload: { auth: … }` chính là đường rò tự nhiên nhất — secret phải được báo là
 *    `forbidden_field` chứ không phải lỗi kiểu hay lỗi khoá lạ.
 * 4. **field lạ** — qua `scanJsonDataObject` (reject, không bỏ qua; đồng thời chặn symbol key/
 *    getter/non-enumerable trước khi đọc bất kỳ giá trị nào).
 * 5. **field bắt buộc** (`Object.hasOwn` — không tính kế thừa từ prototype).
 * 6. **kiểu từng field**, và `transport` **MUST** là `Transport` — `"web-push"` ở đây là
 *    lỗi contract, không phải một giá trị tương đương.
 * 7. **`payload`** theo schema canonical FR-013 (`validateNotificationPayload`): đúng bốn
 *    khoá `title`/`body`/`url`/`data`, `title`/`body` bắt buộc, mọi giá trị JSON-compatible.
 *    Bước này **nằm trong** validator chứ không phải việc của caller. Lý do payload **reason**
 *    được **truyền nguyên** (trừ `invalid_payload` → `invalid_field_type` vì
 *    `invalid_payload` ở vocabulary envelope nghĩa là *envelope* không phải object): gộp mọi
 *    lỗi payload về một reason làm mất khả năng phân loại — khoá lạ lồng trong payload là
 *    `unexpected_field`, khoá thiếu là `missing_field`, đúng thứ consumer cần để metric/alert
 *    phân biệt các loại sự cố.
 *
 * ⚠️ `detail` chỉ nêu **tên** field/giá trị enum, **không** nối nội dung `payload` vào: một
 * message hỏng có thể chứa nội dung hiển thị của người dùng cuối, và `detail` có thể bị log.
 */
export function validateDeliveryCommand(payload: unknown): DeliveryCommandValidation {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Envelope phải là object JSON.' };
  }
  const record = payload;

  // `version` được đọc **qua descriptor** (`readJsonDataProperty`), không đọc thẳng
  // `record.version`: một accessor do caller đặt vào đây sẽ bị kích hoạt bởi phép đọc thẳng,
  // và getter ném lỗi sẽ thoát ra ngoài validator thay vì thành một lần từ chối. Accessor/
  // field ẩn không phải một data property → bỏ qua bước này và để `scanJsonDataObject` bên
  // dưới từ chối object bằng `invalid_payload`; field **vắng hẳn** vẫn là `unsupported_version`
  // vì envelope không có version thì không đọc được field nào theo một schema xác định.
  const version = readJsonDataProperty(record, 'version');
  const versionValue = version.kind === 'value' ? version.value : undefined;
  if (version.kind !== 'not-data' && !isSupportedDeliveryCommandVersion(versionValue)) {
    return {
      ok: false,
      reason: 'unsupported_version',
      detail: `version không được hỗ trợ: ${typeof versionValue === 'number' ? String(versionValue) : typeof versionValue}. Chỉ hỗ trợ ${DELIVERY_COMMAND_VERSION}.`,
    };
  }

  const hostilePresence = presenceProbeDetail(
    record,
    'Envelope',
    FORBIDDEN_DELIVERY_COMMAND_FIELDS,
  );
  if (hostilePresence !== undefined) {
    return { ok: false, reason: 'invalid_payload', detail: hostilePresence };
  }

  for (const field of FORBIDDEN_DELIVERY_COMMAND_FIELDS) {
    if (Object.hasOwn(record, field)) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Envelope chứa field bị cấm (secret/runtime material): ${field}.`,
      };
    }
  }

  // Nhánh 3b — khoá **lồng** trong `payload`. Chạy trước bước field lạ top-level để một
  // secret lồng trong payload luôn được báo đúng là `forbidden_field` (cùng ngữ nghĩa với
  // secret top-level), thay vì rơi thành `unexpected_field` hay lỗi kiểu. Không đọc giá trị
  // của field nào — `readJsonDataProperty` đọc qua descriptor nên **không** kích hoạt getter
  // (một accessor ở `payload` vẫn bị `scanJsonDataObject` bên dưới từ chối), và `Object.hasOwn`
  // chỉ hỏi khoá có mặt.
  const earlyPayload = readJsonDataProperty(record, 'payload');
  const nestedPayload = earlyPayload.kind === 'value' ? earlyPayload.value : undefined;
  if (isPlainObject(nestedPayload)) {
    const hostileNested = presenceProbeDetail(
      nestedPayload,
      'payload',
      FORBIDDEN_DELIVERY_COMMAND_FIELDS,
    );
    if (hostileNested !== undefined) {
      return { ok: false, reason: 'invalid_payload', detail: hostileNested };
    }
    for (const field of FORBIDDEN_DELIVERY_COMMAND_FIELDS) {
      if (Object.hasOwn(nestedPayload, field)) {
        return {
          ok: false,
          reason: 'forbidden_field',
          detail: `payload chứa field bị cấm (secret/runtime material): ${field}.`,
        };
      }
    }
  }

  const scan = scanJsonDataObject(record, 'Envelope', DELIVERY_COMMAND_FIELDS);
  if (!scan.ok) {
    return { ok: false, reason: scan.reason, detail: scan.detail };
  }

  for (const field of DELIVERY_COMMAND_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      return { ok: false, reason: 'missing_field', detail: `Envelope thiếu field: ${field}.` };
    }
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
  if (!isNonEmptyString(record.subscription_id)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'subscription_id phải là chuỗi không rỗng.',
    };
  }
  if (!isNonEmptyString(record.provider_id)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'provider_id phải là chuỗi không rỗng.',
    };
  }

  if (!isTransport(record.transport)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'transport phải là giá trị Transport (web|app), không phải provider type.',
    };
  }

  // `payload` phải là object JSON. Dùng `isPlainObject` thay vì `Array.isArray` thô:
  // `Array.isArray` ném `TypeError` trên Proxy đã revoke, và giá trị của `payload` ở đây
  // là **giá trị** caller đặt — có thể là revoked proxy dù `record` đã qua `isPlainObject`.
  // Phân loại không đổi: `Date`/`Map`/`Set`/class instance/mảng đều rơi vào cùng detail.
  if (!isPlainObject(record.payload)) {
    return { ok: false, reason: 'invalid_field_type', detail: 'payload phải là object JSON.' };
  }

  // `payload` là **closed schema** ở FR-013 (đúng bốn khoá `title`/`body`/`url`/`data`,
  // mọi giá trị JSON-compatible). Kiểm ngay trong envelope validator thay vì để caller tự
  // gọi thêm: đây là boundary mà consumer Queue thật sự đi qua.
  const checkedPayload = validateNotificationPayload(record.payload);
  if (!checkedPayload.ok) {
    return {
      ok: false,
      reason:
        checkedPayload.reason === 'invalid_payload' ? 'invalid_field_type' : checkedPayload.reason,
      detail: `payload không hợp lệ (${checkedPayload.reason}): ${checkedPayload.detail}`,
    };
  }

  return {
    ok: true,
    command: {
      version: DELIVERY_COMMAND_VERSION,
      delivery_id: record.delivery_id,
      notification_id: record.notification_id,
      subscription_id: record.subscription_id,
      provider_id: record.provider_id,
      transport: record.transport,
      payload: checkedPayload.payload,
    },
  };
}

/**
 * Dựng envelope hợp lệ — **buộc** mọi envelope đi qua một chỗ.
 *
 * Không có tham số nào để thêm field ngoài bảy field hay đặt `version` khác hằng số.
 * `payload` **không** được tin theo kiểu TypeScript: input materialize từ storage/JSON là
 * dữ liệu runtime, nên builder chạy **chính validator canonical** trên kết quả dựng được
 * và ném lỗi nếu nó không qua — `payload: { auth: … }`, khoá lạ, dữ liệu không
 * JSON-compatible hay identifier rỗng đều làm builder **throw**, không bao giờ trả envelope
 * mà chính library sẽ từ chối. Envelope trả về mang `payload` bản sao đã validate — caller
 * sửa object nguồn sau đó không đổi envelope (A4).
 */
export function deliveryCommandV1(input: {
  readonly delivery_id: string;
  readonly notification_id: string;
  readonly subscription_id: string;
  readonly provider_id: string;
  readonly transport: Transport;
  readonly payload: DeliveryCommandPayload;
}): DeliveryCommandV1 {
  const candidate = {
    version: DELIVERY_COMMAND_VERSION,
    delivery_id: input.delivery_id,
    notification_id: input.notification_id,
    subscription_id: input.subscription_id,
    provider_id: input.provider_id,
    transport: input.transport,
    payload: input.payload,
  };
  const checked = validateDeliveryCommand(candidate);
  if (!checked.ok) {
    throw new Error(
      `deliveryCommandV1: envelope không qua validator (${checked.reason}): ${checked.detail}`,
    );
  }
  return checked.command;
}
