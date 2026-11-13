/**
 * Message catalog tiếng Anh — **nguồn sự thật cho tập key** của toàn bộ UI
 * console.
 *
 * Catalog này định nghĩa *key*, không phải *nội dung*: `vi` và `zh-CN` phải có
 * đúng tập key này. Tính đồng nhất được kiểm bằng `tests/catalogs.spec.ts`, không
 * dựa vào kỷ luật khi viết — một key thừa ở đây là một key mà hai catalog còn lại
 * không dịch, và nó fallback về tiếng Anh ở giữa một giao diện tiếng Việt.
 *
 * Quy ước: `zh-CN` là locale code, còn BCP-47 cho `<html lang>` là `zh-Hans` —
 * hai giá trị khác nhau, khai ở `nuxt.config.ts` (`i18n.locales[].language`).
 *
 * Nhóm `shell.colorMode` và `shell.search` dịch **đúng** chuỗi mà library sinh mặc định
 * (`DEFAULT_APP_SHELL_LABELS`): app này chỉ thêm khả năng dịch, không đổi nội
 * dung tiếng Anh mà các app khác vẫn thấy.
 */
export default {
  app: {
    // Tên sản phẩm: là thương hiệu, giữ nguyên trong cả ba locale (không dịch
    // "Ecoma"). Dùng cho accessible name của logo và cho metadata.
    name: 'Ecoma LLM Console',
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

    colorMode: {
      label: 'Color mode',
      light: 'Light',
      dark: 'Dark',
      system: 'System',
    },

    language: {
      label: 'Language',
      hint: 'Changes the language of the whole console.',
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
    // Trạng thái unavailable fail-closed, trung tâm theo chế độ — không giả định
    // nguyên nhân cụ thể, và không hứa hẹn về một downstream nào chưa tồn tại.
    unavailableTitle: 'The console is not available',
    unavailableBody:
      'This console cannot serve requests right now. Ask your administrator to check the deployment configuration.',
  },

  nav: {
    console: 'LLM Console',
    overview: 'Overview',
  },

  overview: {
    title: 'Overview',
    description: 'Your LLM gateway console.',
    // Trang scaffold: nói đúng phần đã có và phần **chưa** có. Không có metric,
    // không có con số, không có copy nghiệp vụ ngụ ý dữ liệu đã tồn tại.
    scaffoldTitle: 'Scaffold ready',
    scaffoldBody:
      'The dashboard shell and localization are ready. Account, API key, routing, usage and billing features are not implemented yet.',
  },
} as const;
