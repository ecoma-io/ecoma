import type { RemoteCacheQueryable } from './postgres';

/**
 * Repository cua bang `remote_cache.usage_counters` — bo dem su dung duong tinh
 * theo project (P4.3 MVP). Duong tinh co tai xay lai tu `cache_entries`.
 */

export interface UsageCounterRow {
  readonly id: string;
  readonly project_id: string;
  readonly storage_bytes_used: string;
  readonly entry_count: string;
  readonly updated_at: string;
}

/** Lay bo dem su dung cua mot project. NULL neu chua cau hinh. */
export async function getUsageCounterByProject(
  db: RemoteCacheQueryable,
  projectId: string,
): Promise<UsageCounterRow | null> {
  const rows = await db.unsafe<UsageCounterRow>(
    `SELECT id, project_id, storage_bytes_used, entry_count, updated_at
       FROM remote_cache.usage_counters
      WHERE project_id = $1
      FOR UPDATE`,
    [projectId],
  );
  return rows[0] ?? null;
}

/** Cap nhat bo dem su dung (upsert cong tien). storage_bytes_used / entry_count la
 *  gia tri delta cong vao bo dem hien tai, tranh last-write-wins khi nhieu caller
 *  ghi song sync. */
export async function upsertUsageCounter(
  db: RemoteCacheQueryable,
  entry: {
    readonly projectId: string;
    readonly storageBytesUsed: number;
    readonly entryCount: number;
  },
): Promise<void> {
  if (entry.storageBytesUsed < 0 || entry.entryCount < 0) {
    throw new Error('usage counter delta must be non-negative');
  }
  await db.unsafe(
    `INSERT INTO remote_cache.usage_counters (project_id, storage_bytes_used, entry_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id) DO UPDATE
       SET storage_bytes_used = usage_counters.storage_bytes_used + EXCLUDED.storage_bytes_used,
           entry_count = usage_counters.entry_count + EXCLUDED.entry_count,
           updated_at = now()`,
    [entry.projectId, entry.storageBytesUsed, entry.entryCount],
  );
}

/** Tai xay lai bo dem su dung tu cache_entries va cap nhat bang usage_counters.
 *  Tra ve gia tri tai xay lai. Dung cho xac thuc hoac repair toi bo.
 *  Toan bo chay trong mot cau lenh nguyen tu (INSERT ... SELECT ... ON CONFLICT).
 *  Khong su dung FOR UPDATE vi aggregate function khong duoc phep kieu FOR UPDATE
 *  trong PostgreSQL; ham nay chay o background/control plane, khong tren duong
 *  doc/ghi cac request nen khong can dong bo hang dong.
 *
 *  Luu y: storageBytesUsed tra ve kieu Number. Tong qua 9 PB
 *  (~Number.MAX_SAFE_INTEGER) se mat do chinh xac so nguyen. Canh bao cho cac
 *  caller su dung o quy mo lon. */
export async function rebuildUsageCounter(
  db: RemoteCacheQueryable,
  projectId: string,
): Promise<{
  storageBytesUsed: string;
  entryCount: string;
  storageBytesUsedRaw: string;
  entryCountRaw: string;
}> {
  const rows = await db.unsafe<{ total: string; count: string }>(
    `WITH agg AS (
       SELECT coalesce(sum(size_bytes)::text, '0') AS total, count(*)::text AS count
       FROM remote_cache.cache_entries
      WHERE project_id = $1
     ),
     upsert AS (
       INSERT INTO remote_cache.usage_counters (project_id, storage_bytes_used, entry_count, updated_at)
       SELECT $1, total::bigint, count::bigint, now() FROM agg
       ON CONFLICT (project_id) DO UPDATE
         SET storage_bytes_used = EXCLUDED.storage_bytes_used,
             entry_count = EXCLUDED.entry_count,
             updated_at = now()
     )
    SELECT total, count FROM agg`,
    [projectId],
  );
  const row = rows[0];
  const storageBytesUsedRaw = row?.total ?? '0';
  const entryCountRaw = row?.count ?? '0';

  return {
    storageBytesUsed: Number(storageBytesUsedRaw).toString(),
    entryCount: Number(entryCountRaw).toString(),
    storageBytesUsedRaw,
    entryCountRaw,
  };
}
