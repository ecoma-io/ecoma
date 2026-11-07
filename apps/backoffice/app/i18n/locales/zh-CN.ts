/**
 * Message catalog tiếng Trung giản thể — **bản dịch**, không phải nguồn key.
 *
 * Cùng tập key với `en.ts`; kiểm bằng `catalogs.spec.ts` (colocated cạnh file này).
 *
 * ⚠️ Catalog này viết bằng **Hán tự giản thể** (`zh-Hans`), khớp `language` trong
 * registry — không phải `zh-CN` (đó là `code`, giá trị khoá). Hai khái niệm khác
 * nhau và không đổi chỗ cho nhau: `code` khoá catalog, `language` nói với trình
 * đọc màn hình biến thể chữ nào đang hiển thị.
 */
import type { BackofficeMessages } from './messages';

const zhCN: BackofficeMessages = {
  app: {
    // 品牌名，保留拉丁字母原文，不翻译。
    name: 'Ecoma Backoffice',
  },

  shell: {
    home: '首页',

    search: {
      button: '搜索',
      placeholder: '输入命令或关键词...',
      empty: '未找到结果。',
      dialogTitle: '命令面板',
      dialogDescription: '查找要运行的命令...',
    },

    settings: {
      title: '设置',
      description: '实时自定义并预览',
      theming: '主题色',
      layout: '布局',
      color: '主色',
      direction: '文字方向',
      directionLtr: '从左到右',
      directionRtl: '从右到左',
    },

    language: {
      label: '语言',
      // Giữ "backoffice" như `prototype.notice.body` (và như `en.ts`/`vi.ts`):
      // cùng một tên ứng dụng không nên xuất hiện dưới hai dạng trong một catalog.
      hint: '更改整个 backoffice 界面的语言。',
    },
  },

  prototype: {
    notice: {
      body: '此 backoffice 界面仅为原型，所有数据均来自本地内存，不与后端通信，任何操作均不会持久化或被授权。',
    },
  },

  states: {
    loading: '加载中…',
    errorTitle: '无法加载数据',
    // Lý do đầy đủ (trung tính theo chế độ, và không giả định dòng detail luôn
    // có) ở `en.ts` và `catalogs.spec.ts` (colocated cạnh file này). Dùng "客服团队" (nhóm hỗ trợ nói
    // chung) chứ **không** dùng `roles.items.support.name` ("客服人员"), vì tên đó
    // là nhãn của một system-defined role chỉ tồn tại ở chế độ `prototype`: ở chế
    // độ `unavailable` trang Roles render trạng thái lỗi nên không có "客服人员"
    // nào để gửi, và câu này sẽ trỏ vào một thực thể không tồn tại.
    errorBody: '如下方出现技术详情，可提供给客服团队。',
    retry: '重试',
  },

  staff: {
    search: {
      label: '搜索员工',
      placeholder: '按姓名或 Account ID 搜索…',
    },
    filter: {
      label: '按员工状态筛选',
      all: '全部状态',
    },

    column: {
      member: '员工',
      accountId: 'Account ID',
      status: '员工状态',
      roles: '已分配角色',
      entitlements: '产品订阅',
    },
    noRoles: '未分配角色',
    empty: '暂无员工记录。',
    noResults: '未找到匹配的员工。',
    status: {
      active: '在职',
      suspended: '停用',
      terminated: '已终止',
    },
    entitlements: {
      entitled: '已订阅',
      revoked: '已撤销',
      none: '未订阅任何产品',
    },
  },

  audit: {
    title: '审计轨迹',
    description: '授权敏感操作的历史记录 — actor、target、action、时间和结果。',
    column: {
      time: '时间',
      actor: 'Actor',
      target: 'Target',
      action: '操作',
      outcome: '结果',
      reason: '原因',
    },
    outcome: {
      success: '成功',
      failure: '失败',
      denied: '拒绝',
    },
    empty: '暂无审计记录。',
    noResults: '未找到匹配的审计记录。',
  },

  roles: {
    search: {
      label: '搜索角色',
      placeholder: '按角色名称搜索…',
    },
    column: {
      role: '角色',
      permissions: '该角色包含的权限',
    },
    empty: '尚未定义角色。',
    noResults: '未找到匹配的角色。',
    permissionCount: '{count} 个权限',
    items: {
      operator: {
        name: '运维人员',
        description: '负责日常交付与邮件运维。',
      },
      support: {
        name: '客服人员',
        description: '读取员工与邮件记录以协助客户。',
      },
      auditor: {
        name: '审计人员',
        description: '仅可读取授权审计记录。',
      },
    },
  },

  permissions: {
    search: {
      label: '搜索权限',
      placeholder: '按权限 ID、资源域或操作搜索…',
    },
    filter: {
      label: '按资源域筛选',
      all: '全部域',
    },
    column: {
      permission: '权限 ID',
      domain: '资源域',
      action: '操作',
    },
    empty: '尚未定义权限。',
    noResults: '未找到匹配的权限。',
    // `items` 来自两个来源：真实目录（`0003_permission_catalog_seed.sql`）与
    // prototype fixture —— 理由与边界见 `en.ts`。
    items: {
      delivery: {
        redrive: '对已运行的交付任务重新排队。',
      },
      mail: {
        read: '读取事务邮件模板与交付记录。',
        send: '发送事务邮件。',
      },
      // `staff.read` — 真实目录（`0003`）。
      staff: {
        read: '读取员工目录。',
      },
      role: {
        assign: '为员工分配角色。',
        // `role.read` — 真实目录（`0003`）。读取范围与 `listRoles` 一致：
        // 角色目录含 `id` 与 `isSystem`，不含授权与分配记录。
        read: '读取角色目录，并了解哪些角色由系统预定义。',
      },
      audit: {
        read: '读取授权审计记录。',
      },
      // `permission.read` — 真实目录（`0003`）。读取范围与 `listPermissions`
      // 一致：包含 `retired` 记录，因为目录是 sealed 历史，过滤 `retired` 属于
      // UI 的展示决定。
      permission: {
        read: '读取权限目录，包含已退役的条目。',
      },
    },
  },

  onboarding: {
    title: '完善个人资料',
    body: '您的账号还没有显示名称。请设置显示名称，以便同事在员工目录中找到您。',
    setDisplayName: '前往 Account 设置显示名称',
    continue: '暂不设置，继续使用',
    twoFactor: {
      title: '双因素认证',
      comingSoon: '即将推出——目前尚无法注册双因素认证。',
    },
    noDisplayName: '未设置显示名称',
  },

  nav: {
    platform: '平台',
    overview: '概览',
    staff: '员工',
    roles: '角色',
    permissions: '权限',
    audit: '审计',
  },

  pages: {
    overview: {
      title: '概览',
      description: '前往员工、角色与权限页面。',
    },
    staff: {
      title: '员工',
      description: '查看员工、其状态与已分配的角色。',
    },
    roles: {
      title: '角色',
      description: '可分配给员工的角色。',
    },
    permissions: {
      title: '权限',
      description: '按资源域和操作列出的权限目录。',
    },
  },
};

export default zhCN;
