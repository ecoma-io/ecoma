import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Design token của public web — ghim các bất biến mà không test khác bắt được.
 *
 * Vì sao cần: token là hợp đồng thị giác + khả năng tiếp cận của toàn bộ site.
 * Một giá trị đổi sai không làm hỏng test type, test component hay test build —
 * chỉ hiện ra khi người dùng thật nhìn thấy chữ mờ đúng lúc hover. Vì vậy token
 * được đọc thẳng từ CSS **đã build** trong `.output/public/_nuxt/*.css` và kiểm
 * bằng công thức tương phản tương đối của WCAG 2.x, không hard-code giá trị ở đây.
 *
 * Vì sao đọc build output chứ không đọc `app/assets/css/styles.css`:
 *  - Token chỉ có ý nghĩa khi nó **còn trong CSS mà trình duyệt thật nhận**;
 *    đọc file nguồn sẽ bỏ sót trường hợp token không được đưa vào output (rơi
 *    sót do Tailwind/PostCSS) — đúng loại bug đã xảy ra với `@source` ở đây.
 *  - `import.meta.glob` không dùng được cho `.css`: Vite transform CSS thành
 *    module, nên cả `?raw` lẫn `query: '*'` đều trả chuỗi rỗng (đã thử).
 *  - `node:fs` bị lint cấm trong `apps/**` vì runtime là edge — nhưng file
 *    test này chạy ở **test time** trên Node, không được bundle vào Worker, và
 *    target `test` của project phụ thuộc `build` (xem `package.json`), nên đọc
 *    build output ở đây là an toàn. Import bị chặn bởi
 *    `import/no-nodejs-modules`/`no-restricted-imports`, không phải bởi
 *    `node:fs` tự thân — nên khai báo tường minh chỗ duy nhất cần.
 *
 * Công thức: L = 0.2126·R + 0.7152·G + 0.0722·B với kênh sRGB tuyến tính
 * hoá; contrast = (L₁ + 0.05) / (L₂ + 0.05).
 */

const NUXT_CSS_DIR = resolve(import.meta.dirname, '../.output/public/_nuxt');

/**
 * Nội dung mọi file CSS mà Worker thực sự phục vụ. Build xong mới có thư mục
 * này — target `test` của project `dependsOn: ['build']` bảo đảm điều đó.
 */
const BUILT_CSS = readdirSync(NUXT_CSS_DIR)
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(resolve(NUXT_CSS_DIR, name), 'utf8'))
  .join('\n');

/** Đọc giá trị một token dạng `--tên: #hex;` từ CSS đã build. */
function readToken(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{3,8})`, 'u').exec(BUILT_CSS);
  if (match === null) {
    throw new Error(`Token --color-${name} not found in the built CSS`);
  }
  return match[1] as string;
}

/** Độ sáng tương đối của một màu hex theo WCAG. */
function relativeLuminance(hex: string): number {
  const normalized =
    hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((channel) => `${channel}${channel}`)
          .join('')
      : hex.slice(1, 7);
  const channels = [0, 2, 4].map((offset) => {
    const raw = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.039_28 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] as number) +
    0.7152 * (channels[1] as number) +
    0.0722 * (channels[2] as number)
  );
}

/** Tương phản giữa hai màu hex — 1:1 nếu giống nhau. */
function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Ngưỡng WCAG AA cho chữ thường (dưới 18.66px bold / 24px). */
const AA_NORMAL_TEXT = 4.5;

describe('design token contrast', () => {
  it.each(['brand', 'brand-hover'])('keeps white text on --color-%s above WCAG AA', (token) => {
    // CTA primary là `bg-<token> text-white` ở cỡ `text-sm`/`text-base` — 14-16px
    // KHÔNG thuộc "large text" của WCAG nên ngưỡng 4.5:1 vẫn áp dụng. Nền hover
    // cũng là nền chữ trắng: đổi hover sang sáng hơn làm mờ chữ đúng ở trạng
    // thái tương tác mà người dùng đang nhìn để quyết định bấm.
    const ratio = contrastRatio('#ffffff', readToken(token));
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it.each(['brand-soft', 'muted', 'faint', 'foam'])(
    'keeps --color-%s readable on the page background --color-ink',
    (foreground) => {
      const ratio = contrastRatio(readToken(foreground), readToken('ink'));
      expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    },
  );

  it.each(['muted', 'faint'])('keeps --color-%s readable on --color-surface', (foreground) => {
    // Section dùng nền surface nổi trên ink — chữ thường đọc trên cả hai nền.
    const ratio = contrastRatio(readToken(foreground), readToken('surface'));
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('keeps --color-line distinguishable from --color-ink for surface separation', () => {
    // Đường kẻ (`border-line`, `divide-line`) ở đây là **trang trí**: phân tách
    // card/section trên nền tối, không thuộc thành phần UI mà WCAG 1.4.11 yêu
    // cầu 3:1 (không token nào dùng cho viền input/button/checkbox — app không
    // có form nhập liệu ở public web). Vì vậy KHÔNG ghim 3:1; chỉ ghim điều kiện
    // tối thiểu có ý nghĩa: đường phải tách được khỏi nền, không chìm vào nền.
    const ratio = contrastRatio(readToken('line'), readToken('ink'));
    expect(ratio).toBeGreaterThan(1.2);
  });
});
