import type { RemoteCacheQueryable } from './postgres';

/**
 * Repository cua bang `remote_cache.projects` — project con cua tenant,
 * don vi cach ly cua data plane tuong lai (P4.2; ADR-0015).
 *
 * SQL la ban chep cua migration `apps/remote-cache/db/migrations/
 * 0001_control_plane.sql`; lech ten chi lo ra khi chay voi schema that.
 */

/** Mot hang project nhu schema tra ve. */
export interface ProjectRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Lay project theo id. */
export async function getProjectById(
  db: RemoteCacheQueryable,
  id: string,
): Promise<ProjectRow | null> {
  const rows = await db.unsafe<ProjectRow>(
    `SELECT id, tenant_id, name, created_at, updated_at
       FROM remote_cache.projects
      WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Lay project theo ten trong pham vi mot tenant — duong authorization
 * "key cua tenant X chi cham project cua tenant X" (R2).
 */
export async function getProjectByTenantAndName(
  db: RemoteCacheQueryable,
  tenantId: string,
  name: string,
): Promise<ProjectRow | null> {
  const rows = await db.unsafe<ProjectRow>(
    `SELECT id, tenant_id, name, created_at, updated_at
       FROM remote_cache.projects
      WHERE tenant_id = $1 AND name = $2`,
    [tenantId, name],
  );
  return rows[0] ?? null;
}

/**
 * Liệt kê project theo cursor keyset `(created_at, id)` trong pham vi mot
 * tenant — dung hinh phan trang cursor cua contract list
 * (`RemoteCacheProjectListResponse.next_cursor`). Khong listing khong gioi
 * han: `limit` do caller kiem (contract cap 100), repo khong tu cap.
 */
export async function listProjectsByTenant(
  db: RemoteCacheQueryable,
  options: {
    readonly tenantId: string;
    readonly limit: number;
    readonly cursor?: { readonly createdAt: string; readonly id: string };
  },
): Promise<readonly ProjectRow[]> {
  return db.unsafe<ProjectRow>(
    `SELECT id, tenant_id, name, created_at, updated_at
       FROM remote_cache.projects
      WHERE tenant_id = $1
        AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
      ORDER BY created_at, id
      LIMIT $4`,
    [
      options.tenantId,
      options.cursor?.createdAt ?? null,
      options.cursor?.id ?? null,
      options.limit,
    ],
  );
}

/**
 * Tao project — `id` do caller sinh; UNIQUE `(tenant_id, name)` o schema la
 * nguon that cua viec tu choi ten trung, repo khong pre-check (TOCTOU).
 */
export async function insertProject(
  db: RemoteCacheQueryable,
  entry: {
    readonly id: string;
    readonly tenantId: string;
    readonly name: string;
  },
): Promise<void> {
  await db.unsafe(
    `INSERT INTO remote_cache.projects (id, tenant_id, name)
     VALUES ($1, $2, $3)`,
    [entry.id, entry.tenantId, entry.name],
  );
}
