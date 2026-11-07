/**
 * UI copy của bề mặt legal, theo locale.
 *
 * Cùng pattern với `blog-ui-strings`: dictionary cục bộ của app,
 * `Record<PublicLocale, ...>` nên thêm locale mà thiếu bản dịch là lỗi type
 * ngay tại khai báo. Khoá là tiếng Anh vì chúng định danh vị trí trong UI;
 * giá trị là chuỗi hiển thị đã localized.
 */

import type { PublicLocale } from '../i18n/index';

/** Label UI của Legal Center, đã resolve cho một locale. */
export type LegalUiStrings = {
  /** Tên bề mặt legal — heading landing, link về landing, phần title SEO. */
  readonly legal: string;
  /**
   * Nhãn nhóm `policy` — heading nhóm ở cột chính của landing **và** nhãn nhóm
   * trong sidebar của **cả hai** bề mặt (route truyền qua `categoryLabels`).
   */
  readonly policies: string;
  /**
   * Nhãn nhóm `terms` — heading nhóm ở cột chính của landing **và** nhãn nhóm
   * trong sidebar của **cả hai** bề mặt (route truyền qua `categoryLabels`).
   */
  readonly terms: string;
  /** Nhãn trạng thái draft — badge trên listing lẫn detail. */
  readonly draft: string;
  /** Nhãn trạng thái published — badge trên listing lẫn detail. */
  readonly published: string;
  /** Nhãn review status "chưa qua rà soát pháp lý". */
  readonly unreviewed: string;
  /** Nhãn version + effective date trên detail — phần "Version 1.0 · Effective 2026-01-01". */
  readonly version: string;
  readonly effective: string;
  /** Nhãn khối related documents. */
  readonly related: string;
  /**
   * Tên truy cập được của `<nav>` sidebar điều hướng văn bản.
   *
   * Phải **khác** `breadcrumbs` và khác global nav của shell: breadcrumb và
   * sidebar là hai landmark `<nav>` cùng tồn tại trên một trang, dùng chung một
   * chuỗi thì screen reader đọc hai mục giống hệt nhau và người dùng không
   * phân biệt được đâu là đường dẫn, đâu là cây điều hướng (cùng lập luận với
   * `documentation`/`breadcrumbs` của docs).
   */
  readonly navigation: string;
  /**
   * Tên truy cập được của `<nav>` breadcrumb — khác `navigation` (xem trên).
   */
  readonly breadcrumbs: string;
};

const LEGAL_UI_STRINGS: Readonly<Record<PublicLocale, LegalUiStrings>> = Object.freeze({
  en: Object.freeze({
    legal: 'Legal Center',
    policies: 'Policies',
    terms: 'Terms',
    draft: 'Draft',
    published: 'Published',
    unreviewed: 'Not legally reviewed',
    version: 'Version',
    effective: 'Effective',
    related: 'Related documents',
    navigation: 'Legal documents',
    breadcrumbs: 'Legal breadcrumbs',
  }),
  vi: Object.freeze({
    legal: 'Trung tâm Pháp lý',
    policies: 'Chính sách',
    terms: 'Điều khoản',
    draft: 'Bản nháp',
    published: 'Đã xuất bản',
    unreviewed: 'Chưa qua rà soát pháp lý',
    version: 'Phiên bản',
    effective: 'Có hiệu lực',
    related: 'Văn bản liên quan',
    navigation: 'Văn bản pháp lý',
    breadcrumbs: 'Đường dẫn pháp lý',
  }),
});

/** Resolve UI copy của legal cho một locale. */
export function legalUiStrings(locale: PublicLocale): LegalUiStrings {
  return LEGAL_UI_STRINGS[locale];
}
