/**
 * Message catalog tiếng Anh — **nguồn sự thật cho tập key** của toàn bộ UI
 * ứng dụng quản trị.
 *
 * Catalog này định nghĩa *key*, không phải *nội dung*: `vi` và `zh-CN` phải có
 * đúng tập key này. Tính đồng nhất được kiểm bằng `tests/catalogs.spec.ts`, không
 * dựa vào kỷ luật khi viết — một key thừa ở đây là một key mà hai catalog còn lại
 * không dịch, và nó fallback về tiếng Anh ở giữa một giao diện tiếng Việt.
 *
 * Quy ước: `zh-CN` là locale code, còn BCP-47 cho `<html lang>` là `zh-Hans` —
 * hai giá trị khác nhau, khai ở `nuxt.config.ts` (`i18n.locales[].language`).
 *
 * Nhóm `shell.colorMode` và `shell.search` dịch **đúng** chuỗi mà library sinh mặc
 * định (`DEFAULT_APP_SHELL_LABELS`): app này chỉ thêm khả năng dịch, không đổi nội
 * dung tiếng Anh mà các app khác vẫn thấy.
 */
export default {
  app: {
    // Tên sản phẩm: là thương hiệu, giữ nguyên trong cả ba locale (không dịch
    // "Ecoma"). Dùng cho accessible name của logo và cho metadata.
    name: 'Ecoma Remote Cache Admin',
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
      hint: 'Changes the language of the whole admin app.',
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
    unavailableTitle: 'The admin app is not available',
    unavailableBody:
      'This admin app cannot serve requests right now. Ask your administrator to check the deployment configuration.',
  },

  nav: {
    admin: 'Administration',
    overview: 'Overview',
    projects: 'Projects',
    onboarding: 'Nx onboarding',
  },

  overview: {
    title: 'Overview',
    description: 'The admin shell for Remote Cache.',
    // Trang scaffold: nói đúng phần đã có và phần **chưa** có. Không có metric,
    // không có con số, không có copy nghiệp vụ ngụ ý dữ liệu đã tồn tại.
    scaffoldTitle: 'Shell ready',
    scaffoldBody:
      'The admin shell and localization are ready. Dashboard, cache management, tenants, API keys and other business features are not implemented yet.',
  },

  // --- Portal (issue #180) ---
  //
  // Nhóm key cho các trang quản lý project/API key. Danh từ kỹ thuật giữ tiếng
  // Anh (project, API key, revoke) đúng quy tắc proper-noun/domain-term của
  // AGENTS.md.

  projects: {
    title: 'Projects',
    description: 'Cache projects of your tenant.',
    createProject: 'Create project',
    nameHeader: 'Name',
    createdAtHeader: 'Created',
    keysHeader: 'Keys',
    emptyMessage:
      'No projects yet — create your first project to get a cache endpoint and an API key.',
    loadMore: 'Load more',
    notFound: 'This project does not exist or you do not have access to it.',
  },

  projectCreate: {
    title: 'Create project',
    description: 'Creates a new cache project and its first API key.',
    nameLabel: 'Project name',
    nameHint: 'Lowercase letters, digits and hyphens.',
    submit: 'Create project',
    submitting: 'Creating…',
  },

  showOnce: {
    title: 'Your API key is ready',
    body: 'Copy this token now. For security it is shown only this once — after you close this dialog it can never be retrieved again.',
    tokenLabel: 'API key token',
    copy: 'Copy',
    copied: 'Copied',
    confirm: 'I saved it, close',
  },

  projectDetail: {
    backToProjects: 'Back to projects',
    keysTitle: 'API keys',
    keysDescription: 'Metadata only — key tokens are never shown here again after creation.',
    createKey: 'Create API key',
    creatingKey: 'Creating…',
    scopesHeader: 'Scopes',
    classHeader: 'Class',
    statusHeader: 'Status',
    createdAtHeader: 'Created',
    revokedAtHeader: 'Revoked',
    actionsHeader: 'Actions',
    activeStatus: 'Active',
    revokedStatus: 'Revoked',
    revoke: 'Revoke',
    revokeConfirmTitle: 'Revoke this API key?',
    revokeConfirmBody:
      'Requests signed with this key start failing immediately. This cannot be undone.',
    revokeConfirmSubmit: 'Revoke key',
    revoking: 'Revoking…',
    cancel: 'Cancel',
    emptyMessage: 'No API keys — this project has no API keys yet. Create one to get a token.',
    developerClass: 'Developer',
    developerClassHint: 'Read-only key minted from this portal.',
    trustedCiClass: 'Trusted CI',
    trustedCiClassHint: 'Key minted by the CI machine flow; can carry write scope.',
  },

  onboarding: {
    title: 'Nx onboarding',
    description: 'Connect your Nx workspace to Remote Cache in two steps.',
    endpointLabel: 'Cache endpoint',
    credentialLabel: 'API key',
    credentialHint: 'Shown once at creation. Revoke and mint a new key if you lost it.',
    installLabel: '1. Install the Nx Remote Cache plugin',
    installCommand: "pnpm add -D {'@'}ecoma-io/nx-remote-cache",
    configureLabel: '2. Configure the cache target',
    firstUseTitle: 'First use',
    firstUseBody:
      'Run any Nx task twice. The second run hits Remote Cache: look for "Remote Cache Hit" in the task output.',
  },
} as const;
