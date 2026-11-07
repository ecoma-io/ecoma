import type { RemoteCacheQueryable } from './postgres';

/**
 * Repository cua bang `remote_cache.audit_log` — nhat ky su kien quota/retention
 * (P4.3 MVP). Append-only: chi INSERT, khong UPDATE/DELETE (R15).
 */

/** Han che cac gia tri hop lu cho cot `action` trong audit_log. */
export type AuditAction = 'cache_put' | 'quota_exceeded' | 'quota_limit_set' | 'retention_cleanup';

/** Han che cac gia tri hop lu cho cot `outcome` trong audit_log. */
export type AuditOutcome = 'allowed' | 'denied' | 'error';

export interface AuditLogRow {
  readonly id: string;
  readonly actor: string;
  readonly action: AuditAction;
  readonly target: string;
  readonly time: string;
  readonly outcome: AuditOutcome;
  readonly details: string | null;
  readonly project_id: string | null;
}

/** Them mot ghi nhat ky audit. Tra id cua hang moi. */
export async function insertAuditLog(
  db: RemoteCacheQueryable,
  entry: {
    readonly actor: string;
    readonly action: AuditAction;
    readonly target: string;
    readonly outcome: AuditOutcome;
    readonly details?: string | null;
    readonly projectId?: string | null;
  },
): Promise<string> {
  const rows = await db.unsafe<{ id: string }>(
    `INSERT INTO remote_cache.audit_log (actor, action, target, outcome, details, project_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      entry.actor,
      entry.action,
      entry.target,
      entry.outcome,
      entry.details ?? null,
      entry.projectId ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new Error('audit_log insert returned no id');
  }
  return id;
}
