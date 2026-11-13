import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { APP_SHELL_COLOR_MODE_COOKIE } from '@ecoma-io/ui-app-shell';

import { flush, mountLlmConsoleApp } from './harness';
import { headHtmlAttrs, llmConsoleStores } from './nuxt-globals';
import IndexPage from '../app/pages/index.vue';
import { firstReturnedObject, stripComments } from './source-code';

const APP_VUE = resolve(import.meta.dirname, '../app/app.vue');
const APP_VUE_SOURCE = readFileSync(APP_VUE, 'utf8');
const APP_VUE_CODE = stripComments(APP_VUE_SOURCE);

describe('lang and dir on <html> are owned by the app', () => {
  it('sets lang itself, not delegating it to the shell', () => {
    expect(APP_VUE_CODE).toMatch(/\blang\s*:/u);
    expect(APP_VUE_CODE).not.toMatch(/\blang\s*:\s*'en'/u);
  });

  it('sets lang and dir together in one merged htmlAttrs, not a second useHead', () => {
    expect(APP_VUE_CODE).toMatch(/htmlAttrs\s*:\s*\{[^}]*\blang\s*:/u);
    expect(APP_VUE_CODE).toMatch(/htmlAttrs\s*:\s*\{[^}]*\bdir\s*:/u);
  });

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

  it('never manages the dark class through head attributes', () => {
    // Contract #213: class `dark` trên `<html>` do script bootstrap đặt trước
    // first paint, Vue render và unhead không đụng vào — code của app (đã bóc
    // comment) không được còn `appShellHeadAttributes` cũ, không được có
    // `bodyAttrs`, và không được nhắc tới `dark` ở bất kỳ đâu.
    expect(APP_VUE_CODE).not.toMatch(/appShellHeadAttributes|bodyAttrs|\bdark\b/u);
    const returned = firstReturnedObject(APP_VUE_SOURCE);
    expect(returned).not.toMatch(/bodyAttrs|class|dark/u);
  });

  it('mounts with lang and dir derived from the active locale', async () => {
    const wrapper = await mountLlmConsoleApp({ page: IndexPage });
    // `en` là locale mặc định, registry khai `dir: 'ltr'` — hai thuộc tính của
    // cùng một definition phải xuất hiện cùng nhau trong `htmlAttrs`.
    expect(headHtmlAttrs()).toEqual({ lang: 'en', dir: 'ltr' });
    wrapper.unmount();
  });

  it('keeps lang and dir in sync when the locale changes', async () => {
    const wrapper = await mountLlmConsoleApp({ page: IndexPage });
    // `zh-CN` là ca kiểm thử quan trọng: `lang` lấy BCP-47 (`zh-Hans`) chứ không
    // lấy `code`, và `dir` đổi cùng lượt từ cùng một definition của registry.
    wrapper.get('#llm-console-language').setValue('zh-CN');
    await flush();
    expect(headHtmlAttrs()).toEqual({ lang: 'zh-Hans', dir: 'ltr' });
    wrapper.get('#llm-console-language').setValue('vi');
    await flush();
    expect(headHtmlAttrs()).toEqual({ lang: 'vi', dir: 'ltr' });
    wrapper.unmount();
  });
});

describe('color mode is the one user choice, stored in its own cookie', () => {
  it('reads the mode from the library cookie name through the library validator', () => {
    // App không viết tay tên cookie: nó import hằng số của library, nên script
    // bootstrap và cookie mà app ghi không thể lệch nhau.
    expect(APP_VUE_CODE).toMatch(/APP_SHELL_COLOR_MODE_COOKIE/u);
    expect(APP_VUE_CODE).toMatch(/parseAppShellColorMode\(/u);
    // Contract cũ đã xoá khỏi library — một dấu vết còn sót là lỗi wiring.
    expect(APP_VUE_CODE).not.toMatch(
      /AppShellPreferences|APP_SHELL_PREFERENCES_COOKIE|parseAppShellPreferences|AppShellSettingsPanel/u,
    );
  });

  it('renders the color mode toggle in the actions slot', async () => {
    const wrapper = await mountLlmConsoleApp({ page: IndexPage });
    // Nút toggle nằm cạnh language select trong `#actions` của header; label
    // tiếng Anh đến từ catalog `shell.colorMode.*` qua prop `labels`.
    const toggle = wrapper.find('button[aria-label^="Color mode"]');
    expect(toggle.exists()).toBe(true);
    expect(wrapper.find('[data-testid="llm-console-language-select"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('writes the chosen mode back to the color mode cookie on update:color-mode', async () => {
    expect(APP_VUE_CODE).toMatch(/@update:color-mode="setColorMode"/u);
    expect(APP_VUE_CODE).toMatch(/colorModeCookie\.value\s*=\s*next/u);

    const wrapper = await mountLlmConsoleApp({ page: IndexPage });
    // Không cookie → mode là `system` (nút xoay vòng `light → dark → system`);
    // một lần bấm phải ghi giá trị kế tiếp vào đúng cookie của library.
    const toggle = wrapper.find('button[aria-label^="Color mode"]');
    await toggle.trigger('click');
    expect(llmConsoleStores.cookies.get(APP_SHELL_COLOR_MODE_COOKIE)?.value).toBe('light');
    await toggle.trigger('click');
    expect(llmConsoleStores.cookies.get(APP_SHELL_COLOR_MODE_COOKIE)?.value).toBe('dark');
    wrapper.unmount();
  });

  it('passes dir and color mode to the shell as props, never from a user setting', () => {
    expect(APP_VUE_CODE).toMatch(/:dir="dir"/u);
    expect(APP_VUE_CODE).toMatch(/:color-mode="colorMode"/u);
    // `dir` không được đọc từ cookie nào: nó là thuộc tính của ngôn ngữ.
    expect(APP_VUE_CODE).not.toMatch(/dirCookie|dir-cookie/u);
  });
});
