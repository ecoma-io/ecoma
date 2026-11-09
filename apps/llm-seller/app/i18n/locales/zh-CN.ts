/**
 * Message catalog 简体中文 — cùng cây key với `en.ts` (kiểm bởi
 * `tests/catalogs.spec.ts`).
 */
export default {
  app: {
    name: 'Ecoma LLM Seller',
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
    unavailableTitle: '卖家门户当前不可用',
    unavailableBody: '卖家门户暂时无法访问。请管理员检查部署配置。',
  },

  nav: {
    seller: 'LLM 卖家',
    overview: '概览',
  },

  overview: {
    title: '概览',
    description: '你的 LLM marketplace 卖家门户。',
    scaffoldTitle: '脚手架已就绪',
    scaffoldBody: '卖家界面外壳与本地化已就绪。入驻、验证、offer、定价、收益与结算尚未实现。',
  },
};
