import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineNuxtModule } from '@nuxt/kit';
import { assessOutputSvgAssets } from '../shared/static-output-contract';

/**
 * Module app-local: rào chắn fail-loud cho artifact static của build.
 *
 * Vì sao hook này phải tồn tại: suite `tests/static-output.spec.ts` assert
 * trên `.output/public` sau build, nhưng một build mà `nuxt-content-assets`
 * nuốt lỗi load content config (module chỉ `warn`, và Nx **ẩn output của task
 * pass** khi chạy `nx affected -t test`) vẫn prerender đủ HTML - chỉ thiếu
 * thư mục `assets/`. Khi đó failure chỉ hiện ở test với thông báo kiểu
 * "expected 0 to be greater than or equal to 6": đỏ ở tầng sai, không ai thấy
 * cảnh báo gốc của module. Hook Nuxt `nitro:build:public-assets` chạy đúng
 * một lần sau prerender, trên Nitro chính (`@nuxt/nitro-server` gắn nó vào
 * `rollup:before` sau `copyPublicAssets`, chỉ khi `!dev`) - tức vào đúng thời
 * điểm `.output/public/assets` đã chốt, trước khi bundle server được viết.
 * Kể từ đây một build thiếu asset là build đỏ ngay tại bước `build`.
 *
 * Vì sao hook nằm trong `nuxt.config.ts hooks`-hệ (module), không phải
 * `nitro.config.ts`: `nitro:build:public-assets` là hook của **hệ Nuxt**
 * (`NuxtHooks` trong `@nuxt/schema`), được phát qua `nuxt.callHook`. Hooks
 * khai trong `nitro.config.ts` đi vào `nitro.hooks` - registry khác - nên
 * không bao giờ thấy tên hook này.
 *
 * Threshold và thông báo sống trong `shared/static-output-contract.ts` -
 * cùng nguồn với `tests/static-output.spec.ts` (test assert trên cùng con
 * số, tránh hai nơi trôi nhau).
 */
export default defineNuxtModule({
  meta: {
    name: 'static-assets-guard',
    version: '0.0.1',
  },
  setup(_options, nuxt) {
    nuxt.hooks.hook('nitro:build:public-assets', (nitro) => {
      const assetsDir = resolve(nitro.options.output.publicDir, 'assets');
      let actual: string[];
      try {
        actual = readdirSync(assetsDir).filter((name) => name.endsWith('.svg'));
      } catch {
        actual = [];
      }
      const violation = assessOutputSvgAssets(actual.length);
      if (violation !== null) {
        throw new Error(violation);
      }
    });
  },
});
