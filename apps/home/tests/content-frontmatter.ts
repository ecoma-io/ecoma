/**
 * Parser frontmatter YAML tối thiểu dùng chung cho các spec content của
 * `apps/home`.
 *
 * Tách ra đây vì có **hai** spec phải đọc frontmatter thật của file thật
 * (`content-contract.spec.ts` kiểm schema chung, `curriculum-contract.spec.ts`
 * kiểm curriculum 30 bài) và mỗi bản sao là một cơ hội để chúng trôi lệch —
 * đúng cái lớp lỗi repo đã mắc nhiều lần với "hai bản sao của một định nghĩa
 * không ai nhìn thấy".
 *
 * Vì sao không dùng thư viện YAML: spec chạy trong vitest project của app,
 * không có YAML parser trong dependency, và schema zod thật đã được
 * `@nuxt/content` enforce lúc build. Ở unit test chỉ cần đọc được vài field
 * phẳng và mảng string — thêm một dependency cho việc đó là chi phí không
 * đổi lấy gì. Parser vì vậy **cố ý hẹp**: nó đọc đúng những hình dạng
 * frontmatter của blog/legal dùng, và throw khi gặp thứ nó không hiểu, thay vì
 * trả về dữ liệu sai một cách âm thầm.
 */

/** Frontmatter parse được: value giữ nguyên kiểu YAML đã suy ra (string / number / boolean / string[]). */
export type ParsedFrontmatter = Record<string, unknown>;

/**
 * Tách khối frontmatter YAML ở đầu file.
 *
 * Cờ `m` bắt buộc trong regex H1 của các spec khác: `^` phải neo từng dòng,
 * không phải đầu chuỗi (chuỗi mở đầu bằng `---` của frontmatter).
 *
 * `---` phải là dòng **đầu tiên** — frontmatter đứng sai chỗ không phải
 * frontmatter, và im lặng chấp nhận nó là cách sai một bài hỏng render thành
 * bài "thiếu metadata" khó truy hơn nhiều.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw);
  if (!match) {
    throw new Error('missing frontmatter');
  }
  const result: ParsedFrontmatter = {};
  let currentKey = '';
  for (const line of match[1].split(/\r?\n/u)) {
    // List item phải được xử lý **trước** cặp key:value — key hiện hành là key
    // gần nhất có khai báo (`tags:`), kể cả khi key đó khai báo không có value.
    const listItem = /^ {2}- (.+)$/u.exec(line);
    if (listItem && currentKey) {
      const list = result[currentKey];
      if (Array.isArray(list)) {
        list.push(stripQuotes(listItem[1].trim()));
      } else {
        result[currentKey] = [stripQuotes(listItem[1].trim())];
      }
      continue;
    }
    // Key có thể khai báo không value (`tags:`) — khoảng trắng sau `:` là tùy
    // chọn, nên regex không được yêu cầu nó. Key camelCase (`articleId`,
    // `seriesOrder`...) phải khớp trọn vẹn: `[a-z]+` sẽ cắt tại chữ hoa và
    // làm mất đi chính những field mà contract research cần validate.
    const pair = /^([A-Za-z]+):(.*)$/u.exec(line);
    if (!pair) {
      continue;
    }
    currentKey = pair[1];
    const rawValue = pair[2].trim();
    result[currentKey] = scalar(rawValue, rawValue === '');
  }
  return result;
}

/**
 * Suy kiểu một giá trị scalar từ phần sau dấu `:` đã trim.
 *
 * - `''` (rỗng) → khởi đầu một YAML block sequence (mảng rỗng).
 * - `true`/`false` → boolean.
 * - Chuỗi toàn chữ số → number (YAML parse ra number; mirror cũng vậy, và
 *   giữ string cho mọi giá trị khác đúng hành vi cũ).
 */
function scalar(value: string, wasEmpty: boolean): unknown {
  if (wasEmpty) {
    return [];
  }
  const unquoted = stripQuotes(value);
  if (unquoted === 'true') {
    return true;
  }
  if (unquoted === 'false') {
    return false;
  }
  if (/^\d+$/u.test(value)) {
    return Number.parseInt(value, 10);
  }
  return unquoted;
}

/** Bỏ cặp nháy đơn bao ngoài, nếu có. */
function stripQuotes(value: string): string {
  return value.replace(/^'(.*)'$/u, '$1');
}

/** Mảng string đọc từ frontmatter — `[]` khi field vắng hoặc không phải mảng string. */
export function frontmatterList(frontmatter: ParsedFrontmatter, key: string): string[] {
  const value = frontmatter[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
