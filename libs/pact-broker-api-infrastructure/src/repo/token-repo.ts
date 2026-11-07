/**
 * Repo tra machine token — dùng bởi `requireMachineToken`.
 *
 * Lookup một query: JOIN tenants để lấy status trong cùng lần đọc, tránh
 * kiểm tra hai bước (token hợp lệ lúc tra, tenant bị suspend giữa chừng).
 */
import type { Pool } from 'pg';
import type { TokenLookupResult, TokenRepo } from '@ecoma-io/pact-broker-api-application';

/** Kết quả tra thô từ DB (snake_case). */
interface TokenRow {
  token_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_status: 'active' | 'suspended' | 'deleted';
  scopes: string;
  revoked_at: Date | null;
}

export class PgTokenRepo implements TokenRepo {
  constructor(private readonly pool: Pool) {}

  async findByTokenHash(tokenHash: string): Promise<TokenLookupResult | null> {
    const { rows } = await this.pool.query<TokenRow>(
      `SELECT t.id AS token_id,
              ten.id AS tenant_id,
              ten.name AS tenant_name,
              ten.status AS tenant_status,
              t.scopes,
              t.revoked_at
         FROM pact.machine_tokens t
         JOIN pact.tenants ten ON ten.id = t.tenant_id
        WHERE t.token_hash = $1
        LIMIT 1`,
      [tokenHash],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      tokenId: row.token_id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      tenantStatus: row.tenant_status,
      scopes: row.scopes.split(' ').filter((s) => s !== ''),
      revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
    };
  }
}

/**
 * Ghi audit event (append-only, bảng `pact.audit_events` với trigger chặn
 * UPDATE). Đường này KHÔNG BAO GIỜ nằm trên serving path của Pact protocol:
 * lỗi audit chỉ log chứ không fail request (observability không thành
 * dependency serving-path — bất biến §Non-negotiable). Shape khớp migration:
 * (tenant_id, actor_sub, actor_token_id, action, outcome, detail).
 */
export async function insertAuditEvent(
  client: import('pg').PoolClient,
  event: {
    tenantId: string | null;
    actorSub: string | null;
    actorTokenId: string | null;
    action: string;
    outcome: 'success' | 'failure';
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO pact.audit_events
       (tenant_id, actor_sub, actor_token_id, action, outcome, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      event.tenantId,
      event.actorSub,
      event.actorTokenId,
      event.action,
      event.outcome,
      JSON.stringify(event.detail ?? {}),
    ],
  );
}
