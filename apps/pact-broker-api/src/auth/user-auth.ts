/**
 * User identity auth — đường OIDC của dashboard (ADR-0031 §1), song song với
 * machine-token path (`token-auth.ts`). BFF forward access token của user
 * nguyên vẹn; API tự verify offline rồi tự resolve membership trong DB của
 * mình — KHÔNG tin header nào, KHÔNG introspection, KHÔNG gọi auth.
 *
 * Phân loại token theo **hình dạng** (`isJwtShape`): JWT ba segment base64url
 * là user token; mọi thứ khác (32-byte base64url của machine token) đi đường
 * machine. Không prefix nào phân biệt hai kênh — hình dạng là biên.
 *
 * Lỗi phân lớp theo ADR-0031 §1.3:
 *  * token thiếu / sai chữ ký / hết hạn → 401 đồng nhất (không lộ lý do);
 *  * sub không có membership nào → 403;
 *  * membership chỉ ở tenant suspended/deleted → 401;
 *  * nhiều tenant active cùng lúc → 403 fail-closed (`tenant_ambiguous` chỉ
 *    vào log, không vào response);
 *  * JWKS/network lỗi cấu hình → 503.
 *
 * Token scope KHÔNG phải authorization trên đường user (ADR-0031 §1.4): vai
 * trò đến từ `pact.tenant_members` + `tenants.owner_sub` (owner floor admin,
 * ADR-0032 §2). Trong M1 đường user chỉ đọc (viewer+); mọi route ghi giữ
 * machine-token path (ADR-0032 §3 — publish/verify/environment-CRUD qua
 * portal là ✗ mọi vai trò).
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppEnv } from '../types';
import type { PactBrokerConfig } from '../config';

/** Vai trò membership hiệu lực — bậc thang ADR-0032 §2. */
export type MembershipRole = 'viewer' | 'member' | 'admin';

/** Bậc thang vai trò: viewer < member < admin; owner floor admin. */
const ROLE_RANK: Record<MembershipRole, number> = { viewer: 0, member: 1, admin: 2 };

/** Đúng hình dạng JWT (header.payload.signature, base64url, hai dấu chấm). */
export function isJwtShape(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value);
}

/** Vai trò thỏa mực yêu cầu — read đòi viewer, write/admin không đạt được từ vai trò nào trong M1. */
export function roleSatisfies(role: string, required: 'viewer' | 'member' | 'admin'): boolean {
  const rank = ROLE_RANK[role as MembershipRole];
  if (rank === undefined) return false; // vai trò lạ: fail-closed
  return rank >= ROLE_RANK[required];
}

// ============ JWKS theo issuer (cache trong isolate) ============

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

/**
 * Cache JWKS theo (issuer, fetch origin). `createRemoteJWKSet` của jose tự giữ
 * key cache (TTL 10 phút) + cooldown 30s sau fetch lỗi + single-flight nội bộ;
 * Map này chỉ bảo đảm một instance duy nhất mỗi cặp, nên mọi request cùng
 * isolate chia sẻ đúng một bộ nhớ cache.
 */
const jwksByIssuer = new Map<string, RemoteJwks>();

/** Chỉ test dùng — xoá cache JWKS giữa hai kịch bản cấu hình. */
export function resetJwksCacheForTests(): void {
  jwksByIssuer.clear();
}

/**
 * Path JWKS của `auth` — **`/jwks.json`**, KHÔNG phải
 * `/.well-known/jwks.json`. `auth` chạy `oidc-provider` với route override
 * `jwks: '/jwks.json'` (`apps/auth/src/oidc/provider.ts`); endpoint
 * `/.well-known/jwks.json` không tồn tại và trả 404. Cùng path với BFF
 * (`apps/pact-broker-app/server/auth/verify.ts`).
 */
export const JWKS_PATH = '/jwks.json';

function jwksFor(issuer: string, fetchOrigin?: string | null): RemoteJwks {
  // Cache key gồm cả origin fetch: cùng issuer nhưng khác nơi lấy JWKS ⇒ hai
  // resolver khác nhau, mỗi resolver một cache JWKS riêng.
  const origin = fetchOrigin ?? issuer;
  const key = `${issuer}|${origin}`;
  let jwks = jwksByIssuer.get(key);
  if (jwks === undefined) {
    // Issuer đã được chuẩn hoá ở config (origin, không trailing slash).
    // URL JWKS dựng từ origin FETCH (nội bộ nếu có) — issuer vẫn là giá trị
    // dùng để so claim `iss`.
    jwks = createRemoteJWKSet(new URL(JWKS_PATH, origin));
    jwksByIssuer.set(key, jwks);
  }
  return jwks;
}

// ============ Verify token ============

export type UserTokenResult =
  | { outcome: 'invalid' }
  | { outcome: 'unavailable' }
  | { outcome: 'valid'; sub: string };

/**
 * Phân lớp lỗi verify — cùng luật `classifyJoseError` của backoffice:
 * JWKS/network không tới được là `unavailable` (503), mọi lỗi khác là
 * `invalid` (401). jose ném network lỗi qua `TypeError`; JWKS không parse
 * được qua `JWKSInvalid`.
 */
export function classifyVerifyError(error: unknown): 'unavailable' | 'invalid' {
  const name = error instanceof Error ? error.name : '';
  if (name === 'JWKSInvalid' || name === 'TypeError' || name === 'FetchError') {
    return 'unavailable';
  }
  if (error instanceof TypeError) return 'unavailable';
  return 'invalid';
}

/** Verify access token user: chữ ký ES256 qua JWKS, iss/aud/exp/sub bắt buộc. */
export async function verifyUserToken(
  token: string,
  config: {
    readonly issuer: string;
    readonly audience: string;
    /** Origin fetch JWKS (tuỳ chọn) — `null` ⇒ fetch từ issuer. */
    readonly fetchOrigin?: string | null;
  },
): Promise<UserTokenResult> {
  try {
    const { payload } = await jwtVerify(token, jwksFor(config.issuer, config.fetchOrigin), {
      issuer: config.issuer,
      audience: config.audience,
      requiredClaims: ['iss', 'aud', 'exp', 'sub'],
      clockTolerance: 5,
    });
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub === '') {
      return { outcome: 'invalid' };
    }
    return { outcome: 'valid', sub };
  } catch (error) {
    return { outcome: classifyVerifyError(error) };
  }
}

// ============ Membership resolution ============

/** Hàng membership đã join tenant — đúng hình dạng query trả về. */
export interface MembershipRow {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly status: string;
  readonly role: string;
  readonly ownerSub: string;
}

/** Kết quả resolve principal sau khi verify token. */
export type MembershipResult =
  | { outcome: 'no-membership' }
  | { outcome: 'ambiguous' }
  | { outcome: 'tenant-unavailable' }
  | { outcome: 'granted'; tenantId: string; tenantName: string; role: MembershipRole };

/**
 * Phân lớp memberships của một sub — THUẦN, test không cần DB.
 *
 *  * không row nào → `no-membership` (403);
 *  * chỉ có tenant suspended/deleted → `tenant-unavailable` (401, ADR-0031
 *    §1.3: suspended tenant ⇒ 401 — người dùng không thể tự sửa trạng thái
 *    này, nó là trạng thái tenant);
 *  * nhiều tenant active → `ambiguous` (403 fail-closed — M1 chưa có rule
 *    chọn tenant; chọn giúp user là policy invention);
 *  * đúng một tenant active → granted; owner (owner_sub === sub) floor admin
 *    bất kể role membership (ADR-0032 §2: owner floors to admin trên mọi
 *    behavior).
 */
export function classifyMemberships(sub: string, rows: readonly MembershipRow[]): MembershipResult {
  const active = rows.filter((row) => row.status === 'active');
  if (active.length === 0) {
    return rows.length === 0 ? { outcome: 'no-membership' } : { outcome: 'tenant-unavailable' };
  }
  if (active.length > 1) {
    return { outcome: 'ambiguous' };
  }
  const row = active.at(0);
  if (row === undefined) {
    // Không thể tới được sau hai nhánh trên — guard cho checker, không phải
    // hành vi: active.length === 1 đã khẳng định phần tử đầu tồn tại.
    return { outcome: 'no-membership' };
  }
  // Cast trước validate là chủ ý: giá trị từ DB không tin trước, ROLE_RANK
  // ngay dưới đây là phép kiểm — vai trò lạ fail-closed thành no-membership.
  const role = row.ownerSub === sub ? 'admin' : (row.role as MembershipRole);
  if (ROLE_RANK[role] === undefined) {
    // Vai trò lạ trong DB: fail-closed thay vì đoán quyền.
    return { outcome: 'no-membership' };
  }
  return { outcome: 'granted', tenantId: row.tenantId, tenantName: row.tenantName, role };
}

const MEMBERSHIPS_SQL = `
  SELECT t.id AS tenant_id, t.name AS tenant_name, t.status, m.role, t.owner_sub
    FROM pact.tenant_members m
    JOIN pact.tenants t ON t.id = m.tenant_id
   WHERE m.sub = $1
     AND (m.source IS DISTINCT FROM 'entitlement' OR m.entitlement_revoked_at IS NULL)`;

/** Resolve memberships của sub từ DB — query thật trên pool của request. */
export async function loadMemberships(
  pool: import('pg').Pool,
  sub: string,
): Promise<MembershipRow[]> {
  const { rows } = await pool.query<{
    tenant_id: string;
    tenant_name: string;
    status: string;
    role: string;
    owner_sub: string;
  }>(MEMBERSHIPS_SQL, [sub]);
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    status: row.status,
    role: row.role,
    ownerSub: row.owner_sub,
  }));
}

// ============ HTTP middleware ============

/**
 * 401 đồng nhất — cùng body shape + WWW-Authenticate với machine path
 * (`token-auth.ts`): kẻ dò không phân biệt được hai kênh qua response.
 */
function unauthorized(requestId: string): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized', requestId }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer realm="pact-broker-api"',
    },
  });
}

/** 503 fail-closed khi auth user chưa cấu hình hoặc JWKS không tới được. */
function unavailable(message: string): Response {
  return new Response(JSON.stringify({ error: 'Service Unavailable', message }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

/** 403 generic — không lộ membership tồn tại hay không, không lộ ambiguous. */
function forbidden(): Response {
  return new Response(JSON.stringify({ error: 'Forbidden', message: 'Forbidden' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Lõi HTTP của đường user — được composition gọi sau khi phân loại hình dạng
 * token quyết định đây là JWT. Đọc issuer/audience từ `config` của request,
 * verify, resolve membership, kiểm vai trò, gắn context rồi `next()`.
 *
 * `required` là mực của ROUTE (read/write/admin của machine path); đường user
 * trong M1 chỉ đạt mực read (viewer+). Write/admin qua user token → 403 —
 * đúng matrix ADR-0032 §3: publish/verify/environment-CRUD/token-admin là ✗
 * mọi vai trò cho tới khi có route portal riêng (#207 sở hữu UI mutation).
 */
export async function handleUserToken(
  c: import('hono').Context<AppEnv>,
  token: string,
  config: PactBrokerConfig,
  required: 'read' | 'write' | 'admin',
  next: () => Promise<void>,
): Promise<Response | undefined> {
  const requestId = c.get('requestId') ?? '';
  if (config.authIssuer === null || config.authAudience === null) {
    return unavailable('User authentication is not configured');
  }
  const verified = await verifyUserToken(token, {
    issuer: config.authIssuer,
    audience: config.authAudience,
    fetchOrigin: config.authInternalOrigin,
  });
  if (verified.outcome === 'unavailable') {
    return unavailable('Identity provider is unavailable');
  }
  if (verified.outcome === 'invalid') {
    return unauthorized(requestId);
  }
  const membership = classifyMemberships(
    verified.sub,
    await loadMemberships(c.get('pool'), verified.sub),
  );
  switch (membership.outcome) {
    case 'no-membership':
    case 'ambiguous':
      // Cùng một body cho hai lý do — response không phân biệt được.
      return forbidden();
    case 'tenant-unavailable':
      return unauthorized(requestId);
    case 'granted':
      break;
  }
  if (required !== 'read' || !roleSatisfies(membership.role, 'viewer')) {
    return forbidden();
  }
  c.set('tenantId', membership.tenantId);
  c.set('tenantName', membership.tenantName);
  c.set('principalSub', verified.sub);
  await next();
  return undefined;
}
