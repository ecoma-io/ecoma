/**
 * Kiểu dữ liệu dùng chung của lớp parse Markdown trong readme-check.
 *
 * Tách khỏi implementation để spec import kiểu mà không kéo theo runtime của
 * parser, và để `DefinitionInfo` không phải mượn hình dạng của `LinkInfo` chỉ vì
 * cả hai đều có "đích" — definition là declaration, không phải link.
 */

/** Heading đã gọn về thứ checker cần: depth, text hiển thị, dòng bắt đầu. */
export interface HeadingInfo {
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  /** Text hiển thị của heading (đã bỏ markup inline), chưa trim. */
  text: string;
  /** Dòng 1-based của dòng đầu tiên của heading (setext chiếm hai dòng). */
  line: number;
  /** Dòng 1-based của dòng cuối cùng của heading. */
  endLine: number;
}

/** Hình thức link mà AST nhận diện. */
export type LinkKind = 'link' | 'image' | 'reference';

/** Hình thức reference-style theo CommonMark: full `[t][id]`, collapsed `[t][]`, shortcut `[t]`. */
export type ReferenceType = 'full' | 'collapsed' | 'shortcut';

/** Link hoặc image mà GitHub sẽ render — ứng viên để resolve. */
export interface LinkInfo {
  kind: LinkKind;
  /**
   * Đích thô chưa decode: URL của link/image, hoặc identifier của reference.
   * Với `reference`, đích thật nằm trong definition tương ứng — người gọi tra
   * qua `definitions`.
   */
  target: string;
  /** Text hiển thị (alt của image), đã bỏ markup inline. */
  text: string;
  /** Dòng 1-based nơi link bắt đầu. */
  line: number;
  /**
   * Chỉ có trên `kind: 'reference'`. Shortcut reference KHÔNG có definition
   * không phải link — GitHub render nó thành văn bản thường — nên checker chỉ
   * báo "reference không có definition" với `full`/`collapsed`.
   */
  referenceType?: ReferenceType;
}

/** Đích mà một link-reference definition khai báo. */
export interface DefinitionInfo {
  /** Đích thô chưa decode của definition. */
  target: string;
  /** Dòng 1-based nơi definition đứng. */
  line: number;
}

/** Một cú pháp parser không diễn giải được cho việc extract link — phải thành finding cứng. */
export interface UnsupportedConstruct {
  /** Dòng 1-based nơi construct xuất hiện. */
  line: number;
  /** Mô tả construct, tiếng Anh, cho message của finding. */
  detail: string;
}

/** Kết quả parse một tài liệu Markdown cho mọi lượt kiểm phía sau. */
export interface ParsedMarkdown {
  headings: HeadingInfo[];
  links: LinkInfo[];
  /** Definition theo identifier đã chuẩn hóa (lowercase); definition đầu tiên thắng. */
  definitions: ReadonlyMap<string, DefinitionInfo>;
  unsupported: UnsupportedConstruct[];
}
