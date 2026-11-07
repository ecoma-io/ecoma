/**
 * Composable chọn implementation adapter cho backoffice.
 *
 * Lý do không dùng `useState`:
 *
 * - `useState` trả `Ref<UnwrapRef<T>>`. `UnwrapRef` làm mất phương thức của một
 *   object interface, nên `adapter.listStaff()` trở thành `undefined` sau khi
 *   unwrap/hydrate. Lỗi này đã xảy ra ở `apps/account` và bài học được lặp lại ở
 *   đây một cách có chủ đích.
 * - `useState` ghi vào payload state và serialize để hydrate client; một adapter
 *   object bị serialize sẽ mất sạch hàm, dẫn tới `TypeError` ngay sau hydrate.
 * - Adapter không phải dữ liệu để truyền qua payload — nó là ranh giới runtime.
 *
 * Vì vậy nó nằm trên `nuxtApp`: SSR tạo `NuxtApp` riêng cho mỗi request (không
 * rò dữ liệu giữa requests), client là singleton của tab (cùng instance giữa các
 * trang). `??=` đảm bảo mọi call-site nhận đúng cùng một instance trong cùng
 * phiên.
 *
 * **Gating (E1):** Mode được quyết định **chỉ** từ
 * `useRuntimeConfig().public.backofficeDataMode` (deployment configuration). Không
 * có nhánh nào đọc query param, cookie, header, localStorage hay hostname. Module
 * quyết định là pure (`resolveBackofficeDataMode`) — fail-closed. SSR và client
 * nhận cùng giá trị này qua runtimeConfig payload.
 */
import { useNuxtApp, useRuntimeConfig, type NuxtApp } from '#app';
import {
  createBackofficeAdapter,
  resolveBackofficeDataMode,
  type BackofficeDataAdapter,
} from '../backoffice-data';

type BackofficeNuxtApp = NuxtApp & {
  $backofficeAdapter?: BackofficeDataAdapter;
};

export function useBackofficeAdapter(): BackofficeDataAdapter {
  const nuxtApp = useNuxtApp() as BackofficeNuxtApp;

  // `useRuntimeConfig()` nằm trong vế phải của `??=`: nó chỉ chạy ở lần tạo
  // adapter, còn nhánh cache (mọi call-site sau, gồm cả `BackofficeSampleNotice`
  // mount lại) không phụ thuộc runtime config nữa.
  nuxtApp.$backofficeAdapter ??= createBackofficeAdapter(
    resolveBackofficeDataMode(useRuntimeConfig().public.backofficeDataMode),
  );

  return nuxtApp.$backofficeAdapter;
}
