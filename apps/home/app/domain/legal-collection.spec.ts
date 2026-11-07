import { describe, expect, it } from 'vitest';

import {
  brokenLegalRelatedReferences,
  duplicateLegalSlugs,
  filterLegalDocumentsByPublication,
  groupLegalDocumentsByCategory,
  legalAvailableLocales,
  legalCategoryOrder,
  legalLocaleFromPath,
  legalSlugFromPath,
  orderLegalDocumentsByStem,
} from './legal-collection';

/**
 * Unit test cho domain thuần của collection `legal` — mọi hàm chạy trên data
 * tĩnh, không Nuxt runtime, không SQLite: cùng pattern với các spec domain
 * khác của app. Fixture khớp structural subset `LegalDocumentRecord`.
 */

const FIXTURES = [
  {
    path: '/en/legal/privacy',
    slug: 'privacy',
    title: 'Privacy Policy — ecoma.io',
    description: 'How ecoma.io collects, uses and protects personal data.',
    category: 'policy',
    status: 'published',
    reviewStatus: 'reviewed',
    version: '1.0',
    effectiveDate: '2026-10-10',
    locale: 'en',
  },
  {
    path: '/en/legal/draft-terms',
    slug: 'draft-terms',
    title: 'Draft Terms',
    description: 'A draft.',
    category: 'terms',
    status: 'draft',
    reviewStatus: 'unreviewed',
    version: '0.1',
    effectiveDate: null,
    locale: 'en',
  },
  {
    path: '/vi/legal/privacy',
    slug: 'privacy',
    title: 'Chính sách bảo mật — ecoma.io',
    description: 'Cách ecoma.io thu thập dữ liệu.',
    category: 'policy',
    status: 'published',
    reviewStatus: 'reviewed',
    version: '1.0',
    effectiveDate: '2026-10-10',
    locale: 'vi',
  },
] as const;

describe('legalSlugFromPath / legalLocaleFromPath', () => {
  it('extracts slug and locale from a collection path', () => {
    expect(legalSlugFromPath('/en/legal/privacy')).toBe('privacy');
    expect(legalLocaleFromPath('/vi/legal/privacy')).toBe('vi');
  });

  it('rejects paths outside the legal collection', () => {
    for (const path of ['/en/blog/url-model', '/en/docs/x', '/en/legal', '/legal/privacy']) {
      expect(() => legalSlugFromPath(path)).toThrow(`Not a legal collection path: "${path}"`);
      expect(() => legalLocaleFromPath(path)).toThrow(`Not a legal collection path: "${path}"`);
    }
  });
});

describe('filterLegalDocumentsByPublication', () => {
  it('drops drafts when includeDrafts is false (production build)', () => {
    const result = filterLegalDocumentsByPublication(FIXTURES, false);
    expect(result.map((d) => d.slug)).toEqual(['privacy', 'privacy']);
  });

  it('keeps drafts when includeDrafts is true (staging build)', () => {
    const result = filterLegalDocumentsByPublication(FIXTURES, true);
    expect(result).toHaveLength(3);
  });
});

describe('groupLegalDocumentsByCategory', () => {
  it('groups documents by category without reordering within a group', () => {
    const grouped = groupLegalDocumentsByCategory(FIXTURES);
    expect(grouped.policy.map((d) => d.path)).toEqual(['/en/legal/privacy', '/vi/legal/privacy']);
    expect(grouped.terms.map((d) => d.slug)).toEqual(['draft-terms']);
  });

  it('returns empty arrays for categories without documents', () => {
    const grouped = groupLegalDocumentsByCategory([]);
    expect(grouped.policy).toEqual([]);
    expect(grouped.terms).toEqual([]);
  });
});

describe('legalCategoryOrder', () => {
  it('lists policy before terms', () => {
    expect(legalCategoryOrder()).toEqual(['policy', 'terms']);
  });
});

describe('duplicateLegalSlugs', () => {
  it('reports duplicates within the same locale only', () => {
    const withDuplicate = [...FIXTURES, { ...FIXTURES[0], path: '/en/legal/privacy/extra' }];
    const duplicates = duplicateLegalSlugs(withDuplicate);
    // `/en/legal/privacy/extra` tách slug `privacy/extra` — khác slug `privacy`,
    // nên KHÔNG duplicate; duplicate chỉ xảy ra khi path trùng hoàn toàn.
    expect(duplicates).toEqual([]);

    const sameSlugSameLocale = [...FIXTURES, { ...FIXTURES[0], path: '/en/legal/privacy' }];
    expect(duplicateLegalSlugs(sameSlugSameLocale)).toEqual([{ locale: 'en', slug: 'privacy' }]);
  });
});

describe('brokenLegalRelatedReferences', () => {
  it('accepts references to existing slugs in the same locale', () => {
    const documents = [{ ...FIXTURES[0], related: ['privacy'] }, ...FIXTURES.slice(1)];
    expect(brokenLegalRelatedReferences(documents)).toEqual([]);
  });

  it('reports references to missing slugs and cross-locale mismatches', () => {
    const documents = [
      { ...FIXTURES[0], related: ['nonexistent', 'draft-terms'] },
      ...FIXTURES.slice(1),
    ];
    // `nonexistent` không tồn tại; `draft-terms` tồn tại nhưng ở locale `en`
    // (nguồn cũng `en`) — hợp lệ. Chỉ `nonexistent` bị báo.
    expect(brokenLegalRelatedReferences(documents)).toEqual([
      { from: 'privacy', to: 'nonexistent', locale: 'en' },
    ]);
  });

  it('rejects a related value that is not a slug', () => {
    const documents = [{ ...FIXTURES[0], related: ['/vi/legal/privacy'] }];
    expect(brokenLegalRelatedReferences(documents)).toEqual([
      { from: 'privacy', to: '/vi/legal/privacy', locale: 'en' },
    ]);
  });
});

describe('legalAvailableLocales', () => {
  it('returns only locales whose candidate path exists', () => {
    const candidates = [
      { locale: 'en', path: '/en/legal/privacy' },
      { locale: 'vi', path: '/vi/legal/privacy' },
    ] as const;
    // VI có thật trong content, EN không → chỉ VI được link.
    const available = legalAvailableLocales(candidates, new Set(['/vi/legal/privacy']));
    expect(available).toEqual(['vi']);
  });

  it('returns both locales when both translations exist', () => {
    const candidates = [
      { locale: 'en', path: '/en/legal/privacy' },
      { locale: 'vi', path: '/vi/legal/privacy' },
    ] as const;
    const available = legalAvailableLocales(
      candidates,
      new Set(['/en/legal/privacy', '/vi/legal/privacy']),
    );
    expect(available).toEqual(['en', 'vi']);
  });
});

describe('orderLegalDocumentsByStem', () => {
  it('orders by the numeric prefix in the file name', () => {
    // Thứ tự editorial nằm ở tên file (`1.privacy`), không ở query — nên phải
    // sort tường minh thay vì tin thứ tự builder trả về.
    const ordered = orderLegalDocumentsByStem([
      { stem: 'en/legal/2.terms', path: '/en/legal/2.terms' },
      { stem: 'en/legal/1.privacy', path: '/en/legal/1.privacy' },
      { stem: 'en/legal/3.service-delivery', path: '/en/legal/3.service-delivery' },
    ]);
    expect(ordered.map((item) => item.path)).toEqual([
      '/en/legal/1.privacy',
      '/en/legal/2.terms',
      '/en/legal/3.service-delivery',
    ]);
  });

  it('sorts two-digit prefixes numerically, not lexicographically', () => {
    // So chữ thuần đảo `10.` và `2.`; hiện chưa có file thứ 10 nhưng đó là lý
    // do dùng `{ numeric: true }` — không phải để sửa một lỗi đang xảy ra.
    const ordered = orderLegalDocumentsByStem([
      { stem: 'en/legal/10.acceptable-use', path: '/en/legal/10.acceptable-use' },
      { stem: 'en/legal/2.terms', path: '/en/legal/2.terms' },
      { stem: 'en/legal/1.privacy', path: '/en/legal/1.privacy' },
    ]);
    expect(ordered.map((item) => item.path)).toEqual([
      '/en/legal/1.privacy',
      '/en/legal/2.terms',
      '/en/legal/10.acceptable-use',
    ]);
  });

  it('does not mutate the input', () => {
    const input = [
      { stem: 'en/legal/2.terms', path: '/en/legal/2.terms' },
      { stem: 'en/legal/1.privacy', path: '/en/legal/1.privacy' },
    ];
    orderLegalDocumentsByStem(input);
    expect(input.map((item) => item.path)).toEqual(['/en/legal/2.terms', '/en/legal/1.privacy']);
  });
});
