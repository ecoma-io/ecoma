/**
 * Message catalog tiếng Việt — **bản dịch**, không phải nguồn key.
 *
 * Cùng tập key với `en.ts`; kiểm bằng `catalogs.spec.ts` (colocated cạnh file này). Nhóm `shell` và
 * `shell.search` dịch chuỗi mà library sinh mặc định cho hai app không i18n,
 * nên người dùng tiếng Việt thấy đúng bảng tuỳ chỉnh / ô tìm kiếm mà llm-console
 * và llm-seller hiện bằng tiếng Anh.
 */
import type { BackofficeMessages } from './messages';

const vi: BackofficeMessages = {
  app: {
    // Thương hiệu, giữ nguyên chữ Latinh: "Ecoma Backoffice" là tên sản phẩm,
    // không phải cụm để dịch.
    name: 'Ecoma Backoffice',
  },

  shell: {
    home: 'Trang chủ',

    search: {
      button: 'Tìm kiếm',
      placeholder: 'Gõ lệnh hoặc từ khóa...',
      empty: 'Không tìm thấy kết quả.',
      dialogTitle: 'Bảng lệnh',
      dialogDescription: 'Tìm một lệnh để chạy...',
    },

    settings: {
      title: 'Cài đặt',
      description: 'Tuỳ chỉnh và xem trước theo thời gian thực',
      theming: 'Bảng màu',
      layout: 'Bố cục',
      color: 'Màu chủ đạo',
      direction: 'Chiều văn bản',
      directionLtr: 'Trái sang phải',
      directionRtl: 'Phải sang trái',
    },

    language: {
      label: 'Ngôn ngữ',
      hint: 'Đổi ngôn ngữ của toàn bộ backoffice.',
    },
  },

  prototype: {
    notice: {
      body: 'Bề mặt backoffice này là một prototype UI. Mọi thứ bên dưới đến từ adapter cục bộ, chỉ trong bộ nhớ, không gọi backend nào, và không thao tác nào được lưu hay uỷ quyền.',
    },
  },

  states: {
    loading: 'Đang tải…',
    errorTitle: 'Không tải được dữ liệu này',
    // Lý do đầy đủ (trung tính theo chế độ, và không giả định dòng detail luôn
    // có) ở `en.ts` và `catalogs.spec.ts` (colocated cạnh file này).
    errorBody: 'Chi tiết kỹ thuật hiện bên dưới (nếu có) có thể gửi cho bộ phận hỗ trợ.',
    retry: 'Thử lại',
  },

  staff: {
    search: {
      label: 'Tìm nhân sự',
      placeholder: 'Tìm theo tên hoặc Account ID…',
    },
    filter: {
      label: 'Lọc theo trạng thái nhân sự',
      all: 'Tất cả trạng thái',
    },

    column: {
      member: 'Nhân viên',
      accountId: 'Account ID',
      status: 'Trạng thái nhân sự',
      roles: 'Vai trò đã gán',
      entitlements: 'Đăng ký sản phẩm',
    },
    noRoles: 'Chưa gán vai trò',
    empty: 'Chưa có bản ghi nhân sự.',
    noResults: 'Không có nhân viên nào khớp tìm kiếm.',
    status: {
      active: 'Hoạt động',
      suspended: 'Tạm khoãng',
      terminated: 'Đã chấm dứt',
    },
    entitlements: {
      entitled: 'Đã đăng ký',
      revoked: 'Đã thu hồi',
      none: 'Chưa đăng ký sản phẩm nào',
    },
  },

  audit: {
    title: 'Vết nhảy kiểm toán',
    description:
      'Lịch sử các thao tác nhạy cảm quyền — actor, target, action, thời điểm và kết quả.',
    column: {
      time: 'Thời điểm',
      actor: 'Actor',
      target: 'Target',
      action: 'Hành động',
      outcome: 'Kết quả',
      reason: 'Lý do',
    },
    outcome: {
      success: 'Thành công',
      failure: 'Thất bại',
      denied: 'Từ chối',
    },
    empty: 'Chưa có bản ghi audit nào.',
    noResults: 'Không có bản ghi audit nào khớp bộ lọc.',
  },

  roles: {
    search: {
      label: 'Tìm vai trò',
      placeholder: 'Tìm theo tên vai trò…',
    },
    column: {
      role: 'Vai trò',
      permissions: 'Quyền trong vai trò này',
    },
    empty: 'Chưa định nghĩa vai trò nào.',
    noResults: 'Không có vai trò nào khớp tìm kiếm.',
    permissionCount: '{count} quyền',
    items: {
      operator: {
        name: 'Vận hành',
        description: 'Chạy thao tác vận hành delivery và mail hằng ngày.',
      },
      support: {
        name: 'Hỗ trợ',
        description: 'Đọc hồ sơ nhân sự và mail để hỗ trợ khách hàng.',
      },
      auditor: {
        name: 'Kiểm toán',
        description: 'Chỉ đọc bản ghi authorization audit.',
      },
    },
  },

  permissions: {
    search: {
      label: 'Tìm quyền',
      placeholder: 'Tìm theo ID quyền, resource domain hoặc action…',
    },
    filter: {
      label: 'Lọc theo resource domain',
      all: 'Tất cả domain',
    },
    column: {
      permission: 'Permission ID',
      domain: 'Resource domain',
      action: 'Action',
    },
    empty: 'Chưa định nghĩa quyền nào.',
    noResults: 'Không có quyền nào khớp tìm kiếm.',
    // Nhóm `items` có hai nguồn: catalog thật (`0003_permission_catalog_seed.sql`)
    // và fixture prototype — lý do và ranh giới ở `en.ts`.
    items: {
      delivery: {
        redrive: 'Xếp lại một delivery đã chạy.',
      },
      mail: {
        read: 'Đọc template và lịch sử giao transactional mail.',
        send: 'Gửi một transactional mail.',
      },
      // `staff.read` — catalog thật (`0003`).
      staff: {
        read: 'Đọc danh bạ nhân sự.',
      },
      role: {
        assign: 'Gán một vai trò cho một nhân viên.',
        // `role.read` — catalog thật (`0003`). Phạm vi đọc đúng `listRoles`:
        // catalog role với `id` + `isSystem`, không gồm grant hay assignment.
        read: 'Đọc danh mục vai trò và biết vai trò nào là do hệ thống định nghĩa.',
      },
      audit: {
        read: 'Đọc bản ghi authorization audit.',
      },
      // `permission.read` — catalog thật (`0003`). Phạm vi đọc đúng
      // `listPermissions`: gồm cả row `retired`, vì catalog là lịch sử sealed
      // và việc lọc `retired` là quyết định hiển thị của UI.
      permission: {
        read: 'Đọc danh mục quyền, gồm cả các mục đã retired.',
      },
    },
  },

  onboarding: {
    title: 'Hoàn thiện hồ sơ',
    body: 'Tài khoản của bạn chưa có tên hiển thị. Hãy đặt tên hiển thị để đồng nghiệp tìm thấy bạn trong sổ nhân sự.',
    setDisplayName: 'Đặt tên hiển thị trong Account',
    continue: 'Tiếp tục không cần tên hiển thị',
    twoFactor: {
      title: 'Xác thực hai yếu tố',
      comingSoon: 'Sắp có — chưa thể đăng ký xác thực hai yếu tố.',
    },
    noDisplayName: 'Chưa đặt tên hiển thị',
  },

  nav: {
    platform: 'Nền tảng',
    overview: 'Tổng quan',
    staff: 'Nhân sự',
    roles: 'Vai trò',
    permissions: 'Quyền',
    audit: 'Kiểm toán',
  },

  pages: {
    overview: {
      title: 'Tổng quan',
      description: 'Đi tới các khu vực nhân sự, vai trò và quyền.',
    },
    staff: {
      title: 'Nhân sự',
      description: 'Xem nhân sự, trạng thái và vai trò được gán.',
    },
    roles: {
      title: 'Vai trò',
      description: 'Các vai trò có thể gán cho nhân sự.',
    },
    permissions: {
      title: 'Quyền',
      // Duyệt toàn bộ permission catalog theo resource domain và action; không mô
      // tả khía cạnh "cấp quyền" theo từng vai trò (thuộc trang Roles).
      description: 'Danh mục quyền theo resource domain và action.',
    },
  },
};

export default vi;
