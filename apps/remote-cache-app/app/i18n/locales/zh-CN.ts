/**
 * Message catalog 简体中文 — cùng cây key với `en.ts` (kiểm bởi
 * `tests/catalogs.spec.ts`).
 */
export default {
  app: {
    name: 'Ecoma Remote Cache Admin',
  },

  shell: {
    home: '首页',

    search: {
      button: '搜索',
      placeholder: '输入命令或搜索...',
      empty: '未找到结果。',
      dialogTitle: '命令面板',
      dialogDescription: '搜索要运行的命令...',
    },

    colorMode: {
      label: '配色模式',
      light: '浅色',
      dark: '深色',
      system: '跟随系统',
    },

    language: {
      label: '语言',
      hint: '更改整个管理应用的语言。',
    },
  },

  states: {
    loading: '加载中…',
    errorTitle: '无法加载此数据',
    errorBody: '如果下方出现技术细节，可以分享给支持团队。',
    retry: '重试',
    unavailableTitle: '管理应用当前不可用',
    unavailableBody: '管理应用暂时无法处理请求。请管理员检查部署配置。',
  },

  nav: {
    admin: '管理',
    overview: '概览',
    projects: '项目',
    onboarding: 'Nx 接入',
  },

  overview: {
    title: '概览',
    description: 'Remote Cache 管理应用。',
    scaffoldTitle: '应用外壳已就绪',
    scaffoldBody:
      '管理应用外壳和多语言支持已就绪。仪表板、缓存管理、租户、API 密钥和其他业务功能尚未实现。',
  },

  // --- Portal (issue #180) ---
  //
  // 领域术语（project、API key、revoke）按 AGENTS.md 规则保留英文。

  projects: {
    title: '项目',
    description: '你租户下的缓存项目。',
    createProject: '创建项目',
    nameHeader: '名称',
    createdAtHeader: '创建时间',
    keysHeader: '密钥',
    emptyTitle: '还没有项目',
    emptyBody: '创建第一个项目，获取缓存 endpoint 和 API key。',
    loadMore: '加载更多',
    notFound: '该项目不存在，或你没有访问权限。',
  },

  projectCreate: {
    title: '创建项目',
    description: '创建新的缓存项目及其第一个 API key。',
    nameLabel: '项目名称',
    nameHint: '小写字母、数字和连字符。',
    submit: '创建项目',
    submitting: '创建中…',
  },

  showOnce: {
    title: '你的 API key 已就绪',
    body: '请立即复制此 token。出于安全考虑，它只显示这一次——关闭此对话框后将无法再次获取。',
    tokenLabel: 'API key token',
    copy: '复制',
    copied: '已复制',
    confirm: '我已保存，关闭',
  },

  projectDetail: {
    backToProjects: '返回项目列表',
    keysTitle: 'API key',
    keysDescription: '仅元数据——key 的 token 在创建后不会在这里再次显示。',
    createKey: '创建 API key',
    creatingKey: '创建中…',
    scopesHeader: 'Scopes',
    classHeader: '类别',
    statusHeader: '状态',
    createdAtHeader: '创建时间',
    revokedAtHeader: '已撤销',
    actionsHeader: '操作',
    activeStatus: '有效',
    revokedStatus: '已撤销',
    revoke: '撤销',
    revokeConfirmTitle: '撤销这个 API key？',
    revokeConfirmBody: '使用此密钥签名的请求会立即开始失败。此操作无法撤销。',
    revokeConfirmSubmit: '撤销密钥',
    revoking: '撤销中…',
    cancel: '取消',
    emptyTitle: '还没有 API key',
    emptyBody: '此项目还没有 API key。创建一个以获取 token。',
    developerClass: 'Developer',
    developerClassHint: '从本 portal 铸造的只读密钥。',
    trustedCiClass: 'Trusted CI',
    trustedCiClassHint: '由 CI 机器流程铸造的密钥；可携带 write scope。',
  },

  onboarding: {
    title: 'Nx 接入',
    description: '两步将你的 Nx workspace 连接到 Remote Cache。',
    endpointLabel: '缓存 endpoint',
    credentialLabel: 'API key',
    credentialHint: '创建时仅显示一次。如丢失，请撤销并铸造新密钥。',
    installLabel: '1. 安装 Nx Remote Cache 插件',
    installCommand: "pnpm add -D {'@'}ecoma-io/nx-remote-cache",
    configureLabel: '2. 配置 cache target',
    firstUseTitle: '首次使用',
    firstUseBody:
      '运行任意 Nx task 两次。第二次将命中 Remote Cache：在 task 输出中查找 "Remote Cache Hit"。',
  },
};
