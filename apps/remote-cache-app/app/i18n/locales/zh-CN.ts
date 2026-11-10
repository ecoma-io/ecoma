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
  },

  overview: {
    title: '概览',
    description: 'Remote Cache 管理应用。',
    scaffoldTitle: '应用外壳已就绪',
    scaffoldBody:
      '管理应用外壳和多语言支持已就绪。仪表板、缓存管理、租户、API 密钥和其他业务功能尚未实现。',
  },
};
