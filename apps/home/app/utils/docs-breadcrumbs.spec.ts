import { describe, expect, it } from 'vitest';
import type { ContentNavigationItem } from '@nuxt/content';
import { buildDocsBreadcrumbs } from './docs-breadcrumbs';

function crumb(path: string, title: string): ContentNavigationItem {
  return { title, path };
}

describe('docs breadcrumbs', () => {
  it('seeds the docs root, keeps ancestors in order and ends on the current page', () => {
    const result = buildDocsBreadcrumbs({
      docsRootPath: '/en/docs',
      docsRootTitle: 'Documentation',
      ancestorCrumbs: [
        crumb('/en', 'En'),
        crumb('/en/docs', 'Overview'),
        crumb('/en/docs/getting-started', 'Getting Started'),
      ],
      currentPath: '/en/docs/getting-started/installation',
      currentTitle: 'Installation',
    });

    expect(result).toEqual([
      { path: '/en/docs', title: 'Documentation' },
      { path: '/en/docs/getting-started', title: 'Getting Started' },
      { path: '/en/docs/getting-started/installation', title: 'Installation' },
    ]);
  });

  it('drops the synthetic locale-root crumb so no breadcrumb links to /en', () => {
    // `findPageBreadcrumb` của Nuxt Content chèn node gốc cho locale-root;
    // `/en` không phải route tồn tại trong app này nên link đó sẽ 404.
    const result = buildDocsBreadcrumbs({
      docsRootPath: '/en/docs',
      docsRootTitle: 'Documentation',
      ancestorCrumbs: [crumb('/en', 'En')],
      currentPath: '/en/docs/concepts',
      currentTitle: 'Concepts',
    });

    expect(result.map((entry) => entry.path)).not.toContain('/en');
    expect(result).toEqual([
      { path: '/en/docs', title: 'Documentation' },
      { path: '/en/docs/concepts', title: 'Concepts' },
    ]);
  });

  it('never mixes locales: a vi page never shows en crumbs', () => {
    const result = buildDocsBreadcrumbs({
      docsRootPath: '/vi/docs',
      docsRootTitle: 'Tài liệu',
      // Cây navigation được lọc theo locale ở tầng query, nhưng test này pin
      // thêm một lớp bảo vệ: crumb của locale khác bị loại theo pathname.
      ancestorCrumbs: [crumb('/en/docs/concepts', 'Concepts'), crumb('/vi/docs', 'Tổng quan')],
      currentPath: '/vi/docs/concepts/public-web',
      currentTitle: 'Public Web',
    });

    expect(result.every((entry) => entry.path.startsWith('/vi/'))).toBe(true);
    expect(result).toEqual([
      { path: '/vi/docs', title: 'Tài liệu' },
      { path: '/vi/docs/concepts/public-web', title: 'Public Web' },
    ]);
  });

  it('does not duplicate a crumb whose path matches the current page', () => {
    const result = buildDocsBreadcrumbs({
      docsRootPath: '/en/docs',
      docsRootTitle: 'Documentation',
      ancestorCrumbs: [crumb('/en/docs/concepts', 'Concepts')],
      currentPath: '/en/docs/concepts',
      currentTitle: 'Concepts',
    });

    expect(result).toEqual([
      { path: '/en/docs', title: 'Documentation' },
      { path: '/en/docs/concepts', title: 'Concepts' },
    ]);
  });

  it('does not duplicate the docs root when navigation already contains it', () => {
    const result = buildDocsBreadcrumbs({
      docsRootPath: '/en/docs',
      docsRootTitle: 'Documentation',
      ancestorCrumbs: [crumb('/en/docs', 'Overview')],
      currentPath: '/en/docs/guides',
      currentTitle: 'Guides',
    });

    expect(result).toEqual([
      { path: '/en/docs', title: 'Documentation' },
      { path: '/en/docs/guides', title: 'Guides' },
    ]);
  });

  it('uses the document title for the current page, not the navigation label', () => {
    // Nhãn breadcrumb của page hiện tại lấy từ chính document để luôn khớp
    // tiêu đề trang, kể cả khi `navigation.title` khác `title`.
    const result = buildDocsBreadcrumbs({
      docsRootPath: '/en/docs',
      docsRootTitle: 'Documentation',
      ancestorCrumbs: [crumb('/en/docs/getting-started', 'Getting started (nav)')],
      currentPath: '/en/docs/getting-started',
      currentTitle: 'Getting Started',
    });

    expect(result.at(-1)).toEqual({
      path: '/en/docs/getting-started',
      title: 'Getting Started',
    });
  });

  it('still ends on the current page when the docs root is unavailable', () => {
    const result = buildDocsBreadcrumbs({
      docsRootPath: undefined,
      docsRootTitle: 'Documentation',
      ancestorCrumbs: [],
      currentPath: '/en/docs/unknown',
      currentTitle: 'Unknown',
    });

    expect(result).toEqual([{ path: '/en/docs/unknown', title: 'Unknown' }]);
  });

  it('keeps only the current page when the docs root is unavailable, never leaking the locale-root crumb', () => {
    // Không có `docsRootPath` thì không có anchor cho phép lọc prefix: crumb
    // tuyệt đối nào cũng pass, kể cả locale-root `/en` → link 404. Đúng nhất là
    // bỏ toàn bộ ancestor crumb, giữ page hiện tại (từ document nên tồn tại).
    const result = buildDocsBreadcrumbs({
      docsRootPath: undefined,
      docsRootTitle: 'Documentation',
      ancestorCrumbs: [crumb('/en', 'En'), crumb('/en/docs/getting-started', 'Getting Started')],
      currentPath: '/en/docs/getting-started/installation',
      currentTitle: 'Installation',
    });

    expect(result).toEqual([
      { path: '/en/docs/getting-started/installation', title: 'Installation' },
    ]);
  });
});
