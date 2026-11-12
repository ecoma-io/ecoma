/**
 * Contract heading của README project: đúng một H1 và sáu section H2 bắt buộc.
 *
 * Contract (nguồn: Nx Project README Governance, Issue #134):
 * - Đúng MỘT H1 với text không rỗng.
 * - Sáu section H2 bắt buộc với heading text khớp CHÍNH XÁC sau trim:
 *   `Purpose`, `Responsibilities`, `Boundaries`, `Development`, `Testing`,
 *   `Related Documentation`. So khớp sau trim nhưng KHÔNG so khớp case —
 *   `## testing` không phải `Testing`.
 * - Heading bắt buộc mà theo sau là 0 dòng nội dung không trống cho đến heading
 *   kế tiếp (mọi depth) hoặc EOF là vi phạm — chặn README "filler" đi qua check
 *   bằng heading trống.
 *
 * "Text hiển thị" của heading là text sau khi bỏ markup inline (AST gộp value),
 * khớp với cách GitHub render: `## **Testing**` hiển thị `Testing` nên được tính
 * là section `Testing`. Quyết định này được ghi rõ ở đây vì contract nói "exactly"
 * — chính xác là trên text hiển thị sau trim, không phải trên nguồn Raw gồm markup.
 */

import type { HeadingInfo, ParsedMarkdown } from './markdown-ast-types.js';

/** Sáu section H2 bắt buộc của mọi project README, theo thứ tự quy ước. */
export const REQUIRED_SECTIONS: readonly string[] = [
  'Purpose',
  'Responsibilities',
  'Boundaries',
  'Development',
  'Testing',
  'Related Documentation',
];

/** Vi phạm contract heading trên một dòng của README. */
export interface ContractViolation {
  code: string;
  message: string;
  hint: string;
  /** Dòng 1-based; `0` khi vi phạm không gắn với dòng nào (thiếu H1/section). */
  line: number;
}

/** Kiểm contract heading trên một tài liệu đã parse; trả về vi phạm theo thứ tự ổn định. */
export function checkHeadingContract(
  parsed: Pick<ParsedMarkdown, 'headings'>,
  lines: readonly string[],
): ContractViolation[] {
  const violations: ContractViolation[] = [];

  const h1s = parsed.headings.filter((heading) => heading.depth === 1);
  if (h1s.length === 0) {
    violations.push({
      code: 'missing-h1',
      message: 'README has no H1 heading',
      hint: 'add a single "# <project name>" heading at the top of the file',
      line: 0,
    });
  } else {
    if (h1s[0].text.trim() === '') {
      violations.push({
        code: 'empty-h1',
        message: `H1 heading at line ${h1s[0].line} has no text`,
        hint: 'write the project name after "#"',
        line: h1s[0].line,
      });
    }
    // Chỉ H1 THỨ HA TRỞ ĐI bị báo — H1 đầu tiên vẫn là H1 chính thức của file.
    for (const extra of h1s.slice(1)) {
      violations.push({
        code: 'multiple-h1',
        message: `README has more than one H1 heading (first at line ${h1s[0].line}, another at line ${extra.line})`,
        hint: 'demote extra H1 headings ("# ...") to H2/H3, or merge them into the first section',
        line: extra.line,
      });
    }
  }

  const h2s = parsed.headings
    .filter((heading) => heading.depth === 2)
    .map((heading) => ({ text: heading.text.trim(), heading }));

  // Vị trí heading kế tiếp (mọi depth) sau mỗi heading — dùng để xét phần thân.
  const nextHeadingStart = new Map<HeadingInfo, number>();
  for (let i = 0; i < parsed.headings.length; i++) {
    const following = parsed.headings[i + 1];
    nextHeadingStart.set(parsed.headings[i], following ? following.line : lines.length + 1);
  }

  /** Phần thân sau một heading có ít nhất một dòng không toàn whitespace hay không. */
  const hasBody = (heading: HeadingInfo): boolean => {
    const end = nextHeadingStart.get(heading) ?? lines.length + 1;
    for (let index = heading.endLine; index < end - 1; index++) {
      if (lines[index]?.trim() !== '') return true;
    }
    return false;
  };

  for (const required of REQUIRED_SECTIONS) {
    const matches = h2s.filter((entry) => entry.text === required);
    if (matches.length === 0) {
      // Chẩn đoán gần đúng: heading cùng chữ nhưng khác case gợi ý sửa nhanh.
      const caseMatch = h2s.find((entry) => entry.text.toLowerCase() === required.toLowerCase());
      violations.push({
        code: 'missing-section',
        message: caseMatch
          ? `required H2 section "${required}" is missing (a heading "${caseMatch.text}" at line ${caseMatch.heading.line} differs only in case)`
          : `required H2 section "${required}" is missing`,
        hint: caseMatch
          ? `rename the heading at line ${caseMatch.heading.line} to "${required}"`
          : `add "## ${required}" followed by at least one non-empty line of content`,
        line: 0,
      });
      continue;
    }
    for (const match of matches) {
      if (!hasBody(match.heading)) {
        violations.push({
          code: 'empty-section-body',
          message: `H2 section "${required}" at line ${match.heading.line} has no content before the next heading`,
          hint: `write at least one non-empty line under "## ${required}" (empty sections must not pass the check)`,
          line: match.heading.line,
        });
      }
    }
  }

  return violations;
}
