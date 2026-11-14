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
    matrix: '矩阵',
    environments: '环境',
    tokens: 'API tokens',
  },

  overview: {
    title: '概览',
    description: '此工作区各服务之间的 consumer-driven 契约。',
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
    createdAt: '创建于',
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
