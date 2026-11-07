/**
 * Dựng chuỗi breadcrumb của docs từ content navigation — tách khỏi route để
 * test được các bất biến về thứ tự, trùng lặp và độ tồn tại của link.
 *
 * `findPageBreadcrumb` của Nuxt Content trả tổ tiên của page trong cây
 * navigation, nhưng cây đó có hai tính chất khiến kết quả thô chưa dùng được
 * trực tiếp:
 *
 * 1. Nó đi kèm một node gốc tổng hợp cho **locale-root** (`/en`) — không phải
 *    page của docs, và `/en` không phải route tồn tại trong app này, nên để
 *    nguyên sẽ tạo một breadcrumb trỏ tới 404;
 * 2. Nó không có entry cho chính bề mặt docs, nên thiếu mắt nối giữa root và
 *    section.
 *
 * Hàm này chèn entry `Docs` (trỏ về docs landing) ở đầu, lọc bỏ mọi crumb
 * không nằm trong docs tree, rồi luôn kết thúc bằng **page hiện tại lấy từ
 * chính document** — không phải từ navigation — để nhãn luôn khớp tiêu đề
 * trang. Lọc theo pathname chứ không theo nhãn nên không phụ thuộc ngôn ngữ.
 *
 * Lọc theo prefix chỉ có nghĩa khi biết gốc docs: khi `docsRootPath` là
 * `undefined` (docs landing không resolve được), không có prefix nào để neo
 * phép lọc, nên hàm bỏ toàn bộ ancestor crumb và trả duy nhất page hiện tại —
 * tốt hơn là rò một crumb như `/en` trỏ tới 404.
 */

import type { ContentNavigationItem } from '@nuxt/content';

/** Một mắt breadcrumb: pathname thật của content + nhãn hiển thị. */
export type DocsBreadcrumb = {
  readonly path: string;
  readonly title: string;
};

/**
 * Chuỗi breadcrumb từ gốc docs xuống page hiện tại.
 *
 * `docsRootPath` là public path của docs landing (dựng qua `buildPublicPath` ở
 * route); `ancestorCrumbs` là kết quả `findPageBreadcrumb` đã lọc theo locale;
 * `current` là document của pathname hiện tại.
 *
 * Bất biến: không mắt nào trùng path, mắt cuối luôn là page hiện tại, và mọi
 * mắt đều là pathname thật của content (không có `/en`). Khi `docsRootPath`
 * `undefined`, kết quả là duy nhất page hiện tại.
 */
export function buildDocsBreadcrumbs(input: {
  readonly docsRootPath: string | undefined;
  readonly docsRootTitle: string;
  readonly ancestorCrumbs: readonly ContentNavigationItem[];
  readonly currentPath: string;
  readonly currentTitle: string;
}): readonly DocsBreadcrumb[] {
  const entries: DocsBreadcrumb[] = [];
  const seen = new Set<string>();

  if (input.docsRootPath === undefined) {
    // Không có gốc docs thì không có anchor cho phép lọc prefix: mọi crumb
    // tuyệt đối đều pass, kể cả locale-root `/en` → link 404. Chỉ giữ page
    // hiện tại, lấy từ document nên vẫn tồn tại.
    entries.push({ path: input.currentPath, title: input.currentTitle });
    return entries;
  }

  entries.push({ path: input.docsRootPath, title: input.docsRootTitle });
  seen.add(input.docsRootPath);

  const docsPrefix = `${input.docsRootPath}/`;
  for (const crumb of input.ancestorCrumbs) {
    if (seen.has(crumb.path) || crumb.path === input.currentPath) {
      continue;
    }
    // Bỏ locale-root và mọi path không thuộc docs tree (ví dụ `/en`).
    if (!crumb.path.startsWith(docsPrefix)) {
      continue;
    }
    entries.push({ path: crumb.path, title: crumb.title });
    seen.add(crumb.path);
  }

  if (!seen.has(input.currentPath)) {
    entries.push({ path: input.currentPath, title: input.currentTitle });
  }

  return entries;
}
