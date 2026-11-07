/**
 * Nitro plugin: validate config **một lần**, ở request đầu tiên — không ở
 * module-init.
 *
 * File này là glue. Toàn bộ luật nằm ở `server/utils/config-validation.ts`;
 * thời điểm gọi nằm ở {@link lazyConfigValidator} — tách vậy vì
 * `defineNitroPlugin` ở module scope là auto-import của Nitro, không tồn tại
 * ngoài runtime Nitro, nên đặt logic vào đây sẽ không test được mà không dựng
 * cả runtime.
 *
 * ⚠️ **Không** gọi `validateAccountConfig` ngay trong thân plugin: trên Workers
 * preset, `createNitroApp()` chạy top-level của `index.mjs` khi module Worker
 * load, còn secret (`wrangler secret`) chỉ được nối vào runtime config ở
 * **request**. Validate lúc init đọc config chưa có secret và ném ⇒ module
 * không load được ⇒ kể cả deployment đúng cũng chết. Request đầu chạm config
 * thiếu vẫn ném (fail-closed giữ nguyên) — riêng contract internal còn có lớp
 * 401 `no_secret` của middleware, độc lập với plugin này.
 *
 * `order` mặc định là đủ: không plugin nào khác của app phụ thuộc config, nên
 * không cần sắp thứ tự với chúng.
 */
import { createError } from 'h3';

import { lazyConfigValidator } from '../utils/config-validation';

export default defineNitroPlugin((nitroApp) => {
  // `useRuntimeConfig(event)` — truyền event như middleware: trên Workers, binding
  // của request đến từ env của Worker và Nitro nối vào runtime config theo event.
  const ensureConfigValid = lazyConfigValidator((event) => useRuntimeConfig(event));
  nitroApp.hooks.hook('request', (event) => {
    try {
      ensureConfigValid(event);
    } catch (error) {
      // Surface lỗi config thật (vd. secret còn thiếu) thay vì để nó lan qua chuỗi
      // hook Nitro và bị hook i18n che mất bằng message không liên quan. Status 503
      // vì đây là lỗi cấu hình phía server, không phải lỗi client.
      const message = error instanceof Error ? error.message : 'Internal service misconfigured';
      throw createError({ statusCode: 503, statusMessage: message });
    }
  });
});
