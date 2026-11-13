/**
 * Nitro plugin: mount adapter HTTP vào slot Service Binding `ACCOUNT_SERVICE`
 * trên preset `node-server` (local Docker lane) — đối xứng với
 * `staff-access-service-shim.ts` (pattern đã chứng minh chạy trên lane).
 *
 * ## Vì sao mount theo từng event, không mount một lần lúc boot
 *
 * Cùng lý luận với `staff-access-service-shim.ts`: `useRuntimeConfig(event)`
 * trả bản sao per-event, và backoffice đọc binding qua
 * `event.context.cloudflare.env` (`readWorkerEnv` của `server/db.ts`) — preset
 * `cloudflare-module` của Nitro không populate khoá đó qua runtimeConfig. Gán
 * trực tiếp vào `event.context.cloudflare.env` trong hook `request` là con
 * đường đáng tin duy nhất; chi phí mỗi request là vài property lookup.
 *
 * ## Điều kiện mount — fail-closed giữ nguyên
 *
 * - Binding đã có hình dạng hợp lệ (Workers: binding thật từ `wrangler.jsonc`;
 *   hoặc đã mount ở lần đọc config cache nào đó) ⇒ không đụng.
 * - `backofficeAccountServiceUrl` rỗng/undefined ⇒ không mount ⇒
 *   `accountClientConfig(env)` đọc `ACCOUNT_SERVICE` từ
 *   `event.context.cloudflare.env` (qua `readWorkerEnv`) thấy thiếu ⇒ mọi caller
 *   `binding_missing` ⇒ `/api/onboarding-status` 503, `/api/me` trả
 *   `displayName: null` — đúng trạng thái production khi hạ tầng chưa provision.
 *
 * ## Secret — cặp riêng `ACCOUNT_INTERNAL_SECRET`
 *
 * Container Node local giữ secret của cặp backoffice ↔ staff-access trong
 * `AUTH_INTERNAL_SECRET` (một tên env, một giá trị); secret của cặp backoffice
 * ↔ account là **giá trị khác** (mỗi stack deploy sinh secret độc lập), nên nó
 * đi qua biến container riêng `ACCOUNT_INTERNAL_SECRET` và được nạp vào `env`
 * theo từng request. Workers không có plugin path này: binding thật + secret
 * `AUTH_INTERNAL_SECRET` trong `env` của Worker được dùng như trước (hàm đọc
 * secret của client fallback về tên chung khi biến cặp riêng vắng mặt). Không
 * log secret; giá trị chỉ đi vào closure của hàm ký (`accountClientConfig`).
 */

import {
  ACCOUNT_INTERNAL_SECRET_ENV,
  ACCOUNT_SERVICE_BINDING_NAME,
} from '@ecoma-io/backoffice-infrastructure';
import type { AccountServiceBinding } from '@ecoma-io/backoffice-infrastructure';

export function httpAccountServiceBinding(params: {
  origin: string;
  fetchImpl?: typeof fetch;
}): AccountServiceBinding {
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

export function mountAccountServiceBinding(params: {
  context: Record<string, unknown>;
  origin: unknown;
  secret?: unknown;
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
    env[ACCOUNT_INTERNAL_SECRET_ENV] ??= params.secret;
  }

  // Binding thật của Workers (hoặc một shim đã mount trên chính event này)
  // — giữ nguyên, không ghi đè.
  if (env[ACCOUNT_SERVICE_BINDING_NAME]) {
    return;
  }

  env[ACCOUNT_SERVICE_BINDING_NAME] = httpAccountServiceBinding({
    origin: params.origin,
  });
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    // Backoffice đọc binding qua `event.context.cloudflare.env` (xem
    // `readWorkerEnv` của `server/db.ts`), không qua
    // `useRuntimeConfig(event).cloudflare.env`. Gán trực tiếp vào đây để
    // shim nhìn thấy được từ `accountClientConfig`.
    const context = event.context as Record<string, unknown>;
    const config = useRuntimeConfig(event) as Record<string, unknown>;

    mountAccountServiceBinding({
      context,
      origin: config.backofficeAccountServiceUrl,
      secret:
        typeof process !== 'undefined' && process.versions?.node
          ? process.env[ACCOUNT_INTERNAL_SECRET_ENV]
          : undefined,
    });
  });
});
