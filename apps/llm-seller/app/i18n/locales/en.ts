/**
 * Message catalog tiếng Anh — **nguồn sự thật cho tập key** của toàn bộ UI
 * seller portal.
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
 *
 * ⚠️ Trang overview cố ý **không** có số liệu: seller portal chưa có dữ liệu
 * nghiệp vụ nào được định nghĩa, nên `overview.scaffold*` chỉ nói đúng sự thật
 * là shell và localization đã sẵn sàng, còn onboarding, verification, offer,
 * pricing, earnings và payout **chưa** được hiện thực.
 */
export default {
  app: {
    // Tên sản phẩm: là thương hiệu, giữ nguyên trong cả ba locale (không dịch
    // "Ecoma"). Dùng cho accessible name của logo và cho metadata.
    name: 'Ecoma LLM Seller',
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
    // Portal chưa cấu hình hoặc chưa có downstream: trạng thái unavailable
    // fail-closed, trung tâm theo chế độ — không giả định nguyên nhân cụ thể.
    unavailableTitle: 'The seller portal is not available',
    unavailableBody:
      'The seller portal cannot be reached right now. Ask your administrator to check the deployment configuration.',
  },

  nav: {
    seller: 'LLM Seller',
    overview: 'Overview',
  },

  overview: {
    title: 'Overview',
    description: 'Your LLM marketplace seller portal.',
    scaffoldTitle: 'Scaffold ready',
    scaffoldBody:
      'The seller shell and localization are in place. Onboarding, verification, offers, pricing, earnings and payouts are not implemented yet.',
  },
} as const;
