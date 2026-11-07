import { describe, it, expect } from 'vitest';
import type { PublicLocale } from '../../i18n/index';
import {
  PUBLIC_FOOTER_GROUPS,
  PUBLIC_FOOTER_TAGLINE,
  PUBLIC_NAVIGATION,
  buildPublicFooterGroups,
  buildPublicFooterLegal,
  buildPublicNavigation,
  isPublicMount,
  parsePublicLayoutPath,
} from '../index';
import type { PublicMount } from './mount-registry';

describe('global public navigation', () => {
  it('declares exactly the global items in display order', () => {
    expect(PUBLIC_NAVIGATION.map((item) => item.id)).toEqual(['docs', 'blog', 'legal']);
    expect(PUBLIC_NAVIGATION.map((item) => item.mount)).toEqual(['docs', 'blog', 'legal']);
    expect(PUBLIC_NAVIGATION.map((item) => item.label)).toEqual([
      { en: 'Docs', vi: 'Docs' },
      { en: 'Blog', vi: 'Blog' },
      { en: 'Legal', vi: 'Pháp lý' },
    ]);
  });

  it('only references mounts that exist in the registry', () => {
    for (const item of PUBLIC_NAVIGATION) {
      expect(isPublicMount(item.mount)).toBe(true);
    }
  });

  it('gives every item a label for every locale', () => {
    for (const item of PUBLIC_NAVIGATION) {
      expect(Object.keys(item.label).toSorted()).toEqual(['en', 'vi']);
      for (const locale of ['en', 'vi'] as const) {
        expect(item.label[locale]).not.toBe('');
      }
    }
  });

  it('is frozen: collection and entries are immutable', () => {
    expect(Object.isFrozen(PUBLIC_NAVIGATION)).toBe(true);
    // Gom mọi đích freeze (item, label, groups, từng group + heading + link +
    // link.label) vào một mảng rồi assert .every — tránh no-conditional-expect.
    const nested = PUBLIC_NAVIGATION.flatMap((item) => [
      item,
      item.label,
      ...(item.groups ?? []).flatMap((group) => [
        group,
        group.heading,
        ...group.links.flatMap((link) => [link, link.label]),
      ]),
    ]);
    expect(nested.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(() => {
      // @ts-expect-error -- navigation là tĩnh readonly
      PUBLIC_NAVIGATION[0].mount = 'docs';
    }).toThrow(TypeError);
    expect(PUBLIC_NAVIGATION).toHaveLength(3);
  });

  it('declares groups only as real docs content paths', () => {
    // Group link trong nav data phải trỏ đúng resource docs đang tồn tại —
    // section index + page con; thiếu locale hay path lạ là lỗi data.
    const docs = PUBLIC_NAVIGATION.find((item) => item.id === 'docs');
    expect(docs?.groups?.map((group) => group.links.map((link) => link.path))).toEqual([
      ['/getting-started', '/getting-started/installation', '/getting-started/first-steps'],
      ['/concepts', '/concepts/public-web', '/concepts/content-and-locales'],
      ['/guides', '/guides/building-a-public-page', '/guides/local-development'],
    ]);
    for (const item of PUBLIC_NAVIGATION) {
      for (const group of item.groups ?? []) {
        expect(Object.keys(group.heading).toSorted()).toEqual(['en', 'vi']);
        for (const link of group.links) {
          expect(Object.keys(link.label)).toBeDefined();
          expect(Object.keys(link.label).toSorted()).toEqual(['en', 'vi']);
          // Mount root hợp lệ dùng path rỗng (`''` → `/[locale]/legal`);
          // mọi resource path khác phải là resource path chuẩn.
          expect(link.path === '' || link.path.startsWith('/')).toBe(true);
        }
      }
    }
  });

  it('gives the legal item the Legal Center landing as its trigger path', () => {
    // #116 thêm landing Legal Center tại `/[locale]/legal` — route thật, nên
    // trigger của item legal trỏ mount root (`''` → `/[locale]/legal`) thay vì
    // lệch sang policy đầu tiên.
    const legal = PUBLIC_NAVIGATION.find((item) => item.id === 'legal');
    expect(legal?.triggerPath).toBe('');
    // Các item khác (docs, blog) có landing ở mount root nên không cần
    // triggerPath — href mặc định đã là mount root.
    expect(PUBLIC_NAVIGATION.find((item) => item.id === 'docs')?.triggerPath).toBeUndefined();
    expect(PUBLIC_NAVIGATION.find((item) => item.id === 'blog')?.triggerPath).toBeUndefined();
  });

  it('shares one policy link source between the nav panel and the footer legal row', () => {
    // Panel legal của header và hàng legal của footer phải liệt kê đúng cùng
    // tập policy (cùng thứ tự) — hai bề mặt không tự giữ hai bản có nguy cơ
    // lệch nhau. Assert qua build functions ở cả hai locale.
    for (const locale of ['en', 'vi'] as const) {
      const navLegal = buildPublicNavigation(locale).find((link) => link.id === 'legal');
      const footerLegal = buildPublicFooterLegal(locale);
      expect(navLegal?.groups?.[0]?.links).toEqual(footerLegal);
      expect(footerLegal.map((link) => link.href)).toEqual([
        `/${locale}/legal`,
        `/${locale}/legal/privacy`,
        `/${locale}/legal/terms`,
        `/${locale}/legal/service-delivery`,
        `/${locale}/legal/payment`,
        `/${locale}/legal/refund`,
      ]);
    }
  });

  describe('buildPublicNavigation', () => {
    it('builds locale-aware hrefs for en, resolving declared groups', () => {
      expect(buildPublicNavigation('en')).toEqual([
        {
          id: 'docs',
          mount: 'docs',
          label: 'Docs',
          href: '/en/docs',
          groups: [
            {
              heading: 'Getting started',
              links: [
                { label: 'Getting started', href: '/en/docs/getting-started' },
                { label: 'Installation', href: '/en/docs/getting-started/installation' },
                { label: 'First steps', href: '/en/docs/getting-started/first-steps' },
              ],
            },
            {
              heading: 'Concepts',
              links: [
                { label: 'Concepts', href: '/en/docs/concepts' },
                { label: 'Public web', href: '/en/docs/concepts/public-web' },
                {
                  label: 'Content and locales',
                  href: '/en/docs/concepts/content-and-locales',
                },
              ],
            },
            {
              heading: 'Guides',
              links: [
                { label: 'Guides', href: '/en/docs/guides' },
                {
                  label: 'Building a public page',
                  href: '/en/docs/guides/building-a-public-page',
                },
                { label: 'Local development', href: '/en/docs/guides/local-development' },
              ],
            },
          ],
        },
        { id: 'blog', mount: 'blog', label: 'Blog', href: '/en/blog' },
        {
          id: 'legal',
          mount: 'legal',
          label: 'Legal',
          href: '/en/legal',
          groups: [
            {
              heading: 'Policies',
              links: [
                { label: 'Legal Center', href: '/en/legal' },
                { label: 'Privacy Policy', href: '/en/legal/privacy' },
                { label: 'Terms of Service', href: '/en/legal/terms' },
                { label: 'Service Delivery Policy', href: '/en/legal/service-delivery' },
                { label: 'Payment Policy', href: '/en/legal/payment' },
                { label: 'Refund Policy', href: '/en/legal/refund' },
              ],
            },
          ],
        },
      ]);
    });

    it('builds locale-aware hrefs for vi, resolving declared groups', () => {
      expect(buildPublicNavigation('vi')).toEqual([
        {
          id: 'docs',
          mount: 'docs',
          label: 'Docs',
          href: '/vi/docs',
          groups: [
            {
              heading: 'Bắt đầu',
              links: [
                { label: 'Bắt đầu', href: '/vi/docs/getting-started' },
                { label: 'Cài đặt', href: '/vi/docs/getting-started/installation' },
                { label: 'Các bước đầu tiên', href: '/vi/docs/getting-started/first-steps' },
              ],
            },
            {
              heading: 'Khái niệm',
              links: [
                { label: 'Khái niệm', href: '/vi/docs/concepts' },
                { label: 'Web công khai', href: '/vi/docs/concepts/public-web' },
                {
                  label: 'Nội dung và ngôn ngữ',
                  href: '/vi/docs/concepts/content-and-locales',
                },
              ],
            },
            {
              heading: 'Hướng dẫn',
              links: [
                { label: 'Hướng dẫn', href: '/vi/docs/guides' },
                {
                  label: 'Xây dựng một trang công khai',
                  href: '/vi/docs/guides/building-a-public-page',
                },
                { label: 'Phát triển cục bộ', href: '/vi/docs/guides/local-development' },
              ],
            },
          ],
        },
        { id: 'blog', mount: 'blog', label: 'Blog', href: '/vi/blog' },
        {
          id: 'legal',
          mount: 'legal',
          label: 'Pháp lý',
          href: '/vi/legal',
          groups: [
            {
              heading: 'Chính sách',
              links: [
                { label: 'Trung tâm Pháp lý', href: '/vi/legal' },
                { label: 'Chính sách bảo mật', href: '/vi/legal/privacy' },
                { label: 'Điều khoản dịch vụ', href: '/vi/legal/terms' },
                { label: 'Chính sách cung cấp dịch vụ', href: '/vi/legal/service-delivery' },
                { label: 'Chính sách thanh toán', href: '/vi/legal/payment' },
                { label: 'Chính sách hoàn tiền', href: '/vi/legal/refund' },
              ],
            },
          ],
        },
      ]);
    });

    it('produces hrefs that parse back to the same mount', () => {
      for (const locale of ['en', 'vi'] as const) {
        for (const link of buildPublicNavigation(locale)) {
          const parsed = parsePublicLayoutPath(link.href);
          expect(parsed).toMatchObject({ kind: 'localized', locale, mount: link.mount });
          for (const group of link.groups ?? []) {
            for (const entry of group.links) {
              const entryParsed = parsePublicLayoutPath(entry.href);
              expect(entryParsed).toMatchObject({ kind: 'localized', locale, mount: link.mount });
            }
          }
        }
      }
    });

    it('returns a frozen list of frozen links, group lists included', () => {
      const links = buildPublicNavigation('en');
      expect(Object.isFrozen(links)).toBe(true);
      // Gom mọi đích freeze vào một mảng rồi assert .every — tránh
      // no-conditional-expect (expect trong if/for).
      const nested = links.flatMap((link) => [
        link,
        ...(link.groups ?? []).flatMap((group) => [group, ...group.links]),
      ]);
      expect(nested.every((entry) => Object.isFrozen(entry))).toBe(true);
    });

    it('does not share mutable state between calls', () => {
      const first = buildPublicNavigation('en');
      const second = buildPublicNavigation('en');
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
      expect(PUBLIC_NAVIGATION).toHaveLength(3);
    });
  });

  describe('type safety', () => {
    it('labels are typed against the locale registry of app/i18n', () => {
      for (const item of PUBLIC_NAVIGATION) {
        expect(acceptsLocaleRecord(item.label)).not.toBe('');
      }
    });
  });
});

describe('footer groups', () => {
  it('declares only real destinations: registry mounts and docs sections', () => {
    /** Mount của mọi link, đã bỏ `undefined` (locale-root link không có mount). */
    const mounts: PublicMount[] = [];
    /** Path của mọi link có path — thu thập rồi assert độc lập với mount. */
    const paths: string[] = [];
    for (const group of PUBLIC_FOOTER_GROUPS) {
      for (const link of group.links) {
        if (link.mount !== undefined) {
          mounts.push(link.mount);
        }
        if (link.path !== undefined) {
          paths.push(link.path);
        }
      }
    }
    // Mọi mount không-undefined phải có trong registry.
    expect(mounts.every((mount) => isPublicMount(mount))).toBe(true);
    // Link có path chỉ tồn tại khi path là resource path chuẩn (bắt đầu bằng
    // `/`) — footer không sinh URL bằng concatenation.
    expect(paths.every((path) => path.startsWith('/'))).toBe(true);
    // Cột Documentation chỉ chứa ba section docs có content thật.
    const docsGroup = PUBLIC_FOOTER_GROUPS.find((group) => group.heading.en === 'Documentation');
    expect(docsGroup?.links.map((link) => link.path)).toEqual([
      '/getting-started',
      '/concepts',
      '/guides',
    ]);
    // Cột Platform chỉ chứa page docs thật (concept + guide + installation).
    const platformGroup = PUBLIC_FOOTER_GROUPS.find((group) => group.heading.en === 'Platform');
    expect(platformGroup?.links.map((link) => link.path)).toEqual([
      '/concepts/public-web',
      '/concepts/content-and-locales',
      '/getting-started/installation',
      '/guides/building-a-public-page',
      '/guides/local-development',
    ]);
    // Policy links KHÔNG nằm trong cột nào — chúng là hàng legal riêng.
    for (const group of PUBLIC_FOOTER_GROUPS) {
      expect(group.links.some((link) => link.mount === 'legal')).toBe(false);
    }
  });

  it('gives every heading and link a label for every locale', () => {
    for (const group of PUBLIC_FOOTER_GROUPS) {
      expect(Object.keys(group.heading).toSorted()).toEqual(['en', 'vi']);
      for (const link of group.links) {
        expect(Object.keys(link.label).toSorted()).toEqual(['en', 'vi']);
      }
    }
    expect(Object.keys(PUBLIC_FOOTER_TAGLINE).toSorted()).toEqual(['en', 'vi']);
  });

  it('is frozen: groups, headings and links are immutable', () => {
    expect(Object.isFrozen(PUBLIC_FOOTER_GROUPS)).toBe(true);
    for (const group of PUBLIC_FOOTER_GROUPS) {
      expect(Object.isFrozen(group)).toBe(true);
      expect(Object.isFrozen(group.heading)).toBe(true);
      expect(Object.isFrozen(group.links)).toBe(true);
    }
  });

  describe('buildPublicFooterGroups', () => {
    it('resolves headings and locale-aware hrefs for en', () => {
      expect(buildPublicFooterGroups('en')).toEqual([
        {
          heading: 'Surfaces',
          links: [
            { label: 'Home', href: '/en' },
            { label: 'Docs', href: '/en/docs' },
            { label: 'Blog', href: '/en/blog' },
          ],
        },
        {
          heading: 'Documentation',
          links: [
            { label: 'Getting started', href: '/en/docs/getting-started' },
            { label: 'Concepts', href: '/en/docs/concepts' },
            { label: 'Guides', href: '/en/docs/guides' },
          ],
        },
        {
          heading: 'Platform',
          links: [
            { label: 'Public web model', href: '/en/docs/concepts/public-web' },
            { label: 'Content and locales', href: '/en/docs/concepts/content-and-locales' },
            { label: 'Installation', href: '/en/docs/getting-started/installation' },
            {
              label: 'Building a public page',
              href: '/en/docs/guides/building-a-public-page',
            },
            { label: 'Local development', href: '/en/docs/guides/local-development' },
          ],
        },
      ]);
    });

    it('resolves headings and locale-aware hrefs for vi', () => {
      expect(buildPublicFooterGroups('vi')).toEqual([
        {
          heading: 'Bề mặt',
          links: [
            { label: 'Trang chủ', href: '/vi' },
            { label: 'Docs', href: '/vi/docs' },
            { label: 'Blog', href: '/vi/blog' },
          ],
        },
        {
          heading: 'Tài liệu',
          links: [
            { label: 'Bắt đầu', href: '/vi/docs/getting-started' },
            { label: 'Khái niệm', href: '/vi/docs/concepts' },
            { label: 'Hướng dẫn', href: '/vi/docs/guides' },
          ],
        },
        {
          heading: 'Nền tảng',
          links: [
            { label: 'Mô hình web public', href: '/vi/docs/concepts/public-web' },
            { label: 'Nội dung và ngôn ngữ', href: '/vi/docs/concepts/content-and-locales' },
            { label: 'Cài đặt', href: '/vi/docs/getting-started/installation' },
            {
              label: 'Xây dựng một trang công khai',
              href: '/vi/docs/guides/building-a-public-page',
            },
            { label: 'Phát triển cục bộ', href: '/vi/docs/guides/local-development' },
          ],
        },
      ]);
    });

    it('produces hrefs that parse back to the same locale and mount', () => {
      for (const locale of ['en', 'vi'] as const) {
        for (const group of buildPublicFooterGroups(locale)) {
          for (const link of group.links) {
            const parsed = parsePublicLayoutPath(link.href);
            expect(parsed).toMatchObject({ locale });
          }
        }
      }
    });

    it('returns frozen groups with frozen links', () => {
      const groups = buildPublicFooterGroups('en');
      expect(Object.isFrozen(groups)).toBe(true);
      for (const group of groups) {
        expect(Object.isFrozen(group)).toBe(true);
        expect(Object.isFrozen(group.links)).toBe(true);
        for (const link of group.links) {
          expect(Object.isFrozen(link)).toBe(true);
        }
      }
    });
  });

  describe('buildPublicFooterLegal', () => {
    it('resolves the Legal Center landing plus the five policy links for en', () => {
      expect(buildPublicFooterLegal('en')).toEqual([
        { label: 'Legal Center', href: '/en/legal' },
        { label: 'Privacy Policy', href: '/en/legal/privacy' },
        { label: 'Terms of Service', href: '/en/legal/terms' },
        { label: 'Service Delivery Policy', href: '/en/legal/service-delivery' },
        { label: 'Payment Policy', href: '/en/legal/payment' },
        { label: 'Refund Policy', href: '/en/legal/refund' },
      ]);
    });

    it('resolves the Legal Center landing plus the five policy links for vi', () => {
      expect(buildPublicFooterLegal('vi')).toEqual([
        { label: 'Trung tâm Pháp lý', href: '/vi/legal' },
        { label: 'Chính sách bảo mật', href: '/vi/legal/privacy' },
        { label: 'Điều khoản dịch vụ', href: '/vi/legal/terms' },
        { label: 'Chính sách cung cấp dịch vụ', href: '/vi/legal/service-delivery' },
        { label: 'Chính sách thanh toán', href: '/vi/legal/payment' },
        { label: 'Chính sách hoàn tiền', href: '/vi/legal/refund' },
      ]);
    });

    it('returns a frozen list of frozen links', () => {
      const links = buildPublicFooterLegal('vi');
      expect(Object.isFrozen(links)).toBe(true);
      expect(links.every((link) => Object.isFrozen(link))).toBe(true);
    });
  });
});

/** Nhận đúng shape `Record<PublicLocale, string>` — thiếu locale là lỗi type. */
function acceptsLocaleRecord(record: Readonly<Record<PublicLocale, string>>): string {
  return Object.values(record).join('');
}
