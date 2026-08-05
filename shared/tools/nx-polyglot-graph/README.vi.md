---
name: nx-polyglot-graph
subsystem: shared
lang: vi
description: Plugin Nx graph cục bộ thêm edge liên project Go/Rust/Python bằng cách đọc manifest tĩnh.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# nx-polyglot-graph

<!-- readme:why -->

## Tại sao nó tồn tại

`pnpm nx affected` chỉ biết một dependency khi nó xuất hiện thành edge trong
project graph của Nx, mà cơ chế tự nhận diện graph của Nx lại không hiểu
import Go, dependency path của Cargo, hay một entry trong
`[tool.uv.sources]`. Thiếu plugin này, sửa một lib Go sẽ không bao giờ đánh
dấu project Go anh em là affected, âm thầm làm hỏng
`pnpm nx affected -t lint test typecheck build e2e` cho mọi project đa ngôn ngữ
trong workspace. Các plugin cộng đồng cho vấn đề này (gonx, `@nxlv/python`)
giải quyết bằng cách infer luôn cả target từ toolchain — nhưng repo này cố ý
giữ target viết tay trong từng `project.json` (root `CLAUDE.md` → Workspace
Execution), để `targetDefaults` của `nx.json` cùng `nx:run-commands` riêng
của từng project đa ngôn ngữ vẫn là nguồn sự thật duy nhất cho việc target
làm gì. Plugin này chỉ tồn tại để bù đúng phần edge còn thiếu, không lén đưa
việc infer target quay trở lại.

Khoảng trống đó còn một nửa nữa. `@nx/enforce-module-boundaries` chỉ đọc
được JavaScript và TypeScript, nên trong một project Go hay Rust, các tag
`layer:`, `scope:` và `license:` chỉ là lời khai báo không có cơ chế nào đứng
sau: một file `.go` được thêm import vi phạm trục layer vẫn hiện edge trong
graph và vẫn qua `lint`. Project này là nơi cơ chế đó đang được xây, nên giờ
nó mang thêm một tầng phân tích và các entry point riêng bên cạnh plugin
graph.

<!-- readme:consumers -->

## Ai đang consume nó

Chính Nx. Nó được khai báo trong `nx.json` → `plugins` dưới tên
`./shared/tools/nx-polyglot-graph/index.mjs` và chạy ở bất cứ đâu Nx tự dựng
project graph của nó — `nx affected`, `nx graph`, `nx run-many`. Không có
mã sản phẩm hay tooling nào import nó trực tiếp.

Nó cũng khai báo hai executable dưới dạng entry `bin` trong `package.json`
của chính nó: `cli.mjs` cho lần chạy ở terminal và `lsp.mjs` cho editor. Cả
hai chưa enforce gì cả, và cả hai đều nói thẳng ra thay vì giả vờ —
`cli.mjs check` thoát với mã khác 0.

<!-- readme:ecosystem -->

## Vị trí trong hệ sinh thái

Nó là anh em ngang hàng với `dev-cli`, `eslint-local-rules`, và `repo-care`
dưới `shared/tools` — tooling của workspace, không phải dependency runtime
của bất kỳ sản phẩm nào. Nó bổ sung chứ không thay thế `project.json` viết
tay của từng project đa ngôn ngữ: những file đó khai báo project và target
`build`/`test`/`lint` của nó (Go/Rust/Python qua `nx:run-commands` trên
`go`/`cargo`/`uv`), còn plugin này chỉ thêm edge giữa chúng để `nx affected`
nhìn xuyên được ranh giới ngôn ngữ.

<!-- readme:boundary -->

## Ranh giới — nó cố ý không làm gì

Nó không bao giờ tạo project node và không bao giờ infer hay gắn target —
node và target luôn được viết tay trong `project.json` của từng project.
Các resolver không bao giờ shell ra `go`, `cargo`, hay `uv`; chúng chỉ đọc
file manifest và source đã được track (regex trên import Go theo format
chuẩn gofmt, `smol-toml` cho `Cargo.toml`/`pyproject.toml`), nên graph tính
được trên máy chưa từng cài các toolchain đó, kể cả bước doc-gate của CI và
contributor chỉ làm TS. Nó cũng không bao giờ ghi external package
(crates.io, PyPI, Go module proxy) thành `externalNodes` — chỉ edge giữa
project với project mới có ý nghĩa với `nx affected`.

Nó cũng không chép lại bộ luật ranh giới. Bảng constraint chỉ nằm một chỗ, ở
gốc workspace trong `module-boundaries.config.mjs`, chính là file ESLint cũng
đọc; `src/config.mjs` là thứ duy nhất ở đây nạp nó. Và không có gì ở đây giả
định tên project, khu vực, hay giá trị tag của riêng repo này — công cụ còn
phải chạy trên workspace control-plane riêng tư, nên mọi thứ đều đến từ graph
và từ config đó.

<!-- readme:status -->

## Trạng thái

Nửa graph đang hoạt động và là gate thật sự: đây là nguồn duy nhất của edge
liên project Go/Rust/Python trong graph của workspace, được phủ bởi một unit
test cho mỗi resolver cộng với một integration test chạy thẳng entry point
thật của Nx trên một fixture tmpdir.

Nửa analysis đã là thật. `src/analysis/` đọc source TypeScript, JavaScript,
Vue, Go, Rust và Python thành các record import đã resolve — import nào được
viết ra, ở dòng và cột nào, dưới dạng nào, và trỏ tới đâu — theo đúng hình
dạng record đã chốt trong `src/analysis/contract.md`. Phần resolve TypeScript
là chính `ts.resolveModuleName` của TypeScript, còn phần tách `<script>` của
Vue là chính SFC parser của Vue; không cái nào bị viết lại ở đây.

Nửa enforcement thì vẫn là khung, và là một cái khung ồn ào. Chưa có rule nào
dưới `src/rules/`, nên `cli.mjs check` fail thay vì báo cây code sạch, và
`lsp.mjs` không quảng cáo capability nào thay vì tô xanh mọi file. Cơ chế,
giới hạn parse của từng ngôn ngữ, và giả định one-manifest-per-project nằm ở
[`./CLAUDE.md`](./CLAUDE.md).
