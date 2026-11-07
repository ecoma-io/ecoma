// Import tường minh từ `vitest` (không dựa vào global): spec nằm dưới `app/**`
// nên Nuxt đưa nó vào `.nuxt/tsconfig.app.json` — tsconfig đó khai báo
// `types: []`, nên global của vitest không có mặt lúc typecheck. Đây cũng là
// convention sẵn có cho spec trong `apps/**`.
import { describe, expect, it } from 'vitest';
import type { ContentNavigationItem } from '@nuxt/content';
import { getSectionCards, getSidebarItems } from './docs-navigation';

/** Cây navigation chuẩn như `queryCollectionNavigation` trả về: `[locale] → [docs] → [sections]`. */
function navTree(
  locale: string,
  sections: Array<{ path: string; title: string; children?: ContentNavigationItem[] }>,
): ContentNavigationItem[] {
  return [
    {
      title: locale === 'en' ? 'En' : 'Vi',
      path: `/${locale}`,
      children: [
        {
          title: 'Overview',
          path: `/${locale}/docs`,
          children: [
            // Nuxt Content đưa chính index page vào children[0] (path trùng node).
            { title: 'Overview', path: `/${locale}/docs` },
            ...sections,
          ],
        },
      ],
    },
  ];
}

const enTree = navTree('en', [
  {
    title: 'Getting Started',
    path: '/en/docs/getting-started',
    children: [
      { title: 'Getting Started', path: '/en/docs/getting-started' },
      { title: 'First Steps', path: '/en/docs/getting-started/first-steps' },
      { title: 'Installation', path: '/en/docs/getting-started/installation' },
    ],
  },
  {
    title: 'Concepts',
    path: '/en/docs/concepts',
    children: [
      { title: 'Concepts', path: '/en/docs/concepts' },
      { title: 'Public Web', path: '/en/docs/concepts/public-web' },
    ],
  },
]);

describe('getSidebarItems', () => {
  it('re-roots the docs node and drops the locale node', () => {
    const items = getSidebarItems('en', enTree);
    expect(items.map((item) => item.path)).toEqual([
      '/en/docs',
      '/en/docs/getting-started',
      '/en/docs/concepts',
    ]);
  });

  it('keeps sections but not the duplicate index child', () => {
    const items = getSidebarItems('en', enTree);
    expect(items.find((item) => item.path === '/en/docs/getting-started')?.title).toBe(
      'Getting Started',
    );
    expect(
      items.find((item) => item.path === '/en/docs/getting-started')?.children?.map((c) => c.path),
    ).toEqual(['/en/docs/getting-started/first-steps', '/en/docs/getting-started/installation']);
  });

  it('never leaks a section from another locale', () => {
    const viTree = navTree('vi', [
      {
        title: 'Bắt đầu',
        path: '/vi/docs/getting-started',
        children: [{ title: 'Bắt đầu', path: '/vi/docs/getting-started' }],
      },
    ]);
    const enItems = getSidebarItems('en', enTree);
    // Cây VI không có mặt trong nav EN; và khi dùng cây VI thì toàn bộ path ở miền /vi.
    expect(enItems.every((item) => item.path.startsWith('/en/'))).toBe(true);
    expect(getSidebarItems('vi', viTree).every((item) => item.path.startsWith('/vi/'))).toBe(true);
  });

  it('returns empty for a tree without the docs root', () => {
    expect(getSidebarItems('en', [])).toEqual([]);
  });
});

describe('getSectionCards', () => {
  it('builds one card per section with entries, excluding the current landing', () => {
    const cards = getSectionCards(getSidebarItems('en', enTree), '/en/docs', {});
    expect(cards.map((card) => card.path)).toEqual([
      '/en/docs/getting-started',
      '/en/docs/concepts',
    ]);
    expect(cards[0]?.entries.map((entry) => entry.path)).toEqual([
      '/en/docs/getting-started/first-steps',
      '/en/docs/getting-started/installation',
    ]);
  });

  it('pulls section descriptions from the content-derived map', () => {
    const cards = getSectionCards(getSidebarItems('en', enTree), '/en/docs', {
      '/en/docs/getting-started': 'A section about getting started.',
    });
    expect(cards[0]?.description).toBe('A section about getting started.');
    expect(cards[1]?.description).toBe('');
  });

  it('never mixes entry links with the section index itself', () => {
    const cards = getSectionCards(getSidebarItems('en', enTree), '/en/docs', {});
    for (const card of cards) {
      expect(card.entries.every((entry) => entry.path !== card.path)).toBe(true);
    }
  });

  it('normalizes a raw tree itself: drops the self-child index even without getDocsRootNavigation', () => {
    // `getSectionCards` nhận `navigation` thô từ caller: không được giả định
    // ai đó đã chuẩn hoá — index page trùng path với section phải bị loại tại
    // đây, còn children thật thì giữ nguyên.
    const rawSections: ContentNavigationItem[] = [
      {
        title: 'Getting Started',
        path: '/en/docs/getting-started',
        children: [
          { title: 'Getting Started', path: '/en/docs/getting-started' },
          { title: 'Installation', path: '/en/docs/getting-started/installation' },
        ],
      },
    ];
    const cards = getSectionCards(rawSections, '/en/docs', {});

    expect(cards).toHaveLength(1);
    expect(cards[0]?.entries.map((entry) => entry.path)).toEqual([
      '/en/docs/getting-started/installation',
    ]);
  });
});
