import type { AppShellLabels } from './types';

/**
 * Chuỗi hiển thị mặc định — cũng chính là chuỗi hardcode trước đây trong
 * template, giữ nguyên từng chữ một để việc thêm nhãn không đổi hành vi của
 * llm-console và llm-seller (hai app không truyền `labels`).
 *
 * `Object.freeze` ở đây giống `ACCOUNT_LOCALES`: các nhãn không đổi lúc chạy,
 * và giá trị mặc định không ai được sửa tại chỗ.
 */
export const DEFAULT_APP_SHELL_LABELS: AppShellLabels = Object.freeze({
  settings: Object.freeze({
    title: 'Template Customizer',
    description: 'Customize & Preview in Real Time',
    theming: 'Theming',
    layout: 'Layout',
    color: 'Color',
    direction: 'Direction',
    directionLtr: 'LTR',
    directionRtl: 'RTL',
  }),
  search: Object.freeze({
    buttonLabel: 'Search',
    placeholder: 'Type a command or search...',
    emptyLabel: 'No results found.',
    dialogTitle: 'Command Palette',
    dialogDescription: 'Search for a command to run...',
  }),
});
