import { describe, expect, it } from 'vitest';
import { BLOG_PRODUCTION_ORIGIN, toProductionUrl } from './blog-origin';

describe('BLOG_PRODUCTION_ORIGIN', () => {
  it('is the production origin with no trailing slash', () => {
    expect(BLOG_PRODUCTION_ORIGIN).toBe('https://ecoma.io');
  });
});

describe('toProductionUrl', () => {
  it('builds an absolute URL from a public pathname', () => {
    expect(toProductionUrl('/en/blog/url-model')).toBe('https://ecoma.io/en/blog/url-model');
    expect(toProductionUrl('/vi/blog')).toBe('https://ecoma.io/vi/blog');
  });

  it('keeps the canonical form: no trailing slash is added to the pathname', () => {
    expect(toProductionUrl('/en/blog')).not.toBe('https://ecoma.io/en/blog/');
    expect(new URL(toProductionUrl('/')).pathname).toBe('/');
  });

  it('rejects a pathname that escapes the production origin', () => {
    // `new URL` nuốt cả input tuyệt đối lẫn protocol-relative: không guard thì
    // `//attacker.example/en/blog` trở thành canonical của kẻ khác.
    expect(() => toProductionUrl('//attacker.example/en/blog')).toThrow(
      /escapes the production origin/u,
    );
    expect(() => toProductionUrl('https://attacker.example/en/blog')).toThrow(
      /escapes the production origin/u,
    );
  });
});
