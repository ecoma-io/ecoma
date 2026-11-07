import { describe, it, expect, expectTypeOf } from 'vitest';
import { PUBLIC_LOCALES, getLocaleDefinition, isPublicLocale } from '../index';
import type { PublicLocale, PublicLocaleDefinition } from '../index';
// Chiếu typeof vào đúng nguồn dữ liệu registry (export nội bộ, không qua
// entrypoint): test này chứng minh PublicLocale derive từ registry, không phải
// union viết tay trùng giá trị.
import { PUBLIC_LOCALE_DEFINITIONS } from './locale-registry';

describe('locale registry', () => {
  it('exposes exactly two locales in declaration order', () => {
    expect(PUBLIC_LOCALES.map((definition) => definition.code)).toEqual(['en', 'vi']);
  });

  it('PUBLIC_LOCALES mirrors the registry definitions exactly', () => {
    expect(PUBLIC_LOCALES).toEqual(PUBLIC_LOCALE_DEFINITIONS);
  });

  it('maps each locale to its hreflang (en -> en, vi -> vi-VN)', () => {
    expect(getLocaleDefinition('en')?.hreflang).toBe('en');
    expect(getLocaleDefinition('vi')?.hreflang).toBe('vi-VN');
  });

  it('returns the same frozen instance for every lookup', () => {
    expect(getLocaleDefinition('en')).toBe(getLocaleDefinition('en'));
    expect(getLocaleDefinition('vi')).toBe(getLocaleDefinition('vi'));
    expect(Object.isFrozen(getLocaleDefinition('en'))).toBe(true);
    expect(Object.isFrozen(getLocaleDefinition('vi'))).toBe(true);
  });

  it('returns undefined for unknown locales without throwing', () => {
    expect(getLocaleDefinition('fr')).toBeUndefined();
    expect(getLocaleDefinition('EN')).toBeUndefined();
    expect(getLocaleDefinition('')).toBeUndefined();
  });

  it('freezes the collection itself so the registry cannot be mutated', () => {
    expect(Object.isFrozen(PUBLIC_LOCALES)).toBe(true);
    expect(() => {
      // @ts-expect-error -- metadata là readonly policy, không phải mutable state
      PUBLIC_LOCALES[0].hreflang = 'x';
    }).toThrow(TypeError);
    expect(PUBLIC_LOCALES).toHaveLength(2);
  });

  it('keeps the registry unchanged after failed lookups', () => {
    getLocaleDefinition('fr');
    getLocaleDefinition('');
    expect(PUBLIC_LOCALES).toHaveLength(2);
    expect(PUBLIC_LOCALES.map((definition) => definition.code)).toEqual(['en', 'vi']);
  });

  describe('isPublicLocale', () => {
    it('narrows exact supported codes only', () => {
      expect(isPublicLocale('en')).toBe(true);
      expect(isPublicLocale('vi')).toBe(true);
    });

    it('rejects unsupported, uppercase and locale-shaped lookalikes', () => {
      expect(isPublicLocale('fr')).toBe(false);
      expect(isPublicLocale('EN')).toBe(false);
      expect(isPublicLocale('enabled')).toBe(false);
      expect(isPublicLocale('blog')).toBe(false);
      expect(isPublicLocale('')).toBe(false);
    });
  });

  describe('type safety', () => {
    it('PublicLocale is the closed union of registry codes', () => {
      expectTypeOf<PublicLocale>().toEqualTypeOf<'en' | 'vi'>();
    });

    it('derives PublicLocale from the registry data, not from a hand-written union', () => {
      type DerivedCode = (typeof PUBLIC_LOCALE_DEFINITIONS)[number]['code'];
      // PublicLocale === union các code trong PUBLIC_LOCALE_DEFINITIONS —
      // thêm một definition tại nguồn làm union rộng ra và test này cùng
      // expectTypeOf `'en' | 'vi'` bên trên fail, buộc cập nhật có chủ đích.
      expectTypeOf<PublicLocale>().toEqualTypeOf<DerivedCode>();
      expectTypeOf<DerivedCode>().toEqualTypeOf<'en' | 'vi'>();
    });

    it('every registry entry satisfies the public metadata shape', () => {
      expectTypeOf<(typeof PUBLIC_LOCALE_DEFINITIONS)[number]>().toExtend<
        Readonly<PublicLocaleDefinition>
      >();
    });

    it('metadata collection is readonly', () => {
      expectTypeOf(PUBLIC_LOCALES).toEqualTypeOf<readonly PublicLocaleDefinition[]>();
    });

    it('lookup accepts an untrusted string and returns a definition or undefined', () => {
      expectTypeOf(getLocaleDefinition).parameter(0).toEqualTypeOf<string>();
      expectTypeOf(getLocaleDefinition('fr')).toEqualTypeOf<PublicLocaleDefinition | undefined>();
    });
  });
});
