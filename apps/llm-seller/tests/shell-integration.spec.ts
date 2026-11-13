import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { firstReturnedObject, stripComments } from './source-code';

const APP_VUE = resolve(import.meta.dirname, '../app/app.vue');
const APP_VUE_SOURCE = readFileSync(APP_VUE, 'utf8');
const APP_VUE_CODE = stripComments(APP_VUE_SOURCE);

/**
 * Bất biến của `app.vue` sau issue #213:
 *
 * - `lang` và `dir` do **app** sở hữu, gộp trong **một** `useHead` — chiều văn
 *   bản là thuộc tính của ngôn ngữ, suy ra từ locale registry, không phải lựa
 *   chọn người dùng nên không có setting LTR/RTL.
 * - Class `dark` trên `<html>` **không** do unhead quản lý: script bootstrap quyết
 *   định nó trước first paint, còn render Vue không đọc môi trường.
 * - Cookie duy nhất của cấu hình shell là `app_shell_color_mode`.
 */
describe('lang and dir on <html> are owned by the app', () => {
  it('app.vue sets lang itself, not delegating it to the shell', () => {
    expect(APP_VUE_CODE).toMatch(/\blang\s*:/u);
    expect(APP_VUE_CODE).not.toMatch(/\blang\s*:\s*'en'/u);
  });

  it('lang and dir are part of one merged htmlAttrs, not a second useHead', () => {
    expect(APP_VUE_CODE).toMatch(/htmlAttrs\s*:\s*\{[^}]*\blang\s*:/u);
    expect(APP_VUE_CODE).toMatch(/htmlAttrs\s*:\s*\{[^}]*\bdir\s*:/u);
  });

  it('registers exactly one useHead call', () => {
    expect(APP_VUE_CODE.match(/\buseHead\s*\(/gu) ?? []).toHaveLength(1);
  });

  it('does not delegate document attributes to a shell helper any more', () => {
    expect(APP_VUE_CODE).not.toMatch(/appShellHeadAttributes/u);
    expect(APP_VUE_CODE).not.toMatch(/\bbodyAttrs\b/u);
  });
});

describe('color mode contract', () => {
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

  it('never lets unhead manage the dark class', () => {
    const returned = firstReturnedObject(APP_VUE_SOURCE);
    expect(returned).not.toMatch(/\bclass\b/u);
  });

  it('reads the color mode from the color-mode cookie only', () => {
    expect(APP_VUE_CODE).toMatch(/APP_SHELL_COLOR_MODE_COOKIE/u);
    expect(APP_VUE_CODE).toMatch(/parseAppShellColorMode\s*\(/u);
    expect(APP_VUE_CODE).not.toMatch(/APP_SHELL_PREFERENCES/u);
    expect(APP_VUE_CODE).not.toMatch(/parseAppShellPreferences/u);
    expect(APP_VUE_CODE).not.toMatch(/DEFAULT_APP_SHELL_PREFERENCES/u);
  });

  it('passes direction and color mode to the shell and renders the color mode toggle', () => {
    expect(APP_VUE_CODE).toMatch(/:dir="dir"/u);
    expect(APP_VUE_CODE).toMatch(/:color-mode="colorMode"/u);
    expect(APP_VUE_CODE).toMatch(/@update:color-mode="setColorMode"/u);
    expect(APP_VUE_CODE).toMatch(/<AppShellColorModeToggle/u);
  });
});
