import { describe, expect, it } from 'vitest';
import appShellCss from './app-shell.css?raw';

/**
 * Ghim rằng rule mặc định con trỏ cho `button` nằm **trong `@layer base`**.
 *
 * Vì sao: Tailwind v4 khai `@layer theme, base, components, utilities`, và theo
 * CSS Cascade thì declaration không thuộc layer nào **luôn thắng** mọi
 * declaration có layer, bất kể specificity. Rule này để trần thì đè hết utility
 * con trỏ của chính thư viện lẫn của app — cụ thể utility kéo-đổi-bề-rộng của
 * `SidebarRail` không bao giờ thắng, mất affordance "kéo để đổi bề rộng". Vì
 * layering được áp **trước** specificity, utility có specificity cao hơn
 * `[type=button]` vẫn thua. Đo trên Chromium với CSS production: để trần thì
 * `cursor` của rail là `pointer`; trong `base` thì là `w-resize`.
 *
 * Vì sao kiểm ở **source** chứ không trên CSS đã build: đây là bất biến về cấu
 * trúc file nguồn, và postcss không resolve được từ test của lib này để parse
 * output. Cách kiểm ở đây theo đúng lối của
 * `apps/backoffice/tests/tailwind-source.spec.ts`: ghim cấu trúc nguồn vì đó là
 * thứ đổi được, còn hành vi cascade đã được đo một lần trên trình duyệt thật lúc
 * port. Test này canh cấu trúc khỏi trôi lại.
 *
 * **Không viết tên class Tailwind ra trong file này.** `@source` của lib là
 * `../**\/*.{vue,ts}`, tức Tailwind quét cả `*.spec.ts` dưới `src/`; một tên
 * class chỉ xuất hiện trong comment hay regex ở đây vẫn sinh ra utility trong
 * CSS production của app và làm phép đo trên output sai lệch. Vì vậy phần nhận
 * dạng dưới đây chỉ dùng tiền tố `cursor` (không phải một tên class hợp lệ) và
 * selector `button` (cũng không phải utility).
 */

interface Block {
  /** Prelude của block: `@layer base`, `@media (...)`, hoặc selector. */
  readonly prelude: string;
  /** Tên at-rule (không kèm `@`), hoặc `null` nếu là rule thường. */
  readonly atRule: string | null;
}

interface ParsedRule {
  readonly prelude: string;
  readonly ancestors: readonly Block[];
  readonly body: string;
}

/** Bỏ comment nhưng giữ nguyên độ dài, để chỉ số ký tự không đổi. */
function stripComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//gu, (match) => ' '.repeat(match.length));
}

/**
 * Mọi rule thường (không phải at-rule) kèm các block bao ngoài, theo thứ tự.
 *
 * Quét theo `{`/`}` trên CSS đã bỏ comment. Đủ cho file này: không có `{`/`}`
 * trong chuỗi hay trong selector, nên một stack đơn giản là chính xác.
 */
function rulesOf(css: string): ParsedRule[] {
  const source = stripComments(css);
  const rules: ParsedRule[] = [];
  const stack: { block: Block; bodyStart: number }[] = [];
  let preludeStart = 0;

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const char = source[cursor];

    if (char === '{') {
      const prelude = source.slice(preludeStart, cursor).trim();

      stack.push({
        block: { prelude, atRule: /^@([\w-]+)/u.exec(prelude)?.[1] ?? null },
        bodyStart: cursor + 1,
      });
      preludeStart = cursor + 1;
    } else if (char === '}') {
      const entry = stack.pop();

      if (entry !== undefined && entry.block.atRule === null) {
        rules.push({
          prelude: entry.block.prelude,
          ancestors: stack.map((item) => item.block),
          body: source.slice(entry.bodyStart, cursor),
        });
      }

      preludeStart = cursor + 1;
    } else if (char === ';' && stack.length === 0) {
      // At-rule không có block (`@import ...;`, `@source ...;`).
      preludeStart = cursor + 1;
    }
  }

  return rules;
}

/** Selector nhắm vào `button` — không phải tên utility nào. */
const BUTTON_SELECTOR = /\bbutton\b|\[type\s*=\s*['"]?button['"]?\]/u;

/**
 * Rule có đặt con trỏ không: hoặc `@apply` một utility con trỏ, hoặc một
 * declaration `cursor:` bằng tay. `cursor` một mình không phải utility hợp lệ
 * nên không sinh class nào khi Tailwind quét file này.
 */
const SETS_CURSOR = /@apply[^;]*\bcursor|[\n{;]\s*cursor\s*:/u;

/** Chuỗi tên các layer bao ngoài một rule, từ ngoài vào trong. */
function layerChainOf(ancestors: readonly Block[]): string[] {
  return ancestors
    .filter((block) => block.atRule === 'layer')
    .map((block) => block.prelude.replace(/^@layer\s+/u, '').trim());
}

function buttonCursorRules(rules: readonly ParsedRule[]): ParsedRule[] {
  return rules.filter((rule) => BUTTON_SELECTOR.test(rule.prelude) && SETS_CURSOR.test(rule.body));
}

describe('app-shell.css sets a default cursor for button inside @layer base', () => {
  const rules = rulesOf(appShellCss);

  it('the scanner actually finds the cursor rule for button', () => {
    // Nếu scanner hỏng (selector hay cách đặt con trỏ đổi) thì test dưới sẽ
    // xanh vì không tìm thấy rule nào — "passing by absence". Ghim tồn tại trước.
    const found = buttonCursorRules(rules);

    expect(found.length).toBeGreaterThan(0);
    expect(found.some((rule) => /\[type/u.test(rule.prelude))).toBe(true);
  });

  it('every rule setting the cursor for button is inside @layer base, none left bare', () => {
    const offenders = buttonCursorRules(rules)
      .map((rule) => ({ selector: rule.prelude, layers: layerChainOf(rule.ancestors) }))
      .filter((rule) => rule.layers.at(-1) !== 'base');

    expect(offenders).toEqual([]);
  });
});
