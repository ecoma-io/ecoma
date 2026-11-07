/**
 * Nội dung Home — localized, type-safe, **thuộc sở hữu của application**.
 *
 * Home tự sở hữu content của mình; `app/layout` chỉ sở hữu chrome dùng
 * chung (header/footer/navigation) và không biết content của Home. Cấu trúc
 * `Record<PublicLocale, HomeContent>` khiến việc thêm một locale vào
 * `app/i18n` mà thiếu bản dịch trở thành lỗi type ngay tại khai báo, không
 * phải lỗi runtime.
 *
 * Nội dung ở đây là copy **trung tính, mô tả đúng bề mặt đang tồn tại** —
 * không hứa hẹn tính năng chưa có, không số liệu, không claim sản phẩm suy
 * đoán. Cấu trúc section của trang (hero / categories / use cases /
 * developers / CTA kết) bám **cấu trúc hình ảnh** của mockup tham chiếu,
 * nhưng nội dung chỉ nói về những gì repo thật sự có: public web hai locale
 * (trang chủ, docs, blog, legal) phục vụ từ edge. `HomeContent` là dữ liệu
 * thuần (không hàm, không JSX/VNode) nên render được như nhau ở server và
 * client — cùng input cho cùng output, không hydration mismatch.
 */

import type { PublicLocale } from '../i18n/index';

/**
 * Một card danh mục trên homepage. `mount`/`path` là đích **thật** dưới
 * topology public (`PublicMount`); href được route dựng qua `buildPublicPath`
 * — data không tự sinh URL. `description` là một câu trung tính.
 */
export type HomeCategory = {
  /** Tên hiển thị của danh mục. */
  readonly title: string;
  /** Một câu mô tả trung tính, đúng bề mặt đang tồn tại. */
  readonly description: string;
  /** Mount đích của card — builder của `app/layout` dựng href từ đây. */
  readonly mount: 'docs' | 'blog' | 'legal';
  /** Resource path dưới mount, rỗng cho mount root. */
  readonly path: string;
};

/**
 * Một use case card — mỗi card là một khả năng thật của public web hiện tại,
 * không phải promise tính năng tương lai.
 */
export type HomeUseCase = {
  readonly title: string;
  readonly description: string;
};

/**
 * Nội dung một trang Home cho một locale.
 *
 * `readonly` ở mọi field: content là dữ liệu tĩnh, không phải mutable state.
 */
export type HomeContent = {
  /** Tiêu đề tài liệu (localized) — `document.title`. */
  readonly title: string;
  /** Eyebrow phía trên h1 — một cụm từ định vị ngắn. */
  readonly eyebrow: string;
  /** Tiêu đề chính của trang (một `<h1>` duy nhất). */
  readonly heading: string;
  /** Mô tả ngắn, một câu, dùng cho cả phần hero và meta description. */
  readonly description: string;
  /** Nhãn CTA hero trỏ tới docs — destination thật duy nhất của public web. */
  readonly docsCta: string;
  /** Nhãn CTA phụ hero trỏ tới blog. */
  readonly blogCta: string;
  /**
   * Proof items dưới hero — mỗi item là một **tính chất có thể xác minh** của
   * public web (locale-first URLs, prerendered content, edge delivery), không
   * phải số liệu (số user, uptime, SLA) vì không có nguồn nào trong repo để
   * xác minh chúng.
   */
  readonly heroProofs: readonly string[];
  /** Nội dung chính — các đoạn văn giới thiệu. */
  readonly intro: readonly string[];
  /** Nhãn khối giới thiệu nền tảng. */
  readonly platformLabel: string;
  /** Các điểm mô tả nền tảng, trung tính và đúng với bề mặt public hiện tại. */
  readonly platformPoints: readonly string[];
  /** Heading của khối danh mục + mô tả một dòng. */
  readonly categoriesLabel: string;
  readonly categoriesHeading: string;
  readonly categoriesDescription: string;
  /** Danh mục — cùng một schema cho mọi locale, href do route dựng. */
  readonly categories: readonly HomeCategory[];
  /** Heading của khối use cases + mô tả một dòng. */
  readonly useCasesLabel: string;
  readonly useCasesHeading: string;
  readonly useCasesDescription: string;
  readonly useCases: readonly HomeUseCase[];
  /** Heading của khối developers + các bullet checklist. */
  readonly developersLabel: string;
  readonly developersHeading: string;
  readonly developersDescription: string;
  readonly developersCta: string;
  /** Các bullet checklist của khối developers. */
  readonly developersPoints: readonly string[];
  /** Nội dung hiển thị trong code window (giả terminal, thuần trình bày). */
  readonly developersTerminal: {
    /** Nhãn nhỏ trên thanh tiêu đề của cửa sổ. */
    readonly label: string;
    /** Các dòng code/giả terminal — hiển thị đúng như dữ liệu, không syntax highlight. */
    readonly lines: readonly string[];
  };
  /** Heading của CTA kết + mô tả + nhãn hai nút. */
  readonly closingHeading: string;
  readonly closingDescription: string;
  readonly closingDocsCta: string;
  readonly closingBlogCta: string;
  /** Tiêu đề `<h1>` của trang lỗi 404 — render qua `app/error-pages`. */
  readonly notFoundTitle: string;
  /** Mô tả dưới tiêu đề của trang 404. */
  readonly notFoundDescription: string;
  /** Nhãn CTA của trang 404 — trỏ về locale-root của URL lỗi. */
  readonly notFoundCta: string;
};

/**
 * Nội dung Home cho mọi locale của registry.
 *
 * Khoá là `PublicLocale` nên thiếu bản dịch cho một locale là lỗi compile
 * time; không có nhánh fallback runtime và không có bảng locale thứ hai.
 */
export const HOME_CONTENT: Readonly<Record<PublicLocale, HomeContent>> = Object.freeze({
  en: Object.freeze({
    title: 'Ecoma.io — public home',
    eyebrow: 'The public platform of ecoma.io',
    heading: 'Public web, built right',
    description: 'The public home of ecoma.io, available in English and Vietnamese.',
    docsCta: 'Read the docs',
    blogCta: 'Visit the blog',
    heroProofs: Object.freeze([
      'Locale-first URLs — every page declares its language',
      'Content pages prerendered at build time',
      'Served from the edge as a Cloudflare Worker',
    ]),
    intro: Object.freeze([
      'This is the public landing surface of ecoma.io.',
      'Every page is served under a locale prefix, so a URL always names the language it renders in.',
    ]),
    platformLabel: 'About the platform',
    platformPoints: Object.freeze([
      'Public pages are served from the edge and rendered on the server.',
      'English and Vietnamese are first-class locales, each with its own stable URL.',
    ]),
    categoriesLabel: 'Explore',
    categoriesHeading: 'Start with a surface',
    categoriesDescription: 'The public web is a small set of surfaces, each with one clear job.',
    categories: Object.freeze([
      {
        title: 'Documentation',
        description:
          'How the platform is organized: URL model, content and locales, local development.',
        mount: 'docs',
        path: '',
      },
      {
        title: 'Getting started',
        description: 'Install the toolchain and take the first steps through the repository.',
        mount: 'docs',
        path: '/getting-started',
      },
      {
        title: 'Guides',
        description: 'Task-oriented walkthroughs: build a public page, run the dev loop.',
        mount: 'docs',
        path: '/guides',
      },
      {
        title: 'Concepts',
        description: 'The foundational ideas behind the public web platform.',
        mount: 'docs',
        path: '/concepts',
      },
      {
        title: 'Blog',
        description: 'Engineering notes on the URL model, content pipelines and locale switching.',
        mount: 'blog',
        path: '',
      },
      {
        title: 'Legal & policies',
        description: 'Privacy, terms, service delivery, payment and refund policies.',
        mount: 'legal' as const,
        path: '/privacy',
      },
    ] satisfies readonly HomeCategory[]),
    useCasesLabel: 'Use cases',
    useCasesHeading: 'What the public web does today',
    useCasesDescription: 'Concrete capabilities of the surfaces you can open right now.',
    useCases: Object.freeze([
      {
        title: 'Read documentation in two languages',
        description:
          'Every docs page has an English and a Vietnamese version, and the locale switcher only links to translations that exist.',
      },
      {
        title: 'Follow engineering writing',
        description:
          'The blog is a flat article list with featured posts, tags and related-article links — all resolved from real content.',
      },
      {
        title: 'Trust every URL',
        description:
          'Canonical URLs, two-way hreflang and strict path validation keep every page self-describing.',
      },
      {
        title: 'Read the policies',
        description:
          'Five policy pages — privacy, terms, service delivery, payment, refund — are served under the legal mount.',
      },
    ]),
    developersLabel: 'Developers',
    developersHeading: 'Run it locally in three commands',
    developersDescription:
      'The public app is one Nuxt workspace package. Clone the repository and the whole surface runs on your machine.',
    developersCta: 'Open the docs',
    developersPoints: Object.freeze([
      'Node.js 24+ and pnpm 12+, pinned in the repository',
      'Nx drives the loop: serve, test, build one project or the affected graph',
      'Content lives in Markdown under content/ — no database required to write',
      'The build emits a Cloudflare Worker plus prerendered content pages',
    ]),
    developersTerminal: Object.freeze({
      label: 'terminal',
      lines: Object.freeze([
        '$ pnpm install',
        '$ cd apps/home',
        '$ pnpm exec nuxt dev',
        '  ➜ Local: http://localhost:4200/en',
      ]),
    }),
    closingHeading: 'Start reading',
    closingDescription: 'Docs explain the platform; the blog shows how it is built.',
    closingDocsCta: 'Read the docs',
    closingBlogCta: 'Visit the blog',
    notFoundTitle: 'Page not found',
    notFoundDescription: 'The page you are looking for does not exist.',
    notFoundCta: 'Go to the homepage',
  }),
  vi: Object.freeze({
    title: 'Ecoma.io — trang chủ public',
    eyebrow: 'Nền tảng public của ecoma.io',
    heading: 'Web public, dựng cho đúng',
    description: 'Trang chủ public của ecoma.io, hiển thị bằng tiếng Anh và tiếng Việt.',
    docsCta: 'Đọc tài liệu',
    blogCta: 'Xem blog',
    heroProofs: Object.freeze([
      'URL ưu tiên locale — mọi trang khai báo ngôn ngữ của nó',
      'Trang content được prerender ngay lúc build',
      'Phục vụ từ edge qua một Cloudflare Worker',
    ]),
    intro: Object.freeze([
      'Đây là bề mặt public của ecoma.io.',
      'Mọi trang đều được phục vụ dưới một locale prefix, nên URL luôn nói rõ ngôn ngữ mà trang hiển thị.',
    ]),
    platformLabel: 'Về nền tảng',
    platformPoints: Object.freeze([
      'Các trang public được phục vụ từ edge và render ở server.',
      'Tiếng Anh và tiếng Việt đều là locale hạng nhất, mỗi locale có URL ổn định riêng.',
    ]),
    categoriesLabel: 'Khám phá',
    categoriesHeading: 'Bắt đầu từ một bề mặt',
    categoriesDescription: 'Web public là một tập bề mặt nhỏ, mỗi bề mặt một vai trò rõ ràng.',
    categories: Object.freeze([
      {
        title: 'Tài liệu',
        description: 'Cách nền tảng được tổ chức: mô hình URL, nội dung và ngôn ngữ, dev cục bộ.',
        mount: 'docs',
        path: '',
      },
      {
        title: 'Bắt đầu',
        description: 'Cài bộ công cụ và đi các bước đầu tiên trong repository.',
        mount: 'docs',
        path: '/getting-started',
      },
      {
        title: 'Hướng dẫn',
        description: 'Walkthrough theo tác vụ: dựng một trang public, chạy vòng lặp dev.',
        mount: 'docs',
        path: '/guides',
      },
      {
        title: 'Khái niệm',
        description: 'Các ý tưởng nền tảng của hệ thống web public.',
        mount: 'docs',
        path: '/concepts',
      },
      {
        title: 'Blog',
        description: 'Ghi chú kỹ thuật về mô hình URL, pipeline content và locale switching.',
        mount: 'blog',
        path: '',
      },
      {
        title: 'Pháp lý & chính sách',
        description: 'Chính sách bảo mật, điều khoản, cung cấp dịch vụ, thanh toán và hoàn tiền.',
        mount: 'legal' as const,
        path: '/privacy',
      },
    ] satisfies readonly HomeCategory[]),
    useCasesLabel: 'Trường hợp sử dụng',
    useCasesHeading: 'Web public làm được gì hôm nay',
    useCasesDescription: 'Khả năng cụ thể của những bề mặt bạn có thể mở ngay bây giờ.',
    useCases: Object.freeze([
      {
        title: 'Đọc tài liệu bằng hai ngôn ngữ',
        description:
          'Mỗi trang docs có bản tiếng Anh và tiếng Việt, và locale switcher chỉ link tới bản dịch tồn tại.',
      },
      {
        title: 'Theo dõi bài viết kỹ thuật',
        description:
          'Blog là danh sách phẳng với bài featured, tag và link bài liên quan — tất cả suy ra từ content thật.',
      },
      {
        title: 'Tin mọi URL',
        description:
          'Canonical URL, hreflang hai chiều và validate path nghiêm ngặt giữ cho mọi trang tự mô tả chính nó.',
      },
      {
        title: 'Đọc các chính sách',
        description:
          'Năm trang policy — bảo mật, điều khoản, cung cấp dịch vụ, thanh toán, hoàn tiền — nằm dưới mount legal.',
      },
    ]),
    developersLabel: 'Dành cho developer',
    developersHeading: 'Chạy cục bộ với ba lệnh',
    developersDescription:
      'App public là một package trong workspace Nuxt. Clone repository là toàn bộ bề mặt chạy trên máy bạn.',
    developersCta: 'Mở tài liệu',
    developersPoints: Object.freeze([
      'Node.js 24+ và pnpm 12+, được pin trong repository',
      'Nx điều phối vòng lặp: serve, test, build một project hoặc affected graph',
      'Content là Markdown dưới content/ — viết bài không cần database',
      'Build sinh ra một Cloudflare Worker kèm các trang content prerendered',
    ]),
    developersTerminal: Object.freeze({
      label: 'terminal',
      lines: Object.freeze([
        '$ pnpm install',
        '$ cd apps/home',
        '$ pnpm exec nuxt dev',
        '  ➜ Local: http://localhost:4200/vi',
      ]),
    }),
    closingHeading: 'Bắt đầu đọc',
    closingDescription: 'Docs giải thích nền tảng; blog cho thấy nó được dựng thế nào.',
    closingDocsCta: 'Đọc tài liệu',
    closingBlogCta: 'Xem blog',
    notFoundTitle: 'Không tìm thấy trang',
    notFoundDescription: 'Trang bạn tìm không tồn tại.',
    notFoundCta: 'Về trang chủ',
  }),
});
