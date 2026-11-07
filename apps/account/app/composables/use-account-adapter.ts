import { useNuxtApp, useRuntimeConfig, type NuxtApp } from '#app';
import type { AccountAdapter } from '../account-data/types';
import { createServerAccountAdapter } from '../account-data/real-adapter';
import { createMockAccountAdapter } from '../account-data/mock-adapter';
import { ACCOUNT_DATA_MODE_MOCK, resolveAccountDataMode } from '../account-data/data-mode';

/**
 * Static import của mock adapter có chủ đích, không phải `import()` động:
 * `resolveAccountDataMode` fail-closed nghĩa là mode `mock` **không thể tồn
 * tại trong artifact** — nhánh mock chỉ chạy dưới `nuxt dev`, nên static import
 * không đổi bundle production. Thêm cơ chế dynamic import vào đây là phức tạp
 * hoá một quyết định mà fail-closed đã xử lý, chưa kể `import()` trong
 * composable biến đường dựng adapter thành async boundary cần xử lý
 * pending/hydrate cho cả hai phía SSR/client.
 */

/** App Nuxt đã mang adapter, gắn thêm vào nó. */
type AccountNuxtApp = NuxtApp & {
  $accountAdapter?: AccountAdapter;
};

/**
 * Điểm chọn implementation adapter — **nơi duy nhất** quyết định UI nói chuyện
 * với nguồn dữ liệu nào.
 *
 * Chế độ đến từ `useRuntimeConfig().public.accountDataMode` qua
 * `resolveAccountDataMode` (fail-closed): `mock` chỉ khi chuỗi cấu hình đúng
 * `'mock'` **và** đang chạy `nuxt dev`; mọi tổ hợp khác — gồm cả `mock` đặt
 * trong artifact, nếu lọt qua — là server adapter thật.
 *
 * Server adapter (`real-adapter.ts`): các luồng auth đã nối với BFF thật
 * (`/api/auth/*`, `/api/consent/*`); phần dữ liệu tài khoản còn lại vẫn mô phỏng
 * bên trong nó ở cả hai mode cho tới PR4, và `isPreview` được dẫn xuất từ mode +
 * domain coverage thay vì hardcode — xem {@link createAccountAdapter}.
 *
 * ⚠️ Giữ mock ở đây nghĩa là dự phòng khác cho test harness: `tests/harness.ts`
 * gắn adapter test riêng vào `nuxtApp.$accountAdapter` trước khi mount, nên
 * factory này chạy production — mock xoá bằng một dòng nếu cần.
 *
 * ⚠️ **Không** dùng `useState` cho adapter. `useState` trả `Ref<UnwrapRef<T>>`, mà
 * `UnwrapRef` biến một **interface có phương thức** thành object thuần phẳng —
 * mọi phương thức biến mất khỏi kiểu. Tệ hơn: `useState` ghi vào `payload.state`,
 * và payload được serialize để hydrate client; một adapter đi qua đó sẽ thành
 * object JSON **mất sạch hàm**, nên mọi trang gọi `adapter.listEmails()` sẽ ném
 * `TypeError` ngay sau hydrate. Adapter không phải dữ liệu để vận chuyển.
 *
 * Vì vậy nó nằm trên chính `nuxtApp`. Ở SSR, Nuxt tạo một `NuxtApp` **riêng cho
 * từng request**, nên adapter cũng riêng theo — không rò dữ liệu giữa hai người,
 * đúng điều mà một biến ở cấp module sẽ làm hỏng (và `AGENTS.md` cấm đúng thứ
 * đó). Ở client, `nuxtApp` là singleton của tab nên adapter sống suốt phiên.
 *
 * `??=` thay vì gán thẳng: mọi call-site trong app nhận **cùng** một instance, nên
 * thao tác ghi của một trang phải thấy dữ liệu trang khác vừa ghi.
 */
export function useAccountAdapter(): AccountAdapter {
  const nuxtApp = useNuxtApp() as AccountNuxtApp;

  // `useRuntimeConfig()` nằm trong `createAccountAdapter`, chỉ được gọi từ vế
  // phải của `??=`: nó chỉ chạy ở lần tạo adapter, còn nhánh cache (mọi
  // call-site sau) không phụ thuộc runtime config.
  nuxtApp.$accountAdapter ??= createAccountAdapter();

  return nuxtApp.$accountAdapter;
}

/**
 * Dựng adapter theo mode đã phân giải. Tách khỏi {@link useAccountAdapter} để
 * `useRuntimeConfig()` chỉ chạy ở lần tạo adapter duy nhất.
 */
function createAccountAdapter(): AccountAdapter {
  const dataMode = resolveAccountDataMode(
    useRuntimeConfig().public.accountDataMode,
    import.meta.dev,
  );
  const isMock = dataMode === ACCOUNT_DATA_MODE_MOCK;

  // Độ phủ đường thật của data domain — PR4 đã nối mọi domain dữ liệu vào BFF
  // thật (profile, emails, sessions, applications, preferences, notifications,
  // privacy requests). Các luồng credentials (passkeys/TOTP/recovery) vẫn mock
  // bên trong real adapter nhưng không thuộc data-domain banner. `isPreview`
  // dẫn xuất từ mode + coverage — mode mock ⇒ banner bật; mode real ⇒ banner
  // tắt, không đụng UI.
  const dataDomainHasRealPath = true;

  return isMock
    ? createMockAccountAdapter()
    : createServerAccountAdapter({}, isMock || !dataDomainHasRealPath);
}
