// Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
// Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md.
import type { AppShellBreadcrumbLink } from './types';

/**
 * Biến một phân đoạn URL thành nhãn hiển thị: `account-settings` →
 * `Account Settings`. Giữ nguyên hành vi của nguồn; app nào có nhãn thật (đã
 * dịch, hoặc khác với slug) thì truyền thẳng `links` cho `AppShellBreadcrumb`
 * thay vì để shell đoán từ URL.
 */
export function humanize(segment: string): string {
  return segment
    .replace(/-/gu, ' ')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Suy ra danh sách breadcrumb từ path hiện tại.
 *
 * Hàm thuần: `path` vào, mảng ra — không đọc route, không đọc `window`, nên
 * SSR và client luôn tính ra cùng kết quả từ cùng một input.
 *
 * `path` được so **sau khi bỏ dấu `/` cuối** vì Nuxt có thể render `/settings/`
 * cho trang `/settings`, và nguồn so với `route.fullPath` nên hai dạng đó cho ra
 * hai breadcrumb khác nhau.
 */
export function appShellBreadcrumbLinks(
  path: string,
  homeLabel = 'Home',
): AppShellBreadcrumbLink[] {
  const normalized = path !== '/' && path.endsWith('/') ? path.slice(0, -1) : path;

  if (normalized === '') {
    return [{ title: homeLabel, href: '/' }];
  }

  const segments = normalized.split('/').filter((segment) => segment !== '');

  const rest = segments.map((segment, index) => ({
    title: humanize(segment),
    href: `/${segments.slice(0, index + 1).join('/')}`,
  }));

  return [{ title: homeLabel, href: '/' }, ...rest];
}
