/**
 * Pact repo — port semantics từ upstream DO (`publishPact`, `getPact`,
 * `getLatestPact`, `getLatestPactsForProvider`, `getAllPactsForProvider`,
 * `getPactByContentShaFull`, `getPactsForVerification`) sang PostgreSQL.
 *
 * ⚠️ VÁ cross-tenant leak của upstream: `getPactByContentSha` tra pact CHỈ
 * theo content SHA toàn cục — verification của tenant B ghi được vào pact của
 * tenant A khi SHA trùng. Repo này tra theo (tenant, provider, consumer, sha)
 * và schema ghim bằng UNIQUE (tenant_id, provider_id, consumer_id,
 * content_sha) — xem docs/applications/pact-broker/01-architecture.md §3.
 *
 * Semantics giữ nguyên:
 *  * publishPact: content đổi → UPDATE (created=false), content giống →
 *    no-op (created=false), chưa có → INSERT (created=true).
 *  * latest: tie-break created_at DESC, id DESC.
 *  * for-verification: selector unconstrained = latest per consumer;
 *    constrained chọn từ TOÀN BỘ versions (không chỉ latest) rồi lấy mới
 *    nhất còn khớp per consumer.
 */
import { sha256Hex } from '@ecoma-io/pact-broker-api-application';
import type { Pool, PoolClient } from 'pg';
import { PgVersionRepo, type PacticipantRecord, type VersionRecord } from './version-repo';

export interface PactContent {
  consumer: { name: string };
  provider: { name: string };
  interactions: unknown[];
  metadata?: Record<string, unknown>;
}

export interface PactRecord {
  // JSONB từ `pg` về đã parse (object); chuỗi chỉ xuất hiện với fixture cũ.
  content: unknown;
  contentSha: string;
  createdAt: string;
}

export interface PactFull {
  pact: PactRecord;
  consumer: PacticipantRecord;
  provider: PacticipantRecord;
  version: VersionRecord;
}

export interface PactForVerificationResult extends PactFull {
  notices: string[];
}

export interface ConsumerVersionSelector {
  consumer?: string;
  tag?: string;
  branch?: string;
  mainBranch?: boolean;
  latest?: boolean;
  deployed?: boolean;
  environment?: string;
}

interface PactRow {
  content: unknown;
  content_sha: string;
  created_at: Date;
}

export class PgPactRepo {
  private readonly db: Pool | PoolClient;

  constructor(db: Pool | PoolClient) {
    this.db = db;
  }

  /**
   * Publish một pact. Trả (pact, created). Tenant ghim mọi bước qua
   * `getOrCreateVersion`/`getOrCreatePacticipant`.
   */
  /**
   * Publish một pact. Trả (pact, created). Tenant ghim mọi bước qua
   * `getOrCreateVersion`/`getOrCreatePacticipant`.
   *
   * Transaction-aware: nếu repo được khởi tạo với PoolClient (đang trong
   * transaction của caller), method KHÔNG tự BEGIN/COMMIT/ROLLBACK/release —
   * nó tham gia transaction hiện có. Nếu khởi tạo với Pool, method tự mở
   * transaction riêng (hành vi cũ, giữ backward-compat cho các route đơn lẻ).
   */
  async publishPact(
    tenantId: string,
    consumerName: string,
    consumerVersion: string,
    providerName: string,
    content: PactContent,
    branch?: string,
  ): Promise<{ pact: PactRecord; created: boolean }> {
    const db = this.db;
    const isClient = typeof (db as { release?: unknown }).release === 'function';
    if (isClient) {
      return this.publishPactOnClient(
        db as PoolClient,
        tenantId,
        consumerName,
        consumerVersion,
        providerName,
        content,
        branch,
      );
    }
    const client = await (db as Pool).connect();
    try {
      await client.query('BEGIN');
      const result = await this.publishPactOnClient(
        client,
        tenantId,
        consumerName,
        consumerVersion,
        providerName,
        content,
        branch,
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Core publish logic chạy trên một client đã có transaction (hoặc không). */
  private async publishPactOnClient(
    client: PoolClient,
    tenantId: string,
    consumerName: string,
    consumerVersion: string,
    providerName: string,
    content: PactContent,
    branch?: string,
  ): Promise<{ pact: PactRecord; created: boolean }> {
    const versions = new PgVersionRepo(client);

    // Consumer version (tự tạo pacticipant + version — backfill branch).
    await versions.getOrCreateVersion(tenantId, consumerName, consumerVersion, branch);
    await versions.getOrCreatePacticipant(tenantId, providerName);

    const contentStr = JSON.stringify(content);
    const contentSha = await sha256Hex(contentStr);

    const existing = await client.query<PactRow & { id: string }>(
      `SELECT p.id, p.content, p.content_sha, p.created_at
         FROM pact.pacts p
        WHERE p.tenant_id = $1
          AND p.consumer_version_id = (SELECT v.id FROM pact.versions v
                                         JOIN pact.pacticipants pc
                                           ON pc.tenant_id = v.tenant_id
                                          AND pc.id = v.pacticipant_id
                                       WHERE v.tenant_id = $1
                                         AND pc.name = $2 AND v.number = $3)
          AND p.provider_id = (SELECT id FROM pact.pacticipants
                               WHERE tenant_id = $1 AND name = $4)`,
      [tenantId, consumerName, consumerVersion, providerName],
    );

    const row = existing.rows[0];
    if (row !== undefined) {
      if (row.content_sha !== contentSha) {
        // Content đổi → UPDATE. Verifications cũ vẫn treo ở pact (FK),
        // đúng semantics upstream: verification gắn pact theo id.
        await client.query(`UPDATE pact.pacts SET content = $2, content_sha = $3 WHERE id = $1`, [
          row.id,
          contentStr,
          contentSha,
        ]);
      }
      return {
        pact: {
          content: contentStr,
          contentSha,
          createdAt: row.created_at.toISOString(),
        },
        created: false,
      };
    }

    const inserted = await client.query<PactRow & { id: string }>(
      `INSERT INTO pact.pacts
         (tenant_id, consumer_version_id, provider_id, consumer_id, content, content_sha)
       VALUES ($1,
               (SELECT v.id FROM pact.versions v
                  JOIN pact.pacticipants pc
                    ON pc.tenant_id = v.tenant_id AND pc.id = v.pacticipant_id
                 WHERE v.tenant_id = $1 AND pc.name = $2 AND v.number = $3),
               (SELECT id FROM pact.pacticipants WHERE tenant_id = $1 AND name = $4),
               (SELECT pc.id FROM pact.pacticipants pc
                  JOIN pact.versions v
                    ON v.tenant_id = pc.tenant_id AND v.pacticipant_id = pc.id
                 WHERE v.tenant_id = $1 AND pc.name = $2 AND v.number = $3),
               $5, $6)
       ON CONFLICT (tenant_id, consumer_version_id, provider_id) DO NOTHING
       RETURNING id, content, content_sha, created_at`,
      [tenantId, consumerName, consumerVersion, providerName, contentStr, contentSha],
    );

    if (inserted.rows[0]) {
      return {
        pact: {
          content: contentStr,
          contentSha: inserted.rows[0].content_sha,
          createdAt: inserted.rows[0].created_at.toISOString(),
        },
        created: true,
      };
    }

    // Race: bên khác INSERT trước — đọc lại, cùng created=false.
    const raced = await client.query<PactRow>(
      `SELECT p.content, p.content_sha, p.created_at
         FROM pact.pacts p
        WHERE p.tenant_id = $1
          AND p.consumer_version_id = (SELECT v.id FROM pact.versions v
                                         JOIN pact.pacticipants pc
                                           ON pc.tenant_id = v.tenant_id
                                          AND pc.id = v.pacticipant_id
                                       WHERE v.tenant_id = $1
                                         AND pc.name = $2 AND v.number = $3)
          AND p.provider_id = (SELECT id FROM pact.pacticipants
                               WHERE tenant_id = $1 AND name = $4)`,
      [tenantId, consumerName, consumerVersion, providerName],
    );
    if (raced.rows[0] === undefined) {
      throw new Error('pact disappeared between upsert steps');
    }
    return {
      pact: {
        content: raced.rows[0].content,
        contentSha: raced.rows[0].content_sha,
        createdAt: raced.rows[0].created_at.toISOString(),
      },
      created: false,
    };
  }

  async getPact(
    tenantId: string,
    providerName: string,
    consumerName: string,
    consumerVersion: string,
  ): Promise<PactFull | null> {
    const { rows } = await this.db.query<
      PactRow & { consumer_name: string; consumer_created: Date; provider_created: Date }
    >(
      `SELECT p.content, p.content_sha, p.created_at,
              pc.name AS consumer_name, pc.created_at AS consumer_created,
              prov.created_at AS provider_created
         FROM pact.pacts p
         JOIN pact.versions v ON v.tenant_id = p.tenant_id AND v.id = p.consumer_version_id
         JOIN pact.pacticipants pc ON pc.tenant_id = p.tenant_id AND pc.id = v.pacticipant_id
         JOIN pact.pacticipants prov ON prov.tenant_id = p.tenant_id AND prov.id = p.provider_id
         JOIN pact.pacticipants pprov ON pprov.tenant_id = p.tenant_id AND pprov.name = $3
        WHERE p.tenant_id = $1
          AND prov.name = $2
          AND pc.name = $3
          AND v.number = $4`,
      [tenantId, providerName, consumerName, consumerVersion],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      pact: toPact(row),
      consumer: { name: row.consumer_name, createdAt: row.consumer_created.toISOString() },
      provider: {
        name: providerName,
        createdAt: row.provider_created.toISOString(),
      },
      version: {
        number: consumerVersion,
        branch: null,
        buildUrl: null,
        createdAt: row.consumer_created.toISOString(),
      },
    };
  }

  /**
   * Pact theo content SHA — TRA THEO (tenant, provider, consumer, sha), vá
   * leak tra-sha-toàn-cục của upstream.
   */
  async getPactByContentShaFull(
    tenantId: string,
    providerName: string,
    consumerName: string,
    sha: string,
  ): Promise<PactFull | null> {
    const { rows } = await this.db.query<
      PactRow & {
        consumer_name: string;
        consumer_created: Date;
        provider_created: Date;
        version_number: string;
        version_branch: string | null;
        version_build_url: string | null;
      }
    >(
      `SELECT p.content, p.content_sha, p.created_at,
              pc.name AS consumer_name, pc.created_at AS consumer_created,
              prov.created_at AS provider_created,
              v.number AS version_number, v.branch AS version_branch,
              v.build_url AS version_build_url
         FROM pact.pacts p
         JOIN pact.versions v ON v.tenant_id = p.tenant_id AND v.id = p.consumer_version_id
         JOIN pact.pacticipants pc ON pc.tenant_id = p.tenant_id AND pc.id = v.pacticipant_id
         JOIN pact.pacticipants prov ON prov.tenant_id = p.tenant_id AND prov.id = p.provider_id
        WHERE p.tenant_id = $1
          AND prov.name = $2
          AND pc.name = $3
          AND p.content_sha = $4
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1`,
      [tenantId, providerName, consumerName, sha],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      pact: toPact(row),
      consumer: { name: row.consumer_name, createdAt: row.consumer_created.toISOString() },
      provider: { name: providerName, createdAt: row.provider_created.toISOString() },
      version: {
        number: row.version_number,
        branch: row.version_branch,
        buildUrl: row.version_build_url,
        createdAt: row.consumer_created.toISOString(),
      },
    };
  }

  async getLatestPact(
    tenantId: string,
    providerName: string,
    consumerName: string,
    tag?: string,
  ): Promise<PactFull | null> {
    if (tag !== undefined) {
      // Latest version của consumer gắn tag mà có pact với provider.
      const { rows } = await this.db.query<
        PactRow & {
          consumer_created: Date;
          provider_created: Date;
          version_number: string;
          version_branch: string | null;
          version_build_url: string | null;
        }
      >(
        `SELECT p.content, p.content_sha, p.created_at,
                pc.created_at AS consumer_created, prov.created_at AS provider_created,
                v.number AS version_number, v.branch AS version_branch,
                v.build_url AS version_build_url
           FROM pact.versions v
           JOIN pact.pacticipants pc ON pc.tenant_id = v.tenant_id AND pc.id = v.pacticipant_id
           JOIN pact.pacticipants prov ON prov.tenant_id = pc.tenant_id AND prov.name = $2
           JOIN pact.tags t ON t.tenant_id = v.tenant_id AND t.version_id = v.id
           JOIN pact.pacts p ON p.tenant_id = v.tenant_id
                AND p.consumer_version_id = v.id AND p.provider_id = prov.id
          WHERE v.tenant_id = $1 AND pc.name = $3 AND t.name = $4
          ORDER BY v.created_at DESC, v.id DESC
          LIMIT 1`,
        [tenantId, providerName, consumerName, tag],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        pact: toPact(row),
        consumer: { name: consumerName, createdAt: row.consumer_created.toISOString() },
        provider: { name: providerName, createdAt: row.provider_created.toISOString() },
        version: {
          number: row.version_number,
          branch: row.version_branch,
          buildUrl: row.version_build_url,
          createdAt: row.consumer_created.toISOString(),
        },
      };
    }

    // Không tag: latest version CÓ pact với provider.
    const { rows } = await this.db.query<
      PactRow & {
        consumer_created: Date;
        provider_created: Date;
        version_number: string;
        version_branch: string | null;
        version_build_url: string | null;
      }
    >(
      `SELECT p.content, p.content_sha, p.created_at,
              pc.created_at AS consumer_created, prov.created_at AS provider_created,
              v.number AS version_number, v.branch AS version_branch,
              v.build_url AS version_build_url
         FROM pact.versions v
         JOIN pact.pacticipants pc ON pc.tenant_id = v.tenant_id AND pc.id = v.pacticipant_id
         JOIN pact.pacticipants prov ON prov.tenant_id = pc.tenant_id AND prov.name = $2
         JOIN pact.pacts p ON p.tenant_id = v.tenant_id
              AND p.consumer_version_id = v.id AND p.provider_id = prov.id
        WHERE v.tenant_id = $1 AND pc.name = $3
        ORDER BY v.created_at DESC, v.id DESC
        LIMIT 1`,
      [tenantId, providerName, consumerName],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      pact: toPact(row),
      consumer: { name: consumerName, createdAt: row.consumer_created.toISOString() },
      provider: { name: providerName, createdAt: row.provider_created.toISOString() },
      version: {
        number: row.version_number,
        branch: row.version_branch,
        buildUrl: row.version_build_url,
        createdAt: row.consumer_created.toISOString(),
      },
    };
  }

  /**
   * Mỗi consumer MỘT hàng: latest pact với provider. DISTINCT ON
   * (consumer, provider) + ORDER created_at DESC, id DESC — tie-break giữ.
   */
  async getLatestPactsForProvider(tenantId: string, providerName: string): Promise<PactFull[]> {
    const { rows } = await this.db.query<
      PactRow & {
        consumer_name: string;
        consumer_created: Date;
        provider_created: Date;
        version_number: string;
        version_branch: string | null;
        version_build_url: string | null;
      }
    >(
      `SELECT DISTINCT ON (pc.name)
              p.content, p.content_sha, p.created_at,
              pc.name AS consumer_name, pc.created_at AS consumer_created,
              prov.created_at AS provider_created,
              v.number AS version_number, v.branch AS version_branch,
              v.build_url AS version_build_url
         FROM pact.pacts p
         JOIN pact.versions v ON v.tenant_id = p.tenant_id AND v.id = p.consumer_version_id
         JOIN pact.pacticipants pc ON pc.tenant_id = p.tenant_id AND pc.id = v.pacticipant_id
         JOIN pact.pacticipants prov ON prov.tenant_id = p.tenant_id AND prov.id = p.provider_id
        WHERE p.tenant_id = $1 AND prov.name = $2
        ORDER BY pc.name, v.created_at DESC, v.id DESC`,
      [tenantId, providerName],
    );
    return rows.map((row) => ({
      pact: toPact(row),
      consumer: { name: row.consumer_name, createdAt: row.consumer_created.toISOString() },
      provider: { name: providerName, createdAt: row.provider_created.toISOString() },
      version: {
        number: row.version_number,
        branch: row.version_branch,
        buildUrl: row.version_build_url,
        createdAt: row.consumer_created.toISOString(),
      },
    }));
  }

  /** Mọi pact của provider, mới nhất trước — getAllPactsForProvider upstream. */
  async getAllPactsForProvider(tenantId: string, providerName: string): Promise<PactFull[]> {
    const { rows } = await this.db.query<
      PactRow & {
        consumer_name: string;
        consumer_created: Date;
        provider_created: Date;
        version_number: string;
        version_branch: string | null;
        version_build_url: string | null;
      }
    >(
      `SELECT p.content, p.content_sha, p.created_at,
              pc.name AS consumer_name, pc.created_at AS consumer_created,
              prov.created_at AS provider_created,
              v.number AS version_number, v.branch AS version_branch,
              v.build_url AS version_build_url
         FROM pact.pacts p
         JOIN pact.versions v ON v.tenant_id = p.tenant_id AND v.id = p.consumer_version_id
         JOIN pact.pacticipants pc ON pc.tenant_id = p.tenant_id AND pc.id = v.pacticipant_id
         JOIN pact.pacticipants prov ON prov.tenant_id = p.tenant_id AND prov.id = p.provider_id
        WHERE p.tenant_id = $1 AND prov.name = $2
        ORDER BY v.created_at DESC, v.id DESC`,
      [tenantId, providerName],
    );
    return rows.map((row) => ({
      pact: toPact(row),
      consumer: { name: row.consumer_name, createdAt: row.consumer_created.toISOString() },
      provider: { name: providerName, createdAt: row.provider_created.toISOString() },
      version: {
        number: row.version_number,
        branch: row.version_branch,
        buildUrl: row.version_build_url,
        createdAt: row.consumer_created.toISOString(),
      },
    }));
  }

  /**
   * Pacts for verification — port selector semantics upstream getPactsForVerification:
   *  * selectors rỗng hoặc mọi selector đều unconstrained (chỉ latest=true)
   *    → latest pacts per consumer.
   *  * selector constrained (tag/branch/mainBranch/deployed) → chọn từ TOÀN
   *    BỘ versions có pact với provider, rồi lấy mới nhất còn khớp per
   *    consumer — KHÔNG lọc trên latest (consumer production không phải
   *    version mới nhất sẽ bị bỏ sót im lặng).
   *  * notices ghép theo thứ tự selector áp dụng; pact khớp nhiều selector
   *    gộp notices.
   */
  async getPactsForVerification(
    tenantId: string,
    providerName: string,
    selectors: ConsumerVersionSelector[],
  ): Promise<PactForVerificationResult[]> {
    const latest = await this.getLatestPactsForProvider(tenantId, providerName);

    if (!selectors || selectors.length === 0) {
      return latest.map((r) => ({
        ...r,
        notices: ['This pact is being verified because it is the latest pact'],
      }));
    }

    const allCandidates = await this.getAllPactsForProvider(tenantId, providerName);

    // Batch lookups cho tag/deployed: gom version id của mọi candidate (latest
    // + allCandidates) rồi tra tag/deployed bằng `= ANY($n::uuid[])` thay vì
    // gọi versions.getTagsForVersion / getPacticipant / isVersionDeployed trong
    // vòng selector×candidate (PERF-01/09).
    const candidatePacts = [...latest, ...allCandidates];
    const consumerNames = [...new Set(candidatePacts.map((r) => r.consumer.name))];

    const versionIdByKey = new Map<string, string>();
    if (consumerNames.length > 0) {
      const { rows } = await this.db.query<{ id: string; name: string; number: string }>(
        `SELECT v.id, p.name, v.number
           FROM pact.versions v
           JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
          WHERE v.tenant_id = $1 AND p.name = ANY($2::text[])`,
        [tenantId, consumerNames],
      );
      for (const row of rows) {
        versionIdByKey.set(`${row.name}::${row.number}`, row.id);
      }
    }

    const versionIds = [...new Set(versionIdByKey.values())];

    const tagsByVersionId = new Map<string, string[]>();
    if (versionIds.length > 0) {
      const { rows } = await this.db.query<{ version_id: string; name: string }>(
        `SELECT version_id, name
           FROM pact.tags
          WHERE tenant_id = $1 AND version_id = ANY($2::uuid[])`,
        [tenantId, versionIds],
      );
      for (const row of rows) {
        const list = tagsByVersionId.get(row.version_id) ?? [];
        list.push(row.name);
        tagsByVersionId.set(row.version_id, list);
      }
    }

    const deployedByVersionId = new Map<string, Set<string | null>>();
    if (versionIds.length > 0) {
      const { rows } = await this.db.query<{ version_id: string; environment: string | null }>(
        `SELECT v.id AS version_id, e.name AS environment
           FROM pact.deployed_versions dv
           JOIN pact.versions v ON v.tenant_id = dv.tenant_id AND v.id = dv.version_id
           JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
           LEFT JOIN pact.environments e ON e.tenant_id = dv.tenant_id AND e.id = dv.environment_id
          WHERE dv.tenant_id = $1
            AND dv.undeployed_at IS NULL
            AND v.id = ANY($2::uuid[])`,
        [tenantId, versionIds],
      );
      for (const row of rows) {
        const set = deployedByVersionId.get(row.version_id) ?? new Set<string | null>();
        set.add(row.environment);
        deployedByVersionId.set(row.version_id, set);
      }
    }

    const versionIdOf = (r: PactFull): string | undefined =>
      versionIdByKey.get(`${r.consumer.name}::${r.version.number}`);

    const matched = new Map<string, PactForVerificationResult>();

    for (const selector of selectors) {
      const notices: string[] = [];
      const constrained =
        Boolean(selector.tag) ||
        Boolean(selector.branch) ||
        Boolean(selector.mainBranch) ||
        Boolean(selector.deployed);

      let results: PactFull[] = constrained ? allCandidates : latest;

      if (selector.consumer) {
        results = results.filter((r) => r.consumer.name === selector.consumer);
        notices.push(`consumer is ${selector.consumer}`);
      }

      if (selector.tag) {
        const tag = selector.tag;
        results = results.filter((r) => {
          const vid = versionIdOf(r);
          if (vid === undefined) return false;
          const tags = tagsByVersionId.get(vid) ?? [];
          return tags.some((t) => t === tag);
        });
        notices.push(`version tagged with '${selector.tag}'`);
      }

      if (selector.branch) {
        results = results.filter((r) => r.version.branch === selector.branch);
        notices.push(`version is on branch '${selector.branch}'`);
      }

      if (selector.mainBranch) {
        // mainBranch comparison in-memory: default 'main', không tra DB.
        const mainBranch = 'main';
        results = results.filter((r) => r.version.branch === mainBranch);
        notices.push('version is on the main branch');
      }

      if (selector.deployed) {
        const environment = selector.environment;
        results = results.filter((r) => {
          const vid = versionIdOf(r);
          if (vid === undefined) return false;
          const envs = deployedByVersionId.get(vid);
          if (envs === undefined || envs.size === 0) return false;
          if (environment === undefined) return true;
          return envs.has(environment);
        });
        notices.push(
          selector.environment
            ? `version is deployed to '${selector.environment}'`
            : 'version is currently deployed',
        );
      }

      // Constrained vẫn nghĩa là "mới nhất còn khớp" — giữ version mới nhất
      // per consumer (candidates đã ORDER created_at DESC, id DESC).
      if (constrained) {
        const newestPerConsumer = new Map<string, PactFull>();
        for (const r of results) {
          if (!newestPerConsumer.has(r.consumer.name)) newestPerConsumer.set(r.consumer.name, r);
        }
        results = Array.from(newestPerConsumer.values());
      }

      if (selector.latest) {
        notices.push('it is the latest pact');
      }

      const selectorNotices =
        notices.length > 0 ? notices : ['it matches the consumer version selectors'];

      for (const r of results) {
        const existing = matched.get(r.pact.contentSha);
        if (existing !== undefined) {
          existing.notices = dedupeStrings([...existing.notices, ...notices]);
        } else {
          matched.set(r.pact.contentSha, {
            ...r,
            notices: dedupeStrings(selectorNotices),
          });
        }
      }
    }

    return Array.from(matched.values()).map((r) => ({
      ...r,
      notices: dedupeStrings(r.notices),
    }));
  }

  async isVersionDeployed(
    tenantId: string,
    pacticipantName: string,
    versionNumber: string,
    environmentName?: string,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ ok: boolean }>(
      `SELECT true AS ok
         FROM pact.deployed_versions dv
         JOIN pact.versions v ON v.tenant_id = dv.tenant_id AND v.id = dv.version_id
         JOIN pact.pacticipants p ON p.tenant_id = v.tenant_id AND p.id = v.pacticipant_id
         LEFT JOIN pact.environments e ON e.tenant_id = dv.tenant_id AND e.id = dv.environment_id
        WHERE dv.tenant_id = $1
          AND p.name = $2 AND v.number = $3
          AND dv.undeployed_at IS NULL
          AND ($4::text IS NULL OR e.name = $4)
        LIMIT 1`,
      [tenantId, pacticipantName, versionNumber, environmentName ?? null],
    );
    return rows.length > 0;
  }
}

/** Loại bỏ notice trùng nội dung, giữ thứ tự xuất hiện đầu tiên. */
function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function toPact(row: PactRow): PactRecord {
  return {
    content: row.content,
    contentSha: row.content_sha,
    createdAt: row.created_at.toISOString(),
  };
}
