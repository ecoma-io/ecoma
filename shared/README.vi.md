---
name: shared
lang: vi
description: Thư viện dùng chung (design system, plumbing webview desktop-shell), app shell do workspace sở hữu (Storybook design-system và cổng e2e), và tooling workspace (dev-cli, ESLint rule, repo-care)
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# Shared

Nền tảng chung (substrate) mà mọi sản phẩm trong workspace đứng trên đó. Đây là
cây thư mục duy nhất trong repo có thể import được từ mọi phạm vi, và đó chính
là lý do ngưỡng để đưa một thứ gì đó vào `shared/` phải cao: một thứ chỉ thuộc
về `shared/` khi thực sự có nhiều hơn một sản phẩm cần đến nó, chứ không phải
vì nó _trông_ có vẻ generic. Một lib được đề xuất ở đây mà chỉ có một consumer
thật là một tuyên bố đang chờ xét lại (a claim under review), không phải một
sự thật đã chốt — vài lib bên dưới thẳng thắn nói rõ điều đó.

`shared/libs` không được phép import một product domain, và các domain luôn
độc lập với nhau; cả hai ràng buộc này đều được Nx thực thi
(`@nx/enforce-module-boundaries`, qua tag trong từng `project.json`). Cơ chế
của ranh giới đó và registry của tooling nằm ở [`shared/CLAUDE.md`](./CLAUDE.md)
— file này là bản đồ dành cho người đọc, còn file kia là hợp đồng được máy
kiểm tra.

## Ba tầng con

**[`shared/apps`](./apps)** — các app shell do workspace sở hữu, phục vụ hạ
tầng dùng chung chứ không thuộc riêng sản phẩm nào. Chúng tồn tại vì một
artifact có vòng đời build và deploy riêng không thể nằm trong một lib
buildless:

| App                                                       | Nó là gì                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| [`design-system`](./apps/design-system/README.md)         | Host Storybook render các story và design docs của `core-ui`. |
| [`design-system-e2e`](./apps/design-system-e2e/README.md) | Cổng chặn Playwright trên output đã build của Storybook đó.   |

**[`shared/libs`](./libs)** — mã runtime dùng chung giữa các sản phẩm, được
các shell và lib khác consume tại build time:

| Lib                                         | Nó là gì                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| [`core-tauri`](./libs/core-tauri/README.md) | Phần plumbing webview của Tauri dùng chung (window chrome) cho các desktop shell. |
| [`core-ui`](./libs/core-ui/README.md)       | Alloy — design system mà mọi UI sản phẩm compose từ đó.                           |

**[`shared/tools`](./tools)** — xưởng làm việc (workshop), không phải sản
phẩm. Các tool này không ship trong bất kỳ app nào; chúng tồn tại để những
quy tắc lẽ ra sẽ mai một thành văn xuôi (prose) được thực thi bằng máy thay vì
chỉ nằm trên giấy: [`dev-cli`](./tools/dev-cli/) (các lệnh dev cục bộ, một số
là CI gate), [`eslint-local-rules`](./tools/eslint-local-rules/) (rule ESLint
cục bộ thực thi bằng máy các phần practice mà rule có sẵn không phủ tới),
[`repo-care`](./tools/repo-care/) (tự động hóa bề mặt repository — triage
issue, review practice PR mang tính tư vấn — chạy từ GitHub Actions).

## Thứ tự đọc

Bắt đầu từ [`CLAUDE.md`](../CLAUDE.md) ở gốc repo để nắm practice (Rules 1–14)
mà mọi thứ bên dưới đều phải tuân theo. Mỗi mục ở trên trỏ tới README của
subproject tương ứng để hiểu phần "tại sao", và tới `CLAUDE.md` của nó để nắm
cơ chế — hai loại tài liệu này được giữ tách bạch, không lặp lại nội dung của
nhau.
