export const messages = {
  en: {
    shell: {
      title: "ecoma.io",
      description:
        "Ecoma — the self-hostable labor operating system where humans, AI, and rules/code are the same kind of labor resource.",
      status: "This page is a shell: it proves the plumbing, not the product.",
      languages: "This workspace publishes in the languages below:",
      notFound: "Nothing is served here yet.",
      notFoundHint: "This address exists, but the Website Charter has not shipped its content.",
      error: "Something went wrong.",
      errorHint: "The shell could not render this page. Try the languages below.",
      home: "Home",
    },
  },
  vi: {
    shell: {
      title: "ecoma.io",
      description:
        "Ecoma — hệ điều hành lao động tự lưu trữ, nơi con người, AI và quy tắc/mã là cùng một loại nguồn lực lao động.",
      status: "Trang này là một shell: nó chứng minh hệ thống đường ống, không phải sản phẩm.",
      languages: "Workspace này xuất bản bằng các ngôn ngữ dưới đây:",
      notFound: "Chưa có gì được phục vụ tại đây.",
      notFoundHint: "Địa chỉ này tồn tại, nhưng Website Charter chưa ra mắt nội dung của nó.",
      error: "Đã xảy ra lỗi.",
      errorHint: "Shell không thể hiển thị trang này. Hãy thử các ngôn ngữ bên dưới.",
      home: "Trang chủ",
    },
  },
  zh: {
    shell: {
      title: "ecoma.io",
      description: "Ecoma — 可自托管的劳动操作系统，人类、AI 与规则/代码是同一类劳动资源。",
      status: "此页是一个外壳：它证明的是管道，不是产品。",
      languages: "该工作区使用以下语言发布：",
      notFound: "此处尚无内容。",
      notFoundHint: "该地址存在，但 Website Charter 尚未发布其内容。",
      error: "出错了。",
      errorHint: "此页面无法渲染。请尝试下面的语言。",
      home: "首页",
    },
  },
} as const;

export type ShellMessages = typeof messages;
