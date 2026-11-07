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
      include: [
        '../app/**/*',
        '../shared/**/*',
        '../test/**/*',
        '../modules/**/*.ts',
        './nuxt.d.ts',
        '../types/*.d.ts',
      ],
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
  modules: [
    '@nuxt/fonts',
    'nuxt-content-assets',
    '@nuxt/content',
    './modules/prerendered-content-manifest',
    // Rào chắn fail-loud cho `.output/public/assets` (hook Nuxt
    // `nitro:build:public-assets`): một build mà `nuxt-content-assets` nuốt
    // lỗi load content config vẫn prerender đủ HTML nhưng mất trắng thư mục
    // assets - trước khi có hook này, lỗi đó chỉ lộ ở static-output test sau
    // khi build đã "xanh", với cảnh báo gốc bị Nx ẩn. Chi tiết trong module.
    './modules/static-assets-guard',
  ],
  css: ['~/assets/css/styles.css'],

  content: {
    build: {
      markdown: {
        // Pipeline math cho content học thuật: remark-math parse `$...$` /
        // `$$...$$` thành node math, rehype-katex render sang markup + class
        // KaTeX **lúc build** (cả prerender lẫn payload), nên HTML tĩnh mang
        // sẵn công thức — không client-only rendering. Hai plugin được
        // `@nuxt/content` import theo tên package lúc build (đã cài ở root
        // workspace); plugin tải chậm của katex chỉ chạy trên bài có math.
        remarkPlugins: { 'remark-math': {} },
        rehypePlugins: { 'rehype-katex': {} },
      },
    },
  },

  vite: {
    resolve: { tsconfigPaths: true },
    server: { allowedHosts: true },
    plugins: [tailwindcss()],
  },
});
