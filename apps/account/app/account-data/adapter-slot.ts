import type { NuxtApp } from '#app';
import type { AccountAdapter } from './types';

/**
 * Slot của adapter trên `nuxtApp` — hợp đồng dùng chung bởi hai bên gắn adapter:
 *
 * - {@link ../composables/use-account-adapter.ts} — đọc slot, tự dựng adapter
 *   thật khi slot còn trống (con đường duy nhất trong artifact đã build).
 * - {@link ./preview-adapter-plugin.ts} — gắn adapter preview khi mode là
 *   `mock` (chỉ tồn tại dưới `nuxt dev`, không vào artifact).
 *
 * ⚠️ Vì sao adapter nằm trên `nuxtApp` chứ không `useState` hay module-level:
 * `useState` trả `Ref<UnwrapRef<T>>` — `UnwrapRef` biến một interface có phương
 * thức thành object phẳng mất sạch hàm, và payload được serialize để hydrate
 * client nên adapter đi qua đó thành JSON không còn phương thức nào. Còn biến
 * module-level trên SSR là state dùng chung giữa các request — rò dữ liệu giữa
 * hai người dùng, đúng thứ `AGENTS.md` cấm. `NuxtApp` ở SSR là **mỗi request
 * một instance**, ở client là singleton của tab — cả hai phía đều đúng phạm vi
 * sống của một "phiên adapter".
 */
export type AccountNuxtApp = NuxtApp & {
  $accountAdapter?: AccountAdapter;
};
