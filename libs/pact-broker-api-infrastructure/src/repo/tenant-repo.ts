/**
 * Tenant repo — ensureDefaultTenant race-safe + membership/RBAC + machine
 * token management (Phase 2).
 *
 * ensureDefaultTenant — 4 bước (docs/applications/pact-broker/01-architecture.md
 * §4): INSERT ON CONFLICT DO NOTHING RETURNING → select lại nếu RETURNING
 * rỗng → fail-closed nếu tenant ở trạng thái deleted/suspended → DO NOTHING
 * cho membership owner. Race giữa hai bootstrap đồng thời chỉ cho một INSERT
 * thắng; bên thua đọc hàng của bên thắng.
 *
 * Token: 32 byte entropy, base64url; chỉ hash SHA-256 nằm DB. Token bản rõ
 * trả đúng MỘT lần lúc tạo (show-once); revoke = set revoked_at, hiệu lực tức
 * thời vì mọi request tra hash rồi check.
 */
import type { Pool } from 'pg';
import { randomToken, sha256Hex } from '@ecoma-io/pact-broker-api-application';
import { isOpaqueId, MAX_OPAQUE_ID_LENGTH } from '@ecoma-io/tenant-kernel-domain';

export interface TenantRecord {
  id: string;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
}

export interface MachineTokenRecord {
  id: string;
  tenantId: string;
  name: string;
  scopes: string;
  createdAt: string;
  revokedAt: string | null;
}

export class PactBrokerTenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PactBrokerTenantError';
  }
}

export class PgTenantRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * Guard `owner_sub` của `ensureDefaultTenant` (đường tạo tenant customer):
   * fail-closed qua isOpaqueId trước khi chạm database, cùng một thông báo lỗi
   * cho mọi đường ghi owner. Ném `PactBrokerTenantError`.
   */
  private validateOwnerSub(ownerSub: string): void {
    if (!isOpaqueId(ownerSub)) {
      throw new PactBrokerTenantError(
        `owner_sub is required and must be a non-empty opaque id of at most ${MAX_OPAQUE_ID_LENGTH} characters`,
      );
    }
  }

  /**
   * Bảo đảm tenant customer `name` tồn tại ACTIVE và `ownerSub` là owner.
   * Idempotent, race-safe. Đây là đường tạo tenant customer duy nhất của
   * service: INSERT ghi `classification = 'customer'`, `plan = 'free'` tường
   * minh (migration 0004 bắt classification NOT NULL và plan chỉ tồn tại khi
   * classification là customer — không bao giờ dựa vào default ngầm). Ném
   * `PactBrokerTenantError` khi tenant tồn tại ở trạng thái deleted (fail-closed
   * — không tự sửa dữ liệu đã xoá mềm).
   */
  async ensureDefaultTenant(name: string, ownerSub: string): Promise<TenantRecord> {
    this.validateOwnerSub(ownerSub);
    return this.pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');

        // Bước 1: thử INSERT. RETURNING rỗng = đã có (kể cả do race).
        const inserted = await client.query<{
          id: string;
          name: string;
          status: string;
        }>(
          `INSERT INTO pact.tenants (name, classification, plan, owner_sub)
           VALUES ($1, 'customer', 'free', $2)
           ON CONFLICT (name) DO NOTHING
           RETURNING id, name, status`,
          [name, ownerSub],
        );

        let tenant: { id: string; name: string; status: string };
        if (inserted.rows[0]) {
          tenant = inserted.rows[0];
        } else {
          // Bước 2: select lại hàng của bên thắng race.
          const existing = await client.query<{
            id: string;
            name: string;
            status: string;
          }>(`SELECT id, name, status FROM pact.tenants WHERE name = $1`, [name]);
          if (existing.rows[0] === undefined) {
            throw new PactBrokerTenantError(`tenant ${name} vanished during bootstrap`);
          }
          tenant = existing.rows[0];
        }

        // Bước 3: fail-closed nếu tenant đã xoá/tạm dừng — bootstrap không
        // được âm thầm hồi sinh tenant đã xoá mềm.
        if (tenant.status !== 'active') {
          throw new PactBrokerTenantError(
            `tenant ${name} is ${tenant.status}; refusing to bootstrap`,
          );
        }

        // Bước 4: membership ở vai trò thấp nhất ('member') — chủ sở hữu tenant
        // được lưu trên hàng tenant qua owner_sub, KHÔNG là vai trò membership.
        // DO NOTHING nếu đã có (không đổi role thành viên hiện có).
        await client.query(
          `INSERT INTO pact.tenant_members (tenant_id, sub, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (tenant_id, sub) DO NOTHING`,
          [tenant.id, ownerSub],
        );

        await client.query('COMMIT');
        return tenant as TenantRecord;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async getTenantByName(name: string): Promise<TenantRecord | null> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      status: 'active' | 'suspended' | 'deleted';
    }>(`SELECT id, name, status FROM pact.tenants WHERE name = $1`, [name]);
    return rows[0] ?? null;
  }

  /** Upsert membership `(tenant_id, sub, role)` — DO NOTHING nếu đã có. Provenance entitlement ghi kèm khi có. */
  async upsertMember(
    tenantId: string,
    sub: string,
    role: string,
    provenance?: {
      readonly eventId: string;
      readonly revision: number;
      readonly source: 'entitlement' | 'bootstrap' | 'admin';
    },
  ): Promise<void> {
    // Entitlement-sourced grant restores a previously revoked membership when a
    // higher revision arrives; customer/admin-managed memberships are untouched.
    await this.pool.query(
      `INSERT INTO pact.tenant_members (tenant_id, sub, role, staff_id, entitlement_event_id, entitlement_revision, source, entitlement_revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
       ON CONFLICT (tenant_id, sub) DO UPDATE SET
         role = EXCLUDED.role,
         entitlement_event_id = EXCLUDED.entitlement_event_id,
         entitlement_revision = EXCLUDED.entitlement_revision,
         entitlement_revoked_at = NULL
       WHERE pact.tenant_members.source = 'entitlement'
         AND (pact.tenant_members.entitlement_revision IS NULL
              OR pact.tenant_members.entitlement_revision < EXCLUDED.entitlement_revision)`,
      [
        tenantId,
        sub,
        role,
        provenance ? sub : null,
        provenance?.eventId ?? null,
        provenance?.revision ?? null,
        provenance?.source ?? null,
      ],
    );
  }

  /** Đánh dấu projection entitlement revoked trên membership đã confluent. Không xóa row, không đổi role. Chỉ áp dụng cho source='entitlement'. */
  async markEntitlementRevoked(
    tenantId: string,
    sub: string,
    eventId: string,
    revision: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE pact.tenant_members
          SET entitlement_revoked_at = now(),
              entitlement_event_id = $3::uuid,
              entitlement_revision = $4
        WHERE tenant_id = $1 AND sub = $2 AND source = 'entitlement'
          AND (entitlement_revision IS NULL OR entitlement_revision < $4)`,
      [tenantId, sub, eventId, revision],
    );
  }

  /** Role hiệu lực của sub trong tenant; null khi không là member hoặc entitlement
   *  đã revoke. Customer/admin-managed membership (source != 'entitlement')
   *  không bị ảnh hưởng bởi entitlement_revoked_at. */
  async getMemberRole(tenantId: string, sub: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ role: string }>(
      `SELECT role FROM pact.tenant_members
        WHERE tenant_id = $1 AND sub = $2
          AND (source IS DISTINCT FROM 'entitlement' OR entitlement_revoked_at IS NULL)`,
      [tenantId, sub],
    );
    return rows[0]?.role ?? null;
  }

  // ============ machine tokens ============

  /**
   * Tạo token mới. Trả bản rõ ĐÚNG MỘT LẦN — chỉ hash nằm DB. Caller chịu
   * trách nhiệm không log giá trị này.
   */
  async createMachineToken(
    tenantId: string,
    actorSub: string | null,
    name: string,
    scopes: string[],
  ): Promise<{ token: string; record: MachineTokenRecord }> {
    // 32 byte entropy = 192 bit, base64url không padding.
    const raw = randomToken();
    const tokenHash = await sha256Hex(raw);

    const { rows } = await this.pool.query<{
      id: string;
      tenant_id: string;
      scopes: string;
      created_at: Date;
    }>(
      `INSERT INTO pact.machine_tokens (token_hash, tenant_id, name, created_by_sub, scopes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant_id, scopes, created_at`,
      [tokenHash, tenantId, name, actorSub, scopes.join(' ')],
    );
    const row = rows[0];
    return {
      token: raw,
      record: {
        id: row.id,
        tenantId: row.tenant_id,
        name,
        scopes: row.scopes,
        createdAt: row.created_at.toISOString(),
        revokedAt: null,
      },
    };
  }

  async listMachineTokens(tenantId: string): Promise<Array<MachineTokenRecord>> {
    const { rows } = await this.pool.query<{
      id: string;
      tenant_id: string;
      name: string;
      scopes: string;
      created_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, tenant_id, name, scopes, created_at, revoked_at
         FROM pact.machine_tokens
        WHERE tenant_id = $1
        ORDER BY created_at DESC`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      scopes: r.scopes,
      createdAt: r.created_at.toISOString(),
      revokedAt: r.revoked_at === null ? null : r.revoked_at.toISOString(),
    }));
  }

  /** Revoke — set revoked_at; hiệu lực tức thời. false khi không tìm thấy. */
  async revokeMachineToken(tenantId: string, tokenId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE pact.machine_tokens
          SET revoked_at = now()
        WHERE tenant_id = $1 AND id = $2::uuid AND revoked_at IS NULL`,
      [tenantId, tokenId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Rotate token — thay token_hash bằng giá trị mới, bản rõ trả về đúng một
   * lần. Token cũ (hash cũ) mất hiệu lực ngay lập tức vì mọi request tra hash
   * rồi check. Trả null khi không tìm thấy token hoặc token đã bị revoke.
   *
   * `client` là pg client đã mở (đã BEGIN trong route) — xoay + ghi audit cùng
   * diễn ra trên một transaction duy nhất, fail-closed: nếu audit bị lỗi, toàn
   * bộ transaction rollback và token mới không được lưu.
   */
  async rotateMachineToken(
    client: import('pg').PoolClient,
    tenantId: string,
    tokenId: string,
    _actorSub: string | null,
  ): Promise<{ token: string; record: MachineTokenRecord } | null> {
    const raw = randomToken();
    const tokenHash = await sha256Hex(raw);

    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      name: string;
      scopes: string;
      created_at: Date;
    }>(
      `UPDATE pact.machine_tokens
          SET token_hash = $1
        WHERE tenant_id = $2 AND id = $3::uuid AND revoked_at IS NULL
        RETURNING id, tenant_id, name, scopes, created_at`,
      [tokenHash, tenantId, tokenId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      token: raw,
      record: {
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        scopes: row.scopes,
        createdAt: row.created_at.toISOString(),
        revokedAt: null,
      },
    };
  }
}
