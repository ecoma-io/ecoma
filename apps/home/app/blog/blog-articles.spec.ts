import { describe, expect, it } from 'vitest';
import {
  articleDisplayTags,
  normalizeArticleCover,
  orderArticlesByDateDesc,
  pickAdjacentArticles,
  pickFeaturedArticle,
  pickRelatedArticles,
  type BlogArticleSummary,
} from './blog-articles';

/** Fixture factory — một article EN với các field override được. */
function en(overrides: Partial<BlogArticleSummary> & { path: string }): BlogArticleSummary {
  return {
    stem: `en/blog/${overrides.path.split('/').pop()}`,
    title: `Article ${overrides.path}`,
    description: 'Description',
    date: '2026-09-01',
    author: 'John Martin',
    tags: ['architecture'],
    featured: false,
    ...overrides,
  };
}

describe('orderArticlesByDateDesc', () => {
  it('orders newest first', () => {
    const ordered = orderArticlesByDateDesc([
      en({ path: '/en/blog/a', date: '2026-09-01' }),
      en({ path: '/en/blog/b', date: '2026-09-09' }),
      en({ path: '/en/blog/c', date: '2026-09-05' }),
    ]);
    expect(ordered.map((article) => article.path)).toEqual([
      '/en/blog/b',
      '/en/blog/c',
      '/en/blog/a',
    ]);
  });

  it('breaks date ties deterministically by stem ascending', () => {
    // Hai article cùng ngày: thứ tự chỉ có thể đến từ `stem` — số ordering
    // prefix trong tên file làm tie-break này ổn định và không trùng.
    const ordered = orderArticlesByDateDesc([
      en({ path: '/en/blog/b', stem: 'en/blog/2.b', date: '2026-09-01' }),
      en({ path: '/en/blog/a', stem: 'en/blog/1.a', date: '2026-09-01' }),
    ]);
    expect(ordered.map((article) => article.path)).toEqual(['/en/blog/a', '/en/blog/b']);
  });

  it('breaks stem ties numerically: 2.x sorts before 10.x', () => {
    // So chữ thuần đặt `10.x` trước `2.x` — prefix ordering prefix mất ý nghĩa
    // editorial ngay khi một locale vượt 9 bài cùng ngày. Collation numeric
    // giữ đúng thứ tự số.
    const ordered = orderArticlesByDateDesc([
      en({ path: '/en/blog/ten', stem: 'en/blog/10.ten', date: '2026-09-01' }),
      en({ path: '/en/blog/two', stem: 'en/blog/2.two', date: '2026-09-01' }),
    ]);
    expect(ordered.map((article) => article.path)).toEqual(['/en/blog/two', '/en/blog/ten']);
  });

  it('never mixes locales when the input list is locale-filtered', () => {
    // Hàm chỉ sort theo `date`/`stem` — nhưng test này pin contract: caller
    // truyền danh sách đã lọc một locale, và sort không được làm mất tính chất
    // đó (không thêm/xoá phần tử).
    const input = [en({ path: '/en/blog/a' }), en({ path: '/en/blog/b' })];
    const ordered = orderArticlesByDateDesc(input);
    expect(ordered).toHaveLength(2);
    expect(ordered.every((article) => article.path.startsWith('/en/'))).toBe(true);
  });

  it('does not mutate the input array', () => {
    const input = [
      en({ path: '/en/blog/a', date: '2026-09-01' }),
      en({ path: '/en/blog/b', date: '2026-09-09' }),
    ];
    const snapshot = [...input];
    orderArticlesByDateDesc(input);
    expect(input).toEqual(snapshot);
  });

  it('returns an empty array for an empty list', () => {
    expect(orderArticlesByDateDesc([])).toEqual([]);
  });
});

describe('pickFeaturedArticle', () => {
  it('picks the flagged article even when it is not the newest', () => {
    const featured = pickFeaturedArticle([
      en({ path: '/en/blog/new', date: '2026-10-01', featured: false }),
      en({ path: '/en/blog/pick', date: '2026-09-01', featured: true }),
    ]);
    expect(featured?.path).toBe('/en/blog/pick');
  });

  it('picks the first flagged article in display order when several are flagged', () => {
    const featured = pickFeaturedArticle([
      en({ path: '/en/blog/old', date: '2026-09-01', featured: true }),
      en({ path: '/en/blog/new', date: '2026-10-01', featured: true }),
    ]);
    expect(featured?.path).toBe('/en/blog/new');
  });

  it('falls back to the newest article when nothing is featured', () => {
    // Landing luôn có hero: fallback là bài mới nhất, không phải `undefined` —
    // nhưng fallback phải là bài **thật** từ danh sách, không phải dữ liệu chế.
    const featured = pickFeaturedArticle([
      en({ path: '/en/blog/old', date: '2026-09-01', featured: false }),
      en({ path: '/en/blog/new', date: '2026-10-01', featured: false }),
    ]);
    expect(featured?.path).toBe('/en/blog/new');
    expect(featured?.featured).toBe(false);
  });

  it('returns undefined for an empty list', () => {
    // Blog rỗng: không hero — landing vẫn render hợp lệ với listing rỗng.
    expect(pickFeaturedArticle([])).toBeUndefined();
  });
});

describe('pickRelatedArticles', () => {
  const current = en({
    path: '/en/blog/current',
    date: '2026-10-01',
    tags: ['architecture', 'urls'],
  });

  const pool = [
    current,
    en({ path: '/en/blog/same-primary', tags: ['architecture'], date: '2026-09-20' }),
    en({ path: '/en/blog/same-secondary', tags: ['urls'], date: '2026-09-25' }),
    en({ path: '/en/blog/no-tag-overlap', tags: ['design'], date: '2026-09-15' }),
    // Article VI không nằm trong pool này: caller lọc theo locale ở tầng query;
    // test dưới pin thêm rằng hàm không đụng tới path ngoài locale nếu danh
    // sách đầu vào đúng contract.
  ];

  it('excludes the current article from its own related list', () => {
    const related = pickRelatedArticles(pool, current, 3);
    expect(related.every((article) => article.path !== current.path)).toBe(true);
  });

  it('ranks by the primary tag and orders newest first', () => {
    const related = pickRelatedArticles(pool, current, 3);
    // Chỉ `same-primary` chia tag đầu (`architecture`); `same-secondary` chia
    // tag phụ nhưng không phải tag chính.
    expect(related.map((article) => article.path)).toEqual(['/en/blog/same-primary']);
  });

  it('respects the limit', () => {
    const bigPool = [
      ...pool,
      en({ path: '/en/blog/more-1', tags: ['architecture'], date: '2026-08-20' }),
      en({ path: '/en/blog/more-2', tags: ['architecture'], date: '2026-08-10' }),
    ];
    const related = pickRelatedArticles(bigPool, current, 2);
    expect(related).toHaveLength(2);
    expect(related.map((article) => article.path)).toEqual([
      '/en/blog/same-primary',
      '/en/blog/more-1',
    ]);
  });

  it('returns an empty list when the current article has no tags', () => {
    const untagged = en({ path: '/en/blog/untagged', tags: [] });
    expect(pickRelatedArticles(pool, untagged, 3)).toEqual([]);
  });

  it('keeps every related article within the provided (locale-filtered) pool', () => {
    const related = pickRelatedArticles(pool, current, 10);
    // Mọi kết quả đến từ pool — không có article nào được "suy ra" ngoài input.
    const poolPaths = new Set(pool.map((article) => article.path));
    expect(related.every((article) => poolPaths.has(article.path))).toBe(true);
  });

  it('never promotes a secondary-tag-only article even when the primary tag has no candidates', () => {
    // Docstring của hàm pin hành vi này: không fallback sang tag phụ — pool
    // không ai chia tag chính (`architecture`) thì kết quả rỗng, dù
    // `same-secondary` chia tag phụ.
    const noPrimaryCandidates = [
      current,
      en({ path: '/en/blog/same-secondary', tags: ['urls'], date: '2026-09-25' }),
      en({ path: '/en/blog/other', tags: ['design'], date: '2026-09-15' }),
    ];
    expect(pickRelatedArticles(noPrimaryCandidates, current, 3)).toEqual([]);
  });
});

describe('pickAdjacentArticles', () => {
  // Danh sách đã sort mới-nhất-trước — đúng output của
  // `orderArticlesByDateDesc` mà route truyền vào.
  const list = [
    en({ path: '/en/blog/newest', date: '2026-10-07' }),
    en({ path: '/en/blog/middle', date: '2026-09-16' }),
    en({ path: '/en/blog/oldest', date: '2026-09-02' }),
  ];

  it('points previous at the older article and next at the newer one', () => {
    // Ngữ nghĩa theo trục thời gian: "previous" = cũ hơn, "next" = mới hơn —
    // trong danh sách mới-nhất-trước, previous là phần tử *sau* hiện tại.
    const middle = list[1];
    expect(middle).toBeDefined();
    if (!middle) {
      return;
    }
    const adjacent = pickAdjacentArticles(list, middle);
    expect(adjacent.previous?.path).toBe('/en/blog/oldest');
    expect(adjacent.next?.path).toBe('/en/blog/newest');
  });

  it('leaves previous undefined at the oldest article (no wraparound)', () => {
    const oldest = list[2];
    expect(oldest).toBeDefined();
    if (!oldest) {
      return;
    }
    const adjacent = pickAdjacentArticles(list, oldest);
    expect(adjacent.previous).toBeUndefined();
    expect(adjacent.next?.path).toBe('/en/blog/middle');
  });

  it('leaves next undefined at the newest article (no wraparound)', () => {
    const newest = list[0];
    expect(newest).toBeDefined();
    if (!newest) {
      return;
    }
    const adjacent = pickAdjacentArticles(list, newest);
    expect(adjacent.previous?.path).toBe('/en/blog/middle');
    expect(adjacent.next).toBeUndefined();
  });

  it('returns both sides undefined when the current article is not in the list', () => {
    const stranger = en({ path: '/en/blog/stranger', date: '2026-09-20' });
    const adjacent = pickAdjacentArticles(list, stranger);
    expect(adjacent.previous).toBeUndefined();
    expect(adjacent.next).toBeUndefined();
  });

  it('never places the current article in its own pager pair', () => {
    for (const article of list) {
      const adjacent = pickAdjacentArticles(list, article);
      const paths = [adjacent.previous?.path, adjacent.next?.path];
      expect(paths).not.toContain(article.path);
    }
  });
});

describe('normalizeArticleCover', () => {
  it('keeps a complete valid pair', () => {
    expect(normalizeArticleCover('/assets/cover.svg', 'A cover')).toEqual({
      src: '/assets/cover.svg',
      alt: 'A cover',
    });
  });

  it('drops the cover when the URL is missing or blank', () => {
    // Cover chỉ toàn khoảng trắng cũng bị loại — invariant của hai nhánh phải
    // phản chiếu nhau, không sinh `<img src="   ">`.
    expect(normalizeArticleCover(undefined, 'A cover')).toBeUndefined();
    expect(normalizeArticleCover('', 'A cover')).toBeUndefined();
    expect(normalizeArticleCover('   ', 'A cover')).toBeUndefined();
  });

  it('drops the cover when the alt is missing or blank', () => {
    expect(normalizeArticleCover('/assets/cover.svg', undefined)).toBeUndefined();
    expect(normalizeArticleCover('/assets/cover.svg', '')).toBeUndefined();
    expect(normalizeArticleCover('/assets/cover.svg', '   ')).toBeUndefined();
  });

  it('keeps an alt that only surrounds real text with whitespace, trimmed is not required', () => {
    // Alt có nội dung nhưng hai đầu có khoảng trắng vẫn hợp lệ — hàm chỉ loại
    // alt **rỗng sau trim**, không mutate giá trị (renderer giữ nguyên text).
    expect(normalizeArticleCover('/assets/cover.svg', ' A cover ')).toEqual({
      src: '/assets/cover.svg',
      alt: ' A cover ',
    });
  });
});

describe('articleDisplayTags', () => {
  it('deduplicates repeated tags', () => {
    expect(articleDisplayTags(['meta', 'meta', 'design'])).toEqual(['meta', 'design']);
  });

  it('trims and drops blank tags', () => {
    expect(articleDisplayTags(['  meta  ', '   ', ''])).toEqual(['meta']);
  });

  it('returns an empty list for undefined and empty input', () => {
    expect(articleDisplayTags(undefined)).toEqual([]);
    expect(articleDisplayTags([])).toEqual([]);
  });

  it('preserves first-occurrence order after dedupe', () => {
    // Thứ tự frontmatter mang ý nghĩa (tag đầu là chủ đề chính của related) —
    // dedupe không được đảo thứ tự.
    expect(articleDisplayTags(['design', 'meta', 'design', 'urls'])).toEqual([
      'design',
      'meta',
      'urls',
    ]);
  });
});
