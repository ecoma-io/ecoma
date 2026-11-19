import { defineNuxtConfig } from 'nuxt/config';
import tailwindcss from '@tailwindcss/vite';

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
    port: 4200,
  },
  typescript: {
    typeCheck: true,
    tsConfig: {
      extends: '../../../tsconfig.base.json', // Nuxt chép nguyên văn chuỗi này sang `./.nuxt/tsconfig.json`, nên nó phải là đường dẫn tương đối so với thư mục đó
      include: ['../app/**/*', '../shared/**/*', '../test/**/*', './nuxt.d.ts', '../types/*.d.ts'],
    },
  },
  imports: {
    autoImport: true,
  },
  // Alias tường minh cho `@ecoma-io/ui-ecoma-logo` — **bắt buộc**, không phải tuỳ chọn.
  //
  // `tsconfig.base.json` có `paths: {}` rỗng và `vite.resolve.tsconfigPaths` chỉ
  // đọc `paths`, nên cả hai cùng không map `@ecoma-io/*`. Hệ quả đã quan sát được
  // trên `apps/account`: Vite resolve `@ecoma-io/*` **không** được ở runtime,
  // import trong `server/` chỉ nổ ở request đầu tiên chạm tới route đó (dev 500,
  // production 500 theo cold start). Library `ui-ecoma-logo` là duy nhất trong
  // workspace có tag `scope:shared` và được app này tiêu thụ, nên alias được đặt
  // ở đây — trỏ thẳng vào entrypoint của lib (`src/index.ts`), không cần build
  // output.
  //
  // Vì sao không sửa `tsconfig.base.json`: đó là file dùng chung của **mọi** app,
  // nên thêm `paths` ở đó là thay đổi ngoài phạm vi app này — và app nào không
  // có Nuxt/Vite resolver tương ứng vẫn không được lợi. `nuxt.config.ts` của
  // chính app là nơi duy nhất chịu trách nhiệm resolve được alias của app mình.
  alias: {
    '@ecoma-io/ui-ecoma-logo': new URL('../../libs/ui-ecoma-logo/src/index.ts', import.meta.url)
      .pathname,
  },
  modules: ['@nuxt/fonts'],
  css: ['~/assets/css/styles.css'],

  vite: {
    resolve: { tsconfigPaths: true },
    server: { allowedHosts: true },
    plugins: [tailwindcss()],
  },

  // Prototype #385: cấu hình build cho runtime Node standalone (Docker) qua
  // khối `$env['node-docker']` — chỉ kích hoạt khi envName đúng bằng
  // `node-docker`, tức `nuxt build --envName=node-docker` (c12 xử lý các khối
  // `$development`/`$env` trong `loadNuxtConfig`; envName tuỳ ý phải nằm trong
  // `$env`, còn `$development`/`$production` là key riêng có type). Đây là
  // cơ chế duy nhất cần thiết: nitro preset và output dir đều đặt được từ đây
  // vì `@nuxt/schema` 4.6.4 đã trả `nitro` vào `NuxtConfig` (không còn TS2353).
  //
  // TÊN BẮT BUỘC KHÁC `development`/`production`: `nuxt dev` tự đặt
  // envName = `development` (@nuxt/cli `overrideEnv("development")`, và c12
  // fallback theo NODE_ENV), nên khối `$development` sẽ kích hoạt cả trong
  // `nuxt dev` — buildDir `.nuxt-node` làm dev server hỏng trên fresh checkout
  // (không tìm thấy `.nuxt/tsconfig.*`). envName riêng (`node-docker`) tách
  // `nuxt dev` ra hoàn toàn. Tên Nx configuration vẫn là `development`
  // (contract của target build), chỉ command bên trong mới mang envName.
  //
  // `buildDir` được resolve theo `rootDir` (không phải `workspaceDir`), nên
  // `.nuxt-node`/`.output-node` nằm trong `apps/home/`, không đụng
  // `.nuxt`/`.output` của production — hai build chạy song song an toàn.
  // Lưu ý: build này vẫn cần `.nuxt` tồn tại (project `tsconfig.json`
  // reference `./.nuxt/tsconfig.*.json` mà `vite-plugin-checker` đọc khi
  // `typescript.typeCheck: true`) — target Nx `build` `dependsOn`
  // `nuxt-prepare` đã đảm bảo điều đó.
  $env: {
    'node-docker': {
      buildDir: '.nuxt-node',
      nitro: {
        // Preset Node server standalone — artifact `.output-node/server/index.mjs`
        // chạy trực tiếp bằng `node`, phục vụ preview/local; không đụng contract
        // wrangler của production (`.output/server/index.mjs` + `.output/public`).
        preset: 'node-server',
        output: {
          dir: '.output-node',
        },
      },
    },
  },
});
