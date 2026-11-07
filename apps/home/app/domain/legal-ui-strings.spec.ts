import { describe, expect, it } from 'vitest';

import { PUBLIC_LOCALES } from '../i18n/index';
import { legalUiStrings } from './legal-ui-strings';

/**
 * Dictionary UI của legal phải phủ mọi registry locale (type đã enforce) và
 * không có giá trị rỗng — label rỗng render thành nút/vùng rỗng, lỗi a11y
 * im lặng.
 */

describe('legalUiStrings', () => {
  it('resolves strings for every registry locale', () => {
    for (const definition of PUBLIC_LOCALES) {
      const strings = legalUiStrings(definition.code);
      expect(strings.legal.length, `locale ${definition.code}`).toBeGreaterThan(0);
    }
  });

  it('has no empty value in any locale dictionary', () => {
    for (const definition of PUBLIC_LOCALES) {
      for (const [key, value] of Object.entries(legalUiStrings(definition.code))) {
        expect(value.length, `${definition.code}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('localizes the surface name between locales', () => {
    // Hai locale không thể có dictionary trùng toàn bộ — nếu trùng thì một
    // bên quên dịch (với 'Blog' chung thì chấp nhận, nhưng 'Legal Center' /
    // 'Trung tâm Pháp lý' phải khác nhau).
    expect(legalUiStrings('en').legal).not.toBe(legalUiStrings('vi').legal);
  });

  it('gives the sidebar and the breadcrumb distinct landmark names in every locale', () => {
    // Bất biến JSDoc ngay trên dictionary chỉ là lời hứa bằng văn bản: prop có
    // kiểu `string` nên compiler không canh được. Assertion cũ ở `legal-page.spec.ts`
    // so hai thuộc tính của object literal định nghĩa **trong chính test đó** nên
    // luôn xanh — đổi hai chuỗi thật ở đây thành giống nhau vẫn không bị bắt.
    // Test này đọc dictionary thật nên mới thật sự canh được.
    for (const definition of PUBLIC_LOCALES) {
      const strings = legalUiStrings(definition.code);
      expect(strings.navigation, `locale ${definition.code}`).not.toBe(strings.breadcrumbs);
    }
  });
});
