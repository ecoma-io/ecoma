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

    settings: {
      title: '设置',
      description: '实时自定义与预览',
      theming: '主题',
      layout: '布局',
      color: '颜色',
      direction: '方向',
      directionLtr: 'LTR',
      directionRtl: 'RTL',
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
    latestVersion: '最新版本',
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
    description: '供 CI 和 Pact CLI 使用的 machine token。token 值仅在创建时显示一次。',
    name: '名称',
    scopes: '范围',
    createdAt: '创建于',
    revoked: '已撤销',
    active: '有效',
  },
};
