/**
 * HTTP middleware của machine-token auth — bọc lõi quyết định
 * `authorizeToken` từ `@ecoma-io/pact-broker-api-application` vào Hono.
 * Phần logic (port, scope hierarchy, hash) thuộc application lib; file này
 * chỉ dịch outcome ra response 401/403 và gắn context.
 *
 *  * 401 ĐỒNG NHẤT cho mọi lý do (thiếu header, token lạ, token đã revoke,
 *    tenant suspended) — không giúp kẻ dò biết nó sai ở bước nào.
 *  * 403 chỉ khi token hợp lệ nhưng thiếu scope.
 *
 * KHÔNG dùng middleware này cho dashboard: dashboard đi OIDC qua BFF
 * (§5.1), và BFF không bao giờ thấy machine token.
 */
import type { MiddlewareHandler } from 'hono';
import { authorizeToken } from '@ecoma-io/pact-broker-api-application';
import type { TokenRepo } from '@ecoma-io/pact-broker-api-application';
import type { AppEnv } from '../types';

/**
 * 401 response ĐỒNG NHẤT. Không phân biệt lý do — cùng status, cùng body
 * shape, cùng WWW-Authenticate. Message tiếng Anh không dấu là CLI output
 * cho máy đọc.
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

/**
 * Factory middleware: đòi machine token có scope `required` và tenant active.
 *
 * ⚠️ Hash tra DB, không so sánh token bản rõ với cột nào. `timingSafeEqual`
 * không cần ở đây: lookup là index unique theo hash SHA-256 — không có chuỗi
 * bí mật nào được so từng byte trong code.
 */
export function requireMachineToken(
  repo: TokenRepo,
  required: 'read' | 'write' | 'admin',
): MiddlewareHandler<AppEnv> {
  // Không annotate tường minh: ngữ cảnh đã là `Promise<Response | void>` từ
  // `MiddlewareHandler` của Hono; viết `Promise<Response | void>` ra thì vi
  // phạm rule lint `no-invalid-void-type` của repo (void trong union).
  return async (c, next) => {
    const decision = await authorizeToken(repo, c.req.header('authorization'), required);
    if (decision.outcome === 'unauthorized') {
      return unauthorized(c.get('requestId') ?? '');
    }
    if (decision.outcome === 'forbidden') {
      return c.json(
        { error: 'Forbidden', message: `Token does not have required scope: ${decision.required}` },
        403,
      );
    }

    const lookup = decision.lookup;
    c.set('tenantId', lookup.tenantId);
    c.set('tenantName', lookup.tenantName);
    c.set('scopes', lookup.scopes);
    c.set('tokenId', lookup.tokenId);
    await next();
    return undefined;
  };
}
