---
name: dev-cli
subsystem: shared
lang: vi
description: Bộ command nội bộ biến các điều luật trong CLAUDE.md từ văn xuôi dễ quên thành gate máy kiểm tra thật sự.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# dev-cli

Bộ command nội bộ biến các điều luật trong `CLAUDE.md` từ "mong mọi người
nhớ" thành "quên thì không commit/push/merge được".

<!-- readme:why -->

## Vì sao tồn tại

Repo này có hàng chục điều luật chỉ còn hiệu lực khi có gì đó liên tục kiểm
tra chúng: Rule 13 (không journey marker), mỗi subproject phải có
`CLAUDE.md` riêng, scope của commit phải khớp path đã đổi, mọi practice card
phải còn trỏ đúng câu chữ nó trích. Viết những điều này chỉ dưới dạng văn
xuôi trong `CLAUDE.md` thì chúng sẽ mục dần — người quên, agent quên, và
không có gì báo động khi ai đó vi phạm. `dev-cli` là nơi mỗi điều luật đó trở
thành một hàm nhỏ trả về exit code, được gọi ở đúng chỗ trong vòng đời
commit/push/CI, để practice được cưỡng chế bằng máy chứ không chỉ được ghi
lại. Từ những script rời rạc, giờ tất cả gom về một registry (`COMMANDS`
trong `src/main.mjs`) dùng chung một cách gọi:
`node shared/tools/dev-cli/src/main.mjs <command>`.

<!-- readme:consumers -->

## Ai gọi nó

Không phải mọi command đều được nối vào gate — `lefthook.yml` và
`.github/workflows/ci.yml` mới là nơi nói thật command nào chặn được gì:

- **lefthook pre-commit**: `check-journey-markers-workspace`,
  `check-doc-links`, `check-command-refs`, `check-doctrine`, `check-practice-index`,
  `ensure-commit-identity --check`.
- **lefthook prepare-commit-msg / commit-msg**: `strip-claude-trailers`,
  `check-commit-scope`.
- **CI** (`.github/workflows/ci.yml`): `check-commit-scope --commit <sha>`
  (chạy cho mỗi commit trong PR), `check-contributor-record` (kèm tác giả PR
  trên pull request, dạng trần ở các trường hợp còn lại), và
  `workspace-gates` — toàn bộ gate mức workspace trong một command, danh sách
  thuộc về `WORKSPACE_GATES` trong `src/workspace-gates.mjs` chứ không khai
  lại ở đây hay thành step của workflow. CI của repo cloud chạy đúng command
  đó trên cây gộp, và đó là lý do danh sách là một command chứ không phải một
  dãy step.
- **Target `lint` của từng project** (`project.json` — gần như mọi
  subproject trong repo, kể cả chính `dev-cli`): chạy `check-journey-markers`
  ở dạng per-project. Riêng `check-primitive-artifacts` chỉ được nối vào
  `lint` của `core-ui`, vì quy ước nó soát chỉ thuộc project đó.
  `check-e2e-story-coverage` chỉ được nối vào `lint` của `design-system-e2e`: nó buộc
  mọi component của `core-ui` phải có story, vì đó là thứ đưa component vào
  lượt quét a11y của suite đó. `check-gofmt` chỉ được nối vào `lint` của một
  project Go vừa scaffold (`scaffold-lib`), vì chưa có project Go nào khác
  tồn tại để chạy vào.
- **`commitlint.config.mjs`** import trực tiếp phần discovery
  (project/subsystem) từ `check-commit-scope.mjs` để dựng `scope-enum` — một
  nguồn sự thật duy nhất cho danh sách scope; `list-scopes` in ra đúng phép
  dựng đó để tra cứu thủ công.
- **Không nối vào gate nào** — gọi tay hoặc từ agent skill khi cần việc, chứ
  không phải cưỡng chế liên tục: `scaffold-lib` (skill `scaffold-lib`),
  `pr-facts` (skill `create-pr`), `run-e2e` (target `e2e` của các app
  `*-e2e`), `run-node-tests` (target `test` của `eslint-local-rules`, project
  duy nhất chạy trên test runner có sẵn của Node).

<!-- readme:ecosystem -->

## Vị trí trong hệ sinh thái

`dev-cli` gate **mã nguồn và quy ước repo**, cả cục bộ (lefthook) lẫn trong
CI. Nó không chạm tới bề mặt GitHub (issue, PR comment) — đó là việc của
[`repo-care`](../repo-care/README.vi.md), tool anh em cùng cây
`shared/tools`, tiêu thụ lại đúng nguồn dữ liệu của `check-practice-index`
(`practice-index.json`) cho rubric review PR của riêng nó. `dev-cli` cũng là
nơi duy nhất chứa logic phát hiện Rule 13 (`check-journey-markers`, đọc
`journey-markers.config.json` ở repo root), được
[`eslint-local-rules`](../eslint-local-rules/README.vi.md) dùng lại cùng
nguồn pattern cho hai rule ESLint tương ứng — hai lớp cưỡng chế của cùng một
luật (khớp file/tên vs. khớp AST), không phải hai bản sao độc lập.

<!-- readme:boundary -->

## Ranh giới

Không phải một CLI framework — argument parsing giữ tối giản có chủ đích
(xem comment ở đầu `main.mjs`); chỉ nên đổi sang framework khi thật sự có
nhiều command cần đến nó. Không build, không typecheck (`.mjs` thuần ESM, có
chủ đích). Không phải nơi chứa judgment call ngôn ngữ tự nhiên — mọi command
ở đây là kiểm tra xác định (deterministic), đúng Rule 5. Việc cần phán đoán
như review PR hay phân loại issue thuộc về `repo-care`, không phải đây.

<!-- readme:status -->

## Trạng thái

Đang hoạt động như một gate thật sự cho phần lớn command, không phải bản
nháp. Mechanics, invariant, và cạm bẫy chi tiết của từng command nằm ở
[`CLAUDE.md`](./CLAUDE.md) cùng thư mục.
