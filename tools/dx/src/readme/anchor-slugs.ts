/**
 * Anchor slug theo đúng thuật toán GitHub cho heading Markdown.
 *
 * Contract của readme-check yêu cầu anchor trong link (`#mục-lục`,
 * `./other.md#testing`) phải khớp một heading của file đích theo GitHub anchor
 * slug rules. Tự viết lại thuật toán đó là một parser thứ hai sẽ trôi khỏi hành
 * vi thật của GitHub khi GitHub đổi rule (unicode punctuation, emoji, ký tự
 * CJK...), nên dùng `github-slugger` — implementation mà chính GitHub dùng cho
 * rendered Markdown.
 *
 * Hai quy tắc mà checker phải tái hiện đúng:
 * - Dấu tiếng Việt được giữ nguyên (chỉ lowercase, không fold dấu):
 *   "Tiêu đề" → `tiêu-đề`.
 * - Heading trùng slug trong cùng một file được đánh số: lần xuất hiện thứ hai
 *   nhận suffix `-1`, thứ ba `-2`, ... theo thứ tự tài liệu.
 */

import GithubSlugger from 'github-slugger';

import type { HeadingInfo } from './markdown-ast-types.js';

/**
 * Tập slug anchor của một tài liệu, tính theo đúng thứ tự heading trong tài
 * liệu. `slugger` có trạng thái đếm trùng nên mỗi tài liệu phải dùng một instance
 * mới — không tái dùng giữa hai file, nếu không số đếm trùng của file trước
 * nhiễm sang file sau.
 */
export function headingSlugs(headings: readonly HeadingInfo[]): ReadonlySet<string> {
  const slugger = new GithubSlugger();
  const slugs = new Set<string>();
  for (const heading of headings) {
    slugs.add(slugger.slug(heading.text.trim()));
  }
  return slugs;
}
