/**
 * Message catalog 简体中文 — cùng cây key với `en.ts` (kiểm bởi
 * `tests/catalogs.spec.ts`).
 */
export default {
  app: {
    name: 'Ecoma Pact Broker',
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
      hint: '更改整个 dashboard 的语言。',
    },
  },

  states: {
    loading: '加载中…',
    errorTitle: '无法加载此数据',
    errorBody: '如果下方出现技术细节，可以分享给支持团队。',
    retry: '重试',
    unavailableTitle: 'Pact Broker 当前不可用',
    unavailableBody: 'Dashboard 暂时无法连接 broker API。请管理员检查部署配置。',
  },

  nav: {
    broker: 'Pact Broker',
    overview: '概览',
    pacts: 'Pacts',
    verifications: '验证结果',
    matrix: '矩阵',
    environments: '环境',
    tokens: 'API tokens',
    onboarding: 'CLI 指南',
  },

  overview: {
    title: '概览',
    description: '此工作区各服务之间的 consumer-driven 契约。',
    empty: '尚未发布任何 pact。请参阅 CLI 指南发布第一个契约。',
    statParticipants: 'Pacticipants',
    statIntegrations: '集成关系',
    statVerifications: '验证结果',
  },

  verifications: {
    title: '验证结果',
    description: '每个 consumer/provider 组合的最新验证结果。',
    consumer: 'Consumer',
    consumerVersion: 'Consumer 版本',
    provider: 'Provider',
    outcome: '结果',
    verifiedAt: '验证于',
  },

  matrix: {
    title: '矩阵',
    description:
      '针对某个环境的 pacticipant 版本的 can-i-deploy 结论。"未知"表示尚未验证——并不安全。',
    pacticipant: 'Pacticipant',
    choosePacticipant: '选择一个 pacticipant',
    version: '版本',
    environment: '目标环境',
    environmentPlaceholder: '例如 test',
    ask: '检查',
    verdict: {
      deployable: '可部署：此版本的所有验证均通过。',
      'not-deployable': '不可部署：至少一个验证失败。',
      unknown: '未知：缺少验证结果。没有证据请勿部署。',
    },
  },

  onboarding: {
    title: 'CLI 指南',
    description: '为本地开发和 CI/CD 配置 Pact CLI 以连接此 broker。',
    pinPrefix: '所有命令均已通过固定的 CLI 版本验证：',
    localTitle: '本地开发',
    ciTitle: 'CI/CD 流水线',
    copy: '复制',
    credentialsTitle: '凭据与轮换',
    credentialsBody:
      'Machine token 由管理员创建（或通过具有 admin scope 的凭据经 API 创建）。token 值仅在创建时显示一次——请保存到 CI 的 secret store 中。轮换方式：创建新 token、更新 CI secret，然后撤销旧 token。切勿将 token 提交到仓库。',
  },

  pacts: {
    title: 'Pacts',
    description: '在 consumer 与 provider 之间发布的 pact。',
    consumer: 'Consumer',
    provider: 'Provider',
    consumerVersion: 'Consumer 版本',
    verification: '验证结果',
    verificationSuccess: '验证通过',
    verificationFailed: '验证失败',
    verificationNone: '未验证',
    updatedAt: '更新于',
  },

  environments: {
    title: '环境',
    description: 'broker 已知的部署环境。',
    name: '名称',
    displayName: '显示名称',
    production: '生产环境',
    productionTrue: '生产环境',
    productionFalse: '非生产环境',
    createdAt: '创建于',
    deploymentsTitle: '部署记录（每个 pacticipant 的最新版本）',
    deploymentsEmpty: '尚无部署记录。',
    deploymentsUnavailable: '当前无法查看部署记录。',
    deployedPacticipant: 'Pacticipant',
    deployedVersion: '版本',
    deployedEnvironment: '环境',
    deployedAt: '部署于',
    undeployedAt: '卸载于',
  },

  tokens: {
    title: 'API tokens',
    description: '供 CI 和 Pact CLI 使用的 machine credential。凭据值仅在创建时显示一次。',
    name: '名称',
    scopes: '范围',
    purpose: '用途',
    purposeDeveloper: 'Developer（CLI 场景，publish/verify）',
    purposeCi: 'CI（流水线）',
    creator: '创建者',
    createdAt: '创建于',
    status: '状态',
    revoked: '已撤销',
    active: '有效',
    copy: '复制 token',
    copied: '已复制',
    dismiss: '已保存 — 隐藏',
    rotate: '轮换',
    revoke: '撤销',
    createFailed: '创建凭据被拒绝 — 请检查权限或输入内容。',
    mutateFailed: '操作被拒绝 — 凭据状态可能刚被其他人变更。',
    csrfMissing: '您的会话缺少安全令牌 — 请刷新页面；如仍出现，请重新登录后再试。',
    revealed: {
      title: 'Token 仅显示这一次',
      hint: '请立即保存 — "{name}" 不会再显示。刷新页面后将永久丢失。',
    },
    create: {
      title: '创建新凭据',
      submit: '创建凭据',
    },
    confirm: {
      rotateTitle: '轮换此凭据？',
      revokeTitle: '撤销此凭据？',
      hint: '输入完整名称 "{name}" 以确认。轮换会立即令旧 secret 失效；撤销不可撤销。',
      cancel: '取消',
    },
    forbidden: '您没有查看此 tenant 凭据的权限。',
  },
};
