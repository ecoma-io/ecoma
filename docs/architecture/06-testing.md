# 06 — Testing Architecture

> **Phạm vi:** phân loại test theo phạm vi verify, ownership và layout thư mục, nghĩa của ba canonical Nx targets (`test`,
> `test-integration`, `system-test`), cách suite có database/môi trường, và minimum bar theo trách nhiệm service.
> **Không chứa:** cách chạy test trong CI, scheduling, môi trường preview → [`02-delivery.md`](./02-delivery.md) · facts
> platform → [`04-platform-facts.md`](./04-platform-facts.md) · invariant hệ thống → [`01-architecture.md`](./01-architecture.md)
> · cấu trúc Nx project, tag taxonomy → [`05-code-architecture.md`](./05-code-architecture.md).

---

## 1. Purpose and principles

Tài liệu này là **nguồn sự thật canonical duy nhất** về testing architecture; tài liệu khác reference, không duplicate.

1. **Phân loại theo phạm vi verify, không theo tool.** Một test Playwright chạy UI cô lập của một app là test do app đó sở
   hữu, không tự động thành system E2E. Công cụ chạy không quyết định tầng của test.
2. **Unit/component test colocated với subject** trong owning Nx project.
3. **Mỗi suite tự sở hữu setup, support code, fixture và configuration** của chính nó. Chia sẻ hạ tầng test giữa các suite
   phải có lý do tường minh và consumer được nêu tên — không chia sẻ "phòng khi cần".
4. **Test tôn trọng bounded context và database ownership:** truy cập chéo service chỉ qua contract; database của service
   này không bị suite của service khác chạm vào. Invariants → `01-architecture.md` §9, tài liệu này không nhắc lại nội dung.
5. **Tài liệu này là architecture of record.** Nó định nghĩa kiến trúc đã thống nhất của hệ thống, không phải báo cáo trạng
   thái triển khai; khác biệt giữa bản ghi kiến trúc và cây code được theo dõi ở quá trình delivery, không nằm trong tài liệu.

## 2. Test ownership and directory layout

**Colocated (mặc định cho unit/component).** Spec nằm cạnh subject trong owning Nx project; tên file spec = tên file subject

- `.spec.` (vd `main.ts` → `main.spec.ts`).

**App-owned non-colocated.** Suite không colocated của một app nằm dưới `apps/<app>/tests/`, phân loại bằng **thư mục mục
đích**:

| Thư mục         | Chứa gì                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `integrations/` | Tương tác giữa các thành phần của app: component với nhau, adapter, runtime, dependency thật (PostgreSQL, D1, Queue)             |
| `contracts/`    | Verify contract ở biên service. **Không** là nhà thứ hai cho định nghĩa contract — định nghĩa thuộc contract project (`05` §4)   |
| `databases/`    | Hành vi riêng của database: migration, constraint, index, transaction, data integrity — trong phạm vi database project đó sở hữu |
| `browser/`      | Browser regression của UI do app đó sở hữu (ví dụ Playwright) — không phải system E2E                                            |

Danh sách trên phân loại theo **mục đích**, không đóng (non-exhaustive): chỉ tạo thư mục khi có test thật cần nó, không dựng
scaffolding rỗng. Một `tests/fixtures/` hoặc `tests/support/` dùng chung trong app chỉ được phép khi có lý do cụ thể và
consumer được nêu tên.

**System tests.** Nằm ở repo root `system-tests/`, bốn nhóm mục đích `e2e/`, `performance/`, `resilience/`, `smoke/`. Mỗi
suite thực thi được là **một Nx project độc lập** — project config, setup, support, fixture của riêng nó. Mặc định **không
có** `support/` hay `fixtures/` chung ở root; chỉ tách helper dùng chung khi consumer và dependency của nó tường minh.
`system-tests/local-smoke/` là suite smoke của local platform: script verify serving path (HTTPS + redirect apex) mà
`platform-deploy:local-smoke` gọi sau khi lane up xong.

Ví dụ layout canonical cho `backoffice`:

```text
apps/backoffice/
  server/…                      # colocated *.spec.ts cạnh subject
  tests/
    integrations/               # authn middleware, grants, read-routes…
    databases/                  # migration, constraint, data integrity của db-backoffice
    browser/                    # browser regression của UI backoffice (Playwright) — app-owned, không phải system E2E
system-tests/
  e2e/<suite>/                  # mỗi <suite> là một Nx project độc lập
  performance/<suite>/
  resilience/<suite>/
  smoke/<suite>/
```

## 3. Test category semantics

Phân loại theo **phạm vi được verify**:

| Category                | Verify cái gì                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Unit/component          | Logic của một subject trong owning project; dependency ngoài được thay thế bằng giả lập                                    |
| Integration (app-owned) | Nhiều thành phần của **một** app hoạt động với nhau trên dependency thật (PostgreSQL testcontainers, D1 proxy, …)          |
| Contract                | Biên giữa hai deploy unit: consumer verify provider contract qua public surface, không import internals (`05` §4)          |
| Database                | Hành vi của chính database: migration, constraint, index, transaction, data integrity                                      |
| System test             | **Cả hệ thống đang chạy thật**, nhiều deploy unit — không phải một app đơn lẻ: `e2e`, `performance`, `resilience`, `smoke` |

Ba quy tắc áp dụng cho mọi bảng trên:

- **Runner không quyết định category.** Vitest, Playwright hay k6 chỉ là công cụ; đọc test thuộc tầng nào bằng cách đọc nó
  verify phạm vi nào.
- `test-integration` là **nhóm thực thi** (execution grouping), không phải tuyên bố taxonomy: mọi suite nó chạy là
  "app-owned suite", dù về mặt học thuật một file trong đó có thể là unit-type check.

## 4. Canonical Nx targets

Ba tên dưới đây là **canonical contract** — thêm suite mới phải gắn vào đúng target này:

| Target             | Contract                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `test`             | Colocated unit/component tests của project sở hữu                                                                   |
| `test-integration` | **Toàn bộ** app-owned suites dưới `apps/<app>/tests/` — integration, contract, database và mọi suite app-owned khác |
| `system-test`      | Execution target do **từng** system-test Nx project thực thi tự định nghĩa                                          |

Thực thi: `nx run-many -t system-test` chạy mọi system-test project; `nx affected -t system-test -c local` chỉ chọn đúng các
suite bị ảnh hưởng khi project graph phản ánh đúng dependency thật của chúng. Mỗi suite system-test khai báo dependency ở cả
hai tầng graph — hai cơ chế bổ sung cho nhau, không thay thế nhau:

- **Selection (project graph):** `implicitDependencies` trỏ tới các deploy unit mà luồng của suite chạm thật — thay đổi ảnh
  hưởng deploy unit nào thì chọn đúng những suite đi qua deploy unit đó.
- **Prerequisite (task graph):** target `system-test` khai `dependsOn` tới target `local-up` của đúng các deploy unit đó, kèm
  `configurations.local`; cờ `-c local` truyền xuống mọi task prerequisite (task id dạng `platform-deploy:local-up:local`), nên
  một invocation suite tự dựng đủ stack trước khi chạy — suite không chứa script deploy riêng.
- **Tuần tự:** các suite dùng chung một local stack, nên thực thi với `--parallel=1`.

Tên target ngoài ba tên trên không phải tầng phân loại. Cụ thể: `@nx/playwright/plugin` sinh target `e2e` trên project có
`playwright.config.ts` — đó chỉ là **tên target do plugin suy ra**; một suite Playwright chạy UI của một app đơn lẻ vẫn là
browser regression app-owned (§2, §3) và phải gắn vào `test-integration`. Việc `nx affected -t e2e` chọn đúng project theo
graph không thay đổi tầng của test nó chạy.

Phân biệt ba khái niệm Nx hay bị lẫn:

- **Project dependency** — cạnh trên project graph, suy từ import (JS/TS) hoặc `implicitDependencies`; là input của
  `nx affected`.
- **Task-pipeline `dependsOn`** — thứ tự chạy giữa target của các project (vd `apps/home` khai `test` dependsOn
  `["nuxt-prepare", "build", "test-python"]`); không đổi tập project được chọn.
- **Task inputs / cache validity** — cái gì khiến một cache entry còn hợp; không đổi thứ tự hay tập project.

Đặt file vào đúng thư mục **không tự làm** `nx affected` chọn đúng — selection chỉ đúng khi project dependency truthful (§5).

## 5. Dependency graph, affected and cache

- Test được chọn như mọi task khác: `nx affected` đọc project graph. Giữ project dependency truthful — với JS/TS, plugin suy
  từ import, nên import sai là graph sai.
- Cache: task inputs phải phủ mọi thứ test đọc — source, config, fixture. Khi `namedInputs.production` loại spec file, đổi
  một spec làm `test` chạy lại nhưng không buộc build lại production artifact. Cơ chế `namedInputs`/`inputs` → `nx.json`.

## 6. Test environment, isolation, setup, fixtures, cleanup

- **Mặc định:** mỗi suite tự mang harness của mình (container, D1 proxy, …) và tự dọn sau khi chạy. Resource ephemeral trong
  CI phải được thu hồi — quy tắc vệ sinh phía thực thi thuộc `02-delivery.md` §4.
- **Suite phụ thuộc Docker probe Docker một lần mỗi lần chạy** (vitest `globalSetup`) thay vì để từng spec file tự probe.
  **Một suite bắt buộc Docker phải đỏ khi Docker không có — skip không phải kết quả chấp nhận được:** kết quả xanh không bao
  giờ được che việc một suite bắt buộc đã không chạy. Probe dùng chính dependency thật mà suite sắp dùng (một container
  PostgreSQL qua testcontainers) rồi **ném lỗi** khi nó không dựng được, làm toàn bộ lần chạy đỏ — không có đường skip,
  không có cờ bật tắt; một lần chạy bị chặn vì vắng Docker **không** tính là qua gate bắt buộc nào.
- **Database test không vượt ranh giới database ownership** (`01` §9 invariant 5, 7, 25): harness thuộc sở hữu của suite hoặc
  project cần nó — mỗi project tự dựng harness của mình (PostgreSQL qua testcontainers, D1 qua wrangler `getPlatformProxy`).
  **Không** có shared test-support library: import chéo deploy unit bị cấm bởi module-boundary rules (`05` §7), nên hai
  harness giống hệt nhau ở hai deploy unit là **có chủ đích**, không phải nợ kỹ thuật.
- **Readiness là ranh giới riêng, không phải cạnh graph:** `dependsOn` chỉ bảo chứng thứ tự thực thi task — không bảo chứng
  service đang healthy hay config đã sẵn sàng. Readiness của unit deploy thuộc container resource: mỗi container long-running
  khai `wait: true` + healthcheck Docker của chính nó trong chương trình Pulumi, nên `pulumi up` xanh đã là bằng chứng
  container phục vụ thật (trừ những gì healthcheck không nhìn thấy — config nghẽn, OIDC thiếu biến trả 503 fail-closed).
  Suite system-test chống lại đúng phần đó bằng một gate có budget: **suite readiness gate** (`globalSetup` probe đúng
  contract serving của unit mà suite nhắm tới — status code/mắt xích redirect thực tế, không phải TCP connect) với retry có
  budget chỉ áp cho nhóm dấu hiệu "chưa sẵn sàng" thật sự; TLS sai, status bất ngờ là fail ngay. Smoke không phải health
  check: smoke chứng minh serving path qua Traefik cho một luồng cụ thể, không chứng minh unit đủ điều kiện nhận test.
- **Runtime config đọc tại thời điểm dùng, không tin env snapshot:** Nx snapshot môi trường của từng task trước khi
  `platform-deploy:local-up` ghi `.env`, nên trong một invocation duy nhất env của tiến trình suite không chứa `ROOT_DOMAIN`
  (giá trị sinh lúc deploy). Mọi điểm resolve runtime config của suite (config resolver, `globalSetup`, helper trong tiến
  trình test) phải theo cùng một contract: env trước, fallback parse `.env` repo-root **tại thời điểm gọi**; fail-loud kèm
  hướng dẫn chạy `nx affected -t system-test -c local` khi cả hai nguồn đều vắng. Riêng layer `playwright.config.ts` (được
  eval khi build project graph — trước deploy) không đọc `.env`, dùng placeholder-host để không đỏ oan job CI khác.

## 7. Minimum requirements by responsibility and risk

Mục này là **chỉ mục của enforcement kiến trúc**, không phải yêu cầu mới phát minh — mỗi dòng trỏ về invariant của
`01-architecture.md` §9 (trừ A10 ở §8 Decision records):

| Trách nhiệm / rủi ro                                     | Minimum test                                         | Invariant            |
| -------------------------------------------------------- | ---------------------------------------------------- | -------------------- |
| Domain/policy logic (`libs/<bc>-domain`, `-application`) | Unit test trong owning project                       | §9 (vd 8, 16, 26–34) |
| Biên giữa hai deploy unit                                | Contract test qua public surface                     | A10, 7, 15           |
| Service sở hữu database                                  | Database test: migration, constraint, data integrity | 5, 6, 10, 25         |
| Worker reliability (lease, idempotency, retry, DLQ)      | Integration test với dependency thật                 | 8, 9, 12, 13, 14     |

Minimum bar **scale theo blast radius**: một hàm thuần không state cần ít hơn một worker sở hữu migration — càng gần
authoritative state và cross-service contract, bằng chứng test càng không được thiếu.

Bốn dòng trên là **sàn theo trách nhiệm kiến trúc**. Ngoài sàn đó, một category test được thêm khi **hành vi và hậu quả hỏng
hóc của nó** đáp ứng tiêu chí — không phải vì công nghệ có mặt trong project:

| Category              | Khi nào đáng thêm                                                                                                                                                           | Ownership (§2)                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Browser/UI regression | App **user-facing** và lỗi render/navigate/permission trên UI là lỗi người dùng nhìn thấy được (readonly boundary, role gating, luồng chính); không áp cho API/Worker thuần | App-owned `tests/browser/`                    |
| System E2E            | Journey **liên nhiều deploy unit** mà mỗi contract test riêng không chứng minh được end-to-end (vd đăng nhập xuyên account ↔ auth); hệ thống phải đang chạy thật            | `system-tests/e2e/`, mỗi suite một Nx project |
| Smoke                 | Kiểm **hệ thống đã deploy** còn sống và đúng bề mặt công khai, rẻ và nhanh, chạy sau deploy (thay cho "deploy xong là xong")                                                | `system-tests/smoke/`                         |
| Performance           | Có **SLO đo được** (latency, throughput) hoặc rủi ro contention/hot-spot trên tài nguyên chia sẻ; không có con số SLO thì chưa có performance test                          | `system-tests/performance/`                   |
| Resilience            | Yêu cầu **phục hồi** có thể diễn đạt được: failover, retry qua crash, DLQ, resource limit — và hậu quả vi phạm là mất dữ liệu/tiền/downtime                                 | `system-tests/resilience/`                    |

Không project nào cần đầy đủ cả các category; scaffolding rỗng là anti-pattern (§9). Quyết định "không cần" cũng phải nói được
bằng đúng tiêu chí này (vd Worker không UI → không browser test; không SLO → chưa performance test), và ownership không đổi theo
category: colocated vẫn colocated, app-owned vẫn `apps/<app>/tests/`, system-level vẫn `system-tests/` với setup/support của
từng suite.

## 8. CI quality gates

CI chạy target nào trên PR là **delivery policy**, sở hữu bởi `02-delivery.md` (§1 pipeline, §10 test execution) — tài liệu
này chỉ chốt **semantics**: target canonical nào phủ suite nào.

## 9. Naming conventions and anti-patterns

Conventions:

- Colocated spec: `<subject>.spec.ts` cạnh subject, cùng thư mục.
- Support/harness/fixture của một suite nằm **bên trong thư mục suite** đó.
- System-test project: `system-tests/<category>/<suite>/`, mỗi suite một Nx project.

Anti-patterns:

- Phân loại test theo runner/tool thay vì theo phạm vi verify.
- Thư mục `tests/` bãi rác ở root chứa tạp mọi loại.
- Dựng scaffolding thư mục category rỗng trước khi có test thật.
- Nhân bản định nghĩa contract vào `tests/contracts/` của consumer.
- Root test support dùng chung "phòng khi cần", không có consumer tường minh.
- Tin rằng chuyển thư mục là `nx affected` sẽ chọn đúng.
- Đọc `test-integration` như nhãn taxonomy học thuật thay vì nhóm thực thi.
- Spec colocated boot database thật — thứ đó thuộc app-owned suite.
