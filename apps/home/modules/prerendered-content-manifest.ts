import { defineNuxtModule } from '@nuxt/kit';

/**
 * Module app-local: cung cấp virtual module `virtual:prerendered-content-paths`
 * cho **server bundle** (Nitro), chứa manifest các content path đã prerender.
 *
 * Vì sao dữ liệu chỉ có thể chạm bundle qua **Nitro**, không qua app code:
 *
 * - App code (`app/**`, gồm cả `validate` của route content) được **Vite**
 *   bundle TRƯỚC prerender (`nitro-server`: `build:done` → `await
 *   prerender(nitro); await build(nitro)`). Import `#build/...` từ app code
 *   bị Vite resolve + inline ngay trong pha đó — specifier biến mất khỏi
 *   graph, rollup của Nitro không bao giờ nhìn thấy nó để virtual hóa. Bất
 *   kỳ dữ liệu nào inject kiểu này đều đóng băng ở giá trị trước prerender
 *   (đã xác minh: manifest rỗng trong `.output/server` dù hook
 *   `prerender:done` ghi đủ 68 path).
 * - Code trong `server/**` (middleware, route, plugin) được **rollup của
 *   Nitro** bundle SAU prerender — virtual module cùng specifier đăng ký qua
 *   hook `nitro:config` (chạy trước `createNitro`, trước cả prerenderer con)
 *   được evaluate đúng lúc đó, khi `prerender:done` đã ghi manifest vào
 *   `globalThis` (cùng tiến trình build). Vì vậy consumer duy nhất của
 *   manifest là `server/middleware/prerendered-content-404.ts`; phía app
 *   không import module này.
 *
 * Module này cũng được dùng bởi **prerenderer con** (`preset:
 * "nitro-prerender"` — nhận lại `_config` của config chính, tức cả hook
 * `nitro:config` đã gắn). Trong bundle prerender, manifest vẫn rỗng (hook
 * `prerender:done` chỉ chạy SAU khi prerender xong) — middleware đọc
 * `import.meta.prerender` (thay tĩnh bằng `true` trong bundle đó) và tự
 * skip, nên route content vẫn được render bình thường.
 *
 * Dev (`nitro dev`): hook `nitro:config` vẫn chạy, virtual fn trả manifest
 * rỗng (`globalThis` không ai ghi) — middleware tự skip khi manifest rỗng,
 * content query chạy sqlite local như cũ.
 */
export default defineNuxtModule({
  meta: {
    name: 'prerendered-content-manifest',
    version: '0.0.1',
  },
  setup(_options, nuxt) {
    nuxt.hook('nitro:config', (config) => {
      config.virtual ??= {};
      config.virtual['virtual:prerendered-content-paths'] = (): string => {
        const raw = (globalThis as Record<string, unknown>).__PRERENDERED_CONTENT_PATHS__;
        const paths = Array.isArray(raw)
          ? raw.filter((item): item is string => typeof item === 'string')
          : [];
        return `export const PRERENDERED_CONTENT_PATHS = ${JSON.stringify(paths)};\n`;
      };
    });
  },
});
