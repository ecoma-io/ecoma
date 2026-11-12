# Staff Access Infrastructure

Lớp adapter PostgreSQL của bounded context `staff-access` (`@ecoma-io/staff-access-infrastructure`): client postgres.js qua Hyperdrive binding `DB_STAFF_ACCESS` (database `db-staff-access`) và bộ repository đọc/ghi schema `staff_access`. SQL trong repository là bản chép của schema trong `apps/staff-access/db/migrations/` — lib không tự định nghĩa bảng hay giá trị schema, và không chứa logic authorization nào (catalog govern, backend enforce — ADR-0009).

Nx project `@ecoma-io/staff-access-infrastructure`, tags `type:infrastructure`, `scope:staff-access`, `runtime:edge`.

## Purpose

- Đơn giản hoá mọi đường truy cập `db-staff-access` của app `staff-access` thành một điểm vào duy nhất: chỉ nhận binding Hyperdrive (object có `connectionString`), chấm dứt mọi client trong `finally` của `withStaffAccessClient`, ép `prepare: false` theo ràng buộc Hyperdrive (HD6).
- Đưa các bảng nghiệp vụ — staff, role, permission, assignment, audit, entitlement + outbox — lên thành hàm repository có type, để `apps/staff-access` không viết SQL trực tiếp.

## Responsibilities

- **Client và transaction** (`postgres.ts`): `createStaffAccessPostgresClient`, `withStaffAccessClient`, `isStaffAccessSchemaError`; kiểu `StaffAccessQueryable`, `StaffAccessClient` và `StaffAccessTransaction` — transaction được brand bằng `unique symbol` không export, nên một đường ghi nhầm bằng client thay vì transaction không biên dịch (invariant A8).
- **Staff** (`staff-repository.ts`): `getStaffById`, `getStaffBySub`, `insertStaff`, `listStaff`.
- **Role và permission** (`role-repository.ts`, `permission-repository.ts`): `getRoleById`, `listActiveRoles`, `listRolePermissionIds`, `listEffectivePermissionIdsForStaff`; `getPermissionById`, `listActivePermissions`.
- **Assignment** (`assignment-repository.ts`): `getAssignmentById`, `listAssignmentsForStaff`, `insertAssignment`, `revokeAssignment`.
- **Audit** (`audit-repository.ts`): `appendAuditEntry`, `queryAuditEntries` với filter truy vấn.
- **Entitlement + outbox** (`entitlement-repository.ts`): `upsertEntitlement` ghi state và event outbox trong cùng một transaction — nhận **chỉ** `StaffAccessTransaction`, `revision` do trigger của schema tính và trả qua `RETURNING`; `settleOutboxEvent` ghi settlement receipt; `getEntitlement`, `listEntitlementsForStaff`.
- Consumer duy nhất hiện tại: `apps/staff-access` (`src/main.ts`, `src/routes.ts`).

## Boundaries

- Không có quyết định nghiệp vụ: ai được phép gì thuộc domain và app phục vụ; adapter chỉ thực thi câu lệnh đã khai.
- Không sở hữu đường relay/reconcile outbox: hai đường đó có adapter riêng (`libs/staff-access-relay-infrastructure`, `libs/staff-access-reconciler-infrastructure`) và không import lib này.
- Không tự xây connection string tới PostgreSQL công khai — `StaffAccessHyperdriveBinding` chỉ bọc object mà Worker runtime cấp, và module từ chối cấu hình không phải binding (`StaffAccessConfigurationError`).
- Quy tắc tầng và Nx tags của `libs/` → `docs/architecture/05-code-architecture.md` (§3 dependency direction, §6 tags).

## Development

```bash
pnpm nx run @ecoma-io/staff-access-infrastructure:lint
pnpm nx run @ecoma-io/staff-access-infrastructure:typecheck
```

Repository mới đi kèm migration tương ứng trong `apps/staff-access/db/migrations/` — thêm cột hay bảng ở lib mà không có migration là lệch schema.

## Testing

```bash
pnpm nx run @ecoma-io/staff-access-infrastructure:test    # vitest, environment node
```

Spec colocated duy nhất là `src/postgres.spec.ts`: kiểm đường ống config xuống driver postgres.js qua mock — không mở socket PostgreSQL thật; hành vi repository trên database thật thuộc các suite integration app-owned của `apps/staff-access/tests/`.

## Related Documentation

- [`docs/domains/staff-access/README.md`](../../docs/domains/staff-access/README.md) — bounded context `staff-access`.
- [`docs/domains/staff-access/domain-model.md`](../../docs/domains/staff-access/domain-model.md) — khái niệm staff, role, permission, entitlement và audit.
- [`docs/domains/staff-access/adr/0009-no-internal-authorization-result-contract.md`](../../docs/domains/staff-access/adr/0009-no-internal-authorization-result-contract.md) — vì sao adapter không trả verdict authorization.
- [`docs/applications/staff-access/README.md`](../../docs/applications/staff-access/README.md) — application tiêu thụ lib này.
- [`apps/staff-access/`](../../apps/staff-access/) — app duy nhất import adapter, cùng chỗ chứa migrations.
