import { describe, expect, it } from 'vitest';

import { parseHomeLocaleRoot } from './home-locale';

describe('parseHomeLocaleRoot', () => {
  it('accepts /en and /vi', () => {
    expect(parseHomeLocaleRoot('/en')).toBe('en');
    expect(parseHomeLocaleRoot('/vi')).toBe('vi');
  });

  it('rejects root `/` — `/` is the locale-resolution entry point, not the Home surface', () => {
    expect(parseHomeLocaleRoot('/')).toBeUndefined();
  });

  it('rejects trailing slash, following segment, wrong case, and encoded variants', () => {
    expect(parseHomeLocaleRoot('/en/')).toBeUndefined();
    expect(parseHomeLocaleRoot('/vi/')).toBeUndefined();
    expect(parseHomeLocaleRoot('/en/foo')).toBeUndefined();
    expect(parseHomeLocaleRoot('/EN')).toBeUndefined();
    expect(parseHomeLocaleRoot('/Vi')).toBeUndefined();
    expect(parseHomeLocaleRoot('/%65n')).toBeUndefined();
    expect(parseHomeLocaleRoot('/e%6E')).toBeUndefined();
  });

  it('rejects prefix/suffix confusion: //en, /%2Fen', () => {
    expect(parseHomeLocaleRoot('//en')).toBeUndefined();
    expect(parseHomeLocaleRoot('/%2Fen')).toBeUndefined();
  });

  it('rejects /en/foo/bar and /vi/x', () => {
    expect(parseHomeLocaleRoot('/en/foo/bar')).toBeUndefined();
    expect(parseHomeLocaleRoot('/vi/x')).toBeUndefined();
  });

  it('locale not in the registry → undefined', () => {
    expect(parseHomeLocaleRoot('/fr')).toBeUndefined();
    expect(parseHomeLocaleRoot('/de')).toBeUndefined();
  });
});
