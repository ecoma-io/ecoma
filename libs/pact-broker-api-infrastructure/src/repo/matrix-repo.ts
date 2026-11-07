/**
 * Matrix repo — port query semantics từ upstream
 * `PactBrokerDO.getMatrix` / `resolveProviderVersionForTarget` /
 * `getLatestVersionByTag` / `versionSummary` (SQLite drizzle → PostgreSQL).
 *
 * Bất biến giữ nguyên:
 *  * tie-break `created_at DESC, id DESC` ở MỌI truy vấn "latest" — độ phân
 *    giải giây của upstream là lý do gốc, và PG microsecond vẫn có thể tie
 *    trong cùng transaction (hai INSERT trong một publish).
 *  * target không resolve được được ghi `resolved: false` thay vì nhìn như
 *    một pact chưa verify; type khi không resolve là targetKind của caller
 *    (upstream: `resolved?.type ?? targetKind ?? "tag"`).
 *  * provider version báo cáo là version sinh ra verification; khi query
 *    narrow theo target mà target resolve, báo version của target dù nó
 *    chưa verify pact — hàng là về version đó (COALESCE dưới).
 *  * khi có target mà target không resolve: KHÔNG có verification nào được
 *    nhận (verification với provider version khác target không tính).
 *
 * Mọi query ghim `tenant_id` = tenant đã xác thực.
 */
import type { Pool } from 'pg';
import type { MatrixRowData, MatrixTarget } from '@ecoma-io/pact-broker-api-domain';

export interface MatrixQueryResult {
  rows: MatrixRowData[];
}

interface RawRow {
  consumer_version_id: string;
  consumer_name: string;
  consumer_version_number: string;
  consumer_version_branch: string | null;
  provider_name: string;
  provider_version_id: string | null;
  provider_version_number: string | null;
  provider_version_branch: string | null;
  target_type: string | null;
  target_resolved: boolean | null;
  pact_sha: string;
  pact_created_at: Date;
  verification_id: string | null;
  verification_success: boolean | null;
  verification_verified_at: Date | null;
}

export class PgMatrixRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * Matrix query — mọi pact mà `pacticipant` (tuỳ chọn ở `version`) là
   * consumer, một hàng mỗi pact, verification mới nhất (theo target nếu có).
   *
   * Một query duy nhất với LATERAL: resolve target (environment → tag →
   * branch, cùng thứ tự upstream) per provider, rồi chọn verification mới
   * nhất khớp target. `targetKind` chỉ là fallback type khi target không
   * resolve (route matrix truyền 'environment'/'tag' theo tên param, can-i-
   * deploy để NULL → 'tag' như upstream default).
   */
  async getMatrix(
    tenantId: string,
    pacticipantName: string,
    version?: string,
    to?: string,
    targetKind?: MatrixTarget['type'],
  ): Promise<MatrixQueryResult> {
    // Pacticipant không tồn tại → matrix rỗng (cùng semantics upstream).
    const pacticipantId = await this.pacticipantId(tenantId, pacticipantName);
    if (pacticipantId === null) {
      return { rows: [] };
    }

    const { rows: raw } = await this.pool.query<RawRow>(
      `WITH cp AS (
         SELECT p.id AS pact_id,
                p.content_sha,
                p.created_at AS pact_created_at,
                cv.id AS consumer_version_id,
                cv.number AS consumer_version_number,
                cv.branch AS consumer_version_branch,
                cv.pacticipant_id AS consumer_pacticipant_id,
                prov.id AS provider_id,
                prov.name AS provider_name
           FROM pact.pacts p
           JOIN pact.versions cv
             ON cv.tenant_id = p.tenant_id AND cv.id = p.consumer_version_id
           JOIN pact.pacticipants prov
             ON prov.tenant_id = p.tenant_id AND prov.id = p.provider_id
          WHERE p.tenant_id = $1
            AND cv.pacticipant_id = $2
            AND ($3::text IS NULL OR cv.number = $3)
       ),
       tgt AS (
         SELECT cp.pact_id, res.version_id AS target_version_id, res.target_type
           FROM cp
           CROSS JOIN LATERAL (
             (
               SELECT v.id AS version_id, 1 AS prio, 'environment'::text AS target_type
                 FROM pact.deployed_versions dv
                 JOIN pact.environments e
                   ON e.tenant_id = dv.tenant_id AND e.id = dv.environment_id
                 JOIN pact.versions v
                   ON v.tenant_id = dv.tenant_id AND v.id = dv.version_id
                WHERE dv.tenant_id = $1
                  AND v.pacticipant_id = cp.provider_id
                  AND e.name = $4
                  AND dv.undeployed_at IS NULL
                ORDER BY dv.deployed_at DESC, dv.id DESC
                LIMIT 1
             )
             UNION ALL
             (
               SELECT v.id, 2, 'tag'::text
                 FROM pact.versions v
                 JOIN pact.tags t ON t.tenant_id = v.tenant_id AND t.version_id = v.id
                WHERE v.tenant_id = $1
                  AND v.pacticipant_id = cp.provider_id
                  AND t.name = $4
                ORDER BY v.created_at DESC, v.id DESC
                LIMIT 1
             )
             UNION ALL
             (
               SELECT v.id, 3, 'branch'::text
                 FROM pact.versions v
                WHERE v.tenant_id = $1
                  AND v.pacticipant_id = cp.provider_id
                  AND v.branch = $4
                ORDER BY v.created_at DESC, v.id DESC
                LIMIT 1
             )
             ORDER BY prio
             LIMIT 1
           ) res
          WHERE $4::text IS NOT NULL
       ),
       best_ver AS (
         SELECT DISTINCT ON (cp.pact_id)
                cp.pact_id, ver.id AS verification_id, ver.provider_version_id
           FROM cp
           JOIN pact.verifications ver
             ON ver.tenant_id = $1 AND ver.pact_id = cp.pact_id
           LEFT JOIN tgt ON tgt.pact_id = cp.pact_id
          WHERE $4::text IS NULL
             OR (tgt.target_version_id IS NOT NULL
                 AND ver.provider_version_id = tgt.target_version_id)
          ORDER BY cp.pact_id, ver.verified_at DESC, ver.id DESC
       )
       SELECT cp.consumer_version_id,
              cons.name AS consumer_name,
              cp.consumer_version_number,
              cp.consumer_version_branch,
              cp.provider_name,
              pv.id AS provider_version_id,
              pv.number AS provider_version_number,
              pv.branch AS provider_version_branch,
              tgt.target_type,
              (tgt.target_version_id IS NOT NULL) AS target_resolved,
              cp.content_sha AS pact_sha,
              cp.pact_created_at,
              bv.verification_id,
              ver.success AS verification_success,
              ver.verified_at AS verification_verified_at
         FROM cp
         JOIN pact.pacticipants cons
           ON cons.tenant_id = $1 AND cons.id = cp.consumer_pacticipant_id
         LEFT JOIN tgt ON tgt.pact_id = cp.pact_id
         LEFT JOIN best_ver bv ON bv.pact_id = cp.pact_id
         LEFT JOIN pact.verifications ver ON ver.id = bv.verification_id
         LEFT JOIN pact.versions pv
           ON pv.id = COALESCE(ver.provider_version_id, tgt.target_version_id)
        ORDER BY cp.pact_created_at DESC, cp.pact_id DESC`,
      [tenantId, pacticipantId, version ?? null, to ?? null],
    );

    return { rows: await this.assemble(tenantId, raw, to, targetKind) };
  }

  private async pacticipantId(tenantId: string, name: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM pact.pacticipants WHERE tenant_id = $1 AND name = $2`,
      [tenantId, name],
    );
    return rows[0]?.id ?? null;
  }

  /** Gắn tags + shape MatrixRowData từ raw rows. */
  private async assemble(
    tenantId: string,
    raw: RawRow[],
    to: string | undefined,
    targetKind: MatrixTarget['type'] | undefined,
  ): Promise<MatrixRowData[]> {
    const versionIds = raw
      .flatMap((row) => [row.consumer_version_id, row.provider_version_id])
      .filter((id): id is string => id !== null);
    const tagsByVersion = await this.tagsForVersions(tenantId, [...new Set(versionIds)]);

    return raw.map((row) => {
      // Fallback type khi target không resolve — upstream
      // `resolved?.type ?? targetKind ?? "tag"`.
      const targetType =
        to === undefined
          ? undefined
          : ((row.target_type ?? targetKind ?? 'tag') as MatrixTarget['type']);
      return {
        consumer: {
          name: row.consumer_name,
          version: {
            number: row.consumer_version_number,
            branch: row.consumer_version_branch,
            tags: tagsByVersion.get(row.consumer_version_id) ?? [],
          },
        },
        provider: {
          name: row.provider_name,
          version:
            row.provider_version_number === null || row.provider_version_id === null
              ? null
              : {
                  number: row.provider_version_number,
                  branch: row.provider_version_branch,
                  tags: tagsByVersion.get(row.provider_version_id) ?? [],
                },
          ...(targetType !== undefined && to !== undefined
            ? { target: { type: targetType, value: to, resolved: row.target_resolved === true } }
            : {}),
        },
        pact: { sha: row.pact_sha, createdAt: row.pact_created_at.toISOString() },
        verification:
          row.verification_id !== null && row.verification_success !== null
            ? {
                id: row.verification_id,
                success: row.verification_success,
                verifiedAt: (row.verification_verified_at as Date).toISOString(),
              }
            : null,
      };
    });
  }

  /** Tag list của nhiều version — versionSummary upstream, một query. */
  private async tagsForVersions(
    tenantId: string,
    versionIds: string[],
  ): Promise<Map<string, string[]>> {
    if (versionIds.length === 0) return new Map();
    const { rows } = await this.pool.query<{ version_id: string; name: string }>(
      `SELECT version_id, name
         FROM pact.tags
        WHERE tenant_id = $1 AND version_id = ANY($2::uuid[])
        ORDER BY created_at ASC, id ASC`,
      [tenantId, versionIds],
    );
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.version_id) ?? [];
      list.push(row.name);
      map.set(row.version_id, list);
    }
    return map;
  }

  /**
   * can-i-deploy = getMatrix + summarize (cùng semantics upstream canIDeploy).
   * Caller (route) gọi summarizeMatrix — repo chỉ trả data, kèm
   * `consumerVersionExists` để route phân biệt "selector không khớp gì"
   * (matrix rỗng vì version/pacticipant không tồn tại) với "selector khớp
   * nhưng mọi pact đã pass" (matrix rỗng không thể xảy ra ở nhánh này vì
   * mỗi pact cho ra đúng một hàng).
   */
  /**
   * Kiểm tra selector có khớp version/pacticipant nào không — dùng cho
   * fail-closed empty override (DOM-02): phân biệt "selector không khớp gì"
   * với "version tồn tại nhưng không có pact".
   */
  async selectorExists(
    tenantId: string,
    pacticipantName: string,
    version?: string,
  ): Promise<boolean> {
    if (version) {
      const { rows } = await this.pool.query<{ found: number }>(
        `SELECT 1::int AS found
           FROM pact.versions v
           JOIN pact.pacticipants pc ON pc.tenant_id = v.tenant_id AND pc.id = v.pacticipant_id
          WHERE v.tenant_id = $1 AND pc.name = $2 AND v.number = $3
          LIMIT 1`,
        [tenantId, pacticipantName, version],
      );
      return rows.length > 0;
    }
    const { rows } = await this.pool.query<{ found: number }>(
      `SELECT 1::int AS found
         FROM pact.pacticipants
        WHERE tenant_id = $1 AND name = $2
        LIMIT 1`,
      [tenantId, pacticipantName],
    );
    return rows.length > 0;
  }

  async canIDeploy(
    tenantId: string,
    pacticipantName: string,
    version: string,
    to?: string,
    targetKind?: MatrixTarget['type'],
  ): Promise<MatrixQueryResult & { consumerVersionExists: boolean }> {
    const result = await this.getMatrix(tenantId, pacticipantName, version, to, targetKind);
    if (result.rows.length > 0) {
      return { ...result, consumerVersionExists: true };
    }
    const { rows } = await this.pool.query<{ found: number }>(
      `SELECT 1::int AS found
         FROM pact.versions v
         JOIN pact.pacticipants pc ON pc.tenant_id = v.tenant_id AND pc.id = v.pacticipant_id
        WHERE v.tenant_id = $1 AND pc.name = $2 AND v.number = $3
        LIMIT 1`,
      [tenantId, pacticipantName, version],
    );
    return { ...result, consumerVersionExists: rows.length > 0 };
  }
}
