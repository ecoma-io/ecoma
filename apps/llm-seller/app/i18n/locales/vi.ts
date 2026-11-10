/**
 * Message catalog tiếng Việt — cùng cây key với `en.ts` (kiểm bởi
 * `tests/catalogs.spec.ts`).
 */
export default {
  app: {
    name: 'Ecoma LLM Seller',
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

    settings: {
      title: 'Cài đặt',
      description: 'Tùy chỉnh và xem trước theo thời gian thực',
      theming: 'Giao diện',
      layout: 'Bố cục',
      color: 'Màu',
      direction: 'Hướng',
      directionLtr: 'LTR',
      directionRtl: 'RTL',
    },

    language: {
      label: 'Ngôn ngữ',
      hint: 'Đổi ngôn ngữ của toàn bộ dashboard.',
    },
  },

  states: {
    loading: 'Đang tải…',
    errorTitle: 'Không tải được dữ liệu này',
    errorBody: 'Nếu có chi tiết kỹ thuật hiện bên dưới, bạn có thể chia sẻ với bộ phận hỗ trợ.',
    retry: 'Thử lại',
    unavailableTitle: 'Kênh người bán hiện không khả dụng',
    unavailableBody:
      'Kênh người bán chưa truy cập được lúc này. Hãy báo quản trị viên kiểm tra cấu hình triển khai.',
  },

  nav: {
    seller: 'Kênh người bán LLM',
    overview: 'Tổng quan',
  },

  overview: {
    title: 'Tổng quan',
    description: 'Kênh người bán marketplace LLM của bạn.',
    scaffoldTitle: 'Khung giao diện đã sẵn sàng',
    scaffoldBody:
      'Shell và phần đa ngôn ngữ của kênh người bán đã có. Onboarding, xác minh, offer, pricing, earnings và payout chưa được hiện thực.',
  },
};
