import { describe, expect, it } from 'vitest';
import {
  blogArticleAvailableLocales,
  blogLandingArticleLocales,
  blogLandingAvailableLocales,
  blogSeoAlternateLocales,
  blogTranslationCandidates,
} from './blog-translations';
import { buildBlogSeo } from './blog-seo';

describe('blogLandingAvailableLocales', () => {
  it('exposes both landing locales even when the blog has no articles at all', () => {
    // Landing là route tĩnh của mount — availability suy từ registry, KHÔNG
    // từ số article. Helper không nhận tham số content nào: blog trống ở cả
    // hai locale vẫn phải có cả hai landing để switcher navigation hoạt động.
    const available = blogLandingAvailableLocales();
    expect(available).toContain('en');
    expect(available).toContain('vi');
    expect(available).toHaveLength(2);
  });
});

describe('blogTranslationCandidates', () => {
  it('builds candidate paths for every registry locale independent of content', () => {
    // remainder luôn bắt đầu bằng `/` (vì shape pathname `/<locale>/blog/<remainder>`)
    const candidates = blogTranslationCandidates('/url-model');
    expect(candidates).toEqual(['/en/blog/url-model', '/vi/blog/url-model']);
  });
});

describe('blogArticleAvailableLocales', () => {
  // Content states của Finding 1: không article nào, chỉ EN, chỉ VI.
  // `existingPaths` là kết quả query `path IN candidates` — mô phỏng từng
  // state bằng tập path tĩnh, đúng observable behavior của route.
  const EN_ONLY = new Set(['/en/blog/url-model']);
  const VI_ONLY = new Set(['/vi/blog/url-model']);
  const EMPTY = new Set<string>();

  it('offers only en when only the en translation exists', () => {
    const available = blogArticleAvailableLocales('/url-model', EN_ONLY);
    expect(available).toEqual(['en']);
  });

  it('offers only vi when only the vi translation exists', () => {
    const available = blogArticleAvailableLocales('/url-model', VI_ONLY);
    expect(available).toEqual(['vi']);
  });

  it('offers both locales when both translations exist', () => {
    const available = blogArticleAvailableLocales(
      '/url-model',
      new Set(['/en/blog/url-model', '/vi/blog/url-model']),
    );
    expect(available).toEqual(['en', 'vi']);
  });

  it('offers no locale when the resource exists in neither locale (unknown article)', () => {
    const available = blogArticleAvailableLocales('/url-model', EMPTY);
    expect(available).toEqual([]);
  });

  it('never generates a switch URL for a nonexistent translation', () => {
    // Bất biến: candidate `/vi/...` không tồn tại trong EN_ONLY thì không thể
    // nằm trong kết quả — so khớp trực tiếp từng candidate với tập kết quả.
    const candidates = blogTranslationCandidates('/url-model');
    const availableFromEnOnly = blogArticleAvailableLocales('/url-model', EN_ONLY);
    const viCandidates = candidates.filter((path) => path.startsWith('/vi/'));
    expect(viCandidates).toEqual(['/vi/blog/url-model']);
    expect(EN_ONLY.has('/vi/blog/url-model')).toBe(false);
    expect(availableFromEnOnly).not.toContain('vi');
    expect(blogArticleAvailableLocales('/url-model', VI_ONLY)).not.toContain('en');
  });
});

describe('blogSeoAlternateLocales', () => {
  it('passes the switcher set through when every locale really has articles', () => {
    // Landing có bài ở cả hai locale: switcher availability, article
    // availability và SEO availability là cùng một tập, hành vi cũ giữ nguyên.
    expect(
      blogSeoAlternateLocales({
        fallbackDiscovery: false,
        locale: 'en',
        kind: 'landing',
        switcherLocales: ['en', 'vi'],
        articleLocales: ['en', 'vi'],
      }),
    ).toEqual(['en', 'vi']);
  });

  it('drops a locale whose landing is only an English-content fallback', () => {
    // **Finding B, nhánh EN.** `/en/blog` có bài nên `fallbackDiscovery` là
    // `false` — nhưng `/vi/blog` rỗng. Switcher vẫn phải dẫn tới `/vi/blog`
    // (landing là route tĩnh của mount, xem `blogLandingAvailableLocales`), còn
    // SEO thì **không** được quảng bá nó là bản dịch của `/en/blog`.
    expect(
      blogSeoAlternateLocales({
        fallbackDiscovery: false,
        locale: 'en',
        kind: 'landing',
        switcherLocales: ['en', 'vi'],
        articleLocales: ['en'],
      }),
    ).toEqual(['en']);
  });

  it('collapses to the current locale on a fallback landing', () => {
    // Landing fallback: tập SEO locale không được tràn ra ngoài trang hiện tại.
    // `buildBlogSeo` còn bỏ hết alternate qua cờ `fallbackDiscovery`; lớp này
    // là lớp phòng thứ hai, và test dưới chứng minh cả hai cùng giữ.
    expect(
      blogSeoAlternateLocales({
        fallbackDiscovery: true,
        locale: 'vi',
        kind: 'landing',
        switcherLocales: ['en', 'vi'],
        articleLocales: ['en'],
      }),
    ).toEqual(['vi']);
  });

  it('does not filter an article page by which locales have articles', () => {
    // **Phân biệt loại trang.** Với article, `switcherLocales` **đã** là tập
    // locale có bản dịch của chính bài đó (suy từ `where('path','IN',...)`).
    // Lọc thêm theo "locale nào có bài nào" sẽ loại nhầm một bản dịch hợp lệ
    // chỉ vì nó nằm trong inventory rỗng — `articleLocales` cố tình **không**
    // được đọc ở nhánh này.
    expect(
      blogSeoAlternateLocales({
        fallbackDiscovery: false,
        locale: 'en',
        kind: 'article',
        switcherLocales: ['en', 'vi'],
        articleLocales: ['en'],
      }),
    ).toEqual(['en', 'vi']);
  });

  it('leaves a series page advertising only its own locale', () => {
    // Series overview là route cục bộ theo locale: series có bài ở EN mà chưa
    // có ở VI không được quảng bá một bản dịch chéo trỏ tới trang 404.
    expect(
      blogSeoAlternateLocales({
        fallbackDiscovery: false,
        locale: 'en',
        kind: 'series',
        switcherLocales: ['en'],
        articleLocales: ['en'],
      }),
    ).toEqual(['en']);
  });

  it('keeps the current page self-referential even if its locale is missing from the input', () => {
    // Google khuyến nghị cluster self-referential: danh sách alternate phải
    // bao gồm chính trang hiện tại. Guard này giữ bất biến đó thậm chí khi
    // caller đưa vào một tập không chứa locale của trang.
    expect(
      blogSeoAlternateLocales({
        fallbackDiscovery: false,
        locale: 'en',
        kind: 'landing',
        switcherLocales: ['en'],
        articleLocales: [],
      }),
    ).toEqual(['en']);
  });
});

describe('blogLandingArticleLocales', () => {
  it('reports only locales that actually have a published article', () => {
    // Đây là phép so sánh mà `isFallbackDiscovery` của route làm theo từng
    // locale; helper cho nó một tên để test được và để không lệch định nghĩa.
    // Input là **mảng path thật**, đúng thứ route nhận từ `select('path')`.
    expect(
      blogLandingArticleLocales(['/en/blog/url-model', '/en/blog/attention', '/vi/blog/url-model']),
    ).toEqual(['en', 'vi']);
  });

  it('reports an empty-inventory locale as absent, while another keeps its landing', () => {
    // Trạng thái English-first đích danh: VI rỗng thì `vi` không có mặt, EN
    // thì có — hai landing cùng tồn tại nhưng chỉ một là landing nội dung.
    expect(blogLandingArticleLocales(['/en/blog/url-model'])).toEqual(['en']);
    expect(blogLandingArticleLocales([])).toEqual([]);
  });

  it('does not mistake an article of another mount for a blog article', () => {
    // `/en/docs/x` không phải bài blog: `/en/blog` prefix phải khớp trên ranh
    // giới segment, không phải chuỗi.
    expect(blogLandingArticleLocales(['/en/docs/getting-started'])).toEqual([]);
  });

  it('does not mistake an article of a locale-prefixed code for another locale', () => {
    // `end` là locale code hợp lệ trong registry này; path bài của nó **không**
    // phải bài của `en`, dù `/end/...` bắt đầu bằng `en`. So khớp bằng path
    // `buildPublicPath` sinh ra, không parse tay, là chỗ bảo vệ duy nhất.
    expect(blogLandingArticleLocales(['/end/blog/url-model'])).toEqual([]);
  });
});

/**
 * Dựng đúng input route truyền cho SEO ở một landing, từ tập path bài thật
 * của **cả hai** locale: availability của switcher suy từ route (landing tồn
 * tại ở mọi locale), `fallbackDiscovery` suy từ inventory của locale đó, SEO
 * locale suy qua helper.
 */
function seoFor(locale: 'en' | 'vi', paths: readonly string[]) {
  const prefix = `/${locale}/blog/`;
  const fallbackDiscovery = !paths.some((path) => path.startsWith(prefix));
  return buildBlogSeo({
    pathname: `/${locale}/blog`,
    locale,
    title: undefined,
    description: undefined,
    availableLocales: blogSeoAlternateLocales({
      fallbackDiscovery,
      locale,
      kind: 'landing',
      switcherLocales: blogLandingAvailableLocales(),
      articleLocales: blogLandingArticleLocales(paths),
    }),
    fallbackDiscovery,
  });
}

/** `hreflang=href` của mọi alternate, đã sắp xếp — so sánh không phụ thuộc thứ tự. */
function hrefs(seo: ReturnType<typeof buildBlogSeo>): string[] {
  return seo.alternates.map((alternate) => `${alternate.hreflang}=${alternate.href}`).toSorted();
}

describe('blogSeoAlternateLocales + buildBlogSeo — no false cross-locale hreflang', () => {
  /** Path bài của hai inventory trong các test bên dưới. */
  const englishOnly = ['/en/blog/url-model', '/en/blog/attention'];
  const both = [...englishOnly, '/vi/blog/url-model'];

  it('does not advertise the fallback landing as an equivalent translated alternate', () => {
    // **Finding B.** `/vi/blog` là landing fallback: nội dung tiếng Anh,
    // `noindex, follow`, không alternate. `/en/blog` có bài thật nên phát
    // alternate `en` cho chính nó — nhưng **không** được phát `vi-VN` trỏ
    // tới `/vi/blog`. Nếu phát, cluster thành khai báo một chiều: VI nói "tôi
    // không có bản dịch", EN lại nói "đây là bản dịch của tôi".
    const en = seoFor('en', englishOnly);
    expect(en.alternates.map((alternate) => alternate.hreflang)).toEqual(['en']);
    expect(en.alternates.some((alternate) => alternate.href.includes('/vi/blog'))).toBe(false);
  });

  it('keeps the fallback landing self-canonical, noindex and free of alternates', () => {
    const vi = seoFor('vi', englishOnly);
    expect(vi.canonical).toBe('https://ecoma.io/vi/blog');
    expect(vi.robots).toBe('noindex, follow');
    expect(vi.alternates).toEqual([]);
    // `lang` vẫn theo registry của locale hiện tại, không phải locale của
    // nội dung hiển thị — trang vẫn phục vụ người đọc tiếng Việt.
    expect(vi.lang).toBe('vi-VN');
  });

  it('restores the cross-locale alternate once the locale really has articles', () => {
    // Khi VI có bài, landing không còn fallback: hai landing là hai bản dịch
    // thật và hreflang chéo trở lại. Đây là hành vi phải quay lại khi PR nội
    // dung thêm bài tiếng Việt — không phải hành vi vĩnh viễn.
    const vi = seoFor('vi', both);
    expect(vi.robots).toBeUndefined();
    expect(vi.alternates.map((alternate) => alternate.hreflang).toSorted()).toEqual([
      'en',
      'vi-VN',
    ]);
  });

  it('is symmetric when neither locale is a fallback', () => {
    expect(hrefs(seoFor('en', both))).toEqual(hrefs(seoFor('vi', both)));
  });
});
