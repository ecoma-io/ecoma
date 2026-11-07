/**
 * Ngân sách byte của notification payload và phép đo canonical serialization.
 *
 * Source of truth:
 * - `docs/applications/push-notification/02-requirements.md` FR-008 (**Expiry**, **Ngân
 *   sách**): ngân sách **MUST** được áp trên **serialized plaintext của `payload`**
 *   mà delivery worker sẽ gửi, **MUST** ≤ **3993 octets** để body mã hoá luôn ≤ 4096.
 * - `docs/applications/push-notification/02-requirements.md` FR-013 (canonical
 *   serialization của `payload` là **nguồn duy nhất** để tính ngân sách byte;
 *   `body ≤ plaintext + 103 octets` — `docs/architecture/04-platform-facts.md` §2.15).
 *
 * ⚠️ **Phân chia trách nhiệm với `@ecoma-io/push-notification-contracts`.** Domain
 * **không** import contracts (dependency rule: `<bc>-domain` không phụ thuộc Nx
 * project khác — `docs/architecture/05-code-architecture.md` §3). Vì vậy ranh giới là:
 * - **contracts** sở hữu **wire schema** của `payload`: đúng bốn khoá, kiểu từng
 *   field, chính sách unknown-field, tính tương thích JSON của `data`, và việc chặn
 *   khoá bị cấm (`validateNotificationPayload`, `FORBIDDEN_DELIVERY_COMMAND_FIELDS`
 *   trong `libs/push-notification-contracts/src/`). Đây là boundary validation chạy
 *   khi payload vào hệ thống.
 * - **domain** (module này) sở hữu **quy tắc nghiệp vụ về kích thước**: canonical
 *   serialization được đo bao nhiêu octet, và ngưỡng 3993/4096 mà business bắt buộc.
 *   Domain lặp lại phép serialization **chỉ** để tự đo được ngân sách khi chạy độc
 *   lập — không phải để thay thế validator của contracts, và **không** kiểm lại shape.
 *
 * Vì domain không kiểm shape, các hàm đo ở đây nhận **`NotificationPayload` đã được
 * validate** (xem type cùng tên). Caller **MUST** validate qua contracts trước khi
 * đo — đo một payload chưa validate là sai thứ tự và có thể khiến `JSON.stringify`
 * ném ra ngoài. Domain trả về lỗi `not_serializable` thay vì để exception thoát.
 *
 * Mọi giá trị thời gian là epoch millis kiểu `number`; module này không đọc đồng hồ.
 */

/**
 * Ngân sách **plaintext** của payload (FR-008): serialized plaintext **MUST** ≤ 3993
 * octets để body đã mã hoá luôn ≤ 4096 octets (framing của protocol = 103 octets).
 */
export const MAX_PAYLOAD_PLAINTEXT_BYTES = 3993;

/** Trần **body đã mã hoá** mà Browser Push Service chấp nhận (FR-008). */
export const MAX_PUSH_BODY_BYTES = 4096;

/**
 * Chênh lệch giữa plaintext và body mã hoá do protocol framing (AES128GCM padding)
 * sinh ra: `body ≤ plaintext + 103 octets` (`04-platform-facts.md` §2.15, FR-013).
 */
export const PUSH_PROTOCOL_FRAMING_OVERHEAD_BYTES = 103;

/**
 * Domain value object của nội dung hiển thị — **bản thu nhỏ** của wire payload mà
 * contracts validate. Domain không import type của contracts nên khai báo lại bốn
 * khoá ở đây; đây là **shape tối thiểu để đo byte**, không phải wire schema đầy đủ.
 */
export type NotificationPayload = {
  readonly title: string;
  readonly body: string;
  readonly url?: string;
  readonly data?: Readonly<Record<string, unknown>>;
};

/**
 * Canonical serialization của `payload` (FR-013): UTF-8 JSON object của **đúng** bốn
 * khoá `title`, `body`, `url`, `data`, theo thứ tự cố định đó, không whitespace thừa,
 * khoá vắng mặt không xuất hiện. Đây là nguồn duy nhất để tính ngân sách byte.
 *
 * Thứ tự khoá cố định đảm bảo hai lần đo cùng nội dung cho cùng một kết quả —
 * thứ tự của object đầu vào không được làm đổi số octet. Domain lặp lại thứ tự này
 * (thay vì import serializer của contracts) **chỉ** để đo được ngân sách một cách độc
 * lập; thứ tự chuẩn là của contracts (FR-013), và caller **MUST** ensure hai bên
 * nhất quán khi contracts thay đổi.
 */
export function serializePayloadCanonically(payload: NotificationPayload): string {
  const ordered: Record<string, unknown> = {
    title: payload.title,
    body: payload.body,
  };
  if (payload.url !== undefined) {
    ordered.url = payload.url;
  }
  if (payload.data !== undefined) {
    ordered.data = payload.data;
  }
  return JSON.stringify(ordered);
}

/**
 * Khai báo **tối thiểu, phạm vi module** cho `TextEncoder` — API WHATWG có thật ở cả
 * Cloudflare Workers lẫn Node.
 *
 * ⚠️ **Vì sao không thêm `"lib": ["dom"]`:** lib mang tag `runtime:universal`; bật DOM
 * sẽ cho qua mọi API browser-only (`document`, `window`, …) và code như vậy typecheck
 * xanh nhưng chết lúc chạy trong Worker. Khai báo đúng một method đang dùng là ràng
 * buộc chặt nhất. Không dùng shim `declare global` để tránh một khai báo global thứ hai
 * trong monorepo (internal-auth-contracts đã có một cái); khai báo ở phạm vi module này chỉ
 * che trong file này và bị xoá khi compile.
 */
interface ModuleTextEncoder {
  encode(input?: string): Uint8Array;
}

declare const TextEncoder: {
  new (): ModuleTextEncoder;
};

const textEncoder = new TextEncoder();

/**
 * Số octet UTF-8 của plaintext mà delivery worker sẽ gửi.
 *
 * Dùng `TextEncoder` (Web standard, có ở cả Cloudflare Workers lẫn Node) thay vì
 * `Buffer` — domain là `runtime:universal` và **không** được phụ thuộc Node builtin.
 *
 * Trả về `null` khi payload không serialize được (giá trị không tương thích JSON lọt
 * qua validation, tham chiếu vòng…). Domain **không** để `JSON.stringify` ném ra
 * ngoài: một phép đo thuần phải trả kết quả, không phải exception.
 */
export function measurePayloadPlaintextBytes(payload: NotificationPayload): number | null {
  let serialized: string;
  try {
    serialized = serializePayloadCanonically(payload);
  } catch {
    return null;
  }
  if (typeof serialized !== 'string') {
    // JSON.stringify trả `undefined` khi top-level là undefined — không xảy ra với
    // NotificationPayload hợp lệ, nhưng chặn để hàm luôn trả số hoặc null.
    return null;
  }
  return textEncoder.encode(serialized).length;
}

export type PayloadBudgetRejection = 'not_serializable' | 'payload_over_budget';

export type PayloadBudgetResult =
  | { readonly ok: true; readonly plaintextBytes: number }
  | { readonly ok: false; readonly reason: PayloadBudgetRejection; readonly detail: string };

/**
 * Kiểm ngân sách plaintext (FR-008): serialized payload **MUST** ≤ 3993 octets.
 *
 * Caller **MUST** validate shape qua contracts trước; hàm này chỉ trả về việc đo
 * được hay vượt ngưỡng, và báo `not_serializable` thay vì ném exception khi payload
 * không serialize được.
 */
export function checkPayloadPlaintextBudget(payload: NotificationPayload): PayloadBudgetResult {
  const plaintextBytes = measurePayloadPlaintextBytes(payload);
  if (plaintextBytes === null) {
    return {
      ok: false,
      reason: 'not_serializable',
      detail: 'Payload không serialize được thành JSON hợp lệ để đo ngân sách.',
    };
  }
  if (plaintextBytes > MAX_PAYLOAD_PLAINTEXT_BYTES) {
    return {
      ok: false,
      reason: 'payload_over_budget',
      detail: `Serialized plaintext vượt ngân sách ${MAX_PAYLOAD_PLAINTEXT_BYTES} octets.`,
    };
  }
  return { ok: true, plaintextBytes };
}

/**
 * Body đã mã hoá có nằm trong trần 4096 octets không, biết rằng framing của protocol
 * cộng thêm 103 octets (FR-013: worker **MAY** thêm framing do protocol yêu cầu nhưng
 * **MUST NOT** thêm business data hay field mới).
 *
 * Vì `3993 + 103 = 4096`, mọi payload qua được ngân sách plaintext cũng qua được cửa
 * chặn này — hàm tồn tại để express trần body một cách tường minh khi caller đã có
 * số octet (ví dụ đo bên ngoài domain), chứ không phải một ngưỡng thứ hai.
 */
export function isPushBodyWithinLimit(plaintextBytes: number): boolean {
  return (
    Number.isSafeInteger(plaintextBytes) &&
    plaintextBytes >= 0 &&
    plaintextBytes + PUSH_PROTOCOL_FRAMING_OVERHEAD_BYTES <= MAX_PUSH_BODY_BYTES
  );
}
