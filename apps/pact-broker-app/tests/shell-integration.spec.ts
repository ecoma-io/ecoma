import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_VUE = resolve(import.meta.dirname, '../app/app.vue');
const APP_VUE_SOURCE = readFileSync(APP_VUE, 'utf8');
const APP_VUE_CODE = APP_VUE_SOURCE.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(
  /\/\/[^\n]*/gu,
  '',
);

describe('lang on <html> is owned by the app', () => {
  it('app.vue sets lang itself, not delegating it to the shell', () => {
    expect(APP_VUE_CODE).toMatch(/\blang\s*:/u);
    expect(APP_VUE_CODE).not.toMatch(/\blang\s*:\s*'en'/u);
  });

  it('lang and dir live in one merged htmlAttrs, not a second useHead', () => {
    expect(APP_VUE_CODE).toMatch(/htmlAttrs\s*:\s*\{[^}]*\blang\s*:/u);
    expect(APP_VUE_CODE).toMatch(/htmlAttrs\s*:\s*\{[^}]*\bdir\s*:/u);
  });
});

describe('direction follows the locale, not a user setting', () => {
  it('passes dir down to the shell as a prop', () => {
    expect(APP_VUE_CODE).toMatch(/:dir="dir"/u);
  });

  it('never lets unhead manage a dark class on <html>', () => {
    // Class `dark` do script bootstrap đặt trước first paint; unhead chỉ
    // đăng ký `lang`/`dir` và chính script đó. Nếu `htmlAttrs`/`bodyAttrs`
    // mang class thì hydration sẽ dispute với script.
    expect(APP_VUE_CODE).not.toMatch(/bodyAttrs/u);
    expect(APP_VUE_CODE).not.toMatch(/htmlAttrs\s*:\s*\{[^}]*\bclass\b/u);
  });

  it('reads dir from the locale registry instead of a stored preference', () => {
    const composable = readFileSync(
      resolve(import.meta.dirname, '../app/composables/use-pact-broker-i18n.ts'),
      'utf8',
    );
    expect(composable).toMatch(/getPactBrokerLocaleDefinition\(/u);
    expect(composable).not.toMatch(/preferences?/iu);
  });
});

describe('color mode is the one persisted user choice', () => {
  it('reads the mode from the shell cookie and validates it', () => {
    expect(APP_VUE_CODE).toMatch(/useCookie<string>\(APP_SHELL_COLOR_MODE_COOKIE\)/u);
    expect(APP_VUE_CODE).toMatch(/parseAppShellColorMode\(colorModeCookie\.value\)/u);
  });

  it('writes the mode back to the same cookie', () => {
    expect(APP_VUE_CODE).toMatch(/colorModeCookie\.value\s*=\s*next/u);
  });

  it('injects the bootstrap script only through the static nuxt.config app.head', () => {
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

  it('passes the mode to the shell and listens for its changes', () => {
    expect(APP_VUE_CODE).toMatch(/:color-mode="colorMode"/u);
    expect(APP_VUE_CODE).toMatch(/@update:color-mode="setColorMode"/u);
  });

  it('no longer wires the removed preferences cookie or settings panel', () => {
    expect(APP_VUE_CODE).not.toMatch(/APP_SHELL_PREFERENCES_COOKIE/u);
    expect(APP_VUE_CODE).not.toMatch(/appShellHeadAttributes/u);
    expect(APP_VUE_CODE).not.toMatch(/AppShellSettingsPanel/u);
  });

  it('places the color mode toggle in the shell actions slot', () => {
    expect(APP_VUE_CODE).toMatch(/<AppShellColorModeToggle/u);
  });
});
