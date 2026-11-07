/**
 * Stub cho alias `#components` ngoài Nuxt runtime.
 *
 * `#components` chỉ tồn tại trong Nuxt runtime; vitest thuần không resolve
 * được (alias được khai ở `vitest.config.mts` trỏ vào file này). Các spec
 * mount view dùng `ContentRenderer` chỉ cần placeholder — contract của view
 * là truyền `value` nguyên vẹn, không biến đổi, nên render `null` là đủ.
 */

export const ContentRenderer = {
  name: 'ContentRenderer',
  props: ['value'],
  render: (): null => null,
} as const;
