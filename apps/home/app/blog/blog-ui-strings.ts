/**
 * UI copy của blogs app, theo locale.
 *
 * Đây là **dictionary cục bộ của app**, không phải i18n framework: blogs chỉ có
 * một nhúm label cố định, và chúng là văn bản UI của riêng blog — không thuộc
 * locale dimension của `app/i18n` (registry đó chỉ sở hữu `code`/`hreflang`),
 * cũng không đủ để biện minh cho một abstraction i18n dùng chung.
 *
 * `Record<PublicLocale, ...>` nên thêm locale vào registry mà thiếu bản dịch là
 * lỗi type ngay tại khai báo — không có fallback im lặng về tiếng Anh. Khoá là
 * tiếng Anh vì chúng định danh vị trí trong UI; giá trị là chuỗi hiển thị đã
 * localized.
 */

import type { PublicLocale } from '../i18n/index';

/** Label UI của blog, đã resolve cho một locale. */
export type BlogUiStrings = {
  /** Tên bề mặt blog — nhãn điều hướng, disclosure mobile và phần title fallback của SEO. */
  readonly blog: string;
  /** Tiêu đề khối article featured trên landing. */
  readonly featured: string;
  /** Tiêu đề khối listing article trên landing. */
  readonly latest: string;
  /** Nhãn "đọc thêm" của card listing. */
  readonly readMore: string;
  /** Nhãn link về blog landing từ article page. */
  readonly allPosts: string;
  /** Nhãn link article trước đó. */
  readonly previous: string;
  /** Nhãn link article kế tiếp. */
  readonly next: string;
  /** Tiêu đề khối related articles. */
  readonly related: string;
  /** Tiêu đề khối footer meta của article (tác giả + ngày). */
  readonly writtenBy: string;
  /**
   * Tên truy cập được của `<nav>` bọc cặp prev/next.
   *
   * Landmark `<nav>` phải có tên phân biệt với các `<nav>` khác trên trang
   * (global nav của shell, locale switcher); thiếu tên thì screen reader chỉ
   * đọc "navigation" mà không nói là điều hướng nào.
   */
  readonly pagination: string;
  /** Danh sách tag của một article — nhãn truy cập được cho vùng tag. */
  readonly tags: string;
  /**
   * Tên truy cập được của scroll container bọc bảng Markdown (`ProseTable`).
   *
   * Container có `role="region"` + focus bằng bàn phím (cuộn ngang bảng rộng
   * hơn cột đọc); region phải có tên phân biệt, và tên theo locale của trang
   * — component resolve qua route vì `ContentRenderer` không truyền props.
   */
  readonly tableRegion: string;
  /** Tên truy cập được của `<nav>` bọc TOC trong article. */
  readonly tableOfContents: string;
  /** Nhãn khối series trên article (ví dụ "Series: LLM foundations"). */
  readonly series: string;
  /** Nhãn điều hướng "bài trước" trong series — phân biệt với pager thời gian. */
  readonly seriesPrevious: string;
  /** Nhãn điều hướng "bài sau" trong series. */
  readonly seriesNext: string;
  /** Tiêu đề khối "trong series này" trên trang series overview. */
  readonly seriesContents: string;
  /**
   * Đơn vị đếm bài viết, đứng sau một số ("5 articles" / "5 bài viết") — dùng
   * cho card series trên landing. Cả hai locale hiện tại không biến cách ở số
   * nhiều nên một chuỗi là đủ; khi một locale cần biến cách, đổi thành hàm
   * nhận count thay vì nhét logic vào template.
   */
  readonly articlesUnit: string;
  /** Nhãn khối prerequisites trên article. */
  readonly prerequisites: string;
  /** Nhãn reviewer hiển thị cạnh tên (ví dụ "Reviewed by"). */
  readonly reviewedBy: string;
  /** Nhãn ngày cập nhật ("Updated") hiển thị cạnh ngày xuất bản. */
  readonly updated: string;
  /**
   * Thông báo của landing fallback — locale hiện tại không có bài, listing là
   * các bài English. Câu văn đầy đủ theo locale thiếu bài (hiện là tiếng Việt).
   */
  readonly fallbackNotice: string;
  /**
   * Nhãn ngắn gắn cạnh một reference resolve về bản **English** (`en` trong
   * locale khác) — "bài này viết bằng tiếng Anh".
   *
   * Vì sao cần nếu landing đã có `fallbackNotice`: thông báo đó nói về **cả
   * landing**, còn đây là từng **link** trên trang article. Người đọc bài
   * tiếng Việt bấm "Cần đọc trước" rồi gặp một trang tiếng Anh không có tín
   * hiệu nào là một bước nhảy im lặng. Nhãn là tiếng Anh vì nó **gọi tên ngôn
   * ngữ của đích**, không phải bản dịch của một nhãn UI tiếng Việt — và trên
   * trang EN nó không bao giờ hiện (`isEnglishFallback` chỉ đặt ở nhánh
   * fallback).
   */
  readonly englishLabel: string;
};

const BLOG_UI_STRINGS: Readonly<Record<PublicLocale, BlogUiStrings>> = Object.freeze({
  en: Object.freeze({
    blog: 'Blog',
    featured: 'Featured',
    latest: 'Latest posts',
    readMore: 'Read more',
    allPosts: 'All posts',
    previous: 'Previous',
    next: 'Next',
    related: 'Related posts',
    writtenBy: 'By',
    pagination: 'Article navigation',
    tags: 'Tags',
    tableRegion: 'Data table',
    tableOfContents: 'On this page',
    series: 'Series',
    seriesPrevious: 'Previous in series',
    seriesNext: 'Next in series',
    seriesContents: 'In this series',
    articlesUnit: 'articles',
    prerequisites: 'Prerequisites',
    reviewedBy: 'Reviewed by',
    updated: 'Updated',
    fallbackNotice:
      'Articles in this locale are not available yet - the posts below are in English.',
    englishLabel: 'in English',
  }),
  vi: Object.freeze({
    blog: 'Blog',
    featured: 'Nổi bật',
    latest: 'Bài mới nhất',
    readMore: 'Đọc tiếp',
    allPosts: 'Tất cả bài viết',
    previous: 'Bài trước',
    next: 'Bài sau',
    related: 'Bài liên quan',
    writtenBy: 'Tác giả',
    pagination: 'Điều hướng bài viết',
    tags: 'Thẻ',
    tableRegion: 'Bảng dữ liệu',
    tableOfContents: 'Trong trang này',
    series: 'Chuỗi bài',
    seriesPrevious: 'Bài trước trong chuỗi',
    seriesNext: 'Bài sau trong chuỗi',
    seriesContents: 'Trong chuỗi này',
    articlesUnit: 'bài viết',
    prerequisites: 'Cần đọc trước',
    reviewedBy: 'Được soát bởi',
    updated: 'Cập nhật',
    fallbackNotice: 'Chưa có bài viết tiếng Việt - các bài dưới đây hiện chỉ có bản tiếng Anh.',
    englishLabel: 'bằng tiếng Anh',
  }),
});

/** Label UI của blog cho một locale. */
export function blogUiStrings(locale: PublicLocale): BlogUiStrings {
  return BLOG_UI_STRINGS[locale];
}
