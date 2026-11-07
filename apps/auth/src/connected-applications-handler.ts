/**
 * Hai handler back-channel connected applications của contract
 * `account → auth` (FR-009 Connected applications):
 * `POST /internal/connected-applications` (list) và
 * `POST /internal/connected-applications/revoke`.
 *
 * ## Vai trò của `sub` trong payload
 *
 * Caller (`account`) đã xác minh session của user và ký envelope HMAC với
 * secret nội bộ — `sub` trong payload là subject mà account CHỨNG THỰC, không
 * phải subject mà client tự khai. Auth không re-verify session của account
 * (đó là việc của account); biên tin cậy là envelope + allowlist caller.
 *
 * ## `list` — đọc-only
 *
 * Mọi grant `active` của subject kèm `client_name` đăng ký. Không side effect,
 * không audit (đọc dữ liệu của chính chủ qua contract nội bộ).
 *
 * ## `revoke` — MỘT sự kiện db-auth
 *
 * Bên trong CÙNG `client.begin`:
 *   1. CAS `oauth_grants` `active → revoked` (thua ⇒ id đã hết hiệu lực hoặc
 *      không thuộc subject ⇒ 404, rollback toàn bộ).
 *   2. INSERT `token_revocations` level `client` — control plane thu hồi duy
 *      nhất (FR-17a/§6.4). CAS thắng mà INSERT ném ⇒ rollback cả hai: "grant
 *      revoked" và "revocation được ghi" là MỘT sự kiện.
 *   3. Audit `grant_revoked` — cùng tx, cùng sự kiện (cùng lập luận consent
 *      decide: quyết định thu hồi phải commit/cùng rollback với state).
 *
 * ## Idempotency
 *
 * Thu hồi lại grant đã revoked → 404 (`invalid_grant`): trạng thái cuối client
 * thấy qua danh sách (grant biến mất) giống hệt — account route vẫn trả ok
 * không-audit cho nhánh "đã biến mất rồi" qua lý do riêng, và việc thu hồi hai
 * lần không tạo revocation thứ hai trên control plane.
 */

import type {
  ConnectedApplicationsResponse,
  ConnectedApplicationRevokeResponse,
} from '@ecoma-io/auth-contracts';
import {
  insertAuditEvent,
  insertClientRevocation,
  listConnectedApplications,
  revokeGrantActive,
  type PostgresClientLike,
} from '@ecoma-io/auth-infrastructure';

/** Kết quả dùng chung — status + body JSON (cùng hình dạng `ConsentResult`). */
export type ConnectedApplicationsResult =
  | {
      readonly status: 200;
      readonly body: ConnectedApplicationsResponse | ConnectedApplicationRevokeResponse;
    }
  | {
      readonly status: 400 | 404 | 422;
      readonly body: { error: string; error_description?: string };
    };

/** Payload đã validate — hàm parse thuần, test không cần DB. */
export interface ParsedConnectedApplicationsRequest {
  readonly sub: string;
}

/**
 * Validate body của list — `sub` opaque không rỗng, trần 200 ký tự là trần
 * hình dạng (sub thật của hệ thống ngắn hơn nhiều); quá trần là sai hình dạng
 * 400, không phải "không tìm thấy".
 */
export function parseConnectedApplicationsList(
  value: unknown,
): ParsedConnectedApplicationsRequest | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const sub = (value as { sub?: unknown }).sub;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > 200) {
    return undefined;
  }
  return { sub };
}

/** Payload revoke đã validate — cùng luật `sub`, thêm `grant_id` uuid. */
export interface ParsedConnectedApplicationRevokeRequest {
  readonly sub: string;
  readonly grantId: string;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Validate body của revoke — `sub` cùng luật với list; `grant_id` phải là
 * uuid vì `oauth_grants.id` là uuid (CAST `$2::uuid` trên giá trị sai là lỗi
 * DB, còn 400 trước khi chạm DB là contract sạch hơn).
 */
export function parseConnectedApplicationRevoke(
  value: unknown,
): ParsedConnectedApplicationRevokeRequest | undefined {
  const base = parseConnectedApplicationsList(value);
  if (base === undefined) {
    return undefined;
  }
  const grantId = (value as { grant_id?: unknown }).grant_id;
  if (typeof grantId !== 'string' || !UUID_SHAPE.test(grantId)) {
    return undefined;
  }
  return { sub: base.sub, grantId };
}

/**
 * `POST /internal/connected-applications` — danh sách grant hiện hành.
 */
export async function runConnectedApplicationsList(params: {
  readonly postgresClient: PostgresClientLike;
  readonly payload: unknown;
}): Promise<ConnectedApplicationsResult> {
  const parsed = parseConnectedApplicationsList(params.payload);
  if (parsed === undefined) {
    return { status: 400, body: { error: 'invalid_payload' } };
  }

  const applications = await listConnectedApplications(params.postgresClient, {
    sub: parsed.sub,
  });
  const body: ConnectedApplicationsResponse = {
    applications: applications.map((application) => ({
      id: application.id,
      client_id: application.clientId,
      client_name: application.clientName,
      granted_at: application.grantedAt.getTime(),
      scopes: [...application.scopes],
    })),
  };
  return { status: 200, body };
}

/**
 * `POST /internal/connected-applications/revoke` — thu hồi một grant: CAS +
 * control plane + audit trong MỘT transaction.
 */
export async function runConnectedApplicationRevoke(params: {
  readonly postgresClient: PostgresClientLike;
  readonly payload: unknown;
  readonly now: Date;
}): Promise<ConnectedApplicationsResult> {
  const parsed = parseConnectedApplicationRevoke(params.payload);
  if (parsed === undefined) {
    return { status: 400, body: { error: 'invalid_payload' } };
  }

  const { postgresClient } = params;
  let revokedGrantId: string | undefined;
  let revokedClientId: string | undefined;

  try {
    await postgresClient.begin(async (tx) => {
      // (1) CAS — thua ⇒ id không tồn tại, đã revoked, hoặc thuộc sub khác;
      // cả ba đều 404 (không phân biệt cho caller — không oracle).
      const grant = await revokeGrantActive(tx, {
        sub: parsed.sub,
        grantId: parsed.grantId,
        now: params.now,
      });
      if (grant === undefined) {
        throw new ConnectedAppRevokeRaceError();
      }
      // `client_id` đến từ chính câu CAS (RETURNING) — `client_id` là NOT NULL
      // trong schema, hàng vừa bị tx này UPDATE nên không có đường đọc rỗng.
      revokedGrantId = grant.id;
      revokedClientId = grant.clientId;

      // (2) Control plane — CAS thắng mà INSERT ném ⇒ rollback cả CAS.
      await insertClientRevocation(tx, {
        subjectRef: parsed.sub,
        clientId: revokedClientId,
        grantId: grant.id,
        now: params.now,
      });

      // (3) Audit — cùng tx: thu hồi là một sự kiện có chủ đích của user, cần
      // bằng chứng commit cùng state.
      await insertAuditEvent(tx, {
        eventType: 'grant_revoked',
        subjectRef: parsed.sub,
        clientId: revokedClientId,
        grantId: grant.id,
        outcome: 'success',
        details: { source: 'connected_applications' },
      });
    });
  } catch (error) {
    if (error instanceof ConnectedAppRevokeRaceError) {
      return { status: 404, body: { error: 'invalid_grant' } };
    }
    throw error;
  }

  if (revokedGrantId === undefined || revokedClientId === undefined) {
    // Không tới được: `begin` resolve nghĩa là CAS đã thắng. Guard để TS thu
    // hẹp kiểu — ném là fail-closed đúng hơn trả body nửa vời.
    throw new Error('revoke committed without grant identity');
  }
  const body: ConnectedApplicationRevokeResponse = { outcome: 'revoked' };
  return { status: 200, body };
}

/** Lỗi điều khiển CAS — tách class để bắt CHỈ lỗi này (cùng lập luận consent). */
class ConnectedAppRevokeRaceError extends Error {}
