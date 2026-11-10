import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLIC_LOCALES } from '../app/i18n/index';
import { HOME_CONTENT } from '../app/domain/home-content';
import {
  EXPECTED_OUTPUT_HTML_PATHS,
  assessOutputHtmlInventory,
} from '../shared/static-output-contract';

/**
 * Suite static-output — assert trên **artifact production thật** của
 * `apps/home` (`.output/public` prerender + `.output/server` Worker bundle),
 * chạy sau `nuxt build` (target `test` dependsOn `build`).
 *
 * Phạm vi sau khi gỡ stack @nuxt/content (issue #72):
 *
 * - inventory HTML prerendered **đầy đủ và đúng** — so bằng contract dùng
 *   chung (`assessOutputHtmlInventory`): thiếu hoặc thừa file đều đỏ;
 * - homepage locale-root (`/en`, `/vi`) là HTML prerendered **thật** (SSG):
 *   đầy đủ `<main>`, heading, canonical + hreflang tuyệt đối dưới production
 *   origin, và hydrate được (không phải shell SPA rỗng);
 * - `404.html` là trang lỗi SSR thật, không phải shell rỗng;
 * - không HTML prerendered nào còn trỏ tới bề mặt đã xoá (`/docs`, `/blog`,
 *   `/legal`) hay route content runtime (`/__nuxt_content`);
 * - contract deploy: Worker SSR + static assets, không SPA fallback, không
 *   `not_found_handling`, không database binding.
 */

/** Toàn bộ HTML prerendered trong output — nguồn inventory cho mọi test. */
const PRERENDERED_HTML = import.meta.glob<string>('../.output/public/**/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** `wrangler.jsonc` nguyên văn — assert trên giá trị JSON của config thật. */
const WRANGLER_CONFIG = (() => {
  const glob = import.meta.glob<string>('../wrangler.jsonc', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const key = Object.keys(glob).find((candidate) => candidate.endsWith('wrangler.jsonc'));
  if (key === undefined) {
    throw new Error('wrangler.jsonc not found in build inputs');
  }
  return glob[key];
})();

/** Key glob → đường dẫn tương đối `.output/public` (`en/index.html`…). */
function outputPath(key: string): string {
  return key.replace(/^\.\.\/\.output\/public\//u, '');
}

/** HTML prerendered của một path tương đối, kèm thông báo thiếu rõ ràng. */
function prerenderedHtml(path: string): string {
  const key = `../.output/public/${path}`;
  const html = PRERENDERED_HTML[key];
  if (html === undefined) {
    throw new Error(
      `Prerendered file ${path} is missing from .output/public — ` +
        `glob found [${Object.keys(PRERENDERED_HTML).map(outputPath).join(', ')}]. ` +
        'The build did not emit this route; see nitro.config.ts prerender seeds.',
    );
  }
  return html;
}

/** CSS build thật trong `_nuxt` — đọc qua `node:fs` (`?raw` trả rỗng cho CSS). */
function builtCss(): string {
  const entries = readdirSync('.output/public/_nuxt');
  const cssFiles = entries.filter((name) => name.endsWith('.css'));
  expect(cssFiles.length, 'bundled .css files in _nuxt').toBeGreaterThan(0);
  return cssFiles.map((name) => readFileSync(`.output/public/_nuxt/${name}`, 'utf8')).join('\n');
}

describe('static output: page inventory', () => {
  it('prerenders exactly the contract inventory — homepage locales plus 404.html', () => {
    // So **set equality** qua contract dùng chung: thiếu route SSG lẫn route
    // prerendered thừa (tàn dư của một bề mặt đã xoá) đều là vi phạm.
    const actual = Object.keys(PRERENDERED_HTML).map(outputPath).toSorted();
    // Khi lệch inventory, message của chính contract (đỏ ở assert dưới) là
    // thông báo chẩn đoán dev nhìn thấy — không cần message thứ hai.
    expect(assessOutputHtmlInventory(actual)).toBeNull();
  });

  it('keeps the contract inventory anchored to the real artifact file names', () => {
    // Contract phải mô tả đúng tên artifact Nitro sinh ra cho route `/en`, `/vi`
    // (`en/index.html`, `vi/index.html`) và tên `404.html` mà hook
    // `prerender:generate` đổi từ route ảo. Nếu Nitro đổi quy ước đặt tên, test
    // này đỏ trước khi mọi assertion per-file báo "file missing" mơ hồ.
    expect([...EXPECTED_OUTPUT_HTML_PATHS].toSorted()).toEqual([
      '404.html',
      'en/index.html',
      'vi/index.html',
    ]);
  });
});

describe('static output: locale-root pages (SSG)', () => {
  // `PUBLIC_LOCALES` là mảng definition (`{ code, hreflang }`), không phải
  // string — mọi assertion suy ra từ definition của registry, không hardcode.
  for (const { code: locale, hreflang } of PUBLIC_LOCALES) {
    const path = `${locale}/index.html`;
    const content = HOME_CONTENT[locale];

    it(`prerenders /${locale} as real SSR HTML, not an empty SPA shell`, () => {
      const html = prerenderedHtml(path);
      // Shell SPA rỗng (renderer `PRERENDER_NO_SSR_ROUTES`) chỉ có
      // `data-ssr="false"` và không một byte HTML của page — homepage phải
      // ngược lại: server-render đầy đủ.
      expect(html).toContain('data-ssr="true"');
      expect(html).toContain('<main');
      expect(html).toContain('<header');
      expect(html).toContain('<footer');
      // Nội dung render thật từ HOME_CONTENT, không phải placeholder.
      expect(html).toContain(`<h1`);
      expect(html).toContain(content.heading);
      expect(html).toContain(content.eyebrow);
    });

    it(`/${locale} declares the right language, absolute canonical and two-way hreflang`, () => {
      const html = prerenderedHtml(path);

      // `lang` là tag BCP-47 của registry (`vi` → `vi-VN`), đặt qua
      // `useHead` từ `buildHomeSeo` — không phải locale code của path.
      expect(html).toMatch(new RegExp(`<html[^>]+lang="${hreflang}"`, 'u'));
      // Canonical + hreflang là URL tuyệt đối dưới production origin — pin bởi
      // `buildHomeSeo` (`~/domain/home-origin`), không phụ thuộc origin build.
      expect(html).toContain(`<link rel="canonical" href="https://ecoma.io/${locale}"`);
      for (const other of PUBLIC_LOCALES) {
        expect(html).toContain(
          `<link rel="alternate" hreflang="${other.hreflang}" href="https://ecoma.io/${other.code}"`,
        );
      }
      // Meta description render từ đúng content của locale.
      expect(html).toContain(`name="description"`);
      expect(html).toContain(content.description);
    });

    it(`/${locale} renders the shared shell with brand and locale switcher only`, () => {
      const html = prerenderedHtml(path);
      // Brand của header trỏ đúng locale-root của chính trang.
      expect(html).toContain(`<a href="/${locale}"`);
      // Locale switcher: hai mục — locale hiện tại dạng `aria-current`, locale
      // còn lại là link có `hreflang`.
      expect(html).toContain('aria-label="Language"');
      expect(html).toContain('aria-current="true"');
      for (const other of PUBLIC_LOCALES) {
        if (other.code === locale) {
          continue;
        }
        expect(html).toContain(`hreflang="${other.hreflang}"`);
        expect(html).toContain(`href="/${other.code}"`);
      }
      // `hreflang` của chính trang phải xuất hiện trong switcher hoặc metadata
      // hai chiều — pin đúng tag BCP-47 của registry (`vi` → `vi-VN`).
      expect(html).toContain(`hreflang="${hreflang}"`);
      // CSS bundle của build được tham chiếu (không inline toàn bộ stylesheet).
      expect(html).toMatch(/<link[^>]+rel="stylesheet"/u);
    });
  }
});

describe('static output: 404 artifact', () => {
  it('404.html is a real SSR error page, not an empty SPA shell', () => {
    // Prerender route ảo `/en/__not-found` chạy đúng pipeline lỗi của Nuxt:
    // `validate` từ chối → 404 → `error.vue` SSR. Shell SPA của
    // `PRERENDER_NO_SSR_ROUTES` sẽ mang `data-ssr="false"` và stage rỗng.
    const html = prerenderedHtml('404.html');
    expect(html).toContain('data-ssr="true"');
    // Nội dung lỗi thật của `app/error-pages` (locale mặc định `en`).
    expect(html).toContain('Page not found');
    expect(html).toContain(HOME_CONTENT.en.notFoundTitle);
    expect(html).toContain(HOME_CONTENT.en.notFoundCta);
  });
});

describe('static output: no dead surfaces', () => {
  it('renders no link to a removed mount in any prerendered HTML', () => {
    // Docs/blog/legal đã bị xoá cùng stack content: mọi href còn sót trong
    // HTML prerendered là link chết — header/footer không được render chúng,
    // và homepage không được trỏ tới chúng.
    for (const [key, html] of Object.entries(PRERENDERED_HTML)) {
      for (const deadPrefix of ['/docs', '/blog', '/legal']) {
        expect(html, `${outputPath(key)} must not link to ${deadPrefix}`).not.toContain(
          `href="${deadPrefix}`,
        );
      }
    }
  });

  it('references no @nuxt/content runtime route in prerendered HTML', () => {
    // Route POST `/__nuxt_content/<collection>/query` của @nuxt/content không
    // còn tồn tại; hydration không được trỏ tới nó từ bất kỳ trang prerendered
    // nào.
    for (const [key, html] of Object.entries(PRERENDERED_HTML)) {
      expect(html, `${outputPath(key)} references __nuxt_content`).not.toContain('__nuxt_content');
    }
  });
});

describe('static output: deployment contract', () => {
  it('keeps wrangler config an SSR Worker with assets and no SPA or not-found fallback', () => {
    // Contract deploy, khẳng định trên **config thật**: Worker SSR (`main`
    // trỏ vào bundle Nitro) + static assets qua binding ASSETS, **không** SPA
    // fallback (`single-page-application` sẽ trả 200 cho path lạ) và không
    // `404-page` (sẽ nuốt SSR error page cho path lạ — 404 thật là sản phẩm
    // của Worker qua `validate` + `error.vue`). Config có comment giải thích
    // nên assert trên **giá trị JSON**, không phải trên từ khóa trần trong file.
    expect(WRANGLER_CONFIG).toContain('"name": "ecoma-home"');
    expect(WRANGLER_CONFIG).toContain('"main": ".output/server/index.mjs"');
    expect(WRANGLER_CONFIG).toContain('"directory": ".output/public"');
    expect(WRANGLER_CONFIG).toContain('"binding": "ASSETS"');
    expect(WRANGLER_CONFIG).not.toMatch(/"not_found_handling"\s*:\s*"single-page-application"/u);
    expect(WRANGLER_CONFIG).not.toMatch(/"not_found_handling"\s*:\s*"404-page"/u);
    expect(WRANGLER_CONFIG).not.toMatch(/"run_worker_first"/u);
    // Không D1: app không còn content pipeline nào cần database — Worker không
    // được mang binding database nào.
    expect(WRANGLER_CONFIG).not.toContain('d1_databases');
  });

  it('emits the server bundle — redirect `/`, unknown paths and no-index stay Worker-served', () => {
    // Homepage là SSG nhưng Worker vẫn phải tồn tại: `/` trả 302 server-side,
    // URL lạ đi qua `validate` → 404 SSR, middleware no-index gắn header lúc
    // request. `.output/server` PHẢI tồn tại.
    const serverEntry = import.meta.glob<string>('../.output/server/index.mjs', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(serverEntry)).toContain('../.output/server/index.mjs');
  });

  it('keeps homepage HTML self-contained: stylesheet bundle exists and carries the tokens', () => {
    // Homepage prerendered tham chiếu CSS bundle (assert trong per-locale test
    // ở trên); test này chốt bundle đó thực sự có mặt trong artifact và mang
    // design token — một build làm rơi `_nuxt` sẽ đỏ ở đây thay vì xanh với
    // homepage trần không style.
    const css = builtCss();
    expect(css).toContain('--color-ink');
    expect(css).toContain('--color-brand');
  });
});
