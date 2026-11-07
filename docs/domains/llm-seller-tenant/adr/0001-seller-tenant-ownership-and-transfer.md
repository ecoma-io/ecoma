# ADR-0001 — Seller tenant ownership: một owner, transfer tường minh

**Trạng thái:** Accepted · **Ngày:** 2026-11-06 · **Issue:** #549

## Bối cảnh

Thiết kế cũ của `llm-seller` mô tả membership kèm `role` và coi owner như một role đặc biệt; `llm-consumer-tenant` (sau PR #548) đã bỏ role entity để dùng grant trực tiếp. Seller cần một mô hình ownership rõ ràng: ai nhận quyền tối cao, chuyển giao thế nào, và làm sao không có tenant ownerless.

Ba phương án đã cân nhắc:

1. **Owner là permission grant đặc biệt** — owner = member có grant `*`. Loại: vi phạm "không wildcard", và thu hồi grant sẽ làm tenant không còn chủ thể vận hành.
2. **Owner là role trên membership** — như thiết kế cũ. Loại: cần role entity (đã bị loại ở `llm-consumer-tenant`), và owner biến mất khi membership bị revoke, tạo tenant ownerless.
3. **Owner là thuộc tính ownership của tenant** — `SellerTenant.owner` là một `sub`, độc lập với membership và grant. **Chấp nhận.**

## Quyết định

- Mỗi Seller tenant có **đúng một** owner; owner là field `owner` (`sub`) trên tenant, không phải membership role hay grant.
- Một account có thể owner nhiều Seller tenant và là member của nhiều Seller tenant khác. Owner authority **không** đi theo `sub` sang tenant khác.
- Owner có toàn quyền trong tenant của mình — mọi permission, kể cả permission thêm sau này — **trừ khi target đang bị restriction chặn** ([ADR-0003](../../llm-seller-governance/adr/0003-restriction-and-appeal-model.md)).
- **Transfer** là domain operation tường minh với guard: actor là owner hiện tại; owner mới khác owner hiện tại; owner mới có membership **active** trong tenant; tenant đích đúng là tenant đang xét.
- Hệ quả của transfer: `owner` đổi sang `sub` mới; owner cũ **trở thành member** — nếu chưa có membership active thì tạo membership active mới với `id` mới, nếu đã có thì giữ nguyên.
- Grant hiện có **không** bị đổi bởi transfer: grant thuộc membership, không thuộc owner. Owner mới không tự nhận grant nào.
- Không có trạng thái trung gian "đang chuyển owner", không transfer cho chính mình, không transfer xuyên tenant.

## Hệ quả

- Tenant luôn có chủ thể vận hành được kể cả khi toàn bộ grant bị thu hồi — đây là lý do owner authority không giới hạn theo permission.
- Permission catalog **không** hạn chế được owner; muốn hạn chế phải dùng restriction. Đây là lựa chọn có chủ đích, ghi ở [`domain-model.md`](../domain-model.md) §3.
- Persistence phải thực hiện transfer trong một transaction: update owner + tạo/giữ membership owner cũ, không để snapshot trung gian ownerless — yêu cầu persistence adapter và migration là chi tiết Application, xem [`docs/applications/llm-seller/01-architecture.md`](../../../applications/llm-seller/01-architecture.md), [`docs/applications/llm-seller/03-operations.md`](../../../applications/llm-seller/03-operations.md) và DB owner `llm-api` tại [`docs/architecture/01-architecture.md`](../../../architecture/01-architecture.md) §4.
- Membership của owner cũ có thể bị revoke sau transfer mà không ảnh hưởng owner mới.

## Vẫn mở

Chính sách transfer nâng cao — approval, cooling-off, xử lý khi owner account không còn khả dụng, transfer do platform khởi tạo — chưa chốt ([`domain-model.md`](../domain-model.md) §8.1). Domain không có workflow cho các trường hợp này.

## Cross-reference

- [`domain-model.md`](../domain-model.md) §2, §3, §4 · [`llm-financial/adr/0001`](../../llm-financial/adr/0001-independent-seller-console-tenant.md) — Seller/Console tenant độc lập
- [`llm-consumer-tenant`](../../llm-consumer-tenant/README.md) — pattern owner/membership/grant của Console tenant
