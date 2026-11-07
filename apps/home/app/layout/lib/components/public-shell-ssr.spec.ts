import { describe, it, expect, vi } from 'vitest';
// @vitest-environment node
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { PublicShell } from '../../index';

/**
 * SSR/SSG compatibility: render shell trong môi trường **không có DOM**
 * (node). Nếu component phụ thuộc `window`/`document` hay client-only API
 * thì test này throw ngay — đúng bằng chứng cần cho SSG-first public web.
 */
describe('PublicShell SSR', () => {
  it('renders the full shell to a string without a DOM', async () => {
    const app = createSSRApp({
      render: () => h(PublicShell, { path: '/en/docs/api' }, { default: () => 'SSR_CONTENT' }),
    });
    const html = await renderToString(app);

    expect(html).toContain('SSR_CONTENT');
    expect(html).toContain('<header');
    expect(html).toContain('<main');
    expect(html).toContain('<footer');
    expect(html).toContain('href="/en"');
    // Brand render đúng artwork ngay trong HTML cả trên server — logo là
    // inline `<svg>` (mark + wordmark), accessible name do `aria-label` mang.
    expect(html).toContain('aria-label="ecoma.io"');
    expect(html).toMatch(/<svg[^>]*viewBox="[^"]*"/u);
    expect(html).toContain('<path');
    expect(html).toContain('class="fill-brand"');
    expect(html).toContain('class="fill-foam"');
    // Nav và locale switcher là HTML tĩnh, crawlable — không phụ thuộc hydration.
    expect(html).toContain('href="/en/docs"');
    expect(html).toContain('href="/vi/docs/api"');
    expect(html).toContain('hreflang="vi-VN"');
  });

  it('is deterministic: renders are identical even when system time differs', async () => {
    // Hai render ở hai system time khác nhau — bắt code đọc `Date` (mà
    // render thường chỉ vô tình đọc được qua `Date.now`/`getFullYear`).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2001-02-03T04:05:06.000Z'));
      const first = await renderShell('/vi/blog/hello');
      vi.setSystemTime(new Date('2049-12-31T23:59:59.000Z'));
      expect(await renderShell('/vi/blog/hello')).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders root and invalid paths without throwing', async () => {
    for (const path of ['/', '/en/unknown', 'garbage']) {
      const app = createSSRApp({
        render: () => h(PublicShell, { path }, { default: () => 'X' }),
      });
      const html = await renderToString(app);
      expect(html).toContain('<header');
      expect(html).toContain('<main');
    }
  });
});

/** Render shell cho một path — dùng kiểm chứng deterministic (SSR thuần, không DOM). */
async function renderShell(path: string): Promise<string> {
  const app = createSSRApp({
    render: () => h(PublicShell, { path }, { default: () => 'X' }),
  });
  return renderToString(app);
}
