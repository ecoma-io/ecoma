/**
 * Message catalog tiếng Việt — cùng cây key với `en.ts` (kiểm bởi
 * `tests/catalogs.spec.ts`).
 */
export default {
  app: {
    name: 'Ecoma Pact Broker',
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
    unavailableTitle: 'Pact Broker hiện không khả dụng',
    unavailableBody:
      'Dashboard chưa kết nối được broker API. Hãy báo quản trị viên kiểm tra cấu hình triển khai.',
  },

  nav: {
    broker: 'Pact Broker',
    overview: 'Tổng quan',
    pacts: 'Pacts',
    matrix: 'Ma trận',
    environments: 'Môi trường',
    tokens: 'API tokens',
  },

  overview: {
    title: 'Tổng quan',
    description: 'Hợp đồng consumer-driven giữa các service của workspace này.',
  },

  pacts: {
    title: 'Pacts',
    description: 'Các pact đã được publish giữa consumer và provider.',
    consumer: 'Consumer',
    provider: 'Provider',
    latestVersion: 'Phiên bản mới nhất',
    updatedAt: 'Cập nhật lúc',
  },

  environments: {
    title: 'Môi trường',
    description: 'Các môi trường triển khai mà broker biết đến.',
    name: 'Tên',
    displayName: 'Tên hiển thị',
    createdAt: 'Tạo lúc',
  },

  tokens: {
    title: 'API tokens',
    description:
      'Machine token cho CI và Pact CLI. Giá trị token chỉ hiển thị đúng một lần lúc tạo.',
    name: 'Tên',
    scopes: 'Phạm vi',
    createdAt: 'Tạo lúc',
    revoked: 'Đã thu hồi',
    active: 'Còn hiệu lực',
  },
};
