/**
 * Adapter HTTP cho Service Binding `AUTH_SERVICE` trên preset `node-server`
 * (local Docker lane) — chiều account → auth của topology local
 * (`docs/architecture/local-development/02-account-auth-topology.md` §Service bindings: "Nitro
 * adapter fetch thẳng `http://ecoma-<ns>-auth:4203`").
 *
 * ## Vì sao shim tồn tại
 *
 * Contract thật của `account` gọi `auth` là binding Worker:
 * `env.AUTH_SERVICE.fetch(request, init)` (`server/lib/auth-client.ts`). Trên
 * Workers preset, Nitro nối binding thật vào `runtimeConfig.cloudflare.env`
 * theo từng event — không có gì để làm. Trên `node-server` không có workerd:
 * envmap `NUXT_CLOUDFLARE_ENV` đi qua `applyEnv` + `destr`, tức giá trị phải
 * là **JSON** — và JSON không chứa được function `fetch` mà
 * `authServiceBinding()` bắt buộc. Adapter duy nhất đúng invariant là một
 * object binding dựng lúc **runtime** (nơi function tồn tại được), chuyển tiếp
 * fetch qua HTTP thuần tới worker auth trong WIC:
 *
 *   account (Nitro node-server) → binding AUTH_SERVICE (shim) → HTTP → ecoma-auth
 *
 * Shape binding giữ nguyên 100% — route gọi `authServiceBinding(config)` thấy
 * cùng một hình dạng trên cả hai preset, không biết (và không cần biết) nó
 * đang nói chuyện với binding thật hay shim. Bên trong là HTTP plain qua Docker
 * network nội bộ, đúng ngữ nghĩa service binding production (binding không
 * cung cấp TLS); bảo mật lớp application là envelope HMAC `ecoma-internal-v1`
 * mà `auth-client` đã ký **trước khi** request vào binding — shim KHÔNG ký
 * thêm gì, KHÔNG giữ khoá, chỉ thay protocol + authority của URL.
 *
 * ## Fail-closed
 *
 * Shim này không tự đọc env: origin được truyền vào từ plugin mount
 * (`server/plugins/auth-service-shim.ts`), nguồn là `runtimeConfig.authServiceUrl`
 * (biến `NUXT_AUTH_SERVICE_URL` qua envmap). Biến rỗng ⇒ plugin không mount ⇒
 * `authServiceBinding()` trả `null` ⇒ mọi caller `binding_missing` — cùng
 * trạng thái production khi hạ tầng chưa provision. Không có default nào trỏ
 * loopback hay hostname đoán: một default sai là đúng kiểu "chạy được nhưng
 * sai nơi" mà thiết kế cấm.
 */

import type { AuthServiceBinding } from '../lib/auth-client';

/**
 * Dựng một binding `AUTH_SERVICE` chuyển tiếp qua HTTP tới `origin`.
 *
 * `fetchImpl` là tham số test seam — production dùng `globalThis.fetch`; test
 * truyền một stub ghi lại request để assert trên những gì shim gửi đi mà không
 * cần mạng thật.
 *
 * @param params.origin - Origin của worker auth (vd `http://ecoma-w0123456789ab-auth:4203`),
 *   không path cuối. Chỉ `protocol` + `host` + `port` được dùng: path và query
 *   của request đến giữ nguyên, vì envelope HMAC ký trên chính path đó
 *   (`/internal/session/verified`...) và shim đổi path là phá chữ ký.
 */
export function httpAuthServiceBinding(params: {
  origin: string;
  fetchImpl?: typeof fetch;
}): AuthServiceBinding {
  return {
    fetch: (input, init) => {
      const incoming = new URL(input.url);
      const target = new URL(params.origin);
      // `target.origin` bỏ qua mọi path nằm trong cấu hình — một origin có path
      // thì request vẫn tới đúng root, thay vì resolve tương đối ra URL lạ.
      const rewritten = new URL(`${target.origin}${incoming.pathname}${incoming.search}`);

      // Body stream đi nguyên vẹn: `auth-client` dựng request với body
      // `Uint8Array`, stream mới mỗi lần gọi, không có trạng thái dùng lại.
      // `duplex: 'half'` là yêu cầu của undici khi body là ReadableStream;
      // không nằm trong type `RequestInit` của TS DOM lib nên cast tường minh —
      // cùng cách shim chiều ngược `tools/account-bridge` đã ghi.
      // Redirect KHÔNG theo: contract Account↔Auth không dùng redirect, và
      // theo redirect biến shim thành chuyển tiếp tới một đích khác — trả
      // nguyên status của upstream để caller phân loại đúng.
      const forwarded = new Request(rewritten, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        redirect: 'manual',
        duplex: 'half',
      } as RequestInit);

      const doFetch = params.fetchImpl ?? fetch;
      // `init` (chứa `signal` timeout của `auth-client`) đi thẳng vào fetch —
      // mất signal là mất timeout, gọi treo 3 phút thay vì `unreachable` sau 3s.
      return doFetch(forwarded, init);
    },
  };
}
