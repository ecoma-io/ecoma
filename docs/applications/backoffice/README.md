# Backoffice (application)

`backoffice` là **composition: UI quản trị + BFF** phục vụ vận hành nội bộ. Nó phối hợp các API của các bounded context — Staff Access cho nhân sự/quyền, Pact Broker và Remote Cache cho nghiệp vụ sản phẩm. **Không sở hữu database nghiệp vụ** là target architecture: việc Staff Access tiếp quản staff/RBAC đã được chốt bằng ADR-0013 (supersede phạm vi tương ứng của A21). Khi chuyển xong, composition không ghi database nghiệp vụ thay cho bất kỳ domain nào.

- **Loại component:** composition (UI/BFF).
- **Responsibility:** UI quản trị staff (quản trị nhân sự, vai trò/quyền, entitlement), BFF giữ token server-side (session cookie `__Host-backoffice-session`, lưu `id_hash = SHA-256(id)` trong `bff_sessions`), onboarding staff (gate displayName, fail-closed vs controlled degrade, chỗ gắn 2FA), gọi Application APIs của các domain sở hữu.
- **Bounded contexts tham gia:** `staff-access` (nhân sự/quyền/entitlement, qua contract — trỏ [`docs/domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md)), `pact-broker`, `remote-cache` (nghiệp vụ sản phẩm), `account` (tiêu thụ displayName), `auth` (verify token).
- **Tài liệu bên trong:** `README.md`, `01-architecture.md`.
