# Staff Access

`staff-access` là bounded context sở hữu **quyền truy cập nội bộ của nhân sự**: nhân sự nội bộ và trạng thái truy cập, catalog vai trò/permission dành cho nhân sự, việc gán vai trò/quyền, entitlement cho phép nhân sự sử dụng các sản phẩm nội bộ, và audit mọi thay đổi quyền/entitlement.

> Thư mục này giữ **ranh giới nghiệp vụ và quyết định ownership** của bounded context: trách nhiệm, ngôn ngữ, contract và các ADR. Deploy unit `apps/staff-access` + `apps/staff-access-relay` và lịch sử chuyển ownership từ `backoffice` → §4. Tài liệu ở đây là **contract thiết kế**, không phải mô tả code hiện có.

## 1. Trách nhiệm

1. **Staff directory và lifecycle** — nhân sự nội bộ, trạng thái truy cập nội bộ (active/suspended/terminated).
2. **Permission catalog và role** — catalog permission `domain.action`, role built-in + custom (custom role v1 tắt — ADR-0004), staff-role assignment.
3. **Product entitlement** — quyền sử dụng sản phẩm nội bộ (backoffice, pact-broker, remote-cache…) của từng nhân sự; sự khác biệt giữa entitlement (product-level availability) và authorization (per-resource/per-operation) là ranh giới bắt buộc — ADR-0009.
4. **Audit** — mọi thay đổi quyền/entitlement để lại audit record (actor, target, action, thời điểm, kết quả, lý do, correlation ID).

Staff Access **không** phải IdP thứ hai và **không** phải credential store: authentication đi qua `account`/`auth` như mọi application khác; nó chỉ tiêu thụ **Account ID** (`sub`) như tham chiếu opaque.

## 2. Ranh giới với các context khác

| Context                 | Sở hữu (rút gọn)                                                                                         | Không sở hữu (rút gọn)                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `account`               | Dữ liệu danh tính: hồ sơ, email đã xác thực, credential, MFA/passkey, browser session, authn audit       | Staff membership, staff role, permission assignment — trạng thái staff ≠ trạng thái account (invariant 31) |
| `auth`                  | Giao thức OAuth 2.0 / OIDC: flows, clients, token issuance/revocation                                    | Business role/permission — **OAuth scope ≠ application-level permission** (A22)                            |
| `staff-access`          | Staff directory/lifecycle, permission/role catalog, assignment, product entitlement, authorization audit | Không phải IdP, không phải credential store; không tự enforce trên resource của context khác               |
| Resource-owning backend | Enforce permission trên operation + tài nguyên của chính nó, trên **mọi** protected request (A23)        | Không tự phát minh permission ngoài catalog                                                                |

Enforcement chia đôi: **catalog govern ở Staff Access; backend enforce ở resource-owning backend.** Token hợp lệ không phải bằng chứng privilege còn hiện hành (A24).

## 3. Entitlement và truyền trạng thái

- Mỗi sản phẩm authorize bằng dữ liệu/quy tắc **thuộc quyền sở hữu của chính nó**; không gọi Staff Access đồng bộ trên mỗi request để hỏi quyền (ADR-0009).
- Thay đổi entitlement/role được ghi cùng transactional outbox trong một transaction (A8) và truyền đến các sản phẩm bằng event bất đồng bộ. **Cách bảo đảm revocation latency đã chốt** — [ADR-0014](./adr/0014-revocation-sla-mechanism.md): event-driven invalidation với deadline delivery theo event class, freshness bound + fail-closed, re-check-at-write-time cho write path.
- Entitlement event **không** phải internal authorization-result contract: nó truyền **tính khả dụng sản phẩm**, không truyền verdict allow/deny cho từng request.

## 4. Evolution từ `backoffice`

Quyền staff/RBAC ban đầu được ghi vào `backoffice` (A21–A24, ADR-0001…0012) — quyết định đó vẫn đúng về trách nhiệm nghiệp vụ, còn **vị trí sở hữu** đã chuyển sang `staff-access` theo [ADR-0013](./adr/0013-staff-access-ownership-transfer.md). Cụ thể:

- **Đã chốt và giữ nguyên:** domain model (staff/role/permission/assignment/audit), ADR-0002…0012, các invariant 31–36, nguyên tắc revocation latency theo risk class.
- **Chuyển sở hữu sang `staff-access` (đã chốt — ADR-0013):** database staff/RBAC/audit — `db-staff-access` theo ownership mới; ngày nay `apps/backoffice` còn sở hữu `db-backoffice` với migrations `0001–0006` — và mọi API quản trị nhân sự/quyền.
- **`backoffice` còn lại:** composition/UI + BFF — không sở hữu nghiệp vụ Staff Access (chi tiết → [`docs/applications/backoffice/`](../../applications/backoffice/)).

Việc chuyển này **không** âm thầm sửa quyết định cũ: [ADR-0013](./adr/0013-staff-access-ownership-transfer.md) ghi rõ việc `staff-access` tiếp quản trách nhiệm đã được A21 gán cho `backoffice`, supersede phạm vi tương ứng của A21 và phần tên database/schema của ADR-0001. `apps/staff-access` và `apps/staff-access-relay` đã tồn tại; phần còn thiếu nằm ở các Issue đang mở (#44 đường ghi staff, enforcement permission và wiring BFF của route gán/thu hồi, #46 đường recovery).

## 5. Tài liệu

| Document                               | Nội dung                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Business model, quy tắc nghiệp vụ, invariant, sự kiện domain và ngữ nghĩa quyền                |
| [`adr/`](./adr/README.md)              | Architectural decision record — hai mươi mốt quyết định (ADR-0001…0014, 0016, 0020…0024, 0029) |
