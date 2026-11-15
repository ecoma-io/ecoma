/**
 * BFF portal của `remote-cache-app` — hợp đồng BFF cho sáu workflow của
 * developer portal (R19, issue #180). Browser gọi **chỉ** các route dưới đây;
 * client dưới `server/control-plane.ts` ký envelope HMAC nội bộ mang actor
 * `sub` của phiên (ADR-0034) rồi gọi `remote-cache-api` portal surface.
 *
 * ## Hợp đồng BFF (R19 + R20)
 *
 * | BFF route | Control plane | Ghi chú |
 * | --- | --- | --- |
 * | `GET  /api/portal/tenants/:tenantName/projects` | `GET /tenants/:tenantName/projects` | list project |
 * | `POST /api/portal/tenants/:tenantName/projects` | `POST /tenants/:tenantName/projects` | tạo project + key đầu tiên |
 * | `GET  /api/portal/tenants/:tenantName/projects/:projectName` | `GET .../projects/:projectName` | chi tiết project |
 * | `POST /api/portal/tenants/:tenantName/projects/:projectName/api-keys` | `POST .../api-keys` | tạo thêm key (show-once) |
 * | `GET  /api/portal/tenants/:tenantName/projects/:projectName/api-keys` | `GET .../api-keys` | metadata key — không secret |
 * | `POST /api/portal/tenants/:tenantName/projects/:projectName/api-keys/:keyId/revoke` | `POST .../revoke` | revoke ngay lập tức |
 *
 * ## Bất biến bất di chuyển (SR — hard invariants của #180)
 *
 * - **Show-once**: token API key chỉ xuất hiện ở response của hai route tạo
 *   (`201`), đúng một lần; sau đó BFF không giữ lại, không log, không cache.
 * - **Metadata không secret**: response list metadata **không bao giờ** mang
 *   `token`/`token_hash` — BFF ghim bằng hằng `FORBIDDEN_METADATA_KEYS` trước
 *   khi trả browser (phòng thủ thứ hai sau shape của control plane).
 * - **Browser không gọi control plane trực tiếp**: mọi request đi qua BFF;
 *   không API key, không HMAC secret ở browser.
 * - **CSRF mutation**: middleware authn đã enforce double-submit cho POST;
 *   các route mutation dưới đây chỉ nhận qua lớp đó.
 *
 * ## Fail-closed
 *
 * - Thiếu cấu hình control plane (base URL/secret) ⇒ `503` `control_plane_not_configured`.
 * - Lỗi network tới control plane ⇒ `502` `control_plane_unavailable` (khác
 *   `503`: cấu hình có, nhưng phía sau không trả lời được).
 * - Status của control plane được **pass-through** — không diễn giải lại lỗi
 *   nghiệp vụ (401/403/404/409 từ control plane giữ nguyên status + body).
 */

import {
  createError,
  defineEventHandler,
  readRawBody,
  setHeader,
  setResponseStatus,
  type H3Event,
} from 'h3';

import {
  callControlPlane,
  ControlPlaneUnavailableError,
  remoteCacheControlPlaneConfig,
} from '../../control-plane';
import { INTERNAL_BODY_LIMIT_BYTES } from '@ecoma-io/internal-auth-contracts';
import { requirePrincipal } from '../../principal';
import { writeLog } from '../../log';

/** Route của control plane cho một request portal — pathname + search. */
function controlPlanePath(event: H3Event): string {
  // `event.path` của request BFF là `/api/portal/tenants/...`; control plane
  // mount cùng subtree KHÔNG có tiền tố `/api/portal`.
  const { pathname, search } = new URL(event.path, 'http://remote-cache-app.invalid');
  const stripped = pathname.replace(/^\/api\/portal/u, '');
  // Defense-in-depth: dot-segment không bao giờ được forward lên control plane
  // — fetch client có thể normalize `..` thành segment ngoài subtree đã ký.
  // Percent-encoding cũng bị từ chối: `%2e%2e` decode ra `..` ở upstream, nên
  // chữ ký `%` trần là đường chặn duy nhất không phụ thuộc hành vi decode của
  // phía nhận. Giá trị thật của tên tenant/project/key không chứa `..` lẫn `%`.
  if (stripped.includes('..') || stripped.includes('%')) {
    reject(event, 503, 'control_plane_path_invalid');
  }
  return `${stripped}${search}`;
}

/**
 * Khoá metadata bị cấm lên browser — ghim SR "list metadata never includes
 * token/hash fields": nếu control plane nào đó lệch contract trả thêm field
 * secret, BFF bóc trước khi trả browser.
 */
const FORBIDDEN_METADATA_KEYS = new Set(['token', 'token_hash', 'secret', 'credential']);

/**
 * Bóc mọi khoá forbidden ở mọi cấp của payload — đệ quy trên object/array.
 * Chỉ dùng cho response trả browser; request đi lên không qua hàm này.
 */
function stripForbiddenKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripForbiddenKeys);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_METADATA_KEYS.has(key)) {
        continue;
      }
      out[key] = stripForbiddenKeys(item);
    }
    return out;
  }
  return value;
}

/**
 * Từ chối request trước khi chạm control plane — log một dòng ổn định rồi
 * ném `H3Error` (Nitro render JSON 5xx).
 */
function reject(event: H3Event, status: 502 | 503, reason: string): never {
  writeLog({
    event: 'remote_cache_app_portal.failed',
    route: event.path,
    method: event.method,
    status,
    reason,
  });
  throw createError({
    statusCode: status,
    statusMessage: status === 502 ? 'Bad Gateway' : 'Service Unavailable',
    // Mã lý do ổn định (không phải secret) đi kèm response — caller/soi log
    // phân biệt được `control_plane_not_configured` với `control_plane_unreachable`.
    data: { reason },
  });
}

/**
 * Thân chung của sáu route portal: đọc cấu hình (fail-closed 503), đọc principal
 * (401 từ middleware nếu thiếu), đọc body byte thẳng, gọi control plane đã ký,
 * pass-through status + body (đã bóc khoá secret).
 *
 * @param event Request BFF.
 * @returns `{ status, json }` của control plane — `json` đã qua
 *   {@link stripForbiddenKeys}.
 */
async function portalProxy(event: H3Event): Promise<unknown> {
  const config = remoteCacheControlPlaneConfig(event);
  if (config === null) {
    reject(event, 503, 'control_plane_not_configured');
  }

  // Principal gắn bởi middleware authn — thiếu ở đây chỉ xảy ra khi route bị
  // gọi ngoài ranh giới middleware (không có trong runtime thật) ⇒ 401.
  const principal = requirePrincipal(event);

  // Byte thẳng từ request — đúng byte được ký; không parse/serialize lại.
  // ⚠️ `readRawBody` của h3 1.15 assert method PayloadMethods (POST/PUT/PATCH/
  // DELETE) trước khi đọc — một GET đi qua đây nhận 405 dù không có body.
  // GET của portal không mang body, nên chỉ đọc khi method là payload method.
  // Giới hạn `INTERNAL_BODY_LIMIT_BYTES` (64 KiB, cùng hằng với middleware
  // internal của `account`) chặn DoS body lớn trên đường nóng của BFF ⇒ 413.
  const body =
    event.method === 'GET'
      ? null
      : await (async (): Promise<Uint8Array | null> => {
          const rawBody = await readRawBody(event, false);
          if (rawBody === undefined || rawBody === null) return null;
          const bytes =
            typeof rawBody === 'string'
              ? new TextEncoder().encode(rawBody)
              : new Uint8Array(rawBody);
          if (bytes.byteLength > INTERNAL_BODY_LIMIT_BYTES) {
            throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' });
          }
          return bytes;
        })();

  let result: Awaited<ReturnType<typeof callControlPlane>>;
  try {
    result = await callControlPlane(config, {
      method: event.method === 'GET' ? 'GET' : 'POST',
      path: controlPlanePath(event),
      ...(body === null ? {} : { body }),
      actorSub: principal.actorSub,
    });
  } catch (error) {
    if (error instanceof ControlPlaneUnavailableError) {
      reject(event, 502, 'control_plane_unreachable');
    }
    throw error;
  }

  if (result.status >= 500) {
    // Lỗi từ phía control plane: log để điều tra, giữ pass-through status.
    writeLog({
      event: 'remote_cache_app_portal.upstream_error',
      route: event.path,
      method: event.method,
      status: result.status,
    });
  }

  setResponseStatus(event, result.status);
  if (event.method !== 'GET') {
    // Response POST tạo key/project mang token show-once — cấm mọi tầng cache.
    setHeader(event, 'Cache-Control', 'no-store');
  }
  // Bóc khoá secret CHỈ trên GET (metadata list/detail): response của POST tạo
  // là show-once — `api_key.token` là nội dung ĐÚNG hợp đồng phải tới browser.
  return event.method === 'GET' ? stripForbiddenKeys(result.json) : result.json;
}

/** Handler GET chung — list project, chi tiết project, list metadata key. */
export const portalGetHandler = defineEventHandler((event: H3Event) => portalProxy(event));

/** Handler POST chung — tạo project, tạo key (show-once), revoke key. */
export const portalPostHandler = defineEventHandler((event: H3Event) => portalProxy(event));

/** `GET /api/portal/tenants/:tenantName/projects` — list project. */
export const listProjectsHandler = portalGetHandler;
/** `POST /api/portal/tenants/:tenantName/projects` — tạo project + key đầu tiên. */
export const createProjectHandler = portalPostHandler;
/** `GET /api/portal/tenants/:tenantName/projects/:projectName` — chi tiết project. */
export const projectDetailHandler = portalGetHandler;
/** `POST /api/portal/tenants/:tenantName/projects/:projectName/api-keys` — tạo key (show-once). */
export const createApiKeyHandler = portalPostHandler;
/** `GET /api/portal/tenants/:tenantName/projects/:projectName/api-keys` — list metadata key. */
export const listApiKeysHandler = portalGetHandler;
/** `POST /api/portal/tenants/:tenantName/projects/:projectName/api-keys/:keyId/revoke` — revoke. */
export const revokeApiKeyHandler = portalPostHandler;
