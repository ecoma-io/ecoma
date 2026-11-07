/**
 * Management contract cho **authorization audit QUERY** — truy vấn read-only
 * bản ghi audit của Staff Access.
 *
 * Source of truth (docs/domains/staff-access/):
 * - `01-architecture.md` §4.6: authorization audit là bản ghi của một thao tác
 *   nhạy cảm quyền — actor, target, action, thời gian, kết quả, lý do,
 *   request/correlation ID; **append-only** và access-restricted; **không** chứa
 *   access token, auth secret hay PII.
 * - SR-013: mỗi privileged operation ghi audit đủ 7 trường; SR-014: audit
 *   không bao giờ chứa token/secret/password/PII; SR-015 + invariant 12:
 *   **append-only** — UPDATE/DELETE bị chặn.
 * - SR-018: quyết định deny cũng phải quan sát được như allow.
 *
 * ⚠️ **QUERY-ONLY.** Append xảy ra server-side nội bộ của Staff Access khi một
 * privileged operation diễn ra — contract này KHÔNG có request ghi. Để có
 * request append ở đây là mở đường ghi đè/che dấu vết đi qua wire, phá đúng
 * append-only mà SR-015 yêu cầu (T-12).
 *
 * ⚠️ Entry audit KHÔNG mang token/secret/PII — `FORBIDDEN_AUDIT_FIELDS` là hàng
 * phòng thủ thứ hai của SR-014 sau shape TypeScript; `FORBIDDEN_CONTEXT_KEY_…
 * (chính là FORBIDDEN_AUDIT_CONTEXT_KEYS)` chặn payload context lồng.
 *
 * Chỉ mục query cho phép: actor, target, action, khung thời gian,
 * correlation_id. Truy vấn theo nội dung payload (context) KHÔNG có — search
 * full-text trên audit là oracle rò dữ liệu.
 */

/** Trần số bản ghi tối đa một trang audit. */
export const AUDIT_LIST_MAX_LIMIT = 100;

/** Giá trị `limit` mặc định khi caller không truyền. */
export const AUDIT_LIST_DEFAULT_LIMIT = 50;

/** Kết quả của một thao tác nhạy cảm quyền — tập đóng, khớp migration 0001 (`outcome_check`). */
export type AuditOutcome = 'success' | 'failure' | 'denied';

export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const;

/** Type guard cho {@link AuditOutcome}. */
export function isAuditOutcome(value: unknown): value is AuditOutcome {
  return typeof value === 'string' && (AUDIT_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Nhóm trường mà một audit entry **cấm** mang — SR-014: token, secret,
 * password, và dữ liệu hồ sơ (PII) ngoài định danh staff. Hàng phòng thủ thứ
 * hai sau shape: validator chặn payload đã qua dây.
 */
export const FORBIDDEN_AUDIT_FIELDS = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'secret',
  'password',
  'authorization',
  'email',
  'display_name',
  'avatar_url',
  'profile',
  'mfa',
] as const;

/**
 * Key bị cấm trong payload `context` lồng — cùng rationale
 * `FORBIDDEN_AUDIT_FIELDS`, áp cho object lồng một tầng (CHECK của migration
 * 0001 là soft-check top-level; validator ở đây lặp đệ quy một tầng và đó
 * vẫn chỉ là hàng phòng thủ bổ sung, không thay thế app-layer scrubbing).
 */
export const FORBIDDEN_AUDIT_CONTEXT_KEYS = [
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'password',
  'authorization',
] as const;

/** Tham số query audit — mọi tham số tùy chọn, kết hợp AND. */
export interface AuditQueryRequest {
  /** Actor — staff id của người thực hiện thao tác. */
  readonly actor_staff_id?: string;
  /** Actor theo Account ID (`sub`) — cho truy vấn từ vết token. */
  readonly actor_sub?: string;
  /** Target bị tác động — định danh tự do mà thao tác nhắm tới (staff id, role id, ...). */
  readonly target?: string;
  /** Tên action của thao tác. */
  readonly action?: string;
  /** Đầu khung thời gian (inclusive) — ISO 8601 có offset/Z. */
  readonly occurred_from?: string;
  /** Cuối khung thời gian (inclusive) — ISO 8601 có offset/Z. */
  readonly occurred_to?: string;
  /** Correlation ID — lần vết một request xuyên service. */
  readonly correlation_id?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

/** Một entry audit trên wire. */
export interface AuditEntry {
  readonly id: string;
  /** Actor theo staff id — vắng khi thao tác hệ thống (seed/bootstrap). */
  readonly actor_staff_id?: string | null;
  /** Actor theo Account ID (`sub`) — đi kèm khi thao tác mang token staff. */
  readonly actor_sub?: string | null;
  /** Target bị tác động — định danh tự do mà thao tác nhắm tới. */
  readonly target: string;
  /** Tên action của thao tác (không phải verdict). */
  readonly action: string;
  /** Thời điểm xảy ra — ISO 8601. */
  readonly occurred_at: string;
  /** Kết quả — `success | failure | denied` (SR-018: deny cũng phải quan sát được). */
  readonly outcome: AuditOutcome;
  /** Lý do mã hoá (mã nguyên nhân đóng, ví dụ reason_code) — tùy chọn. */
  readonly reason?: string | null;
  /** Correlation ID xuyên service — tùy chọn nhưng privileged op thật luôn có (SR-013). */
  readonly correlation_id?: string | null;
  /**
   * Payload ngữ cảnh đã scrub — chỉ dữ liệu phi nhạy cảm, phi PII. Vắng mặc
   * định; validator lặp key lồng một tầng chặn key nhạy cảm.
   */
  readonly context?: Record<string, unknown>;
}

/** Response query audit — một trang. */
export interface AuditListResponse {
  readonly entries: readonly AuditEntry[];
  /** `null` = hết dữ liệu. Không `total_count`. */
  readonly next_cursor: string | null;
}

/** Lý do từ chối một payload audit. */
export type AuditContractRejectionReason =
  | 'invalid_payload'
  | 'invalid_entry'
  | 'forbidden_field'
  | 'forbidden_context_key'
  | 'invalid_outcome'
  | 'invalid_time_range'
  | 'oversized_page';

/** Shape tổng quát của validation result trong lib này. */
export type AuditContractValidation<T> =
  | { readonly ok: true; readonly payload: T }
  | { readonly ok: false; readonly reason: AuditContractRejectionReason; readonly detail: string };

/** Kết quả validate request query. */
export type AuditQueryValidation = AuditContractValidation<AuditQueryRequest>;

/** Kết quả validate response query. */
export type AuditListValidation = AuditContractValidation<AuditListResponse>;

const AUDIT_QUERY_KEYS = [
  'actor_staff_id',
  'actor_sub',
  'target',
  'action',
  'occurred_from',
  'occurred_to',
  'correlation_id',
  'limit',
  'cursor',
] as const;

const AUDIT_ENTRY_KEYS = [
  'id',
  'actor_staff_id',
  'actor_sub',
  'target',
  'action',
  'occurred_at',
  'outcome',
  'reason',
  'correlation_id',
  'context',
] as const;

/** Kiểm tra timestamp ISO 8601 hình thức (chuỗi, parse được, có múi giờ rõ). */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  return /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value);
}

/** Lặp key của object `context` một tầng, trả key bị cấm đầu tiên nếu có. */
function findForbiddenContextKey(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((FORBIDDEN_AUDIT_CONTEXT_KEYS as readonly string[]).includes(key)) {
      return key;
    }
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      for (const nestedKey of Object.keys(nested as Record<string, unknown>)) {
        if ((FORBIDDEN_AUDIT_CONTEXT_KEYS as readonly string[]).includes(nestedKey)) {
          return nestedKey;
        }
      }
    }
  }
  return null;
}

/**
 * Validate request query audit.
 *
 * Khung thời gian vô nghĩa (`occurred_to` trước `occurred_from`) bị chặn ở
 * validator — consumer không nên dựng query mà service chắc chắn trả rỗng.
 */
export function validateAuditQueryRequest(payload: unknown): AuditQueryValidation {
  if (payload === undefined || payload === null) {
    return { ok: true, payload: {} };
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Query must be an object.' };
  }
  const record = payload as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(AUDIT_QUERY_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Query carries a field outside the contract: ${key}.`,
      };
    }
  }

  for (const key of ['actor_staff_id', 'actor_sub', 'target', 'action', 'correlation_id']) {
    const value = record[key];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: `${key} must be a non-empty string when present.`,
      };
    }
  }

  for (const key of ['occurred_from', 'occurred_to']) {
    const value = record[key];
    if (value !== undefined && !isIsoTimestamp(value)) {
      return {
        ok: false,
        reason: 'invalid_time_range',
        detail: `${key} must be an ISO 8601 timestamp with an explicit offset or Z.`,
      };
    }
  }

  if (
    record.occurred_from !== undefined &&
    record.occurred_to !== undefined &&
    Date.parse(record.occurred_from as string) > Date.parse(record.occurred_to as string)
  ) {
    return {
      ok: false,
      reason: 'invalid_time_range',
      detail: 'occurred_to must not be before occurred_from.',
    };
  }

  if (
    record.limit !== undefined &&
    (typeof record.limit !== 'number' ||
      !Number.isInteger(record.limit) ||
      record.limit < 1 ||
      record.limit > AUDIT_LIST_MAX_LIMIT)
  ) {
    return {
      ok: false,
      reason: 'invalid_time_range',
      detail: `limit must be an integer in [1, ${AUDIT_LIST_MAX_LIMIT}].`,
    };
  }

  if (
    record.cursor !== undefined &&
    record.cursor !== null &&
    (typeof record.cursor !== 'string' || record.cursor.length === 0)
  ) {
    return {
      ok: false,
      reason: 'invalid_entry',
      detail: 'cursor must be null or a non-empty string.',
    };
  }

  return {
    ok: true,
    payload: { ...record } as AuditQueryRequest,
  };
}

/**
 * Validate một audit entry — cấm trường nhạy cảm (SR-014) trước, kiểm key
 * context lồng, rồi kiểm shape từng trường.
 *
 * ⚠️ Không nối **giá trị** trường bị cấm vào `detail`; chỉ nêu tên trường.
 */
export function validateAuditEntry(value: unknown): AuditContractValidation<AuditEntry> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Audit entry must be an object.' };
  }
  const record = value as Record<string, unknown>;

  for (const field of FORBIDDEN_AUDIT_FIELDS) {
    if (field in record) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Audit entry carries a forbidden field: ${field}.`,
      };
    }
  }

  for (const key of Object.keys(record)) {
    if (!(AUDIT_ENTRY_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Audit entry carries a field outside the contract: ${key}.`,
      };
    }
  }

  for (const key of ['id', 'target', 'action', 'occurred_at']) {
    if (!Object.keys(record).includes(key)) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: `Audit entry is missing required field: ${key}.`,
      };
    }
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    return { ok: false, reason: 'invalid_entry', detail: 'id must be a non-empty string.' };
  }
  if (typeof record.target !== 'string' || record.target.length === 0) {
    return { ok: false, reason: 'invalid_entry', detail: 'target must be a non-empty string.' };
  }
  if (typeof record.action !== 'string' || record.action.length === 0) {
    return { ok: false, reason: 'invalid_entry', detail: 'action must be a non-empty string.' };
  }
  if (!isIsoTimestamp(record.occurred_at)) {
    return {
      ok: false,
      reason: 'invalid_time_range',
      detail: 'occurred_at must be an ISO 8601 timestamp with an explicit offset or Z.',
    };
  }
  if (!isAuditOutcome(record.outcome)) {
    return {
      ok: false,
      reason: 'invalid_outcome',
      detail: 'outcome must be "success", "failure" or "denied".',
    };
  }

  if (record.context !== undefined) {
    if (
      typeof record.context !== 'object' ||
      record.context === null ||
      Array.isArray(record.context)
    ) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: 'context must be an object when present.',
      };
    }
    const bad = findForbiddenContextKey(record.context);
    if (bad !== null) {
      return {
        ok: false,
        reason: 'forbidden_context_key',
        detail: `Audit context carries a forbidden key: ${bad}.`,
      };
    }
  }

  for (const key of ['actor_staff_id', 'actor_sub', 'reason', 'correlation_id']) {
    const fieldValue = record[key];
    if (fieldValue === undefined || fieldValue === null) continue;
    if (typeof fieldValue !== 'string' || fieldValue.length === 0) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: `${key} must be a non-empty string or null when present.`,
      };
    }
  }

  return {
    ok: true,
    payload: {
      id: record.id,
      target: record.target,
      action: record.action,
      occurred_at: record.occurred_at,
      outcome: record.outcome,
      ...(record.actor_staff_id !== undefined
        ? { actor_staff_id: record.actor_staff_id as string | null }
        : {}),
      ...(record.actor_sub !== undefined ? { actor_sub: record.actor_sub as string | null } : {}),
      ...(record.reason !== undefined ? { reason: record.reason as string | null } : {}),
      ...(record.correlation_id !== undefined
        ? { correlation_id: record.correlation_id as string | null }
        : {}),
      ...(record.context !== undefined
        ? { context: record.context as Record<string, unknown> }
        : {}),
    },
  };
}

/** Validate response query audit. */
export function validateAuditListResponse(payload: unknown): AuditListValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Response must be an object.' };
  }
  const record = payload as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== 'entries' && key !== 'next_cursor') {
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `Response contains a field outside the contract: ${key}.`,
      };
    }
  }

  if (!Array.isArray(record.entries)) {
    return { ok: false, reason: 'invalid_payload', detail: 'entries must be an array.' };
  }

  if (record.entries.length > AUDIT_LIST_MAX_LIMIT) {
    return {
      ok: false,
      reason: 'oversized_page',
      detail: `audit page exceeds the ceiling of ${AUDIT_LIST_MAX_LIMIT} entries.`,
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

  const entries: AuditEntry[] = [];
  for (const entry of record.entries) {
    const result = validateAuditEntry(entry);
    if (!result.ok) {
      return result;
    }
    entries.push(result.payload);
  }

  return {
    ok: true,
    payload: { entries, next_cursor: record.next_cursor as string | null },
  };
}

/**
 * Dựng response query audit hợp lệ — một chỗ dựng duy nhất.
 */
export function auditListResponse(
  entries: readonly AuditEntry[],
  nextCursor: string | null,
): AuditListResponse {
  return { entries, next_cursor: nextCursor };
}
