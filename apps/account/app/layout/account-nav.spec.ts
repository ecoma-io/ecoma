/**
 * Bất biến của cây điều hướng tài khoản.
 *
 * ⚠️ Test này tồn tại để **giữ bất biến passwordless**. Ecoma không có mật khẩu, nên
 * không được tồn tại route hay mục nav nào dẫn tới màn hình mật khẩu: không
 * "đổi mật khẩu", không "quên mật khẩu", không "đặt lại mật khẩu". Thêm một mục nav
 * sai sẽ tạo ra một đường vào UI không tồn tại — và người dùng sẽ báo là app hỏng.
 *
 * `ACCOUNT_NAV_ITEMS` là nguồn duy nhất cho cả `<nav>` desktop và `<details>` mobile
 * trong `layouts/default.vue`, nên kiểm danh sách này là kiểm cả hai bản.
 */
import { describe, expect, it } from 'vitest';

import { ACCOUNT_NAV_ITEMS, isActiveNavItem } from './account-nav';
import en from '../i18n/locales/en';

const PASSWORD_ROUTE_PATTERN = /password|mat-khau|passwort|mot-mat-khau|dang-nhap-…?mat/iu;

describe('account nav items', () => {
  it('covers the eight authenticated sections', () => {
    expect(ACCOUNT_NAV_ITEMS.map((item) => item.to)).toEqual([
      '/',
      '/emails',
      '/security',
      '/sessions',
      '/applications',
      '/preferences',
      '/notifications',
      '/privacy',
    ]);
  });

  it('contains no route or label pointing at password UI', () => {
    for (const item of ACCOUNT_NAV_ITEMS) {
      expect(PASSWORD_ROUTE_PATTERN.test(item.to), `route ${item.to}`).toBe(false);
      const label = item.labelKey
        .split('.')
        .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], en);
      expect(typeof label, `label key ${item.labelKey} must exist in en catalog`).toBe('string');
      expect(PASSWORD_ROUTE_PATTERN.test(String(label)), `label for ${item.to}`).toBe(false);
    }
  });

  it('gives every nav item a label key that exists in the English catalog', () => {
    for (const item of ACCOUNT_NAV_ITEMS) {
      expect(item.labelKey.startsWith('nav.'), `${item.to} label key`).toBe(true);
      expect(item.labelKey).not.toBe('nav.');
    }
  });

  it('keeps routes free of a locale prefix', () => {
    for (const item of ACCOUNT_NAV_ITEMS) {
      const [first] = item.to.split('/').filter((segment) => segment !== '');
      expect(['en', 'vi', 'zh-CN', 'zh-Hans']).not.toContain(first);
    }
  });
});

describe('isActiveNavItem', () => {
  const personal = ACCOUNT_NAV_ITEMS[0] as { readonly labelKey: string; readonly to: string };
  const emails = ACCOUNT_NAV_ITEMS[1] as { readonly labelKey: string; readonly to: string };

  it('marks the personal section active only at the root', () => {
    expect(isActiveNavItem({ path: '/' }, personal)).toBe(true);
    expect(isActiveNavItem({ path: '/emails' }, personal)).toBe(false);
    expect(isActiveNavItem({ path: '/security' }, personal)).toBe(false);
  });

  it('marks a section active for its own route', () => {
    expect(isActiveNavItem({ path: '/emails' }, emails)).toBe(true);
  });
});
