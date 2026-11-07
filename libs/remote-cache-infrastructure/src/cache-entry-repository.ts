import type { RemoteCacheQueryable } from './postgres';

/**
 * Repository cua bang `remote_cache.cache_entries` — metadata cua mot artifact
 * cache da luu tren object storage, pham vi project (P4.2 data plane).
 *
 * Moi thao tac loc theo `project_id` cua API key da xac thuc — day la chot
 * chan namespace isolation. Khong co duong nao resolve row ma khong co
 * `project_id` trong predicate.
 */

/** Mot hang cache entry nhu schema tra ve. */
export interface CacheEntryRow {
  readonly id: string;
  readonly project_id: string;
  readonly hash: string;
  readonly object_key: string;
  readonly size_bytes: string;
  readonly content_type: string | null;
  readonly created_at: string;
  readonly expires_at: string | null;
}

/** Lay entry theo project + hash — duong read-side. NULL khi miss. */
export async function getCacheEntryByProjectAndHash(
  db: RemoteCacheQueryable,
  projectId: string,
  hash: string,
): Promise<CacheEntryRow | null> {
  const rows = await db.unsafe<CacheEntryRow>(
    `SELECT id, project_id, hash, object_key, size_bytes, content_type, created_at, expires_at
       FROM remote_cache.cache_entries
      WHERE project_id = $1 AND hash = $2
        AND (expires_at IS NULL OR expires_at > now())`,
    [projectId, hash],
  );
  return rows[0] ?? null;
}

/** Danh sach entry cua mot project (danh cho test, khong nam tren serving path). */
export async function listCacheEntriesByProject(
  db: RemoteCacheQueryable,
  projectId: string,
): Promise<readonly CacheEntryRow[]> {
  return db.unsafe<CacheEntryRow>(
    `SELECT id, project_id, hash, object_key, size_bytes, content_type, created_at, expires_at
       FROM remote_cache.cache_entries
      WHERE project_id = $1
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at, id`,
    [projectId],
  );
}

/**
 * Chen mot entry moi hoac cap nhat expires_at neu entry da ton tai.
 * `ON CONFLICT DO UPDATE SET expires_at` cho phep gia han TTL khi re-PUT cung
 * hash (entry immutable nhung co the cap nhat thoi gian song con lai). Tra ve
 * `{ wasInsert: boolean }` de caller biet đây la insert moi hay cap nhat entry cu
 * (x5 dung de phan biet 'tao moi' -> 201 va 'da ton tai -> gia han TTL' -> 409).
 * Loi khac (vi pham CHECK, mat ket noi) van nem ra ngoai — khong duoc nuot.
 */
export async function insertCacheEntry(
  db: RemoteCacheQueryable,
  entry: {
    readonly projectId: string;
    readonly hash: string;
    readonly objectKey: string;
    readonly sizeBytes: number;
    readonly contentType: string | null;
    readonly expiresAt: string | null;
  },
): Promise<{ wasInsert: boolean }> {
  const result = await db.unsafe<{ was_insert: string }>(
    `WITH inserted AS (
       INSERT INTO remote_cache.cache_entries (project_id, hash, object_key, size_bytes, content_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, hash) DO UPDATE
         SET expires_at = EXCLUDED.expires_at
      RETURNING 1 AS one, xmax = 0 AS was_insert
     )
     SELECT bool_or(was_insert)::text AS was_insert FROM inserted`,
    [
      entry.projectId,
      entry.hash,
      entry.objectKey,
      entry.sizeBytes,
      entry.contentType,
      entry.expiresAt,
    ],
  );
  return { wasInsert: result[0]?.was_insert === 'true' };
}
