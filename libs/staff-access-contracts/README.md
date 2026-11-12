# Staff Access Contracts

Contract library của bounded context `staff-access` (`@ecoma-io/staff-access-contracts`): management API cho staff/role/permission/assignment, authorization audit query, entitlement read model và entitlement event — wire shape mà service Staff Access publish và các consumer phụ thuộc vào.

Nx project `@ecoma-io/staff-access-contracts`, tags `type:contracts`, `scope:staff-access`, `runtime:universal`; `package.json` không có dependency nào — đúng ràng buộc `type:contracts` của `.oxlintrc.json`: không phụ thuộc bất kỳ project implementation nào, kể cả transitive.

## Purpose

- Định nghĩa hợp đồng thiết kế của management API và entitlement cho BFF `backoffice` và các resource-owning backend tiêu thụ — contract là thứ provider publish để consumer phụ thuộc vào, không phải một tầng đi theo chiều phụ thuộc.
- Ghim ranh giới entitlement ≠ authorization ngay trong wire shape: read model và event entitlement chỉ mang tính khả dụng sản phẩm, không mang verdict/permission/role.

## Responsibilities

- **Staff directory** (`management-staff-contract.ts`): `validateStaffMember`, `validateStaffListRequest`, `validateStaffListResponse`, `staffListResponse`, `isStaffStatus`, `isStaffSubFormat`, `STAFF_STATUSES`, `FORBIDDEN_STAFF_PROFILE_FIELDS`, `STAFF_DISPLAY_NAME_MAX_LENGTH`, limit phân trang.
- **Role và permission** (`management-role-contract.ts`, `management-permission-contract.ts`): `validateStaffRole`, `validatePermission`, `ROLE_KINDS`, `ROLE_STATUSES`, `PERMISSION_STATUSES`, `isPermissionIdFormat`, `FORBIDDEN_ROLE_FIELDS`, `FORBIDDEN_PERMISSION_FIELDS`, limit phân trang.
- **Assignment** (`management-assignment-contract.ts`): `validateCreateAssignmentRequest`, `validateRevokeAssignmentRequest`, `validateStaffRoleAssignment`, `AssignmentScope`, limit phân trang.
- **Audit query** (`management-audit-contract.ts`): `validateAuditQueryRequest`, `validateAuditEntry`, `validateAuditListResponse`, `AUDIT_OUTCOMES`, `FORBIDDEN_AUDIT_FIELDS`, `FORBIDDEN_AUDIT_CONTEXT_KEYS`.
- **Entitlement read** (`entitlement-read-contract.ts`): `validateEntitlementReadResponse`, `validateEntitlementEntry`, `ENTITLEMENT_PRODUCTS`, `ENTITLEMENT_STATUSES`, `pickRevisionWinner`, `FORBIDDEN_ENTITLEMENT_FIELDS`.
- **Entitlement event** (`entitlement-events-contract.ts`, `entitlement-event-consumer.ts`): `entitlementEvent`, `validateEntitlementEvent`, `ENTITLEMENT_EVENT_TYPES`, `ENTITLEMENT_EVENT_PRODUCER`, `FORBIDDEN_ENTITLEMENT_EVENT_FIELDS`, `shouldApplyEntitlementEvent` — compare-and-drop theo `revision` cho consumer idempotent.
- **Delivery metrics** (`entitlement-delivery-metrics-contract.ts`): `ENTITLEMENT_DELIVERY_DEADLINE_MS`, `ENTITLEMENT_DELIVERY_EVENT_CLASSES`, tên metric freshness/fail-closed/reconciliation.

Consumer: `apps/staff-access` (`src/routes.ts`), `libs/staff-access-infrastructure` (`entitlement-repository.ts`), `libs/pact-broker-api-application` (`provision-entitlement-membership.ts`) và `apps/pact-broker-api` (`src/entitlement-consumer.ts`), `libs/backoffice-infrastructure` (`src/staff-access/client.ts`), `apps/backoffice` (`app/backoffice-data/types.ts`, `server/api/audit.get.ts`).

## Boundaries

- Không import implementation nào và không chứa implementation: không Hono handler, không SQL, không Queue, không Cloudflare binding, không HMAC/encryption, không network call.
- **Không có internal authorization-result contract**: read model và event entitlement bị các tập `FORBIDDEN_*` chặn việc mang verdict/permission/role trong wire; quyết định và lý do ở [ADR-0009](../../docs/domains/staff-access/adr/0009-no-internal-authorization-result-contract.md).
- Không pin quyết định còn mở trong wire: tập nhãn staff status là đề xuất — điều đã chốt là nó là một trục riêng với account status ([`docs/domains/staff-access/domain-model.md`](../../docs/domains/staff-access/domain-model.md) §3.2); nội dung system-defined role xuất phát từ permission catalog, không khai ở đây ([ADR-0004](../../docs/domains/staff-access/adr/0004-custom-role-administration.md)); cơ chế delivery của Phase 2 không được mã hoá — envelope event có `revision` cho idempotency nhưng không có transport.

## Development

```bash
pnpm nx run @ecoma-io/staff-access-contracts:lint
pnpm nx run @ecoma-io/staff-access-contracts:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm contract mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/staff-access-contracts:test        # vitest — spec colocated trong src/
```

Spec colocated cho từng contract (`management-staff-contract.spec.ts`, `management-role-contract.spec.ts`, `management-assignment-contract.spec.ts`, `management-audit-contract.spec.ts`, `entitlement-read-contract.spec.ts`, `entitlement-events-contract.spec.ts`, `entitlement-event-consumer.spec.ts`, `entitlement-delivery-metrics-contract.spec.ts`).

## Related Documentation

- [`docs/domains/staff-access/README.md`](../../docs/domains/staff-access/README.md) — bounded context `staff-access` sở hữu gì, ranh giới với `account`.
- [`docs/domains/staff-access/domain-model.md`](../../docs/domains/staff-access/domain-model.md) — khái niệm staff directory, role/permission, entitlement, audit.
- [`docs/domains/staff-access/adr/`](../../docs/domains/staff-access/adr/) — index ADR của context (entitlement ≠ authorization, permission naming, revocation SLA…).
- [`docs/applications/staff-access/01-architecture.md`](../../docs/applications/staff-access/01-architecture.md) — API surface và ranh giới sử dụng contract (§3, §4).
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — dependency rule cho `type:contracts` (§7).
