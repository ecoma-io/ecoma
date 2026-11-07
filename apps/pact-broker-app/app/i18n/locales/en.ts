/**
 * Message catalog tiếng Anh — **nguồn sự thật cho tập key** của toàn bộ UI
 * dashboard.
 *
 * Catalog này định nghĩa *key*, không phải *nội dung*: `vi` và `zh-CN` phải có
 * đúng tập key này. Tính đồng nhất được kiểm bằng `tests/catalogs.spec.ts`, không
 * dựa vào kỷ luật khi viết — một key thừa ở đây là một key mà hai catalog còn lại
 * không dịch, và nó fallback về tiếng Anh ở giữa một giao diện tiếng Việt.
 *
 * Quy ước: `zh-CN` là locale code, còn BCP-47 cho `<html lang>` là `zh-Hans` —
 * hai giá trị khác nhau, khai ở `nuxt.config.ts` (`i18n.locales[].language`).
 *
 * Nhóm `shell` và `shell.search` dịch **đúng** chuỗi mà library sinh mặc định
 * (`DEFAULT_APP_SHELL_LABELS`): app này chỉ thêm khả năng dịch, không đổi nội
 * dung tiếng Anh mà các app khác vẫn thấy.
 */
export default {
  app: {
    // Tên sản phẩm: là thương hiệu, giữ nguyên trong cả ba locale (không dịch
    // "Ecoma"). Dùng cho accessible name của logo và cho metadata.
    name: 'Ecoma Pact Broker',
  },

  shell: {
    home: 'Home',

    search: {
      button: 'Search',
      placeholder: 'Type a command or search...',
      empty: 'No results found.',
      dialogTitle: 'Command Palette',
      dialogDescription: 'Search for a command to run...',
    },

    settings: {
      title: 'Settings',
      description: 'Customize & Preview in Real Time',
      theming: 'Theming',
      layout: 'Layout',
      color: 'Color',
      direction: 'Direction',
      directionLtr: 'LTR',
      directionRtl: 'RTL',
    },

    language: {
      label: 'Language',
      hint: 'Changes the language of the whole dashboard.',
    },
  },

  states: {
    loading: 'Loading…',
    errorTitle: 'Could not load this data',
    // Bổ sung thông tin thay vì lặp lại `errorTitle`, và **không** giả định dòng
    // detail luôn có mặt: state lỗi render detail theo `v-if`, mà `message` có
    // thể rỗng.
    errorBody: 'If a technical detail appears below, it can be shared with support.',
    retry: 'Try again',
    // Broker chưa cấu hình (BFF thiếu base URL / token): trạng thái unavailable
    // fail-closed, trung tâm theo chế độ — không giả định nguyên nhân cụ thể.
    unavailableTitle: 'Pact Broker is not available',
    unavailableBody:
      'The dashboard cannot reach the broker API right now. Ask your administrator to check the deployment configuration.',
  },

  nav: {
    broker: 'Pact Broker',
    overview: 'Overview',
    pacts: 'Pacts',
    matrix: 'Matrix',
    environments: 'Environments',
    tokens: 'API tokens',
  },

  overview: {
    title: 'Overview',
    description: 'Consumer-driven contracts between the services of this workspace.',
  },

  pacts: {
    title: 'Pacts',
    description: 'Pacts published between consumers and providers.',
    consumer: 'Consumer',
    provider: 'Provider',
    latestVersion: 'Latest version',
    updatedAt: 'Updated at',
  },

  environments: {
    title: 'Environments',
    description: 'Deployment environments known to the broker.',
    name: 'Name',
    displayName: 'Display name',
    createdAt: 'Created at',
  },

  tokens: {
    title: 'API tokens',
    description: 'Machine tokens for CI and the Pact CLI. Values are shown only once at creation.',
    name: 'Name',
    scopes: 'Scopes',
    createdAt: 'Created at',
    revoked: 'Revoked',
    active: 'Active',
  },
} as const;
