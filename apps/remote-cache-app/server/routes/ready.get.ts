import { defineEventHandler, setResponseStatus } from 'h3';

import { remoteCacheAuthConfig } from '../auth/config';
import { remoteCacheControlPlaneConfig } from '../control-plane';
import { writeLog } from '../log';

/**
 * `GET /ready` — readiness của app có **downstream cấu hình thật** (ADR-0035).
 *
 * Phân biệt với `/health` (xem `health.get.ts`): readiness trả lời "Worker có
 * phục vụ request thật được không". Sau #180, app phục vụ BFF OIDC + portal —
 * câu trả lời là có khi và chỉ khi **cấu hình bắt buộc của BFF đã đủ**:
 *
 * - OIDC: `REMOTE_CACHE_AUTH_ISSUER`/`_AUDIENCE`/`_CLIENT_ID` — thiếu ⇒ mọi
 *   request `/api/**` đều 503, readiness phải nói cùng điều đó.
 * - Control plane: `REMOTE_CACHE_API_BASE_URL` + `INTERNAL_AUTH_SECRET` —
 *   thiếu ⇒ mọi route portal đều 503, readiness phải nói cùng điều đó.
 *
 * ## Fail-closed — chính hợp đồng mà spec trước ghim
 *
 * Thiếu bất kỳ nhóm nào ⇒ `503` kèm mã ổn định (`*_not_configured`) — **không**
 * mặc định trả ready. Route đọc **cấu hình**, không gọi mạng: không fetch tới
 * control plane hay JWKS ở đây — một phụ thuộc mạng như vậy biến readiness
 * thành serving-path dependency của service khác (invariant observability).
 * Kiểm cấu hình bằng env là đủ, vì middleware authn và proxy portal fail
 * closed trên đúng các env đó.
 *
 * DB không nằm trong phép kiểm này: binding Hyperdrive vắng là trạng thái hợp
 * lệ của preview tĩnh (chưa đăng nhập), middleware trả 503 trên đường request
 * thật — readiness không nhân đôi phép đo đó.
 */
export default defineEventHandler((event) => {
  const oidcReady = remoteCacheAuthConfig(event) !== null;
  const controlPlaneReady = remoteCacheControlPlaneConfig(event) !== null;
  if (!oidcReady || !controlPlaneReady) {
    const code = !oidcReady ? 'oidc_not_configured' : 'control_plane_not_configured';
    writeLog({
      event: 'ready.check_failed',
      route: '/ready',
      status: 503,
      reason: code,
    });
    setResponseStatus(event, 503);
    return { status: 'not_ready', code };
  }
  return { status: 'ready' };
});
