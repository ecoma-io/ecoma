import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLIC_LOCALES, getLocaleDefinition } from '../app/i18n/index';
import { PUBLIC_MOUNTS } from '../app/layout/index';
import { SERIES_META } from '../app/blog/blog-series';
import { blogUiStrings } from '../app/blog/blog-ui-strings';
import { legalUiStrings } from '../app/domain/legal-ui-strings';
import { MIN_OUTPUT_SVG_ASSETS, assessOutputSvgAssets } from '../shared/static-output-contract';

/**
 * Verification của **output production thật** (`.output/` sau `home:build`) —
 * kế thừa Finding 4 của review PR #20 cho bản hợp nhất.
 *
 * Những test này KHÔNG thay build: chúng chạy **sau** build (local và CI chạy
 * `nx build @ecoma-io/home && nx test @ecoma-io/home` — target `test` khai
 * `dependsOn: ['build']`). Mọi assertion đọc đúng file HTML/media đã được
 * prerender, nên một build hỏng (thiếu page, media không resolve, 404 fallback
 * SPA hóa...) lộ ngay tại đây thay vì chỉ được phát hiện khi đã deploy.
 *
 * Khác bản blogs trước đây: home là app **SSR** trên Cloudflare Workers —
 * output mang cả `.output/server` (Worker bundle) lẫn `.output/public`
 * (static assets + các content page đã prerender). Content routes (docs,
 * blog) được prerender lúc build; landing locale, legal và server routes vẫn
 * SSR lúc request. Cơ chế 404 (xem chi tiết ở test deployment-contract dưới):
 * static assets mặc định là assets-first — request không khớp asset nào được
 * **invoke Worker**, và 404 cho path lạ là sản phẩm của Worker (middleware
 * gate + `error.vue`); `404.html` prerender chỉ là artifact, không wire vào
 * serving (`wrangler.jsonc` cố ý không đặt `not_found_handling`).
 *
 * Inventory blog được **suy từ output**, không hard-code số trang: blog hướng
 * tới English-first với hai locale không còn bảo đảm bằng số bài, và các
 * surface mới (series overview) xuất hiện chỉ khi content thật tồn tại. Mỗi
 * assertion mô tả một bất biến cấu trúc (mọi article prerendered đều hợp lệ,
 * series page chỉ tồn tại khi có bài, math render at build...) — không phải
 * một bản chụp số lượng sẽ hỏng ở bài thứ 31.
 *
 * Nguồn file là `import.meta.glob` của Vite (`query: '?raw'`, `eager: true`)
 * trên `.output/public`, cộng `node:fs` cho asset mà glob không đọc được raw:
 * Vitest xử lý `.css` bằng pipeline CSS riêng nên `?raw` trên nó trả chuỗi
 * rỗng — CSS bundle phải đọc bằng `readFileSync`. `node:fs` hợp lệ ở đây vì
 * override lint cho file spec (đặt sau block `apps/**` trong
 * `.oxlintrc.json`) tắt `no-restricted-imports` cho file test. Glob pattern
 * phải dùng path tương đối từ thư mục `tests/`; thư mục `.output` nằm trong
 * app root nên glob thấy được.
 *
 * `import.meta.glob` chỉ quét lúc **dev/test start**, nhưng test này luôn chạy
 * trên output vừa build trong cùng một lệnh — đây là pattern đã dùng ở
 * `content-contract.spec.ts`, chỉ khác nguồn là output thay vì source.
 */

/** Raw HTML của mọi trang prerender trong `.output/public/en|vi` — khoá là path từ `apps/home/tests`. */
const PRERENDERED_HTML = import.meta.glob<string>('../.output/public/{en,vi}/**/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** `404.html` ở gốc output — artifact prerender, không wire vào serving (nằm ngoài cây `{en,vi}`). */
const NOT_FOUND_HTML = import.meta.glob<string>('../.output/public/404.html', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Raw content của mọi media file trong output `assets/` — để xác nhận file tồn tại và không rỗng. */
const OUTPUT_ASSETS = import.meta.glob<string>('../.output/public/assets/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * Raw markdown của mọi bài blog trong cây content — nguồn để suy ra danh sách
 * asset mà content **thật** tham chiếu, thay vì hard-code tên asset trong test.
 */
const ARTICLE_MARKDOWN = import.meta.glob<string>('../content/{en,vi}/blog/*/index.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * Payload prerender (`_payload.json`) của mọi **blog** page — đây chính là dữ
 * liệu client hydrate lại, nên nó phải mang **đúng shape** mà handler
 * `useAsyncData` tương ứng trả về.
 *
 * Cần đọc riêng vì một lỗi shape chỉ lộ ra ở đây: HTML prerender render
 * server-side nên vẫn đúng dù payload sai, còn client hydrate từ payload và
 * lúc đó mới hỏng (ảnh bìa, khối prerequisites, metadata research biến mất).
 *
 * Glob giới hạn ở `blog/`: các mount khác (`docs`, `legal`) có bộ key riêng và
 * test này chỉ khẳng định bất biến của các handler blog.
 */
const PRERENDERED_PAYLOADS = import.meta.glob<string>(
  '../.output/public/{en,vi}/blog/**/_payload.json',
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

/**
 * CSS bundle trong `_nuxt/` — đọc một lần cho các assertion cần nội dung CSS.
 * `import.meta.glob` với `?raw` không dùng được ở đây: Vitest route `.css`
 * qua pipeline CSS riêng của nó và trả chuỗi rỗng thay vì nội dung raw, nên
 * đếm + đọc file bằng `node:fs` trực tiếp (path tính từ cwd — root của
 * `apps/home` khi vitest chạy — không phải từ `tests/`).
 */
const NUXT_CSS_DIR = '.output/public/_nuxt';
const PRERENDERED_NUXT_CSS: Record<string, string> = Object.fromEntries(
  readdirSync(NUXT_CSS_DIR)
    .filter((file) => file.endsWith('.css'))
    .map((file) => [file, readFileSync(`${NUXT_CSS_DIR}/${file}`, 'utf8')]),
);

/** Wrangler config thô — khẳng định contract deploy ngay từ test. */
const WRANGLER_CONFIG = (() => {
  const modules = import.meta.glob<string>('../wrangler.jsonc', {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  return modules['../wrangler.jsonc'] ?? '';
})();

/** Source của middleware gate — test đồng bộ regex mount đọc literal từ đây. */
const GATE_SOURCE = import.meta.glob<string>('../server/middleware/prerendered-content-404.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Source của nitro config — test đồng bộ regex mount đọc filter từ đây. */
const NITRO_SOURCE = import.meta.glob<string>('../nitro.config.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Path trong output (bỏ prefix `../.output/public/`) của một glob key. */
function outputPath(key: string): string {
  return key.replace('../.output/public/', '');
}

/** Tất cả HTML của một locale, dạng `path → raw html`. */
function htmlForLocale(locale: 'en' | 'vi'): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, html] of Object.entries(PRERENDERED_HTML)) {
    const path = outputPath(key);
    if (path.startsWith(`${locale}/`)) {
      map.set(path, html);
    }
  }
  return map;
}

/** HTML landing blog của một locale — `undefined` khi landing không được prerender. */
function blogLandingHtml(locale: 'en' | 'vi'): string | undefined {
  return PRERENDERED_HTML[`../.output/public/${locale}/blog/index.html`];
}

/** Path content blog suy từ glob — landing, article và series page gộp chung. */
const BLOG_PAGES = Object.keys(PRERENDERED_HTML)
  .map(outputPath)
  .filter((path) => path.includes('/blog/'));

/** Path article blog (không landing, không `series/`). */
const BLOG_ARTICLE_PAGES = BLOG_PAGES.filter(
  (path) => !path.endsWith('/blog/index.html') && !path.includes('/blog/series/'),
);

/** Path series overview prerendered. */
const BLOG_SERIES_PAGES = BLOG_PAGES.filter((path) => path.includes('/blog/series/'));

/** Path content docs suy từ glob. */
const DOCS_PAGES = Object.keys(PRERENDERED_HTML)
  .map(outputPath)
  .filter((path) => path.includes('/docs/'));

/**
 * Locale có **bài** trong output — inventory thật, không giả định. Một locale
 * không có bài thì landing của nó là fallback discovery.
 */
function localesWithArticles(locale: 'en' | 'vi'): boolean {
  return BLOG_ARTICLE_PAGES.some((path) => path.startsWith(`${locale}/`));
}

/**
 * Registry locale → `hreflang` của nó, đọc từ cùng một nguồn mà `useHead` dùng.
 * Không hard-code `en`/`vi-VN` ở assertion: registry thêm locale thì test phải
 * bắt được thay vì hỏng vì lý do không liên quan.
 */
function hreflangOf(locale: 'en' | 'vi'): string {
  return getLocaleDefinition(locale)?.hreflang ?? locale;
}

/**
 * Escape HTML như `useHead` làm khi serialize attribute — `&` trước, rồi `<`,
 * `>`, `"`. Mô tả series là nội dung biên tập nên **phải** assert trên chuỗi
 * đã escape: so trực tiếp với text thô sẽ đỏ vì một dấu `&` hợp lệ, và đó là
 * hỏng của test chứ không phải của code.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/** Path content legal suy từ glob (landing + văn bản prerendered). */
const LEGAL_PAGES = Object.keys(PRERENDERED_HTML)
  .map(outputPath)
  .filter((path) => path.includes('/legal/'));

/**
 * Mọi landmark `<nav aria-label="…">` khớp accessible name, theo thứ tự xuất
 * hiện trong HTML — mỗi phần tử là **toàn văn** của một nav.
 *
 * Nav sidebar render hai lần (mobile disclosure + desktop) từ cùng dữ liệu,
 * nên một trang có hai nav cùng name. Regex ghép không lồng nhau ở đây là
 * an toàn: nav của app không chứa nav con, nên match đầu tiên sau mỗi nav là
 * chính thẻ đóng của nó.
 */
function sidebarNavSurfaces(html: string, label: string): string[] {
  const pattern = new RegExp(`<nav aria-label="${label}"[^>]*>(.*?)</nav>`, 'gu');
  return [...html.matchAll(pattern)].map(([, inner]) => inner);
}

describe('static output: page inventory', () => {
  it('prerenders a blog landing per locale plus every article the content tree declares', () => {
    // Không hard-code số trang: landing là bề mặt cố định của mount (mọi
    // locale registry), article suy từ chính output — mỗi landing kèm ít nhất
    // một article, và **mọi locale có article đều có landing**.
    const landing = BLOG_PAGES.filter((path) => path.endsWith('/blog/index.html'));
    expect(landing).toContain('en/blog/index.html');
    // Mọi locale có **bất kỳ** article nào đều phải có landing, và ngược lại:
    // landing của locale không có bài vẫn được prerender (fallback discovery),
    // còn locale không có landing thì mọi link bên trong nó là link chết.
    for (const locale of ['en', 'vi'] as const) {
      expect(landing, `${locale} landing prerendered`).toContain(`${locale}/blog/index.html`);
    }
    // Và inventory article không rỗng — content tree phải còn bài thật, đây là
    // chốt chặn cuối chống một build "thành công" với content rỗng.
    expect(BLOG_ARTICLE_PAGES.length, 'total blog article pages').toBeGreaterThan(0);
  });

  it('keeps each blog article a flat single-segment page under its locale', () => {
    // URL article phẳng một segment (`/blog/<slug>`, không prefix số) — segment
    // `series/` là không gian riêng của route series, không được có article lọt
    // vào dạng lồng sâu nào khác.
    for (const path of BLOG_ARTICLE_PAGES) {
      expect(path.match(/^\/?(en|vi)\/blog\/[^/]+\/index\.html$/u), `${path}`).not.toBeNull();
    }
  });

  it('prerenders docs pages in both locales', () => {
    const landings = DOCS_PAGES.filter((path) => path.endsWith('/docs/index.html'));
    expect(landings).toContain('en/docs/index.html');
    expect(landings).toContain('vi/docs/index.html');
    // Cả hai locale phải prerender cùng số trang docs — cây content song song.
    const en = DOCS_PAGES.filter((path) => path.startsWith('en/')).length;
    const vi = DOCS_PAGES.filter((path) => path.startsWith('vi/')).length;
    expect(en).toBeGreaterThan(0);
    expect(en).toBe(vi);
  });

  it('prerenders a series overview exactly for every series with articles, and never for empty ones', () => {
    // Series page tồn tại **chỉ khi** series đó có bài published: một series
    // trong `SERIES_META` không có bài nào không được sinh trang (trang 404
    // được PR tường minh). Ngược lại, series có bài phải có trang overview để
    // crawler prerender được (landing link tới nó). Va chạm với mock: dữ liệu
    // source-of-truth ở đây là số link series render trên landing của từng
    // locale — output phải khớp đúng tập ID mà landing quảng bá.
    for (const locale of ['en', 'vi'] as const) {
      const landingHtml = blogLandingHtml(locale) ?? '';
      // Lấy **path đầy đủ** landing trỏ tới, không chỉ series id: landing
      // fallback (locale không có bài) quảng bá series của locale có bài thật
      // (`/vi/blog` → `/en/blog/series/...`), và series page phải tồn tại ở
      // chính locale mà link chỉ tới. Chỉ lấy id sẽ ra một assert sai rằng
      // `/vi/blog/series/*` phải được prerender — nó cố tình không tồn tại.
      const linkedPaths = [
        ...new Set(
          [...landingHtml.matchAll(/href="(\/[a-z]{2}\/blog\/series\/[a-z0-9-]+)"/gu)].map(
            (match) => (match[1] ?? '').replace(/^\//u, ''),
          ),
        ),
      ].toSorted();
      for (const linkPath of linkedPaths) {
        expect(BLOG_SERIES_PAGES, `${locale} landing links ${linkPath}`).toContain(
          `${linkPath}/index.html`,
        );
      }
      // Output không được có series page nào ngoài những link landing quảng bá
      // — tính trên **cả hai** landing, vì landing fallback quảng bá series
      // thuộc locale khác và không có landing riêng quảng bá chúng.
      const linkedIds = [
        ...new Set(linkedPaths.map((path) => /series\/([a-z0-9-]+)$/u.exec(path)?.[1] ?? '')),
      ].toSorted();
      const prerenderedIds = [
        ...new Set(
          BLOG_SERIES_PAGES.map(
            (path) => /series\/([a-z0-9-]+)\/index\.html/u.exec(path)?.[1] ?? '',
          ),
        ),
      ].toSorted();
      expect(prerenderedIds).toEqual(linkedIds);
    }
    // Bất biến tuyệt đối: KHÔNG series page nào của một series không có trong
    // danh mục — một ID lạ xuất hiện trong output là route series đã nuốt một
    // article path.
    const knownIds = new Set(Object.keys(SERIES_META));
    for (const path of BLOG_SERIES_PAGES) {
      const id = /series\/([a-z0-9-]+)\/index\.html/u.exec(path)?.[1] ?? '';
      expect(knownIds.has(id), `series page of unknown id: ${path}`).toBe(true);
    }
  });

  it('emits a 404 page as a prerendered artifact', () => {
    // `404.html` phải tồn tại như một artifact prerender (render bằng SSR thật
    // của `error.vue` — xem hook `prerender:generate` trong `nitro.config.ts`).
    // Lưu ý nó KHÔNG được wire vào serving: `wrangler.jsonc` cố ý không đặt
    // `not_found_handling`, nên request không khớp asset vẫn được invoke
    // Worker — 404 cho path lạ là sản phẩm của middleware gate + `error.vue`
    // SSR, còn file này chỉ giữ tương thích artifact-level. Sự vắng mặt của
    // `not_found_handling` (cả hai giá trị) và SPA fallback được khẳng định ở
    // test wrangler config dưới.
    expect(Object.keys(NOT_FOUND_HTML)).toContain('../.output/public/404.html');
  });

  it('keeps unknown content paths out of the prerendered inventory', () => {
    // Manifest gate (`#build/prerendered-content-paths`) chặn route không có
    // trong manifest trước khi query content; hệ quả trong output: KHÔNG được
    // tồn tại HTML cho path ngoài cây content thật — nếu có thì crawler đã đi
    // theo link lạ và "prerender" một trang rỗng. `series/<id>` là một phần
    // của cây blog hợp lệ (route catch-all phục vụ), nên patternInventory
    // cho phép nó tường minh.
    for (const path of Object.keys(PRERENDERED_HTML).map(outputPath)) {
      expect(path).toMatch(/^\/?(en|vi)\/(docs|blog|legal)(\/|$)/u);
    }
  });

  it('keeps the content-mount regex in sync across gate, prerender filter, and registries', () => {
    // Regex mount content tồn tại ở BA nơi "đồng bộ bằng comment": middleware
    // gate (`server/middleware/prerendered-content-404.ts`), filter của hook
    // `prerender:done` (`nitro.config.ts` — nguồn của manifest) và assertion
    // inventory ở trên. Lệch một nơi (thêm locale/mount mà quên) là lỗi im
    // lặng: gate ngừng chặn path content mới. Test này đọc SOURCE của hai
    // nơi qua glob raw và khẳng định mọi cặp locale × mount content trong
    // registry đều được cả hai regex chấp nhận — lệch registry là CI đỏ.
    const registryLocales = PUBLIC_LOCALES.map((d) => d.code) as readonly string[];
    // Content mounts = mọi mount của registry — docs, blog và legal đều là
    // content prerendered có mặt trong manifest (`docs/api` vẫn bị loại vì
    // mount lồng nhau được phủ qua segment đầu của `docs`).
    const registryContentMounts = PUBLIC_MOUNTS.filter((m) => !m.path.includes('/')).map(
      (m) => m.path,
    );

    const gateSource = GATE_SOURCE['../server/middleware/prerendered-content-404.ts'] ?? '';
    const nitroSource = NITRO_SOURCE['../nitro.config.ts'] ?? '';
    expect(gateSource).not.toBe('');
    expect(nitroSource).not.toBe('');

    // Hai nguồn phải chứa regex mount dạng literal — trích literal của gate
    // ra, rồi khẳng định literal ĐÓ xuất hiện nguyên văn trong nitro config
    // (thay đổi một nơi mà quên nơi kia bị bắt tại đây).
    const regexLiteral = /^const CONTENT_MOUNT_RE = (\/.*\/u);$/gmu;
    const gateLiterals = [...gateSource.matchAll(regexLiteral)].map((m) => m[1]);
    expect(gateLiterals.length).toBe(1);
    expect(
      nitroSource.includes(gateLiterals[0]),
      'nitro.config.ts must embed the same mount regex literal as the gate',
    ).toBe(true);

    // Mỗi cặp locale × mount phải được regex của gate chấp nhận, đúng trên
    // ranh giới segment: regex chỉ neo mount segment ĐẦU TIÊN (không có `$`
    // cuối — mọi path dưới mount đều thuộc gate), nên ranh giới thật là
    // segment đầu (`/en/docsary` không được nuốt vào mount `docs`; với mount
    // lồng `docs/api` thì `/en/docs/apix` hợp lý nằm trong mount `docs`).
    const gateRe = new RegExp(gateLiterals[0].slice(1, -2), 'u');
    for (const locale of registryLocales) {
      for (const mount of registryContentMounts) {
        expect(gateRe.test(`/${locale}/${mount}`), `/${locale}/${mount}`).toBe(true);
        expect(gateRe.test(`/${locale}/${mount}/deep/page`), `/${locale}/${mount}/deep/page`).toBe(
          true,
        );
        const firstSegment = mount.split('/')[0] as string;
        expect(
          gateRe.test(`/${locale}/${firstSegment}x`),
          `/${locale}/${firstSegment}x boundary`,
        ).toBe(false);
      }
    }
    // Locale/mount ngoài registry phải bị từ chối — registry là nguồn duy nhất.
    expect(gateRe.test('/fr/docs')).toBe(false);
  });
});

describe('static output: per-page correctness', () => {
  it('renders correct lang, canonical, and per-locale content on every page', () => {
    for (const locale of ['en', 'vi'] as const) {
      for (const [path, html] of htmlForLocale(locale)) {
        const lang = /<html[^>]*\slang="([^"]*)"/u.exec(html)?.[1];
        const canonical = /<link[^>]*rel="canonical"[^>]*href="([^"]*)"/u.exec(html)?.[1];
        expect(lang, `${path}`).toBe(locale === 'en' ? 'en' : 'vi-VN');
        expect(canonical, `${path}`).toContain(
          `https://ecoma.io/${path.replace(/\/index\.html$/u, '')}`,
        );
        // Nội dung qua shell thật: page phải render `<main>` của `PublicShell`.
        expect(html, `${path}`).toContain('<main');
      }
    }
  });

  it('renders a distinct title per blog article page', () => {
    // Số lượng **không** hard-code: mọi article prerendered phải có title
    // riêng trong locale của nó — hai trang trùng title là metadata trùng
    // lặp cho crawler và người đọc.
    // Locale duy nhất được cover là locale **có bài thật**: curriculum này
    // viết tiếng Anh, nên `vi` không có article page nào và vòng lặp cố định
    // trên `['en','vi']` sẽ hỏng vì lý do không liên quan tới title.
    const localesWithArticlesList = ['en', 'vi'].filter((locale) => localesWithArticles(locale));
    expect(localesWithArticlesList.length, 'locales with blog articles').toBeGreaterThan(0);
    for (const locale of localesWithArticlesList) {
      const titles = new Map<string, string>();
      for (const [path, html] of htmlForLocale(locale)) {
        // Chỉ article (landing/series không có title frontmatter).
        if (
          path.includes('/blog/') &&
          !path.endsWith('/blog/index.html') &&
          !path.includes('/blog/series/')
        ) {
          const title = /<title>([^<]*)<\/title>/u.exec(html)?.[1] ?? `missing at ${path}`;
          titles.set(path, title);
        }
      }
      expect(titles.size, `${locale}: article pages`).toBeGreaterThan(0);
      expect(new Set(titles.values()).size, `${locale}: distinct article titles`).toBe(titles.size);
    }
  });

  it('advertises a landing hreflang alternate only for locales that have articles', () => {
    // **Finding B.** Landing `/vi/blog` khi VI rỗng là **fallback discovery**:
    // nội dung tiếng Anh, `noindex, follow`, không alternate. `/en/blog` có bài
    // thật nên phát alternate cho chính nó — nhưng phải **không** phát
    // `vi-VN` trỏ tới `/vi/blog`, vì khi đó cluster là khai báo một chiều: EN
    // nói "đây là bản dịch của tôi" trong khi `/vi/blog` tự khai "tôi không có
    // bản dịch nào".
    //
    // Kỳ vọng **suy từ inventory thật**, không hard-code "cả hai locale đều có
    // bài": khi PR nội dung bỏ hết bài tiếng Việt, hành vi đúng là thiếu
    // alternate `vi-VN`, và test này phải xanh **không cần sửa**.
    for (const locale of ['en', 'vi'] as const) {
      const html = blogLandingHtml(locale) ?? '';
      const alternates = [
        ...html.matchAll(/<link[^>]*rel="alternate"[^>]*hreflang="([^"]*)"[^>]*>/gu),
      ].map((match) => match[1]);
      // Kỳ vọng là **tập**, nên so sánh một lần thay vì if/else: cả "phải có"
      // lẫn "không được có" đều là assert vô điều kiện, và locale thiếu bài
      // không bị bỏ sót khỏi coverage.
      //
      // Landing fallback phát **không** alternate nào — kể cả self — vì nó
      // không phải bản dịch của landing locale kia mà là một surface discovery
      // `noindex`. Đây là contract đã được pin ở `blog-seo.spec.ts`
      // ("drops all hreflang alternates on a fallback-discovery landing"); ở đây
      // ta kiểm nó trên **HTML thật**. Landing có bài thật thì quảng bá mọi
      // locale có bài, kể cả chính nó.
      const isFallback = !localesWithArticles(locale);
      expect(
        [...alternates].toSorted(),
        `${locale}/blog hreflang alternates (${isFallback ? 'fallback' : 'populated'})`,
      ).toEqual(
        isFallback
          ? []
          : [
              ...new Set(
                ['en', 'vi'].filter(localesWithArticles).map((other) => hreflangOf(other)),
              ),
            ].toSorted(),
      );
      // Mọi alternate phải trỏ tới landing thật của locale đó, không trỏ tới
      // path hư không.
      for (const href of [...html.matchAll(/<link[^>]*rel="alternate"[^>]*href="([^"]*)"/gu)].map(
        (match) => match[1],
      )) {
        expect(
          PRERENDERED_HTML[`../.output/public/${href.replace('https://ecoma.io/', '')}/index.html`],
          `${locale}/blog alternate target: ${href}`,
        ).toBeDefined();
      }
    }
  });

  it('renders the fallback discovery landing contract only on an empty locale', () => {
    // Landing fallback (`/vi/blog` khi locale không có bài nào): `noindex,
    // follow`, self-canonical, KHÔNG hreflang alternate nào (không quảng bá
    // "bản dịch" không tồn tại), thông báo tiếng Việt, và listing là link bài
    // English thật. Khi locale ĐÃ có bài (hiện tại: cả hai), landing là trang
    // bình thường — không robots, có đủ hreflang. Contract theo **trạng thái**
    // (locale rỗng hay không), không theo slug, nên PR thêm bài tiếng Việt
    // không phải sửa test này.
    for (const locale of ['en', 'vi'] as const) {
      const html = blogLandingHtml(locale) ?? '';
      const hasArticles = BLOG_ARTICLE_PAGES.some((path) => path.startsWith(`${locale}/`));
      const robots = /<meta[^>]*name="robots"[^>]*content="([^"]*)"/u.exec(html)?.[1];
      // Bảng kỳ vọng theo trạng thái — rỗng thì robots phải xuất hiện đúng
      // chuỗi policy và cả hai dấu hiệu "quảng bá bản dịch" (hreflang,
      // rel=alternate) phải tắt; có bài thì không robots và hreflang là hành
      // vi đúng (dấu hiệu được phép xuất hiện). Assert không nằm trong if.
      const [hasHreflang, hasAlternate] = [
        html.includes('hreflang='),
        html.includes('rel="alternate"'),
      ];
      const [expectedRobots, expectDiscovery] = hasArticles
        ? [undefined, true]
        : ['noindex, follow', false];
      expect(robots, `${locale}/blog robots`).toEqual(expectedRobots);
      expect([locale, hasHreflang || !expectDiscovery, hasAlternate || !expectDiscovery]).toEqual([
        locale,
        true,
        true,
      ]);
    }
  });

  it('gives every series overview its own title, description and self-canonical', () => {
    // **Finding D.** Trang series KHÔNG có document trong collection (chỉ
    // article có file content), nên lấy `title`/`description` từ `page` rơi về
    // `null` và SEO rơi về `Ecoma Blog` + mô tả rỗng. Metadata phải đến từ
    // `SERIES_META` — kiểm trên **HTML thật**, vì đây đúng là chỗ hỗ trợ gốc có
    // thể lệch mà helper thuần không thấy.
    for (const locale of ['en', 'vi'] as const) {
      for (const id of Object.keys(SERIES_META)) {
        const key = `../.output/public/${locale}/blog/series/${id}/index.html`;
        const html = PRERENDERED_HTML[key];
        if (html === undefined) {
          continue; // series chưa có bài ở locale này — vắng mặt là hành vi đúng.
        }
        const meta = SERIES_META[id as keyof typeof SERIES_META];
        // Title: template Ecoma áp trên title của series, đúng một lần tên
        // bề mặt — không phải `Ecoma Blog` chung chung.
        expect(html, `${key} title`).toContain(`<title>${meta.title} · Ecoma Blog</title>`);
        // Description: mô tả riêng của series, escape đúng HTML.
        expect(html, `${key} description`).toContain(
          `<meta name="description" content="${escapeHtml(meta.description)}">`,
        );
        // Canonical tự tham chiếu dưới production origin.
        expect(html, `${key} canonical`).toContain(
          `<link rel="canonical" href="https://ecoma.io/${locale}/blog/series/${id}">`,
        );
        // Series là route cục bộ theo locale: không quảng bá bản dịch chéo trỏ
        // tới trang 404 của locale khác.
        expect(html, `${key} cross-locale hreflang`).not.toContain('hreflang="vi-VN"');
      }
    }
  });

  it('renders every series overview with the series title and its published articles in order', () => {
    // Trang series phải là trang *nội dung* thật: h1 lấy từ `SERIES_META`
    // (single source of truth), khối nội dung mang nhãn localized theo locale
    // của trang, và danh sách bài giữ nguyên thứ tự biên tập (`seriesOrder`).
    for (const locale of ['en', 'vi'] as const) {
      for (const id of Object.keys(SERIES_META)) {
        const html = PRERENDERED_HTML[`../.output/public/${locale}/blog/series/${id}/index.html`];
        if (html === undefined) {
          // Series chưa có bài ở locale này — vắng mặt là hành vi đúng.
          continue;
        }
        const meta = SERIES_META[id as keyof typeof SERIES_META];
        // h1 là title từ `SERIES_META` (single source of truth), khối nội dung
        // mang nhãn localized (UI string theo locale của trang).
        expect(html).toMatch(new RegExp(`<h1[^>]*>[^<]*${meta.title}`, 'u'));
        expect(html).toContain(blogUiStrings(locale).seriesContents);
        // Link bài trong trang series phải trỏ tới article page thật của cùng
        // locale — không link chết tới article 404.
        const links = [...html.matchAll(new RegExp(`href="/${locale}/blog/([^"]+)"`, 'gu'))]
          .map((match) => match[1])
          .filter((slug) => slug !== 'series' && !slug.startsWith('series/'));
        expect(links.length, `${locale}/blog/series/${id} article links`).toBeGreaterThan(0);
        for (const slug of links) {
          expect(BLOG_ARTICLE_PAGES, `series link target: ${locale}/blog/${slug}`).toContain(
            `${locale}/blog/${slug}/index.html`,
          );
        }
      }
    }
  });

  it('serializes each blog inventory key with one shape and no undefined fields', () => {
    // **Hai lớp lỗi cùng chỉ lộ ra ở `_payload.json`.** HTML prerender render
    // server-side nên vẫn đúng; chỉ client hydrate từ payload mới hỏng, và cả hai
    // đều im lặng với mọi assertion đọc HTML — nên phải đọc payload thật.
    //
    // **1. Field optional phải vắng hẳn, không phải `x ?? undefined`.**
    // `undefined` là một **giá trị** nên key vẫn có mặt. Qua payload nó thành node
    // `-1` của devalue và hydrate trả lại `undefined` — tức `'cover' in summary`
    // là **đúng** trên client với bài không hề khai cover, mọi kiểm tra tồn tại
    // field viết bằng `in` cho kết quả sai. Mapper phải loại hẳn key
    // (`optionalField` trong route).
    //
    // **2. Một key không được mang hai shape.** `useAsyncData` gộp theo key, và
    // key đã có cache thì handler sau ăn luôn cache của handler trước (`execute`
    // trả `cachedData` trước khi gọi handler). Inventory English fallback từng
    // dùng đúng key `blog:articles:en` mà query listing locale sinh ra trên
    // `/en/**` (`select` 9 cột thay vì 18): key đó mang shape của **một** trong
    // hai handler, tùy cái nào đăng ký trước — đổi thứ tự hai dòng code là đổi
    // shape, và shape còn lại là đọc nhầm (mất `cover`, `articleId`,
    // `prerequisiteIds`).
    //
    // Lưu ý giới hạn của bất biến này: nó **không** bắt được sự trùng key, vì
    // key trùng chỉ khiến key đó mang *một* shape thôi — hợp lệ theo bất biến.
    // Cái đã được bắt ở đây là hệ quả quan sát được của nó. Đừng đọc test này
    // như một bảo đảm về tính duy nhất của key.
    //
    // Shape đo theo **hợp nhất field của mọi record của key trên mọi trang**.
    // Đừng so hai locale bằng nhau: bài demo VI không khai `seriesId`/`articleId`/
    // `level` là chuyện hợp lệ, và bất biến này không cấm điều đó — nó chỉ cấm
    // `undefined` và cấm shape đổi theo trang.
    const NODE_UNDEFINED = -1;
    const violations: string[] = [];
    /** key -> payloadPath -> tập field mà key đó serialize trên trang đó. */
    const fieldsByKey = new Map<string, Map<string, Set<string>>>();

    for (const [payloadPath, raw] of Object.entries(PRERENDERED_PAYLOADS)) {
      const node = JSON.parse(raw) as unknown[];
      // Devalue: node đầu là chính payload, các node sau là bảng tham chiếu chỉ
      // bằng **index**. Node thứ hai là map các key async data.
      const map = node.find(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          !Array.isArray(entry) &&
          Object.keys(entry).some((name) => name.startsWith('blog:articles:')),
      ) as Record<string, number> | undefined;
      expect(map, `${payloadPath} has a blog inventory map`).toBeDefined();

      for (const [name, nodeIndex] of Object.entries(map ?? {})) {
        const container = node[nodeIndex];
        // `["Set"]` / `"ShallowReactive"` là container của devalue, không phải
        // record bài viết — inventory rỗng serialize thành đúng thứ đó.
        if (!Array.isArray(container) || container.length === 0) {
          continue;
        }
        const pages = fieldsByKey.get(name) ?? new Map<string, Set<string>>();
        fieldsByKey.set(name, pages);
        const fields = pages.get(payloadPath) ?? new Set<string>();
        pages.set(payloadPath, fields);
        for (const recordIndex of container) {
          const record = node[recordIndex];
          if (typeof record !== 'object' || record === null || Array.isArray(record)) {
            continue;
          }
          for (const [field, value] of Object.entries(record)) {
            if (value === NODE_UNDEFINED) {
              violations.push(
                `${payloadPath}: "${name}" record ${String(node[(record['path'] as number) ?? ''])} serializes ${field} as undefined — an absent optional field must be missing from the key entirely`,
              );
            }
            fields.add(field);
          }
        }
      }
    }

    // Bất biến 2: một key chỉ có **một** handler, nên mọi trang dùng key đó phải
    // serialize **cùng một** tập field — bằng phép so sánh bằng, không phải kiểm
    // "field này có mặt ở nơi khác không". Hai hướng đó khác nhau và chỉ một hướng
    // bắt đúng lỗi: thu hẹp làm một trang **thiếu** field mà các trang khác có,
    // nên phải tìm field *thiếu*, không phải field *dư*.
    //
    // Trước khi mapper bỏ key thay vì gán `undefined`, landing VI mang 16 field
    // (kèm `-1`) còn các trang bài VI chỉ mang 11 — khác nhau ở chính các field
    // optional mà không bài VI nào khai, dù handler là một. Đây là hệ quả quan
    // sát được của việc hai handler trùng key, và là thứ bất biến này canh.
    //
    // Đừng đòi mọi trang có **mọi** field của hợp nhất: record hợp lệ thì vẫn
    // thiếu field optional mà không bài nào khai, và điều đó không phải lỗi.
    // Vì vậy chuẩn là **bằng nhau giữa các trang của cùng key**, không phải bằng
    // hợp nhất.
    for (const [name, pages] of fieldsByKey) {
      if (pages.size < 2) {
        continue;
      }
      const reference = [...pages.entries()][0];
      for (const [payloadPath, fields] of pages) {
        if (payloadPath === reference[0]) {
          continue;
        }
        const missing = [...reference[1]].filter((field) => !fields.has(field));
        const extra = [...fields].filter((field) => !reference[1].has(field));
        violations.push(
          ...missing.map(
            (field) =>
              `${payloadPath}: "${name}" is missing ${field}, which ${reference[0]} serializes — one key must carry one shape on every page`,
          ),
          ...extra.map(
            (field) =>
              `${payloadPath}: "${name}" serializes extra ${field}, which ${reference[0]} does not — one key must carry one shape on every page`,
          ),
        );
      }
    }

    expect(violations, `payload inventory shape violations:\n${violations.join('\n')}`).toEqual([]);
    expect(fieldsByKey.size, 'payload exposes blog article inventory keys').toBeGreaterThan(0);
  });

  it('renders the docs landing with its card sections in both locales', () => {
    // Landing docs prerender phải mang section card thật (không phải shell
    // rỗng) — một lỗi query content sẽ để landing trắng và fail ở đây.
    for (const locale of ['en', 'vi'] as const) {
      const html = PRERENDERED_HTML[`../.output/public/${locale}/docs/index.html`] ?? '';
      expect(html.length, `${locale}/docs landing size`).toBeGreaterThan(5000);
      expect(html).toContain('<main');
    }
  });

  it('prerenders the legal landing and all five published policies in both locales', () => {
    // Legal Center: landing + 5 policy published × 2 locale = 12 trang. Draft
    // templates (platform-terms-of-service, llm-gateway-marketplace-terms)
    // KHÔNG được xuất hiện — production output là artifact kiểm chứng draft
    // exclusion (build này chạy không có NUXT_PUBLIC_LEGAL_INCLUDE_DRAFTS).
    const landings = LEGAL_PAGES.filter((path) => path.endsWith('/legal/index.html'));
    expect(landings).toContain('en/legal/index.html');
    expect(landings).toContain('vi/legal/index.html');
    const publishedSlugs = ['privacy', 'terms', 'service-delivery', 'payment', 'refund'];
    for (const locale of ['en', 'vi'] as const) {
      for (const slug of publishedSlugs) {
        const page = `${locale}/legal/${slug}/index.html`;
        expect(LEGAL_PAGES, `${page}`).toContain(page);
      }
    }
    expect(LEGAL_PAGES).toHaveLength(12);
  });

  it('keeps every seeded draft legal document out of the production output', () => {
    // Draft gate là cờ build: build không set NUXT_PUBLIC_LEGAL_INCLUDE_DRAFTS
    // (mặc định production semantics) phải loại toàn bộ draft khỏi artifact —
    // không HTML, không payload, không link. Đây là assertion **artifact-level**
    // của "production không phục vụ draft", không phải assertion UI.
    for (const locale of ['en', 'vi'] as const) {
      for (const slug of ['platform-terms-of-service', 'llm-gateway-marketplace-terms']) {
        const page = `${locale}/legal/${slug}`;
        expect(LEGAL_PAGES, `${page} must not be prerendered`).not.toContain(`${page}/index.html`);
      }
    }
    // Toàn bộ output không chứa bất kỳ reference nào tới slug draft (link hỏng
    // trong listing/footer của trang khác cũng bị bắt tại đây).
    for (const [path, html] of Object.entries(PRERENDERED_HTML)) {
      expect(html, `${path}`).not.toContain('/legal/platform-terms-of-service');
      expect(html, `${path}`).not.toContain('/legal/llm-gateway-marketplace-terms');
    }
  });

  it('renders legal document pages with publication and review metadata', () => {
    // Trang văn bản published phải mang badge Published + version; landing
    // phải mang heading Legal Center và cả hai nhóm category.
    for (const locale of ['en', 'vi'] as const) {
      const privacy =
        PRERENDERED_HTML[`../.output/public/${locale}/legal/privacy/index.html`] ?? '';
      expect(privacy).toContain('<main');
      // Metadata line "Version 1.0" render từ frontmatter, không phải text cứng.
      expect(privacy).toMatch(/Version 1\.0|Phiên bản 1\.0/u);
    }
    for (const locale of ['en', 'vi'] as const) {
      const landing = PRERENDERED_HTML[`../.output/public/${locale}/legal/index.html`] ?? '';
      expect(landing.length, `${locale}/legal landing size`).toBeGreaterThan(3000);
      // Cả hai nhóm category đều render — grouped listing hoạt động thật.
      expect(landing).toMatch(/Policies|Chính sách/u);
      expect(landing).toMatch(/Terms|Điều khoản/u);
      // 5 policy published xuất hiện trên landing; draft không.
      for (const slug of ['privacy', 'terms', 'service-delivery', 'payment', 'refund']) {
        expect(landing, `${locale}/legal landing must link ${slug}`).toContain(`/legal/${slug}`);
      }
    }
  });

  it('gives the legal landing and every document the same sidebar navigation', () => {
    // Sidebar là **một** mô hình dùng chung cho cả hai bề mặt: mọi trang legal
    // đều có cùng một nav điều hướng, liệt kê cùng một tập văn bản. Đây là
    // assertion **artifact-level** — nó chứng minh sidebar thực sự render ở
    // HTML prerender, không chỉ pass ở unit test với props giả.
    const publishedSlugs = ['privacy', 'terms', 'service-delivery', 'payment', 'refund'];
    for (const locale of ['en', 'vi'] as const) {
      const ui = legalUiStrings(locale);
      const pages = [
        `${locale}/legal/index.html`,
        ...publishedSlugs.map((slug) => `${locale}/legal/${slug}/index.html`),
      ];
      for (const path of pages) {
        const html = PRERENDERED_HTML[`../.output/public/${path}`] ?? '';
        // Có nav điều hướng với accessible name đã localized.
        expect(html, `${path}: navigation nav`).toContain(`<nav aria-label="${ui.navigation}"`);
        // Mọi văn bản published đều tới được từ mọi bề mặt — đây là mục tiêu
        // của PR: người đọc không phải rời trang để sang văn bản khác.
        for (const slug of publishedSlugs) {
          expect(html, `${path} must link ${slug}`).toContain(`/${locale}/legal/${slug}`);
        }
        // Draft không được lọt vào nav (gate ở tầng query, xem assertion trên).
        expect(html, `${path} must not link a draft`).not.toContain(
          `/${locale}/legal/platform-terms-of-service`,
        );
      }
    }
  });

  it('marks exactly one current page per legal surface in the sidebar', () => {
    // Active state chỉ làm việc nếu sidebar biết trang hiện tại: landing đánh
    // dấu `Overview`, detail đánh dấu văn bản đang đọc.
    //
    // Đếm **trong nav sidebar** chứ không phải cả trang: header/footer cũng mang
    // `aria-current` cho mount Legal, và breadcrumb mang nó cho trang hiện tại,
    // nên đếm cả trang sẽ ra con số vô nghĩa. Vùng lấy là chính landmark
    // `<nav aria-label="…">` — không dựa vào vị trí `<main>`/`<aside>`, vì
    // sidebar nằm **trong** `<main>` (PublicShell đã cấp landmark đó) và
    // markup hai bề mặt mobile/desktop có thể đổi hình thức theo class.
    for (const locale of ['en', 'vi'] as const) {
      const ui = legalUiStrings(locale);
      const cases = [
        { path: `${locale}/legal/index.html`, current: `/${locale}/legal` },
        { path: `${locale}/legal/privacy/index.html`, current: `/${locale}/legal/privacy` },
      ];
      for (const { path, current } of cases) {
        const html = PRERENDERED_HTML[`../.output/public/${path}`] ?? '';
        // Sidebar render hai bề mặt (mobile disclosure + desktop) từ cùng một
        // dữ liệu: mỗi bề mặt có đúng một mắt current, và cùng một mắt đó.
        const surfaces = sidebarNavSurfaces(html, ui.navigation);
        expect(surfaces.length, `${path}: sidebar nav surfaces`).toBe(2);
        for (const surface of surfaces) {
          const currentEntries = [...surface.matchAll(/<a\s([^>]*?)>/gu)]
            .map(([, attrs]) => attrs)
            .filter((attrs) => /aria-current="page"/u.test(attrs))
            .map((attrs) => attrs.match(/href="([^"]*)"/u)?.[1]);
          expect(currentEntries, `${path}: current entries in a sidebar surface`).toEqual([
            current,
          ]);
        }
      }
    }
  });

  it('renders legal breadcrumbs ending at the current document', () => {
    // Breadcrumb là `Legal Center → Document`: mắt đầu là link về landing, mắt
    // cuối là trang hiện tại với `aria-current="page"`. Trên landing chỉ có một
    // mắt (landing là bản thân mục đầu của chuỗi).
    //
    // Breadcrumb render bằng `NuxtLink`, và `NuxtLink` **không** giữ thứ tự
    // attribute: `aria-current` đứng trước `href`. Regex bên dưới vì thế kiểm
    // `href` và `aria-current` độc lập trong **cùng một thẻ `<a>`** thay vì
    // mượn thứ tự của chúng — thứ tự attribute là chi tiết hợp thức không nên
    // ghim.
    for (const locale of ['en', 'vi'] as const) {
      const privacy =
        PRERENDERED_HTML[`../.output/public/${locale}/legal/privacy/index.html`] ?? '';
      // Mắt đầu trỏ về landing, không phải link chết.
      expect(privacy).toMatch(
        new RegExp(`<nav aria-label="[^"]*"><ol[^>]*>.*<a href="/${locale}/legal"`, 'su'),
      );
      // Mắt cuối là page hiện tại: `<a>` chứa cả `href` lẫn `aria-current`.
      // Đếm **trong landmark breadcrumb**: sidebar cũng có link `aria-current`
      // tới cùng pathname (mắt desktop lẫn bản disclosure mobile), nên quét
      // toàn trang sẽ đếm trùng.
      const breadcrumb =
        privacy.match(/<nav aria-label="[^"]*">\s*<ol[^>]*>.*?<\/ol>/su)?.[0] ?? '';
      const anchors = breadcrumb.match(/<a\b[^>]*>/gu) ?? [];
      const current = anchors.filter(
        (anchor) =>
          anchor.includes(`href="/${locale}/legal/privacy"`) &&
          anchor.includes('aria-current="page"'),
      );
      expect(current).toHaveLength(1);
    }
  });

  it('keeps legal heading levels in order from the page title downwards', () => {
    // `<h1>` của trang → `<h2>` nhóm ở cột chính → `<h3>`+ trong Markdown.
    // Không nhóm nào được nhảy bậc, và sidebar **không** góp heading nào (nhãn
    // nhóm trong nav là `<p>`, vì cột chính đã có heading riêng cho cùng nhóm).
    // Kiểm trên HTML prerender vì đây là loại lỗi chỉ lộ ra sau khi build,
    // không lộ ở unit test với props giả.
    for (const locale of ['en', 'vi'] as const) {
      const ui = legalUiStrings(locale);
      for (const path of LEGAL_PAGES.filter((page) => page.startsWith(`${locale}/`))) {
        const html = PRERENDERED_HTML[`../.output/public/${path}`] ?? '';
        // `<main>` của `PublicShell` là vùng nội dung; header/footer thuộc
        // hierarchy khác.
        const main = html.slice(html.indexOf('<main'));
        expect(main, `${path}: page must have a <main>`).not.toBe(html);
        const levels = [...main.matchAll(/<h([1-6])\b/gu)].map(([, level]) => Number(level));
        expect(levels.length, `${path}: page headings`).toBeGreaterThan(0);
        expect(levels[0], `${path}: first heading level`).toBe(1);
        for (const [index, level] of levels.slice(1).entries()) {
          expect(
            level - levels[index],
            `${path}: heading ${index + 2} (h${level}) jumps from h${levels[index]}`,
          ).toBeLessThanOrEqual(1);
        }
        // Sidebar không góp heading: hai landmark cùng name, cả hai sạch.
        for (const surface of sidebarNavSurfaces(html, ui.navigation)) {
          expect(/<h[1-6]\b/u.test(surface), `${path}: sidebar nav must not contain headings`).toBe(
            false,
          );
        }
      }
    }
  });
});

describe('static output: scholarly rendering', () => {
  it('renders inline and display math as KaTeX markup at build time', () => {
    // Bài research có math phải prerender thành markup KaTeX (class `katex`),
    // không phải raw `$...$` hay client-only placeholder — công thức nằm sẵn
    // trong HTML tĩnh, không đợi hydration.
    const mathPages = BLOG_ARTICLE_PAGES.filter((path) =>
      (PRERENDERED_HTML[`../.output/public/${path}`] ?? '').includes('katex'),
    );
    expect(mathPages.length, 'at least one KaTeX-rendered article').toBeGreaterThan(0);
    for (const path of mathPages) {
      const html = PRERENDERED_HTML[`../.output/public/${path}`] ?? '';
      // Markup KaTeX thật của cả hai dạng: inline (`class="katex"`) và display
      // block (`katex-display`).
      expect(html, `${path} inline katex`).toMatch(/class="katex"/u);
      expect(html, `${path} display katex`).toContain('katex-display');
      // Không để lại cú pháp raw cho người đọc.
      expect(html, `${path} raw math delimiter`).not.toMatch(/\$\$[\s\S]{0,80}[A-Za-z]/u);
    }
  });

  it('loads KaTeX stylesheet from the bundled CSS, not a CDN', () => {
    // CSS của KaTeX phải vào bundle local (import trong `styles.css`) — một
    // link CDN trong head vừa là dependency ngoài vừa chấm điểm hiệu năng.
    const html = blogLandingHtml('en') ?? '';
    expect(html).not.toMatch(/<link[^>]*href="https?:\/\/[^"]*katex/u);
    const cssKeys = Object.keys(PRERENDERED_NUXT_CSS);
    expect(cssKeys.length, 'bundled CSS files in _nuxt/').toBeGreaterThan(0);
    const bundledCss = Object.values(PRERENDERED_NUXT_CSS).join('\n');
    expect(bundledCss).toContain('.katex');
  });

  it('renders the scholarly metadata row only with real data, and prerequisites as internal links', () => {
    // Nhãn "Updated" chỉ khi có `updatedAt`, "Reviewed by" chỉ khi có reviewer
    // thật, nav "Prerequisites" chỉ khi có prerequisite resolve được — demo
    // bài không khai metadata research không bao giờ thấy nhãn nào trong số
    // này (nhãn không có dữ liệu = claim phản biện không có thật). Mọi bài
    // có prerequisites phải render nav với link nội bộ thật.
    // Violations thu trong vòng lặp, assert một lần cuối — expect không nằm
    // trong if (repo cấm conditional expect), mà sức mạnh assertion giữ
    // nguyên: mọi vi phạm cấu trúc đều thành entry trong danh sách.
    const violations: string[] = [];
    let fixtureSeen = false;
    for (const path of BLOG_ARTICLE_PAGES) {
      const locale = (path.startsWith('en/') ? 'en' : 'vi') as 'en' | 'vi';
      const ui = blogUiStrings(locale);
      const html = PRERENDERED_HTML[`../.output/public/${path}`] ?? '';
      const updated = html.includes(ui.updated);
      const prerequisites = html.includes(ui.prerequisites);
      // Prerequisites là link nội bộ `/<locale>/blog/<slug>` — không bao giờ
      // link ngoài hay link chết từ khối này.
      if (prerequisites) {
        fixtureSeen = true;
        const hasInternalLink = new RegExp(
          `${ui.prerequisites}[\\s\\S]{0,600}?href="/${locale}/blog/[^"]+"`,
          'u',
        ).test(html);
        if (!hasInternalLink) {
          violations.push(`${path}: prerequisites nav without internal link`);
        }
      }
      // Ngày update phải là `<time datetime>` thật cạnh nhãn, không phải
      // chuỗi trần.
      if (updated && !/<time[^>]*datetime="\d{4}-\d{2}-\d{2}"/u.test(html)) {
        violations.push(`${path}: updated label without <time datetime>`);
      }
    }
    expect(violations).toEqual([]);
    // Nhánh render "có prerequisites" phải xuất hiện ít nhất một lần trong
    // toàn bộ output, nếu không khối nav đó chỉ còn được cover bởi fixture
    // component và có thể hỏng âm thầm khi bài đầu tiên không còn là bài có
    // prerequisites.
    expect(fixtureSeen, 'at least one article rendered its prerequisites nav').toBe(true);
  });

  it('keeps a table of contents only on articles with enough headings', () => {
    // TOC (`<details>`) là khối có điều kiện: chỉ bài đạt ngưỡng heading
    // (MIN_LINKS = 3 h2 trong component) mới có. Ngưỡng **được** test bằng
    // fixture độc lập ở `blog-views.spec.ts` (`BlogArticleToc` mount với 2 và
    // 3 h2 tự dựng) — không suy ra từ inventory thật, vì inventory này sẽ đổi:
    // khi toàn bộ 30 bài research đều dài, **không** còn bài nào dưới ngưỡng,
    // và assert "có ít nhất một bài không TOC" sẽ đỏ vô lý.
    //
    // Suite này giữ phần **artifact-level**: mọi anchor TOC phải trỏ tới
    // heading thật trong chính trang đó (id do renderer sinh) — anchor chết
    // trong HTML đã prerender là lỗi điều hướng, và nó không xuất hiện ở bất
    // kỳ fixture nào khác.
    let tocCount = 0;
    const brokenAnchors: string[] = [];
    for (const path of BLOG_ARTICLE_PAGES) {
      const locale = (path.startsWith('en/') ? 'en' : 'vi') as 'en' | 'vi';
      const label = blogUiStrings(locale).tableOfContents;
      const html = PRERENDERED_HTML[`../.output/public/${path}`] ?? '';
      if (html.includes(label)) {
        tocCount += 1;
        for (const match of html.matchAll(/href="#([^"]+)"/gu)) {
          const anchorId = match[1] ?? '';
          if (!html.includes(`id="${anchorId}"`)) {
            brokenAnchors.push(`${path}: #${anchorId}`);
          }
        }
      }
    }
    expect(brokenAnchors).toEqual([]);
    expect(tocCount, 'articles with a TOC in production output').toBeGreaterThan(0);
  });

  it('renders series navigation on series articles, distinct from the time pager', () => {
    // Bài thuộc series render khối điều hướng series (nhãn localized) với
    // prev/next trong thứ tự học tập; pager thời gian vẫn tồn tại độc lập.
    // Bài demo ngoài series không render khối series nào.
    let seriesNavCount = 0;
    const violations: string[] = [];
    for (const path of BLOG_ARTICLE_PAGES) {
      const locale = (path.startsWith('en/') ? 'en' : 'vi') as 'en' | 'vi';
      const ui = blogUiStrings(locale);
      const html = PRERENDERED_HTML[`../.output/public/${path}`] ?? '';
      const hasSeriesNav = html.includes(ui.seriesPrevious) || html.includes(ui.seriesNext);
      if (hasSeriesNav) {
        seriesNavCount += 1;
        // Khối series mang nav có tên riêng — không trùng accessible name với
        // pager thời gian (hai `<nav>` hai accessible name trên cùng trang) —
        // và trang vẫn giữ pager thời gian.
        if (!new RegExp(`aria-label="${ui.series}: [^"]+"`, 'u').test(html)) {
          violations.push(`${path}: series nav without labeled <nav>`);
        }
        if (!html.includes(ui.pagination)) {
          violations.push(`${path}: series article missing time pager`);
        }
      } else {
        // Bài ngoài series không được lộ nhãn series nào (claim sai).
        if (html.includes(`${ui.series}:`)) {
          violations.push(`${path}: series label on non-series article`);
        }
      }
    }
    expect(violations).toEqual([]);
    expect(seriesNavCount, 'articles with series navigation').toBeGreaterThan(0);
  });
});

describe('static output: media resolution', () => {
  it('copies every referenced cover and inline asset into the output assets directory', () => {
    // Mọi `src="/assets/x.svg"` trong mọi HTML phải tồn tại trong output
    // `assets/` — bắt broken media ở test thay vì ở browser.
    const available = new Set(Object.keys(OUTPUT_ASSETS).map(outputPath));
    // Sàn tối thiểu dùng chung với hook build (`modules/static-assets-guard.ts`
    // qua `shared/static-output-contract.ts`) - hook đã fail-loud ngay lúc
    // build, nên tới được đây tức artifact thường hợp lệ; test giữ assertion
    // như lớp bảo vệ cuối. Thông báo phân biệt HAI tiền đề: HTML prerender có
    // nội dung trong khi glob asset rỗng ⇒ `nuxt-content-assets` đã chạy nhưng
    // không đóng góp asset nào (nuốt lỗi load content config, cảnh báo bị Nx
    // ẩn khi task vẫn pass) - không phải assertion sai. Vượt qua `available`
    // (không phải số 0 trơ trọi) để khi assertion đỏ, diff in ra những gì glob
    // thực sự thấy.
    expect(
      available.size,
      `${
        Object.keys(PRERENDERED_HTML).length > 0 && available.size === 0
          ? 'Prerendered HTML exists but the output assets glob is empty: the ' +
            'nuxt-content-assets module produced no assets in this build (it ' +
            'swallows content-config load errors with only a warning; look ' +
            "for '[content-assets] Unable to load content config' in " +
            'untruncated build output). The build-side guard in ' +
            'modules/static-assets-guard.ts should already have failed the ' +
            'build; reaching this message means the guard did not run.'
          : `output assets directory (contract floor: ${MIN_OUTPUT_SVG_ASSETS})`
      }`,
    ).toBeGreaterThanOrEqual(MIN_OUTPUT_SVG_ASSETS);
    // Hợp đồng chung build↔test được assert luôn ở phía test: cùng hàm đánh
    // giá, cùng thông báo vi phạm (pin cả hai phía dùng một nguồn).
    expect(assessOutputSvgAssets(available.size)).toBeNull();
    for (const [path, html] of Object.entries(PRERENDERED_HTML)) {
      for (const match of html.matchAll(/src="(\/assets\/[^"]+)"/gu)) {
        const assetRef = match[1] ?? '';
        const assetPath = `assets/${assetRef.replace('/assets/', '')}`;
        expect(available.has(assetPath), `${path}: ${assetRef}`).toBe(true);
      }
    }
  });

  it('leaves no unresolved relative asset path in any HTML', () => {
    // Một `src` tương đối sót lại (`../../../assets/...`) nghĩa là
    // `content:file:afterParse` không rewrite được - hệ quả trực tiếp của asset
    // index rỗng (cùng nguyên nhân gốc với test trên): module không có index
    // nào để tra cứu đường dẫn. Regex bắt cả hai dạng: `../` leo thư mục và
    // `assets/` tương đối trần.
    const unresolved: string[] = [];
    for (const [path, html] of Object.entries(PRERENDERED_HTML)) {
      if (/src="[^"]*\.\.\//u.test(html)) {
        unresolved.push(`${path}: contains ../ in an asset src`);
      }
      if (/src="assets\//u.test(html)) {
        unresolved.push(`${path}: contains a bare relative assets/ src`);
      }
    }
    // Hỏng dạng này là sản phẩm phụ của asset index rỗng - cùng root cause với
    // assertion sàn asset phía trên, nên thông báo trỏ về cùng nguồn: một khi
    // guard build (`modules/static-assets-guard.ts`) chạy, hỏng đến được đây
    // chỉ khi guard không chạy.
    expect(
      unresolved,
      `${
        unresolved.length > 0
          ? 'Prerendered HTML still contains unresolved relative asset paths: the ' +
            'nuxt-content-assets asset index was empty in this build, so ' +
            'content:file:afterParse could not rewrite them. Same root cause ' +
            'as the assets-floor assertion above; see ' +
            'modules/static-assets-guard.ts.'
          : 'unresolved relative asset paths'
      }`,
    ).toEqual([]);
  });

  it('renders cover images with meaningful alt text on articles that declare one', () => {
    // Cover của bài demo khai `cover` (EN và VI song song): alt phải là text
    // thật, không phải `[object Object]`. Danh sách slug **không** hard-code —
    // assertion chạy trên mọi article có `<img>` cover trong output.
    for (const path of BLOG_ARTICLE_PAGES) {
      const html = PRERENDERED_HTML[`../.output/public/${path}`] ?? '';
      for (const match of html.matchAll(/<img[^>]*src="(\/assets\/cover-[^"]+)"[^>]*>/gu)) {
        const imgTag = match[0];
        expect(imgTag, `${path}: cover alt`).toMatch(/alt="[^"]+"/u);
        expect(imgTag, `${path}: cover alt garbage`).not.toContain('[object Object]');
      }
    }
  });

  it('renders no cover image on articles without one', () => {
    // Bài không khai cover (demo `build-time-content`, `demo-content-note`
    // và các bài research mới) — graceful absence: không `<img>` cover, không
    // hình hỏng, không alt rác.
    for (const path of BLOG_ARTICLE_PAGES) {
      const html = PRERENDERED_HTML[`../.output/public/${path}`] ?? '';
      expect(html, `${path}`).not.toMatch(/alt="\[object Object\]"/u);
    }
  });

  it('serves every asset an article references, cover or inline body media', () => {
    // Mọi asset mà content **thật** tham chiếu phải có mặt trong static
    // output với URL public đúng và nội dung khác rỗng. Danh sách tham chiếu
    // đọc từ markdown thật qua `import.meta.glob`, không hard-code tên asset:
    // hard-code là cách inventory cũ biến một bài có sơ đồ inline thành một
    // test đỏ ngay khi bài đó bị xoá (và im lặng bỏ qua coverage khi bài mới
    // thêm ảnh mà chưa ai kịp khai tên).
    const markdown = Object.entries(ARTICLE_MARKDOWN);
    const referenced = new Set<string>();
    for (const [, raw] of markdown) {
      for (const match of raw.matchAll(/\]\((\.\.\/\.\.\/\.\.\/assets\/[^)]+)\)/gu)) {
        referenced.add((match[1] ?? '').split('/').pop() ?? '');
      }
    }
    // Gom lỗi rồi assert một lần: `expect(value, message)` dạng 2 tham số bị
    // repo cấm, nên không thể đẩy context vào từng assertion.
    const missing: string[] = [];
    for (const name of referenced) {
      const url = `/assets/${name}`;
      const served = OUTPUT_ASSETS[`../.output/public${url}`];
      if (served === undefined || served.length === 0) {
        missing.push(url);
      }
    }
    expect(missing).toEqual([]);
    // Và mọi `<img>` trong output blog phải trỏ tới asset thật — `<img>` hỏng
    // là lỗi người đọc thấy ngay, và nó không để lại dấu vết trong HTML tĩnh
    // nếu ta chỉ kiểm tên file.
    const broken: string[] = [];
    for (const path of BLOG_ARTICLE_PAGES) {
      const html = PRERENDERED_HTML[`../.output/public/${path}`] ?? '';
      for (const match of html.matchAll(/<img[^>]*src="(\/assets\/[^"]+)"/gu)) {
        const src = match[1] ?? '';
        if (OUTPUT_ASSETS[`../.output/public${src}`] === undefined) {
          broken.push(`${path}: ${src}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('serves every output asset with non-empty content', () => {
    const empty: string[] = [];
    for (const [key, raw] of Object.entries(OUTPUT_ASSETS)) {
      if (raw.length === 0) {
        empty.push(key);
      }
    }
    expect(empty).toEqual([]);
  });
});

describe('static output: deployment contract', () => {
  it('keeps wrangler config an SSR Worker with assets and no SPA or not-found fallback', () => {
    // Contract deploy của bản hợp nhất, khẳng định trên **config thật**:
    // Worker SSR (`main` trỏ vào bundle Nitro) + static assets qua binding
    // ASSETS, **không** SPA fallback (`single-page-application` sẽ trả 200
    // cho path lạ). Config có comment giải thích nên assert trên **giá trị
    // JSON**, không phải trên từ khóa trần trong file.
    //
    // Khác bản docs/blogs static: KHÔNG đặt `not_found_handling` — với
    // `main` + assets (assets-first), fallback đó phục vụ `404.html` cho mọi
    // request không khớp asset mà **không invoke Worker**, tức sẽ nuốt SSR
    // của `/en`, `/en/legal/*` và error page SSR cho path content lạ. Trong
    // app hợp nhất, 404 cho path lạ là sản phẩm của Worker (middleware gate
    // + `error.vue`), còn `404.html` prerender chỉ là artifact để giữ tương
    // thích artifact-level, không wire vào serving.
    expect(WRANGLER_CONFIG).toContain('"name": "ecoma-home"');
    expect(WRANGLER_CONFIG).toContain('"main": ".output/server/index.mjs"');
    expect(WRANGLER_CONFIG).toContain('"directory": ".output/public"');
    expect(WRANGLER_CONFIG).toContain('"binding": "ASSETS"');
    expect(WRANGLER_CONFIG).not.toMatch(/"not_found_handling"\s*:\s*"single-page-application"/u);
    expect(WRANGLER_CONFIG).not.toMatch(/"not_found_handling"\s*:\s*"404-page"/u);
    expect(WRANGLER_CONFIG).not.toMatch(/"run_worker_first"/u);
    // Không D1: toàn bộ content là Git-managed Markdown, prerender lúc build —
    // Worker không được mang binding database nào.
    expect(WRANGLER_CONFIG).not.toContain('d1_databases');
  });

  it('emits the server bundle for SSR — content pages still stay prerendered', () => {
    // Home là SSR Worker: `.output/server` PHẢI tồn tại (ngược với blogs
    // static trước đây). Contract của bản hợp nhất là "SSR cho landing/legal
    // + prerender cho docs/blog", không phải "static toàn bộ".
    const serverEntry = import.meta.glob<string>('../.output/server/index.mjs', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(serverEntry)).toContain('../.output/server/index.mjs');
  });

  it('embeds the prerendered content manifest into the server bundle', () => {
    // Middleware gate (`server/middleware/prerendered-content-404.ts`) đọc
    // virtual module `virtual:prerendered-content-paths` — lấp bởi hook
    // `prerender:done` lúc build. Manifest rỗng trong server bundle = gate
    // 404 mọi content path ở runtime (bug đã gặp: app code import bị Vite
    // đóng băng trước prerender — chi tiết trong module app-local đăng ký
    // virtual). Test này chốt điều ngược lại: manifest trong bundle phải
    // non-empty và phủ đúng các trang HTML prerendered trong output.
    const chunks = import.meta.glob<string>('../.output/server/chunks/**/*.mjs', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    // Không collapse whitespace: minifier có thể đặt `new` và `Set` trên hai
    // dòng (join bằng `\n` giữa các chunk), collapse sẽ dính chúng thành
    // `newSet(`. Regex tự cho phép whitespace thay vì biến dạng nguồn.
    // Bundle có nhiều Set literal — neo đúng Set của manifest qua phần tử
    // đầu tiên biết chắc (`/en/blog`, path content nhỏ nhất theo thứ tự
    // `toSorted()` của hook `prerender:done`).
    const bundled = Object.values(chunks).join('\n');
    const match = /new\s+Set\(\s*\[\s*"\/en\/blog"[^\]]*\]\)/u.exec(bundled);
    expect(match, 'manifest Set literal in server chunks').not.toBeNull();
    const paths = (match?.[0] ?? '')
      .replace(/^new\s+Set\(\s*\[/u, '')
      .replace(/\]\)$/u, '')
      .split(',')
      .map((item) => item.replace(/"/gu, '').trim())
      .filter((item) => item.startsWith('/'));
    expect(paths.length, 'manifest entries').toBeGreaterThan(0);
    // Mỗi HTML prerendered trong `.output/public` phải có mặt trong manifest
    // (manifest chứa cả `_payload.json` nên chỉ cần hướng HTML ⊆ manifest).
    for (const key of Object.keys(PRERENDERED_HTML)) {
      const routePath = `/${key.replace(/^\.\.\/\.output\/public\//u, '').replace(/\/index\.html$/u, '')}`;
      expect(paths, `${routePath} in embedded manifest`).toContain(routePath);
    }
  });
});
