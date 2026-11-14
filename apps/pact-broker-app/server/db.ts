/**
 * Đọc `env` của Worker và nguồn connection string PostgreSQL của
 * `pact-broker-app` — cùng đường `apps/backoffice/server/db.ts` (deliberate
 * duplication giữa hai deploy unit; module boundary cấm import chéo,
 * 05-code-architecture.md §7).
 *
 * Hai nguồn, đúng thứ tự ưu tiên:
 * - **Workers** (production/staging): binding Hyperdrive `DB_PACT_BROKER_APP`
 *   đọc từ `event.context.cloudflare.env` (preset `cloudflare-module` của
 *   Nitro **không** populate `runtimeConfig.cloudflare` — đo trên bundle thật
 *   ở `apps/backoffice/server/db.ts`; đường `useRuntimeConfig().cloudflare`
 *   luôn `undefined`).
 * - **Node container local**: connection string thẳng qua runtimeConfig private
 *   `pactBrokerAppDatabaseUrl` ← `NITRO_PACT_BROKER_APP_DATABASE_URL`.
 *
 * `null` khi không có nguồn nào — caller fail closed (`503`).
 */

import type { H3Event } from 'h3';

import { pactBrokerAppHyperdrive, pactBrokerAppNodeDatabaseUrl } from './auth/session';

/**
 * Đọc `env` của Worker ra khỏi context của request — `undefined` khi request
 * không đi qua preset Cloudflare (test dựng h3 app trực tiếp).
 *
 * ⚠️ Đường đọc là `event.context.cloudflare.env`, **không phải**
 * `useRuntimeConfig(event).cloudflare.env` — chi tiết Nitro đã đo ở
 * `apps/backoffice/server/db.ts`, giữ nguyên ở đây.
 */
export function readWorkerEnv(event: H3Event): unknown {
  const context = event.context as Record<string, unknown>;
  const platform = context['cloudflare'] as { env?: unknown } | undefined;
  return platform?.env;
}

/**
 * Nguồn connection string PostgreSQL của request — Hyperdrive trước, runtime
 * Node local sau; `null` khi không có nguồn nào.
 *
 * ⚠️ `useRuntimeConfig` là auto-import của Nitro (không có trong `h3`): ghi
 * import tường minh từ 'h3' là `undefined` lúc chạy ⇒ nhánh Node chết 503 vĩnh
 * viễn. Gọi như global auto-import, bọc try cho môi trường không có
 * runtimeConfig (test dựng app trực tiếp).
 */
export function poolBinding(event: H3Event): { connectionString: string } | null {
  const hyperdrive = pactBrokerAppHyperdrive(readWorkerEnv(event));
  if (hyperdrive !== null) {
    return { connectionString: hyperdrive.connectionString };
  }
  try {
    const url = pactBrokerAppNodeDatabaseUrl(useRuntimeConfig(event));
    if (url !== null) {
      return { connectionString: url };
    }
  } catch {
    // Không có runtimeConfig (test dựng app trực tiếp) ⇒ rơi về `null`.
  }
  return null;
}
