import { defineNuxtConfig } from 'nuxt/config';
import type { Nuxt } from 'nuxt/schema';
import tailwindcss from '@tailwindcss/vite';
import { ACCOUNT_LOCALE_DEFINITIONS, DEFAULT_ACCOUNT_LOCALE } from './app/i18n/locale-registry';

/**
 * Module inline đăng ký plugin adapter preview của data domain — **chỉ dưới
 * `nuxt dev`**.
 *
 * Đây là đường **loại trừ ở build graph**, không phải guard runtime với dynamic
 * import: skill `frontend-data-mocking` §H cấm dùng `import()` làm bằng chứng
 * vắng mặt vì lazy chunk vẫn ship trong artifact. Ở đây plugin (và theo đó
 * `preview-adapter.ts`, `mock-adapter.ts`) được push vào `nuxt.options.plugins`
 * **trước khi graph được dựng** khi và chỉ khi `nuxt.options.dev`, nên một
 * artifact đã build không chứa chữ nào của đường mock trong output — điều kiện
 * chấp nhận của Issue #123, được kiểm bởi
 * `tests/integrations/artifact-no-mock.spec.ts`.
 *
 * Plugin tự kiểm mode runtime (`resolveAccountDataMode`) trước khi gắn adapter,
 * nên dev server chạy với `NITRO_PUBLIC_ACCOUNT_DATA_MODE=real` vẫn dùng đường
 * thật; và kể cả khi plugin bị đăng ký nhầm ở artifact, resolver thấy
 * `import.meta.dev = false` và no-op — hai lớp guard độc lập.
 *
 * Cờ này **không** đụng auth: plugin chỉ gắn dữ liệu preview lên slot
 * `$accountAdapter`; `/login` và `/consent` đi BFF thật ở mọi mode.
 */
const registerPreviewDataAdapter = (_options: unknown, nuxt: Nuxt): void => {
  if (!nuxt.options.dev) {
    return;
  }
  nuxt.options.plugins.push({
    src: new URL('./app/account-data/preview-adapter-plugin', import.meta.url).pathname,
    mode: 'all',
  });
};

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-05',
  workspaceDir: '../../',
  devtools: { enabled: true },
  devServer: {
    // Listen trên mọi network interface để mở app từ thiết bị khác (LAN,
    // Tailscale IP) thay vì chỉ loopback. `vite.server.allowedHosts` phải
    // đi kèm: Vite mặc định chỉ nhận `localhost`, `*.localhost` và IP
    // literal, nên mọi tên DNS khác — kể cả MagicDNS `.ts.net` — bị chặn
    // 403. Hardcode hostname không dùng được vì mỗi developer một tailnet.
    // Đánh đổi: dev server không có authentication, ai nối được tới máy dev
    // đều đọc được app, build error và source code. Cả hai key chỉ có tác
    // dụng khi `nuxt.options.dev`, nên build production không đổi.
    host: '0.0.0.0',
    port: 4202,
  },
  typescript: {
    typeCheck: true,
    tsConfig: {
      extends: '../../../tsconfig.base.json', // Nuxt chép nguyên văn chuỗi này sang `./.nuxt/tsconfig.json`, nên nó phải là đường dẫn tương đối so với thư mục đó
    },
  },
  imports: {
    autoImport: true,
  },
  css: ['~/assets/css/styles.css'],
  modules: ['@nuxt/fonts', '@nuxtjs/i18n', registerPreviewDataAdapter],

  i18n: {
    // Không tiền tố locale trong URL: `/emails` là `/emails` ở cả ba ngôn ngữ.
    // Đây là yêu cầu sản phẩm của app tài khoản (địa chỉ phải giữ được khi đổi
    // ngôn ngữ), **không** phải lựa chọn kỹ thuật cho tiện — vì vậy nó đặt ở
    // đây chứ không phải ở từng route.
    strategy: 'no_prefix',

    // Không suy ra locale từ `Accept-Language`. Không có lựa chọn tường minh và
    // không có preference đã lưu thì app vẫn là tiếng Anh; `defaultLocale` ở
    // dưới là nguồn sự thật của quy tắc đó và nó **là** giá trị trong registry
    // (`DEFAULT_ACCOUNT_LOCALE`), không phải chuỗi viết lại lần nữa.
    detectBrowserLanguage: false,
    defaultLocale: DEFAULT_ACCOUNT_LOCALE,

    // `language` là BCP-47 cho `<html lang>`; với `zh-CN` nó là `zh-Hans`, khác
    // `code`. Trộn hai khái niệm này là lỗi thường gặp — xem
    // `app/i18n/locale-registry.ts`.
    //
    // ⚠️ **Không khai `file`.** Message đã nối vào `vue-i18n.config.ts`, và khai
    // `file` thêm cho mỗi locale sẽ tạo ra một nguồn message thứ hai cho cùng một
    // locale. Hai nguồn là hai cây key, chúng trôi khỏi nhau ngay khi ai đó
    // thêm key mới ở một bên — đúng cái lỗi mà `catalogs.spec.ts` sinh ra để
    // bắt, và ở đây là lỗi do config tự tạo ra.
    locales: ACCOUNT_LOCALE_DEFINITIONS.map(({ code, language, label }) => ({
      code,
      language,
      name: label,
    })),

    // Đường dẫn tương đối từ `restructureDir` (`<rootDir>/i18n`). Module tự quét
    // `i18n.config.ts` nếu bỏ trống, nhưng file của ta nằm trong `app/i18n/`
    // cùng chỗ với registry và ba catalog — chỉ định tường minh để một đổi tên
    // file sau này không âm thầm đổi sang config rỗng.
    restructureDir: 'app/i18n',
    vueI18n: './vue-i18n.config.ts',
  },

  // Alias tường minh cho `@ecoma-io/*` — **bắt buộc**, không phải tuỳ chọn.
  //
  // `tsconfig.base.json` có `paths: {}` rỗng và `vite.resolve.tsconfigPaths` chỉ
  // đọc `paths`, nên cả hai cùng không map gì cho `@ecoma-io/account-domain` /
  // `@ecoma-io/account-contracts` / `@ecoma-io/auth-contracts`. Hệ quả đã quan
  // sát được: Vite resolve `@ecoma-io/*` **không** được ở runtime, nên import
  // trong `server/` chỉ nổ ở request đầu tiên chạm tới route đó (dev 500,
  // production 500 theo cold start).
  //
  // Vì sao không sửa `tsconfig.base.json`: đó là file dùng chung của **mọi** app,
  // nên thêm `paths` ở đó là thay đổi ngoài phạm vi app này — và app nào không có
  // Nuxt/Vite resolver tương ứng vẫn không được lợi. `nuxt.config.ts` của chính app
  // là nơi duy nhất chịu trách nhiệm resolve được alias của app mình.
  alias: {
    // `import.meta.url` chứ không phải `node:path`: `.oxlintrc.json` cấm import Node
    // builtin trong `apps/**`, và `nuxt.config.ts` khớp glob đó. `new URL(x,
    // import.meta.url).pathname` cho đường dẫn tuyệt đối mà không cần `resolve`.
    '@ecoma-io/account-domain': new URL('../../libs/account-domain/src/index.ts', import.meta.url)
      .pathname,
    '@ecoma-io/account-contracts': new URL(
      '../../libs/account-contracts/src/index.ts',
      import.meta.url,
    ).pathname,
    '@ecoma-io/auth-contracts': new URL('../../libs/auth-contracts/src/index.ts', import.meta.url)
      .pathname,
    '@ecoma-io/transactional-mail-contracts': new URL(
      '../../libs/transactional-mail-contracts/src/index.ts',
      import.meta.url,
    ).pathname,
  },

  runtimeConfig: {
    // Private runtime config — chỉ server đọc được, không nhúng vào payload.
    //
    // Nuxt đổi tên sang convention `NUXT_*`: `internalHmacSecret` ←
    // `NUXT_INTERNAL_HMAC_SECRET`. Cùng một tên biến phục vụ Worker Secret ở
    // production và `.env` khi `pnpm dev`, nên không có chỗ nào trong code tự đọc
    // `process.env` cho config.
    //
    // ⚠️ KHÔNG đặt giá trị mặc định ở đây. Default rỗng biến "chưa cấu hình" thành
    // "chạy được với secret rỗng", mà internal HMAC với secret rỗng thì **chấp nhận
    // mọi chữ ký**. `server/plugins/config.ts` kiểm lúc khởi động và `throw` — đó mới
    // là fail closed.
    internalHmacSecret: '',
    // `kid` của `internalHmacSecret` — rỗng ⇒ chưa bật `kid` (transition). Có ⇒ mọi
    // envelope đi ra gắn `x-ecoma-internal-kid` (hướng `account → auth`) và mọi envelope
    // đi vào có `kid` được tra qua registry (xem `config-validation.ts`). Cùng luật
    // `NUXT_*` ở trên; không default, sai hình dạng thì validate throw lúc request đầu.
    internalHmacKid: '',
    // Cặp **verify-only** — tuỳ chọn, cả hai cùng được đặt hoặc cùng vắng mặt: chỉ dùng
    // để **verify** envelope có `kid` = `internalHmacPreviousKid`, không bao giờ để ký.
    //
    // ⚠️ Đây là slot "verify-only", KHÔNG phải slot "khoá cũ": khi xoay secret nó chứa
    // khoá **mới** trong pha nạp trước, rồi khoá **cũ** trong pha overlap — cùng một cặp
    // biến, hai ý nghĩa khác nhau theo giai đoạn. Runbook: `docs/applications/auth/03-operations.md` §3.3.
    internalHmacPreviousSecret: '',
    internalHmacPreviousKid: '',
    // Secret HMAC cho digest mã OTP (`server/lib/otp.ts`). Cùng luật với
    // `internalHmacSecret`: không default, thiếu/qua ngắn thì validate throw —
    // một digest OTP với key rỗng hay key ngắn không còn là keyed digest.
    otpHmacSecret: '',
    // Origin của transactional-mail cho `POST /v1/messages` (không path cuối).
    // Rỗng = chưa cấu hình; luồng OTP fail-closed ở lần gửi (`server/lib/mail.ts`)
    // chứ không tự gọi provider — `account` không giữ provider credential.
    mailServiceUrl: '',
    // Credential HMAC ký cho path Account↔Mail (`POST /v1/messages`).
    //
    // ⚠️ **Không dùng chung `internalHmacSecret`.** Receiver suy ra principal từ
    // credential đã khớp (`apps/transactional-mail/src/internal-auth.ts`); secret của
    // path này là entry `MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT` trong registry của
    // receiver, khác entry của path Account↔Auth ở receiver kia. Tái sử dụng một
    // secret cho hai path là lỗi cấu hình mà không gì bắt được cho tới khi chữ ký
    // lệch ở production.
    //
    // Cùng luật `NUXT_*` ở trên: không default, thiếu ⇒ validate throw ở request
    // đầu (fail-closed, không có "gửi unsigned" để receiver từ chối).
    mailInternalAuthSecret: '',
    // Credential HMAC ký cho path Account↔Staff-Access (`POST /authorization/verdict`,
    // ADR-0033 Quyết định 3).
    //
    // ⚠️ **Không dùng chung `internalHmacSecret`** — cùng lý do
    // `mailInternalAuthSecret`: giá trị phải là secret mà `staff-access` verify
    // (`AUTH_INTERNAL_SECRET` của nó), là một entry riêng trong registry của
    // receiver. Cùng luật `NUXT_*`: không default, thiếu ⇒ cổng verdict trả
    // `unavailable` với reason `authorization_surface_not_configured` ⇒ route phát
    // lời mời 503 fail-closed (không có đường nào phát mà không có verdict).
    staffAccessInternalAuthSecret: '',
    // Origin HTTP của worker `staff-access` cho adapter Service Binding
    // `STAFF_ACCESS_SERVICE` trên preset `node-server` (local lane) — cùng cơ
    // chế với `authServiceUrl` bên trên. Rỗng = chưa cấu hình ⇒ shim không
    // mount ⇒ `staffAccessServiceBinding()` trả `null` ⇒ mọi hỏi verdict
    // fail-closed `authorization_surface_not_configured`, đúng trạng thái
    // production khi hạ tầng chưa provision (production Workers dùng binding
    // thật qua `__env__`, không đặt biến này).
    //
    // ## Vì sao key này phải nằm ở đây
    //
    // Envmmap của Nitro (`applyEnv`) chỉ merge vào các key CÓ SẴN trong object
    // inline (đã đo ở `NUXT_CLOUDFLARE_ENV` của chính file này) — không khai key
    // thì biến `NUXT_STAFF_ACCESS_SERVICE_URL` của deploy layer không bao giờ
    // chạm được tới runtimeConfig.
    staffAccessServiceUrl: '',
    // Cửa sổ skew (giây) của envelope HMAC; rỗng ⇒ `verifyRequest` dùng mặc định
    // 300s. Để trống chứ không đặt số ở đây để chỉ có **một** nơi định nghĩa mặc định
    // (trong `internal-auth-contracts`) — tránh hai nguồn sự thật cho cùng một luật.
    internalAuthSkewSeconds: '',
    // Adapter HTTP cho Service Binding `AUTH_SERVICE` — CHỈ preset `node-server`
    // (local Docker lane). Rỗng = chưa cấu hình ⇒ không mount gì ⇒
    // `authServiceBinding()` trả `null` ⇒ mọi gọi auth fail-closed
    // `binding_missing`, đúng trạng thái production khi hạ tầng chưa provision.
    //
    // ## Vì sao không nhét binding vào `NUXT_CLOUDFLARE_ENV`
    //
    // Envmmap của Nitro (`applyEnv` + `destr`) parse giá trị biến từ **JSON** —
    // JSON không chứa được function, mà `authServiceBinding()` bắt buộc entry
    // có `fetch` là function. Binding thật (Workers) và shim (local) đều là
    // function `fetch`, nên đường duy nhất để "nuôi" binding trên Node server
    // là một Nitro plugin mount lúc runtime (`server/plugins/auth-service-shim.ts`)
    // đọc origin từ đây. Code app chỉ chứa **tên** binding; origin nằm trong
    // env của deployment layer — cùng invariant với `NUXT_MAIL_SERVICE_URL`.
    //
    // Production (Workers) không đặt `NUXT_AUTH_SERVICE_URL`: binding thật được
    // nạp qua `__env__`, plugin thấy binding đã có hình dạng hợp lệ và no-op.
    authServiceUrl: '',
    // Origin của worker auth mà BFF dựng URL browser cho nó (`/authorize/confirm`
    // sau khi mã OTP được chấp nhận — §5.1.2 hàng 7 của
    // `docs/applications/auth/01-architecture.md`). Rỗng = chưa cấu hình ⇒ verify
    // không cấp `confirmUrl` (luồng có handle fail-closed ở bước cuối, người dùng
    // thấy trạng thái "không tiếp tục được"); luồng đăng nhập account thuần
    // không bao giờ đọc key này. Cùng luật `NUXT_*` ở trên: không default, được
    // đặt thì phải là origin http(s) không mang path — một path tại đây là lỗi
    // cấu hình lộ ở lần dựng URL đầu (`server/utils/config-validation.ts`).
    authIssuer: '',
    // Binding container của Cloudflare — preset `cloudflare-module` tự nạp qua
    // `globalThis.__env__` (production) và `getPlatformProxy` (dev), Nuxt core
    // không đụng vào key này. Khai báo ở đây để preset `node-server` (local Docker)
    // có "chốt" mà envmap đổ vào: biến `NUXT_CLOUDFLARE_ENV` chứa JSON object
    // (ví dụ `{"DB_ACCOUNT":{"connectionString":"..."}}`) được merge vào
    // `cloudflare.env` lúc khởi động. Không đặt biến ⇒ object rỗng ⇒
    // `accountHyperdrive()` trả `null` ⇒ `/ready` 503 — fail-closed giữ nguyên.
    // Production (Workers) không đọc `NUXT_CLOUDFLARE_ENV` nào cả: `__env__` ghi đè
    // bằng binding thật, nên khai báo này là additive và không đổi hành vi.
    cloudflare: {
      env: {},
    },
    // Seam chế độ dữ liệu của data domain — đọc ở phía app qua
    // `runtimeConfig.public`, cùng nguồn với payload mà client hydrate, nên SSR
    // và client không thể lệch nhau. Khai ở đây (không phải `nitro.config.ts`)
    // vì cùng lý do với `public` của backoffice.
    //
    // Giá trị runtime đến từ `NITRO_PUBLIC_ACCOUNT_DATA_MODE` (Nitro `applyEnv`
    // phủ lên giá trị build-time dưới đây). Hai giá trị hợp lệ là `mock` và
    // `real` — tập giá trị chỉ được khai ở `app/account-data/data-mode.ts`.
    //
    // ⚠️ Default là chuỗi rỗng = "chưa cấu hình", KHÔNG phải một giá trị mode:
    // chính resolver (`resolveAccountDataMode`) quyết định theo môi trường —
    // `nuxt dev` ⇒ `mock`, artifact đã build ⇒ `real`. Một default tĩnh `mock`
    // ở đây sẽ chảy vào artifact (vi phạm fail-closed), còn default tĩnh `real`
    // thì giết luôn mock ở dev. Rỗng là giá trị duy nhất trung tính với cả hai
    // môi trường — cùng quy ước với các key private phía trên.
    public: {
      accountDataMode: '',
    },
  },

  nitro: {
    // `pg` được **bundle** vào Worker, không external: preset `cloudflare-module`
    // chạy trong isolate của Cloudflare nên `node:*` không tồn tại ở đó.
    alias: {
      // ⚠️ Bắt buộc, xem `server/lib/pg-native.cjs` về lý do. Tóm tắt:
      // `pg/lib/native/client.js` `require('pg-native')` — optional dependency mà
      // Node nuốt lỗi được, còn Rollup của Nitro thì fail build. Preset bật
      // `noExternals` nên `nitro.externals` **không** được đọc; `nitro.alias` thì có,
      // vì nó chạy trước resolver trong plugin `alias` của rollup.
      'pg-native': new URL('./server/lib/pg-native.cjs', import.meta.url).pathname,
    },
  },

  vite: {
    resolve: { tsconfigPaths: true },
    server: { allowedHosts: true },
    plugins: [tailwindcss()],
  },
});
