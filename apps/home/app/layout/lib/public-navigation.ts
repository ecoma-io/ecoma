/**
 * Global public navigation — navigation cấp Public Web do `app/layout`
 * sở hữu.
 *
 * Dữ liệu tĩnh, frozen, không runtime fetch, không CMS schema. Application-
 * specific navigation (sidebar của docs, category của blogs…) **không** nằm
 * ở đây — nó thuộc về app.
 *
 * Model v2 (redesign #104): mỗi item mang `id` ổn định (khóa cho disclosure
 * panel của header) và **tối đa một** danh sách `groups`; item có `groups`
 * được header render là mega panel, item không có là link thường. Nhiều item
 * cùng lúc có thể khai báo `groups` — header giữ state mở/đóng độc lập theo
 * `id`, không còn giả định "tối đa một menu". Label và heading là
 * `Record<PublicLocale, string>`: thêm một locale vào `app/i18n` mà thiếu
 * bản dịch là lỗi type ngay tại khai báo.
 */

import type { PublicLocale } from '../../i18n/index';
import { buildPublicPath } from './build-public-path';
import type { PublicMount } from './mount-registry';

/**
 * Một link trong panel: resource path **dưới mount** (bắt đầu bằng `/`) kèm
 * label theo locale. Dùng chung cho link trong group của mega panel, cho các
 * policy link (header lẫn footer) và cho các nhóm footer.
 */
export type PublicNavigationSection = {
  readonly path: string;
  readonly label: Readonly<Record<PublicLocale, string>>;
};

/** Một cột của mega panel: heading + các link con. */
export type PublicNavigationGroup = {
  readonly heading: Readonly<Record<PublicLocale, string>>;
  readonly links: readonly PublicNavigationSection[];
};

export type PublicNavigationItem = {
  /** ID ổn định của item — khóa state disclosure và suffix của panel id DOM. */
  readonly id: string;
  /** Mount dùng cho active state (`aria-current`) của trigger. */
  readonly mount: PublicMount;
  readonly label: Readonly<Record<PublicLocale, string>>;
  /**
   * Resource path dưới mount mà trigger trỏ tới (bắt đầu bằng `/` hoặc rỗng
   * cho mount root). Trigger **luôn là link thật**: mount `legal` không có
   * trang landing nên trigger của nó trỏ policy đầu tiên thay vì một URL
   * không tồn tại.
   */
  readonly triggerPath?: string;
  /**
   * Các cột của mega panel. Có mặt → header render disclosure; vắng mặt →
   * link thường. Panel luôn kèm một link tới chính trigger path (đầu tiên)
   * nên mount root không bao giờ mất đường vào cho no-JS/crawler.
   */
  readonly groups?: readonly PublicNavigationGroup[];
};

/**
 * Navigation item đã được resolve cho một locale cụ thể: `href` là public
 * path canonical dựng qua `buildPublicPath`, không bao giờ là string
 * concatenate. `groups` chỉ xuất hiện khi item khai báo nó trong data.
 */
export type PublicNavigationLink = {
  readonly id: string;
  readonly mount: PublicMount;
  readonly label: string;
  readonly href: string;
  readonly groups?: readonly {
    readonly heading: string;
    readonly links: readonly { readonly label: string; readonly href: string }[];
  }[];
};

/**
 * Link dùng chung cho mount docs — section index + hai page con của từng
 * section, đúng content thật của collection `docs`. Nguồn duy nhất cho mega
 * panel Docs của header; footer Documentation trỏ section index qua
 * FOOTER_DEFINITIONS.
 */
const DOCS_SECTION_GROUPS: readonly PublicNavigationGroup[] = [
  {
    heading: { en: 'Getting started', vi: 'Bắt đầu' },
    links: [
      { path: '/getting-started', label: { en: 'Getting started', vi: 'Bắt đầu' } },
      { path: '/getting-started/installation', label: { en: 'Installation', vi: 'Cài đặt' } },
      {
        path: '/getting-started/first-steps',
        label: { en: 'First steps', vi: 'Các bước đầu tiên' },
      },
    ],
  },
  {
    heading: { en: 'Concepts', vi: 'Khái niệm' },
    links: [
      { path: '/concepts', label: { en: 'Concepts', vi: 'Khái niệm' } },
      { path: '/concepts/public-web', label: { en: 'Public web', vi: 'Web công khai' } },
      {
        path: '/concepts/content-and-locales',
        label: { en: 'Content and locales', vi: 'Nội dung và ngôn ngữ' },
      },
    ],
  },
  {
    heading: { en: 'Guides', vi: 'Hướng dẫn' },
    links: [
      { path: '/guides', label: { en: 'Guides', vi: 'Hướng dẫn' } },
      {
        path: '/guides/building-a-public-page',
        label: { en: 'Building a public page', vi: 'Xây dựng một trang công khai' },
      },
      {
        path: '/guides/local-development',
        label: { en: 'Local development', vi: 'Phát triển cục bộ' },
      },
    ],
  },
];

/**
 * Entry point của Legal Center + năm resource policy dưới mount `legal` —
 * nguồn **duy nhất** cho cả mega panel Legal của header lẫn hàng legal của
 * footer; hai bề mặt không tự giữ hai bản danh sách có nguy cơ lệch nhau.
 *
 * `/legal` (landing, #116) đứng đầu: nó là danh sách đầy đủ mọi văn bản của
 * Legal Center, nên policy nằm sau nó có thứ tự đọc tự nhiên và người đọc
 * luôn có một đường vào tập hồ sơ chứ không phải rơi thẳng vào một policy.
 */
const LEGAL_POLICY_LINKS: readonly PublicNavigationSection[] = [
  {
    path: '',
    label: { en: 'Legal Center', vi: 'Trung tâm Pháp lý' },
  },
  {
    path: '/privacy',
    label: { en: 'Privacy Policy', vi: 'Chính sách bảo mật' },
  },
  {
    path: '/terms',
    label: { en: 'Terms of Service', vi: 'Điều khoản dịch vụ' },
  },
  {
    path: '/service-delivery',
    label: { en: 'Service Delivery Policy', vi: 'Chính sách cung cấp dịch vụ' },
  },
  {
    path: '/payment',
    label: { en: 'Payment Policy', vi: 'Chính sách thanh toán' },
  },
  {
    path: '/refund',
    label: { en: 'Refund Policy', vi: 'Chính sách hoàn tiền' },
  },
];

const NAVIGATION_DEFINITIONS = [
  {
    id: 'docs',
    mount: 'docs',
    label: { en: 'Docs', vi: 'Docs' },
    // Trigger trỏ mount root — `/en/docs` là landing thật của docs.
    groups: DOCS_SECTION_GROUPS,
  },
  { id: 'blog', mount: 'blog', label: { en: 'Blog', vi: 'Blog' } },
  {
    id: 'legal',
    mount: 'legal',
    label: { en: 'Legal', vi: 'Pháp lý' },
    // Trigger trỏ landing của mount (`/[locale]/legal` #116) — danh sách đầy
    // đủ văn bản; panel bắt đầu bằng chính link này nên crawler/no-JS vẫn vào
    // được Legal Center.
    triggerPath: '',
    groups: [
      {
        heading: { en: 'Policies', vi: 'Chính sách' },
        links: LEGAL_POLICY_LINKS,
      },
    ],
  },
] as const satisfies readonly {
  id: string;
  mount: PublicMount;
  label: Record<PublicLocale, string>;
  triggerPath?: string;
  groups?: readonly PublicNavigationGroup[];
}[];

/**
 * Toàn bộ global navigation, frozen — **dữ liệu duy nhất** mô tả navigation
 * cấp Public Web. Mỗi mount chỉ xuất hiện tối đa một lần (lookup bắt buộc,
 * `aria-current` không mơ hồ); mount phải có trong registry, nên
 * `buildPublicNavigation` không bao giờ gặp mount lạ.
 */
export const PUBLIC_NAVIGATION: readonly PublicNavigationItem[] = Object.freeze(
  (NAVIGATION_DEFINITIONS as readonly PublicNavigationItem[]).map((item) =>
    Object.freeze({
      id: item.id,
      mount: item.mount,
      label: Object.freeze({ ...item.label }),
      ...(item.triggerPath === undefined ? {} : { triggerPath: item.triggerPath }),
      ...(item.groups === undefined
        ? {}
        : {
            groups: Object.freeze(
              item.groups.map((group) =>
                Object.freeze({
                  heading: Object.freeze({ ...group.heading }),
                  links: Object.freeze(
                    group.links.map((link) =>
                      Object.freeze({ ...link, label: Object.freeze({ ...link.label }) }),
                    ),
                  ),
                }),
              ),
            ),
          }),
    }),
  ),
);

/**
 * Dựng danh sách link navigation cho một locale, theo thứ tự hiển thị.
 *
 * Mọi `href` đi qua `buildPublicPath`; item không dựng được (chỉ xảy ra nếu
 * registry bị sửa sai ngoài ý muốn) bị bỏ qua thay vì trả href hỏng — không
 * có đường nào sinh URL bằng concatenation.
 */
export function buildPublicNavigation(locale: PublicLocale): readonly PublicNavigationLink[] {
  const links: PublicNavigationLink[] = [];
  for (const item of PUBLIC_NAVIGATION) {
    const built = buildPublicPath({ locale, mount: item.mount, path: item.triggerPath ?? '' });
    if (built.kind === 'invalid') {
      continue;
    }
    // Group có link không dựng được bị bỏ kèm item — panel mà trỏ link hỏng
    // thì tệ hơn là giảm còn link thường.
    const groups: { heading: string; links: readonly { label: string; href: string }[] }[] = [];
    let groupsValid = true;
    if (item.groups !== undefined) {
      for (const group of item.groups) {
        const groupLinks: { label: string; href: string }[] = [];
        for (const link of group.links) {
          const linkBuilt = buildPublicPath({ locale, mount: item.mount, path: link.path });
          if (linkBuilt.kind === 'invalid') {
            groupsValid = false;
            break;
          }
          groupLinks.push(Object.freeze({ label: link.label[locale], href: linkBuilt.path }));
        }
        if (!groupsValid) {
          break;
        }
        groups.push(
          Object.freeze({ heading: group.heading[locale], links: Object.freeze(groupLinks) }),
        );
      }
      if (!groupsValid) {
        continue;
      }
    }
    links.push(
      Object.freeze({
        id: item.id,
        mount: item.mount,
        label: item.label[locale],
        href: built.path,
        ...(item.groups === undefined ? {} : { groups: Object.freeze(groups) }),
      }),
    );
  }
  return Object.freeze(links);
}

/**
 * Một link trong footer — trỏ tới một mount (kèm `path` resource tùy chọn)
 * hoặc một locale-root (`mount: undefined`). `path` phải bắt đầu bằng `/`;
 * mọi href vẫn đi qua `buildPublicPath` nên path lạ bị loại khỏi kết quả
 * thay vì sinh URL hỏng.
 */
export type PublicFooterLink = {
  readonly mount: PublicMount | undefined;
  readonly label: Readonly<Record<PublicLocale, string>>;
  readonly path?: string;
};

/**
 * Một cột của footer: heading + các link con. Heading là
 * `Record<PublicLocale, string>` — thiếu locale là lỗi type.
 */
export type PublicFooterGroup = {
  readonly heading: Readonly<Record<PublicLocale, string>>;
  readonly links: readonly PublicFooterLink[];
};

/**
 * Footer groups — dữ liệu tĩnh, frozen, chỉ chứa destination **thực sự tồn
 * tại**: home locale-root, các public mount, các section docs đã có content
 * (`getting-started`, `concepts`, `guides`) và các page docs sâu hơn. Các
 * policy link KHÔNG nằm ở đây — chúng là hàng legal riêng
 * (`PUBLIC_FOOTER_LEGAL`), dùng chung nguồn `LEGAL_POLICY_LINKS` với mega
 * panel Legal của header. Không có link mạng xã hội — không có trang nào như
 * vậy, footer không bịa destination để lấp layout.
 */
const FOOTER_DEFINITIONS = [
  {
    heading: { en: 'Surfaces', vi: 'Bề mặt' },
    links: [
      { mount: undefined, label: { en: 'Home', vi: 'Trang chủ' } },
      { mount: 'docs', label: { en: 'Docs', vi: 'Docs' } },
      { mount: 'blog', label: { en: 'Blog', vi: 'Blog' } },
    ],
  },
  {
    heading: { en: 'Documentation', vi: 'Tài liệu' },
    links: [
      {
        mount: 'docs',
        path: '/getting-started',
        label: { en: 'Getting started', vi: 'Bắt đầu' },
      },
      { mount: 'docs', path: '/concepts', label: { en: 'Concepts', vi: 'Khái niệm' } },
      { mount: 'docs', path: '/guides', label: { en: 'Guides', vi: 'Hướng dẫn' } },
    ],
  },
  {
    heading: { en: 'Platform', vi: 'Nền tảng' },
    links: [
      {
        mount: 'docs',
        path: '/concepts/public-web',
        label: { en: 'Public web model', vi: 'Mô hình web public' },
      },
      {
        mount: 'docs',
        path: '/concepts/content-and-locales',
        label: { en: 'Content and locales', vi: 'Nội dung và ngôn ngữ' },
      },
      {
        mount: 'docs',
        path: '/getting-started/installation',
        label: { en: 'Installation', vi: 'Cài đặt' },
      },
      {
        mount: 'docs',
        path: '/guides/building-a-public-page',
        label: { en: 'Building a public page', vi: 'Xây dựng một trang công khai' },
      },
      {
        mount: 'docs',
        path: '/guides/local-development',
        label: { en: 'Local development', vi: 'Phát triển cục bộ' },
      },
    ],
  },
] as const satisfies readonly {
  heading: Record<PublicLocale, string>;
  links: readonly {
    mount: PublicMount | undefined;
    label: Record<PublicLocale, string>;
    path?: string;
  }[];
}[];

/**
 * Toàn bộ footer groups, frozen — dữ liệu duy nhất mô tả các cột footer.
 * Footer của shell render **heading + link text**, không render `<nav>`
 * wrapper (spec component ghim: footer không có navigation landmark; heading
 * h3 không phải nav).
 */
export const PUBLIC_FOOTER_GROUPS: readonly PublicFooterGroup[] = Object.freeze(
  FOOTER_DEFINITIONS.map((group) =>
    Object.freeze({
      heading: Object.freeze({ ...group.heading }),
      links: Object.freeze(group.links.map((link) => Object.freeze({ ...link }))),
    }),
  ),
);

/**
 * Hàng legal của footer — resolve từ cùng nguồn `LEGAL_POLICY_LINKS` với
 * header. Footer render hàng này ở đáy (cạnh copyright); phần tử đầu là
 * landing Legal Center (`/[locale]/legal`), các phần tử sau là policy
 * (`/[locale]/legal/<slug>`).
 */
export function buildPublicFooterLegal(
  locale: PublicLocale,
): readonly { readonly label: string; readonly href: string }[] {
  const links: { label: string; href: string }[] = [];
  for (const link of LEGAL_POLICY_LINKS) {
    const built = buildPublicPath({ locale, mount: 'legal', path: link.path });
    if (built.kind === 'invalid') {
      continue;
    }
    links.push(Object.freeze({ label: link.label[locale], href: built.path }));
  }
  return Object.freeze(links);
}

/**
 * Mô tả ngắn của brand trong footer — một câu, mô tả đúng bề mặt đang tồn
 * tại (public web hai locale), không hứa hẹn tính năng chưa có.
 */
export const PUBLIC_FOOTER_TAGLINE: Readonly<Record<PublicLocale, string>> = Object.freeze({
  en: 'The public surface of ecoma.io — English and Vietnamese, served from the edge.',
  vi: 'Bề mặt public của ecoma.io — English và tiếng Việt, phục vụ từ edge.',
});

/**
 * Dựng footer groups đã resolve cho một locale, theo thứ tự hiển thị.
 *
 * Mọi `href` đi qua `buildPublicPath`; item không dựng được (chỉ xảy ra nếu
 * registry bị sửa sai ngoài ý muốn) bị bỏ qua thay vì trả href hỏng — không
 * có đường nào sinh URL bằng concatenation. Heading và label đã là text của
 * locale; kết quả frozen từng phần.
 */
export function buildPublicFooterGroups(
  locale: PublicLocale,
): readonly { readonly heading: string; readonly links: readonly PublicFooterLinkResolved[] }[] {
  return Object.freeze(
    PUBLIC_FOOTER_GROUPS.map((group) => {
      const links: PublicFooterLinkResolved[] = [];
      for (const link of group.links) {
        const built =
          link.mount === undefined
            ? buildPublicPath({ locale })
            : buildPublicPath({ locale, mount: link.mount, path: link.path });
        if (built.kind === 'invalid') {
          continue;
        }
        links.push(Object.freeze({ label: link.label[locale], href: built.path }));
      }
      return Object.freeze({ heading: group.heading[locale], links: Object.freeze(links) });
    }),
  );
}

/** Footer link đã resolve cho một locale: text hiển thị + href canonical. */
export type PublicFooterLinkResolved = {
  readonly label: string;
  readonly href: string;
};
