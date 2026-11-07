/**
 * Hợp đồng nội dung của `error-pages` — thứ duy nhất consumer truyền vào.
 *
 * Library là **trình trình bày thuần** (pure presenter): mọi chuỗi hiển thị
 * và mọi điểm đến của CTA thuộc về consumer. Library không biết locale
 * (`app/i18n` là chủ sở hữu locale dimension), không biết routing, không
 * biết HTTP status — app quyết định khi nào một lỗi là 404 hay 403 và tự
 * localize nội dung trước khi đưa vào đây.
 *
 * `readonly` ở mọi field: content là dữ liệu tĩnh cho một lần render, không
 * phải mutable state; cấu trúc này cũng bảo đảm render như nhau ở server và
 * client (SSR byte-identical, không hydration dependency).
 */

/** Một hành động CTA hiển thị dạng link (`<a href>`) trên trang lỗi. */
export type ErrorPageAction = {
  /** Nhãn hiển thị của link CTA — đã localize bởi consumer. */
  readonly label: string;
  /**
   * Đích của CTA — pathname (tương đối) hoặc URL tuyệt đối, không bị library
   * kiểm tra hay biến đổi: đích đến là chính sách điều hướng của consumer.
   */
  readonly href: string;
};

/**
 * Nội dung đầy đủ của một trang lỗi.
 *
 * `title` vừa là `<h1>` trên page vừa là chuỗi mà consumer có thể đưa vào
 * `document.title` — library không tự chạm `<head>` (một component UI thuần
 * không có side effect lên document).
 */
export type ErrorPageContent = {
  /** Tiêu đề chính của trang (một `<h1>` duy nhất). */
  readonly title: string;
  /** Đoạn giải thích ngắn dưới tiêu đề. */
  readonly description: string;
  /** Hành động chính — đường về bề mặt an toàn (home, docs landing…). */
  readonly primaryAction: ErrorPageAction;
  /** Hành động phụ, tùy chọn. */
  readonly secondaryAction?: ErrorPageAction;
};
