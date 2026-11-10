/**
 * Message catalog 简体中文 — cùng cây key với `en.ts` (kiểm bởi
 * `tests/catalogs.spec.ts`).
 */
export default {
  app: {
    name: 'Ecoma LLM Console',
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
      hint: '更改整个 console 的语言。',
    },
  },

  states: {
    loading: '加载中…',
    errorTitle: '无法加载此数据',
    errorBody: '如果下方出现技术细节，可以分享给支持团队。',
    retry: '重试',
    unavailableTitle: 'Console 当前不可用',
    unavailableBody: 'Console 暂时无法处理请求。请管理员检查部署配置。',
  },

  nav: {
    console: 'LLM 控制台',
    overview: '概览',
  },

  overview: {
    title: '概览',
    description: '你的 LLM gateway 控制台。',
    scaffoldTitle: '脚手架已就绪',
    scaffoldBody: '仪表板外壳和多语言支持已就绪。账户、API key、路由、用量和计费功能尚未实现。',
  },
};
