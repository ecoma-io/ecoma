/**
 * Environment repo — port `getOrCreateEnvironment` / `getAllEnvironments` /
 * `getEnvironment` từ upstream DO (SQLite → PG, thêm tenant_id).
 *
 * getOrCreateEnvironment giữ semantics upstream: tồn tại → update các field
 * được cung cấp; chưa có → INSERT. Race giữa hai request tạo cùng tên được
 * xử lý bằng ON CONFLICT DO NOTHING + re-select (default tenant pattern).
 */
import type { Pool } from 'pg';

export interface EnvironmentRecord {
  /** UUID của environment (PK `pact.environments.id`) — Pact CLI dùng làm handle. */
  uuid: string;
  name: string;
  displayName: string | null;
  production: boolean;
  createdAt: string;
}

interface EnvRow {
  id: string;
  name: string;
  display_name: string | null;
  production: boolean;
  created_at: Date;
}

export class PgEnvironmentRepo {
  constructor(private readonly pool: Pool) {}

  async getAllEnvironments(tenantId: string): Promise<EnvironmentRecord[]> {
    const { rows } = await this.pool.query<EnvRow>(
      `SELECT id, name, display_name, production, created_at
         FROM pact.environments
        WHERE tenant_id = $1
        ORDER BY created_at ASC, name ASC`,
      [tenantId],
    );
    return rows.map(toRecord);
  }

  async getEnvironment(tenantId: string, name: string): Promise<EnvironmentRecord | null> {
    const { rows } = await this.pool.query<EnvRow>(
      `SELECT id, name, display_name, production, created_at
         FROM pact.environments
        WHERE tenant_id = $1 AND name = $2`,
      [tenantId, name],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async getEnvironmentByUuid(tenantId: string, uuid: string): Promise<EnvironmentRecord | null> {
    const { rows } = await this.pool.query<EnvRow>(
      `SELECT id, name, display_name, production, created_at
         FROM pact.environments
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenantId, uuid],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async deleteEnvironment(tenantId: string, idOrName: string, byUuid: boolean): Promise<boolean> {
    const sql = byUuid
      ? `DELETE FROM pact.environments WHERE tenant_id = $1 AND id = $2::uuid`
      : `DELETE FROM pact.environments WHERE tenant_id = $1 AND name = $2`;
    const { rowCount } = await this.pool.query(sql, [tenantId, idOrName]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Tạo hoặc update — semantics upstream getOrCreateEnvironment. Trả về
   * (record, created).
   */
  async getOrCreate(
    tenantId: string,
    name: string,
    displayName?: string,
    production?: boolean,
  ): Promise<{ environment: EnvironmentRecord; created: boolean }> {
    // 1. Thử INSERT khi chưa có. ON CONFLICT DO NOTHING tránh race unique.
    const inserted = await this.pool.query<EnvRow>(
      `INSERT INTO pact.environments (tenant_id, name, display_name, production)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, name) DO NOTHING
       RETURNING id, name, display_name, production, created_at`,
      [tenantId, name, displayName ?? null, production ?? false],
    );
    if (inserted.rows[0]) {
      return { environment: toRecord(inserted.rows[0]), created: true };
    }

    // 2. Đã có → update các field được cung cấp (upstream: chỉ update khi
    // caller gửi ít nhất một field).
    if (displayName !== undefined || production !== undefined) {
      await this.pool.query(
        `UPDATE pact.environments
            SET display_name = COALESCE($3, display_name),
                production = COALESCE($4, production),
                updated_at = now()
          WHERE tenant_id = $1 AND name = $2`,
        [tenantId, name, displayName ?? null, production ?? null],
      );
    }

    const existing = await this.getEnvironment(tenantId, name);
    if (existing === null) {
      // ON CONFLICT hit nhưng select lại không thấy: đã bị xoá giữa hai bước
      // (không có DELETE route ở broker, nhưng defence-in-depth) — fail-closed.
      throw new Error(`environment ${name} disappeared between upsert steps`);
    }
    return { environment: existing, created: false };
  }
}

function toRecord(row: EnvRow): EnvironmentRecord {
  return {
    uuid: row.id,
    name: row.name,
    displayName: row.display_name,
    production: row.production,
    createdAt: row.created_at.toISOString(),
  };
}
