/**
 * Primitive dùng chung cho contract của cặp service `push-notification` /
 * `web-push-notification-job` (`docs/applications/push-notification/01-architecture.md` §4.2).
 *
 * ⚠️ **`Transport` và provider type là hai abstraction khác nhau** và bị lẫn nhau đúng một
 * cách: gán `"web-push"` (provider type) vào `transport`. Đó là lỗi contract nguy hiểm vì
 * cả hai plane đều đọc `transport` để quyết định, nên hai union được khai báo tách biệt
 * ngay từ file này và guard `isTransport` / `isProviderType` là hai hàm riêng.
 *
 * File **không** chứa business rule (khi nào gửi, chọn provider nào) — chỉ hình dạng giá
 * trị được phép có mặt trên wire.
 */

/** Phương thức `Device` nhận notification (§4.2). */
export const TRANSPORT_VALUES = ['web', 'app'] as const;

/** Union `Transport` trên wire. */
export type Transport = (typeof TRANSPORT_VALUES)[number];

/**
 * Hệ thống bên ngoài thực hiện delivery (§4.2).
 *
 * `web-push` **KHÔNG** phải một `Transport`; nó là provider type nằm dưới `Transport = web`.
 */
export const PROVIDER_TYPE_VALUES = ['web-push', 'fcm', 'apns'] as const;

/** Union provider type trên wire. */
export type ProviderType = (typeof PROVIDER_TYPE_VALUES)[number];

/** `Transport` v1 hỗ trợ thực thi (worker còn giới hạn thêm theo scope — worker §4). */
export const V1_EXECUTABLE_TRANSPORT = 'web' as const satisfies Transport;

/** `Provider` v1 hỗ trợ thực thi. */
export const V1_EXECUTABLE_PROVIDER_TYPE = 'web-push' as const satisfies ProviderType;

/** Lý do một giá trị nằm **ngoài** scope thực thi v1 của web-push worker. */
export type ExecutionScopeRejectionReason = 'unsupported_transport' | 'unsupported_provider_type';

/** Kết quả kiểm scope thực thi — discriminated union, không kèm giá trị đầu vào. */
export type ExecutionScopeValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: ExecutionScopeRejectionReason;
      readonly detail: string;
    };

/**
 * Guard scope thực thi (envelope boundary) — kiểm `transport` của Queue envelope **trước**
 * khi claim (worker §4, §23.1).
 *
 * ⚠️ Đây là **guard scope thực thi**, không phải schema validator: schema của hệ thống mô
 * tả vocabulary rộng (`web`/`app` — thêm transport mới là chuyện của phase sau), nhưng
 * worker `web-push-notification-job` v1 **chỉ** được thực thi `transport = web`. Consumer
 * **MUST** gọi guard này bên trong boundary của chính nó; validator schema chung
 * (`validateDeliveryCommand`) **không** thay thế được — nó cố ý chấp nhận `app` để vocabulary
 * hệ thống không bị thu hẹp theo một worker.
 *
 * `detail` là chuỗi hằng — **không** nối giá trị đầu vào (log injection).
 */
export function validateV1ExecutionTransport(transport: unknown): ExecutionScopeValidation {
  if (transport === V1_EXECUTABLE_TRANSPORT) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: 'unsupported_transport',
    detail: `transport nằm ngoài scope thực thi v1 — worker chỉ thực thi "${V1_EXECUTABLE_TRANSPORT}".`,
  };
}

/**
 * Guard scope thực thi (claim boundary) — kiểm **cặp** `transport` + `provider.type` trên
 * runtime material của response `200` claim, **trước** khi gửi provider (worker §7, §23.1).
 *
 * Hai giá trị phải kiểm cùng nhau vì chúng là hai abstraction khác nhau: `transport = web`
 * nhưng `provider.type = fcm` (hoặc ngược lại) là dữ liệu ngoài scope — worker **MUST NOT**
 * reroute sang provider ngoài scope. Guard này là hàng rào consumer: schema validator chung
 * vẫn chấp nhận `fcm`/`apns`/`app` vì vocabulary hệ thống có chúng.
 *
 * `detail` là chuỗi hằng — **không** nối giá trị đầu vào (log injection).
 */
export function validateV1ExecutionMaterialScope(input: {
  readonly transport: unknown;
  readonly provider_type: unknown;
}): ExecutionScopeValidation {
  const transportCheck = validateV1ExecutionTransport(input.transport);
  if (!transportCheck.ok) {
    return transportCheck;
  }
  if (input.provider_type === V1_EXECUTABLE_PROVIDER_TYPE) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: 'unsupported_provider_type',
    detail: `provider.type nằm ngoài scope thực thi v1 — worker chỉ thực thi "${V1_EXECUTABLE_PROVIDER_TYPE}".`,
  };
}

/** Kiểm tra một giá trị có phải `Transport` hợp lệ. */
export function isTransport(value: unknown): value is Transport {
  return typeof value === 'string' && (TRANSPORT_VALUES as readonly string[]).includes(value);
}

/** Kiểm tra một giá trị có phải provider type hợp lệ. */
export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (PROVIDER_TYPE_VALUES as readonly string[]).includes(value);
}

/**
 * Kết quả một phép phản chiếu đã được bọc an toàn.
 *
 * `Proxy` có thể đặt trap cho `getPrototypeOf`/`ownKeys`/`getOwnPropertyDescriptor` mà
 * **ném exception**. Nếu để nó thoát, boundary validator mất khả năng phân loại: thay vì
 * `{ ok: false }` với reason đóng, caller nhận một exception chưa kiểm soát — đúng lỗi mà
 * `readJsonDataProperty` bên dưới đã diệt cho getter. Ba helper phản chiếu dưới đây áp cùng
 * một chính sách: trap ném ⇒ coi object không phải JSON-data và trả về reason đã có sẵn.
 */
type Reflection<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** `Object.getPrototypeOf` bọc try/catch — `ok: false` khi trap của Proxy ném. */
function reflectPrototype(value: object): Reflection<unknown> {
  try {
    return { ok: true, value: Object.getPrototypeOf(value) };
  } catch {
    return { ok: false };
  }
}

/** `Reflect.ownKeys` bọc try/catch — `ok: false` khi trap của Proxy ném. */
function reflectOwnKeys(value: object): Reflection<readonly PropertyKey[]> {
  try {
    return { ok: true, value: Reflect.ownKeys(value) };
  } catch {
    return { ok: false };
  }
}

/** `Object.getOwnPropertyDescriptor` bọc try/catch — `ok: false` khi trap của Proxy ném. */
function reflectDescriptor(
  value: object,
  key: PropertyKey,
): Reflection<PropertyDescriptor | undefined> {
  try {
    return { ok: true, value: Object.getOwnPropertyDescriptor(value, key) };
  } catch {
    return { ok: false };
  }
}

/**
 * `Array.isArray` bọc try/catch — `ok: false` khi trap của Proxy ném.
 *
 * ⚠️ `Array.isArray` **không** an toàn trên Proxy đã revoke: revoke khiến mọi internal
 * method trên proxy ném `TypeError`, kể cả `[[GetTarget]]` mà `Array.isArray` dùng. Vì
 * `isPlainObject` là lời gọi đầu tiên của **mọi** validator, một Proxy revoked đi qua
 * `Array.isArray` thẳng sẽ ném `TypeError` thô ra ngoài biên thay vì trả union phân loại.
 */
function reflectIsArray(value: object): Reflection<boolean> {
  try {
    return { ok: true, value: Array.isArray(value) };
  } catch {
    return { ok: false };
  }
}

/** Chi tiết hằng cho diagnostic khi trap của Proxy ném — không lấy gì từ đầu vào. */
const HOSTILE_REFLECTION_DETAIL = 'object ném exception khi phản chiếu (Proxy trap).';
/** `kind` hằng của `copyJsonCompatible` cho cùng trường hợp trên. */
const HOSTILE_REFLECTION_KIND = 'object ném lỗi khi phản chiếu (Proxy trap)';
/** `field` hằng khi không có field nào để nêu — chuỗi này không lấy từ đầu vào. */
const HOSTILE_REFLECTION_FIELD = '[reflection-error]';

/**
 * Kiểm tra một giá trị có phải **plain object** thật sự: không `null`, không mảng, và
 * prototype là `Object.prototype` hoặc `null` (object tạo từ `{}`/`Object.create(null)`/`JSON.parse`).
 *
 * ⚠️ Không nhận `Date`, `Map`, `Set`, `RegExp`, instance của class hay object có prototype
 * tùy ý: `JSON.stringify` đổi shape của chúng lặng lẽ (`Date` → chuỗi, `Map` → `{}`), nên
 * coi chúng là "object JSON" là một lỗ hổng validator — caller truyền `new Date()` vào một
 * field hợp đồng sẽ bị **từ chối**, không bị coi là dữ liệu JSON hợp lệ.
 *
 * Trap `getPrototypeOf` của `Proxy` ném exception ⇒ trả `false` (từ chối) thay vì để
 * exception thoát ra ngoài boundary.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const isArray = reflectIsArray(value as object);
  if (!isArray.ok || isArray.value) {
    return false;
  }
  const prototype = reflectPrototype(value as object);
  if (!prototype.ok) {
    return false;
  }
  return prototype.value === Object.prototype || prototype.value === null;
}

/** Kiểm tra chuỗi không rỗng. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Kiểm tra số nguyên dương an toàn (dùng cho `dispatch_generation`). */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Chuẩn hoá **tên field do caller kiểm soát** trước khi nối vào `detail` (log injection).
 *
 * `detail` có thể đi vào log, nên tên khoá chứa `\\n`/ký tự điều khiển sẽ chèn dòng giả và
 * chuỗi cực dài sẽ phình log. Hàm thay ký tự điều khiển bằng `?` và cắt ở **256** ký tự —
 * hai giới hạn này áp cho **tên field** ở mọi diagnostic, không phải cho giá trị (giá trị
 * **không bao giờ** được nối vào `detail`).
 */
export function safeFieldName(key: PropertyKey): string {
  if (typeof key !== 'string') {
    return '[non-string-key]';
  }
  let sanitized = '';
  for (let i = 0; i < key.length && i < 256; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      sanitized += '?';
      continue;
    }
    sanitized += key.charAt(i);
  }
  return sanitized;
}

/** Kết quả quét own-key của một object hợp đồng — hai reason dùng chung mọi validator. */
export type JsonPropertyRejection = {
  readonly ok: false;
  readonly reason: 'unexpected_field' | 'invalid_payload';
  readonly detail: string;
  /** Tên field đã qua `safeFieldName` — dùng được cho diagnostic cấp caller. */
  readonly field: string;
};

/**
 * Kết quả `scanJsonDataObject` — hoặc danh sách own-key hợp lệ, hoặc một lần từ chối.
 *
 * Hai reason là **chính xác** tập reason mà mọi validator trong thư viện đã có sẵn:
 * `unexpected_field` cho khoá ngoài contract, `invalid_payload` cho object không phải
 * object JSON (symbol key / getter / field ẩn).
 */
export type JsonDataObjectScan =
  | { readonly ok: true; readonly keys: readonly string[] }
  | JsonPropertyRejection;

/** Từ chối `invalid_payload` dùng chung khi một phép phản chiếu của `Proxy` ném exception. */
function hostileScan(label: string): JsonPropertyRejection {
  return {
    ok: false,
    reason: 'invalid_payload',
    detail: `${label}: ${HOSTILE_REFLECTION_DETAIL}`,
    field: HOSTILE_REFLECTION_FIELD,
  };
}

/**
 * Dò trap `getOwnPropertyDescriptor` của `Proxy` trên tập khoá mà validator sắp hỏi
 * `Object.hasOwn` **trước** vòng kiểm field bị cấm.
 *
 * `Object.hasOwn` đi qua `[[GetOwnProperty]]` nên kích hoạt trap đó; trap ném sẽ làm
 * exception thoát ra ngoài boundary thay vì thành một lần từ chối — đúng lỗi mà
 * `readJsonDataProperty` đã diệt cho getter. Gọi hàm này trước vòng cấm để bước shape →
 * cấm → lạ → thiếu → kiểu giữ nguyên thứ tự với object **lành mạnh** (hàm chỉ hỏi sự có
 * mặt, không đọc giá trị, nên không kích hoạt getter nào) và chỉ nhúng tay khi chuẩn bị
 * ném exception.
 *
 * Trả `undefined` khi an toàn; ngược lại là `detail` hằng để validator trả `invalid_payload`.
 */
export function presenceProbeDetail(
  record: object,
  label: string,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    try {
      Object.hasOwn(record, key);
    } catch {
      return `${label}: ${HOSTILE_REFLECTION_DETAIL}`;
    }
  }
  return undefined;
}

/**
 * Quét own-key của một object hợp đồng theo **chính sách JSON-data thống nhất** (A1):
 *
 * 1. **Khoá ngoài contract bị chặn trước khoá thiếu** — cùng policy unknown-field-before-
 *    missing của canonical (FR-013), áp cho mọi validator.
 * 2. **Chỉ key chuỗi** — symbol key không tồn tại trên JSON wire; bỏ qua nó là bỏ qua
 *    âm thầm dữ liệu.
 * 3. **Chỉ data property enumerable** — getter/setter bị từ chối **trước** khi bất kỳ giá
 *    trị nào được đọc (validator không kích hoạt getter của caller); field non-enumerable
 *    bị từ chối vì `JSON.stringify` sẽ bỏ nó lặng lẽ → object không đại diện đúng JSON.
 * 4. **Trap `get`/`getOwnPropertyDescriptor` của `Proxy` bị dò trước khi trả về** — sau bước
 *    này validator đọc thẳng `record.field` và hỏi `Object.hasOwn`, nên `Proxy` có
 *    `ownKeys`/descriptor ở khoá lồng (`scanJsonDataObject` đã dò) lành mạnh nhưng trap
 *    `get` hay trap ở khoá **vắng** ném vẫn làm exception thoát ra ngoài boundary. Khối
 *    này thử cả hai phép trên **mọi** khoá trong `allowed` (kể cả khoá vắng — validator
 *    vẫn đọc thẳng chúng và nhận `undefined`) trong try/catch. Trên object JSON thật hai
 *    phép đó thuần: khoá có mặt là data property (đã loại accessor ở bước 3), khoá vắng chỉ
 *    đi qua `Object.prototype`/`null`; chỉ `Proxy` mới chạy trap.
 *
 * **Precondition**: `record` MUST đã qua `isPlainObject`. Bước 4 đọc khoá vắng nên đi xuống
 * prototype — prototype khác `Object.prototype`/`null` có thể mang getter mà helper này sẽ
 * vô tình kích hoạt, nên guard đầu hàm tự enforce thay vì chỉ ghi trong tài liệu.
 *
 * `detail` chỉ chứa **tên** field đã qua `safeFieldName` — không bao giờ nối giá trị.
 * `allowed` là tập field **đóng** của object; object mở (opaque container) không đi qua
 * helper này — validator không đọc bên trong nên không có getter nào bị kích hoạt.
 */
export function scanJsonDataObject(
  record: object,
  label: string,
  allowed: readonly string[],
): JsonDataObjectScan {
  if (!isPlainObject(record)) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: `${label} phải là object JSON.`,
      field: HOSTILE_REFLECTION_FIELD,
    };
  }
  const reflectedKeys = reflectOwnKeys(record);
  if (!reflectedKeys.ok) {
    return hostileScan(label);
  }
  const ownKeys = reflectedKeys.value;

  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `${label}: symbol key không phải JSON key ([non-string-key]).`,
        field: '[non-string-key]',
      };
    }
    if (!allowed.includes(key)) {
      const field = safeFieldName(key);
      return {
        ok: false,
        reason: 'unexpected_field',
        detail: `${label} chứa field ngoài contract: ${field}.`,
        field,
      };
    }
  }

  for (const key of ownKeys as readonly string[]) {
    const reflectedDescriptor = reflectDescriptor(record, key);
    if (!reflectedDescriptor.ok) {
      return hostileScan(label);
    }
    const descriptor = reflectedDescriptor.value;
    if (descriptor === undefined) {
      continue;
    }
    if ('get' in descriptor || 'set' in descriptor) {
      const field = safeFieldName(key);
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `${label}: field ${field} là getter/setter — object JSON chỉ có data property.`,
        field,
      };
    }
    if (!descriptor.enumerable) {
      const field = safeFieldName(key);
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `${label}: field ${field} là non-enumerable — JSON.stringify sẽ bỏ nó âm thầm.`,
        field,
      };
    }
  }

  // Khối 4 — dò trap `get` **và** `getOwnPropertyDescriptor` của `Proxy` trước khi trả
  // `ok: true`. Xem ghi chú trong JSDoc: bước 3 đã chứng minh mọi khoá có mặt là data
  // property nên `Reflect.get` ở đây không kích hoạt getter nào trên object JSON thật;
  // `Object.hasOwn` được dò song song vì vòng kiểm khoá thiếu phía sau validator dùng nó
  // và nó đi qua trap `getOwnPropertyDescriptor` — hai trap độc lập nhau nên dò cả hai.
  // Exception chỉ đến từ trap của `Proxy`, và ném nó ra ngoài boundary chính là lỗi mà
  // `readJsonDataProperty` đã diệt cho getter.
  for (const key of allowed) {
    try {
      Object.hasOwn(record, key);
      Reflect.get(record, key);
    } catch {
      return hostileScan(label);
    }
  }

  return { ok: true, keys: ownKeys as readonly string[] };
}

/**
 * Kết quả đọc một own property **an toàn với getter**.
 */
export type JsonDataProperty =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'absent' }
  | { readonly kind: 'not-data' };

/**
 * Đọc own property mà **không** kích hoạt getter/setter (A1).
 *
 * `scanJsonDataObject` từ chối accessor, nhưng chỉ **sau** bước quét của nó. Vài validator
 * phải đọc một field **trước** bước đó: envelope đọc `version` để biết cách đọc phần còn lại,
 * và đọc `payload` để chặn secret lồng trong nó. Đọc thẳng `record.version` ở đó sẽ **kích
 * hoạt** getter của caller — một getter ném lỗi sẽ thoát ra ngoài validator dưới dạng
 * exception thay vì thành một lần từ chối, tức boundary mất khả năng phân loại. Helper này
 * đọc qua descriptor nên không bao giờ kích hoạt accessor.
 *
 * - `'value'` — own data property enumerable; `value` là giá trị.
 * - `'absent'` — **không** có own property (kế thừa từ prototype không tính, cùng định nghĩa
 *   `"có mặt"` với `Object.hasOwn`).
 * - `'not-data'` — có own property nhưng là accessor hoặc non-enumerable, **hoặc** trap
 *   `getOwnPropertyDescriptor` của `Proxy` ném exception (cùng chính sách với accessor:
 *   không có giá trị nào để đọc). Caller **MUST NOT** đọc giá trị; `scanJsonDataObject`
 *   sẽ từ chối chính object đó bằng `invalid_payload`.
 */
export function readJsonDataProperty(record: object, key: string): JsonDataProperty {
  const reflected = reflectDescriptor(record, key);
  if (!reflected.ok) {
    return { kind: 'not-data' };
  }
  const descriptor = reflected.value;
  if (descriptor === undefined) {
    return { kind: 'absent' };
  }
  if ('get' in descriptor || 'set' in descriptor || !descriptor.enumerable) {
    return { kind: 'not-data' };
  }
  return { kind: 'value', value: descriptor.value };
}

/** Kết quả một lần copy + kiểm giá trị JSON — `kind` là chuỗi hằng, không lấy từ đầu vào. */
export type JsonCompatibleCopy =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly kind: string };

/** `kind` khi engine hết stack giữa lúc copy — cùng giới hạn mà `JSON.stringify` cũng có. */
const TOO_DEEP_KIND = 'vượt độ sâu JSON mà engine serialize được';

/**
 * Kiểm tính tương thích JSON **và** tạo bản sao độc lập trong **một** lần duyệt (A2 + A4).
 *
 * Policy — đúng một bộ quy tắc, không dựa vào việc `JSON.stringify()` có ném lỗi không:
 *
 * - Chấp nhận: `null`, boolean, string, số **hữu hạn**, mảng và plain object JSON.
 * - Từ chối: `undefined`, `function`, `symbol`, `BigInt`, số không hữu hạn (`NaN`/`Infinity`/
 *   overflow), circular reference, object có prototype tùy ý (`Date`/`Map`/`Set`/class),
 *   getter/setter (đọc qua descriptor — **không bao giờ kích hoạt**), field non-enumerable
 *   (`JSON.stringify` sẽ bỏ âm thầm → mất dữ liệu), symbol key, mảng sparse, mảng có field
 *   ngoài chỉ số.
 * - Bản sao là **plain object/array mới với primitive copy by value** — caller sửa object
 *   nguồn sau khi validate không đổi kết quả; bản sao cũng chính là hình dạng sẽ lên wire
 *   (không còn thuộc tính nào mà stringify có thể bỏ hay biến đổi).
 *
 * Duyệt **có** đệ quy. Không impose một giới hạn độ sâu mới (tài liệu chưa cho phép) — thay
 * vào đó bắt `RangeError` của engine ở **hai** chỗ, để invariant "validator nhận ⇒ serializer
 * canonical serialize được" là **đúng**, không chỉ gần đúng:
 *
 * 1. Lúc bản sao đệ quy tràn stack (`copyJsonCompatibleValue`).
 * 2. Sau khi copy xong, thử serialize **chính bản sao** (hình dạng sẽ lên wire) và bắt
 *    `RangeError` của chính bộ serialize.
 *
 * Bước (2) là cần thiết vì hai traversal có **ngân sách stack khác nhau** trên V8:
 * `JSON.stringify` tốn frame hơn per level nên đứt trước. Đo được: một object lồng tới
 * ~4 600 cấp thì `copyJsonCompatibleValue` vẫn copy xong nhưng `JSON.stringify` đã ném
 * `RangeError` — tức không có bước (2) thì validator **nhận** một payload mà consumer Queue
 * không publish nổi. Bước (2) dùng đúng giới hạn của engine, **không** phát minh con số nào.
 *
 * `seen` là tập **trên đường đi** (thêm khi vào, xoá khi ra): tham chiếu dùng chung không
 * cyclic vẫn hợp lệ (`JSON.stringify` cũng serialize hai lần), chỉ vòng lặp thật sự bị từ chối.
 */
export function copyJsonCompatible(value: unknown, seen: Set<object>): JsonCompatibleCopy {
  let copy: JsonCompatibleCopy;
  try {
    copy = copyJsonCompatibleValue(value, seen);
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      return { ok: false, kind: TOO_DEEP_KIND };
    }
    throw error;
  }
  if (!copy.ok) {
    return copy;
  }
  try {
    JSON.stringify(copy.value);
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      return { ok: false, kind: TOO_DEEP_KIND };
    }
    throw error;
  }
  return copy;
}

/** Thân đệ quy của `copyJsonCompatible` — `RangeError` do caller bắt ở đúng một chỗ. */
function copyJsonCompatibleValue(value: unknown, seen: Set<object>): JsonCompatibleCopy {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { ok: true, value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false, kind: 'số không hữu hạn (NaN/Infinity)' };
  }
  if (typeof value === 'undefined') {
    return { ok: false, kind: 'undefined' };
  }
  if (typeof value === 'bigint') {
    return { ok: false, kind: 'BigInt' };
  }
  if (typeof value === 'function') {
    return { ok: false, kind: 'function' };
  }
  if (typeof value === 'symbol') {
    return { ok: false, kind: 'symbol' };
  }

  // Object: đã qua mọi nhánh primitive nên đây là object thật.
  const object: object = value;
  if (seen.has(object)) {
    return { ok: false, kind: 'vòng tham chiếu (circular reference)' };
  }

  const isArray = reflectIsArray(object);
  if (!isArray.ok) {
    return { ok: false, kind: HOSTILE_REFLECTION_KIND };
  }
  if (isArray.value) {
    const clone: unknown[] = [];
    let indexCount = 0;
    seen.add(object);
    const reflectedArrayKeys = reflectOwnKeys(object);
    if (!reflectedArrayKeys.ok) {
      return { ok: false, kind: HOSTILE_REFLECTION_KIND };
    }
    // `length` đọc qua descriptor chứ không qua `object.length` — đọc thẳng sẽ kích hoạt
    // trap `get` của `Proxy` và một trap ném sẽ lại thoát ra ngoài boundary.
    const reflectedLength = reflectDescriptor(object, 'length');
    if (!reflectedLength.ok || reflectedLength.value === undefined) {
      return { ok: false, kind: HOSTILE_REFLECTION_KIND };
    }
    const lengthValue: unknown = reflectedLength.value.value;
    if (typeof lengthValue !== 'number') {
      return { ok: false, kind: 'mảng không có length số' };
    }
    const arrayLength = lengthValue;
    for (const key of reflectedArrayKeys.value) {
      if (key === 'length') {
        continue;
      }
      if (typeof key !== 'string') {
        return { ok: false, kind: 'symbol key trong mảng' };
      }
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= arrayLength) {
        return { ok: false, kind: 'field ngoài chỉ số trong mảng' };
      }
      const reflectedElement = reflectDescriptor(object, key);
      if (!reflectedElement.ok) {
        return { ok: false, kind: HOSTILE_REFLECTION_KIND };
      }
      const descriptor = reflectedElement.value;
      if (descriptor === undefined) {
        continue;
      }
      if ('get' in descriptor || 'set' in descriptor) {
        return { ok: false, kind: 'getter/setter' };
      }
      if (!descriptor.enumerable) {
        return { ok: false, kind: 'field non-enumerable trong mảng' };
      }
      const copied = copyJsonCompatibleValue(descriptor.value, seen);
      if (!copied.ok) {
        return copied;
      }
      clone[index] = copied.value;
      indexCount += 1;
    }
    if (indexCount !== arrayLength) {
      return { ok: false, kind: 'mảng sparse (chỗ trống thành null lặng lẽ)' };
    }
    seen.delete(object);
    return { ok: true, value: clone };
  }

  if (!isPlainObject(object)) {
    // `isPlainObject` đã trả `false` cho prototype không phải JSON; nó cũng trả `false` khi
    // trap `getPrototypeOf` của `Proxy` ném — phân biệt hai trường hợp để diagnostic không
    // nói "Date/Map/Set" cho một object đáng lẽ phải nói là trap.
    if (!reflectPrototype(object).ok) {
      return { ok: false, kind: HOSTILE_REFLECTION_KIND };
    }
    return {
      ok: false,
      kind: 'object có prototype không phải JSON (Date/Map/Set/class instance)',
    };
  }

  const clone: Record<string, unknown> = {};
  seen.add(object);
  const reflectedObjectKeys = reflectOwnKeys(object);
  if (!reflectedObjectKeys.ok) {
    return { ok: false, kind: HOSTILE_REFLECTION_KIND };
  }
  for (const key of reflectedObjectKeys.value) {
    if (typeof key !== 'string') {
      return { ok: false, kind: 'symbol key' };
    }
    const reflectedMember = reflectDescriptor(object, key);
    if (!reflectedMember.ok) {
      return { ok: false, kind: HOSTILE_REFLECTION_KIND };
    }
    const descriptor = reflectedMember.value;
    if (descriptor === undefined) {
      continue;
    }
    if ('get' in descriptor || 'set' in descriptor) {
      return { ok: false, kind: 'getter/setter' };
    }
    if (!descriptor.enumerable) {
      return { ok: false, kind: 'field non-enumerable' };
    }
    const copied = copyJsonCompatibleValue(descriptor.value, seen);
    if (!copied.ok) {
      return copied;
    }
    // `defineProperty` chứ không phải gán `clone[key] = …`: gán sẽ gọi setter `__proto__`
    // của `Object.prototype` thay vì tạo own data property — đúng semantic `JSON.parse`.
    Object.defineProperty(clone, key, {
      value: copied.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  seen.delete(object);
  return { ok: true, value: clone };
}

/**
 * RFC3339 timestamp — shape kiểm được mà không cần locale.
 *
 * **Không** dùng `Date.parse` làm nguồn chân lý: nó **normalize** thay vì từ chối, nên
 * một ngày không tồn tại vẫn "parse được" (`"2026-02-30"` → 2/3, `"2026-04-31"` → 1/5) và
 * `24:00:00` được chấp nhận như nửa đêm hôm sau. Vì vậy shape do regex chốt, còn **ngày
 * tồn tại thật** kiểm bằng số học lịch (số ngày trong tháng + năm nhuận) — không phụ thuộc
 * engine ngày, không đọc `locale`/timezone nào.
 */
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

/** Số ngày chuẩn của từng tháng (tháng 2 lấy đúng giá trị không nhuận — xử lý riêng bên dưới). */
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Số ngày của một tháng, có xét năm nhuận (lịch Gregorian). */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  // `month` luôn ∈ [1, 12] khi chạy tới đây — caller đã reject `mo < 1 || mo > 12` bằng vế
  // trái của `||`, nên `month - 1` luôn ∈ [0, 11] và không cần fallback `?? 31`.
  return DAYS_PER_MONTH[month - 1];
}

export function isRfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const [, year, month, day, hour, minute, second, offsetSign, offsetHour, offsetMinute] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  // Miền số của từng thành phần (regex đã chốt đúng số chữ số).
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
    return false;
  }
  if (h > 23 || mi > 59 || s > 59) {
    return false;
  }
  // Offset phải là `±HH:MM` hợp lệ: giờ 0–23, phút 0–59 (regex cho qua `+99:00`).
  if (offsetSign !== undefined) {
    if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) {
      return false;
    }
  }
  return true;
}

/** Delivery state (canonical → `docs/applications/push-notification/02-requirements.md` FR-015). */
export const DELIVERY_STATUS_VALUES = [
  'pending',
  'queued',
  'processing',
  'delivered',
  'failed',
  'expired',
  'cancelled',
] as const;

/** Union delivery state. */
export type DeliveryStatus = (typeof DELIVERY_STATUS_VALUES)[number];

/** Terminal state — không rời được theo đường bình thường (FR-015). */
export const TERMINAL_DELIVERY_STATUS_VALUES = [
  'delivered',
  'failed',
  'expired',
  'cancelled',
] as const satisfies readonly DeliveryStatus[];

/** Union terminal state. */
export type TerminalDeliveryStatus = (typeof TERMINAL_DELIVERY_STATUS_VALUES)[number];

/** Kiểm tra một giá trị có phải delivery state hợp lệ. */
export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === 'string' && (DELIVERY_STATUS_VALUES as readonly string[]).includes(value);
}

/** Kiểm tra một giá trị có phải terminal delivery state. */
export function isTerminalDeliveryStatus(value: unknown): value is TerminalDeliveryStatus {
  return (
    typeof value === 'string' &&
    (TERMINAL_DELIVERY_STATUS_VALUES as readonly string[]).includes(value)
  );
}

/** Union non-terminal state — `pending`/`queued`/`processing` (FR-015). */
export type NonTerminalDeliveryStatus = Exclude<DeliveryStatus, TerminalDeliveryStatus>;

/**
 * Kiểm tra một giá trị có phải **non-terminal** delivery state.
 *
 * Worker cần đúng phép này trên wire: sau khi claim một delivery vẫn `processing` thì
 * bất kỳ kết cục nào khác đều là terminal, và trước khi claim thì chỉ `queued` là
 * claimable (`pending` nghĩa là chưa có lần publish thành công nào). Suy ra **bằng cách đảo**
 * `isTerminalDeliveryStatus` sau khi đã đi qua `isDeliveryStatus` — một giá trị ngoài
 * vocabulary phải trả `false` ở **cả** hai guard, nếu không thì một state lạ (lệch version
 * vocabulary) có thể lọt vào nhánh "non-terminal" của worker.
 *
 * ⚠️ Không `!isTerminalDeliveryStatus(value)` một mình: đó là fail-open — mọi giá trị
 * không thuộc vocabulary (kể cả `null`) sẽ được coi là non-terminal.
 */
export function isNonTerminalDeliveryStatus(value: unknown): value is NonTerminalDeliveryStatus {
  return isDeliveryStatus(value) && !isTerminalDeliveryStatus(value);
}

/**
 * Non-terminal state — `pending`/`queued`/`processing` (FR-015).
 *
 * **Suy ra** từ `DELIVERY_STATUS_VALUES` trừ tập terminal, rồi **giữ nguyên thứ tự của
 * vocabulary cha** thay vì dùng `Array#sort` (repo cấm `sort`; `toSorted` cũng cần
 * `lib` es2023 và tệ hơn: nó trả một bản *copy*, mà ở đây ta cần một hằng module).
 * `filter` giữ thứ tự nên danh sách này là `pending`, `queued`, `processing` — đúng thứ tự
 * đọc tự nhiên của FR-015, và quan trọng hơn là **tự cập nhật** khi vocabulary cha đổi:
 * một state mới thêm vào `DELIVERY_STATUS_VALUES` mà quên cập nhật terminal thì nó tự xuất
 * hiện ở đây thay vì biến mất khỏi khả năng kiểm.
 *
 * Mảng này là **để kiểm**, không phải nguồn sự thật của guard: `isNonTerminalDeliveryStatus`
 * cố ý đảo `isTerminalDeliveryStatus` trên tập **cha** để hai guard không thể lệch nhau
 * (thêm một state vào một trong hai tập thì guard đảo vẫn đúng).
 */
export const NON_TERMINAL_DELIVERY_STATUS_VALUES: readonly NonTerminalDeliveryStatus[] =
  DELIVERY_STATUS_VALUES.filter(
    (status): status is NonTerminalDeliveryStatus => !isTerminalDeliveryStatus(status),
  );

/**
 * Subscription lifecycle (canonical → `docs/applications/push-notification/02-requirements.md` FR-004).
 *
 * Tập này là **đóng**: `invalidated` **KHÔNG** phải một state của subscription — nó từng được
 * dùng lẫn cho `status` trong ack của `invalidate` và nếu ghi vào cột `status` sẽ tạo state
 * thứ tư ngoài lifecycle. Ack của `invalidate` trả về state **thuộc tập này** (`disabled`).
 */
export const SUBSCRIPTION_STATUS_VALUES = ['active', 'disabled', 'expired'] as const;

/** Union subscription state. */
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS_VALUES)[number];

/** Kiểm tra một giá trị có phải subscription state hợp lệ. */
export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return (
    typeof value === 'string' && (SUBSCRIPTION_STATUS_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Nhóm **tên secret protocol** — credential/subscription material và mọi alias thường
 * gặp của nó (`authorization`, `secret`, `token`, `access_token`).
 *
 * ⚠️ Đây là **nguồn duy nhất** của nhóm secret, dùng cho **cả** envelope Queue **và** mọi
 * body response. Trước đây hai bên dùng hai danh sách chép tay khác nhau: envelope chặn
 * `authorization`/`secret`/`token`/`access_token` còn response thì **không**, nên cùng một
 * tên secret báo `forbidden_field` ở envelope nhưng chỉ báo `unexpected_field` ở `409` —
 * alert lọc theo `runtime_material_leak` sẽ bỏ sót đúng secret mà lớp kia chặn.
 */
export const SECRET_PROTOCOL_FIELDS = [
  'auth',
  'p256dh',
  'endpoint',
  'vapid_private_key',
  'vapid_key_id',
  'provider_credential',
  'credential',
  'authorization',
  'secret',
  'token',
  'access_token',
] as const;

/** Field của **response** delivery runtime — hợp pháp với envelope (nơi chúng là material), cấm ở đây. */
export const RESPONSE_ONLY_MATERIAL_FIELDS = [
  'payload',
  'payload_digest',
  'subscription',
  'provider',
  'dispatch_generation',
  'lease_expires_at',
] as const;

/** Field thêm ngoài nhóm secret trên **envelope** — `status`/`expires_at`/`app` thuộc response, `payload` thì hợp lệ. */
export const ENVELOPE_ADDITIONAL_FORBIDDEN_FIELDS = [
  'subscription',
  'provider',
  'dispatch_generation',
  'lease_expires_at',
  'status',
  'expires_at',
  'app',
  'payload_digest',
] as const;

/**
 * Nhóm field mang **delivery runtime material + secret protocol** — body của mọi operation
 * trong private delivery runtime API (`claim`/`release`/`outcome`/`invalidate`) **MUST NOT**
 * chứa nhóm này.
 *
 * ⚠️ Danh sách này là **nguồn duy nhất** cho các `FORBIDDEN_*` của response: trước đây ba
 * danh sách được chép tay và đã trôi lệch nhau (`dispatch_generation` có ở chỗ này thiếu ở
 * chỗ kia, `subscription`/`provider` thiếu ở ack `invalidate`) — mỗi lần thêm một tên secret
 * mới mà quên một response là một lỗ hổng phân loại âm thầm. Envelope Queue
 * (`FORBIDDEN_DELIVERY_COMMAND_FIELDS`) **không** dùng hằng này: `payload` là field **hợp
 * pháp** của envelope trong khi là material **bị cấm** trong response, hai ngữ nghĩa khác
 * nhau — nhưng **cả hai** cùng lấy nhóm secret từ `SECRET_PROTOCOL_FIELDS` ở trên.
 */
export const FORBIDDEN_DELIVERY_MATERIAL_FIELDS = [
  ...RESPONSE_ONLY_MATERIAL_FIELDS,
  ...SECRET_PROTOCOL_FIELDS,
] as const;
