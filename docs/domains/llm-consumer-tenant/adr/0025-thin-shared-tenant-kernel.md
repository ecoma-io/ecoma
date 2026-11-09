# ADR-0025 — Thin Shared Tenant Kernel, tenant domain thuộc từng sản phẩm

**Trạng thái:** Accepted · **Ngày:** 2026-11-10 · **Issue:** #9

> ADR này áp cho cả bốn context có tenant — `remote-cache`, `pact-broker`, `llm-consumer-tenant`, `llm-seller-tenant` — không riêng Consumer. Đặt tại đây vì `docs/AGENTS.md` §10 không cho phép một ADR directory toàn cục; `architecture/01-architecture.md` §8 (A25) trỏ về ADR này. Cùng lý do đặt chỗ với [ADR-0019](./0019-llm-scope-ownership-and-dependency-matrix.md).

## Bối cảnh

Bốn context đều dùng các từ **tenant**, **membership**, **owner**, nhưng nghĩa không giống nhau:

- Hai context đã ship (`remote-cache`, `pact-broker`) biểu diễn owner bằng **role trên membership**, không có cột owner trên `tenants`, không ràng buộc số owner, membership không có danh tính riêng và không có lịch sử revoke.
- Hai context LLM (`llm-consumer-tenant`, `llm-seller-tenant`) biểu diễn owner là **thuộc tính của tenant**, đúng một owner, membership là **một lần cấp quyền** có `id` riêng, và grant trỏ `membershipId` để quyền của lần đã revoke không sống lại.
- Hai context đã ship đặt lifecycle `status` lên tenant (`active`/`suspended`/`deleted`); một context LLM cấm hẳn `status`; context LLM còn lại để vòng đời pháp lý chưa chốt.

Code hiện tại phản ánh sự khác nhau đó bằng **trùng lặp**: hai `shared.ts` LLM khai lại cùng branded ID, `MAX_OPAQUE_ID_LENGTH`, `isEpochMillis`; hai module membership gần như trùng nhau; `libs/backoffice-domain` tự viết lại `AccountId` thay vì import. Duplication có chủ đích, nhưng duplication của **cùng một bất biến** là chi phí không mua được gì.

Issue #9 ban đầu yêu cầu một chính sách Free/Paid dùng chung (một slot Free cho mỗi Account mỗi sản phẩm, plan, `pending_deletion`) áp lên cả bốn sản phẩm. Yêu cầu đó không đứng được với các quyết định đã accept: `llm-seller-tenant` cấm `status` lifecycle ([ADR-0002](../../llm-seller-tenant/adr/0002-tenant-existence-separate-from-eligibility.md)), hai sản phẩm LLM không có khái niệm Free/Paid, và quy tắc slot Free phụ thuộc quyết định riêng của từng sản phẩm. Vì vậy phạm vi #9 được thu lại thành câu hỏi đúng: **cái gì thật sự dùng chung, và ai sở hữu phần còn lại**.

## Phương án

1. **Một shared Tenant kernel đầy đủ** — một bounded context `Tenant` dùng chung với aggregate, lifecycle, role và policy. Bị loại: không có bất biến chung nào bảo vệ được lifecycle khác nhau thật giữa bốn sản phẩm, và một aggregate chung buộc mọi sản phẩm đổi cùng lúc khi một sản phẩm đổi. [ADR-0018](../../llm-seller-governance/adr/0018-seller-bounded-context-split.md) đã loại phương án tương tự cho tầng entitlement; `llm-financial` ADR-0001 loại "single shared tenant model".
2. **Bốn implementation độc lập hoàn toàn.** Bị loại: giữ nguyên trùng lặp của cùng một bất biến, và không có chỗ ghi lại rằng "owner không phải role" là quyết định chứ không phải tình cờ — chính khoảng trống đó đã cho phép hai schema đã ship lệch khỏi nhau.
3. **Thin Shared Kernel + tenant domain thuộc sản phẩm** — chỉ chia sẻ domain primitive có ngữ nghĩa **chứng minh được là giống nhau**, phần còn lại mỗi sản phẩm tự sở hữu. Được chọn.

## Quyết định

### 1. So sánh bốn context

`chốt` = quyết định đã accept · `impl` = hành vi đã hiện thực trong code/migration · `mở` = chưa chốt.

| Trục                        | `remote-cache`                                                                                                                                         | `pact-broker`                                                                                                                             | `llm-consumer-tenant`                                                                                                  | `llm-seller-tenant`                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Owner nằm ở đâu             | role `owner` trong `tenant_members`; `tenants` không có cột owner `impl`                                                                               | như trên `impl`                                                                                                                           | thuộc tính `owner` trên tenant `chốt`+`impl`                                                                           | thuộc tính `owner` trên tenant (ADR-0001) `chốt`+`impl`                                         |
| Số owner                    | không ràng buộc: PK `(tenant_id, member_sub)` cho phép 0..N role owner `impl`                                                                          | không ràng buộc `impl`                                                                                                                    | đúng một, không có tenant ownerless `chốt`+`impl`                                                                      | đúng một `chốt`+`impl`                                                                          |
| Danh tính membership        | khoá `(tenant_id, member_sub)`; không `id`, không `status` `impl`                                                                                      | khoá `(tenant_id, sub)`; không `id`, không `status` `impl`                                                                                | `id` của **lần** membership; `active`/`revoked` `chốt`+`impl` domain                                                   | như Consumer (ADR-0005) `chốt`+`impl`                                                           |
| Revoke membership           | không tồn tại `impl`                                                                                                                                   | chỉ revoke được row sinh từ entitlement (`entitlement_revoked_at`) `impl`                                                                 | revoke terminal, giữ row `chốt`+`impl` domain                                                                          | như Consumer `chốt`+`impl`                                                                      |
| Role                        | `owner`/`member` `impl`                                                                                                                                | `owner`/`admin`/`member`/`viewer` `impl`                                                                                                  | không có role; quyền từ grant `chốt`                                                                                   | không có role (ADR-0005) `chốt`                                                                 |
| Grant                       | không có bảng grant `impl`                                                                                                                             | không có bảng grant; role + `entitlement_sync_state` `impl`                                                                               | grant trỏ `membershipId`, scope tenant/workspace; không `id`/`status` `chốt`+`impl`; cách thu hồi chưa chốt `mở`       | grant trỏ `membershipId`; có `id`/`status`/`revokedAt` (ADR-0005) `chốt`+`impl`                 |
| Provision/revoke            | không route; seed tay trên DB; runtime role chỉ `SELECT` `impl`                                                                                        | bootstrap idempotent + entitlement sync; không route tenant `impl`                                                                        | hàm domain thuần; provision tường minh `chốt`+`impl`                                                                   | như Consumer, thêm `transferSellerOwnership` `chốt`+`impl`                                      |
| Chuyển owner                | không có `impl`                                                                                                                                        | không có `impl`                                                                                                                           | **chưa chốt** (§8.2)                                                                                                   | đã chốt + `impl`, một transaction (ADR-0001)                                                    |
| Lifecycle tenant            | `status` `active`/`suspended`/`deleted`, re-check mỗi request (ADR-0017) `chốt`+`impl`                                                                 | cùng bộ `status`; bootstrap không hồi sinh tenant suspended `chốt`+`impl`                                                                 | không có `status`; "bị hạn chế" suy ra từ suspension record; vòng đời pháp lý `mở`                                     | không có `status` (ADR-0002); eligibility suy ra ở governance `chốt`                            |
| Hạn chế/authorization riêng | API key project-scoped `read`/`write`; entitlement deferred (ADR-0015) `chốt`+`impl`                                                                   | machine token `read`/`write`/`admin`; role người không phải đường enforce per-request `impl`                                              | workspace; deny-by-default; suspension chặn trước owner; permission tenant-wide khai báo từng permission `chốt`+`impl` | không workspace; `payout.manage` ghim capability; EC→UC cần hai authorization (ADR-0005) `chốt` |
| Ràng buộc DB                | unique name; PK membership; trigger chặn un-revoke trên `api_keys` (không phải membership); `audit_log` append-only bằng grant `SELECT, INSERT` `impl` | unique name index, composite FK tenant, `ON CONFLICT` race-safe, partial index non-active, trigger append-only trên `audit_events` `impl` | chỉ đặc tả; partial unique index chưa có trong migration nào `chốt`,`mở` ở DDL                                         | như Consumer, cộng partial unique grant (ADR-0005) `chốt`                                       |

Đọc bảng này theo một chiều: **giống nhau về ngữ nghĩa chỉ ở hai cột LLM**. Hai cột đã ship khác ở cả bốn trục quyết định — owner, danh tính membership, lifecycle, grant — nên không có "cùng tên ⇒ cùng nghĩa" nào để dựa vào.

### 2. Phần được chia sẻ: một kernel mỏng

Kernel là **một Nx project** `libs/tenant-kernel-domain` (`@ecoma-io/tenant-kernel-domain`), chứa đúng ba nhóm sau. ADR này chốt thiết kế, không hiện thực; việc tạo project là Issue Delivery riêng.

1. **Owned-tenant fact.** Một hình dạng tối thiểu `{ id, owner }` với `owner` là **tham chiếu opaque** tới Account identity (`sub`), cộng guard từ chối record thiếu owner. Kernel **không** định nghĩa aggregate `Tenant`: không `name`, không `createdAt`, không lifecycle, không operation trên tenant. Sản phẩm giữ type `Tenant` của mình và có thể mở rộng fact này. Vì membership của kernel không có trường `owner` hay `role`, bất biến "owner không phải role và không phải grant" được bảo đảm bằng **hình dạng**, không bằng kiểm tra runtime.
2. **Membership incarnation.** Record `{ id, tenantId, actor, status: 'active' | 'revoked', createdAt, revokedAt }` cùng các hàm: provision tường minh (từ chối `id` trùng trong tenant, từ chối actor đã có membership `active`), revoke terminal (từ chối ghi đè `revokedAt`), kiểm tra `active`, và tra cứu trả về **tập** để authorization tự phát hiện > 1 bản ghi active thay vì làm mịn dữ liệu hỏng.
3. **Guard nhất quán collection.** Mọi collection membership phải thuộc đúng tenant đang xét; phần tử sai hình dạng hoặc lệch tenant làm **cả collection** bị từ chối, không lọc rồi tiếp tục. Lọc im lặng biến lỗi dữ liệu thành quyết định authorization.

Ba nhóm này được chia sẻ vì chúng có ngữ nghĩa **chứng minh được là giống nhau** ở hai context LLM: cùng bất biến, cùng guard, cùng ca kiểm thử (re-provision tạo `id` mới, grant của lần cũ không authorize lại, ambiguous collection bị từ chối). Kernel tồn tại để hai context đó không phải sửa cùng một luật ở hai nơi.

Kernel **không** chia sẻ grant, role, permission, scope, authorization ladder hay thứ tự kiểm. Grant của hai context LLM chỉ giống nhau ở **bất biến** "hiệu lực phải đối chiếu với incarnation đang active", và bất biến đó phát biểu được bằng một câu trên record membership — không đáng một abstraction riêng, càng không đáng một hình dạng grant chung (Consumer không có `id`/`status`, Seller có). Mỗi context tự kiểm.

### 3. Phần thuộc sản phẩm

| Khái niệm                                                                                  | Owner                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant aggregate, `name`, lifecycle `status`, deletion/retention                           | từng sản phẩm (`remote-cache` và `pact-broker` giữ `status` theo ADR-0017/ADR-0002 riêng của mình; hai context LLM giữ quyết định riêng) |
| Role, permission identifier, grant scope, thứ tự kiểm authorization                        | từng sản phẩm; nội dung permission catalog thuộc `staff-access`                                                                          |
| Owner transfer                                                                             | từng sản phẩm; Seller đã chốt (ADR-0001), Consumer chưa chốt                                                                             |
| Suspension record (`llm-consumer-tenant`) và restriction verdict (`llm-seller-governance`) | context tương ứng                                                                                                                        |
| Plan Free/Paid, slot, quota, limit, deletion policy                                        | `remote-cache` (#12) và `pact-broker` (#13); hai sản phẩm LLM không có khái niệm này                                                     |
| Workspace                                                                                  | chỉ `llm-consumer-tenant`                                                                                                                |
| Machine credential (API key, machine token)                                                | sản phẩm sở hữu credential đó                                                                                                            |
| Product entitlement                                                                        | `staff-access`                                                                                                                           |

Ba khái niệm dễ bị gộp, và **không** được gộp:

- **Product entitlement** (`staff-access`) trả lời "account này có được dùng sản phẩm không". Nó không tạo membership và không trả verdict per-request (ADR-0009).
- **Tenant membership** (sản phẩm) trả lời "account này có quan hệ gì với tenant này". Nó không cấp quyền cụ thể.
- **Authorization** (resource-owning backend) trả lời "request này được phép hay không", deny-by-default, và là nơi duy nhất enforce.

Entitlement của nhân sự nội bộ chuyển thành membership bằng bước bootstrap/seed tường minh ([ADR-0020](../../staff-access/adr/0020-bootstrap-seed-contract.md)), không bằng suy diễn.

### 4. Quy tắc phụ thuộc và vị trí Nx

Kernel mang `type:domain` + `scope:shared` + `runtime:universal`:

- `scope:shared` là đáy của trục ownership: kernel chỉ được phụ thuộc `scope:shared`, nên nó **không** import được `scope:platform`, contract hay implementation của bất kỳ context nào. Đó là ràng buộc mong muốn, không phải hạn chế.
- Mọi scope nghiệp vụ đã được phép phụ thuộc `scope:shared`, nên không cần scope mới. Scope mới sẽ phải khai trong `.oxlintrc.json` và `KNOWN_SCOPES`, đồng thời tạo thêm một trục ownership không có nội dung riêng.
- **Không** đặt kernel vào `scope:llm-shared`: scope đó là nhóm sở hữu `llm-inference`/`llm-usage`/`llm-financial`, không phải catch-all cho tenant.
- **Không** đặt kernel ở `type:contracts`: contract không mang business logic, và allowlist scope khớp **bất kỳ** tag trong danh sách nên một contract `scope:shared` sẽ khiến kernel đi vào mọi scope LLM qua đường contract.
- Kernel không phải bounded context, không có database, không sở hữu dữ liệu. Nó không tạo đường phụ thuộc mới giữa các context: Consumer và Seller cùng phụ thuộc `scope:shared` chứ không phụ thuộc nhau, nên bất biến của [ADR-0019](./0019-llm-scope-ownership-and-dependency-matrix.md) giữ nguyên. Kernel không được dùng làm cầu nối để context này đọc implementation của context khác.
- Sản phẩm **adapt tại boundary của mình**: giữ branded ID riêng, map reason code của kernel sang error vocabulary của mình, và giữ adapter persistence của mình. Kernel không import package của sản phẩm nào và không áp error vocabulary lên sản phẩm.

### 5. Không bắt buộc tiêu thụ

Kernel chỉ dành cho context có đúng ngữ nghĩa đó. `remote-cache` và `pact-broker` **không** áp dụng model membership incarnation: chúng đang dùng khoá `(tenant_id, sub)` không có lịch sử revoke, và việc chuyển sang incarnation là thay đổi ngữ nghĩa kèm migration, không phải tái sử dụng code. Nếu một trong hai về sau thêm thuộc tính owner trên tenant, nó **có thể** dùng owned-tenant fact; đó là quyết định của sản phẩm, không được suy ra từ ADR này. Không có yêu cầu nào ở đây buộc bốn context thay đổi cùng lúc.

## Hệ quả

- Issue #9 không còn là nguồn của chính sách Free/Paid dùng chung. Quy tắc plan và slot Free thuộc #12 (`remote-cache`) và #13 (`pact-broker`); hai sản phẩm LLM không có Free/Paid.
- Hai domain model LLM đang mô tả cùng một bất biến membership sẽ chuyển sang dùng kernel khi kernel được hiện thực; hình dạng public của hai domain library không đổi.
- `remote-cache` và `pact-broker` không đổi gì. Khoảng lệch "owner chỉ là role, không ràng buộc đúng một owner" ở hai schema đó là **hành vi hiện tại của sản phẩm**, không phải vi phạm ADR này; muốn đổi thì mở quyết định ở context tương ứng.
- Chi phí phải trả: khi một sản phẩm cần hành vi khác đi (owner không phải thành viên, nhiều owner, ownerless tenant), nó **không** được thêm nhánh vào kernel. Nó ngừng tiêu thụ kernel, hoặc kernel phải đổi bằng ADR mới.
- Thêm khái niệm vào kernel — role, permission, grant, authorization, lifecycle, plan, quota, limit, deletion, transfer, suspension, restriction, workspace, credential — phải qua ADR mới. Đây là điều kiện chống biến kernel thành bounded context `Tenant` bằng đường sau.
- Điều kiện đảo ngược: nếu một context thứ ba tiêu thụ kernel với ngữ nghĩa khác hai context LLM, hoặc nếu xuất hiện yêu cầu đa owner/ownership uỷ nhiệm, giả định "đúng một owner, owner là thuộc tính tenant" không còn đúng và phải mở lại quyết định.

## Liên quan

- Issue #9 — quyết định này; phạm vi và tiêu chí nghiệm thu đã được cập nhật theo ADR.
- #12, #13 — sở hữu chính sách plan/Free và slot; #14, #15 — funding và seller identity/eligibility; #16, #25 — composition entry point, không liên quan tới tenant; #20, #21, #23 — bootstrap tenant của từng sản phẩm; #24 — tenant/quota của Consumer.
- [ADR-0018](../../llm-seller-governance/adr/0018-seller-bounded-context-split.md), [ADR-0019](./0019-llm-scope-ownership-and-dependency-matrix.md) — tách context và ba scope LLM; giữ nguyên hiệu lực.
- [ADR-0001](../../llm-seller-tenant/adr/0001-seller-tenant-ownership-and-transfer.md), [ADR-0002](../../llm-seller-tenant/adr/0002-tenant-existence-separate-from-eligibility.md), [ADR-0005](../../llm-seller-tenant/adr/0005-membership-grants-and-financial-permission-boundary.md) — mô hình Seller tenant; ADR này không sửa nội dung nào.
- [ADR-0015](../../remote-cache/adr/0015-remote-cache-bounded-context.md), [ADR-0017](../../remote-cache/adr/0017-lifecycle-enforcement.md) — tenant của `remote-cache`; không đổi.
