/**
 * Canonical serialization tầng 2 của profile `v1` (FR-002): **RFC 8785 — JSON
 * Canonicalization Scheme (JCS)**, cài đặt tay, không dependency ngoài.
 *
 * ⚠️ Giới hạn đã chốt: profile `v1` của FR-002 **không** phải một chuẩn canonicalization tổng
 * quát. Nó chỉ định nghĩa canonical cho **đúng bốn** trường fingerprint, không bảo đảm canonical
 * cho kiểu dữ liệu ngoài JSON (`Date`, binary, `NaN`) và không thay thế validation schema. Hàm
 * này được tái dùng ở chỗ khác thì phải được tham chiếu như một quyết định độc lập — không
 * được suy ra từ FR-002.
 *
 * Ba điểm JCS đã chốt và dễ sai, mỗi điểm có một đoạn kiểm tương ứng trong `jcs.spec.ts`:
 *
 * 1. **Thứ tự key** — so **UTF-16 code unit**, không theo code point và không theo locale
 *    (`Array#sort` mặc định cũng là UTF-16 code unit, nhưng dùng comparator tường minh để không
 *    phụ thuộc vào đó), và sắp **đệ quy ở mọi cấp**.
 * 2. **Array có thứ tự**, object là tập key — `[1,2] !== [2,1]`.
 * 3. **Số** theo ECMA-262 §7.1.12.1 (IEEE-754 double); `NaN`/`±Infinity` **không** serialize
 *    được nên hàm ném lỗi — validation phải từ chối chúng **trước** khi tính fingerprint, tuyệt
 *    đối không fallback về `null`.
 *
 * Riêng chuỗi: escape tối thiểu, control char U+0000–U+001F dùng `\uhhhh` chữ thường trừ
 * U+0008/0009/000A/000C/000D (`\b \t \n \f \r`), code point khác giữ nguyên trừ `\` và `"` — đó
 * chính xác là `JSON.stringify` trên một chuỗi JS. Surrogate lẻ (invalid Unicode) là **lỗi**
 * theo JCS; ở v1 nó bị chặn sớm hơn ở tầng request-shape (`validateRequestShapeVariables`) và ở
 * tầng schema theo `max_length`, nên nhánh này chỉ là fail-closed chứ không phải luật đã dùng.
 */

/** Chuỗi thoát lỗi nội bộ: chỉ để phân biệt nguyên nhân khi `jcsCanonicalize` ném. */
export class JcsUnsupportedValueError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'JcsUnsupportedValueError';
  }
}

/**
 * Escape chuỗi theo ECMA-262 `JSON.stringify`, tức đúng luật escape chuỗi của JCS.
 *
 * `JSON.stringify` trên một chuỗi luôn trả ra chuỗi JSON hợp lệ (escape `"`, `\`, control char).
 *
 * Surrogate lẻ thì **không**: `JSON.stringify` vẫn trả về nó một cách im lặng, nhưng nó không có
 * biểu diễn UTF-8 hợp lệ — FR-002 yêu cầu từ chối. Kiểm ở đây cho **mọi** chuỗi (value lẫn key).
 */
function canonicalizeString(value: string): string {
  if (hasLoneSurrogate(value)) {
    throw new JcsUnsupportedValueError('lone_surrogate');
  }

  return JSON.stringify(value);
}

/**
 * So hai key theo **UTF-16 code unit**.
 *
 * `a < b` so chuỗi JS, tức cũng là UTF-16 code unit — nhưng comparator tường minh giữ đúng
 * luật khi đọc, và không phụ thuộc vào `Array#sort` mặc định.
 */
function compareKeysByUtf16CodeUnit(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

/**
 * Canonicalize một giá trị JSON theo RFC 8785.
 *
 * @param value Giá trị JSON (`null`, boolean, number hữu hạn, string, array, object thuần).
 * @returns Canonical form — không có whitespace giữa các token.
 * @throws {@link JcsUnsupportedValueError} khi giá trị không canonicalize được: số không hữu
 * hạn, `undefined`/function/symbol, `bigint`, surrogate lẻ trong chuỗi, hay object không thuần
 * (kế thừa `null`, có symbol key, hoặc là `Date`/`Map`/class instance).
 */
export function jcsCanonicalize(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      // FR-002: `NaN`/`±Infinity` không serialize được — ném, không fallback `null`.
      if (!Number.isFinite(value)) {
        throw new JcsUnsupportedValueError('non_finite_number');
      }

      // `JSON.stringify` trên một số hữu hạn chính là biểu diễn ECMA-262 §7.1.12.1 mà JCS chốt.
      return JSON.stringify(value) satisfies string;
    }
    case 'string':
      return canonicalizeString(value);
    default:
      break;
  }

  if (Array.isArray(value)) {
    // Array giữ nguyên thứ tự phần tử — thứ tự là **nghĩa**, không phải hình thức.
    return `[${value.map((element) => jcsCanonicalize(element)).join(',')}]`;
  }

  if (typeof value === 'object') {
    return canonicalizePlainObject(value as Record<string, unknown>);
  }

  throw new JcsUnsupportedValueError(`unsupported_value_type:${typeof value}`);
}

/**
 * Canonicalize object — sort key đệ quy ở mọi cấp.
 *
 * Object **phải** thuần: `Object.prototype` là prototype trực tiếp và không có symbol key.
 * Chấp nhận `undefined`/`function` làm **value** (được bỏ qua như `JSON.stringify` làm) là
 * tiện nhưng làm hàm khó dự đoán với người đọc, nên ở đây mọi giá trị đều phải canonicalize
 * được — thứ bị loại đến từ tầng validation trên, không phải từ profile này.
 */
function canonicalizePlainObject(value: Record<string, unknown>): string {
  if (!isPlainObject(value)) {
    throw new JcsUnsupportedValueError('unsupported_value_type:object');
  }

  // `canonicalizeString` kiểm surrogate lẻ cho **mọi** chuỗi, key của object cũng là chuỗi — nên
  // không cần một nhánh riêng cho key ở đây.
  const entries = Object.keys(value).map((key) => ({
    key,
    canonical: jcsCanonicalize(value[key]),
  }));

  entries.sort((left, right) => compareKeysByUtf16CodeUnit(left.key, right.key));

  return `{${entries.map((entry) => `${canonicalizeString(entry.key)}:${entry.canonical}`).join(',')}}`;
}

/** Object thuần: prototype trực tiếp là `Object.prototype` hoặc `null`. */
function isPlainObject(value: Record<string, unknown>): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * Có surrogate **lẻ** trong chuỗi hay không — tức một code point UTF-16 không ghép đôi được, và
 * do đó không có biểu diễn UTF-8 hợp lệ.
 *
 * ⚠️ `charCodeAt` **ngoài độ dài chuỗi trả `NaN`**, và mọi phép so với `NaN` đều `false` — nên
 * kiểm "code unit kế tiếp có nằm trong `[0xDC00, 0xDFFF]` không" phải viết bằng
 * `Number.isNaN` hoặc bằng so sánh trực tiếp. Viết `next < 0xdc00 || next > 0xdfff` thì một
 * surrogate cao ở **cuối chuỗi** lọt qua im lặng, vì `NaN < 0xdc00` và `NaN > 0xdfff` đều sai.
 */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next: number | undefined =
        index + 1 < value.length ? value.charCodeAt(index + 1) : undefined;

      if (next === undefined || next < 0xdc00 || next > 0xdfff) {
        return true;
      }

      // Cặp surrogate hợp lệ: bỏ qua cả hai.
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}
