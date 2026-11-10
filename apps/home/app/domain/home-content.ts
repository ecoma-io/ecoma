/**
 * Nội dung Home — localized, type-safe, **thuộc sở hữu của application**.
 *
 * Home tự sở hữu content của mình; `app/layout` chỉ sở hữu chrome dùng
 * chung (header/footer) và không biết content của Home. Cấu trúc
 * `Record<PublicLocale, HomeContent>` khiến việc thêm một locale vào
 * `app/i18n` mà thiếu bản dịch trở thành lỗi type ngay tại khai báo, không
 * phải lỗi runtime.
 *
 * Nội dung ở đây là copy **trung tính, mô tả đúng bề mặt đang tồn tại** —
 * không hứa hẹn tính năng chưa có, không số liệu, không claim sản phẩm suy
 * đoán. Cấu trúc section của trang (hero / intro / platform / developers)
 * bám **cấu trúc hình ảnh** của mockup tham chiếu, nhưng nội dung chỉ nói
 * về những gì repo thật sự có: homepage locale-root hai locale phục vụ từ
 * edge. `HomeContent` là dữ liệu thuần (không hàm, không JSX/VNode) nên
 * render được như nhau ở server và client — cùng input cho cùng output,
 * không hydration mismatch.
 */

import type { PublicLocale } from '../i18n/index';

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
  /**
   * Proof items dưới hero — mỗi item là một **tính chất có thể xác minh** của
   * public web (locale-first URLs, prerendered homepage, edge delivery), không
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
  /** Heading của khối developers + các bullet checklist. */
  readonly developersLabel: string;
  readonly developersHeading: string;
  readonly developersDescription: string;
  /** Các bullet checklist của khối developers. */
  readonly developersPoints: readonly string[];
  /** Nội dung hiển thị trong code window (giả terminal, thuần trình bày). */
  readonly developersTerminal: {
    /** Nhãn nhỏ trên thanh tiêu đề của cửa sổ. */
    readonly label: string;
    /** Các dòng code/giả terminal — hiển thị đúng như dữ liệu, không syntax highlight. */
    readonly lines: readonly string[];
  };
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
    heroProofs: Object.freeze([
      'Locale-first URLs — every page declares its language',
      'Homepage prerendered at build time',
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
    developersLabel: 'Developers',
    developersHeading: 'Run it locally in three commands',
    developersDescription:
      'The public app is one Nuxt workspace package. Clone the repository and the whole surface runs on your machine.',
    developersPoints: Object.freeze([
      'Node.js 24+ and pnpm 12+, pinned in the repository',
      'Nx drives the loop: serve, test, build one project or the affected graph',
      'The build emits a Cloudflare Worker plus the prerendered homepage',
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
    notFoundTitle: 'Page not found',
    notFoundDescription: 'The page you are looking for does not exist.',
    notFoundCta: 'Go to the homepage',
  }),
  vi: Object.freeze({
    title: 'Ecoma.io — trang chủ public',
    eyebrow: 'Nền tảng public của ecoma.io',
    heading: 'Web public, dựng cho đúng',
    description: 'Trang chủ public của ecoma.io, hiển thị bằng tiếng Anh và tiếng Việt.',
    heroProofs: Object.freeze([
      'URL ưu tiên locale — mọi trang khai báo ngôn ngữ của nó',
      'Trang chủ được prerender ngay lúc build',
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
    developersLabel: 'Dành cho developer',
    developersHeading: 'Chạy cục bộ với ba lệnh',
    developersDescription:
      'App public là một package trong workspace Nuxt. Clone repository là toàn bộ bề mặt chạy trên máy bạn.',
    developersPoints: Object.freeze([
      'Node.js 24+ và pnpm 12+, được pin trong repository',
      'Nx điều phối vòng lặp: serve, test, build một project hoặc affected graph',
      'Build sinh ra một Cloudflare Worker kèm trang chủ được prerender',
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
    notFoundTitle: 'Không tìm thấy trang',
    notFoundDescription: 'Trang bạn tìm không tồn tại.',
    notFoundCta: 'Về trang chủ',
  }),
});
