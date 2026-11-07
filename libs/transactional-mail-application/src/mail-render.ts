/**
 * Render `{{ variable }}` từ template + schema của version đã chọn (FR-003).
 *
 * Template **không phải chương trình**: renderer không thực thi template code, không đánh giá
 * biểu thức tùy ý — chỉ thay biến theo schema. Không có partial/include nào nhận giá trị từ
 * request.
 *
 * Ba luật an toàn, mỗi luật một nhánh trả lỗi riêng vì ba nguyên nhân khác nhau về mặt vận
 * hành:
 *
 * - **Placeholder không khai báo trong schema** → `unrenderable_placeholder`, tức fail-closed
 *   `500 internal_error` + alert. Không im lặng thay bằng chuỗi rỗng — đó là seed lỗi lọt ra
 *   ngoài, và thay rỗng sẽ gửi một lá thư thiếu chữ mà không ai biết.
 * - **Subject chứa control character** → `subject_control_character`, tức `400 invalid_request`.
 *   Luật này phải **đứng riêng**: HTML escape không loại bỏ CR/LF, nên chỉ escape không chặn được
 *   header injection.
 * - **Giá trị biến là dữ liệu, không bao giờ là template syntax**: thay **một lượt**; giá trị chứa
 *   `{{ ... }}` không được quét lại.
 */

import type { ParsedTemplateSchema } from './mail-template-schema';

/**
 * Placeholder duy nhất mà renderer hiểu: `{{ variable_name }}`.
 *
 * Cho phép whitespace quanh tên biến nhưng **không** có biểu thức, dấu `.` hay chỉ số — vì vậy
 * một template viết `{{ user.name }}` không render được và sẽ bị seed từ chối.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu;

/** ASCII control character trong context header: U+0000–U+001F và U+007F (FR-003). */
// oxlint-disable-next-line no-control-regex -- FR-002/FR-003 chốt **đúng** ASCII control character (U+0000–U+001F, U+007F) vào regex: đây là tập ký tự phải bị kiểm, không phải ký tự ngẫu nhiên trong một pattern.
const ASCII_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u;

/** Input của {@link renderMail}. */
export interface RenderMailInput {
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
  readonly schema: ParsedTemplateSchema;
  /** Biến đã vượt `validateVariablesAgainstSchema` — chỉ chứa biến có mặt trong request. */
  readonly normalized: ReadonlyMap<string, unknown>;
  /**
   * Hàm escape cho **context subject** do caller truyền vào.
   *
   * Subject đi vào header MIME, không phải HTML: escape kiểu text của nó sẽ biến `Nguyễn` hay
   * `R&D` thành `Nguyễn`/`R&amp;D` trong header — tức đổi nội dung người nhận thấy. Vì vậy
   * context này gọi tới hàm escape **thực sự của mình** (thường là escape HTML để một lá thư
   * multipart vẫn an toàn ở phần HTML), và việc chọn hàm là quyết định của tầng trên chứ không
   * hard-code ở đây.
   */
  readonly htmlEscapeForSubject: (value: string) => string;
}

/** Kết quả render. */
export type RenderMailResult =
  | { readonly ok: true; readonly subject: string; readonly body: string }
  | {
      readonly ok: false;
      readonly reason: 'unrenderable_placeholder' | 'subject_control_character';
    };

/**
 * Render subject + body.
 *
 * Subject: mỗi placeholder thay bằng giá trị đã escape, rồi kiểm lại control character trên
 * **chuỗi đã render** — giá trị biến là nơi chúng đến từ.
 *
 * Body: **single-pass** — quét template một lượt, mỗi placeholder thay **một** lần bằng giá trị đã
 * escape. Giá trị chứa `{{` không được render lần hai: vì phần thay thế không được quét lại, đó là
 * hệ quả của cách làm chứ không phải một điều kiện phải kiểm thêm.
 */
export function renderMail(input: RenderMailInput): RenderMailResult {
  const subject = renderTemplate(input.subjectTemplate, input, input.htmlEscapeForSubject);

  if (subject === null) {
    return { ok: false, reason: 'unrenderable_placeholder' };
  }

  if (ASCII_CONTROL_PATTERN.test(subject)) {
    return { ok: false, reason: 'subject_control_character' };
  }

  const body = renderTemplate(input.bodyTemplate, input, escapeHtmlText);

  if (body === null) {
    return { ok: false, reason: 'unrenderable_placeholder' };
  }

  return { ok: true, subject, body };
}

/**
 * Thay placeholder trong một template; `null` khi có placeholder không khai báo trong schema.
 *
 * Dùng `String#replace` với hàm thay thế: chuỗi thay thế được chèn **nguyên văn**, không được
 * `$`-pattern diễn giải lại — một giá trị chứa `$&` hay `$1` sẽ bị nuốt mất.
 *
 * Escape **theo vị trí** (FR-003 "HTML escape đúng một lần, theo output context"): placeholder
 * nằm ngay trong dấu nháy attribute (`{{ name }}` đứng sau `"` hoặc `'`, cho phép khoảng trắng)
 * được escape bằng `escapeHtmlAttribute` — thêm `"`/`'` — thay vì `escapeHtmlText`. Không có
 * bước này, một giá trị chứa `"` (ví dụ một URL hợp lệ với `"` trong query) thoát khỏi context
 * attribute và inject markup: `<a href="{{ cta_url }}">` với `cta_url` qua được URL validation
 * vẫn sinh `href="https://example.com/" onmouseover="..."`. Phát hiện vị trí bằng dấu nháy
 * **nguyên văn** trong template (template là seed-controlled, đã qua validation riêng), không
 * bằng dấu nháy sinh ra từ placeholder liền kề — so trên đoạn template **gốc**, trước khi
 * placeholder nào được thay.
 */
function renderTemplate(
  template: string,
  input: RenderMailInput,
  escape: (value: string) => string,
): string | null {
  let unrenderable = false;

  const rendered = template.replace(
    PLACEHOLDER_PATTERN,
    (match: string, name: string, offset: number): string => {
      if (!input.schema.has(name)) {
        unrenderable = true;

        return '';
      }

      const escaper = placeholderIsInQuotedAttribute(template, offset, match.length)
        ? escapeHtmlAttribute
        : escape;

      return escaper(stringifyValue(input.normalized.get(name)));
    },
  );

  return unrenderable ? null : rendered;
}

/**
 * Placeholder tại `offset` có đang nằm ngay trong dấu nháy attribute của template hay không.
 *
 * Quét ngược từ `offset` qua khoảng trắng, rồi đòi `"` hoặc `'`; quét tới sau `}}` (độ dài
 * match) qua khoảng trắng rồi đòi dấu nháy đóng. Chỉ dấu nháy **nguyên văn trong template**
 * mới mở context attribute — một giá trị chứa `"` ở placeholder liền trước không tạo được
 * context đó, vì giá trị đã qua escape của placeholder đó rồi.
 *
 * ⚠️ Skip cả **tab, LF, CR, form feed** chứ không chỉ `0x20`: HTML cho phép whitespace giữa
 * dấu nháy và value attribute (`href="{{ url }}\n >"` vẫn là một attribute nguyên vẹn). Chỉ
 * skip `0x20` thì template đó bị coi là context text — giá trị chứa `"` thoát attribute được
 * (bộ test: `treats a placeholder around newline inside a quoted attribute as attribute context`).
 */
function placeholderIsInQuotedAttribute(
  template: string,
  offset: number,
  matchLength = 0,
): boolean {
  let start = offset - 1;

  while (start >= 0 && isAttributeBoundaryWhitespace(template[start])) {
    start -= 1;
  }

  if (start < 0 || (template[start] !== '"' && template[start] !== "'")) {
    return false;
  }

  let end = offset + matchLength;

  while (end < template.length && isAttributeBoundaryWhitespace(template[end])) {
    end += 1;
  }

  return end < template.length && (template[end] === '"' || template[end] === "'");
}

/**
 * Whitespace được phép nằm giữa dấu nháy attribute và value theo HTML: `0x20` cùng các
 * control character cơ bản (`\t`, `\n`, `\r`, form feed `0x0C`). Đây là tập mà parser HTML
 * bỏ qua giữa dấu nháy và value — không phải mọi whitespace Unicode (các ký tự khác trình
 * duyệt không bỏ qua giữa dấu nháy và value).
 */
function isAttributeBoundaryWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\r' ||
    character === '\f'
  );
}

/**
 * Biến thành chuỗi để escape (FR-003):
 *
 * - biến optional **vắng mặt** (không có trong `normalized`) → chuỗi rỗng, không crash.
 * - `null` (biến `nullable: true`) → chuỗi rỗng.
 * - số → `String(number)`, tức `Number::toString` của ECMAScript (`1` → `'1'`, `1.5` → `'1.5'`).
 * - boolean → `'true'`/`'false'`.
 */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

/**
 * Escape context **text** (FR-003): `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.
 *
 * Đúng **một lần** và đúng thứ tự: thay `&` trước, nếu không `&` trong `&lt;` sinh ra sẽ bị escape
 * lần hai thành `&amp;lt;`.
 *
 * KHÔNG escape `"` và `'`: ở context text chúng không mở ngữ cảnh nào, và escape chúng sẽ đổi nội
 * dung người nhận thấy trong text thuần.
 */
export function escapeHtmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/**
 * Escape context **attribute** (FR-003): context text **cộng thêm** `"` → `&quot;` và `'` →
 * `&#39;`.
 *
 * `&#39;` chứ không phải `&apos;` vì `&apos;` không có trong HTML4 và chưa được áp rộng rãi trong
 * mọi trình duyệt.
 */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}
