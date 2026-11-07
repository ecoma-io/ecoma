import type { AuthGrant } from '@ecoma-io/auth-application';

import type { PostgresClientLike, Queryable } from './postgres';

/**
 * Store grant + consent decision của `db-auth` — bảng `auth.oauth_grants`,
 * `auth.client_grant_scopes`, `auth.oauth_consent_decisions`.
 *
 * ## Ranh giới
 *
 * Truy vấn này từng nằm trong `apps/auth/src/authorization-store.ts` — chỗ tạm
 * của app cho tới khi lib sở hữu nó (#343). Cùng bộ luật với các module anh em
 * (`authorization-code-cas`, `authorization-transaction-store`): câu SQL là
 * bản chép của quy ước trong migration (`0003`, `0008`), lệch tên cột chỉ lộ
 * ra khi chạy với schema thật.
 *
 * ⚠️ **Mỗi hàm bọc đúng MỘT câu SQL**, trừ cặp `insertGrant` + `insertGrantScopes`
 * — ba INSERT của consent `approve` (decision → grant → scopes) PHẢI đi trong
 * cùng một `client.begin` của caller để "đã consume Y" và "grant tồn tại" là
 * MỘT sự kiện (§5.1.5b); các hàm chỉ cung cấp các câu lệnh cho caller ghép.
 *
 * ## Parity test
 *
 * Các bảng ở trên KHÔNG có parity spec colocated song song từng file migration;
 * hợp đồng đọc/ghi của chúng được ghim bằng suite PostgreSQL thật app-owned
 * `apps/auth/tests/integrations/authorization-store.spec.ts` (+ các đường
 * handler qua `main.spec.ts`). Quyết định này giữ nguyên khi store dời về lib
 * — suite sở hữu database thuộc app, không thuộc lib (06-testing.md §6, §9).
 */

/** Hàng `oauth_grants` như PostgreSQL trả về. */
interface GrantRow {
  id: string;
  sub: string;
  client_id: string;
  status: string;
  scopes: string[];
}

/**
 * Nạp grant HIỆN HÀNH của một cặp `(sub, client)`.
 *
 * Index unique `oauth_grants_active_sub_client_idx` (0003) bảo đảm tối đa MỘT hàng
 * active — nếu hai hàng lọt qua index hỏng thì hàng đầu tiên vẫn không phải tình
 * trạng "hai đáp án" mà caller có thể diễn giải: `$limit 1` + `status = 'active'`
 * là hợp đồng đọc của bảng này.
 *
 * ⚠️ Trả kèm `id`: application layer dùng nó làm `jti` của provider Grant
 * (xem `oidc/interaction.ts` — hai vế thu hồi phải trỏ cùng một định danh).
 */
export async function findActiveGrant(
  client: PostgresClientLike,
  params: { readonly sub: string; readonly clientId: string },
): Promise<(AuthGrant & { readonly id: string }) | undefined> {
  const rows = await client.unsafe<GrantRow>(
    `SELECT g.id, g.sub, g.client_id, g.status,
            coalesce(array_agg(s.scope ORDER BY s.scope) FILTER (WHERE s.scope IS NOT NULL), '{}') AS scopes
       FROM auth.oauth_grants g
       LEFT JOIN auth.client_grant_scopes s ON s.grant_id = g.id
      WHERE g.sub = $1 AND g.client_id = $2 AND g.status = 'active'
      GROUP BY g.id, g.sub, g.client_id, g.status
      LIMIT 1`,
    [params.sub, params.clientId],
  );
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    id: row.id,
    account_id: row.sub,
    client_id: row.client_id,
    scopes: row.scopes,
    isActive: row.status === 'active',
  };
}

/** Dữ liệu để mở grant mới — caller (`consent/decide` approve) đã có đủ mọi trường. */
export interface NewGrantInput {
  readonly sub: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** `oauth_consent_decisions.id` — liên kết audit; NULL khi consent record bị retention xoá. */
  readonly consentDecisionId: string | undefined;
  readonly now: Date;
}

/** INSERT `oauth_grants` — trả `id` mới để gọi hai câu lệnh còn lại tham chiếu. */
export async function insertGrant(tx: Queryable, input: NewGrantInput): Promise<string> {
  const rows = await tx.unsafe<{ id: string }>(
    `INSERT INTO auth.oauth_grants (sub, client_id, status, consent_decision_id, granted_at)
     VALUES ($1, $2, 'active', $3, $4)
     RETURNING id`,
    [input.sub, input.clientId, input.consentDecisionId, input.now],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('INSERT oauth_grants khong tra ve id');
  }
  return row.id;
}

/** INSERT toàn bộ scope của một grant — PK composite chặn trùng. */
export async function insertGrantScopes(
  tx: Queryable,
  params: { readonly grantId: string; readonly scopes: readonly string[] },
): Promise<void> {
  // `unnest($2::text[])` — một câu cho mọi scope; tham số hoá toàn bộ, không nối chuỗi.
  await tx.unsafe(
    `INSERT INTO auth.client_grant_scopes (grant_id, scope)
     SELECT $1, scope FROM unnest($2::text[]) AS scope
     ON CONFLICT (grant_id, scope) DO NOTHING`,
    [params.grantId, [...params.scopes]],
  );
}

/** INSERT consent decision — hàng audit LỊCH SỬ, không phải quyền hiện hành (§3.4). */
export async function insertConsentDecision(
  tx: Queryable,
  params: {
    readonly sub: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly grantedScopes: readonly string[];
    readonly decision: 'approve' | 'deny';
    readonly authorizationTransactionId: string;
    readonly now: Date;
  },
): Promise<string> {
  const rows = await tx.unsafe<{ id: string }>(
    `INSERT INTO auth.oauth_consent_decisions (
        sub, client_id, redirect_uri, granted_scopes, decision,
        authorization_transaction_id, decided_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      params.sub,
      params.clientId,
      params.redirectUri,
      [...params.grantedScopes],
      params.decision,
      params.authorizationTransactionId,
      params.now,
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('INSERT oauth_consent_decisions khong tra ve id');
  }
  return row.id;
}

/**
 * Đọc quyết định consent ĐÃ COMMIT của một authorization transaction.
 *
 * ⚠️ Đây là nguồn sự thật duy nhất của "quyết định nào đã thắng" — KHÔNG PHẢI
 * cột `event_id` của `authorization_transactions`: khối bốn cột `event_*` là
 * idempotency key của event PUSH account→auth (§5.1.5a), quyết định consent
 * là contract khác với định danh riêng (`oauth_consent_decisions`, §5.1.5b).
 * Replay decide (cùng Y + cùng decision) và từ chối decision khác đều đối
 * chiếu qua bảng này, cùng transaction `db-auth` với CAS consume-Y nên giá
 * trị luôn khớp trạng thái consume.
 */
export async function findCommittedConsentDecision(
  client: PostgresClientLike,
  params: { readonly authorizationTransactionId: string },
): Promise<'approve' | 'deny' | undefined> {
  const rows = await client.unsafe<{ decision: string }>(
    `SELECT decision FROM auth.oauth_consent_decisions
      WHERE authorization_transaction_id = $1
      ORDER BY decided_at ASC
      LIMIT 1`,
    [params.authorizationTransactionId],
  );
  const decision = rows[0]?.decision;
  return decision === 'approve' || decision === 'deny' ? decision : undefined;
}

/* ------------------------------------------------------------------------- */
/* Connected applications — list + revoke của contract account → auth         */
/* ------------------------------------------------------------------------- */

/**
 * Hàng danh sách ứng dụng đã kết nối — join `oauth_clients` lấy `client_name`.
 *
 * ⚠️ `client_name` là dữ liệu ĐĂNG KÝ của client (0001), không phải dữ liệu
 * grant; tách cột để response của contract không bắt account query thêm bảng
 * nào. Chỉ grant `active` được trả: `revoked` không còn là "đã kết nối".
 */
interface ConnectedAppRow {
  id: string;
  client_id: string;
  client_name: string;
  granted_at: Date;
  scopes: string[];
}

/**
 * Liệt kê mọi grant `active` của một sub, kèm tên client đăng ký.
 *
 * ⚠️ Chỉ MỘT câu SELECT với tham số hoá — `sub` đi qua bind parameter, không
 * bao giờ chạm chuỗi SQL. Danh sách KHÔNG chứa secret, hash hay redirect_uri:
 * contract này phục vụ trang "ứng dụng đã kết nối", không phải đăng ký client.
 */
export async function listConnectedApplications(
  client: PostgresClientLike,
  params: { readonly sub: string },
): Promise<
  readonly {
    id: string;
    clientId: string;
    clientName: string;
    grantedAt: Date;
    scopes: readonly string[];
  }[]
> {
  const rows = await client.unsafe<ConnectedAppRow>(
    `SELECT g.id, g.client_id, c.client_name, g.granted_at,
            coalesce(array_agg(s.scope ORDER BY s.scope) FILTER (WHERE s.scope IS NOT NULL), '{}') AS scopes
       FROM auth.oauth_grants g
       JOIN auth.oauth_clients c ON c.client_id = g.client_id
       LEFT JOIN auth.client_grant_scopes s ON s.grant_id = g.id
      WHERE g.sub = $1 AND g.status = 'active'
      GROUP BY g.id, g.client_id, c.client_name, g.granted_at
      ORDER BY g.granted_at DESC`,
    [params.sub],
  );
  return rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    grantedAt: row.granted_at,
    scopes: row.scopes,
  }));
}

/**
 * Thu hồi MỘT grant `active` của `(sub, grant_id)` — CAS, trả id khi thắng.
 *
 * ⚠️ CAS `WHERE status = 'active'`: một grant đã revoked không bị ghi đè mốc
 * `revoked_at` của lần đầu, và một id của người khác khớp 0 hàng (404 phía
 * handler, không xác nhận tồn tại). `status` `revoked` là vĩnh viễn (0003).
 * Row `token_revocations` level `client` + audit được caller ghi trong CÙNG
 * transaction — hàm này chỉ là câu CAS.
 */
export async function revokeGrantActive(
  tx: Queryable,
  params: { readonly sub: string; readonly grantId: string; readonly now: Date },
): Promise<{ id: string; clientId: string } | undefined> {
  const rows = await tx.unsafe<{ id: string; client_id: string }>(
    `UPDATE auth.oauth_grants
        SET status = 'revoked',
            revoked_at = $3
      WHERE id = $2::uuid AND sub = $1 AND status = 'active'
      RETURNING id, client_id`,
    [params.sub, params.grantId, params.now],
  );
  const row = rows[0];
  return row === undefined ? undefined : { id: row.id, clientId: row.client_id };
}
