import { describe, expect, it } from 'vitest';
import { buildDocsSeo } from './docs-seo';

describe('docs SEO head', () => {
  it('uses the registry hreflang for lang, not the locale code', () => {
    // `vi` → `vi-VN`: dùng `locale` code trực tiếp là lỗi dễ mắc nhất ở đây.
    expect(
      buildDocsSeo({
        pathname: '/vi/docs/getting-started/installation',
        locale: 'vi',
        title: 'Cài đặt',
        description: 'Mô tả',
        availableLocales: ['vi'],
      }).lang,
    ).toBe('vi-VN');

    expect(
      buildDocsSeo({
        pathname: '/en/docs/getting-started/installation',
        locale: 'en',
        title: 'Installation',
        description: 'Description',
        availableLocales: ['en'],
      }).lang,
    ).toBe('en');
  });

  it('templates the title from the page title and the localized surface name', () => {
    expect(
      buildDocsSeo({
        pathname: '/en/docs/getting-started/installation',
        locale: 'en',
        title: 'Installation',
        description: 'Description',
        availableLocales: ['en'],
      }).title,
    ).toBe('Installation · Ecoma Documentation');

    expect(
      buildDocsSeo({
        pathname: '/vi/docs/getting-started/installation',
        locale: 'vi',
        title: 'Cài đặt',
        description: 'Mô tả',
        availableLocales: ['vi'],
      }).title,
    ).toBe('Cài đặt · Ecoma Tài liệu');
  });

  it('falls back to the localized surface name when the title is missing', () => {
    // Title thiếu là hợp lệ (frontmatter không bắt buộc): fallback phải sang
    // tên bề mặt đã localized, không sinh separator lơ lửng đầu chuỗi.
    expect(
      buildDocsSeo({
        pathname: '/en/docs/getting-started/installation',
        locale: 'en',
        title: undefined,
        description: 'Description',
        availableLocales: ['en'],
      }).title,
    ).toBe('Documentation · Ecoma Documentation');

    expect(
      buildDocsSeo({
        pathname: '/vi/docs/getting-started/installation',
        locale: 'vi',
        title: undefined,
        description: 'Mô tả',
        availableLocales: ['vi'],
      }).title,
    ).toBe('Tài liệu · Ecoma Tài liệu');
  });

  it('treats a whitespace-only title as missing', () => {
    expect(
      buildDocsSeo({
        pathname: '/en/docs/getting-started/installation',
        locale: 'en',
        title: '   ',
        description: 'Description',
        availableLocales: ['en'],
      }).title,
    ).toBe('Documentation · Ecoma Documentation');
  });

  it('trims surrounding whitespace from the page title', () => {
    expect(
      buildDocsSeo({
        pathname: '/en/docs/getting-started/installation',
        locale: 'en',
        title: '  Installation  ',
        description: 'Description',
        availableLocales: ['en'],
      }).title,
    ).toBe('Installation · Ecoma Documentation');
  });

  it('takes the description from the document frontmatter', () => {
    expect(
      buildDocsSeo({
        pathname: '/en/docs/getting-started/installation',
        locale: 'en',
        title: 'Installation',
        description: 'Prerequisites and local development overview.',
        availableLocales: ['en'],
      }).description,
    ).toBe('Prerequisites and local development overview.');
  });

  it('falls back to an empty description when the page declares none', () => {
    expect(
      buildDocsSeo({
        pathname: '/en/docs/getting-started/installation',
        locale: 'en',
        title: 'Installation',
        description: undefined,
        availableLocales: ['en'],
      }).description,
    ).toBe('');
  });

  it('canonicalises each page to its own absolute URL', () => {
    expect(
      buildDocsSeo({
        pathname: '/en/docs/getting-started/installation',
        locale: 'en',
        title: 'Installation',
        description: 'Description',
        availableLocales: ['en'],
      }).canonical,
    ).toBe('https://ecoma.io/en/docs/getting-started/installation');
  });

  it('emits both hreflang alternates when both locales have the resource', () => {
    const { alternates } = buildDocsSeo({
      pathname: '/en/docs/getting-started/installation',
      locale: 'en',
      title: 'Installation',
      description: 'Description',
      availableLocales: ['en', 'vi'],
    });

    expect(alternates).toEqual([
      {
        rel: 'alternate',
        hreflang: 'en',
        href: 'https://ecoma.io/en/docs/getting-started/installation',
      },
      {
        rel: 'alternate',
        hreflang: 'vi-VN',
        href: 'https://ecoma.io/vi/docs/getting-started/installation',
      },
    ]);
  });

  it('never advertises a translation that does not exist', () => {
    // Page chỉ có tiếng Anh: hreflang `vi-VN` sẽ trỏ tới một URL 404.
    const { alternates } = buildDocsSeo({
      pathname: '/en/docs/getting-started/installation',
      locale: 'en',
      title: 'Installation',
      description: 'Description',
      availableLocales: ['en'],
    });

    expect(alternates.map((alternate) => alternate.hreflang)).toEqual(['en']);
  });

  it('switches locale through the i18n contract, keeping the resource path', () => {
    const { alternates } = buildDocsSeo({
      pathname: '/vi/docs/guides/building-a-public-page',
      locale: 'vi',
      title: 'Xây dựng một public page',
      description: 'Mô tả',
      availableLocales: ['en', 'vi'],
    });

    const english = alternates.find((alternate) => alternate.hreflang === 'en');
    expect(english?.href).toBe('https://ecoma.io/en/docs/guides/building-a-public-page');
  });

  it('builds the docs landing canonical without a trailing segment', () => {
    expect(
      buildDocsSeo({
        pathname: '/en/docs',
        locale: 'en',
        title: 'Ecoma Documentation',
        description: 'Description',
        availableLocales: ['en'],
      }).canonical,
    ).toBe('https://ecoma.io/en/docs');
  });
});
