/**
 * Helper đọc wrangler.jsonc cho spec hợp đồng config — JSONC (comment +
 * trailing comma) không parse được bằng JSON.parse thuần, và repo không có
 * thư viện JSONC nào trong scope import của deploy project. Strip tối giản,
 * đủ cho wrangler.jsonc: line comment `//`, block comment kiểu slash-star,
 * và trailing comma trước `}`/`]` — scan từng ký tự, luôn nhận diện chuỗi
 * (escape `\"`) để comment marker NỘI CHUỖI không bị strip nhầm. Block comment
 * không đóng là input malformed — strip throw thay vì cắt lặng lẽ phần đuôi
 * file rồi để JSON.parse ra lỗi khó đọc.
 *
 * ⚠️ Bản copy có chủ đích của `transactional-mailer-job-deploy/wrangler-jsonc.ts`
 * (cần ở CẢ HAI deploy project vì mỗi spec tự đọc wrangler.jsonc của app mình);
 * follow-up tổng quát hoá lên `@ecoma-io/deployment` đi kèm tổng quát hoá
 * engine staging — xoá cả hai bản cùng lúc.
 */

/** Bỏ comment ngoài chuỗi — trả văn bản JSON-with-trailing-commas. */
export function stripJsoncComments(text: string): string {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const ch = text[index];
    if (inString) {
      out += ch;
      if (ch === '\\' && index + 1 < text.length) {
        // Escape hai ký tự (`\"`, `\\`) — giữ nguyên cặp, không đánh giá ký tự sau.
        out += text[index + 1];
        index += 2;
        continue;
      }
      if (ch === '"') inString = false;
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }
    // Lookahead có bounds-check: `/` đứng cuối input không được đọc quá độ dài.
    const next = index + 1 < text.length ? text[index + 1] : undefined;
    if (ch === '/' && next === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      // Không tìm thấy điểm kết thúc là input malformed — fail loud với offset,
      // không cắt lặng phần đuôi file (lỗi thật sẽ bị che dưới JSON.parse).
      const end = text.indexOf('*/', index + 2);
      if (end < 0) {
        throw new Error(`unterminated block comment at offset ${index} — JSONC input is malformed`);
      }
      index = end + 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/** Bỏ trailing comma ngoài chuỗi — JSON.parse khắt khe, JSONC cho phép. */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const ch = text[index];
    if (inString) {
      out += ch;
      if (ch === '\\' && index + 1 < text.length) {
        out += text[index + 1];
        index += 2;
        continue;
      }
      if (ch === '"') inString = false;
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/u.test(text[lookahead])) lookahead += 1;
      // Đọc tới cuối input thì `undefined` — không khớp `}`/`]` nên comma được
      // giữ lại và JSON.parse sẽ từ chối file malformed, đúng hợp đồng.
      const next: string | undefined = text[lookahead];
      if (next === '}' || next === ']') {
        index += 1;
        continue;
      }
    }
    out += ch;
    index += 1;
  }
  return out;
}

/** Parse một file JSONC (đã đọc text) thành object — sai hình là lỗi tường minh. */
export function parseJsonc<T>(text: string): T {
  return JSON.parse(stripTrailingCommas(stripJsoncComments(text))) as T;
}
