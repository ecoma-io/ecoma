import type { RemoteCacheQueryable } from './postgres';

/**
 * Repository cua bang `remote_cache.quota_limits` — gioi han quota theo project
 * (P4.3 MVP). `max_storage_bytes` / `max_entry_count` cap writes; 0 khong han
 * che. Mot hang moi project.
 */

export interface QuotaLimitRow {
  readonly id: string;
  readonly project_id: string;
  readonly max_storage_bytes: string;
  readonly max_entry_count: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Lay gioi han quota cua mot project. NULL neu chua cau hinh. */
export async function getQuotaLimitByProject(
  db: RemoteCacheQueryable,
  projectId: string,
): Promise<QuotaLimitRow | null> {
  const rows = await db.unsafe<QuotaLimitRow>(
    `SELECT id, project_id, max_storage_bytes, max_entry_count, created_at, updated_at
       FROM remote_cache.quota_limits
      WHERE project_id = $1`,
    [projectId],
  );
  return rows[0] ?? null;
}

/** Tao hoac cap nhat gioi han quota cua mot project (upsert). */
export async function upsertQuotaLimit(
  db: RemoteCacheQueryable,
  entry: {
    readonly projectId: string;
    readonly maxStorageBytes: number;
    readonly maxEntryCount: number;
  },
): Promise<void> {
  if (entry.maxStorageBytes < 0 || entry.maxEntryCount < 0) {
    throw new Error('quota limit values must be non-negative');
  }
  await db.unsafe(
    `INSERT INTO remote_cache.quota_limits (project_id, max_storage_bytes, max_entry_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id) DO UPDATE
       SET max_storage_bytes = EXCLUDED.max_storage_bytes,
           max_entry_count = EXCLUDED.max_entry_count,
           updated_at = now()`,
    [entry.projectId, entry.maxStorageBytes, entry.maxEntryCount],
  );
}
