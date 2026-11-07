import { isNonEmptyString, isPositiveSafeInteger, MAIL_CONTENT_TYPE } from './shared';

describe('shared utils', () => {
  it('isNonEmptyString trims correctly', () => {
    expect(isNonEmptyString('x')).toBe(true);
    expect(isNonEmptyString('  x  ')).toBe(true);
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString('   ')).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
  });

  it('isPositiveSafeInteger enforces positive integer', () => {
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(2)).toBe(true);
    expect(isPositiveSafeInteger(0)).toBe(false);
    expect(isPositiveSafeInteger(-1)).toBe(false);
    expect(isPositiveSafeInteger(1.5)).toBe(false);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it('content type constant', () => {
    expect(MAIL_CONTENT_TYPE).toBe('text/html');
  });
});
