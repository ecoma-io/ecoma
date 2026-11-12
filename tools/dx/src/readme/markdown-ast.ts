/**
 * Lớp mỏng quanh `mdast-util-from-markdown` cho nhu cầu của readme-check.
 *
 * Vì sao không regex: một link extractor viết tay bằng regex sẽ false-pass trên
 * Markdown thật — link nằm trong code fence, trong inline code span, trong HTML
 * comment, escaped bracket `[...]` và link-reference definition đều trông giống
 * link nhưng không render thành link. micromark là implementation CommonMark
 * tham chiếu (cùng động cơ của remark), nên AST trả về đúng cái GitHub render:
 * những gì AST cho là link chính là link, những gì nằm trong code là code.
 *
 * Phạm vi cú pháp được hỗ trợ (CommonMark core, không GFM extension):
 * - ATX heading (`#`…`######`) và setext heading (`===`/`---` dưới một dòng văn bản).
 * - Inline link `[t](target)` cả dạng angle `[t](<path with spaces>)`, autolink
 *   `<https://…>`/`<mailto:…>`, image `![alt](target)`.
 * - Reference-style `[t][id]`, `[t][]`, shortcut `[t]`, cùng `imageReference`
 *   `![alt][id]`; definition `[id]: target` — definition đầu tiên thắng theo spec
 *   CommonMark khi một identifier khai báo nhiều lần.
 * - GFM table: micromark core không parse bảng, nhưng một dòng bảng chỉ là
 *   paragraph văn bản nên inline link trong cell vẫn được extract đúng — GitHub
 *   render link trong cell theo cùng inline grammar.
 * - Code fence, code span, HTML comment: không sinh link — đúng render của GitHub.
 *
 * Không hỗ trợ và KHÔNG bỏ qua lặng lẽ (báo về qua `unsupported` để checker gắn
 * finding cứng):
 * - HTML (block hoặc inline) chứa thuộc tính `href=`/`src=` ngoài comment — link
 *   thật mà AST không extract được dưới dạng link node.
 * - Cú pháp footnote `[^id]` — parser core đọc thành linkReference mang định danh
 *   `^id`; để tránh báo nhầm "link hỏng", báo riêng là cú pháp không hỗ trợ.
 * - Bare URL ngoài code (GFM autolink literal, `www.example.com`): micromark core
 *   đọc thành text. GitHub render chúng thành link ngoài — mọi autolink literal
 *   đều là external nên checker không bao giờ fetch chúng; khoảng trống này chỉ
 *   ảnh hưởng đến con số đếm `externalLinks`, không ảnh hưởng verdict pass/fail.
 */

import type {
  DefinitionInfo,
  HeadingInfo,
  LinkInfo,
  ParsedMarkdown,
  UnsupportedConstruct,
} from './markdown-ast-types.js';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { PhrasingContent, RootContent } from 'mdast';

/** Hình dạng khả biến của kết quả parse trước khi giao ra ngoài dưới dạng ParsedMarkdown. */
interface MutableParsedMarkdown {
  headings: HeadingInfo[];
  links: LinkInfo[];
  definitions: Map<string, DefinitionInfo>;
  unsupported: UnsupportedConstruct[];
}

/**
 * Gộp text của một node theo đúng thứ tự render: node `value` thì lấy value,
 * node có con thì gộp đệ quy. Đây là "text hiển thị" của heading/link — markup
 * inline (`**`, `` ` ``, emphasis) biến mất đúng như GitHub hiển thị.
 */
function displayedText(node: PhrasingContent): string {
  if ('type' in node && node.type === 'image') return node.alt ?? '';
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map((child) => displayedText(child)).join('');
  }
  return '';
}

/**
 * Thu thập link/image/reference từ cây phrasing, đệ quy qua mọi container inline
 * (emphasis, strong, heading con...). Một link lồng trong link text
 * (`[![img](a)](b)`) cho ra CẢ hai đích — GitHub render cả hai đều phải resolve.
 */
function collectPhrasingLinks(
  nodes: readonly PhrasingContent[],
  links: LinkInfo[],
  unsupported: UnsupportedConstruct[],
): void {
  for (const node of nodes) {
    if (node.type === 'link' || node.type === 'image') {
      links.push({
        kind: node.type,
        target: node.url,
        text: displayedText(node),
        line: node.position?.start.line ?? 0,
      });
    } else if (node.type === 'linkReference' || node.type === 'imageReference') {
      links.push({
        kind: 'reference',
        target: node.identifier,
        text: displayedText(node),
        line: node.position?.start.line ?? 0,
        referenceType: node.referenceType,
      });
    } else if (node.type === 'html') {
      // HTML inline nằm trong paragraph — cùng nhánh với HTML block.
      if (htmlLinkAttributes(node.value)) {
        unsupported.push({
          line: node.position?.start.line ?? 0,
          detail:
            'HTML carrying a link attribute (href/src); plain Markdown link syntax is required so the checker can verify the target',
        });
      }
    }
    if ('children' in node && Array.isArray(node.children)) {
      collectPhrasingLinks(node.children, links, unsupported);
    }
  }
}

/**
 * HTML chứa thuộc tính link (`href=`/`src=`) là một link thật mà AST không tách
 * được — phải báo unsupported thay vì bỏ qua lặng lẽ. HTML comment được miễn:
 * trình duyệt không render gì bên trong comment, nên không có link nào bị bỏ sót.
 * Nội dung HTML mẫu trong repository hiện nay chỉ là comment trong code fence —
 * đã nằm trong node `code`, không bao giờ rơi vào nhánh này.
 */
function htmlLinkAttributes(value: string): boolean {
  const withoutComments = value.replace(/<!--[\s\S]*?-->/gu, '');
  return /(?:href|src)\s*=/iu.test(withoutComments);
}

/** Đi qua mọi khối cấp cao: heading, definition, html và mọi container khối. */
function collectBlockContent(nodes: readonly RootContent[], parsed: MutableParsedMarkdown): void {
  for (const node of nodes) {
    if (node.type === 'heading') {
      const text = node.children.map((child) => displayedText(child)).join('');
      parsed.headings.push({
        depth: node.depth,
        text,
        line: node.position?.start.line ?? 0,
        endLine: node.position?.end.line ?? 0,
      });
      // Heading có thể chứa link inline (`## Xem [docs](./x.md)`) — vẫn phải resolve.
      collectPhrasingLinks(node.children, parsed.links, parsed.unsupported);
    } else if (node.type === 'definition') {
      const definition: DefinitionInfo = {
        target: node.url,
        line: node.position?.start.line ?? 0,
      };
      // CommonMark: definition đầu tiên cho một identifier là definition hợp lệ.
      if (!parsed.definitions.has(node.identifier))
        parsed.definitions.set(node.identifier, definition);
    } else if (node.type === 'html') {
      if (htmlLinkAttributes(node.value)) {
        parsed.unsupported.push({
          line: node.position?.start.line ?? 0,
          detail:
            'HTML carrying a link attribute (href/src); plain Markdown link syntax is required so the checker can verify the target',
        });
      }
    }
    if ('children' in node && Array.isArray(node.children)) {
      if (node.type === 'paragraph') {
        collectPhrasingLinks(node.children, parsed.links, parsed.unsupported);
      } else {
        collectBlockContent(node.children, parsed);
      }
    }
  }
}

/**
 * Parse một tài liệu Markdown. Bật lỗi lên cho người gọi — một tài liệu không
 * parse được là finding cứng của checker (`unparseable-markdown`), không phải
 * dữ liệu rỗng âm thầm.
 */
export function parseMarkdown(source: string): ParsedMarkdown {
  const root = fromMarkdown(source);

  const parsed: MutableParsedMarkdown = {
    headings: [],
    links: [],
    definitions: new Map(),
    unsupported: [],
  };

  collectBlockContent(root.children, parsed);

  // `[^id]` của footnote bị parser core đọc thành linkReference với identifier
  // bắt đầu bằng `^` — không có definition tương ứng sẽ thành "link hỏng" nhầm.
  // Tách riêng thành unsupported để người đọc biết đây là khoảng cú pháp, không
  // phải link sai.
  const footnotes = parsed.links.filter(
    (link) => link.kind === 'reference' && link.target.startsWith('^'),
  );
  for (const footnote of footnotes) {
    parsed.unsupported.push({
      line: footnote.line,
      detail: `footnote-style reference "[${footnote.target}]"; footnotes are outside the supported CommonMark subset`,
    });
  }
  const footnoteIds = new Set(footnotes.map((link) => link.target));
  parsed.links = parsed.links.filter(
    (link) => !(link.kind === 'reference' && footnoteIds.has(link.target)),
  );

  return parsed;
}

/**
 * Các dòng văn bản thô của tài liệu — checker dùng để xét "section có nội dung
 * hay không" giữa hai heading, việc mà AST không diễn đạt trực tiếp.
 */
export function splitLines(source: string): string[] {
  return source.split('\n');
}
