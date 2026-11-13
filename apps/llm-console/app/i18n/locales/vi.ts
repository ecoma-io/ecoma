/**
 * Message catalog tiếng Việt — cùng cây key với `en.ts` (kiểm bởi
 * `tests/catalogs.spec.ts`).
 */
export default {
  app: {
    name: 'Ecoma LLM Console',
  },

  shell: {
    home: 'Trang chủ',

    search: {
      button: 'Tìm kiếm',
      placeholder: 'Gõ một lệnh hoặc từ khoá...',
      empty: 'Không tìm thấy kết quả.',
      dialogTitle: 'Bảng lệnh',
      dialogDescription: 'Tìm một lệnh để chạy...',
    },

    colorMode: {
      label: 'Chế độ màu',
      light: 'Sáng',
      dark: 'Tối',
      system: 'Hệ thống',
    },

    language: {
      label: 'Ngôn ngữ',
      hint: 'Đổi ngôn ngữ của toàn bộ console.',
    },
  },

  states: {
    loading: 'Đang tải…',
    errorTitle: 'Không tải được dữ liệu này',
    errorBody: 'Nếu có chi tiết kỹ thuật hiện bên dưới, bạn có thể chia sẻ với bộ phận hỗ trợ.',
    retry: 'Thử lại',
    unavailableTitle: 'Console hiện không khả dụng',
    unavailableBody:
      'Console chưa thể phục vụ yêu cầu lúc này. Hãy báo quản trị viên kiểm tra cấu hình triển khai.',
  },

  nav: {
    console: 'Bảng điều khiển LLM',
    overview: 'Tổng quan',
  },

  overview: {
    title: 'Tổng quan',
    description: 'Bảng điều khiển LLM gateway của bạn.',
    scaffoldTitle: 'Khung giao diện đã sẵn sàng',
    scaffoldBody:
      'Khung dashboard và phần đa ngôn ngữ đã sẵn sàng. Các tính năng tài khoản, API key, định tuyến, mức sử dụng và thanh toán chưa được triển khai.',
  },
};
