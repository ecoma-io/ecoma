/**
 * Chuẩn hoá request trước khi tính fingerprint (FR-002), tầng request-shape của service.
 *
 * Ba hàm ở đây là **một hàm duy nhất cho cả fingerprint và lưu trữ**: cùng một địa chỉ phải ra
 * cùng một chuỗi ở cả hai nơi, và cùng một locale trong request cũng phải ra cùng một chuỗi — vì
 * vậy không có bản chuẩn hoá "chỉ để hiển thị" nào.
 *
 * Thứ tự tầng (FR-003, bảng "Phân tầng validation"): hàm ở đây chạy **trước** rate limit và
 * idempotency và **không biết** template version nào đang active — nên nó chỉ kiểm ngưỡng toàn
 * cục. Validation theo `variables_schema_json` là bước sau, của template version đã chọn, và
 * nằm ở `mail-template-schema.ts`.
 *
 * ⚠️ Ngưỡng toàn cục ở đây là **public API contract do service enforce** — không phải contract
 * library. Với row đã lưu, chúng chỉ được **nới lỏng, không được siết chặt**: siết chặt làm
 * replay của row cũ bị `400` ở bước shape thay vì `200`.
 */

/**
 * Hằng default locale của service (FR-002 bước 1 và FR-003 locale fallback).
 *
 * Đây là **hằng của module**, không phải giá trị đọc từ config: `createMailMessage` vẫn nhận
 * `defaultLocale` tường minh qua config (một giá trị cấu hình theo deploy) nhưng hằng này là
 * **fallback cuối cùng** của {@link normalizeLocale} — khi không truyền locale, dùng hằng này
 * để canonical form luôn xác định, không phụ thuộc việc caller có truyền config hay không.
 */
export const MAIL_DEFAULT_LOCALE = 'en';

/**
 * BCP-47 ngắn — **ràng buộc syntax**, không phải kiểm tra region subtag có tồn tại thật hay
 * không (FR-002 bước 4): mục đích là chặn chuỗi bất thường vào canonical form.
 */
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;

/** ASCII control character: U+0000–U+001F và U+007F (FR-002 bước 2). */
// oxlint-disable-next-line no-control-regex -- FR-002/FR-003 chốt **đúng** ASCII control character (U+0000–U+001F, U+007F) vào regex: đây là tập ký tự phải bị kiểm, không phải ký tự ngẫu nhiên trong một pattern.
const ASCII_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u;

/**
 * Khai báo global tối thiểu cho `URL` — WHATWG URL parser, có ở **cả** Cloudflare Workers lẫn Node.
 *
 * Chỉ cần `.hostname`: parser tự punycode hoá theo UTS-46 **và** tự lowercase, nên đọc đúng một
 * thuộc tính là đủ — không tự viết punycode, không cần dependency IDN, và cùng một parser chạy ở
 * cả hai runtime nên không có chỗ cho hai cách chuẩn hoá lệch nhau.
 *
 * Khai ở **phạm vi module** (file này là module) nên nó che global chứ không đụng file khác.
 */
declare const URL: {
  new (url: string, base?: string): { readonly hostname: string };
};

/**
 * Ký tự whitespace mà FR-002 bước 1 chốt cho trim: **space, tab, CR, LF** — đúng bốn, không
 * phải `String#trim()` của ECMAScript — bản đó cắt **nhiều hơn**: NBSP, LINE SEPARATOR và
 * cả những ký tự Unicode whitespace khác mà FR-002 không liệt kê.
 *
 * Dùng tập cứng này là để hai bên chuẩn hoá cho ra **cùng một chuỗi**; `trim()` của runtime thì
 * rộng hơn và có thể khác giữa các engine.
 *
 * ⚠️ Trim chạy bằng **vòng lặp `charCodeAt` hai đầu**, không phải regex
 * `/^[ \t\r\n]+|[ \t\r\n]+$/gu`. Trong một pattern alternation "neo hai đầu", nhánh `$` được
 * `replace` thử lại từ **mỗi vị trí** bên trong một run whitespace bị chặn giữa hai ký tự
 * thường (vd. `a` + `\t`×n + `b`): mỗi lần thử greedy-consume run rồi fail tại `$` —
 * backtracking bậc hai O(n²), CodeQL `js/polynomial-redos`. Chia thành hai replace
 * `/^[ \t\r\n]+/` + `/[ \t\r\n]+$/` **không** chữa được: nhánh có `$` vẫn bị quét từ mỗi
 * vị trí (đã đo: ~3 s với n=100.000). Vòng lặp dưới đây là O(n) chắc chắn vì nó chỉ đi qua
 * mỗi ký tự đúng một lần, và ngữ nghĩa trim đúng bốn ký tự không đổi.
 */
function isTrimmableWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a;
}

function trimTrimmable(raw: string): string {
  let start = 0;
  let end = raw.length;

  while (start < end && isTrimmableWhitespace(raw.charCodeAt(start))) {
    start += 1;
  }

  while (end > start && isTrimmableWhitespace(raw.charCodeAt(end - 1))) {
    end -= 1;
  }

  return raw.slice(start, end);
}

/** Số key tối đa của `variables` ở tầng shape (FR-003, bảng "Phân tầng validation"). */
export const MAIL_VARIABLES_MAX_KEYS = 50;

/** Pattern của một key biến (FR-002 AC): `^[a-zA-Z0-9_]{1,64}$`. */
export const MAIL_VARIABLES_KEY_PATTERN = /^[a-zA-Z0-9_]{1,64}$/u;

/** Độ dài tối đa một chuỗi trong `variables`, tính bằng **UTF-16 code unit** (`String#length`). */
export const MAIL_VARIABLES_MAX_STRING_LENGTH = 10_000;

/** Kết quả chuẩn hoá `recipient` — chỉ mang lý do từ chối, không mang giá trị từ chối. */
export type NormalizeRecipientResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'invalid_recipient' };

/** Kết quả chuẩn hoá `locale`. */
export type NormalizeLocaleResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'invalid_locale' };

/** Kết quả kiểm shape của `variables` — mọi từ chối đều ra cùng một mã `invalid_request`. */
export type ValidateRequestShapeVariablesResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid_request' };

/**
 * Chuẩn hoá `recipient` (FR-002, mục "Chuẩn hoá `recipient`").
 *
 * Bốn bước đã chốt, không thêm bước ngầm:
 *
 * 1. Trim **space/tab/CR/LF** hai đầu.
 * 2. Từ chối nếu rỗng sau trim, không có **đúng một** `@`, **mỗi phía của `@` rỗng**, hoặc chứa
 *    ASCII control character (U+0000–U+001F, U+007F).
 * 3. Domain (sau `@` cuối) → **A-label punycode** rồi **lowercase** (IDN chuyển trước, lowercase
 *    sau — đúng thứ tự FR-002 chốt).
 * 4. Local-part (trước `@` cuối) giữ **nguyên bản**, phân biệt hoa/thường theo RFC 5321 §2.3.11.
 *
 * KHÔNG strip dot, KHÔNG strip plus-tag, KHÔNG áp rule riêng của provider: `An@example.com` và
 * `an@example.com` là **hai** giá trị recipient khác nhau (đánh đổi được chọn có chủ đích — hậu
 * quả tệ nhất là gửi dư, không phải dedupe sai).
 */
export function normalizeRecipient(raw: string): NormalizeRecipientResult {
  const trimmed = trimTrimmable(raw);

  if (
    trimmed === '' ||
    ASCII_CONTROL_PATTERN.test(trimmed) ||
    countOccurrences(trimmed, '@') !== 1
  ) {
    return { ok: false, reason: 'invalid_recipient' };
  }

  const separatorIndex = trimmed.indexOf('@');
  const localPart = trimmed.slice(0, separatorIndex);
  const domain = trimmed.slice(separatorIndex + 1);

  // `@example.com` và `user@` đều bị từ chối: mỗi phía của `@` phải khác rỗng.
  if (localPart === '' || domain === '') {
    return { ok: false, reason: 'invalid_recipient' };
  }

  const asciiDomain = domainToAscii(domain);

  if (asciiDomain === null) {
    return { ok: false, reason: 'invalid_recipient' };
  }

  return { ok: true, value: `${localPart}@${asciiDomain.toLowerCase()}` };
}

/**
 * Chuẩn hoá `locale` (FR-002, mục "Chuẩn hoá `locale`").
 *
 * 1. Không truyền (hoặc rỗng sau trim) → {@link MAIL_DEFAULT_LOCALE}.
 * 2. Trim whitespace hai đầu.
 * 3. Lowercase toàn bộ (`en-US` → `en-us`) — ngữ cảnh v1 chỉ tra template theo `(name, locale)`
 *    key chính xác lowercase nên không mất match nào.
 * 4. Từ chối nếu không khớp {@link LOCALE_PATTERN}.
 */
export function normalizeLocale(raw: string | undefined): NormalizeLocaleResult {
  if (raw === undefined) {
    return { ok: true, value: MAIL_DEFAULT_LOCALE };
  }

  const trimmed = trimTrimmable(raw).toLowerCase();

  if (trimmed === '') {
    return { ok: true, value: MAIL_DEFAULT_LOCALE };
  }

  if (!LOCALE_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'invalid_locale' };
  }

  return { ok: true, value: trimmed };
}

/**
 * Kiểm shape của `variables` ở tầng service (FR-001 bước 3 / FR-003 bảng "Phân tầng validation").
 *
 * Ngưỡng toàn cục, **không biết** template version nào đang active: ≤ {@link MAIL_VARIABLES_MAX_KEYS}
 * key, mỗi key khớp {@link MAIL_VARIABLES_KEY_PATTERN}, mỗi value là **JSON scalar**
 * (`string`/`number`/`boolean`/`null`; object/array bị từ chối), chuỗi ≤
 * {@link MAIL_VARIABLES_MAX_STRING_LENGTH} UTF-16 code unit.
 *
 * `null` **đi qua** tầng này để schema của version quyết định (`nullable`); `NaN`/`±Infinity`
 * bị chặn vì chúng không canonicalize được (FR-002: không serialize thành `null`). Mọi từ chối đều
 * ra `invalid_request` — không phân biệt loại lỗi cho caller.
 */
export function validateRequestShapeVariables(
  variables: Record<string, unknown>,
): ValidateRequestShapeVariablesResult {
  const keys = Object.keys(variables);

  if (keys.length > MAIL_VARIABLES_MAX_KEYS) {
    return { ok: false, reason: 'invalid_request' };
  }

  for (const key of keys) {
    if (!MAIL_VARIABLES_KEY_PATTERN.test(key)) {
      return { ok: false, reason: 'invalid_request' };
    }

    if (!isJsonScalar(variables[key])) {
      return { ok: false, reason: 'invalid_request' };
    }

    const value = variables[key];

    if (typeof value === 'string' && value.length > MAIL_VARIABLES_MAX_STRING_LENGTH) {
      return { ok: false, reason: 'invalid_request' };
    }
  }

  return { ok: true };
}

/**
 * Giá trị có phải **JSON scalar** hợp lệ cho tầng shape không.
 *
 * `NaN`/`±Infinity` là số nhưng **không** JSON-serialize được (`JSON.stringify` hoá chúng thành
 * `null` — chính xác cái fallback FR-002 cấm), nên chúng bị chặn ở đây thay vì để JCS ném.
 */
function isJsonScalar(value: unknown): boolean {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      return value === null;
    default:
      return false;
  }
}

/**
 * Domain → **A-label punycode**.
 *
 * Dùng WHATWG `URL` parser (`new URL('http://<domain>')` rồi đọc `.hostname`): parser này tự
 * punycode theo UTS-46 và tự lowercase, ở giống runtime Workers lẫn Node — nên không cần
 * dependency IDN và không phải tự viết punycode (dễ sai ở các nhãn nhiều ký tự).
 *
 * Trả `null` khi parser ném: domain đó không phải host hợp lệ → người gọi từ chối.
 */
function domainToAscii(domain: string): string | null {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return null;
  }
}

/** Số lần xuất hiện của `needle` trong `haystack` — bản chữ được chốt là "đúng một `@`". */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
}
