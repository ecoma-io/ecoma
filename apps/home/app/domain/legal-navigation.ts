/**
 * Điều hướng của Legal Center — dựng sidebar và breadcrumb từ **grouped listing
 * đã qua publication gate** mà route đã resolve, tách khỏi route và khỏi
 * component để test được các bất biến về thứ tự, URL và locale mà không cần
 * dựng Nuxt runtime hay SQLite query.
 *
 * Legal là **tập văn bản phẳng có phân nhóm**, không phải tree như docs: không
 * có node cha/child, không có index page trùng path. Vì vậy ở đây không có
 * `queryCollectionNavigation` nào — nguồn duy nhất là listing route query sẵn
 * (`legal-collection.ts`), dùng lại cho landing, sidebar và breadcrumb. Thêm
 * một nguồn điều hướng thứ hai nghĩa là phải giữ cho nó khớp với listing, và
 * draft sẽ có thể lọt vào nav theo một đường khác gate.
 *
 * Bất biến chung của cả hai hàm:
 *
 * - **URL canonical**: link tới **văn bản** là `document.path` — path collection
 *   khớp thẳng public URL, không dựng lại từ slug (không có registry thứ hai để
 *   lệch). Mắt anchor landing (`Overview` của sidebar, mắt đầu của breadcrumb)
 *   là ngoại lệ: nó dùng `legalRootPath` mà caller truyền vào — route dựng từ
 *   `buildPublicPath`, không phải từ một văn bản trong listing. Cả hai hàm **bỏ
 *   hẳn** mắt đó khi `legalRootPath` là `undefined`, thay vì trỏ tới URL không
 *   tin được.
 * - **Không fabricate**: link chỉ tới văn bản thật trong listing đã gate, nên
 *   draft không thể lọt vào sidebar ở production.
 *
 * Bất biến riêng của `buildLegalSidebar` (`legalBreadcrumbs` không có nhóm nào):
 *
 * - **Thứ tự ổn định**: nhóm đi đúng thứ tự `categoryOrder` mà **caller** truyền
 *   vào — route lấy từ `legalCategoryOrder()`, và spec của hàm truyền cả
 *   `['terms','policy']` để chốt rằng thứ tự là input chứ không phải hằng bên
 *   trong. Trong mỗi nhóm giữ nguyên thứ tự của listing — listing đã được
 *   `orderLegalDocumentsByStem` chốt theo prefix số trong tên file (KHÔNG phải so
 *   chữ của `stem`, vì `10.` sẽ đứng trước `2.`). Không `sort` lại ở đây để không
 *   phá thứ tự editorial mà seed đã khai.
 */

import type { LegalCategory, LegalDocumentRecord } from './legal-collection';

/**
 * Một mắt breadcrumb: pathname thật + nhãn hiển thị.
 *
 * Mắt cuối là page hiện tại; các mắt trước là link. Cùng shape với
 * `DocsBreadcrumb` và với prop `entries` của `PublicBreadcrumbs`, nên hai bề mặt
 * dùng chung được một component render.
 */
export type LegalBreadcrumb = {
  readonly path: string;
  readonly title: string;
};

/** Văn bản tối thiểu mà các builder navigation cần — chỉ `path` và `title`.
 *
 * `legal-collection.ts` đã chốt convention "record tối thiểu mà domain function
 * cần" bằng `Pick<>`; hai builder ở đây cũng chỉ đọc đúng hai field này. Không
 * khai đủ `LegalDocumentRecord` vì nó ép fixture phải bịa `version`,
 * `effectiveDate`, `reviewStatus` chỉ để thỏa type, và mọi field mới thêm vào
 * record sẽ lan sang đây dù không dùng tới.
 */
export type LegalNavigationRecord = Pick<LegalDocumentRecord, 'path' | 'title'>;

/**
 * Chuỗi breadcrumb `Legal Center → Document` cho một văn bản.
 *
 * Landing không gọi hàm này: `/en/legal` là bản thân mục đầu của chuỗi nên
 * breadcrumb của nó là một mắt duy nhất. Route dựng mắt đó trong computed
 * `breadcrumbs` của nó (nhánh `current === undefined`) rồi truyền xuống cả hai
 * bề mặt qua prop — route là nơi duy nhất resolve breadcrumb của legal.
 *
 * Trung gian là **nhóm phân loại** (`Policies` / `Terms`), không phải một trang:
 * legal không có URL cho từng nhóm (đó là điều docs có và legal cố ý không có —
 * xem `legal-locale.ts`, legal là danh sách phẳng đúng một segment slug). Vì
 * vậy nhóm không thành một mắt breadcrumb có `path`; nó là **label của sidebar
 * group** (`categoryLabels`), và chuỗi breadcrumb chỉ có hai mắt thật: về
 * landing, rồi về văn bản. Cả hai đều là URL thật của tài liệu đã render.
 *
 * Chống trùng path giống `buildDocsBreadcrumbs` của docs: khi landing **là**
 * trang hiện tại thì chỉ giữ một mắt. Hai link cùng đích vừa sinh key trùng ở
 * `v-for` của `PublicBreadcrumbs` (Vue cảnh báo dev và patch sai node) vừa
 * khiến screen reader đọc cùng một nhãn hai lần.
 *
 * Chuỗi này dựng **không** từ `grouped` listing: `legalBreadcrumbs` chỉ nhận
 * record của văn bản đang đọc (`current`). Route gọi nó ở nhánh detail — nhánh
 * landing tự dựng mắt đơn, xem `[[...slug]].vue`.
 */
export function legalBreadcrumbs(input: {
  /**
   * Public path của landing (`/{locale}/legal`) — mắt đầu, là link.
   *
   * `undefined` khi builder không resolve được path hợp lệ: thay vì dựng
   * link tới một URL không tin được, bỏ hẳn mắt tổ tiên và chỉ giữ trang
   * hiện tại (cùng cách `buildDocsBreadcrumbs` xử lý `docsRootPath` rỗng).
   */
  readonly legalRootPath: string | undefined;
  /** Nhãn localized của landing — nhãn hiển thị của mắt đầu. */
  readonly legalRootTitle: string;
  /** Văn bản đang đọc — mắt cuối, mang `aria-current="page"`. */
  readonly current: LegalNavigationRecord;
}): readonly LegalBreadcrumb[] {
  if (input.legalRootPath === undefined || input.current.path === input.legalRootPath) {
    return [{ path: input.current.path, title: input.current.title }];
  }
  return [
    { path: input.legalRootPath, title: input.legalRootTitle },
    { path: input.current.path, title: input.current.title },
  ];
}

/** Một mắt sidebar tới **một trang**: landing (`Overview`) hoặc một văn bản. */
export type LegalSidebarLink = {
  readonly title: string;
  /** Pathname thật của trang đích — canonical, không dựng lại từ slug. */
  readonly path: string;
  /** `true` khi đây là trang hiện tại → mang `aria-current="page"`. */
  readonly current: boolean;
};

/** Một nhóm văn bản theo category: nhãn nhóm + các trang của nhóm. */
export type LegalSidebarGroup = {
  /** Category đã khai — giữ để consumer test/key được ổn định. */
  readonly category: LegalCategory;
  /**
   * Nhãn nhóm đã localized (`Policies` / `Terms`), render dạng `<p>` ở sidebar —
   * **không** phải heading: landing có một `<h2>` mỗi nhóm còn detail chỉ có một
   * `<h2>` gộp, nên heading thứ hai trong nav sẽ lặp hoặc phá document outline
   * (xem `LegalNav` và `tests/static-output.spec.ts`).
   */
  readonly title: string;
  /** Các trang của nhóm, giữ thứ tự listing. */
  readonly documents: readonly LegalSidebarLink[];
};

/** Sidebar đầy đủ: mắt `Overview` (có thể không có) rồi các nhóm category. */
export type LegalSidebarNav = {
  /**
   * Mắt `Overview` trỏ về landing. `null` khi không resolve được landing path —
   * xem `buildLegalSidebar`.
   */
  readonly overview: LegalSidebarLink | null;
  readonly groups: readonly LegalSidebarGroup[];
};

/**
 * Dựng sidebar từ grouped listing của route.
 *
 * Cấu trúc: `Overview` → link landing, rồi từng nhóm category theo
 * `categoryOrder` (`policy` trước `terms`), mỗi nhóm là **nhãn nhóm** (`<p>`,
 * không phải heading — xem `LegalSidebarGroup.title`) + danh sách văn bản của nhóm.
 *
 * **Nhóm rỗng vẫn được giữ** (nhãn không kèm link nào), cùng chính sách với
 * landing: nhóm biến mất khiến người đọc không biết Legal Center có nhóm đó
 * nhưng chưa có văn bản nào. Danh sách seed hiện có cả hai nhóm ở cả hai locale.
 *
 * `currentPath` là pathname hiện tại (landing = `legalRootPath`) dùng cho
 * `aria-current="page"`; caller truyền vào để hàm này không cần biết route.
 *
 * **Nhiều nhất một mắt `current` trong cả sidebar**: `Overview` chỉ bật khi không
 * mắt văn bản nào đang current. So khớp là so sánh pathname đầy đủ, không phải suy
 * từ slug. Hàm tự bảo vệ thay vì dựa vào kỷ luật của caller: **không** có
 * `hasCurrentDocument` ở đây thì khi `legalRootPath` trùng `currentPath` của một
 * văn bản, hai mắt cùng bật, tức **hai**
 * `aria-current="page"` trong cùng một `<nav>` — reader không phân biệt được
 * đâu là trang hiện tại. Đó là lý do `Overview` có điều kiện `!hasCurrentDocument`
 * bên dưới, và vì vậy đây là bất biến **do hàm bảo đảm**, không phải điều kiện
 * caller phải giữ.
 *
 * Hàm bảo đảm **nhiều nhất một**, không phải *đúng một*: khi `currentPath` không
 * khớp mắt nào — `currentPath` lệch, hoặc `legalRootPath` là `undefined` và văn
 * bản hiện tại không có trong listing — thì **không** mắt nào bật. Route hiện tại
 * luôn rơi vào nhánh khớp (landing khớp `legalRootPath`, detail luôn có document
 * trong listing đã qua gate), nhưng đó là điều kiện của **caller**, không phải
 * bảo đảm của hàm — nên chữ "đúng một" ở đây sẽ khiến consumer sau tin cứ đã
 * được chắc và không thêm guard.
 */
export function buildLegalSidebar(input: {
  /**
   * Public path của landing, mắt `Overview`.
   *
   * `undefined` khi builder không resolve được: khi đó **không render mắt
   * Overview** thay vì trỏ nó về một URL không tin được — cùng cách
   * `buildDocsBreadcrumbs` bỏ mắt tổ tiên khi `docsRootPath` rỗng.
   */
  readonly legalRootPath: string | undefined;
  readonly currentPath: string;
  readonly legalRootTitle: string;
  readonly categoryOrder: readonly LegalCategory[];
  readonly categoryLabels: Readonly<Record<LegalCategory, string>>;
  readonly grouped: Readonly<Record<LegalCategory, readonly LegalNavigationRecord[]>>;
}): LegalSidebarNav {
  const groups = input.categoryOrder.map((category) => ({
    category,
    title: input.categoryLabels[category],
    // Không `?? []`: `category` thuộc `readonly LegalCategory[]` nên
    // `grouped[category]` không bao giờ `undefined` — invariant "mọi category
    // đều có mắt trong sidebar" đến từ `legalCategoryOrder()`, không từ
    // guard ở đây.
    documents: input.grouped[category].map((document) => ({
      title: document.title,
      path: document.path,
      current: document.path === input.currentPath,
    })),
  }));
  // Mắt văn bản đang đọc thắng mắt `Overview` khi hai pathname trùng nhau.
  const hasCurrentDocument = groups.some((group) =>
    group.documents.some((document) => document.current),
  );

  return {
    // Không có anchor landing hợp lệ thì sidebar chỉ còn các nhóm văn bản —
    // link về tổng quan bị bỏ thay vì dựng URL sai.
    overview:
      input.legalRootPath === undefined
        ? null
        : {
            title: input.legalRootTitle,
            path: input.legalRootPath,
            current: !hasCurrentDocument && input.currentPath === input.legalRootPath,
          },
    groups,
  };
}
