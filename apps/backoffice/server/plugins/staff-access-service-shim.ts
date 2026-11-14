/**
 * Nitro plugin: mount adapter HTTP vào slot Service Binding `STAFF_ACCESS_SERVICE`
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
 * - `backofficeStaffAccessServiceUrl` rỗng/undefined ⇒ không mount ⇒
 *   `staffAccessClientConfig(env)` đọc `STAFF_ACCESS_SERVICE` từ
 *   `event.context.cloudflare.env` (qua `readWorkerEnv`) thấy `null` ⇒ mọi
 *   caller `binding_missing` — production không đặt biến này, nên hành vi
 *   production không đổi.
 *
 * Hook `request` của Nitro chạy trước middleware và router, nên mọi route đọc
 * `useRuntimeConfig(event)` sau hook này đều thấy shim đã mount.
 *
 * ⚠️ Plugin này là glue. Toàn bộ luật (khi nào mount, shape nào hợp lệ) nằm ở
 * file này + `server/lib/staff-access-client.ts` (xem `staffAccessClientConfig`
 * đọc binding từ `env` qua `readWorkerEnv`).
 *
 * Lưu ý: backoffice đọc binding qua `event.context.cloudflare.env`
 * (`readWorkerEnv`), KHÔNG qua `useRuntimeConfig(event).cloudflare.env`
 * (preset `cloudflare-module` của Nitro 2.13.4 không populate khoá đó — xem
 * JSDoc `server/db.ts`). Plugin gán trực tiếp vào `event.context.cloudflare.env`
 * để shim nhìn thấy được từ `staffAccessClientConfig`.
 */

import {
  AUTHZ_PROJECTION_CUTOVER_ENV,
  STAFF_ACCESS_SECRET_ENV,
  STAFF_ACCESS_SERVICE_BINDING_NAME,
} from '@ecoma-io/backoffice-infrastructure';
import type { StaffServiceBinding } from '@ecoma-io/backoffice-infrastructure';

export function httpStaffAccessServiceBinding(params: {
  origin: string;
  fetchImpl?: typeof fetch;
}): StaffServiceBinding {
  return {
    fetch: (input, init) => {
      const incoming = new URL(input.url);
      const target = new URL(params.origin);
      const rewritten = new URL(`${target.origin}${incoming.pathname}${incoming.search}`);

      const forwarded = new Request(rewritten, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        redirect: 'manual',
        duplex: 'half',
      } as RequestInit);

      const doFetch = params.fetchImpl ?? fetch;
      return doFetch(forwarded, init);
    },
  };
}

export function mountStaffAccessServiceBinding(params: {
  context: Record<string, unknown>;
  origin: unknown;
  secret?: unknown;
  cutoverAt?: unknown;
}): void {
  if (typeof params.origin !== 'string' || params.origin === '') {
    return;
  }

  const cloudflare = (params.context['cloudflare'] ?? {}) as {
    env?: Record<string, unknown>;
  };
  const env = cloudflare.env ?? {};

  // Nitro's node-server preset không tạo Cloudflare context. Tạo một env
  // container chỉ cho local adapter; Workers cung cấp binding environment
  // thật nên đi qua nhánh hiện hữu bên dưới.
  if (!cloudflare.env) {
    if (typeof process === 'undefined' || !process.versions?.node) {
      return;
    }
    cloudflare.env = env;
    params.context['cloudflare'] = cloudflare;
  }

  if (typeof params.secret === 'string' && params.secret !== '') {
    env[STAFF_ACCESS_SECRET_ENV] ??= params.secret;
  }

  // Mốc cutover authorization (issue #241) — biến container của deploy layer
  // được forward vào env container để `readWorkerEnv` thấy được trên preset
  // node-server, cùng cơ chế với secret ở trên. Workers đọc var của chính
  // env nên không cần đường này. Vắng biến ⇒ gate đóng ⇒ legacy vẫn authority.
  if (typeof params.cutoverAt === 'string' && params.cutoverAt !== '') {
    env[AUTHZ_PROJECTION_CUTOVER_ENV] ??= params.cutoverAt;
  }

  // Binding thật của Workers (hoặc một shim đã mount trên chính event này)
  // — giữ nguyên, không ghi đè.
  if (env[STAFF_ACCESS_SERVICE_BINDING_NAME]) {
    return;
  }

  env[STAFF_ACCESS_SERVICE_BINDING_NAME] = httpStaffAccessServiceBinding({
    origin: params.origin,
  });
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    // Backoffice đọc binding qua `event.context.cloudflare.env` (xem
    // `readWorkerEnv` của `server/db.ts`), không qua
    // `useRuntimeConfig(event).cloudflare.env`. Gán trực tiếp vào đây để
    // shim nhìn thấy được từ `staffAccessClientConfig`.
    const context = event.context as Record<string, unknown>;
    const config = useRuntimeConfig(event) as Record<string, unknown>;

    mountStaffAccessServiceBinding({
      context,
      origin: config.backofficeStaffAccessServiceUrl,
      secret:
        typeof process !== 'undefined' && process.versions?.node
          ? process.env[STAFF_ACCESS_SECRET_ENV]
          : undefined,
      cutoverAt:
        typeof process !== 'undefined' && process.versions?.node
          ? process.env[AUTHZ_PROJECTION_CUTOVER_ENV]
          : undefined,
    });
  });
});
