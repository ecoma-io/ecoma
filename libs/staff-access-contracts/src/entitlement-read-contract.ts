/**
 * Entitlement **read model** — ảnh trạng thái "nhân sự X được dùng sản phẩm Y"
 * mà các sản phẩm nội bộ (`backoffice`, `pact-broker`, `remote-cache`) giữ về
 * phía mình sau khi đồng bộ event từ Staff Access.
 *
 * Source of truth (docs/domains/staff-access/):
 * - `README.md` §3: entitlement = **tính khả dụng sản phẩm** (product-level
 *   availability); authorization = per-resource/per-operation — hai khái niệm
 *   khác nhau, ranh giới bắt buộc (ADR-0009).
 * - [ADR-0009](../../domains/staff-access/adr/0009-no-internal-authorization-result-contract.md):
 *   KHÔNG có contract nội bộ nhận **kết quả authorization**; state lan bằng
 *   batch/event-based sync; không sync call trên đường request.
 * - ADR-0002: ngưỡng revocation latency `normal` ≤ 60s / `high` ≤ 5s là
 *   **target**; cơ chế đáp ứng thuộc Phase 2 (P2.2/P2.5) — read model này
 *   KHÔNG mã hoá transport.
 *
 * ⚠️ **Ranh giới entitlement ≠ authorization được cơ giới hoá tại đây.** Read
 * model chỉ được tuyên bố ĐÚNG MỘT thứ: sản phẩm có sẵn dùng cho staff hay
 * không (`status`). Bất kỳ trường nào mang verdict/decision allow-deny,
 * permission hay role đều là biến contract này thành authorization-result
 * contract mà ADR-0009 cấm — `FORBIDDEN_ENTITLEMENT_FIELDS` chặn ở validator,
 * và P1.3 ghim phía docs cùng ranh giới đó.
 *
 * Key của entry: `staff_id` — định danh do Staff Access sở hữu, KHÔNG phải
 * `sub`. Lý do: mapping `sub` → staff là quy trình server-side của service
 * (ADR-0012 §4) và `sub` có thể **đổi chủ** theo lifecycle account (không tái
 * phát hành là bất biến của `account`, không phải của Staff Access); định danh
 * staff là key bất biến trong directory của Staff Access. Consumer cần `sub`
 * lúc enforce thì ánh xạ qua dữ liệu đồng bộ của mình — read model không mang
 * `sub` để tránh một khoá thứ hai dễ trôi lệch.
 */

/** Danh sách sản phẩm nội bộ được Staff Access phát entitlement — mở khi thêm sản phẩm mới. */
export const ENTITLEMENT_PRODUCTS = ['backoffice', 'pact-broker', 'remote-cache'] as const;

/**
 * Tập sản phẩm hợp lệ trên wire — kiểu dữ liệu đọc từ đây. Danh sách **sẽ
 * dài thêm** khi sản phẩm nội bộ mới xuất hiện (registry sản phẩm tăng dần);
 * consumer phải xử lý giá trị lạ theo kiểu "không phải sản phẩm của mình"
 * thay vì giả định tập đóng.
 */
export type EntitlementProduct = (typeof ENTITLEMENT_PRODUCTS)[number];

/** Type guard cho {@link EntitlementProduct}. */
export function isEntitlementProduct(value: unknown): value is EntitlementProduct {
  return typeof value === 'string' && (ENTITLEMENT_PRODUCTS as readonly string[]).includes(value);
}

/** Trạng thái entitlement của một staff+product — `revoked` là trạng thái cuối của entry hiện hành. */
export type EntitlementStatus = 'entitled' | 'revoked';

export const ENTITLEMENT_STATUSES = ['entitled', 'revoked'] as const;

/** Type guard cho {@link EntitlementStatus}. */
export function isEntitlementStatus(value: unknown): value is EntitlementStatus {
  return typeof value === 'string' && (ENTITLEMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Nhóm trường mà một entitlement entry **cấm** mang — ranh giới ADR-0009 cơ
 * giới hoá: read model chỉ tuyên bố tính khả dụng sản phẩm, không bao giờ
 * mang kết quả authorize cho một request, permission, role hay risk class.
 */
export const FORBIDDEN_ENTITLEMENT_FIELDS = [
  'verdict',
  'decision',
  'allow',
  'deny',
  'allowed',
  'denied',
  'permissions',
  'roles',
  'assignments',
  'scope',
  'risk_class',
  'authorization',
] as const;

/** Một entry read model entitlement. */
export interface StaffEntitlementEntry {
  /** Staff member — định danh của Staff Access directory (không phải `sub`; xem doc đầu file). */
  readonly staff_id: string;
  /** Sản phẩm nội bộ. */
  readonly product: EntitlementProduct;
  /**
   * Trạng thái hiện hành của entitlement: `entitled` = sản phẩm có sẵn dùng;
   * `revoked` = đã thu hồi. Thu hồi là trạng thái **ghi nhận**, không phải
   * xoá entry — consumer dùng nó để dừng serving (và audit còn truy vấn được).
   */
  readonly status: EntitlementStatus;
  /**
   * Số phiên tăng đơn điệu theo cặp `(staff_id, product)` — mọi lần thay đổi
   * trạng thái +1. Consumer idempotent: revision nhỏ hơn hoặc bằng revision
   * đã thấy là bản cũ/trùng → bỏ qua (compare-and-drop); revision lớn hơn →
   * áp dụng. Cơ chế truyền (queue/batch/pull) KHÔNG nằm trong contract này.
   */
  readonly revision: number;
  /** Thời điểm trạng thái này có hiệu lực — ISO 8601 có offset/Z. */
  readonly occurred_at: string;
}

/** Response đọc read model — một trang theo staff. */
export interface EntitlementReadResponse {
  readonly entitlements: readonly StaffEntitlementEntry[];
  /** `null` = hết dữ liệu. Không `total_count`. */
  readonly next_cursor: string | null;
}

/** Lý do từ chối một payload entitlement. */
export type EntitlementReadRejectionReason =
  | 'invalid_payload'
  | 'invalid_entry'
  | 'invalid_product'
  | 'invalid_status'
  | 'invalid_revision'
  | 'forbidden_field'
  | 'oversized_page';

/** Shape tổng quát của validation result trong lib này. */
export type EntitlementReadValidation<T> =
  | { readonly ok: true; readonly payload: T }
  | {
      readonly ok: false;
      readonly reason: EntitlementReadRejectionReason;
      readonly detail: string;
    };

/** Kết quả validate một entry. */
export type EntitlementEntryValidation = EntitlementReadValidation<StaffEntitlementEntry>;

/** Kết quả validate response read. */
export type EntitlementListValidation = EntitlementReadValidation<EntitlementReadResponse>;

const ENTITLEMENT_ENTRY_KEYS = [
  'staff_id',
  'product',
  'status',
  'revision',
  'occurred_at',
] as const;

/** Trần revision hợp lệ — guard số nguyên dương, không phải trần nghiệp vụ. */
export const ENTITLEMENT_MAX_REVISION = Number.MAX_SAFE_INTEGER;

/**
 * Kiểm tra một entry entitlement — cấm trường authorization (ADR-0009) trước,
 * rồi kiểm shape từng trường.
 *
 * ⚠️ Không nối **giá trị** trường bị cấm vào `detail`; chỉ nêu tên trường.
 */
export function validateEntitlementEntry(value: unknown): EntitlementEntryValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Entitlement entry must be an object.' };
  }
  const record = value as Record<string, unknown>;

  for (const field of FORBIDDEN_ENTITLEMENT_FIELDS) {
    if (field in record) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Entitlement entry carries a forbidden authorization field: ${field}.`,
      };
    }
  }

  const keys = Object.keys(record);
  for (const key of ENTITLEMENT_ENTRY_KEYS) {
    if (!keys.includes(key)) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: `Entitlement entry is missing required field: ${key}.`,
      };
    }
  }
  for (const key of keys) {
    if (!(ENTITLEMENT_ENTRY_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Entitlement entry carries a field outside the contract: ${key}.`,
      };
    }
  }

  if (typeof record.staff_id !== 'string' || record.staff_id.length === 0) {
    return {
      ok: false,
      reason: 'invalid_entry',
      detail: 'staff_id must be a non-empty string.',
    };
  }
  if (!isEntitlementProduct(record.product)) {
    return {
      ok: false,
      reason: 'invalid_product',
      detail: 'product is not a known internal product.',
    };
  }
  if (!isEntitlementStatus(record.status)) {
    return {
      ok: false,
      reason: 'invalid_status',
      detail: 'status must be "entitled" or "revoked".',
    };
  }
  if (
    typeof record.revision !== 'number' ||
    !Number.isInteger(record.revision) ||
    record.revision < 1 ||
    record.revision > ENTITLEMENT_MAX_REVISION
  ) {
    return {
      ok: false,
      reason: 'invalid_revision',
      detail: 'revision must be a positive integer.',
    };
  }
  if (
    typeof record.occurred_at !== 'string' ||
    record.occurred_at.length === 0 ||
    Number.isNaN(Date.parse(record.occurred_at))
  ) {
    return {
      ok: false,
      reason: 'invalid_entry',
      detail: 'occurred_at must be a parseable timestamp string.',
    };
  }

  return {
    ok: true,
    payload: {
      staff_id: record.staff_id,
      product: record.product,
      status: record.status,
      revision: record.revision,
      occurred_at: record.occurred_at,
    },
  };
}

/** Trần số entry một trang read. */
export const ENTITLEMENT_READ_MAX_PAGE = 200;

/** Validate response read — chặn trần trang trước từng entry. */
export function validateEntitlementReadResponse(payload: unknown): EntitlementListValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Response must be an object.' };
  }
  const record = payload as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== 'entitlements' && key !== 'next_cursor') {
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `Response contains a field outside the contract: ${key}.`,
      };
    }
  }

  if (!Array.isArray(record.entitlements)) {
    return { ok: false, reason: 'invalid_payload', detail: 'entitlements must be an array.' };
  }

  if (record.entitlements.length > ENTITLEMENT_READ_MAX_PAGE) {
    return {
      ok: false,
      reason: 'oversized_page',
      detail: `entitlements page exceeds the ceiling of ${ENTITLEMENT_READ_MAX_PAGE} entries.`,
    };
  }

  if (
    record.next_cursor !== null &&
    (typeof record.next_cursor !== 'string' || record.next_cursor.length === 0)
  ) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: 'next_cursor must be null or a non-empty string.',
    };
  }

  const entitlements: StaffEntitlementEntry[] = [];
  for (const entry of record.entitlements) {
    const result = validateEntitlementEntry(entry);
    if (!result.ok) {
      return result;
    }
    entitlements.push(result.payload);
  }

  return {
    ok: true,
    payload: { entitlements, next_cursor: record.next_cursor as string | null },
  };
}

/**
 * So revision cho consumer idempotent — compare-and-drop.
 *
 * Trả về bản nên áp dụng: `incoming` khi revision lớn hơn revision đã thấy,
 * `current` khi revision nhỏ hơn hoặc bằng (bản cũ hoặc trùng — qua lại thứ
 * tự là bình thường của kênh bất đồng bộ). Producer bảo đảm revision tăng
 * đơn điệu theo `(staff_id, product)`; hàm này không tự sinh revision.
 */
export function pickRevisionWinner(
  current: Pick<StaffEntitlementEntry, 'revision'>,
  incoming: Pick<StaffEntitlementEntry, 'revision'>,
): 'current' | 'incoming' {
  return incoming.revision > current.revision ? 'incoming' : 'current';
}

/** Dựng response read hợp lệ — một chỗ dựng duy nhất. */
export function entitlementReadResponse(
  entitlements: readonly StaffEntitlementEntry[],
  nextCursor: string | null,
): EntitlementReadResponse {
  return { entitlements, next_cursor: nextCursor };
}
