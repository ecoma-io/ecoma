/**
 * Cây điều hướng của tài khoản — **một** danh sách cho cả desktop sidebar và
 * mobile.
 *
 * ⚠️ Không có phần tử nào dẫn tới màn hình mật khẩu: không có "đổi mật khẩu", không
 * có "quên mật khẩu", không có "đặt lại mật khẩu". Ecoma là passwordless, và
 * một mục nav tới trang đó sẽ là một đường vào UI không tồn tại. `nav-items.spec.ts`
 * kiểm đúng danh sách này, nên thêm một mục sai sẽ đỏ ngay.
 *
 * Thứ tự là thứ tự đọc của người dùng: "tôi là ai" → "tôi dùng email nào" → "tôi
 * bảo vệ tài khoản ra sao" → "ai đang truy cập" → "tôi muốn app hiển thị gì" →
 * "quyền riêng tư".
 */
export type AccountNavItem = {
  /** Key message trong catalog `nav.*` — không phải chuỗi hiển thị. */
  readonly labelKey: string;
  /** Đường dẫn nội bộ, không có tiền tố locale. */
  readonly to: string;
};

export const ACCOUNT_NAV_ITEMS: readonly AccountNavItem[] = [
  { labelKey: 'nav.personal', to: '/' },
  { labelKey: 'nav.emails', to: '/emails' },
  { labelKey: 'nav.security', to: '/security' },
  { labelKey: 'nav.sessions', to: '/sessions' },
  { labelKey: 'nav.applications', to: '/applications' },
  { labelKey: 'nav.preferences', to: '/preferences' },
  { labelKey: 'nav.notifications', to: '/notifications' },
  { labelKey: 'nav.privacy', to: '/privacy' },
];

/**
 * `/` là trang thông tin cá nhân nhưng cũng là trang con của layout — `NuxtLink`
 * sẽ highlight nó ở mọi route con nếu chỉ so `to`. `exact` chặn điều đó: trên
 * `/emails`, mục "Thông tin cá nhân" không được sáng.
 */
export function isActiveNavItem(route: { path: string }, item: AccountNavItem): boolean {
  return item.to === '/' ? route.path === '/' : route.path.startsWith(item.to);
}
