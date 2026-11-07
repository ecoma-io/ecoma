import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// @vitest-environment node
import { createSSRApp, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';

import { PUBLIC_LOCALES } from '../i18n/index';

/**
 * SSR thật cho page Home — render trong môi trường **node**, không DOM.
 *
 * Khác với `home-page.spec.ts` (mount trong jsdom, chỉ kiểm tra cây component),
 * file này chạy đúng đường render của server: `renderToString` của
 * `vue/server-renderer` trên `createSSRApp`. Đây là lớp kiểm chứng mà một lần
 * mount jsdom **không** thay thế được:
 *
 * - không có `document`/`window` — bất kỳ browser-only API nào trong đường SSR
 *   (trực tiếp hay qua component con) làm test đỏ ngay;
 * - output là HTML tĩnh, nên header/footer/nội dung phải có mặt **trong
 *   string** chứ không phải trong DOM ảo;
 * - không có hydration — chỉ đường render phía server.
 *
 * Phần `<head>` (lang/title/description/canonical/hreflang) do unhead quản lý
 * và unhead là dependency **transitive** của `nuxt`, không resolve được từ
 * workspace package này; thêm nó làm devDependency là thêm framework cho một
 * test. Nên ở đây `useHead` được stub **có ghi lại** input, và test khẳng định
 * đúng payload mà page đưa cho unhead (nguồn của `<head>`). Việc `<head>` thật
 * trong response Nitro/Wrangler chứa các thẻ đó được kiểm bằng runtime smoke
 * trên output đã build (`wrangler dev --local`), không phải bằng file này —
 * xem comment ở cuối file.
 */

vi.stubGlobal('definePageMeta', (): void => undefined);
vi.stubGlobal('createError', (options: { statusCode: number; statusMessage: string }): Error =>
  Object.assign(new Error(options.statusMessage), options),
);

/** Input `useHead` của lần render gần nhất — ghi lại thay vì bỏ qua. */
type RecordedHead = {
  readonly htmlAttrs?: { readonly lang?: string };
  readonly title?: string;
  readonly meta?: readonly { readonly name?: string; readonly content?: string }[];
  readonly link?: readonly {
    readonly rel?: string;
    readonly hreflang?: string;
    readonly href?: string;
  }[];
};

let recordedHead: RecordedHead | undefined;
vi.stubGlobal('useHead', (input: RecordedHead): void => {
  recordedHead = input;
});

let currentPath = '/en';
vi.stubGlobal('useRoute', () => ({ path: currentPath }));

let HomePage: Component;

beforeAll(async () => {
  // Dynamic import sau khi stub — import tĩnh bị ESM hoist lên trước `stubGlobal`.
  HomePage = ((await import('~/pages/[locale]/index.vue')) as { default: Component }).default;
});

/** Render page ở `path` bằng đúng đường SSR của server; trả HTML + head input. */
async function renderOnServer(path: string): Promise<{ html: string; head: RecordedHead }> {
  currentPath = path;
  recordedHead = undefined;
  const app = createSSRApp(HomePage);
  const html = await renderToString(app);
  if (recordedHead === undefined) {
    throw new Error('Page did not call useHead');
  }
  return { html, head: recordedHead };
}

const canonicalOf = (head: RecordedHead): string | undefined =>
  head.link?.find((link) => link.rel === 'canonical')?.href;

const alternatesOf = (head: RecordedHead): readonly { hreflang?: string; href?: string }[] =>
  (head.link ?? []).filter((link) => link.rel === 'alternate');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SSR render of app/pages/[locale]/index.vue', () => {
  it('runs in a node environment — no DOM (the condition of a real SSR test)', () => {
    // Nếu environment là jsdom thì các khẳng định dưới đây không còn chứng minh
    // được đường server-render nữa; chốt lại để không âm thầm mất tính chất đó.
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  it('/en: server renders HTML with h1/header/footer and no errors/warnings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);

    const { html } = await renderOnServer('/en');

    expect(html).toContain('<h1');
    // Brand xuất hiện trong chính HTML server trả về: logo footer mang
    // `alt="ecoma.io"` (artwork qua `<img>` — xem `EcomaLogo`), nên chuỗi
    // `ecoma.io` nằm trong body render, không phải chỉ trong `<head>`.
    expect(html).toContain('ecoma.io');
    // Nội dung hero v2 render đầy đủ trong SSR — heading mới của HOME_CONTENT.
    expect(html).toContain('Public web, built right');
    expect(html).toContain('<ul');
    expect(html).toContain('<header');
    expect(html).toContain('<footer');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('/en: head input has lang=en, title, description, absolute canonical + two alternates', async () => {
    const { head } = await renderOnServer('/en');

    expect(head.htmlAttrs?.lang).toBe('en');
    expect(head.title).toBe('Ecoma.io — public home');
    expect(head.meta?.find((meta) => meta.name === 'description')?.content).toContain(
      'The public home of ecoma.io',
    );
    expect(canonicalOf(head)).toBe('https://ecoma.io/en');

    const alternates = alternatesOf(head);
    expect(alternates).toHaveLength(PUBLIC_LOCALES.length);
    expect(alternates.find((a) => a.hreflang === 'en')?.href).toBe('https://ecoma.io/en');
    expect(alternates.find((a) => a.hreflang === 'vi-VN')?.href).toBe('https://ecoma.io/vi');
  });

  it('/vi: server renders Vietnamese content, head has lang=vi-VN and canonical /vi', async () => {
    const { html, head } = await renderOnServer('/vi');

    expect(html).toContain('Mọi trang đều được phục vụ dưới một locale prefix');
    expect(html).not.toContain('Every page is served');
    expect(head.htmlAttrs?.lang).toBe('vi-VN');
    expect(head.title).toBe('Ecoma.io — trang chủ public');
    expect(canonicalOf(head)).toBe('https://ecoma.io/vi');
    expect(alternatesOf(head).find((a) => a.hreflang === 'vi-VN')?.href).toBe(
      'https://ecoma.io/vi',
    );
  });

  it('the two locales server-render different HTML — no content leaks between them', async () => {
    const en = await renderOnServer('/en');
    const viRender = await renderOnServer('/vi');
    expect(en.html).not.toBe(viRender.html);
    expect(en.head).not.toEqual(viRender.head);
  });

  it('deterministic: two server renders of the same path yield the same HTML and head', async () => {
    const first = await renderOnServer('/en');
    const second = await renderOnServer('/en');
    expect(second.html).toBe(first.html);
    expect(second.head).toEqual(first.head);
  });

  // Giới hạn đã biết, ghi rõ để không ai đọc file này như một integration test
  // đầy đủ: unhead không được chạy ở đây nên `<head>` thật (thứ tự thẻ, thuộc
  // tính `href` render ra HTML, `<link rel=canonical>` trong response) **không**
  // được khẳng định trong file này. Kiểm chứng đó là **runtime smoke** trên
  // output đã build — `nx run home:build` rồi `npx wrangler dev --local` và
  // kiểm HTML thật của `/en`, `/vi` (canonical + hreflang tuyệt đối) cùng
  // routing matrix (`/` → 302 `/en`; `/fr`, `/en/`, `/%65n` → 404). Smoke là
  // thao tác thủ công có thể lặp lại, không phải một test tự động — nên nó
  // không nằm trong `nx run home:test`.
});
