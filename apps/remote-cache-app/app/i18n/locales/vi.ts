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
    projects: 'Dự án',
    onboarding: 'Hướng dẫn Nx',
  },

  overview: {
    title: 'Tổng quan',
    description: 'Ứng dụng quản trị Remote Cache.',
    scaffoldTitle: 'Khung ứng dụng đã sẵn sàng',
    scaffoldBody:
      'Khung ứng dụng và đa ngôn ngữ đã sẵn sàng. Bảng điều khiển, quản lý cache, tenant, API key và các tính năng nghiệp vụ khác chưa được triển khai.',
  },

  // --- Portal (issue #180) ---
  //
  // Danh từ kỹ thuật (project, API key, revoke) giữ tiếng Anh đúng quy tắc
  // domain-term của AGENTS.md; phần còn lại là văn hướng dẫn cho người dùng.

  projects: {
    title: 'Dự án',
    description: 'Các dự án cache của tenant của bạn.',
    createProject: 'Tạo dự án',
    nameHeader: 'Tên',
    createdAtHeader: 'Đã tạo',
    keysHeader: 'Khoá',
    emptyMessage: 'Chưa có dự án nào — tạo dự án đầu tiên để nhận cache endpoint và API key.',
    loadMore: 'Tải thêm',
    notFound: 'Dự án này không tồn tại hoặc bạn không có quyền truy cập.',
  },

  projectCreate: {
    title: 'Tạo dự án',
    description: 'Tạo dự án cache mới cùng API key đầu tiên của nó.',
    nameLabel: 'Tên dự án',
    nameHint: 'Chữ thường, chữ số và gạch nối.',
    submit: 'Tạo dự án',
    submitting: 'Đang tạo…',
  },

  showOnce: {
    title: 'API key của bạn đã sẵn sàng',
    body: 'Sao chép token này ngay. Vì lý do bảo mật, nó chỉ được hiển thị đúng một lần này — sau khi đóng hộp thoại, không thể lấy lại được nữa.',
    tokenLabel: 'Token API key',
    copy: 'Sao chép',
    copied: 'Đã sao chép',
    confirm: 'Tôi đã lưu, đóng',
  },

  projectDetail: {
    backToProjects: 'Về danh sách dự án',
    keysTitle: 'API key',
    keysDescription:
      'Chỉ metadata — token của khoá không bao giờ hiển thị lại tại đây sau khi tạo.',
    createKey: 'Tạo API key',
    creatingKey: 'Đang tạo…',
    scopesHeader: 'Scopes',
    classHeader: 'Phân lớp',
    statusHeader: 'Trạng thái',
    createdAtHeader: 'Đã tạo',
    revokedAtHeader: 'Đã revoke',
    actionsHeader: 'Thao tác',
    activeStatus: 'Còn hiệu lực',
    revokedStatus: 'Đã revoke',
    revoke: 'Revoke',
    revokeConfirmTitle: 'Revoke API key này?',
    revokeConfirmBody:
      'Các request ký bằng khoá này sẽ bắt đầu thất bại ngay lập tức. Không thể hoàn tác.',
    revokeConfirmSubmit: 'Revoke khoá',
    revoking: 'Đang revoke…',
    cancel: 'Huỷ',
    emptyMessage: 'Chưa có API key — dự án này chưa có API key nào. Tạo một khoá để nhận token.',
    developerClass: 'Developer',
    developerClassHint: 'Khoá chỉ đọc được cấp từ portal này.',
    trustedCiClass: 'Trusted CI',
    trustedCiClassHint: 'Khoá được luồng máy CI cấp; có thể mang scope write.',
  },

  onboarding: {
    title: 'Hướng dẫn Nx',
    description: 'Kết nối workspace Nx của bạn với Remote Cache trong hai bước.',
    endpointLabel: 'Cache endpoint',
    credentialLabel: 'API key',
    credentialHint: 'Chỉ hiển thị một lần khi tạo. Revoke và cấp khoá mới nếu bạn đánh mất.',
    installLabel: '1. Cài đặt Nx Remote Cache plugin',
    installCommand: "pnpm add -D {'@'}ecoma-io/nx-remote-cache",
    configureLabel: '2. Cấu hình cache target',
    firstUseTitle: 'Lần chạy đầu',
    firstUseBody:
      'Chạy bất kỳ Nx task nào hai lần. Lần thứ hai sẽ trúng Remote Cache: tìm "Remote Cache Hit" trong output của task.',
  },
};
