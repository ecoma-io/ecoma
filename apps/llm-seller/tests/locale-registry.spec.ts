import { describe, expect, it } from 'vitest';

import {
  LLM_SELLER_LOCALE_DEFINITIONS,
  LLM_SELLER_LOCALES,
  getLlmSellerLocaleDefinition,
} from '../app/i18n/locale-registry';

/**
 * Ghim `dir` của registry — thuộc tính của **ngôn ngữ nội dung**, không phải
 * lựa chọn người dùng (issue #213): shell không còn setting LTR/RTL, nên registry
 * là nguồn duy nhất của chiều văn bản, cùng nguồn với `<html lang>`.
 *
 * Giá trị ghim ở đây là giá trị **hiện tại** của policy, không phải bất biến
 * vĩnh viễn: thêm một locale RTL (ar, he, fa…) là một thay đổi có chủ đích và
 * test này phải được cập nhật cùng lúc — không phải đường để một locale vào
 * registry mà không ai quyết định chiều văn bản của nó.
 */
describe('llm-seller locale registry direction', () => {
  it('carries a direction on every locale definition', () => {
    for (const definition of LLM_SELLER_LOCALE_DEFINITIONS) {
      expect(definition.dir === 'ltr' || definition.dir === 'rtl').toBe(true);
    }
  });

  it('pins every current locale to ltr', () => {
    expect(LLM_SELLER_LOCALE_DEFINITIONS.map((definition) => definition.dir)).toEqual([
      'ltr',
      'ltr',
      'ltr',
    ]);
  });

  it('returns the direction from the definition lookup, same source as <html lang>', () => {
    for (const definition of LLM_SELLER_LOCALES) {
      expect(getLlmSellerLocaleDefinition(definition.code)?.dir).toBe(definition.dir);
    }
    expect(getLlmSellerLocaleDefinition('fr')?.dir).toBeUndefined();
  });
});
