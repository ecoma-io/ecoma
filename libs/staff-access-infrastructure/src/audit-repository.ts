import type { StaffAccessQueryable } from './postgres';

/**
 * Repository của `staff_access.authorization_audit` — audit append-only
 * (SR-015 + invariant 12): repo chỉ expose **append** và **query**. Không có
 * hàm update/delete/truncate nào ở module này — schema chặn bằng hai lớp
 * (grant không cấp UPDATE/DELETE ở `0002`, trigger raising exception); thêm
 * một hàm ghi đè ở đây là tự mở đường che dấu vết (T-12).
 *
 * ⚠️ **Không token/secret/PII trong payload** (SR-014): entry giữ đúng bảy
 * nhóm trường SR-013 (actor, target, action, thời gian, kết quả, lý do,
 * request/correlation ID) và một `context` đã scrub do tầng application quyết.
 * CHECK top-level của schema là soft-check; scrubbing thật là việc tầng app.
 */

/** Tham số append một bản ghi audit — đúng bảy nhóm trường SR-013 + context scrubbed. */
export interface AppendAuditEntryInput {
  /** Actor theo staff id — NULL cho thao tác hệ thống (seed/bootstrap). */
  readonly actorStaffId?: string | null;
  /** Actor theo Account ID (`sub`) — đi kèm khi thao tác mang token staff. */
  readonly actorSub?: string | null;
  /** Target bị tác động — định danh tự do mà thao tác nhắm tới. */
  readonly target: string;
  /** Tên action của thao tác (không phải verdict). */
  readonly action: string;
  /** Kết quả — `success | failure | denied` (SR-018: deny cũng phải quan sát được). */
  readonly outcome: 'success' | 'failure' | 'denied';
  /** Lý do mã hoá — tùy chọn. */
  readonly reason?: string | null;
  /** Correlation ID xuyên service — privileged op thật luôn có (SR-013). */
  readonly correlationId?: string | null;
  /** Payload ngữ cảnh đã scrub — tầng application chịu trách nhiệm làm sạch. */
  readonly context?: Record<string, unknown>;
}

/**
 * Ghi một bản ghi audit. `id` và `occurred_at` do database sinh
 * (`gen_random_uuid()`/`now()` ở `0001`) — không nhận từ caller để hai giá
 * trị không bị desync giữa các đường ghi.
 */
export async function appendAuditEntry(
  db: StaffAccessQueryable,
  entry: AppendAuditEntryInput,
): Promise<void> {
  await db.unsafe(
    `INSERT INTO staff_access.authorization_audit
       (actor_staff_id, actor_sub, target, action, outcome, reason, correlation_id, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      entry.actorStaffId ?? null,
      entry.actorSub ?? null,
      entry.target,
      entry.action,
      entry.outcome,
      entry.reason ?? null,
      entry.correlationId ?? null,
      entry.context === undefined ? '{}' : JSON.stringify(entry.context),
    ],
  );
}

/** Một hàng audit như schema trả về — hình đọc ra cho query path. */
export interface AuditEntryRow {
  readonly id: string;
  readonly actor_staff_id: string | null;
  readonly actor_sub: string | null;
  readonly target: string;
  readonly action: string;
  readonly occurred_at: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly correlation_id: string | null;
  readonly context: Record<string, unknown>;
}

/** Tham số query audit — kết hợp AND, mọi tham số tùy chọn (khớp `AuditQueryRequest` của contracts). */
export interface AuditQueryFilters {
  readonly actorStaffId?: string;
  readonly actorSub?: string;
  readonly target?: string;
  readonly action?: string;
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
  readonly correlationId?: string;
}

/**
 * Query audit — chỉ theo các chỉ mục cho phép của contract (actor, target,
 * action, khung thời gian, correlation_id). Truy vấn theo nội dung `context`
 * **không có** ở đây: search full-text trên audit là oracle rò dữ liệu
 * (`management-audit-contract.ts` của contracts).
 */
export async function queryAuditEntries(
  db: StaffAccessQueryable,
  filters: AuditQueryFilters,
  options: {
    readonly limit: number;
    readonly cursor?: { readonly occurredAt: string; readonly id: string };
  },
): Promise<readonly AuditEntryRow[]> {
  return db.unsafe<AuditEntryRow>(
    `SELECT id, actor_staff_id, actor_sub, target, action, occurred_at,
            outcome, reason, correlation_id, context
       FROM staff_access.authorization_audit
      WHERE ($1::uuid IS NULL OR actor_staff_id = $1::uuid)
        AND ($2::text IS NULL OR actor_sub = $2::text)
        AND ($3::text IS NULL OR target = $3::text)
        AND ($4::text IS NULL OR action = $4::text)
        AND ($5::timestamptz IS NULL OR occurred_at >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR occurred_at <= $6::timestamptz)
        AND ($7::text IS NULL OR correlation_id = $7::text)
        AND ($8::timestamptz IS NULL OR (occurred_at, id) < ($8::timestamptz, $9::uuid))
      ORDER BY occurred_at DESC, id DESC
      LIMIT $10`,
    [
      filters.actorStaffId ?? null,
      filters.actorSub ?? null,
      filters.target ?? null,
      filters.action ?? null,
      filters.occurredFrom ?? null,
      filters.occurredTo ?? null,
      filters.correlationId ?? null,
      options.cursor?.occurredAt ?? null,
      options.cursor?.id ?? null,
      options.limit,
    ],
  );
}
