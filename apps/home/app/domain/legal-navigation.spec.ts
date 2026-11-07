import { describe, expect, it } from 'vitest';

import { buildLegalSidebar, legalBreadcrumbs } from './legal-navigation';
import type { LegalDocumentRecord } from './legal-collection';

/**
 * Unit test cho điều hướng Legal — sidebar và breadcrumb dựng từ grouped
 * listing của route. Cùng pattern với `legal-collection.spec.ts`: data tĩnh,
 * không Nuxt runtime, không SQLite.
 *
 * Trọng tâm là các bất biến mà UI không thể tự bảo vệ: thứ tự nhóm, URL
 * canonical, việc không bao giờ bật hai mắt `current` cùng lúc, và việc
 * breadcrumb không trỏ sang locale khác.
 */

const POLICY_EN = {
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
} as const satisfies LegalDocumentRecord;

const PAYMENT_EN = {
  ...POLICY_EN,
  path: '/en/legal/payment',
  slug: 'payment',
  title: 'Payment Policy — ecoma.io',
} as const satisfies LegalDocumentRecord;

const TERMS_EN = {
  ...POLICY_EN,
  path: '/en/legal/terms',
  slug: 'terms',
  title: 'Terms of Service — ecoma.io',
  category: 'terms',
} as const satisfies LegalDocumentRecord;

const POLICY_VI = {
  ...POLICY_EN,
  path: '/vi/legal/privacy',
  locale: 'vi',
  title: 'Chính sách bảo mật — ecoma.io',
} as const satisfies LegalDocumentRecord;

/** Input mặc định — mỗi test chỉ ghi đè phần nó đang kiểm tra. */
function sidebarInput(overrides: {
  readonly currentPath: string;
  readonly legalRootPath?: string | undefined;
  readonly legalRootTitle?: string;
  readonly categoryOrder?: readonly ('policy' | 'terms')[];
  readonly grouped?: Parameters<typeof buildLegalSidebar>[0]['grouped'];
}) {
  return {
    legalRootPath: 'legalRootPath' in overrides ? overrides.legalRootPath : '/en/legal',
    currentPath: overrides.currentPath,
    legalRootTitle: overrides.legalRootTitle ?? 'Legal Center',
    categoryOrder: overrides.categoryOrder ?? (['policy', 'terms'] as const),
    categoryLabels: { policy: 'Policies', terms: 'Terms' },
    grouped: overrides.grouped ?? { policy: [POLICY_EN, PAYMENT_EN], terms: [TERMS_EN] },
  };
}

/** Mắt `Overview` — `null` khi route không resolve được landing path. */
function overviewOf(sidebar: ReturnType<typeof buildLegalSidebar>) {
  if (sidebar.overview === null) {
    throw new Error('expected an Overview entry');
  }
  return sidebar.overview;
}

describe('buildLegalSidebar', () => {
  it('puts Overview first, then every category in declared order', () => {
    const sidebar = buildLegalSidebar(sidebarInput({ currentPath: '/en/legal' }));
    expect(overviewOf(sidebar).path).toBe('/en/legal');
    expect(sidebar.groups.map((group) => group.category)).toEqual(['policy', 'terms']);
    expect(sidebar.groups.map((group) => group.title)).toEqual(['Policies', 'Terms']);
  });

  it('honours a reordered category list without regrouping the documents', () => {
    // Thứ tự nhóm là input của route (`legalCategoryOrder()`), không phải hằng
    // bên trong hàm: đổi thứ tự hiển thị chỉ phải đổi input.
    const sidebar = buildLegalSidebar(
      sidebarInput({ currentPath: '/en/legal', categoryOrder: ['terms', 'policy'] }),
    );
    expect(sidebar.groups.map((group) => group.category)).toEqual(['terms', 'policy']);
  });

  it('keeps listing order inside a group instead of re-sorting', () => {
    // Thứ tự trong nhóm là thứ tự editorial của seed (stem ASC). Hàm không
    // `sort` lại: sắp xếp ở đây là thứ tự đến từ query, không phải quyết định
    // của tầng UI.
    const sidebar = buildLegalSidebar(
      sidebarInput({
        currentPath: '/en/legal',
        grouped: { policy: [PAYMENT_EN, POLICY_EN], terms: [] },
      }),
    );
    expect(sidebar.groups[0]?.documents.map((document) => document.title)).toEqual([
      'Payment Policy — ecoma.io',
      'Privacy Policy — ecoma.io',
    ]);
  });

  it('links each entry to the document path verbatim', () => {
    // URL lấy thẳng từ `document.path` (path collection khớp thẳng public URL)
    // — không dựng lại từ slug, nên không có registry thứ hai để lệch.
    const sidebar = buildLegalSidebar(sidebarInput({ currentPath: '/en/legal' }));
    expect(sidebar.groups.flatMap((group) => group.documents.map((d) => d.path))).toEqual([
      '/en/legal/privacy',
      '/en/legal/payment',
      '/en/legal/terms',
    ]);
  });

  it('marks Overview current on the landing and nothing else', () => {
    const sidebar = buildLegalSidebar(sidebarInput({ currentPath: '/en/legal' }));
    expect(overviewOf(sidebar).current).toBe(true);
    const marked = sidebar.groups
      .flatMap((group) => group.documents)
      .filter((document) => document.current);
    expect(marked).toEqual([]);
  });

  it('marks exactly one document current on a detail page', () => {
    const sidebar = buildLegalSidebar(sidebarInput({ currentPath: '/en/legal/payment' }));
    expect(overviewOf(sidebar).current).toBe(false);
    const marked = sidebar.groups
      .flatMap((group) => group.documents)
      .filter((document) => document.current);
    expect(marked.map((document) => document.path)).toEqual(['/en/legal/payment']);
  });

  it('marks no document current when the path matches nothing in the listing', () => {
    // Không có mắt nào bật `current` thay vì bật bừa: một path lạ (ví dụ qua
    // client-side transition tới trang bị gate) không được giả làm trang hiện tại.
    const sidebar = buildLegalSidebar(sidebarInput({ currentPath: '/en/legal/unknown' }));
    expect(overviewOf(sidebar).current).toBe(false);
    expect(
      sidebar.groups.flatMap((group) => group.documents).filter((document) => document.current),
    ).toEqual([]);
  });

  it('keeps an empty category as a heading instead of dropping it', () => {
    // Nhóm rỗng vẫn được render: người đọc biết Legal Center có nhóm đó nhưng
    // chưa có văn bản nào, thay vì tưởng nhóm không tồn tại.
    const sidebar = buildLegalSidebar(
      sidebarInput({
        currentPath: '/en/legal',
        grouped: { policy: [POLICY_EN], terms: [] },
      }),
    );
    expect(sidebar.groups).toHaveLength(2);
    expect(sidebar.groups[1]?.category).toBe('terms');
    expect(sidebar.groups[1]?.documents).toEqual([]);
  });

  it('never links across locales when the listing is one locale', () => {
    // Route truyền listing đã lọc theo locale; hàm không tự thêm link chéo
    // locale — locale switcher là đường duy nhất sang locale khác, và nó chỉ
    // quảng bá locale có bản dịch thật.
    const sidebar = buildLegalSidebar(
      sidebarInput({
        currentPath: '/vi/legal',
        legalRootPath: '/vi/legal',
        legalRootTitle: 'Trung tâm Pháp lý',
        grouped: { policy: [POLICY_VI], terms: [] },
      }),
    );
    expect(overviewOf(sidebar).path).toBe('/vi/legal');
    expect(
      sidebar.groups.flatMap((group) => group.documents).map((document) => document.path),
    ).toEqual(['/vi/legal/privacy']);
    expect(overviewOf(sidebar).current).toBe(true);
  });
});

describe('legalBreadcrumbs', () => {
  it('links the landing then ends at the current document', () => {
    const crumbs = legalBreadcrumbs({
      legalRootPath: '/en/legal',
      legalRootTitle: 'Legal Center',
      current: PAYMENT_EN,
    });
    expect(crumbs).toEqual([
      { path: '/en/legal', title: 'Legal Center' },
      { path: '/en/legal/payment', title: 'Payment Policy — ecoma.io' },
    ]);
  });

  it('keeps both crumbs in the document locale', () => {
    // Cả hai mắt là URL thật của bề mặt đang đọc: breadcrumb không trỏ sang
    // locale khác (lập luận với `buildDocsBreadcrumbs` của docs).
    const crumbs = legalBreadcrumbs({
      legalRootPath: '/vi/legal',
      legalRootTitle: 'Trung tâm Pháp lý',
      current: POLICY_VI,
    });
    expect(crumbs.every((crumb) => crumb.path.startsWith('/vi/'))).toBe(true);
  });

  it('never repeats a path when the landing is also the current document', () => {
    // Không xảy ra với dữ liệu thật (landing không phải document), nhưng nếu
    // input sai thì hai mắt trùng path sẽ tạo hai link cùng đích — cùng dạng
    // lỗi mà `buildDocsBreadcrumbs` chặn. Khẳng định **số mắt** chứ không chỉ
    // số path khác nhau: hai mắt cùng `/en/legal` vẫn là hai link cùng đích và
    // vẫn sinh key trùng ở `v-for` của `PublicBreadcrumbs`.
    const crumbs = legalBreadcrumbs({
      legalRootPath: '/en/legal',
      legalRootTitle: 'Legal Center',
      current: { ...POLICY_EN, path: '/en/legal' },
    });
    expect(crumbs).toEqual([{ path: '/en/legal', title: 'Privacy Policy — ecoma.io' }]);
  });

  it('keeps only the current page when the landing path is unresolvable', () => {
    // `legalRootPath` là `undefined` khi builder không trả `localized`: thay vì
    // dựng link tới một URL không tin được, bỏ hẳn mắt tổ tiên.
    const crumbs = legalBreadcrumbs({
      legalRootPath: undefined,
      legalRootTitle: 'Legal Center',
      current: PAYMENT_EN,
    });
    expect(crumbs).toEqual([{ path: '/en/legal/payment', title: 'Payment Policy — ecoma.io' }]);
  });
});

describe('unresolvable landing path', () => {
  // Route truyền `legalRootPath: undefined` khi `buildPublicPath` không trả
  // `localized`. Cả hai hàm phải degrade thay vì dựng link sai — cùng cách
  // `buildDocsBreadcrumbs` xử lý `docsRootPath` rỗng.

  it('drops the Overview entry rather than linking an unverified URL', () => {
    const sidebar = buildLegalSidebar(
      sidebarInput({ currentPath: '/en/legal/payment', legalRootPath: undefined }),
    );
    expect(sidebar.overview).toBeNull();
    // Nhóm văn bản vẫn còn nguyên — mất anchor tổng quan không được mất đường
    // điều hướng tới chính các văn bản.
    expect(
      sidebar.groups.flatMap((group) => group.documents.map((document) => document.path)),
    ).toEqual(['/en/legal/privacy', '/en/legal/payment', '/en/legal/terms']);
  });

  it('never marks both Overview and a document current', () => {
    // Đây là invariant mà JSDoc của hàm từng khẳng định nhưng chỉ nhờ kỷ luật
    // của caller. Khiến `legalRootPath` trùng **path của văn bản đang đọc**
    // thì trước đây cả hai mắt cùng bật → hai `aria-current="page"` trong một
    // `<nav>`, và `Overview` lại trỏ về chính trang đang đọc.
    const sidebar = buildLegalSidebar(
      sidebarInput({
        currentPath: '/en/legal/privacy',
        legalRootPath: '/en/legal/privacy',
      }),
    );
    // Mắt văn bản thắng: đúng một `aria-current`, và nó là văn bản đang đọc.
    const marked = sidebar.groups
      .flatMap((group) => group.documents)
      .filter((document) => document.current);
    expect(marked.map((document) => document.path)).toEqual(['/en/legal/privacy']);
    expect(sidebar.overview?.current).toBe(false);
  });
});
