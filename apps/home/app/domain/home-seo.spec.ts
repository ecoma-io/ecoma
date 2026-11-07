import { describe, expect, it } from 'vitest';

import { buildHomeSeo } from './home-seo';
import { HOME_PRODUCTION_ORIGIN, toProductionUrl } from './home-origin';
import { PUBLIC_LOCALES } from '../i18n/index';

const enContent = {
  title: 'Ecoma.io — public home',
  description: 'The public home of ecoma.io, available in English and Vietnamese.',
};
const viContent = {
  title: 'Ecoma.io — trang chủ public',
  description: 'Trang chủ public của ecoma.io, hiển thị bằng tiếng Anh và tiếng Việt.',
};

describe('buildHomeSeo', () => {
  it('SEO for /en: lang=en, absolute canonical, alternates en + vi-VN absolute', () => {
    const seo = buildHomeSeo('en', enContent);
    expect(seo.lang).toBe('en');
    expect(seo.title).toBe(enContent.title);
    expect(seo.description).toBe(enContent.description);
    expect(seo.canonicalUrl).toBe('https://ecoma.io/en');
    expect(seo.alternates.length).toBe(PUBLIC_LOCALES.length);
    const enAlt = seo.alternates.find((a) => a.hreflang === 'en');
    const viAlt = seo.alternates.find((a) => a.hreflang === 'vi-VN');
    expect(enAlt?.href).toBe('https://ecoma.io/en');
    expect(viAlt?.href).toBe('https://ecoma.io/vi');
    expect(seo.alternates.every((a) => a.rel === 'alternate')).toBe(true);
  });

  it('SEO for /vi: lang=vi-VN, absolute canonical, full alternates', () => {
    const seo = buildHomeSeo('vi', viContent);
    expect(seo.lang).toBe('vi-VN');
    expect(seo.canonicalUrl).toBe('https://ecoma.io/vi');
    const enAlt = seo.alternates.find((a) => a.hreflang === 'en');
    const viAlt = seo.alternates.find((a) => a.hreflang === 'vi-VN');
    expect(enAlt?.href).toBe('https://ecoma.io/en');
    expect(viAlt?.href).toBe('https://ecoma.io/vi');
  });

  it('every URL is absolute and under the production origin', () => {
    // Canonical tương đối sẽ bị crawler resolve theo hostname đang phục vụ
    // (staging/preview/localhost), nên tính tuyệt đối + đúng origin là bất biến
    // của payload chứ không phải chi tiết trang trí.
    for (const locale of ['en', 'vi'] as const) {
      const seo = buildHomeSeo(locale, enContent);
      const urls = [seo.canonicalUrl, ...seo.alternates.map((a) => a.href)];
      for (const url of urls) {
        expect(url.startsWith(`${HOME_PRODUCTION_ORIGIN}/`)).toBe(true);
        expect(new URL(url).origin).toBe(HOME_PRODUCTION_ORIGIN);
        expect(new URL(url).protocol).toBe('https:');
      }
    }
  });

  it('alternates self-reference: each canonical record matches its own locale href', () => {
    // Google yêu cầu hreflang hai chiều kèm self-referencing; thiếu
    // self-reference thì cluster ngôn ngữ không đóng.
    const seoEn = buildHomeSeo('en', enContent);
    const seoVi = buildHomeSeo('vi', viContent);
    expect(seoEn.alternates.find((a) => a.hreflang === 'en')?.href).toBe(seoEn.canonicalUrl);
    expect(seoVi.alternates.find((a) => a.hreflang === 'vi-VN')?.href).toBe(seoVi.canonicalUrl);
  });

  it('payload is invariant to the request hostname', () => {
    // `buildHomeSeo` thuần `(locale, content)`: không nhận request, không đọc
    // hostname. Test này chốt bất biến đó ở mức API — chỉ locale + content đi
    // vào, và payload không thể chứa hostname nào khác production origin.
    const fromAnyEnvironment = buildHomeSeo('en', enContent);
    const serialized = JSON.stringify(fromAnyEnvironment);
    expect(serialized).not.toContain('localhost');
    expect(serialized).not.toContain('ecoma.io.vn');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('workers.dev');
    expect(fromAnyEnvironment).toEqual(buildHomeSeo('en', enContent));
  });

  it('alternates cover all of PUBLIC_LOCALES', () => {
    const seo = buildHomeSeo('en', enContent);
    const hreflangs = seo.alternates.map((a) => a.hreflang).toSorted();
    const expected = PUBLIC_LOCALES.map((d) => d.hreflang).toSorted();
    expect(hreflangs).toEqual(expected);
  });

  it('canonicalUrl is never / or a bare origin', () => {
    const seoEn = buildHomeSeo('en', enContent);
    const seoVi = buildHomeSeo('vi', viContent);
    for (const canonical of [seoEn.canonicalUrl, seoVi.canonicalUrl]) {
      expect(canonical).not.toBe('/');
      expect(canonical).not.toBe(HOME_PRODUCTION_ORIGIN);
      expect(canonical).not.toBe(`${HOME_PRODUCTION_ORIGIN}/`);
      expect(new URL(canonical).pathname).not.toBe('/');
    }
  });

  it('each locale has its own canonical — no two locales share a URL', () => {
    const seoEn = buildHomeSeo('en', enContent);
    const seoVi = buildHomeSeo('vi', viContent);
    expect(seoEn.canonicalUrl).not.toBe(seoVi.canonicalUrl);
  });

  it('deterministic: two calls with the same input yield identical results (stable SSR/SSG)', () => {
    // SSR/SSG cần output tất định: cùng locale + content phải ra cùng payload,
    // không phụ thuộc `Date`, thứ tự object, hay state ẩn.
    const first = buildHomeSeo('en', enContent);
    const second = buildHomeSeo('en', enContent);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not call Date/random: payload contains only declared fields', () => {
    const seo = buildHomeSeo('en', enContent);
    expect(Object.keys(seo).toSorted()).toEqual([
      'alternates',
      'canonicalUrl',
      'description',
      'lang',
      'title',
    ]);
  });
});

describe('toProductionUrl', () => {
  it('builds an absolute URL from a relative pathname', () => {
    expect(toProductionUrl('/en')).toBe('https://ecoma.io/en');
    expect(toProductionUrl('/vi')).toBe('https://ecoma.io/vi');
  });

  it('does not add a trailing slash to the pathname: /en and origin keep their canonical form', () => {
    expect(toProductionUrl('/en')).not.toBe('https://ecoma.io/en/');
    expect(new URL(toProductionUrl('/')).pathname).toBe('/');
  });

  it('rejects a pathname that escapes the production origin', () => {
    // `new URL` nuốt input tuyệt đối và protocol-relative: không guard thì
    // `//attacker.example/en` trở thành canonical của kẻ khác.
    expect(() => toProductionUrl('//attacker.example/en')).toThrow(
      /escapes the production origin/u,
    );
    expect(() => toProductionUrl('https://attacker.example/en')).toThrow(
      /escapes the production origin/u,
    );
  });
});
