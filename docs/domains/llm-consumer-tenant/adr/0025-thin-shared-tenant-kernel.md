# ADR-0025 — Thin Shared Tenant Kernel, tenant domain thuộc từng sản phẩm

**Trạng thái:** Accepted · **Ngày:** 2026-11-10 · **Issue:** #9

> ADR này áp cho và ràng buộc **tất cả bốn domain có tenant** — `remote-cache`, `pact-broker`, `llm-consumer-tenant`, `llm-seller-tenant` — không riêng Consumer. Nó xác định cái gì dùng chung (kernel) và phần còn lại thuộc từng sản phẩm. Kernel là dự án Nx `libs/tenant-kernel-domain` (`@ecoma-io/tenant-kernel-domain`, thẻ `type:domain` + `scope:shared` + `runtime:universal`), **một** dự án, một entry point `"."`. Đặt tại đây vì `docs/AGENTS.md` §10 không cho phép một ADR directory toàn cục; `architecture/01-architecture.md` §8 (A25) trỏ về ADR này.

## Bối cảnh

Bốn domain đều dùng các từ **tenant**, **membership**, **owner**, nhưng nghĩa không giống nhau:

- Tại thời điểm mở Issue #9, hai domain đã ship (`remote-cache`, `pact-broker`) biểu diễn owner bằng **role trên membership**, không có cột owner trên `tenants`, không ràng buộc số owner, và membership không có danh tính riêng: khoá là `(tenant_id, sub)`, không `id`, không `status`. Đây là trạng thái trước khi ADR này được chốt; mô hình sau khi ADR này được nêu trong Quyết định §1 và §3.
- Hai domain LLM (`llm-consumer-tenant`, `llm-seller-tenant`) biểu diễn owner là **thuộc tính của tenant**, đúng một owner, membership là **một lần cấp quyền** có `id` riêng, và grant trỏ `membershipId`.

Code hiện tại phản ánh sự khác nhau đó bằng **trùng lặp**: hai `shared.ts` LLM khai lại cùng branded ID, `MAX_OPAQUE_ID_LENGTH`, `isEpochMillis`; hai module membership gần như trùng nhau. Duplication của **cùng một bất biến** là chi phí không mua được gì.

Issue #9 ban đầu yêu cầu chính sách Free/Paid dùng chung (một slot Free cho mỗi Account mỗi sản phẩm, plan, `pending_deletion`) áp lên cả bốn sản phẩm. Yêu cầu đó không đứng được với các quyết định đã accept: `llm-seller-tenant` cấm `status` lifecycle ([ADR-0002](../../llm-seller-tenant/adr/0002-tenant-existence-separate-from-eligibility.md)), hai sản phẩm LLM không có khái niệm Free/Paid, và quy tắc slot Free phụ thuộc quyết định riêng của từng sản phẩm. Vì vậy phạm vi #9 được thu lại thành câu hỏi đúng: **cái gì thật sự dùng chung, và ai sở hữu phần còn lại**.

## Quyết định

### 1. So sánh bốn domain

| Trục                        | `remote-cache`                                                                   | `pact-broker`                                                                          | `llm-consumer-tenant`                                                | `llm-seller-tenant`                                                            |
| --------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Owner                       | `owner_sub` NOT NULL trên `tenants` (opaque `sub`, đúng một owner) `chốt`+`impl` | như trên `chốt`+`impl`                                                                 | thuộc tính `owner` trên tenant `chốt`+`impl`                         | thuộc tính `owner` trên tenant `chốt`+`impl` (ADR-0001)                        |
| Số owner                    | đúng một, không tenant ownerless (`owner_sub` NOT NULL) `chốt`+`impl`            | như trên `chốt`+`impl`                                                                 | đúng một, không có tenant ownerless `chốt`+`impl`                    | đúng một `chốt`+`impl`                                                         |
| Danh tính membership        | khoá `(tenant_id, sub)`; không `id`, không `status` `impl`                       | khoá `(tenant_id, sub)`; không `id`, không `status` `impl`                             | `id` của **lần** membership; `active`/`revoked` `chốt`+`impl` domain | như Consumer (ADR-0005) `chốt`+`impl`                                          |
| Revoke membership           | không tồn tại `impl`                                                             | chỉ revoke row sinh từ entitlement (`entitlement_revoked_at`) `impl`                   | revoke terminal, giữ row `chốt`+`impl` domain                        | như Consumer `chốt`+`impl`                                                     |
| Role                        | chỉ còn `member`, chỉ là nhãn: runtime không đọc `tenant_members` `chốt`+`impl`  | `admin`/`member`/`viewer`, role `owner` đã loại, chỉ là nhãn `chốt`+`impl`             | không có role; quyền từ grant `chốt`                                 | không có role (ADR-0005) `chốt`                                                |
| Lifecycle tenant            | `status` `active`/`suspended`/`deleted`, không transition rule `chốt`+`impl`     | cùng bộ `status`, không transition rule `chốt`+`impl`                                  | không có `status` `chốt`+`impl`                                      | không có `status` (ADR-0002) `chốt`+`impl`                                     |
| Hạn chế/authorization riêng | API key project-scoped `read`/`write`; entitlement deferred `chốt`+`impl`        | machine token `read`/`write`/`admin`; role người không phải enforce mỗi request `impl` | workspace; deny-by-default `chốt`+`impl`                             | `payout.manage` ghim capability; EC→UC cần hai authorization (ADR-0005) `chốt` |

**Đọc theo một chiều:** hai cột đã ship khác nhau về owner, danh tính membership, lifecycle và grant là động lực của Issue #9 (trạng thái trước khi ADR này), không phải trạng thái hiện tại. Sau khi ADR này, trục owner thống nhất trên cả bốn domain theo Quyết định §3 (đúng một `owner_sub` trên `tenants`); danh tính membership, thu hồi membership, lifecycle và grant vẫn thuộc từng sản phẩm.

### 2. Phần dùng chung: primitive kernel (danh sách đóng, P1–P5)

Kernel là **một** Nx project với **một** entry point `"."`, không subpath export. Mỗi primitive được tiêu thụ độc lập: một domain có thể dùng nhóm này mà không dùng nhóm kia, và không nhóm nào import nhóm nào theo hướng buộc sản phẩm phải nhận cả gói. Kernel không phải bounded context: không database, không network, không service, không đọc clock, không random, không phụ thuộc vòng đời sản phẩm nào. Không có hàm "khởi tạo kernel", không aggregate gốc, và không kiểu nào buộc consumer phải nhận cả năm primitive.

| #   | Primitive                                                    | Bất biến                                                                                                                                                | Áp dụng           |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| P1  | Opaque ID guard: `isOpaqueId` + `MAX_OPAQUE_ID_LENGTH = 200` | Chuỗi đã trim, không rỗng, dài ≤ 200; biên độ này là một **quyết định**, không phải chi tiết code                                                       | tất cả bốn domain |
| P2  | Epoch-millis guard: `isEpochMillis`                          | Số nguyên an toàn (`Number.isSafeInteger`); từ chối `NaN`, số thực, `Infinity`, chuỗi                                                                   | tất cả bốn domain |
| P3  | Owned-tenant fact `{ id, owner }` + guard                    | Đúng một owner là `sub` opaque; không tenant ownerless; guard hình dạng chạy **trước** khi so sánh owner                                                | tất cả bốn domain |
| P4  | Tenant member reference `{ tenantId, actor }`                | Tham chiếu membership tối thiểu; không incarnation, không status, không timestamp                                                                       | tất cả bốn domain |
| P5  | Tenant-scoped collection                                     | Phần tử lệch tenant, sai hình dạng, hoặc tenant context không qua guard làm **cả collection** bị từ chối; không lọc rồi tiếp tục, không ném `TypeError` | tất cả bốn domain |

Cột "Áp dụng" là phạm vi **quy tắc** — mọi domain chịu bound bởi bất invariant tương ứng — không phải bản đồ import. Tiêu thụ guard trong code là theo từng boundary và không sản phẩm nào bị ép tiêu thụ cả năm: P1 được import bởi hai domain LLM và `pact-broker-api` (+ infrastructure của nó), còn `remote-cache` chưa có đường runtime nào xử lý owner nên enforce cùng biên độ bằng constraint persistence (`owner_sub` NOT NULL + CHECK, §3); P2 được import bởi hai domain LLM; P3 được import bởi `llm-consumer-tenant-domain`, còn Seller giữ bất invariant ở kiểu domain (owner là field bắt buộc của aggregate); P4 và P5 hiện chưa có consumer — vẫn nằm trong danh sách đóng đã chốt ở trên và được tiêu thụ khi một boundary thực sự xử lý giá trị đó.

**Không thuộc kernel (không bao giờ):** role, permission, grant, authorization, lifecycle, plan, quota, limit, deletion, retention, suspension, restriction, workspace, machine credential, entitlement. Thêm một trong những khái niệm này vào kernel phải qua ADR mới, kèm bằng chứng hành vi dùng chung.

### 3. Bất biến owner áp cho cả bốn domain

Mọi tenant có **đúng một** owner là một tham chiếu `sub` opaque, được lưu độc lập trên bản ghi tenant (không phải role, không phải grant, không phải membership). Owner có thể hoặc không có là member; một account có thể sở hữu nhiều tenant và là member của nhiều tenant khác; không có quy tắc một-tenant-mỗi-người ở cấp toàn hệ thống. Thu hồi membership **không** được ngầm loại bỏ quyền sở hữu. Owner transfer là nghiệp vụ của từng sản phẩm, không phải kernel.

### 4. Phần thuộc sản phẩm

| Khái niệm                                                                                  | Owner                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant aggregate, `name`, `owner`, lifecycle `status`                                      | từng sản phẩm; `remote-cache` giữ `status` theo [ADR-0017](../../remote-cache/adr/0017-lifecycle-enforcement.md), `pact-broker` giữ `status` theo [`pact-broker/domain-model.md`](../../pact-broker/domain-model.md) §2.5, hai context LLM giữ quyết định riêng |
| Role, permission identifier, grant scope, thứ tự kiểm authorization                        | từng sản phẩm; nội dung permission catalog thuộc `staff-access`                                                                                                                                                                                                 |
| Owner transfer                                                                             | từng sản phẩm; Seller đã chốt (ADR-0001), Consumer chưa chốt                                                                                                                                                                                                    |
| Suspension record (`llm-consumer-tenant`) và restriction verdict (`llm-seller-governance`) | context tương ứng                                                                                                                                                                                                                                               |
| Plan Free/Paid, slot, deletion policy                                                      | `remote-cache` (#12) và `pact-broker` (#13); hai sản phẩm LLM không có Free/Paid                                                                                                                                                                                |
| Quota policy/limits                                                                        | `llm-consumer-tenant` ([`open-boundaries.md`](../../open-boundaries.md) OB-1); quota authority tại gateway là Application concern (A7). Seller không có quota policy                                                                                            |
| Workspace                                                                                  | chỉ `llm-consumer-tenant`                                                                                                                                                                                                                                       |
| Machine credential (API key, machine token)                                                | sản phẩm sở hữu credential đó                                                                                                                                                                                                                                   |
| Product entitlement                                                                        | `staff-access`                                                                                                                                                                                                                                                  |

Ba khái niệm dễ bị gộp, và **không** được gộp:

- **Product entitlement** (`staff-access`) trả lời "account này có được dùng sản phẩm không". Không trả verdict per-request (ADR-0009). Entitlement **có thể** là nguồn tạo membership — `pact-broker` làm vậy, `source = 'entitlement'` — nhưng membership đó chỉ bắt đầu ở role thấp nhất và thu hồi entitlement không được xoá customer membership độc lập.
- **Tenant membership** (sản phẩm) trả lời "account này có quan hệ gì với tenant này". Nó không cấp quyền cụ thể.
- **Authorization** (resource-owning backend) trả lời "request này được phép hay không", deny-by-default, và là nơi duy nhất enforce.

Entitlement của nhân sự nội bộ được chuyển thành membership của **sản phẩm** — đường hiện có của `pact-broker` là projection entitlement, chạy ngoài serving path, khởi đầu ở role thấp nhất. Với dữ liệu do sản phẩm tự seed (tenant nội bộ, Superadmin), đường đó là bước bootstrap/seed tường minh ([ADR-0020](../../staff-access/adr/0020-bootstrap-seed-contract.md)), không phải suy diễn từ signup/login.

### 5. Quy tắc phụ thuộc và vị trí Nx

Kernel mang `type:domain` + `scope:shared` + `runtime:universal`:

- `scope:shared` là đáy của trục ownership: kernel chỉ được phụ thuộc `scope:shared`, nên nó **không** import được `scope:platform`, contract hay implementation của bất kỳ context nào.
- Mọi scope nghiệp vụ đã được phép phụ thuộc `scope:shared`, nên không cần scope mới. Scope mới sẽ phải khai trong `.oxlintrc.json` và `KNOWN_SCOPES`, đồng thời tạo thêm một trục ownership không có nội dung riêng.
- **Không** đặt kernel vào `scope:llm-shared`: scope đó là nhóm sở hữu `llm-inference`/`llm-usage`/`llm-financial`, không phải catch-all cho tenant.
- **Không** đặt kernel ở `type:contracts`: contract không mang business logic, và allowlist scope khớp **bất kỳ** tag trong danh sách nên một contract `scope:shared` sẽ khiến kernel đi vào mọi scope LLM qua đường contract.
- Kernel không tạo đường phụ thuộc mới giữa các context: Consumer và Seller cùng phụ thuộc `scope:shared` chứ không phụ thuộc nhau, nên bất biến của [ADR-0019](./0019-llm-scope-ownership-and-dependency-matrix.md) giữ nguyên. Kernel không được dùng làm cầu nối để context này đọc implementation của context khác.
- Sản phẩm **adapt tại boundary của mình**: giữ branded ID riêng, map reason code của kernel sang error vocabulary của mình, và giữ adapter persistence của mình. Kernel không import package của sản phẩm nào và không áp error vocabulary lên sản phẩm.

### 6. Hệ quả

- Kernel biến "owner không phải role" thành bất biến kiểm được thay vì quy ước. Việc loại role-based membership và tenant lifecycle khỏi kernel không phải kết luận tạm: nhận lại chúng cũng phải qua ADR mới, kèm bằng chứng hành vi dùng chung mà hiện chưa có.
- `remote-cache` và `pact-broker` lưu owner trên bản ghi tenant như mọi domain khác (§3); role trên membership của hai sản phẩm đó không còn là nguồn ownership và role `owner` bị loại khỏi từ điển role của membership. Kernel không đưa role vào membership của sản phẩm nào.
- Môi trường chưa phát hành: không backfill, không legacy fallback, không dual-write/read, không compatibility adapter. Schema validated từ database sạch; migrations có thể được thay thế tại chỗ (idempotent DDL, không ledger, chưa phát hành).
- Kernel **không** giải quyết trường hợp owner account không còn khả dụng. `owner` là `sub` opaque, không FK; cả hai context LLM đều để chính sách này chưa chốt. Kernel chỉ bảo đảm hình dạng đúng-một-owner; điều kiện, approval và đường xử lý vẫn thuộc từng sản phẩm.

### 7. Phương án bị loại

1. **Một shared Tenant kernel đầy đủ** — aggregate, lifecycle, role và policy dùng chung. Bị loại: không có bất biến chung nào bảo vệ được lifecycle khác nhau thật giữa bốn sản phẩm, và một aggregate chung buộc mọi sản phẩm đổi cùng lúc khi một sản phẩm đổi.
2. **Bốn implementation độc lập hoàn toàn.** Bị loại: giữ nguyên trùng lặp của cùng một bất biến, và không có chỗ ghi lại rằng "owner không phải role" là quyết định chứ không phải tình cờ.

## Liên quan

- Issue #9 — quyết định này; phạm vi và tiêu chí nghiệm thu đã được cập nhật theo ADR.
- #54 — hiện thực kernel P1–P5 và áp model owner độc lập trên cả bốn domain.
- #12, #13 — sở hữu chính sách plan/Free và slot; #14, #15 — funding và seller identity/eligibility; #16, #25 — composition entry point; #20, #21, #23 — bootstrap tenant của từng sản phẩm; #24 — tenant/quota của Consumer.
- [ADR-0018](../../llm-seller-governance/adr/0018-seller-bounded-context-split.md), [ADR-0019](./0019-llm-scope-ownership-and-dependency-matrix.md) — tách context và ba scope LLM; giữ nguyên hiệu lực.
- [ADR-0001](../../llm-seller-tenant/adr/0001-seller-tenant-ownership-and-transfer.md), [ADR-0002](../../llm-seller-tenant/adr/0002-tenant-existence-separate-from-eligibility.md), [ADR-0005](../../llm-seller-tenant/adr/0005-membership-grants-and-financial-permission-boundary.md) — mô hình Seller tenant; ADR này không sửa nội dung nào.
- [ADR-0015](../../remote-cache/adr/0015-remote-cache-bounded-context.md), [ADR-0017](../../remote-cache/adr/0017-lifecycle-enforcement.md) — tenant của `remote-cache`; không đổi.
