import { describe, it, expect } from 'vitest';
import { PUBLIC_FOOTER_TAGLINE } from '../index';

/**
 * Navigation mounted (mega panel, footer groups, hàng legal) đã bị xoá cùng
 * stack @nuxt/content (issue #72): header chỉ còn brand + language switcher,
 * footer chỉ còn brand + tagline. Module còn đúng một dữ liệu public —
 * tagline — nên suite này ghim đúng contract còn lại.
 */
describe('public navigation data', () => {
  it('reduces to the footer tagline only', () => {
    // Contract còn lại của module: một hằng số duy nhất. Mọi dữ liệu mounted
    // mới (nếu có) phải đi kèm spec riêng — không được tái xuất hiện ngầm ở
    // đây.
    expect(PUBLIC_FOOTER_TAGLINE).toBeDefined();
  });

  it('gives the tagline a string for every locale', () => {
    expect(Object.keys(PUBLIC_FOOTER_TAGLINE).toSorted()).toEqual(['en', 'vi']);
    for (const locale of ['en', 'vi'] as const) {
      expect(PUBLIC_FOOTER_TAGLINE[locale]).not.toBe('');
    }
  });

  it('is frozen: the tagline record is immutable', () => {
    expect(Object.isFrozen(PUBLIC_FOOTER_TAGLINE)).toBe(true);
    expect(() => {
      // @ts-expect-error -- tagline là dữ liệu tĩnh readonly
      PUBLIC_FOOTER_TAGLINE.en = 'mutated';
    }).toThrow(TypeError);
  });

  it('describes the surface that actually exists', () => {
    // Copy trung tính, mô tả đúng bề mặt hiện tại (hai locale, edge) — không
    // hứa hẹn bề mặt chưa có.
    expect(PUBLIC_FOOTER_TAGLINE.en).toContain('ecoma.io');
    expect(PUBLIC_FOOTER_TAGLINE.vi).toContain('ecoma.io');
  });
});
