# LLM Consumer Tenant

Bounded context `llm-consumer-tenant`: tenant, membership, workspace, permission grant và suspension record của **Consumer** trong hệ sinh thái LLM. Sở hữu ranh giới cách ly đa tenant và quyền truy cập tài nguyên LLM.

> `llm-consumer-tenant` là tenant của **Consumer** (khách hàng dùng LLM API, console). Nó **không phải** Seller tenant: Seller tenant, ownership, membership và permission grant của Seller thuộc [`llm-seller-tenant`](../llm-seller-tenant/README.md) — hai loại tenant độc lập, không dùng thay nhau ([ADR-0018](../llm-seller-governance/adr/0018-seller-bounded-context-split.md), [`llm-financial/adr/0001`](../llm-financial/adr/0001-independent-seller-console-tenant.md)). Workspace là khái niệm của Consumer tenant; **không có Seller Workspace** (ADR-0018). Tách context và ba Nx scope → [ADR-0018](../llm-seller-governance/adr/0018-seller-bounded-context-split.md), [ADR-0019](./adr/0019-llm-scope-ownership-and-dependency-matrix.md); index ADR → [`adr/`](./adr/README.md).

> **Cross-reference:** catalog canonical → [`docs/domains/README.md`](../README.md) §2 (`llm-consumer-tenant`) · context map → [`docs/domains/context-map.md`](../context-map.md) · ranh giới system-level → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2, §4, §8 · account `sub` opaque → [`docs/domains/glossary.md`](../glossary.md) · quyết định Seller/Console tenant độc lập → [`llm-financial/adr/0001`](../llm-financial/adr/0001-independent-seller-console-tenant.md) · staff-access entitlement → [`docs/domains/staff-access/README.md`](../staff-access/README.md).

## 1. Trách nhiệm

1. **Tenant** — ranh giới cách ly dữ liệu của một tổ chức/customer trong LLM. Mỗi tenant có **đúng một owner**; tenant ownerless không tồn tại.
2. **Membership** — quan hệ giữa một account (`sub`) và một tenant. Provision tường minh; signup/login không bao giờ tự tạo membership. Bất biến incarnation và owned-tenant fact dùng chung với `llm-seller-tenant` qua thin shared kernel → [ADR-0025](./adr/0025-thin-shared-tenant-kernel.md); role, grant, workspace, suspension và authorization vẫn thuộc context này.
3. **Workspace** — không gian làm việc trong LLM (workspace, offer, catalog, thống kê) thuộc **đúng một** Consumer tenant; namespace/storage scope derive từ `(tenant_id, workspace_id)`, không từ input client. Chỉ Consumer tenant có workspace; Seller tenant không có.
4. **Permission grant** — cấp trực tiếp một permission cho một **lần membership**, tại tenant scope hoặc đúng một workspace scope. Không có role entity và không có administration cho custom role.
5. **Authorization** — quyết định allow/deny trên tài nguyên LLM: owner có toàn quyền trong tenant của mình; member chỉ có đúng permission được cấp. Target đang bị suspension chặn thì deny kể cả owner. Backend sở hữu tài nguyên tự enforce.
6. **Suspension** — nhiều record độc lập, mỗi record có vòng đời riêng; "tenant đang bị hạn chế" là **giá trị suy ra** tại thời điểm đánh giá, không phải trạng thái được lưu.
7. **Tenant resolution / selector** — authenticated actor (`sub`) lấy từ verified authentication context; tenant selector có thể do client cung cấp để chọn tenant/resource scope, nhưng backend phải xác minh membership/permission/tenant-resource ownership trước khi dùng; selector không bao giờ là proof of authorization.
8. **Multi-tenant isolation** — mọi domain data gắn tenant; không request nào đọc/ghi lệch tenant.

## 2. Không sở hữu

- Danh tính account và credential/MFA → `account`.
- Giao thức OAuth 2.0/OIDC → `auth`.
- Ledger credit, payment transaction, payout, số dư, reconciliation → `payment` / `llm-financial`; **billing account ≠ tenant** (xem §4).
- Quota authority tại gateway (reserve/settle), usage, reservation, settlement → `llm-api` (A7). Phân chia đầy đủ quota policy/limits vs authority → [`open-boundaries.md`](../open-boundaries.md) OB-1 (phần đã chốt) và A7.
- Seller offer, model catalog, upstream endpoint → `llm-marketplace`.
- Seller tenant, ownership, membership, grant và authorization ladder của Seller → `llm-seller-tenant`; restriction/appeal/verification/eligibility của Seller → `llm-seller-governance`.
- Nội dung permission catalog và entitlement cấp sản phẩm → `staff-access` (catalog govern / backend enforce, ADR-0009). `llm-consumer-tenant` chỉ giữ **identifier** permission theo hình `domain.action` và tự enforce.
- Vòng đời pháp lý của dữ liệu (archive, termination, deletion, retention, legal hold, export, anonymization, physical deletion) → chưa chốt, không thuộc domain này (xem §4).

## 3. Ranh giới với các context khác

| Context                | Ranh giới với `llm-consumer-tenant`                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`              | `sub` là tham chiếu opaque; tenant không tự tạo membership khi account signup/login.                                                                                  |
| `auth`                 | `sub` lấy từ authenticated principal (access token) đã verify; `llm-consumer-tenant` không tự xác minh danh tính.                                                     |
| `payment`              | Billing account và tenant là hai khái niệm khác nhau; không suy tenant từ billing account và ngược lại.                                                               |
| `llm-api`              | Tenant/workspace id truyền qua contract; `llm-api` là storage owner duy nhất của `db-llm-tenant`, không có deploy unit riêng cho `llm-consumer-tenant`.               |
| `llm-marketplace`      | Workspace/tenant là scope cho offer/catalog; marketplace không sở hữu membership/grant.                                                                               |
| `llm-consumer-routing` | Tiêu thụ tenant/workspace scope khi resolve routing; không sở hữu membership/grant.                                                                                   |
| `llm-seller-tenant`    | Seller tenant **độc lập**: không dùng `llm-consumer-tenant` thay cho Seller tenant và ngược lại; không có Seller Workspace (ADR-0018).                                |
| `staff-access`         | Product entitlement cấp khả năng dùng sản phẩm LLM; không thay thế authorization bên trong `llm-consumer-tenant`, và không trả lời allow/deny per-request (ADR-0009). |

## 4. Quy tắc cốt lõi

- **Đúng một owner mỗi tenant.** Owner có toàn quyền trong tenant của mình, kể cả billing. Không có global owner role: cùng một `sub` có thể owner tenant A, member tenant B, và không có quyền gì ở tenant C.
- **`first_party` không mua gì ngoài miễn trừ thương mại — và Consumer không có hạn mức thương mại.** Classification là quan hệ tổ chức ([ADR-0026](./adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md)), không phải plan: tenant `first_party` vẫn bị đo usage, vẫn chịu quota/operational limit, vẫn ghi sổ vào kế toán kép `llm-financial`, suspension vẫn chặn kể cả owner, và membership, authorization, staff entitlement giữ nguyên như mọi tenant.
- **`sub` là opaque và đa membership.** Một `sub` có thể owner nhiều tenant và member nhiều tenant khác. Consumer tenant và Seller tenant độc lập hoàn toàn (ADR-0018); không có ngầm chọn tenant đầu tiên/default/UI state.
- **Membership tường minh và có danh tính.** Provision vào tenant (kể cả internal) là thao tác riêng; signup/login không tạo membership. Revoke không tự restore — re-provision tạo membership **mới với `id` mới**, nên grant của lần cũ không sống lại.
- **Grant trực tiếp theo scope, gắn với một lần membership.** Member chỉ có đúng permission được cấp, tại tenant scope hoặc đúng một workspace scope. **Không kế thừa ngầm tenant → workspace**: grant tenant scope không authorize thao tác trên một workspace cụ thể, trừ khi permission đó được khai báo tường minh là quản trị workspace toàn tenant.
- **Billing là permission riêng.** Một permission `billing.manage` (khởi tạo/top up) không cấp bất kỳ quyền nào khác. Domain chỉ authorize; thực thi giao dịch, số dư, ledger, reconciliation, funding nằm ngoài.
- **Suspension là suy ra và chặn authorization.** Nhiều record độc lập theo reason/scope/policy; lift hoặc expire record này không làm yếu record khác. Không có cột `status = suspended` thứ hai. Policy không đánh giá được ⇒ restrictive (fail closed), và evaluation `blocked`/`unevaluable` ⇒ deny **kể cả owner**. Suspension không huỷ request đã được admission.
- **Billing account ≠ tenant.** Một tenant có thể có nhiều billing account hoặc một billing account phục vụ nhiều tenant; quan hệ crediting/reconciliation giữa `payment` và `llm` là open boundary (domains/README §5.1) — không giả định.
- **`sub` opaque.** Không FK xuyên database; toàn vẹn là responsibility của contract + reconciliation.
- **Xác minh lại ở write boundary.** Tenant selector từ client chỉ là gợi ý chọn scope: backend xác minh lại ownership, membership và quyền tại chính write boundary để tránh TOCTOU, và fail closed nếu không xác minh được.
- **Vòng đời pháp lý chưa chốt.** Archive/termination/deletion/retention/legal hold/export/anonymization/physical deletion không được implement hay suy diễn trong domain này. Không có transition `deleted`/`archived` nào là quyết định đã duyệt.

## 5. Tài liệu

| Document                               | Nội dung                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Business model, authorization, suspension, workspace isolation, auth boundary, data ownership, contract, quyết định chưa chốt, failure/correction |
| [`adr/README.md`](./adr/README.md)     | ADR index (0019, 0025, 0026) của bounded context                                                                                                  |
