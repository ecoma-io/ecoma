import { describe, it, expect } from 'vitest';
import type { PublicLocale } from '../../i18n/index';
import { resolveLocaleContext } from '../index';

describe('resolveLocaleContext', () => {
  it('returns every registry locale when availability is omitted', () => {
    // Behavior mặc định: không giới hạn availability → toàn bộ registry.
    expect(resolveLocaleContext('en')).toEqual({
      current: 'en',
      availableLocales: ['en', 'vi'],
    });
    expect(resolveLocaleContext('vi')).toEqual({
      current: 'vi',
      availableLocales: ['en', 'vi'],
    });
  });

  it('keeps a single available locale', () => {
    expect(resolveLocaleContext('en', ['en'])).toEqual({
      current: 'en',
      availableLocales: ['en'],
    });
  });

  it('keeps multiple available locales', () => {
    expect(resolveLocaleContext('en', ['en', 'vi'])).toEqual({
      current: 'en',
      availableLocales: ['en', 'vi'],
    });
  });

  it('always includes the current locale when the app omits it', () => {
    // Invariant: current luôn hợp lệ trong context, kể cả availability không liệt kê.
    expect(resolveLocaleContext('vi', ['en'])).toEqual({
      current: 'vi',
      availableLocales: ['en', 'vi'],
    });
  });

  it('always includes the current locale when availability is empty', () => {
    expect(resolveLocaleContext('en', [])).toEqual({
      current: 'en',
      availableLocales: ['en'],
    });
  });

  it('drops values outside the locale registry instead of throwing', () => {
    // Kế thừa contract `app/i18n`: so khớp exact, giá trị lạ bị loại.
    const invalid = ['en', 'de', 'EN', 'enabled'] as unknown as readonly PublicLocale[];
    expect(resolveLocaleContext('en', invalid)).toEqual({
      current: 'en',
      availableLocales: ['en'],
    });
  });

  it('deduplicates repeated entries', () => {
    expect(resolveLocaleContext('en', ['en', 'vi', 'en'])).toEqual({
      current: 'en',
      availableLocales: ['en', 'vi'],
    });
  });

  it('returns results in registry declaration order regardless of input order', () => {
    expect(resolveLocaleContext('vi', ['vi', 'en']).availableLocales).toEqual(['en', 'vi']);
  });

  it('freezes the returned context', () => {
    const context = resolveLocaleContext('en', ['en']);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.availableLocales)).toBe(true);
  });
});
