/**
 * Nitro plugin: mount adapter HTTP vào slot Service Binding `STAFF_ACCESS_SERVICE`
 * trên preset `node-server` (local Docker lane) — chiều account → staff-access
 * của đường verdict phát lời mời (ADR-0033 Quyết định 3).
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
 * - `staffAccessServiceUrl` rỗng/undefined ⇒ không mount ⇒
 *   `staffAccessServiceBinding()` trả `null` ⇒ `authorizeInvitationIssuance`
 *   trả `authorization_surface_not_configured` (503 có lý do đọc được, không
 *   phải 503 mù) — production không đặt biến này, nên hành vi production
 *   không đổi.
 *
 * Secret của path này KHÔNG đi qua plugin: nó là giá trị `NUXT_*` của runtime
 * config (`staffAccessInternalAuthSecret`), `applyEnv` nối như mọi key private
 * khác trên cả hai preset. Plugin chỉ nuôi function `fetch` — thứ duy nhất mà
 * envmap JSON không chứa được.
 *
 * Hook `request` của Nitro chạy trước middleware và router, nên mọi route đọc
 * `useRuntimeConfig(event)` sau hook này đều thấy shim đã mount. Cùng cấu trúc
 * với `auth-service-shim.ts` (chiều account → auth) và
 * `staff-access-service-shim.ts` của backoffice (nguồn mẫu của issue #260).
 *
 * ⚠️ Nitro đăng ký **mọi** file trong `server/plugins/` làm plugin — adapter
 * HTTP phải sống trong chính file này (không tách module, khác `auth-service-shim`
 * vì file đó nằm ở `server/utils/`), nếu không Rollup import file thiếu
 * `default` export là lỗi build.
 *
 * ⚠️ Plugin này là glue. Toàn bộ luật (khi nào mount, shape nào hợp lệ) nằm ở
 * `server/lib/staff-access-client.ts` và `server/utils/config-validation.ts`.
 */

import {
  STAFF_ACCESS_SERVICE_BINDING_NAME,
  staffAccessServiceBinding,
} from '../lib/staff-access-client';

/**
 * Dựng một binding `STAFF_ACCESS_SERVICE` chuyển tiếp qua HTTP tới `origin`.
 *
 * `fetchImpl` là tham số test seam — production dùng `globalThis.fetch`; test
 * truyền một stub ghi lại request để assert trên những gì shim gửi đi mà không
 * cần mạng thật.
 *
 * @param params.origin - Origin của worker staff-access (vd
 *   `http://ecoma-staff-access:4206`), không path cuối. Chỉ `protocol` + `host`
 *   + `port` được dùng: path và query của request đến giữ nguyên, vì envelope
 *   HMAC ký trên chính path đó (`/authorization/verdict`) và shim đổi path là
 *   phá chữ ký.
 */
export function httpStaffAccessServiceBinding(params: {
  origin: string;
  fetchImpl?: typeof fetch;
}): { fetch: (input: Request, init?: RequestInit) => Promise<Response> } {
  return {
    fetch: (input, init) => {
      const incoming = new URL(input.url);
      const target = new URL(params.origin);
      // `target.origin` bỏ qua mọi path nằm trong cấu hình — một origin có path
      // thì request vẫn tới đúng root, thay vì resolve tương đối ra URL lạ.
      const rewritten = new URL(`${target.origin}${incoming.pathname}${incoming.search}`);

      // Body stream đi nguyên vẹn: `requestPermissionVerdict` dựng request với
      // body `Uint8Array`, stream mới mỗi lần gọi, không có trạng thái dùng lại.
      // `duplex: 'half'` là yêu cầu của undici khi body là ReadableStream;
      // không nằm trong type `RequestInit` của TS DOM lib nên cast tường minh —
      // cùng cách shim `auth-service-shim.ts` đã ghi.
      // Redirect KHÔNG theo: contract Account↔Staff-Access không dùng redirect,
      // và theo redirect biến shim thành chuyển tiếp tới một đích khác — trả
      // nguyên status của upstream để caller phân loại đúng.
      const forwarded = new Request(rewritten, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        redirect: 'manual',
        duplex: 'half',
      } as RequestInit);

      const doFetch = params.fetchImpl ?? fetch;
      // `init` (chứa `signal` timeout của `requestPermissionVerdict`) đi thẳng
      // vào fetch — mất signal là mất timeout, gọi treo thay vì `unreachable`.
      return doFetch(forwarded, init);
    },
  };
}

/**
 * Mount adapter vào `runtimeConfig` của event hiện tại — hàm thuần export để
 * test được trực tiếp (cùng lý do plugin `config.ts` tách validator khỏi glue).
 */
export function mountStaffAccessServiceBinding(config: unknown): void {
  // Binding thật của Workers (hoặc một shim đã mount trên chính event này)
  // — giữ nguyên, không ghi đè.
  if (staffAccessServiceBinding(config) !== null) {
    return;
  }

  const record = (config ?? {}) as Record<string, unknown>;
  const origin = record['staffAccessServiceUrl'];
  if (typeof origin !== 'string' || origin === '') {
    return;
  }

  // `cloudflare` không nằm trong kiểu `runtimeConfig` tường minh (xem
  // `server/utils/bindings.ts` về lý do đọc qua `unknown` + kiểm hình dạng).
  const cloudflare = record['cloudflare'] as unknown as
    | { env?: Record<string, unknown> }
    | undefined;
  const env = cloudflare?.env;
  if (!env) {
    return;
  }

  env[STAFF_ACCESS_SERVICE_BINDING_NAME] = httpStaffAccessServiceBinding({ origin });
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    mountStaffAccessServiceBinding(useRuntimeConfig(event));
  });
});
