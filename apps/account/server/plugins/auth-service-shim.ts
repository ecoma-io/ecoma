/**
 * Nitro plugin: mount adapter HTTP vào slot Service Binding `AUTH_SERVICE`
 * trên preset `node-server` (local Docker lane).
 *
 * ## Vì sao mount theo từng event, không mount một lần lúc boot
 *
 * `useRuntimeConfig(event)` của Nitro trả về một **bản sao per-event** của
 * runtime config (klona + applyEnv, cache trên `event.context.nitro`), còn bản
 * dùng chung lúc boot bị deep-freeze. Gán vào bản per-event trong hook
 * `request` là con đường đáng tin duy nhất không đụng internals của Nitro —
 * và nó lặp lại đúng đối xứng của preset Workers, nơi binding thật cũng được
 * nối vào config theo từng event. Chi phí mỗi request là một property lookup.
 *
 * ## Điều kiện mount — fail-closed giữ nguyên
 *
 * - Binding đã có hình dạng hợp lệ (Workers: binding thật; hoặc đã mount ở
 *   lần đọc config cache nào đó) ⇒ không đụng.
 * - `authServiceUrl` rỗng/undefined ⇒ không mount ⇒ `authServiceBinding()`
 *   trả `null` ⇒ mọi caller `binding_missing` — production không đặt biến này,
 * nên hành vi production không đổi.
 *
 * Hook `request` của Nitro chạy trước middleware và router, nên mọi route đọc
 * `useRuntimeConfig(event)` sau hook này đều thấy shim đã mount. Validation
 * hình dạng origin nằm ở `server/utils/config-validation.ts` (request đầu,
 * fail-closed 503) — plugin này chỉ mount, không nhân đôi luật.
 *
 * ⚠️ Plugin này là glue. Toàn bộ luật (khi nào mount, shape nào hợp lệ) nằm ở
 * `auth-service-shim.ts` + `config-validation.ts`; đặt logic vào plugin sẽ
 * không test được mà không dựng cả runtime — cùng lý do với
 * `server/plugins/config.ts`.
 */

import { AUTH_SERVICE_BINDING_NAME, authServiceBinding } from '../lib/auth-client';
import { httpAuthServiceBinding } from '../utils/auth-service-shim';

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    const config = useRuntimeConfig(event);

    // Binding thật của Workers (hoặc một shim đã mount trên chính event này)
    // — giữ nguyên, không ghi đè.
    if (authServiceBinding(config) !== null) {
      return;
    }

    const origin = config.authServiceUrl;
    if (typeof origin !== 'string' || origin === '') {
      return;
    }

    // `cloudflare` không nằm trong kiểu `runtimeConfig` tường minh (xem
    // `server/utils/bindings.ts` về lý do đọc qua `unknown` + kiểm hình dạng).
    const cloudflare = config.cloudflare as unknown as
      | { env?: Record<string, unknown> }
      | undefined;
    const env = cloudflare?.env;
    if (!env) {
      return;
    }

    env[AUTH_SERVICE_BINDING_NAME] = httpAuthServiceBinding({ origin });
  });
});
