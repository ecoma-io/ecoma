/**
 * Message catalog tiếng Anh — **nguồn sự thật cho tập key** của toàn bộ UI
 * backoffice.
 *
 * Catalog này định nghĩa *key*, không phải *nội dung*: `vi` và `zh-CN` phải có
 * đúng tập key này. Tính đồng nhất được kiểm bằng `catalogs.spec.ts` (colocated cạnh file này), không
 * dựa vào kỷ luật khi viết — một key thừa ở đây là một key mà hai catalog còn lại
 * không dịch, và nó fallback về tiếng Anh ở giữa một giao diện tiếng Việt.
 *
 * Quy ước: `zh-CN` là locale code, còn BCP-47 cho `<html lang>` là `zh-Hans` —
 * hai giá trị khác nhau, khai ở `nuxt.config.ts` (`i18n.locales[].language`).
 *
 * Nhóm `shell` và `shell.search` dịch **đúng** chuỗi mà library sinh mặc định
 * (`DEFAULT_APP_SHELL_LABELS`) cho llm-console và llm-seller: backoffice chỉ
 * thêm khả năng dịch, không đổi nội dung tiếng Anh mà hai app kia vẫn thấy.
 */
export default {
  app: {
    // Tên sản phẩm: là thương hiệu, giữ nguyên trong cả ba locale (không dịch
    // "Ecoma"). Dùng cho accessible name của logo và cho metadata.
    name: 'Ecoma Backoffice',
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
      hint: 'Changes the language of the whole backoffice.',
    },
  },

  prototype: {
    notice: {
      body: 'This backoffice surface is a UI prototype. Everything below comes from a local, in-memory adapter that never talks to a backend, and no action here is persisted or authorized.',
    },
  },

  states: {
    loading: 'Loading…',
    errorTitle: 'Could not load this data',
    // Bổ sung thông tin thay vì lặp lại `errorTitle`, và **không** giả định dòng
    // detail luôn có mặt: `BackofficeErrorState` render nó theo `v-if`, mà
    // `message` có thể rỗng. Lý do câu phải trung tính theo chế độ (bỏ claim
    // "prototype") nằm ở `catalogs.spec.ts` (colocated cạnh file này); đây là nguồn sự thật cho key.
    errorBody: 'If a technical detail appears below, it can be shared with support.',
    retry: 'Try again',
  },

  staff: {
    search: {
      label: 'Search staff',
      placeholder: 'Search by name or account ID…',
    },
    filter: {
      label: 'Filter by staff status',
      all: 'All statuses',
    },

    column: {
      member: 'Staff member',
      accountId: 'Account ID',
      status: 'Staff status',
      roles: 'Assigned roles',
      entitlements: 'Entitlements',
    },
    noRoles: 'No roles assigned',
    empty: 'No staff records yet.',
    noResults: 'No staff member matches this search.',
    status: {
      active: 'Active',
      suspended: 'Suspended',
      terminated: 'Terminated',
    },
    entitlements: {
      entitled: 'Entitled',
      revoked: 'Revoked',
      none: 'No entitlements',
    },
  },

  audit: {
    title: 'Audit trail',
    description:
      'History of authorization-sensitive actions — actor, target, action, time, and outcome.',
    column: {
      time: 'Time',
      actor: 'Actor',
      target: 'Target',
      action: 'Action',
      outcome: 'Outcome',
      reason: 'Reason',
    },
    outcome: {
      success: 'Success',
      failure: 'Failure',
      denied: 'Denied',
    },
    empty: 'No audit entries yet.',
    noResults: 'No audit entries match this filter.',
  },

  roles: {
    search: {
      label: 'Search roles',
      placeholder: 'Search by role name…',
    },
    column: {
      role: 'Role',
      permissions: 'Permissions in this role',
    },
    empty: 'No roles defined yet.',
    noResults: 'No role matches this search.',
    permissionCount: '{count} permissions',
    // Nhãn và mô tả của từng system-defined role lấy theo `id` của fixture
    // (`app/backoffice-data/prototype-fixture.ts`). Id là định danh ổn định, không
    // dịch; chỉ phần hiển thị nằm ở đây.
    items: {
      operator: {
        name: 'Operator',
        description: 'Runs day-to-day delivery and mail operations.',
      },
      support: {
        name: 'Support',
        description: 'Reads staff and mail records to help customers.',
      },
      auditor: {
        name: 'Auditor',
        description: 'Reads authorization audit records only.',
      },
    },
  },

  permissions: {
    search: {
      label: 'Search permissions',
      placeholder: 'Search by permission ID, domain or action…',
    },
    filter: {
      label: 'Filter by resource domain',
      all: 'All domains',
    },
    column: {
      permission: 'Permission ID',
      domain: 'Resource domain',
      action: 'Action',
    },
    empty: 'No permissions defined yet.',
    noResults: 'No permission matches this search.',
    // Mô tả lấy theo `<domain>.<action>` của fixture. `domain` và `action` đều là
    // một token không chứa dấu chấm, nên chuỗi key dựng được là một path hợp lệ
    // của vue-i18n.
    //
    // ⚠️ Hai nguồn của cùng một khối này:
    //   * **Catalog thật** (`db/migrations/0003_permission_catalog_seed.sql`) —
    //     seed 3 id `status = 'active'`, mỗi id một dòng đọc đúng permission mà
    //     route yêu cầu. Mô tả phải khớp **hành vi thật** của permission: đúng
    //     những cột mà query cho route đọc (`01-architecture.md` §4.3 là
    //     định danh, không phải nhãn để dịch), không phải một câu chung chung.
    //     Ba id này được ghim ở `permission-catalog-i18n.spec.ts` (cùng thư mục `app/i18n/`) —
    //     catalogue seed là nguồn của phép kiểm, không phải danh sách chép tay.
    //   * **Fixture prototype** (`app/backoffice-data/prototype-fixture.ts`) —
    //     `delivery.redrive`, `mail.read`, `mail.send`, `role.assign`,
    //     `audit.read` là minh hoạ của UI prototype, không phải catalog thật và
    //     không được seed; `staff.read` đứng ở nhóm trên vì trùng id thật.
    //     Giữ chúng là để UI prototype còn nhãn (`prototype-fixture.spec.ts` (colocated cạnh fixture)
    //     buộc đủ key cho mọi id trong fixture); xoá một cái là làm UI prototype
    //     hiện key rỗng.
    items: {
      delivery: {
        redrive: 'Queue a redrive for a delivery that already ran.',
      },
      mail: {
        read: 'Read transactional mail templates and delivery records.',
        send: 'Send a transactional mail.',
      },
      // `staff.read` — catalog thật (`0003`).
      staff: {
        read: 'Read the staff directory.',
      },
      role: {
        assign: 'Assign a role to a staff member.',
        // `role.read` — catalog thật (`0003`). Phạm vi đọc đúng `listRoles`
        // (`server/queries.ts`): catalog role với `id` + `isSystem`, không gồm
        // grant (`role_permissions`) hay assignment (`role_assignments`).
        read: 'Read the role catalog and which roles are system-defined.',
      },
      audit: {
        read: 'Read authorization audit records.',
      },
      // `permission.read` — catalog thật (`0003`). Phạm vi đọc đúng
      // `listPermissions`: cả row `retired`, vì catalog là sealed history và
      // việc lọc `retired` là quyết định hiển thị của UI, không phải của API.
      permission: {
        read: 'Read the permission catalog, including retired entries.',
      },
    },
  },

  onboarding: {
    title: 'Complete your profile',
    body: 'Your staff record has no display name yet. Set a display name so colleagues can find you in the staff directory.',
    setDisplayName: 'Set display name in Account',
    continue: 'Continue without a display name',
    twoFactor: {
      title: 'Two-factor authentication',
      comingSoon: 'Coming soon — two-factor enrolment is not available yet.',
    },
    noDisplayName: 'Display name not set',
  },

  nav: {
    platform: 'Platform',
    overview: 'Overview',
    staff: 'Staff',
    roles: 'Roles',
    permissions: 'Permissions',
    audit: 'Audit',
  },

  pages: {
    overview: {
      title: 'Overview',
      description: 'Jump to the staff, role and permission areas.',
    },
    staff: {
      title: 'Staff',
      description: 'Browse staff members, their status and assigned roles.',
    },
    roles: {
      title: 'Roles',
      description: 'Roles that can be assigned to staff members.',
    },
    permissions: {
      title: 'Permissions',
      // Trang này render **toàn bộ** catalog, gồm cả `role.assign` — permission mà
      // `prototype-fixture.ts` cố ý không gán cho role nào — nên mô tả phải nói về
      // việc duyệt catalog, không phải "quyền mà mỗi role cấp" (cách nhìn theo
      // role thuộc trang Roles).
      description: 'Permission catalog by resource domain and action.',
    },
  },
} as const;
