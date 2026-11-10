/**
 * Đọc source như một **tập ký tự**, không như regex.
 *
 * Các spec ở đây khẳng định những bất biến về *code* của app (một `useHead` duy
 * nhất, không có downstream trong `/ready`), nên chúng phải bỏ comment trước
 * khi quét — comment của `ready.get.ts` cố ý nhắc `llm-api` để giải thích vì sao
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

/** Thay nội dung string literal bằng khoảng trắng, giữ nguyên độ dài và vị trí. */
function maskStringContents(source: string): string {
  let result = '';
  let index = 0;

  while (index < source.length) {
    const char = source[index] as string;

    if (char !== '"' && char !== "'" && char !== '`') {
      result += char;
      index += 1;
      continue;
    }

    const quote = char;
    result += char;
    index += 1;

    while (index < source.length) {
      const current = source[index] as string;
      if (current === '\\') {
        result += ' ';
        index += 1;
        result += ' ';
        index += 1;
        continue;
      }
      result += current === quote ? quote : ' ';
      index += 1;
      if (current === quote) {
        break;
      }
    }
  }

  return result;
}

/**
 * Object literal của câu `return { … }` **đầu tiên** trong code đã bỏ comment.
 *
 * String được mask trước khi đếm ngoặc: một dấu `{` trong string literal sẽ làm
 * bộ đếm lệch và cắt sai đoạn mã, khiến assertion sau đó kiểm trên vùng sai mà
 * vẫn xanh.
 */
export function firstReturnedObject(source: string): string {
  const code = stripComments(source);
  const masked = maskStringContents(code);
  const match = /return\s*\{/u.exec(masked);

  if (match === null) {
    return '';
  }

  const start = masked.indexOf('{', match.index);
  let depth = 0;

  for (let index = start; index < masked.length; index += 1) {
    if (masked[index] === '{') {
      depth += 1;
    } else if (masked[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return code.slice(start, index + 1);
      }
    }
  }

  return '';
}
