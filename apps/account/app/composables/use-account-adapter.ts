import { useNuxtApp } from '#app';
import { createServerAccountAdapter } from '../account-data/real-adapter';
import type { AccountAdapter } from '../account-data/types';
import type { AccountNuxtApp } from '../account-data/adapter-slot';

/**
 * Điểm chọn implementation adapter — **nơi duy nhất trong artifact** quyết định
 * UI nói chuyện với nguồn dữ liệu nào: luôn là adapter thật.
 *
 * Đường dữ liệu preview (mock) **không đi qua đây**: nó được plugin dev-only
 * (`account-data/preview-adapter-plugin.ts`) gắn lên slot trước khi trang nào
 * chạy, và plugin chỉ được đăng ký dưới `nuxt dev` (module inline trong
 * `nuxt.config.ts`). Trong một artifact đã build, plugin không tồn tại trong
 * module graph — factory dưới đây không có nhánh mock nào để "quên" tắt, và
 * không dùng `import()` động làm đường preview vì lazy chunk vẫn ship trong
 * artifact (`frontend-data-mocking` §H).
 *
 * Nếu slot đã có adapter (preview plugin dưới dev) thì dùng nó; không thì dựng
 * adapter thật. Hai nhánh lệch nhau chỉ về phía an toàn: nhánh fallback luôn
 * là đường thật, không bao giờ là mock.
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
 * `??=` thay vì gán thẳng: mọi call-site trong app nhận **cùng** một instance,
 * nên thao tác ghi của một trang phải thấy dữ liệu trang khác vừa ghi.
 */
export function useAccountAdapter(): AccountAdapter {
  const nuxtApp = useNuxtApp() as AccountNuxtApp;

  nuxtApp.$accountAdapter ??= createServerAccountAdapter();

  return nuxtApp.$accountAdapter;
}
