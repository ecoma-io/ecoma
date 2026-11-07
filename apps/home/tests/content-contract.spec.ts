import { describe, expect, it } from 'vitest';
import { PUBLIC_LOCALES } from '../app/i18n/index';
import { SERIES_META } from '../app/blog/blog-series';
import { parseFrontmatter } from './content-frontmatter';

/**
 * Contract của content — chạy trên **file thật** trong `content/`, không
 * phải fixture: những test này bắt lỗi frontmatter/slug/mapping locale ngay ở
 * unit test thay vì chờ tới build.
 *
 * Schema zod thật của collection nằm trong `content.config.ts` và được
 * `@nuxt/content` enforce lúc build; ở đây mirror contract bằng validation thủ
 * công (zod không resolve được ngoài Nuxt context trong vitest project này)
 * để bắt lỗi dữ liệu ngay từ `nx test` — kể cả phần contract research mới
 * (`articleId`, `seriesId`/`seriesOrder`, reference, citation).
 *
 * Nguồn file là `import.meta.glob` của Vite (`query: '*'` → raw string,
 * `eager: true` → đọc đồng bộ lúc import), không phải `node:fs`: override
 * lint của repo cấm Node builtin trong `apps/**` theo tag `runtime:edge` —
 * spec là file của app nên cũng chịu ràng buộc đó, dù chỉ chạy trong Node.
 * Glob raw `.md` và `.svg` mang lại đúng dữ liệu cần validate mà không cần
 * `readFileSync`/`readdirSync`.
 */

/** Raw content của mọi article, khoá là path từ `apps/home` — dạng `../content/en/blog/<slug>/index.md`. */
const ARTICLE_SOURCES = import.meta.glob<string>('../content/{en,vi}/blog/*/index.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Raw content của mọi shared asset, dùng để đếm và so khớp reference. */
const ASSET_NAMES = Object.keys(
  import.meta.glob<string>('../content/assets/*.svg', { query: '?raw', eager: true }),
).map((path) => path.split('/').pop() ?? '');

/** Raw content của mọi văn bản legal, khoá là path từ `apps/home` — dạng `../content/en/legal/<slug>.md`. */
const LEGAL_SOURCES = import.meta.glob<string>('../content/{en,vi}/legal/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** `{ locale, slug, raw }` suy ra từ glob key legal. */
const legalDocuments = Object.entries(LEGAL_SOURCES).map(([key, raw]) => {
  // Filename mang hậu tố `.draft.md` cho template chưa công bố (quy ước loại
  // khỏi production build — xem `content.config.ts`); `slug` giữ NGUYÊN cả
  // hậu tố `.draft` để mirror đúng stem trong database, còn slug URL qua
  // `urlSlug()` strip cả prefix số lẫn hậu tố này.
  const match =
    /content\/(en|vi)\/legal\/([^/]+?)\.draft\.md$|content\/(en|vi)\/legal\/([^/]+)\.md$/u.exec(
      key,
    );
  if (!match) {
    throw new Error(`unexpected glob key: ${key}`);
  }
  const locale = (match[1] ?? match[3]) as 'en' | 'vi';
  const slug = match[2] ?? match[4];
  return { locale, slug: `${slug}`, raw };
});

/** `{ locale, slug, raw }` suy ra từ glob key. */
const articles = Object.entries(ARTICLE_SOURCES).map(([key, raw]) => {
  const match = /content\/(en|vi)\/blog\/([^/]+)\/index\.md$/u.exec(key);
  if (!match) {
    throw new Error(`unexpected glob key: ${key}`);
  }
  return { locale: match[1] as 'en' | 'vi', slug: match[2], raw };
});

/** Kiểm tra frontmatter khớp contract của `blogSchema` trong `content.config.ts`. */
function validFrontmatter(frontmatter: Record<string, unknown>): boolean {
  return (
    typeof frontmatter.title === 'string' &&
    frontmatter.title.length > 0 &&
    typeof frontmatter.description === 'string' &&
    frontmatter.description.length > 0 &&
    typeof frontmatter.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(frontmatter.date) &&
    typeof frontmatter.author === 'string' &&
    frontmatter.author.length > 0 &&
    Array.isArray(frontmatter.tags) &&
    frontmatter.tags.every((tag) => typeof tag === 'string') &&
    typeof frontmatter.featured === 'boolean'
  );
}

/** Slug định danh URL — prefix số ordering (`N.`) và hậu tố `.draft` bị bỏ. */
function urlSlug(fileSlug: string): string {
  return fileSlug.replace(/^\d+\./u, '').replace(/\.draft$/u, '');
}

/** Tập slug legal (đã bỏ prefix ordering `N.`) của một locale — đã sort. */
function legalSlugsByLocale(locale: 'en' | 'vi'): string[] {
  return legalDocuments
    .filter((d) => d.locale === locale)
    .map((d) => urlSlug(d.slug))
    .toSorted();
}

/**
 * Locale **có bài** — danh sách rỗng là trạng thái hợp lệ, không phải lỗi.
 *
 * Blog hướng tới English-first: `/en/blog` có bài, `/vi/blog` có thể rỗng và
 * trở thành landing fallback khám phá bài English. Vì vậy các test về seed
 * chỉ **bắt buộc** với locale có bài; vòng lặp "mọi locale" ở các test bên dưới
 * vì thế lọc qua đây, để contract này sống được cả với inventory
 * English-only mà PR nội dung sắp mang vào — và để lỗi thật (một file blog
 * parse sai, một locale có bài nhưng thiếu frontmatter) vẫn bị bắt.
 */
function localesWithArticles(): readonly ('en' | 'vi')[] {
  return (['en', 'vi'] as const).filter((locale) =>
    articles.some((article) => article.locale === locale),
  );
}

describe('seed content contract', () => {
  it('seeds English articles, the discovery inventory of the whole blog', () => {
    // EN là inventory khám phá của blog: landing `/en/blog` không bao giờ rỗng,
    // và mọi landing khác rơi về nó khi chưa có bản dịch. Hai locale **không**
    // còn bảo đảm bằng số bài — VI rỗng là trạng thái fallback có chính sách
    // riêng, không phải lỗi inventory (xem suite static-output).
    expect(articles.filter((article) => article.locale === 'en').length).toBeGreaterThan(0);
  });

  it('keeps slugs unique within each locale that has content', () => {
    // Slug trùng trong một locale là hai file ứng một URL — build phải đỏ,
    // nhưng bắt ngay tại đây với thông điệp rõ hơn. Số bài giữa hai locale
    // **không** buộc bằng nhau nữa (English-first), và locale rỗng không bị
    // tính là lỗi — nên chỉ duyệt locale thật sự có bài.
    for (const locale of localesWithArticles()) {
      const slugs = articles.filter((a) => a.locale === locale).map((a) => a.slug);
      expect(new Set(slugs).size, `${locale} slug uniqueness`).toBe(slugs.length);
    }
  });

  it('has valid frontmatter for every article', () => {
    for (const article of articles) {
      expect(
        validFrontmatter(parseFrontmatter(article.raw)),
        `${article.locale}/${article.slug}`,
      ).toBe(true);
    }
  });

  it('has a clear H1 matching the article body', () => {
    for (const article of articles) {
      // Cờ `m` bắt buộc: `^` phải neo từng dòng, không phải đầu chuỗi (chuỗi
      // mở đầu bằng frontmatter).
      expect(article.raw, `${article.locale}/${article.slug}`).toMatch(/^# .+/mu);
    }
  });

  it('marks at least one article featured per locale that has content', () => {
    // Landing có bài mà không bài featured nào vẫn có hero (helper fallback sang
    // bài mới nhất), nhưng inventory thật nên có một bài được biên tập chọn —
    // và locale **rỗng** không có khái niệm "bài featured nào".
    for (const locale of localesWithArticles()) {
      const perLocale = articles.filter((a) => a.locale === locale);
      const featured = perLocale.filter((a) => parseFrontmatter(a.raw).featured === true);
      // Thông điệp lỗi tự dựng (không dùng message arg của expect — rule
      // vitest/valid-expect chỉ nhận 1 argument) để biết locale nào thiếu.
      expect([locale, featured.length >= 1]).toEqual([expect.any(String), true]);
    }
  });

  it('uses deterministic ordering prefixes in file names', () => {
    // Thứ tự listing dựa `date` DESC, tie-break `stem ASC`. Prefix số trong tên
    // thư mục (`1.url-model`) làm `stem` không trùng nhau — điều kiện để tie-break
    // luôn xác định.
    for (const locale of localesWithArticles()) {
      const slugs = articles
        .filter((a) => a.locale === locale)
        .map((a) => a.slug)
        .toSorted();
      expect([locale, slugs]).toEqual([
        expect.any(String),
        expect.arrayContaining([expect.stringMatching(/^\d+\./u)]),
      ]);
      expect(slugs.filter((slug) => !/^\d+\./u.test(slug))).toEqual([]);
    }
  });

  it('exercises the markdown renderer with a representative element mixture', () => {
    // Toàn bộ seed (cả hai locale) phải cover mọi element: heading nhiều mức,
    // list, table, code block, blockquote, hr, link — đủ để renderer gặp một
    // lần mỗi loại.
    const all = articles.map((a) => a.raw).join('\n');
    expect(all).toMatch(/^## /mu);
    expect(all).toMatch(/^- /mu);
    expect(all).toMatch(/^\| .+\|/mu);
    expect(all).toMatch(/```/u);
    expect(all).toMatch(/^> /mu);
    expect(all).toMatch(/^---$/mu);
    expect(all).toMatch(/\]\(\//u);
  });

  it('exercises the math pipeline with inline and display notation', () => {
    // Content research khai `contentType` phải dùng cả inline ($...$) lẫn
    // display ($$...$$) math — hai nhánh parse khác nhau của remark-math,
    // đủ để build gặp một lần mỗi loại ngay từ seed đầu tiên.
    const research = articles.filter((a) =>
      /^\s*contentType:\s*(theory|research-review|experiment|benchmark|interactive-demo)\s*$/mu.exec(
        a.raw,
      ),
    );
    expect(research.length, 'at least one typed research article').toBeGreaterThan(0);
    const all = research.map((a) => a.raw).join('\n');
    expect(all).toMatch(/\$\$[\s\S]+?\$\$/u);
    expect(all).toMatch(/\$[^$\n]+\$/u);
  });

  it('references only collocated shared assets that exist in the repository', () => {
    // Mọi reference `../../../assets/x.svg` phải trỏ tới asset thật trong
    // `content/assets/` — bắt broken image ở unit test thay vì chỉ phát hiện
    // bằng một build đỏ. Vì asset dùng chung nằm ở một thư mục cố định,
    // reference hợp lệ luôn resolve về đúng tập tên file ở đó.
    const sharedNames = new Set(ASSET_NAMES);
    expect(sharedNames.size).toBeGreaterThanOrEqual(3);
    for (const article of articles) {
      const refs = [
        ...article.raw.matchAll(/!\[[^\]]*\]\((\.\.\/\.\.\/\.\.\/assets\/[^)]+)\)/gu),
      ].map((match) => match[1]);
      for (const ref of refs) {
        const assetName = ref.split('/').pop() ?? '';
        expect(sharedNames.has(assetName), `${article.locale}/${article.slug}: ${ref}`).toBe(true);
      }
    }
  });

  it('keeps shared language-neutral assets in one place, not duplicated per locale', () => {
    // Assets graphic không chữ nằm dưới `content/assets/` dùng chung; chúng
    // không được nhân bản vào thư mục locale. Glob chỉ phủ `content/{en,vi}/
    // blog/*/index.md` nên mọi file asset khác trong cây locale là leak —
    // kiểm tra qua một glob phụ rộng hơn.
    const localeAssetLeaks = Object.keys(
      import.meta.glob<string>('../content/{en,vi}/blog/**/*.{svg,png,jpg,webp}', {
        query: '?raw',
        eager: true,
      }),
    );
    expect(localeAssetLeaks, 'asset files inside locale trees').toEqual([]);
  });

  it('covers every registry locale in the prerender ignore list', () => {
    // `nitro.config.ts` liệt kê tường minh những entry point ngoài content
    // mà crawler (`crawlLinks: true`) đi theo từ global nav/footer của
    // `PublicShell`: locale roots. Đây là coupling có chủ ý — nhưng phải được
    // ghim bằng test: registry thêm locale mới mà `nitro.config.ts` chưa cập
    // nhật `ignore` thì test đỏ **ngay tại đây** thay vì build đỏ lúc
    // prerender (hoặc tệ hơn, prerender 404 âm thầm).
    const nitroConfig = (() => {
      const modules = import.meta.glob<string>('../nitro.config.ts', {
        query: '?raw',
        import: 'default',
        eager: true,
      });
      return modules['../nitro.config.ts'] ?? '';
    })();

    // Mọi locale của registry phải có locale root phủ trong ignore.
    for (const definition of PUBLIC_LOCALES) {
      const code = definition.code;
      expect(nitroConfig, `nitro ignore: locale root /${code}`).toContain(`^\\/${code}\\/?$`);
    }

    // Mọi mount content (docs, blog, legal) phải được **seed landing** trong
    // `prerender.routes` — crawler bắt đường đọc từ landing; mount mới sinh
    // ra ở registry mà home không sở hữu là một entry point ngoài ownership.
    const prerenderedMounts = ['docs', 'blog', 'legal'];
    for (const mount of prerenderedMounts) {
      for (const locale of PUBLIC_LOCALES) {
        expect(nitroConfig, `nitro routes: landing /${locale.code}/${mount}`).toContain(
          `'/${locale.code}/${mount}'`,
        );
      }
    }
  });

  it('parses legal frontmatter and enforces the legalSchema contract on every document', () => {
    // Mirror contract của `legalSchema` (content.config.ts) — zod không chạy
    // được ngoài Nuxt context trong vitest project này, cùng cách với blog ở
    // trên. Mọi văn bản phải có đủ metadata bắt buộc với giá trị thuộc enum.
    for (const document of legalDocuments) {
      const fm = parseFrontmatter(document.raw);
      const problems: string[] = [];
      if (typeof fm.title !== 'string' || fm.title.length === 0) {
        problems.push('title');
      }
      if (typeof fm.description !== 'string' || fm.description.length === 0) {
        problems.push('description');
      }
      if (fm.category !== 'policy' && fm.category !== 'terms') {
        problems.push('category');
      }
      if (!['policy', 'terms-of-service', 'supplemental-terms'].includes(fm.docType as string)) {
        problems.push('docType');
      }
      if (fm.status !== 'draft' && fm.status !== 'published') {
        problems.push('status');
      }
      if (fm.reviewStatus !== 'unreviewed' && fm.reviewStatus !== 'reviewed') {
        problems.push('reviewStatus');
      }
      if (typeof fm.version !== 'string' || fm.version.length === 0) {
        problems.push('version');
      }
      if (typeof fm.scope !== 'string' || fm.scope.length === 0) {
        problems.push('scope');
      }
      if (fm.effectiveDate !== undefined) {
        if (
          typeof fm.effectiveDate !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/u.test(fm.effectiveDate) ||
          Number.isNaN(Date.parse(`${fm.effectiveDate}T00:00:00Z`))
        ) {
          problems.push('effectiveDate');
        }
      }
      // `related` (nếu có) là mảng string.
      if (
        fm.related !== undefined &&
        !(Array.isArray(fm.related) && fm.related.every((item) => typeof item === 'string'))
      ) {
        problems.push('related');
      }
      expect([`${document.locale}/${document.slug}`, problems]).toEqual([expect.any(String), []]);
    }
  });

  it('keeps publication status and effectiveDate consistent with the schema refine', () => {
    // Refine của `legalSchema`: published phải có effectiveDate; draft không
    // được gán ngày hiệu lực chưa chốt (gán ngày là bịa cam kết). Assert sau
    // khi lọc theo status — tránh conditional expect (oxlint
    // vitest/no-conditional-expect), id trong tuple giữ context lỗi.
    const cases = legalDocuments.map((document) => {
      const fm = parseFrontmatter(document.raw);
      return {
        id: `${document.locale}/${document.slug}`,
        status: fm.status,
        effectiveDate: fm.effectiveDate,
      };
    });
    const published = cases.filter((c) => c.status === 'published');
    const drafts = cases.filter((c) => c.status === 'draft');
    expect(published.length + drafts.length).toBe(cases.length);
    for (const { id, effectiveDate } of published) {
      expect([id, typeof effectiveDate]).toEqual([expect.any(String), 'string']);
    }
    for (const { id, effectiveDate } of drafts) {
      expect([id, effectiveDate]).toEqual([expect.any(String), undefined]);
    }
  });

  it('marks every seeded draft template draft and unreviewed in both locales', () => {
    // Safeguard của seed: template Terms of Service + LLM Gateway Supplemental
    // phải là draft, chưa review, ở CẢ HAI locale — một bản "published" lọt là
    // cam kết pháp lý chưa được duyệt lộ ra production.
    const draftSlugs = ['platform-terms-of-service', 'llm-gateway-marketplace-terms'];
    for (const locale of ['en', 'vi'] as const) {
      for (const slug of draftSlugs) {
        const document = legalDocuments.find(
          (d) => d.locale === locale && urlSlug(d.slug) === slug,
        );
        expect([`${locale}/${slug}`, document !== undefined]).toEqual([expect.any(String), true]);
        const fm = parseFrontmatter(document?.raw ?? '');
        expect([`${locale}/${slug} status`, fm.status]).toEqual([expect.any(String), 'draft']);
        expect([`${locale}/${slug} review`, fm.reviewStatus]).toEqual([
          expect.any(String),
          'unreviewed',
        ]);
      }
    }
  });

  it('migrates every legacy registry document 1:1 with identical slugs in both locales', () => {
    // Migration parity: 5 policy cũ của TypeScript registry phải tồn tại ở
    // cả hai locale với đúng slug cũ — slug là định danh URL, đổi slug là
    // đổi public URL.
    const legacySlugs = ['privacy', 'terms', 'service-delivery', 'payment', 'refund'];
    for (const locale of ['en', 'vi'] as const) {
      const slugs = legalSlugsByLocale(locale);
      for (const slug of legacySlugs) {
        expect([`${locale}`, slugs]).toEqual([expect.any(String), expect.arrayContaining([slug])]);
      }
      // Mọi file legal đều có prefix số ordering (stem ASC tie-break); slug
      // URL sau khi bỏ prefix là duy nhất.
      expect(
        legalDocuments.filter((d) => d.locale === locale && !/^\d+\./u.test(d.slug)).length,
      ).toBe(0);
      expect(new Set(slugs).size).toBe(slugs.length);
    }
  });

  it('keeps identical legal slugs across locales for the locale switcher', () => {
    // Hai locale có cùng tập slug (locale prefix số chỉ ordering — cùng giá
    // trị hai bên): mọi văn bản en đều có bản vi và ngược lại. Khi sau này
    // một văn bản chỉ có một locale, test này phải được nới cùng lúc với
    // việc availability của switcher chuyển sang suy từ content (đã thiết kế
    // vậy) — lúc đó assertion mới là "tập slug hai bên bằng nhau" bị bỏ,
    // thay bằng per-slug availability.
    expect(legalSlugsByLocale('vi')).toEqual(legalSlugsByLocale('en'));
  });

  it('starts every legal document with an H1 matching its title role', () => {
    // Title Markdown (`# ...`) là `<h1>` thực của trang — view không render
    // thêm h1. Thiếu H1 là trang không có heading chính.
    for (const document of legalDocuments) {
      expect(document.raw, `${document.locale}/${document.slug}`).toMatch(/^# .+/mu);
    }
  });
});

describe('research content contract', () => {
  /** Frontmatter của mọi article, kèm ngữ cảnh locale/slug. */
  const parsed = articles.map((article) => ({
    ...article,
    frontmatter: parseFrontmatter(article.raw),
  }));

  /** Bài khai `articleId` — nhóm reference/series identity. */
  const identified = parsed.filter((a) => typeof a.frontmatter.articleId === 'string');

  /** Chuỗi ID hợp lệ tại thời điểm build — nguồn so khớp mọi reference. */
  const knownIds = new Set(identified.map((a) => a.frontmatter.articleId as string));

  it('keeps articleId unique across all published articles', () => {
    // `articleId` là identity biên tập: hai bài cùng ID là hai URL cạnh một
    // khái niệm — mọi reference resolve lệch, locale switch nhảy sai. Unique
    // trên **cả hai locale**: bản dịch sharing ID là chủ ý, nhưng đó là cùng
    // một khái niệm — hai bài EN khác nhau không được trùng.
    const ids = identified.map((a) => `${a.frontmatter.articleId}@${a.locale}`);
    expect(new Set(ids).size, 'articleId+locale uniqueness').toBe(ids.length);
  });

  it('resolves every reference to a published articleId', () => {
    // Prerequisites/related khai theo `articleId`: tham chiếu tới ID không có
    // trong content published sẽ im lặng biến mất khỏi UI (resolve "missing"
    // không render link) — hợp lệ về runtime nhưng hầu như luôn là lỗi tác
    // giả. Bắt ngay tại đây, kể cả trong demo bài.
    for (const article of parsed) {
      for (const field of ['prerequisites', 'relatedArticleIds'] as const) {
        const refs = article.frontmatter[field];
        if (!Array.isArray(refs)) {
          continue;
        }
        for (const ref of refs) {
          expect(knownIds.has(ref), `${article.locale}/${article.slug}: ${field} -> ${ref}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('pairs seriesId and seriesOrder and pins seriesId to the catalog', () => {
    // Cặp series field đi cùng nhau (mirror của refine trong schema — zod
    // chạy lúc build, bộ luật này chạy ở `nx test`), và mọi seriesId phải là
    // series đã khai metadata hiển thị trong `SERIES_META`.
    for (const article of parsed) {
      const { seriesId, seriesOrder } = article.frontmatter;
      const hasId = typeof seriesId === 'string';
      const hasOrder = typeof seriesOrder === 'string' || typeof seriesOrder === 'number';
      expect(
        [article.slug, hasId === hasOrder],
        `${article.locale}/${article.slug}: series pair`,
      ).toEqual([expect.any(String), true]);
      // Series id ngoài catalog cũng bị chặn — assert không nằm trong if:
      // bài không khai series thì chuỗi rỗng, `'' in SERIES_META` luôn false,
      // điều kiện biến thành điều kiện ràng buộc thật của assertion.
      const id = hasId ? seriesId : '';
      expect(id in SERIES_META, `${article.locale}/${article.slug}: seriesId ${id}`).toBe(hasId);
    }
  });

  it('keeps series order unambiguous within each series and locale', () => {
    // Hai bài cùng `(seriesId, seriesOrder, locale)` là thứ tự học tập mù —
    // nav series không biết ai trước ai. Khoảng trống order (1,3 thiếu 2) là
    // hợp lệ: series có thể đặt khoảng chủ ý.
    const seen = new Set<string>();
    for (const article of parsed) {
      const { seriesId, seriesOrder } = article.frontmatter;
      if (typeof seriesId !== 'string' || seriesOrder === undefined) {
        continue;
      }
      const key = `${seriesId}@${article.locale}@${seriesOrder}`;
      expect(seen.has(key), `duplicate series position: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('marks research articles with prerequisites and at least one citation link', () => {
    // **Chỉ** bài khai `contentType` research (research-review/benchmark/
    // experiment) mới chịu chuẩn trích dẫn — demo bài không khai contentType
    // không bao giờ bị gán chuẩn research giả. Bài theory không bắt buộc cite
    // (nó là bài explain của chính mình).
    const scholarly = parsed.filter((a) =>
      ['research-review', 'benchmark', 'experiment'].includes(a.frontmatter.contentType as string),
    );
    for (const article of scholarly) {
      const body = article.raw.replace(/^---[\s\S]*?---/u, '');
      const citationLinks = [...body.matchAll(/\[[^\]]+\]\(https?:\/\/[^)]+\)/gu)].map(
        (match) => match[0],
      );
      expect(
        citationLinks.length,
        `${article.locale}/${article.slug}: external citations`,
      ).toBeGreaterThan(0);
    }
  });

  it('never backdates updatedAt before the publication date', () => {
    // `updatedAt` trước `date` là metadata mâu thuẫn (mirror của refine trong
    // schema — so sánh lexical an toàn vì cả hai đều là YYYY-MM-DD).
    for (const article of parsed) {
      const { updatedAt, date } = article.frontmatter;
      if (typeof updatedAt !== 'string') {
        continue;
      }
      expect(
        updatedAt >= (date as string),
        `${article.locale}/${article.slug}: updatedAt ${updatedAt} < date ${date}`,
      ).toBe(true);
    }
  });
});

describe('blog route namespace', () => {
  it('keeps the series route namespace free of article slugs', () => {
    // Route blog duy nhất phục vụ cả article lẫn series overview: remainder
    // `series/<id>` là KHÔNG GIAN của series (regex ở route + `SERIES_META`).
    // Một thư mục content `blog/series/...` hoặc `blog/series` sẽ cùng không
    // gian URL đó — đúng ID đã khai là route series nuốt mất document; sai ID
    // thì document render ở path mà người đọc đọc nhầm là trang series. Contract:
    // namespace `series/` thuộc route, content article luôn phẳng một segment.
    const conflicting = articles.filter(
      (article) => article.slug === 'series' || article.slug.startsWith('series/'),
    );
    expect(conflicting.map((a) => `${a.locale}/${a.slug}`)).toEqual([]);
  });
});
