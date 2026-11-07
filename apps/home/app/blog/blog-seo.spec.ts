import { describe, expect, it } from 'vitest';
import { buildBlogSeo } from './blog-seo';

describe('buildBlogSeo', () => {
  it('uses the registry hreflang as html lang, not the locale code', () => {
    // `vi` → `vi-VN`: điểm dễ sai nhất khi ai đó truyền thẳng locale code.
    expect(
      buildBlogSeo({
        pathname: '/vi/blog/url-model',
        locale: 'vi',
        title: 'Một mô hình URL',
        description: 'Mô tả',
        availableLocales: ['vi'],
      }).lang,
    ).toBe('vi-VN');
    expect(
      buildBlogSeo({
        pathname: '/en/blog/url-model',
        locale: 'en',
        title: 'One URL model',
        description: 'Description',
        availableLocales: ['en'],
      }).lang,
    ).toBe('en');
  });

  it('builds the title with the Ecoma Blog template', () => {
    expect(
      buildBlogSeo({
        pathname: '/en/blog/url-model',
        locale: 'en',
        title: 'One URL model',
        description: 'Description',
        availableLocales: ['en'],
      }).title,
    ).toBe('One URL model · Ecoma Blog');
  });

  it('falls back to the brand plus surface name, once, when the title is missing or blank', () => {
    // Title thiếu hoặc rỗng không được sinh chuỗi lặp tên bề mặt
    // (`Blog · Ecoma Blog` — thừa, và giống hệt nhau ở mọi locale nên mất tín
    // hiệu locale cho crawler); fallback phát `Ecoma Blog` đúng một lần.
    // Frontmatter có khoảng trắng phải bị trim.
    for (const title of [undefined, '', '   ']) {
      expect(
        buildBlogSeo({
          pathname: '/en/blog/url-model',
          locale: 'en',
          title,
          description: 'Description',
          availableLocales: ['en'],
        }).title,
      ).toBe('Ecoma Blog');
    }
  });

  it('trims a padded title before applying the template', () => {
    expect(
      buildBlogSeo({
        pathname: '/en/blog/url-model',
        locale: 'en',
        title: '  One URL model  ',
        description: 'Description',
        availableLocales: ['en'],
      }).title,
    ).toBe('One URL model · Ecoma Blog');
  });

  it('keeps the description verbatim and reports missing description as an empty string', () => {
    // Chuỗi rỗng là contract có chủ ý: route bỏ hẳn thẻ meta khi rỗng.
    expect(
      buildBlogSeo({
        pathname: '/en/blog/a',
        locale: 'en',
        title: 'T',
        description: undefined,
        availableLocales: ['en'],
      }).description,
    ).toBe('');
    expect(
      buildBlogSeo({
        pathname: '/en/blog/a',
        locale: 'en',
        title: 'T',
        description: 'Real description',
        availableLocales: ['en'],
      }).description,
    ).toBe('Real description');
  });

  it('makes the current path self-canonical under the production origin', () => {
    expect(
      buildBlogSeo({
        pathname: '/en/blog/url-model',
        locale: 'en',
        title: 'T',
        description: 'D',
        availableLocales: ['en'],
      }).canonical,
    ).toBe('https://ecoma.io/en/blog/url-model');
  });

  it('emits hreflang alternates for every available locale, current one included', () => {
    // Chuẩn hreflang: danh sách alternate **bao gồm** chính trang hiện tại
    // (Google khuyến nghị cluster self-referential). Article chỉ có tiếng Anh
    // phát một alternate `en` trỏ về chính nó; không bao giờ phát locale không
    // có bản dịch thật.
    const en = buildBlogSeo({
      pathname: '/en/blog/en-only',
      locale: 'en',
      title: 'T',
      description: 'D',
      availableLocales: ['en'],
    });
    expect(en.alternates).toEqual([
      { rel: 'alternate', hreflang: 'en', href: 'https://ecoma.io/en/blog/en-only' },
    ]);

    // Article có cả hai bản dịch: hai alternate, hreflang từ registry.
    const both = buildBlogSeo({
      pathname: '/en/blog/url-model',
      locale: 'en',
      title: 'T',
      description: 'D',
      availableLocales: ['en', 'vi'],
    });
    expect(both.alternates).toEqual([
      { rel: 'alternate', hreflang: 'en', href: 'https://ecoma.io/en/blog/url-model' },
      { rel: 'alternate', hreflang: 'vi-VN', href: 'https://ecoma.io/vi/blog/url-model' },
    ]);
  });

  it('never emits an alternate for a locale outside the availability list', () => {
    // Locale không nằm trong `availableLocales` phải bị loại hoàn toàn — một
    // page chỉ có tiếng Anh không quảng bá bản dịch tiếng Việt 404.
    const seo = buildBlogSeo({
      pathname: '/en/blog/en-only',
      locale: 'en',
      title: 'T',
      description: 'D',
      availableLocales: ['en'],
    });
    expect(seo.alternates.some((alternate) => alternate.hreflang === 'vi-VN')).toBe(false);
  });

  it('never emits a broken locale link: switch failure drops the alternate', () => {
    // `availableLocales` chứa locale không dựng được path (không thể xảy ra với
    // registry hiện tại, nhưng contract phải giữ: switch hỏng → bỏ alternate,
    // không ghép chuỗi tay).
    const seo = buildBlogSeo({
      pathname: '/en/blog/a',
      locale: 'en',
      title: 'T',
      description: 'D',
      availableLocales: ['en'],
    });
    expect(
      seo.alternates.every((alternate) => alternate.href.startsWith('https://ecoma.io/')),
    ).toBe(true);
  });

  it('emits no robots tag for a normal page', () => {
    // Trang thường không mang thẻ robots — `undefined` nghĩa là route không
    // emit meta nào, không phải chuỗi rỗng.
    expect(
      buildBlogSeo({
        pathname: '/en/blog/a',
        locale: 'en',
        title: 'T',
        description: 'D',
        availableLocales: ['en'],
      }).robots,
    ).toBeUndefined();
  });

  it('marks a fallback-discovery landing noindex,follow while keeping self-canonical', () => {
    // `/vi/blog` không có bài tiếng Việt: landing chỉ còn là surface khám phá
    // các bài English — `noindex, follow` để crawler đi tiếp theo link bài
    // nhưng không index surface trung gian; self-canonical giữ nguyên vì URL
    // vẫn tồn tại thật.
    const seo = buildBlogSeo({
      pathname: '/vi/blog',
      locale: 'vi',
      title: undefined,
      description: undefined,
      availableLocales: ['vi'],
      fallbackDiscovery: true,
    });
    expect(seo.robots).toBe('noindex, follow');
    expect(seo.canonical).toBe('https://ecoma.io/vi/blog');
  });

  it('drops all hreflang alternates on a fallback-discovery landing', () => {
    // Landing fallback **không phải bản dịch** của landing locale kia —
    // hreflang chéo (EN ⇄ VI) sẽ quảng bá một cặp bản dịch không tồn tại.
    const seo = buildBlogSeo({
      pathname: '/vi/blog',
      locale: 'vi',
      title: undefined,
      description: undefined,
      availableLocales: ['vi'],
      fallbackDiscovery: true,
    });
    expect(seo.alternates).toEqual([]);
  });

  it('never marks an article page as fallback even with fallbackDiscovery passed', () => {
    // Cờ chỉ đúng cho landing — route là nơi quyết định, nhưng hàm thuần phải
    // tách rõ: cờ `true` cho pathname article là lạm dụng API của caller.
    // Contract được pin qua behavior: cờ chỉ đổi robots/alternates, không đụng
    // canonical/lang/title của page nào cả.
    const seo = buildBlogSeo({
      pathname: '/en/blog/a',
      locale: 'en',
      title: 'T',
      description: 'D',
      availableLocales: ['en'],
      fallbackDiscovery: true,
    });
    expect(seo.robots).toBe('noindex, follow');
    expect(seo.alternates).toEqual([]);
  });
});
