/**
 * Bất biến của locale registry và thứ tự ưu tiên locale.
 *
 * ⚠️ Hai luật ở đây là bất biến sản phẩm, không phải chi tiết hiện thực:
 *
 * 1. **Giá trị lạ không được im lặng thành locale khác.** `parseAccountLocale` trả
 *    `undefined` cho giá trị không hợp lệ, không trả `DEFAULT_ACCOUNT_LOCALE`. Trả
 *    default ở đây sẽ biến "server trả `fr`" thành "người dùng đang đọc tiếng Anh",
 *    xoá mất dấu vết của một lỗi contract — đúng thứ FR-008a cấm phía server.
 * 2. **Không có prefix locale trong URL.** `/emails` là `/emails` ở cả ba ngôn ngữ,
 *    nên `AccountLocale` không bao giờ được ghép vào một `to` của nav hay link.
 */
import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_LOCALES,
  DEFAULT_ACCOUNT_LOCALE,
  getAccountLocaleDefinition,
  isAccountLocale,
  parseAccountLocale,
  type AccountLocaleDefinition,
} from './locale-registry';

describe('locale registry', () => {
  it('defaults to English', () => {
    expect(DEFAULT_ACCOUNT_LOCALE).toBe('en');
  });

  it('offers English, Vietnamese, and Simplified Chinese', () => {
    expect(ACCOUNT_LOCALES.map((definition) => definition.label)).toEqual([
      'English',
      'Tiếng Việt',
      '简体中文',
    ]);
  });

  it('distinguishes the locale code from the BCP-47 language tag', () => {
    // `zh-CN` là giá trị hợp lệ của `user_preferences.locale`; `zh-Hans` là tag cho
    // `<html lang>`/`hreflang`. Trộn hai khái niệm là lỗi thường gặp.
    expect(getAccountLocaleDefinition('zh-CN')?.language).toBe('zh-Hans');
    expect(getAccountLocaleDefinition('zh-CN')?.code).toBe('zh-CN');
  });

  it('marks every current locale as left-to-right', () => {
    // `dir` là thuộc tính của ngôn ngữ (một ngôn ngữ RTL tương lai như ar, he,
    // fa… sẽ khai `'rtl'` ngay tại entry của nó), không phải lựa chọn hiển thị:
    // mọi locale hiện có đều viết từ trái sang phải, nên một giá trị khác ở đây
    // là lỗi khai báo registry chứ không phải hành vi hợp lệ.
    expect(ACCOUNT_LOCALES.map((definition) => definition.dir)).toEqual(['ltr', 'ltr', 'ltr']);
    // Pin hình dạng type: `dir` là field của `AccountLocaleDefinition` và nhận
    // giá trị trong union `'ltr' | 'rtl'`. Vì `ACCOUNT_LOCALES` được khai kiểu
    // `readonly AccountLocaleDefinition[]`, đọc `definition.dir` ở assertion trên
    // chỉ biên dịch được khi chính định nghĩa type mang field này.
    const direction: AccountLocaleDefinition['dir'] = 'ltr';
    expect(getAccountLocaleDefinition('vi')?.dir).toBe(direction);
  });

  it('rejects unsupported and malformed locale values', () => {
    for (const value of ['', 'EN', 'zh', 'zh-TW', 'en-US', 'fr', 'en_US', '  ']) {
      expect(
        parseAccountLocale(value),
        `parseAccountLocale(${JSON.stringify(value)})`,
      ).toBeUndefined();
    }
  });

  it('rejects non-string values', () => {
    for (const value of [undefined, null, 42, {}, ['en'], true]) {
      expect(parseAccountLocale(value)).toBeUndefined();
    }
  });

  it('accepts exactly the supported locale codes', () => {
    for (const definition of ACCOUNT_LOCALES) {
      expect(parseAccountLocale(definition.code)).toBe(definition.code);
      expect(isAccountLocale(definition.code)).toBe(true);
    }
  });

  it('is frozen so no caller can mutate the policy', () => {
    expect(Object.isFrozen(ACCOUNT_LOCALES)).toBe(true);
  });
});
