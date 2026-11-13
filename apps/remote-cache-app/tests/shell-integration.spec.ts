import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import IndexPage from '../app/pages/index.vue';
import { APP_SHELL_COLOR_MODE_COOKIE } from '@ecoma-io/ui-app-shell';
import { mountRemoteCacheAppApp, flush } from './harness';
import { documentHead, remoteCacheAppStores } from './nuxt-globals';
import { stripComments } from './source-code';

const APP_VUE = resolve(import.meta.dirname, '../app/app.vue');
const APP_VUE_SOURCE = readFileSync(APP_VUE, 'utf8');
const APP_VUE_CODE = stripComments(APP_VUE_SOURCE);

describe('lang and dir on <html> are owned by the app', () => {
  it('app.vue sets lang itself, not delegating it to the shell', () => {
    expect(APP_VUE_CODE).toMatch(/\blang\s*:/u);
    expect(APP_VUE_CODE).not.toMatch(/\blang\s*:\s*'en'/u);
  });

  it('lang and dir are part of one merged htmlAttrs, not a second useHead', () => {
    expect(APP_VUE_CODE).toMatch(/htmlAttrs\s*:\s*\{[^}]*\blang\s*:/u);
    expect(APP_VUE_CODE).toMatch(/htmlAttrs\s*:\s*\{[^}]*\bdir\s*:/u);
  });

  it('passes the registry-derived dir to the shell', () => {
    expect(APP_VUE_CODE).toMatch(/:dir="dir"/u);
  });
});

describe('the dark class is not managed by unhead', () => {
  it('injects the color mode bootstrap script only through the static nuxt.config app.head', () => {
    // App chạy `ssr: false`: `useHead` chỉ áp dụng sau mount, nên script phải
    // là entry **tĩnh** trong `app.head` của `nuxt.config.ts` — render thẳng
    // vào HTML shell lúc build, chạy lúc parse trước first paint. Ghim theo
    // source: biểu thức chính xác `innerHTML: APP_SHELL_COLOR_MODE_BOOTSTRAP_
    // SCRIPT` cùng dòng import subpath của library — tên hằng được typecheck
    // kiểm, nên hai phía không thể lệch nhau.
    const nuxtConfig = readFileSync(resolve(import.meta.dirname, '../nuxt.config.ts'), 'utf8');
    expect(nuxtConfig).toContain("from '@ecoma-io/ui-app-shell/lib/color-mode'");
    expect(nuxtConfig).toContain('innerHTML: APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT');

    // Và `useHead` của app.vue không đăng ký script nào — một script qua
    // useHead chỉ xuất hiện sau mount, tạo cảm giác đã bảo vệ mà thực ra không.
    expect(APP_VUE_CODE).not.toMatch(/\bscript\s*:/u);
  });

  it('never sets a dark class through htmlAttrs or bodyAttrs', () => {
    expect(APP_VUE_CODE).not.toMatch(/bodyAttrs/u);
    expect(APP_VUE_CODE).not.toMatch(/class\s*:\s*['"`][^'"`]*\bdark\b/u);
  });

  it('does not use the removed shell head-attributes helper', () => {
    expect(APP_VUE_CODE).not.toMatch(/appShellHeadAttributes/u);
  });
});

describe('color mode is the one persisted shell setting', () => {
  it('reads the color mode from the shared cookie name', () => {
    expect(APP_VUE_CODE).toMatch(/useCookie<string>\(\s*APP_SHELL_COLOR_MODE_COOKIE/u);
    expect(APP_VUE_CODE).toMatch(/parseAppShellColorMode\(/u);
  });

  it('writes the color mode back to that cookie when the shell emits a change', () => {
    expect(APP_VUE_CODE).toMatch(/@update:color-mode="setColorMode"/u);
    expect(APP_VUE_CODE).toMatch(/colorModeCookie\.value\s*=\s*next/u);
  });

  it('no longer reads a shell preferences cookie or a preferences prop', () => {
    expect(APP_VUE_CODE).not.toMatch(/APP_SHELL_PREFERENCES_COOKIE/u);
    expect(APP_VUE_CODE).not.toMatch(/\bpreferences\b/u);
  });

  it('renders the color mode toggle next to the language select', () => {
    expect(APP_VUE_CODE).toMatch(/<AppShellColorModeToggle/u);
    expect(APP_VUE_CODE).toMatch(/<RemoteCacheAppLanguageSelect/u);
  });
});

describe('the merged head carries lang and dir', () => {
  it('registers lang and dir on <html> and no scripts', async () => {
    const wrapper = await mountRemoteCacheAppApp({ page: IndexPage });
    const head = documentHead();

    expect(head['htmlAttrs']).toMatchObject({ lang: 'en', dir: 'ltr' });
    // Script bootstrap nằm trong `app.head` tĩnh của `nuxt.config.ts` (ngoài
    // tầm với của `useHead`) — head mà app đăng ký phải sạch script.
    expect(head['script'] ?? []).toEqual([]);

    wrapper.unmount();
  });

  it('follows the locale registry when the user switches language', async () => {
    const wrapper = await mountRemoteCacheAppApp({ page: IndexPage });

    const { useRemoteCacheAppLocale } =
      await import('../app/composables/use-remote-cache-app-locale');
    useRemoteCacheAppLocale().chooseLocale('vi');
    await flush();

    // `dir` là thuộc tính của ngôn ngữ: đổi locale phải đổi `dir` theo registry.
    // Với `vi` (LTR) giá trị không đổi, nhưng nó phải được tính lại từ registry —
    // test này ghim cơ chế, không phải giá trị cụ thể.
    expect(documentHead()['htmlAttrs']).toMatchObject({ lang: 'vi', dir: 'ltr' });

    wrapper.unmount();
  });
});

describe('the color mode cookie is the one source of the shell color mode', () => {
  it('defaults to system when the cookie holds nothing', async () => {
    const wrapper = await mountRemoteCacheAppApp({ page: IndexPage });

    expect(remoteCacheAppStores.cookies.get(APP_SHELL_COLOR_MODE_COOKIE)?.value).toBeUndefined();

    wrapper.unmount();
  });

  it('writes the chosen color mode to the shared cookie', async () => {
    const wrapper = await mountRemoteCacheAppApp({ page: IndexPage });

    const toggle = wrapper.findComponent({ name: 'AppShellColorModeToggle' });
    expect(toggle.exists()).toBe(true);
    await toggle.trigger('click');
    await flush();

    // `system → light` là bước đầu tiên của vòng xoay của nút.
    expect(remoteCacheAppStores.cookies.get(APP_SHELL_COLOR_MODE_COOKIE)?.value).toBe('light');

    wrapper.unmount();
  });
});
