# Staff Access (application)

`staff-access` là executable component hiện thực nghiệp vụ **Staff Access** (bounded context): sổ staff, catalog role/permission, staff-role assignment, entitlement, authorization audit và privileged-operation workflow, phục vụ Composition `backoffice` qua internal API/BFF.

- **Loại component:** UI/BFF + Worker API nội bộ.
- **Responsibility:** giao diện quản trị nhân sự/role/permission, BFF xử lý yêu cầu đặc quyền, tiêu thụ contract profiles của `account` (displayName), gateway internal contract qua envelope HMAC, relay outbox entitlement (thực hiện bởi `staff-access-relay`).
- **Bounded contexts tham gia:** `staff-access` (host business semantics, trỏ [`docs/domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md)), `account` (tiêu thụ displayName qua contract), `auth` (verify token, internal HMAC envelope).
- **Tài liệu bên trong:** [`README.md`](./README.md), [`01-architecture.md`](./01-architecture.md), [`02-requirements.md`](./02-requirements.md), [`03-operations.md`](./03-operations.md).
