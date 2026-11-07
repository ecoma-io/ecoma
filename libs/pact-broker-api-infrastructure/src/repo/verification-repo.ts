/**
 * Verification repo — port `publishVerification` / `getVerificationById` từ
 * upstream DO, VỚI VÁ cross-tenant leak:
 *
 * Upstream `publishVerification` tra pact CHỈ theo content SHA toàn cục
 * (`getPactByContentSha(pactSha)` không biết tenant) — verification của
 * tenant B ghi được vào pact của tenant A nếu SHA trùng (content giống nhau
 * giữa hai tenant là chuyện bình thường với boilerplate pact). Repo này tra
 * pact theo (tenant, provider, consumer, sha); schema ghim bằng UNIQUE
 * (tenant_id, provider_id, consumer_id, content_sha) + composite FK của
 * verifications → pact. Tenant B không thấy pact của tenant A → 404.
 *
 * Verifications append-only: không UPDATE nào ở đây — mọi publish INSERT.
 */
import type { Pool, PoolClient } from 'pg';
import { PgVersionRepo } from './version-repo';

export interface VerificationRecord {
  id: string;
  success: boolean;
  buildUrl: string | null;
  verifiedAt: string;
}

interface VerificationInsertRow {
  id: string;
  success: boolean;
  build_url: string | null;
  verified_at: Date;
}

export class PgVerificationRepo {
  constructor(private readonly pool: Pool) {}

  private versionsFor(db: Pool | PoolClient): PgVersionRepo {
    return new PgVersionRepo(db);
  }

  /**
   * Publish verification cho (tenant, provider, consumer, sha). Trả null khi
   * pact không thuộc tenant — 404 route, KHÔNG 500.
   */
  async publishVerification(
    tenantId: string,
    providerName: string,
    consumerName: string,
    pactSha: string,
    providerVersion: string,
    success: boolean,
    buildUrl?: string,
  ): Promise<VerificationRecord | null> {
    return this.pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');

        // Pact theo 4 cột — khác upstream chỉ tra sha.
        const pact = await client.query<{ id: string }>(
          `SELECT p.id
             FROM pact.pacts p
             JOIN pact.versions cv ON cv.tenant_id = p.tenant_id AND cv.id = p.consumer_version_id
             JOIN pact.pacticipants pc ON pc.tenant_id = p.tenant_id AND pc.id = cv.pacticipant_id
             JOIN pact.pacticipants prov ON prov.tenant_id = p.tenant_id AND prov.id = p.provider_id
            WHERE p.tenant_id = $1
              AND p.content_sha = $2
              AND prov.name = $3
              AND pc.name = $4
            LIMIT 1`,
          [tenantId, pactSha, providerName, consumerName],
        );
        const pactRow = pact.rows[0];
        if (pactRow === undefined) {
          await client.query('ROLLBACK');
          return null;
        }

        // Get or create provider version (cùng tenant).
        await this.versionsFor(client).getOrCreateVersion(tenantId, providerName, providerVersion);
        const providerVersionId = await client.query<{ id: string }>(
          `SELECT v.id FROM pact.versions v
             JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
            WHERE v.tenant_id = $1 AND p.name = $2 AND v.number = $3`,
          [tenantId, providerName, providerVersion],
        );
        const pvid = providerVersionId.rows[0]?.id;
        if (pvid === undefined) {
          await client.query('ROLLBACK');
          return null;
        }

        const inserted = await client.query<VerificationInsertRow>(
          `INSERT INTO pact.verifications
             (tenant_id, pact_id, provider_version_id, success, verified_by, build_url)
           VALUES ($1, $2, $3, $4, 'pact-cli', $5)
           RETURNING id, success, build_url, verified_at`,
          [tenantId, pactRow.id, pvid, success, buildUrl ?? null],
        );
        await client.query('COMMIT');
        const row = inserted.rows[0];
        return {
          id: row.id,
          success: row.success,
          buildUrl: row.build_url,
          verifiedAt: row.verified_at.toISOString(),
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  /**
   * Verification theo uuid id + ghim tenant + khớp pact SHA + khớp
   * (provider, consumer) — ba điều kiện cùng thiếu một cái đều 404.
   */
  async getVerificationById(
    tenantId: string,
    id: string,
    pactSha: string,
  ): Promise<{
    verification: { success: boolean; buildUrl: string | null; verifiedAt: string; id: string };
    providerVersionNumber: string;
    pactContentSha: string;
  } | null> {
    const { rows } = await this.pool.query<{
      id: string;
      success: boolean;
      build_url: string | null;
      verified_at: Date;
      provider_version_number: string;
      pact_content_sha: string;
    }>(
      `SELECT ver.id, ver.success, ver.build_url, ver.verified_at,
              pv.number AS provider_version_number,
              p.content_sha AS pact_content_sha
         FROM pact.verifications ver
         JOIN pact.versions pv ON pv.tenant_id = ver.tenant_id AND pv.id = ver.provider_version_id
         JOIN pact.pacts p ON p.tenant_id = ver.tenant_id AND p.id = ver.pact_id
        WHERE ver.tenant_id = $1 AND ver.id = $2::uuid`,
      [tenantId, id],
    );
    const row = rows[0];
    if (row === undefined) return null;
    // SHA không khớp pact — 404 như upstream (route kiểm rồi).
    if (row.pact_content_sha !== pactSha) return null;
    return {
      verification: {
        id: row.id,
        success: row.success,
        buildUrl: row.build_url,
        verifiedAt: row.verified_at.toISOString(),
      },
      providerVersionNumber: row.provider_version_number,
      pactContentSha: row.pact_content_sha,
    };
  }
}
