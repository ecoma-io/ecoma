/**
 * Đọc source như một **tập ký tự**, không như regex.
 *
 * Các spec ở đây khẳng định những bất biến về *code* của app (một `useHead` duy
 * nhất, không có downstream trong `/ready`), nên chúng phải bỏ comment trước
 * khi quét — comment của `ready.get.ts` cố ý nhắc `remote-cache-api` để giải thích vì sao
 * readiness **không** phụ thuộc nó.
 *
 * ⚠️ Không dùng regex `//[^\n]*` để làm việc đó: nó không phân biệt comment với
 * `//` bên trong string literal, nên `'https://…'` bị cắt cụt và mọi khẳng định
 * sau đó chạy trên một đoạn mã đã hỏng — có thể xanh vì lý do sai. Hàm dưới đây
 * quét từng ký tự và **nhảy qua** string/template literal nguyên vẹn; chỉ nội
 * dung comment bị bỏ.
 */

/** Bỏ comment, giữ nguyên nội dung mọi string và template literal. */
export function stripComments(source: string): string {
  let result = '';
  let index = 0;

  while (index < source.length) {
    const char = source[index] as string;

    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      result += char;
      index += 1;

      while (index < source.length) {
        const current = source[index] as string;
        result += current;
        index += 1;

        if (current === '\\') {
          result += source[index] ?? '';
          index += 1;
          continue;
        }
        if (current === quote) {
          break;
        }
      }
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}
