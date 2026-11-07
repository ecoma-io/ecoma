/**
 * Lấy principal của request từ **server-side context** — không bao giờ từ
 * body/query/header do client kiểm soát.
 *
 * ## Vì sao principal lấy từ `event.context`
 *
 * `01-architecture.md` §5 (T-10 confused deputy): "Trusted mapping từ token
 * subject (`sub`) sang Account ID và sang staff context diễn ra server-side từ
 * token đã xác thực; client không supply được principal, role, permission hay
 * scope". Tầng xác thực thật đã được wire (ADR-0012, PR J2): middleware
 * `server/middleware/authn.ts` verify phiên + access token rồi gắn principal
 * vào context **trước** mọi route.
 *
 * ⚠️ Vì vậy context này **không** phải header do client gửi: `event.context` là
 * nơi middleware của chính app gắn principal sau khi verify. Route đọc được
 * nó, không tự verify, và **fail closed** khi nó vắng.
 *
 * ## Vì sao vắng principal ⇒ `401` (đã flip từ `503`)
 *
 * ADR-0011 §1: `401` = credential vắng/hỏng — caller chưa đăng nhập. Trước PR
 * J2, app **chưa có** đường xác thực nên thiếu principal nghĩa là "hệ thống
 * chưa dựng được đường" ⇒ `503` (ADR-0010, giai đoạn đó). Từ PR J2, middleware
 * authn là đường đó: thiếu principal ở context nghĩa là request **không có
 * phiên hợp lệ** — một khẳng định về caller ⇒ `401`. Đây là đúng quy tắc
 * chuyển tiếp của ADR-0011 §3: flip trong cùng PR wire authn.
 *
 * ⚠️ `503` vẫn giữ cho các class "không verify được **lúc này**" (JWKS outage,
 * DB outage) và cho actor sai định dạng ở `requirePermission` (trục
 * authorization) — chúng nằm ở middleware/hook khác, không phải ở đây.
 *
 * ⚠️ Route **không** đọc `sub` từ query/body/header. Đọc header `x-actor-sub`
 * ở đây là đường confused deputy: client tự chọn danh tính, và `SR-001` cấm
 * đúng thứ đó.
 */

import { createError } from 'h3';
import type { H3Event } from 'h3';

import { isBackofficeAccountId } from '@ecoma-io/backoffice-domain';

/**
 * Khoá context mà middleware authn gắn principal vào.
 *
 * ⚠️ Đây là **hợp đồng giữa các lớp trong cùng app**, chưa phải contract với
 * service khác: giá trị ở `event.context` chỉ có ý nghĩa khi middleware authn
 * gắn nó. Tầng authn (`server/middleware/authn.ts`) là bên **duy nhất** ghi
 * key này — nếu một tầng sau này đổi tên key, route này và middleware phải
 * đổi cùng lúc.
 */
export const PRINCIPAL_CONTEXT_KEY = 'backofficePrincipal';

/**
 * Principal đã verify, dạng tối thiểu mà route cần.
 *
 * ⚠️ `actorSub` là `sub` đã verify server-side. Route **không** tin nó chỉ vì
 * nó nằm trong context: {@link readPrincipal} kiểm lại hình dạng bằng
 * `isBackofficeAccountId` trước khi dùng, và `requirePermission` kiểm lại lần
 * nữa ở đầu checkpoint.
 */
export interface VerifiedPrincipal {
  readonly actorSub: string;
}

/**
 * Đọc principal từ context; `null` khi vắng hoặc sai hình dạng.
 *
 * Hàm này **không** ném lỗi — caller quyết định phản hồi (route đọc trả
 * `503`; `requirePermission` tự kiểm lại và ném `503` khi actor sai định
 * dạng).
 */
export function readPrincipal(event: H3Event): VerifiedPrincipal | null {
  const context = event.context as Record<string, unknown>;
  const principal = context[PRINCIPAL_CONTEXT_KEY] as { actorSub?: unknown } | undefined;
  if (principal === undefined || principal === null || typeof principal !== 'object') {
    return null;
  }
  const actorSub = principal.actorSub;
  if (typeof actorSub !== 'string' || !isBackofficeAccountId(actorSub)) {
    return null;
  }
  return { actorSub };
}

/**
 * Đọc principal hoặc fail closed với `401` (ADR-0011 §1 — credential vắng).
 *
 * @throws {H3Error} `401` khi context không có principal verify được.
 */
export function requirePrincipal(event: H3Event): VerifiedPrincipal {
  const principal = readPrincipal(event);
  if (principal === null) {
    throw createError({ statusCode: 401, statusMessage: 'unauthorized' });
  }
  return principal;
}
