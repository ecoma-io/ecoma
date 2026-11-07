import { describe, expect, it } from 'vitest';

import { buildLegalSeo } from './legal-seo';

/**
 * Bất biến SEO của bề mặt legal — tách khỏi route để test mà không cần dựng
 * Nuxt runtime. Khác bản cũ: hreflang chỉ sinh cho locale **có bản dịch thật**
 * (`availableLocales` do route resolve bằng query), không còn "phủ toàn bộ
 * registry" — content Markdown cho phép bản dịch thiếu, và hreflang trỏ 404
 * là metadata sai.
 */

describe('buildLegalSeo', () => {
  it('emits BCP-47 lang, self-canonical under the production origin, and title/description passthrough', () => {
    const seo = buildLegalSeo({
      pathname: '/vi/legal/privacy',
      locale: 'vi',
      title: 'Chính sách bảo mật — ecoma.io',
      description: 'Cách ecoma.io thu thập, sử dụng và bảo vệ dữ liệu cá nhân.',
      availableLocales: ['vi', 'en'],
    });
    expect(seo.lang).toBe('vi-VN');
    expect(seo.canonicalUrl).toBe('https://ecoma.io/vi/legal/privacy');
    expect(seo.title).toBe('Chính sách bảo mật — ecoma.io');
    expect(seo.description).toBe('Cách ecoma.io thu thập, sử dụng và bảo vệ dữ liệu cá nhân.');
  });

  it('emits hreflang only for locales with a real translation', () => {
    const seo = buildLegalSeo({
      pathname: '/en/legal/privacy',
      locale: 'en',
      title: 'Privacy Policy — ecoma.io',
      description: 'How ecoma.io collects, uses and protects personal data.',
      // Chỉ EN có bản dịch thật — hreflang VI (và self-reference EN) là đúng;
      // một locale thiếu bản dịch không được quảng bá.
      availableLocales: ['en'],
    });
    expect(seo.alternates).toEqual([
      { rel: 'alternate', hreflang: 'en', href: 'https://ecoma.io/en/legal/privacy' },
    ]);
  });

  it('emits bidirectional alternates with self-reference when both translations exist', () => {
    const seo = buildLegalSeo({
      pathname: '/en/legal/terms',
      locale: 'en',
      title: 'Terms of Service — ecoma.io',
      description: 'The terms that govern your use of ecoma.io services.',
      availableLocales: ['en', 'vi'],
    });
    expect(seo.alternates).toEqual([
      { rel: 'alternate', hreflang: 'en', href: 'https://ecoma.io/en/legal/terms' },
      { rel: 'alternate', hreflang: 'vi-VN', href: 'https://ecoma.io/vi/legal/terms' },
    ]);
  });

  it('emits the en hreflang tag as bare "en" and canonical never reads the request host', () => {
    const seo = buildLegalSeo({
      pathname: '/en/legal/refund',
      locale: 'en',
      title: 'Refund Policy — ecoma.io',
      description: 'When and how ecoma.io issues refunds.',
      availableLocales: ['en'],
    });
    expect(seo.lang).toBe('en');
    // Origin là hằng số policy — một pathname bất kỳ luôn resolve dưới
    // `https://ecoma.io`, không có tham số host nào.
    expect(seo.canonicalUrl.startsWith('https://ecoma.io/')).toBe(true);
  });
});
