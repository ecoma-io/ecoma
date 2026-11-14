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

    colorMode: {
      label: 'Chế độ màu',
      light: 'Sáng',
      dark: 'Tối',
      system: 'Hệ thống',
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
    consumerVersion: 'Phiên bản consumer',
    verification: 'Xác minh',
    verificationSuccess: 'Xác minh thành công',
    verificationFailed: 'Xác minh thất bại',
    verificationNone: 'Chưa xác minh',
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
      'Machine credential cho CI và Pact CLI. Giá trị chỉ hiển thị đúng một lần lúc tạo.',
    name: 'Tên',
    scopes: 'Phạm vi',
    purpose: 'Mục đích',
    purposeDeveloper: 'Developer (kịch bản CLI, publish/verify)',
    purposeCi: 'CI (pipeline)',
    creator: 'Người tạo',
    createdAt: 'Tạo lúc',
    status: 'Trạng thái',
    revoked: 'Đã thu hồi',
    active: 'Còn hiệu lực',
    copy: 'Sao chép token',
    copied: 'Đã sao chép',
    dismiss: 'Đã lưu — ẩn',
    rotate: 'Xoay',
    revoke: 'Thu hồi',
    createFailed: 'Tạo credential bị từ chối — kiểm tra lại quyền hoặc dữ liệu.',
    mutateFailed: 'Thao tác bị từ chối — credential có thể vừa bị người khác đổi trạng thái.',
    csrfMissing:
      'Phiên của bạn thiếu security token — tải lại trang; nếu vẫn lặp lại, đăng nhập rồi thử lại.',
    revealed: {
      title: 'Token chỉ hiển thị lần này',
      hint: 'Lưu lại ngay — "{name}" sẽ không bao giờ hiển thị lại. Reload trang là mất vĩnh viễn.',
    },
    create: {
      title: 'Tạo credential mới',
      submit: 'Tạo credential',
    },
    confirm: {
      rotateTitle: 'Xoay credential?',
      revokeTitle: 'Thu hồi credential?',
      hint: 'Gõ đúng tên "{name}" để xác nhận. Xoay làm secret cũ hết hiệu lực ngay; thu hồi không thể hoàn tác.',
      cancel: 'Huỷ',
    },
    forbidden: 'Bạn không có quyền xem credential của tenant này.',
  },
};
