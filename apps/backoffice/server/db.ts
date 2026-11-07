/**
 * Đọc `env` của Worker ra khỏi context của request — phần **duy nhất** của
 * lớp truy cập DB cũ (`db.ts` trước tách layer) phụ thuộc `h3` ({@link H3Event}).
 *
 * Mọi phần framework-agnostic (đọc binding Hyperdrive, dựng pool `pg` theo
 * giới hạn Hyperdrive, đường pool Node local) đã chuyển sang
 * `@ecoma-io/backoffice-infrastructure`; caller ở đây đọc `env`/runtimeConfig
 * từ request rồi truyền **giá trị thường** vào các hàm của lib
 * (`backofficeHyperdrive`, `withBackofficePool`, `backofficeNodeDatabaseUrl`).
 *
 * ## Vì sao hàm này nằm ở app, không ở lib
 *
 * `H3Event` là kiểu của h3 — một lib `type:infrastructure` không được ràng buộc
 * vào framework serving của một app (`libs/backoffice-infrastructure` chạy được
 * với bất kỳ caller nào có `env`, kể cả Worker không h3). Đường đọc `_platform`
 * dưới đây lại là chi tiếtNitro/h3 (`event.context.cloudflare.env`), nên nó ở
 * đúng chỗ của nó: composition layer.
 */

import type { H3Event } from 'h3';

import {
  backofficeHyperdrive,
  backofficeNodeDatabaseUrl,
} from '@ecoma-io/backoffice-infrastructure';

/**
 * Đọc `env` của Worker ra khỏi context của request.
 *
 * ⚠️ **Không** đọc binding qua `useRuntimeConfig(event).cloudflare.env` như
 * `apps/account` làm: preset `cloudflare-module` của Nitro 2.13.4 **không**
 * populate `runtimeConfig.cloudflare` (config inline của `useRuntimeConfig` chỉ
 * có `app`/`nitro`/`appSecret`/`public`), nên đường đó luôn trả `undefined` và
 * mọi route sẽ fail closed vô ích. Đo trên bundle thật: `useRuntimeConfig(e)`
 * resolve `e.context.nitro.runtimeConfig` từ `ir` — không có khoá `cloudflare`.
 *
 * `env` của Worker đi vào request qua `_platform`:
 * `nitropack/dist/presets/cloudflare/runtime/_module-handler.mjs` truyền
 * `_platform.cloudflare = { request, env, context, url }`, và
 * `nitropack/dist/runtime/internal/app.mjs` (`onRequest`) trải `_platform` ra
 * `event.context` — nên `event.context.cloudflare.env` là `env` thật của Worker.
 *
 * @returns `env` của Worker, hoặc `undefined` khi request không đi qua preset
 *   Cloudflare (ví dụ test dựng h3 app trực tiếp).
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
 * ## Vì sao hàm này nằm chung chỗ với `readWorkerEnv`
 *
 * Trước đây logic này bị **nhân bản thành ba bản** với độ phủ lệch nhau:
 * middleware authn và callback có nhánh Node fallback, còn khung
 * `withReadEnforcement` của 3 read route **chỉ** nhìn Hyperdrive — local chạy
 * container Node (không có Hyperdrive) thì cả 3 route đọc trả `503` trước khi
 * chạm SQL (đỏ thật ở suite `backoffice-access-control-e2e`). Gom về một hàm
 * là xóa đúng lớp sai số mà JSDoc của `read-route.ts` gọi tên: "ba bản sao của
 * đường đi giống nhau là ba chỗ để quên một nhánh".
 *
 * Thứ tự nguồn giữ nguyên của middleware authn (đồng quan điểm với
 * readiness): binding Hyperdrive là nguồn Workers; container Node local nối
 * thẳng PostgreSQL qua `NITRO_BACKOFFICE_DATABASE_URL` (runtimeConfig private
 * `backofficeDatabaseUrl`).
 *
 * @returns `{ connectionString }`, hoặc `null` — caller fail closed (`503`).
 */
export function poolBinding(event: H3Event): { connectionString: string } | null {
  const hyperdrive = backofficeHyperdrive(readWorkerEnv(event));
  if (hyperdrive !== null) {
    return { connectionString: hyperdrive.connectionString };
  }
  try {
    // ⚠️ `useRuntimeConfig` là auto-import của Nitro (không có trong `h3` —
    // hàm này chỉ nằm ở `nitropack/runtime/internal/config`): ghi import tường
    // minh từ 'h3' là `undefined` lúc chạy ⇒ nhánh Node chết 503 vĩnh viễn.
    // Gọi như global auto-import, đồng bộ với các bản sao trước đây.
    const url = backofficeNodeDatabaseUrl(useRuntimeConfig(event));
    if (url !== null) {
      return { connectionString: url };
    }
  } catch {
    // Không có runtimeConfig (test dựng app trực tiếp) ⇒ rơi về `null`.
  }
  return null;
}
