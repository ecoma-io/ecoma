import { defineNuxtPlugin, useRuntimeConfig } from '#app';
import { ACCOUNT_DATA_MODE_MOCK, resolveAccountDataMode } from './data-mode';
import { createPreviewAccountAdapter } from './preview-adapter';
import type { AccountNuxtApp } from './adapter-slot';

/**
 * Plugin gắn adapter preview vào `nuxtApp` trước khi bất kỳ trang nào đọc slot.
 *
 * ⚠️ **Đăng ký của plugin là build-time exclusion**: module inline trong
 * `nuxt.config.ts` chỉ push plugin này vào `nuxt.options.plugins` khi
 * `nuxt.options.dev`, nên một artifact đã build không chứa plugin này,
 * `preview-adapter.ts` hay `mock-adapter.ts` trong module graph — không phải
 * "có trong bundle nhưng không chạy", mà là **không tồn tại** trong output.
 *
 * ⚠️ **Chỉ data domain.** Plugin chỉ gắn adapter lên slot `$accountAdapter`;
 * port auth của adapter đó đến từ adapter thật (xem `preview-adapter.ts`).
 * Không có nhánh nào ở đây giả một luồng đăng nhập hay consent — dưới dev
 * preview, `/login` và `/consent` gọi BFF thật và cần auth backend chạy cục
 * bộ; thiếu backend thì luồng thất bại trung thực, không diễn giả.
 *
 * Guard kép ở đây: cả khi plugin này bị đăng ký nhầm ở artifact, mode resolver
 * (`resolveAccountDataMode`) vẫn trả `real` khi `import.meta.dev` là `false` —
 * plugin rơi qua nhánh no-op và không gắn gì. Hai lớp độc lập cùng phải sai
 * cùng lúc mới có mock trong môi trường production.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const mode = resolveAccountDataMode(useRuntimeConfig().public.accountDataMode, import.meta.dev);
  if (mode !== ACCOUNT_DATA_MODE_MOCK) {
    return;
  }

  (nuxtApp as AccountNuxtApp).$accountAdapter ??= createPreviewAccountAdapter();
});
