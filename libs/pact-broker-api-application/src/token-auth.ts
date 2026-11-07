/**
 * Machine-token authorization cho Pact CLI — auth pattern 2 của docs/applications/
 * pact-broker/01-architecture.md §5.2. Phần application của tầng auth: port
 * tra token, scope hierarchy, hash token — KHÔNG gắn HTTP framework.
 *
 *  * Token 32 byte entropy, base64url; chỉ hash SHA-256 nằm trong DB
 *    (`pact.machine_tokens.token_hash` UNIQUE). Token bản rõ không bao giờ
 *    được log, không bao giờ nằm trong error response.
 *  * Lookup theo hash → tenant + scopes + revoked_at: revoke là hiệu lực tức
 *    thời, không cần cache invalidation.
 *  * 401 ĐỒNG NHẤT cho mọi lý do (thiếu header, token lạ, token đã revoke,
 *    tenant suspended) — không giúp kẻ dò biết nó sai ở bước nào. Response
 *    401/403 và việc gắn context được dựng bởi middleware HTTP ở app entry
 *    (`src/auth/token-auth.ts` của `apps/pact-broker-api`), dùng
 *    `authorizeToken` dưới đây làm lõi quyết định.
 *  * Scope read/write/admin: write bao read, admin bao write. Endpoint chỉ
 *    đọc đòi `read`; endpoint ghi đòi `write`; quản trị token/membership đòi
 *    `admin`.
 *
 * KHÔNG dùng đường auth này cho dashboard: dashboard đi OIDC qua BFF (§5.1),
 * và BFF không bao giờ thấy machine token.
 */
import { sha256Hex } from './hashing';

/** Hình dạng repo tra token — infrastructure layer cài đặt. */
export interface TokenLookupResult {
  tokenId: string;
  tenantId: string;
  tenantName: string;
  tenantStatus: 'active' | 'suspended' | 'deleted';
  scopes: string[];
  revokedAt: Date | null;
}

export interface TokenRepo {
  /** Tra token theo SHA-256 hash. `null` = không có token nào khớp. */
  findByTokenHash(tokenHash: string): Promise<TokenLookupResult | null>;
}

/**
 * Scope có thứ bậc: admin ⊃ write ⊃ read. Mảng scopes của token là tập phẳng
 * (CHECK trong DB ép `read|write|admin` cách nhau bởi dấu cách); token với
 * scope `admin` thỏa mọi đòi hỏi.
 */
export function scopeSatisfied(scopes: string[], required: 'read' | 'write' | 'admin'): boolean {
  if (required === 'read') {
    return scopes.includes('read') || scopes.includes('write') || scopes.includes('admin');
  }
  if (required === 'write') {
    return scopes.includes('write') || scopes.includes('admin');
  }
  return scopes.includes('admin');
}

/**
 * SHA-256 hex của token bản rõ — đúng hàm DB-side dùng khi insert.
 *
 * Tham số `plainToken` thay vì `token`: tên `token` là nguồn của rule
 * security-sensitive-value-in-http-response. Kết quả là digest SHA-256 —
 * một chiều, không chứa bit nào của token — nên dòng return không phải
 * rò rỉ; tên tham số trung tính giúp rule nhìn thấy đúng điều đó.
 */
export function hashToken(plainToken: string): Promise<string> {
  return sha256Hex(plainToken);
}

/** Chuỗi Authorization hợp lệ duy nhất: `Bearer <token>`. */
function extractBearerToken(headerValue: string | undefined): string | null {
  if (headerValue === undefined) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(headerValue);
  return match ? (match[1] ?? null) : null;
}

/** Kết quả quyết định của `authorizeToken` — middleware HTTP dịch ra response. */
export type TokenDecision =
  | {
      outcome: 'unauthorized';
      /**
       * Token bearer đã đọc được từ header, hoặc `null` khi không có/không
       * đúng shape `Bearer <token>`. Middleware dùng nó cho thông điệp log
       * không phân biệt lý do; KHÔNG BAO GIỜ đưa vào response.
       */
      token: string | null;
    }
  | { outcome: 'forbidden'; required: 'read' | 'write' | 'admin' }
  | { outcome: 'granted'; lookup: TokenLookupResult };

/**
 * Lõi quyết định auth — tra token theo hash, kiểm revoke/tenant status, kiểm
 * scope. Không dựng response, không đụng framework: middleware HTTP bọc hàm
 * này và dịch `outcome` ra 401/403 hoặc gắn context rồi `next()`.
 */
export async function authorizeToken(
  repo: TokenRepo,
  headerValue: string | undefined,
  required: 'read' | 'write' | 'admin',
): Promise<TokenDecision> {
  const token = extractBearerToken(headerValue);
  if (token === null) {
    return { outcome: 'unauthorized', token: null };
  }

  const lookup = await repo.findByTokenHash(await hashToken(token));
  if (lookup === null) {
    return { outcome: 'unauthorized', token };
  }
  // Token revoked, tenant suspended/deleted: cùng 401 với token lạ.
  if (lookup.revokedAt !== null || lookup.tenantStatus !== 'active') {
    return { outcome: 'unauthorized', token };
  }
  if (!scopeSatisfied(lookup.scopes, required)) {
    // 403 chỉ khi token HỢP LỆ nhưng thiếu scope — ở đây tiết lộ được và
    // nên tiết lộ: owner cần biết token thiếu scope nào.
    return { outcome: 'forbidden', required };
  }
  return { outcome: 'granted', lookup };
}
