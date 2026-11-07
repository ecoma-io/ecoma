<!--
  `EcomaLogo` — render primary horizontal logo của ecoma.io.

  Artwork không được vẽ lại bằng code: component render đúng hình học của file
  SVG nguồn trong `assets/` (hai path `d` nằm ở `logo-artwork.ts`, xét cùng
  file nguồn bởi `ecoma-logo.spec.ts`). Vì sao **inline SVG** thay vì `<img>`:
  `<img>` đóng gói SVG thành tài liệu riêng, nên `fill` bị nướng thành hex bên
  trong file và CSS của trang **không chạm vào được** — không có cách nào cho
  logo đi theo design token. Inline SVG dùng chung document với trang nên
  `fill` nhận được `var(--color-*)` của app: mark theo `fill-brand`
  (`--color-brand`), wordmark theo `fill-foam` (`--color-foam`).

  `<style>` của file nguồn (`.a{fill:#006aff}`/`.b{fill:#161616}`) **không** được
  mang sang: đó là lý do gốc chọn `<img>`, và inline nếu mang theo sẽ leak style
  generic ra toàn trang. Bỏ `<style>` khỏi markup giải quyết đúng cái lo đó mà
  vẫn giữ được khả năng đổi màu — xem `logo-artwork.ts` vì sao không dùng `v-html`.

  API tối giản: `alt` duy nhất (accessibility). `width`/`height` mặc định là
  **tỉ lệ** artwork (intrinsic của SVG là 160×46): `<svg>` không có cặp thuộc
  tính đó nên consumer phải đặt chiều cao qua CSS và để `w-auto` — nếu không
  chỉ đặt một phía, artwork bị méo. Attribute fallthrough cho mọi attr còn lại
  (class, style, aria-*, data-*…), NGOẶC TRỪ nhóm bị filter: `src`/`srcset`/
  `imagesrcset` (không phải ảnh nữa — artwork là source of truth) và
  `width`/`height` (một mình một phía làm méo artwork, sizing chỉ đi qua CSS).
  Component không tự thêm margin, không bọc link, không đọc router — brand link là
  việc của consumer.
-->
<script setup lang="ts">
import { computed, useAttrs } from 'vue';
import {
  ECOMA_LOGO_MARK_PATH,
  ECOMA_LOGO_VIEWBOX,
  ECOMA_LOGO_WORDMARK_PATH,
} from '../logo-artwork';

/**
 * Attribute KHÔNG được fallthrough xuống `<svg>` (lọc bằng destructure trong
 * `svgAttrs` dưới đây):
 * - nhóm nguồn ảnh (`src`, `srcset`, `imagesrcset`): artwork giờ là vector
 *   inline, không có nguồn ảnh nào để thay — không ai thay thế ngầm được;
 * - `width`/`height`: override một mình một trong hai làm méo artwork (một
 *   phía bị đặt, phía kia bị co về `auto` ⇒ méo). Sizing chỉ qua CSS.
 *
 * Tự quản fallthrough: mọi attr khác của consumer (class, style, aria-*,
 * data-*…) đều đi thẳng vào `<svg>`.
 */
defineOptions({ inheritAttrs: false });

// Destructure props từ `defineProps` (rule `vue/define-props-destructuring`):
// Vue 3.5 reactive props destructure giữ được reactivity trong template.
// Một prop duy nhất — đủ cho accessibility, vừa rule `vue/max-props` (max 1).
const { alt = 'ecoma.io' } = defineProps<{
  /** Văn bản thay thế — bắt buộc có ý nghĩa, logo ngữ nghĩa là brand. */
  readonly alt?: string;
}>();

const attrs = useAttrs();

// `useAttrs()` trả Proxy over `instance.attrs` (shallowReactive, Vue mutate
// in-place + trigger) nên `computed` re-evaluate đúng khi consumer đổi binding
// động — được pin bởi ecoma-logo-reactivity.spec.ts.
// `attrs[key]` có rest sibling nên biến lọc không vi phạm `noUnusedLocals`.
const svgAttrs = computed<Record<string, unknown>>(() => {
  const { src, srcset, imagesrcset, width, height, ...rest } = attrs;
  return rest;
});
</script>

<template>
  <!--
    `focusable="false"`: logo nằm trong link sẵn có, không cần thêm một tab stop
    vào tab order (là SVG inline, một số engine/AT cũ vẫn coi là focusable).
    `aria-label` thay cho `alt` của `<img>`: `<svg>` không có `alt`, nên
    accessible name phải đến từ ARIA.
  -->
  <svg
    :viewBox="ECOMA_LOGO_VIEWBOX"
    role="img"
    :aria-label="alt"
    focusable="false"
    class="ecoma-logo"
    v-bind="svgAttrs"
  >
    <path :d="ECOMA_LOGO_MARK_PATH" fill-rule="evenodd" class="fill-brand" />
    <path :d="ECOMA_LOGO_WORDMARK_PATH" class="fill-foam" />
  </svg>
</template>
