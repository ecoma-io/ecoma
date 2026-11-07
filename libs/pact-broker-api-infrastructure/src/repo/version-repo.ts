/**
 * Pacticipant / version / tag / deployment repo — port semantics từ upstream
 * DO (`getOrCreatePacticipant`, `getOrCreateVersion`, `recordVersionBranch`,
 * `addTag`, `recordDeployment`, `recordUndeployment`) sang PostgreSQL.
 *
 * Semantics giữ nguyên từng method:
 *  * getOrCreateVersion: branch/build_url chỉ BACKFILL (điền thứ chưa biết),
 *    không overwrite — overwrite tường minh là việc của pb:branch-version PUT.
 *  * recordVersionBranch: overwrite tường minh branch; tạo version khi thiếu.
 *  * recordDeployment: idempotent với deployment đang chạy; hàng cũ đã
 *    undeploy thì INSERT hàng mới (re-record).
 *  * recordUndeployment: chỉ hàng đang chạy được đóng; không có → false.
 */
import type { Pool, PoolClient } from 'pg';

export interface PacticipantRecord {
  name: string;
  createdAt: string;
}

export interface VersionRecord {
  number: string;
  branch: string | null;
  buildUrl: string | null;
  createdAt: string;
}

export interface TagRecord {
  name: string;
  createdAt: string;
}

export interface DeploymentRecord {
  environment: string;
  deployedAt: string;
  undeployedAt: string | null;
}

interface PacticipantRow {
  name: string;
  created_at: Date;
}

interface VersionRow {
  number: string;
  branch: string | null;
  build_url: string | null;
  created_at: Date;
}

export class PgVersionRepo {
  private readonly db: Pool | PoolClient;
  constructor(db: Pool | PoolClient) {
    this.db = db;
  }

  async getAllPacticipants(tenantId: string): Promise<PacticipantRecord[]> {
    const { rows } = await this.db.query<PacticipantRow>(
      `SELECT name, created_at FROM pact.pacticipants
        WHERE tenant_id = $1 ORDER BY created_at ASC, id ASC`,
      [tenantId],
    );
    return rows.map((r) => ({ name: r.name, createdAt: r.created_at.toISOString() }));
  }

  async getPacticipant(tenantId: string, name: string): Promise<PacticipantRecord | null> {
    const { rows } = await this.db.query<PacticipantRow>(
      `SELECT name, created_at FROM pact.pacticipants WHERE tenant_id = $1 AND name = $2`,
      [tenantId, name],
    );
    return rows[0] ? { name: rows[0].name, createdAt: rows[0].created_at.toISOString() } : null;
  }

  /**
   * Tạo khi thiếu, race-safe: ON CONFLICT DO NOTHING rồi re-select. Hai
   * request publish cùng lúc tạo cùng pacticipant chỉ cho một INSERT thắng;
   * bên thua đọc hàng của bên thắng (default tenant pattern).
   */
  async getOrCreatePacticipant(tenantId: string, name: string): Promise<PacticipantRecord> {
    await this.db.query(
      `INSERT INTO pact.pacticipants (tenant_id, name)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [tenantId, name],
    );
    const existing = await this.getPacticipant(tenantId, name);
    if (existing === null) {
      throw new Error(`pacticipant ${name} disappeared between upsert steps`);
    }
    return existing;
  }

  async getVersion(
    tenantId: string,
    pacticipantName: string,
    versionNumber: string,
  ): Promise<VersionRecord | null> {
    const { rows } = await this.db.query<VersionRow>(
      `SELECT v.number, v.branch, v.build_url, v.created_at
         FROM pact.versions v
         JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
        WHERE v.tenant_id = $1 AND p.name = $2 AND v.number = $3`,
      [tenantId, pacticipantName, versionNumber],
    );
    return rows[0] ? toVersion(rows[0]) : null;
  }

  async getVersionsByPacticipant(
    tenantId: string,
    pacticipantName: string,
  ): Promise<VersionRecord[]> {
    const { rows } = await this.db.query<VersionRow>(
      `SELECT v.number, v.branch, v.build_url, v.created_at
         FROM pact.versions v
         JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
        WHERE v.tenant_id = $1 AND p.name = $2
        ORDER BY v.created_at DESC, v.id DESC`,
      [tenantId, pacticipantName],
    );
    return rows.map(toVersion);
  }

  /**
   * Tạo version khi thiếu; branch/build_url chỉ backfill — KHÔNG overwrite
   * giá trị đã có (semantics upstream getOrCreateVersion).
   */
  async getOrCreateVersion(
    tenantId: string,
    pacticipantName: string,
    versionNumber: string,
    branch?: string,
    buildUrl?: string,
  ): Promise<{ version: VersionRecord }> {
    await this.getOrCreatePacticipant(tenantId, pacticipantName);

    const existing = await this.db.query<VersionRow>(
      `SELECT v.number, v.branch, v.build_url, v.created_at
         FROM pact.versions v
         JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
        WHERE v.tenant_id = $1 AND p.name = $2 AND v.number = $3`,
      [tenantId, pacticipantName, versionNumber],
    );

    if (existing.rows[0]) {
      const row = existing.rows[0];
      // Backfill only.
      const backfillBranch = branch !== undefined && row.branch === null ? branch : null;
      const backfillBuildUrl = buildUrl !== undefined && row.build_url === null ? buildUrl : null;
      if (backfillBranch !== null || backfillBuildUrl !== null) {
        await this.db.query(
          `UPDATE pact.versions
              SET branch = COALESCE($2, branch),
                  build_url = COALESCE($3, build_url)
            WHERE tenant_id = $1 AND number = $4
              AND pacticipant_id = (SELECT id FROM pact.pacticipants WHERE tenant_id = $1 AND name = $5)`,
          [tenantId, backfillBranch, backfillBuildUrl, versionNumber, pacticipantName],
        );
        const updated = await this.getVersion(tenantId, pacticipantName, versionNumber);
        if (updated !== null) return { version: updated };
      }
      return { version: toVersion(row) };
    }

    const inserted = await this.db.query<VersionRow>(
      `INSERT INTO pact.versions (tenant_id, pacticipant_id, number, branch, build_url)
       VALUES ($1,
               (SELECT id FROM pact.pacticipants WHERE tenant_id = $1 AND name = $2),
               $3, $4, $5)
       ON CONFLICT (tenant_id, pacticipant_id, number) DO NOTHING
       RETURNING number, branch, build_url, created_at`,
      [tenantId, pacticipantName, versionNumber, branch ?? null, buildUrl ?? null],
    );

    if (inserted.rows[0]) {
      return { version: toVersion(inserted.rows[0]) };
    }
    // Race: bên khác đã INSERT giữa hai bước — đọc lại.
    const raced = await this.getVersion(tenantId, pacticipantName, versionNumber);
    if (raced === null) {
      throw new Error(
        `version ${versionNumber} of ${pacticipantName} disappeared between upsert steps`,
      );
    }
    return { version: raced };
  }

  /**
   * Overwrite tường minh branch (pb:branch-version PUT). Tạo version khi
   * thiếu — upstream recordVersionBranch cũng tự tạo.
   */
  async recordVersionBranch(
    tenantId: string,
    pacticipantName: string,
    versionNumber: string,
    branch: string,
  ): Promise<VersionRecord> {
    await this.getOrCreatePacticipant(tenantId, pacticipantName);

    const updated = await this.db.query<VersionRow>(
      `UPDATE pact.versions v
          SET branch = $4
         FROM pact.pacticipants p
        WHERE p.tenant_id = v.tenant_id
          AND p.id = v.pacticipant_id
          AND v.tenant_id = $1 AND p.name = $2 AND v.number = $3
       RETURNING v.number, v.branch, v.build_url, v.created_at`,
      [tenantId, pacticipantName, versionNumber, branch],
    );
    if (updated.rows[0]) {
      return toVersion(updated.rows[0]);
    }

    const { version } = await this.getOrCreateVersion(
      tenantId,
      pacticipantName,
      versionNumber,
      branch,
    );
    return version;
  }

  /** Ghi đè tường minh build_url (contracts/publish path). Thiếu version → null. */
  async recordVersionBuildUrl(
    tenantId: string,
    pacticipantName: string,
    versionNumber: string,
    buildUrl: string,
  ): Promise<VersionRecord | null> {
    const { rows } = await this.db.query<VersionRow>(
      `UPDATE pact.versions v
          SET build_url = $4
         FROM pact.pacticipants p
        WHERE p.tenant_id = v.tenant_id
          AND p.id = v.pacticipant_id
          AND v.tenant_id = $1 AND p.name = $2 AND v.number = $3
       RETURNING v.number, v.branch, v.build_url, v.created_at`,
      [tenantId, pacticipantName, versionNumber, buildUrl],
    );
    return rows[0] ? toVersion(rows[0]) : null;
  }

  // ============ tags ============
  async getTagsForVersion(
    tenantId: string,
    pacticipantName: string,
    versionNumber: string,
  ): Promise<TagRecord[]> {
    const { rows } = await this.db.query<{ name: string; created_at: Date }>(
      `SELECT t.name, t.created_at
         FROM pact.tags t
         JOIN pact.versions v ON v.tenant_id = t.tenant_id AND v.id = t.version_id
         JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
        WHERE t.tenant_id = $1 AND p.name = $2 AND v.number = $3
        ORDER BY t.created_at ASC, t.id ASC`,
      [tenantId, pacticipantName, versionNumber],
    );
    return rows.map((r) => ({ name: r.name, createdAt: r.created_at.toISOString() }));
  }

  async getTag(
    tenantId: string,
    pacticipantName: string,
    versionNumber: string,
    tagName: string,
  ): Promise<TagRecord | null> {
    const { rows } = await this.db.query<{ name: string; created_at: Date }>(
      `SELECT t.name, t.created_at
         FROM pact.tags t
         JOIN pact.versions v ON v.tenant_id = t.tenant_id AND v.id = t.version_id
         JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
        WHERE t.tenant_id = $1 AND p.name = $2 AND v.number = $3 AND t.name = $4`,
      [tenantId, pacticipantName, versionNumber, tagName],
    );
    return rows[0] ? { name: rows[0].name, createdAt: rows[0].created_at.toISOString() } : null;
  }

  async addTag(
    tenantId: string,
    pacticipantName: string,
    versionNumber: string,
    tagName: string,
  ): Promise<TagRecord | null> {
    const version = await this.getVersion(tenantId, pacticipantName, versionNumber);
    if (version === null) return null;

    const versionId = await this.db.query<{ id: string }>(
      `SELECT v.id FROM pact.versions v
         JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
        WHERE v.tenant_id = $1 AND p.name = $2 AND v.number = $3`,
      [tenantId, pacticipantName, versionNumber],
    );
    const vid = versionId.rows[0]?.id;
    if (vid === undefined) return null;

    await this.db.query(
      `INSERT INTO pact.tags (tenant_id, version_id, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, version_id, name) DO NOTHING`,
      [tenantId, vid, tagName],
    );
    return this.getTag(tenantId, pacticipantName, versionNumber, tagName);
  }

  // ============ deployments ============

  /**
   * Idempotent record: deployment đang chạy cùng (version, env) → trả hàng cũ;
   * hàng cũ đã undeploy → INSERT hàng mới (partial unique index chỉ chặn hai
   * hàng đang chạy).
   */
  async recordDeployment(
    tenantId: string,
    pacticipantName: string,
    versionNumber: string,
    environmentName: string,
  ): Promise<DeploymentRecord | null> {
    const db = this.db;
    const isClient = typeof (db as { release?: unknown }).release === 'function';
    const client: PoolClient = isClient ? (db as PoolClient) : await (db as Pool).connect();
    const ownsTx = !isClient;
    try {
      if (ownsTx) await client.query('BEGIN');
      const version = await this.getVersion(tenantId, pacticipantName, versionNumber);
      if (version === null) {
        if (ownsTx) await client.query('ROLLBACK');
        return null;
      }
      // Environment tự tạo khi thiếu (upstream recordDeployment gọi
      // getOrCreateEnvironment).
      const env = await new PgEnvironmentRepoForClient(client).getOrCreate(
        tenantId,
        environmentName,
      );

      const existing = await client.query<{ deployed_at: Date }>(
        `SELECT dv.deployed_at
             FROM pact.deployed_versions dv
             JOIN pact.environments e ON e.tenant_id = dv.tenant_id AND e.id = dv.environment_id
            WHERE dv.tenant_id = $1 AND dv.version_id = $2 AND e.name = $3
              AND dv.undeployed_at IS NULL`,
        [
          tenantId,
          await versionIdFor(client, tenantId, pacticipantName, versionNumber),
          env.environment.name,
        ],
      );
      if (existing.rows[0]) {
        if (ownsTx) await client.query('COMMIT');
        return {
          environment: env.environment.name,
          deployedAt: existing.rows[0].deployed_at.toISOString(),
          undeployedAt: null,
        };
      }

      const inserted = await client.query<{ deployed_at: Date }>(
        `INSERT INTO pact.deployed_versions (tenant_id, version_id, environment_id)
           VALUES ($1, $2,
                   (SELECT id FROM pact.environments WHERE tenant_id = $1 AND name = $3))
           RETURNING deployed_at`,
        [
          tenantId,
          await versionIdFor(client, tenantId, pacticipantName, versionNumber),
          env.environment.name,
        ],
      );
      if (ownsTx) await client.query('COMMIT');
      return {
        environment: env.environment.name,
        deployedAt: inserted.rows[0].deployed_at.toISOString(),
        undeployedAt: null,
      };
    } catch (error) {
      if (ownsTx) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if (ownsTx) client.release();
    }
  }

  /** Đóng hàng đang chạy; không có → null. */
  async recordUndeployment(
    tenantId: string,
    pacticipantName: string,
    versionNumber: string,
    environmentName: string,
  ): Promise<DeploymentRecord | null> {
    const { rows } = await this.db.query<{ deployed_at: Date; undeployed_at: Date }>(
      `UPDATE pact.deployed_versions dv
          SET undeployed_at = now()
        WHERE dv.id IN (
          SELECT dv2.id
            FROM pact.deployed_versions dv2
            JOIN pact.versions v ON v.tenant_id = dv2.tenant_id AND v.id = dv2.version_id
            JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
            JOIN pact.environments e ON e.tenant_id = dv2.tenant_id AND e.id = dv2.environment_id
           WHERE dv2.tenant_id = $1
             AND p.name = $2 AND v.number = $3 AND e.name = $4
             AND dv2.undeployed_at IS NULL
        )
       RETURNING dv.deployed_at, dv.undeployed_at`,
      [tenantId, pacticipantName, versionNumber, environmentName],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      environment: environmentName,
      deployedAt: row.deployed_at.toISOString(),
      undeployedAt: row.undeployed_at.toISOString(),
    };
  }

  async getDeploymentsForVersion(
    tenantId: string,
    pacticipantName: string,
    versionNumber: string,
  ): Promise<DeploymentRecord[]> {
    const { rows } = await this.db.query<{
      environment: string;
      deployed_at: Date;
      undeployed_at: Date | null;
    }>(
      `SELECT e.name AS environment, dv.deployed_at, dv.undeployed_at
         FROM pact.deployed_versions dv
         JOIN pact.versions v ON v.tenant_id = dv.tenant_id AND v.id = dv.version_id
         JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
         JOIN pact.environments e ON e.tenant_id = dv.tenant_id AND e.id = dv.environment_id
        WHERE dv.tenant_id = $1 AND p.name = $2 AND v.number = $3
        ORDER BY dv.deployed_at DESC, dv.id DESC`,
      [tenantId, pacticipantName, versionNumber],
    );
    return rows.map((r) => ({
      environment: r.environment,
      deployedAt: r.deployed_at.toISOString(),
      undeployedAt: r.undeployed_at === null ? null : r.undeployed_at.toISOString(),
    }));
  }
}

/** EnvironmentRepo variant dùng client có sẵn (transaction). */
class PgEnvironmentRepoForClient {
  constructor(private readonly client: import('pg').PoolClient) {}

  async getOrCreate(tenantId: string, name: string): Promise<{ environment: { name: string } }> {
    await this.client.query(
      `INSERT INTO pact.environments (tenant_id, name)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [tenantId, name],
    );
    return { environment: { name } };
  }
}

async function versionIdFor(
  client: import('pg').PoolClient,
  tenantId: string,
  pacticipantName: string,
  versionNumber: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT v.id FROM pact.versions v
       JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
      WHERE v.tenant_id = $1 AND p.name = $2 AND v.number = $3`,
    [tenantId, pacticipantName, versionNumber],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('version id not found');
  return id;
}

function toVersion(row: VersionRow): VersionRecord {
  return {
    number: row.number,
    branch: row.branch,
    buildUrl: row.build_url,
    createdAt: row.created_at.toISOString(),
  };
}
