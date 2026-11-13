/**
 * Message catalog tiếng Việt — cùng cây key với `en.ts` (kiểm bởi
 * `tests/catalogs.spec.ts`).
 */
export default {
  app: {
    name: 'Ecoma Remote Cache Admin',
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
      hint: 'Đổi ngôn ngữ của toàn bộ ứng dụng quản trị.',
    },
  },

  states: {
    loading: 'Đang tải…',
    errorTitle: 'Không tải được dữ liệu này',
    errorBody: 'Nếu có chi tiết kỹ thuật hiện bên dưới, bạn có thể chia sẻ với bộ phận hỗ trợ.',
    retry: 'Thử lại',
    unavailableTitle: 'Ứng dụng quản trị hiện không khả dụng',
    unavailableBody:
      'Ứng dụng quản trị chưa thể phục vụ yêu cầu lúc này. Hãy báo quản trị viên kiểm tra cấu hình triển khai.',
  },

  nav: {
    admin: 'Quản trị',
    overview: 'Tổng quan',
  },

  overview: {
    title: 'Tổng quan',
    description: 'Ứng dụng quản trị Remote Cache.',
    scaffoldTitle: 'Khung ứng dụng đã sẵn sàng',
    scaffoldBody:
      'Khung ứng dụng và đa ngôn ngữ đã sẵn sàng. Bảng điều khiển, quản lý cache, tenant, API key và các tính năng nghiệp vụ khác chưa được triển khai.',
  },
};
