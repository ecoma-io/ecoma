import { describe, expect, it } from 'vitest';
import { PUBLIC_LOCALES } from '../i18n/index';
import { blogUiStrings } from './blog-ui-strings';

describe('blogUiStrings', () => {
  it('returns a complete dictionary for every registry locale', () => {
    // Thêm locale vào registry mà thiếu bản dịch là lỗi type tại khai báo;
    // test này pin thêm mặt runtime: dictionary trả về đầy đủ field và khác
    // rỗng cho mọi locale.
    for (const definition of PUBLIC_LOCALES) {
      const strings = blogUiStrings(definition.code);
      for (const value of Object.values(strings)) {
        expect(value, `${definition.code}: ${String(value)}`).not.toBe('');
      }
    }
  });

  it('gives the pagination nav a distinct accessible name from the global navigation', () => {
    // `<nav>` prev/next và global nav của shell cùng tồn tại trên một page;
    // hai accessible name trùng nhau làm screen reader không phân biệt được.
    for (const definition of PUBLIC_LOCALES) {
      const strings = blogUiStrings(definition.code);
      expect(strings.pagination).not.toBe(strings.blog);
    }
  });

  it('returns the same frozen instance for repeated calls of one locale', () => {
    expect(blogUiStrings('en')).toBe(blogUiStrings('en'));
    expect(blogUiStrings('vi')).toBe(blogUiStrings('vi'));
  });
});
