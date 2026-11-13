/**
 * Hợp đồng head của `app.vue` sau issue #213 — những gì một spec regex trên
 * source **không** chứng minh được.
 *
 * Ba luật được ghim ở đây bằng cách mount `app.vue` thật rồi đọc đúng object mà
 * `useHead` nhận:
 *
 * 1. `lang` **và** `dir` nằm chung trong `htmlAttrs` của **một** `useHead`:
 *    `lang` là BCP-47 từ registry, `dir` là hướng chữ của cùng definition đó —
 *    thuộc tính của ngôn ngữ, không phải cấu hình người dùng (issue #213).
 * 2. Script bootstrap color mode là entry **tĩnh** trong `app.head` của
 *    `nuxt.config.ts` (app chạy `ssr: false`, `useHead` chỉ áp dụng sau mount)
 *    — script này quyết định class `dark` trên `<html>` **trước first paint**,
 *    nên thiếu nó là FOUC ở chế độ tối.
 * 3. Vue/unhead **không** quản lý class `dark`: `htmlAttrs` không có `class`,
 *    và không còn `bodyAttrs` nào — đăng ký class qua head là hoàn tác giá trị
 *    mà script đã đặt (lý do `appShellHeadAttributes` cũ bị xoá).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_SHELL_COLOR_MODE_COOKIE } from '@ecoma-io/ui-app-shell';

import { documentHead, headHtmlAttrs, useCookie } from '../tests/nuxt-globals';
import { flushPromises, mountBackofficeApp } from '../tests/harness';
import type { BackofficeLocale } from './i18n/locale-registry';

/**
 * Chọn một locale qua chính `<select>` mà người dùng bấm.
 *
 * Selector ghim `data-testid="backoffice-language-select"` — thuộc tính đó do
 * `BackofficeLanguageSelect` (component của app này) sở hữu; đổi testid ở đó
 * phải cập nhật cả helper này.
 */
async function selectLanguage(
  wrapper: Awaited<ReturnType<typeof mountBackofficeApp>>['wrapper'],
  locale: BackofficeLocale,
): Promise<void> {
  const select = wrapper.find('[data-testid="backoffice-language-select"]');
  expect(select.exists()).toBe(true);
  await select.setValue(locale);
  await flushPromises(wrapper);
}

describe('the app owns the <html> lang and dir attributes in one useHead', () => {
  it('sets lang from the registry language and dir from the same definition', async () => {
    const { wrapper } = await mountBackofficeApp();

    // Mặc định `en` → `lang="en"`, `dir="ltr"` theo đúng entry của registry.
    expect(headHtmlAttrs()).toEqual({ lang: 'en', dir: 'ltr' });

    // `zh-CN` kiểm cả hai dây nối cùng lúc: `language` phải là BCP-47
    // (`zh-Hans`, không phải code), và `dir` phải lấy từ **cùng** definition —
    // tách nguồn thì một ngày nào đó hai thuộc tính lệch nhau mà không ai biết.
    await selectLanguage(wrapper, 'zh-CN');
    expect(headHtmlAttrs()).toEqual({ lang: 'zh-Hans', dir: 'ltr' });
  });

  it('injects the color-mode bootstrap script only through the static nuxt.config app.head', async () => {
    // App chạy `ssr: false`: `useHead` chỉ áp dụng sau mount, nên script phải
    // là entry **tĩnh** trong `app.head` của `nuxt.config.ts` — render thẳng
    // vào HTML shell lúc build, chạy lúc parse trước first paint. Ghim theo
    // source: biểu thức chính xác `innerHTML: APP_SHELL_COLOR_MODE_
    // BOOTSTRAP_SCRIPT` cùng dòng import subpath của library — tên hằng được
    // typecheck kiểm, nên hai phía không thể lệch nhau.
    const nuxtConfig = readFileSync(resolve(import.meta.dirname, '../nuxt.config.ts'), 'utf8');
    expect(nuxtConfig).toContain("from '@ecoma-io/ui-app-shell/lib/color-mode'");
    expect(nuxtConfig).toContain('innerHTML: APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT');

    // Và `useHead` của app.vue không đăng ký script nào — một script qua useHead
    // chỉ xuất hiện sau mount, tạo cảm giác đã bảo vệ mà thực ra không.
    await mountBackofficeApp();
    const scripts = documentHead()['script'] as Array<Record<string, unknown>> | undefined;
    expect(scripts ?? []).toEqual([]);
  });

  it('never registers the dark class or body attributes through unhead', async () => {
    await mountBackofficeApp();

    // Class `dark` là việc của script bootstrap + watcher của shell; `class`
    // trong `htmlAttrs` là đường Vue hoàn tác giá trị mà script đã đặt.
    expect(headHtmlAttrs()).not.toHaveProperty('class');
    const head = documentHead();
    expect(head).not.toHaveProperty('bodyAttrs');
  });
});

/** Giá trị hiện tại của cookie color mode, đọc qua đúng `useCookie` app đọc. */
function readColorModeCookie(): string | undefined {
  return useCookie<string | undefined>(APP_SHELL_COLOR_MODE_COOKIE).value;
}

describe('color mode is the one user choice, persisted in its cookie', () => {
  it('starts unconfigured and the toggle cycles system → light → dark into the cookie', async () => {
    const { wrapper } = await mountBackofficeApp();
    // Không có cookie thì không có lựa chọn: mode là `system`, cookie vẫn trống —
    // app **không** được ghi đè giá trị mặc định xuống cookie (hợp đồng của
    // `parseAppShellColorMode`: fallback chỉ tồn tại lúc đọc, không phải lúc ghi).
    expect(readColorModeCookie()).toBeUndefined();

    const toggle = wrapper.find('button[aria-label^="Color mode"]');
    expect(toggle.exists()).toBe(true);

    // Chu kỳ của toggle: system → light → dark → system. Mỗi lần bấm phải ghi
    // cookie — đây là dây nối duy nhất giữa nút bấm và lần tải trang sau.
    await toggle.trigger('click');
    await flushPromises(wrapper);
    expect(readColorModeCookie()).toBe('light');

    await toggle.trigger('click');
    await flushPromises(wrapper);
    expect(readColorModeCookie()).toBe('dark');

    await toggle.trigger('click');
    await flushPromises(wrapper);
    expect(readColorModeCookie()).toBe('system');
  });

  it('a stored cookie is read, not overwritten, and the head stays class-free', async () => {
    useCookie<string | undefined>(APP_SHELL_COLOR_MODE_COOKIE).value = 'dark';
    await mountBackofficeApp();

    // Cookie đã lưu là nguồn sự thật lúc khởi tạo: app không được ghi đè nó.
    expect(readColorModeCookie()).toBe('dark');
    // Và class dark vẫn không nằm trong head — nó do script bootstrap đặt.
    expect(headHtmlAttrs()).not.toHaveProperty('class');
  });
});
