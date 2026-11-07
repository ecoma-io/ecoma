import { describe, expect, it } from 'vitest';
import {
  getSeriesMeta,
  orderArticlesBySeriesOrder,
  seriesNeighbors,
  seriesLandingEntries,
  seriesWithArticles,
  type SeriesArticle,
} from './blog-series';

/** Fixture factory — một article trong series với các field override được. */
function article(overrides: Partial<SeriesArticle> & { path: string }): SeriesArticle {
  return { ...overrides };
}

describe('seriesWithArticles', () => {
  it('lists only series that have at least one article', () => {
    const entries = seriesWithArticles([
      article({ path: '/en/blog/a', seriesId: 'language-modeling', seriesOrder: 1 }),
      article({ path: '/en/blog/b' }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(['language-modeling']);
    expect(entries[0]?.meta.title).toBe('Language modeling and transformers');
  });

  it('never lists a series without published articles', () => {
    // Series trong SERIES_META mà không bài nào published KHÔNG xuất hiện —
    // trang series rỗng không bao giờ được sinh từ metadata khai sẵn.
    expect(seriesWithArticles([article({ path: '/en/blog/a' })])).toEqual([]);
    expect(seriesWithArticles([])).toEqual([]);
  });

  it('ignores series ids outside the catalog', () => {
    // Bài khai seriesId lạ (schema refine phải chặn ở build, nhưng hàm thuần
    // không được trust): không crash, không liệt kê series "đường".
    const entries = seriesWithArticles([
      article({ path: '/en/blog/a', seriesId: 'ghost-series', seriesOrder: 1 }),
    ]);
    expect(entries).toEqual([]);
  });

  it('sorts entries by series id for deterministic rendering', () => {
    const entries = seriesWithArticles([
      article({ path: '/en/blog/a', seriesId: 'language-modeling', seriesOrder: 2 }),
      article({ path: '/en/blog/b', seriesId: 'language-modeling', seriesOrder: 1 }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(['language-modeling']);
  });
});

describe('getSeriesMeta', () => {
  it('returns metadata for a catalog series', () => {
    expect(getSeriesMeta('language-modeling')?.title).toBe('Language modeling and transformers');
  });

  it('returns undefined for an unknown series id', () => {
    expect(getSeriesMeta('nope')).toBeUndefined();
  });
});

describe('orderArticlesBySeriesOrder', () => {
  it('orders by seriesOrder ascending, ignoring publication date', () => {
    const ordered = orderArticlesBySeriesOrder(
      [
        article({ path: '/en/blog/late', seriesId: 's', seriesOrder: 3 }),
        article({ path: '/en/blog/early', seriesId: 's', seriesOrder: 1 }),
        article({ path: '/en/blog/mid', seriesId: 's', seriesOrder: 2 }),
      ],
      's',
    );
    expect(ordered.map((a) => a.path)).toEqual(['/en/blog/early', '/en/blog/mid', '/en/blog/late']);
  });

  it('excludes articles of other series and standalone articles', () => {
    const ordered = orderArticlesBySeriesOrder(
      [
        article({ path: '/en/blog/in', seriesId: 's', seriesOrder: 1 }),
        article({ path: '/en/blog/other', seriesId: 'other', seriesOrder: 1 }),
        article({ path: '/en/blog/standalone' }),
      ],
      's',
    );
    expect(ordered.map((a) => a.path)).toEqual(['/en/blog/in']);
  });

  it('breaks order ties deterministically by path ascending', () => {
    // Hai bài cùng order là lỗi contract (bắt ở contract test), nhưng sort
    // không được rơi vào hành vi không xác định vì thế.
    const ordered = orderArticlesBySeriesOrder(
      [
        article({ path: '/en/blog/b', seriesId: 's', seriesOrder: 1 }),
        article({ path: '/en/blog/a', seriesId: 's', seriesOrder: 1 }),
      ],
      's',
    );
    expect(ordered.map((a) => a.path)).toEqual(['/en/blog/a', '/en/blog/b']);
  });

  it('does not mutate the input array', () => {
    const input = [
      article({ path: '/en/blog/late', seriesId: 's', seriesOrder: 2 }),
      article({ path: '/en/blog/early', seriesId: 's', seriesOrder: 1 }),
    ];
    const snapshot = [...input];
    orderArticlesBySeriesOrder(input, 's');
    expect(input).toEqual(snapshot);
  });
});

describe('seriesNeighbors', () => {
  const series = [
    article({ path: '/en/blog/one', title: 'One', seriesId: 's', seriesOrder: 1 }),
    article({ path: '/en/blog/two', title: 'Two', seriesId: 's', seriesOrder: 2 }),
    article({ path: '/en/blog/three', title: 'Three', seriesId: 's', seriesOrder: 3 }),
  ];

  it('returns previous and next within the learning order', () => {
    const neighbors = seriesNeighbors(series, series[1] as SeriesArticle);
    expect(neighbors?.previous?.path).toBe('/en/blog/one');
    expect(neighbors?.next?.path).toBe('/en/blog/three');
  });

  it('returns undefined previous at the series head and undefined next at the tail', () => {
    const head = seriesNeighbors(series, series[0] as SeriesArticle);
    expect(head?.previous).toBeUndefined();
    expect(head?.next?.path).toBe('/en/blog/two');
    const tail = seriesNeighbors(series, series[2] as SeriesArticle);
    expect(tail?.previous?.path).toBe('/en/blog/two');
    expect(tail?.next).toBeUndefined();
  });

  it('returns undefined for an article outside any series', () => {
    expect(seriesNeighbors(series, article({ path: '/en/blog/solo' }))).toBeUndefined();
  });

  it('returns undefined when the article is not in the given list', () => {
    expect(
      seriesNeighbors(
        series,
        article({ path: '/en/blog/unlisted', seriesId: 's', seriesOrder: 9 }),
      ),
    ).toBeUndefined();
  });
});

describe('seriesLandingEntries', () => {
  /** Hai bài của một series trong `SERIES_META` — fixture không cần thêm series. */
  const englishSeries = [
    article({ path: '/en/blog/one', seriesId: 'language-modeling', seriesOrder: 1 }),
    article({ path: '/en/blog/two', seriesId: 'language-modeling', seriesOrder: 2 }),
  ];

  it('links a series overview under the locale that actually has its articles', () => {
    // Landing có bài của locale: series ở cùng locale thì URL cùng locale.
    expect(seriesLandingEntries(englishSeries, 'en')).toEqual([
      {
        id: 'language-modeling',
        meta: getSeriesMeta('language-modeling'),
        articleCount: 2,
        path: '/en/blog/series/language-modeling',
      },
    ]);
  });

  it('points an English-only series at its English overview from an empty-locale landing', () => {
    // **Nhánh English-first.** Landing `/vi/blog` chưa có bài tiếng Việt nên
    // inventory của nó rỗng; series chỉ tồn tại ở English. Link bắt buộc là
    // `/en/blog/series/...` — `/vi/blog/series/...` sẽ 404 vì route series
    // cần ít nhất một bài published ở chính locale đó.
    expect(seriesLandingEntries([], 'vi', { articles: englishSeries, locale: 'en' })).toEqual([
      {
        id: 'language-modeling',
        meta: getSeriesMeta('language-modeling'),
        articleCount: 2,
        path: '/en/blog/series/language-modeling',
      },
    ]);
  });

  it('counts articles from the locale the series belongs to, not the empty landing locale', () => {
    // Đếm trên inventory rỗng sẽ ra 0 và card sẽ quảng bá một series rỗng ở
    // nơi nó có 2 bài thật — số bài phải đếm trên inventory của series.
    const [entry] = seriesLandingEntries([], 'vi', { articles: englishSeries, locale: 'en' });
    expect(entry?.articleCount).toBe(2);
  });

  it('prefers the landing locale when the series has articles in both locales', () => {
    // Series đã có bản ở cả hai locale: landing `/vi` dẫn tới bản tiếng Việt,
    // và inventory English chỉ là dự phòng chứ không phải nơi đếm.
    const both = [
      ...englishSeries,
      article({ path: '/vi/blog/mot', seriesId: 'language-modeling', seriesOrder: 1 }),
    ];
    expect(
      seriesLandingEntries(both, 'vi', { articles: englishSeries, locale: 'en' }).map(
        (entry) => entry.path,
      ),
    ).toEqual(['/vi/blog/series/language-modeling']);
  });

  it('never emits a series entry that has no articles in either locale', () => {
    // Không có bài ở đâu thì không có card — một card series là đường duy nhất
    // crawler prerender tới trang overview, nên card sai là trang 404 trong
    // manifest.
    expect(seriesLandingEntries([], 'vi', { articles: [], locale: 'en' })).toEqual([]);
    expect(seriesLandingEntries([article({ path: '/en/blog/solo' })], 'en')).toEqual([]);
  });

  it('works without a fallback inventory, which is the normal localized landing', () => {
    expect(seriesLandingEntries(englishSeries, 'en')).toHaveLength(1);
  });
});
