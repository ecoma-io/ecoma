import { describe, expect, it } from 'vitest';
import { DOCS_PRODUCTION_ORIGIN, toProductionUrl } from './docs-origin';

describe('DOCS_PRODUCTION_ORIGIN', () => {
  it('is the production origin with no trailing slash', () => {
    expect(DOCS_PRODUCTION_ORIGIN).toBe('https://ecoma.io');
  });
});

describe('toProductionUrl', () => {
  it('builds an absolute URL from a public pathname', () => {
    expect(toProductionUrl('/en/docs/getting-started')).toBe(
      'https://ecoma.io/en/docs/getting-started',
    );
    expect(toProductionUrl('/vi/docs')).toBe('https://ecoma.io/vi/docs');
  });

  it('keeps the canonical form: no trailing slash is added to the pathname', () => {
    expect(toProductionUrl('/en/docs')).not.toBe('https://ecoma.io/en/docs/');
    expect(new URL(toProductionUrl('/')).pathname).toBe('/');
  });

  it('rejects a pathname that escapes the production origin', () => {
    // `new URL` nuốt cả input tuyệt đối lẫn protocol-relative: không guard thì
    // `//attacker.example/en` trở thành canonical của kẻ khác.
    expect(() => toProductionUrl('//attacker.example/en')).toThrow(
      /escapes the production origin/u,
    );
    expect(() => toProductionUrl('https://attacker.example/en')).toThrow(
      /escapes the production origin/u,
    );
  });
});
