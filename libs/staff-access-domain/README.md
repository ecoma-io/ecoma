# Staff Access Domain

Thư viện domain thuần của bounded context `staff-access` (`@ecoma-io/staff-access-domain`): value object, invariant vòng đời và constraint thuần — staff status trục của staff directory và taxonomy lỗi domain.

Nx project `@ecoma-io/staff-access-domain`, tags `type:domain`, `scope:staff-access`, `runtime:universal`; `package.json` không có dependency nào — đúng dependency rule cho `type:domain` (không phụ thuộc project nào khác, kể cả `type:contracts`).

## Purpose

- Ghim hình dạng đánh dấu trạng thái membership của staff member trong staff directory, cùng nguyên tắc **hai trục độc lập**: staff status và `account.status` không suy ra nhau (invariant 31, [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) §9).
- Cấp taxonomy lỗi an toàn cho tầng domain: error chỉ mang `code` ổn định + `message` ngắn gọn, không có field cho identifier/token/secret hay payload tuỳ ý.

## Responsibilities

- **Staff status** (`staff-status.ts`): `STAFF_ACCESS_STAFF_STATUS` (`active`, `suspended`, `terminated`), `STAFF_ACCESS_STAFF_STATUSES`, `isStaffAccessStaffStatus`, `isTerminalStaffAccessStatus` — chỉ `terminated` là terminal; `suspended` còn đường quay lại `active`, và không có hàm nào chuyển `terminated` sang trạng thái khác.
- **Lỗi** (`errors.ts`): `staffAccessDomainError`, `isStaffAccessDomainError`, catalog `STAFF_ACCESS_DOMAIN_ERROR_MESSAGES` — cùng pattern với `libs/account-domain/src/errors.ts` và `libs/backoffice-domain/src/errors.ts`.

Consumer: `apps/staff-access` — `src/main.ts` dùng `isStaffAccessDomainError` ở error path, `src/routes.ts` dùng `staffAccessDomainError`; CHECK/trigger của migration `apps/staff-access/db/migrations/0001_staff_access_domain.sql` neo vào cùng tập trạng thái.

## Boundaries

- Thuần TypeScript: không import Nx project khác, không SQL, không Node builtin, không I/O; mọi tham số thời gian do caller truyền vào, domain không đọc đồng hồ.
- **Khai báo lại vocabulary thay vì import contracts**: `type:domain` không được phụ thuộc `type:contracts`, nên tập nhãn được khai độc lập với `StaffStatus` của `@ecoma-io/staff-access-contracts`; `staff-status.spec.ts` ghim sự đối xứng giữa hai tập.
- Điều được ghim ở đây là **sự tách trục** và tính terminal của `terminated` — nội dung catalog permission và nội dung role system xuất phát từ catalog thật (`apps/staff-access/db/migrations/0003_permission_catalog_seed.sql`, [ADR-0004](../../docs/domains/staff-access/adr/0004-custom-role-administration.md)), không được phát minh trong thư viện này.
- Không có cơ chế outbox/transport nào ở đây: delivery entitlement của Phase 2 và revision semantics thuộc [ADR-0002](../../docs/domains/staff-access/adr/0002-revocation-latency-risk-class.md) và [ADR-0016](../../docs/domains/staff-access/adr/0016-outbox-relay-mechanism.md); `revision` ở đây chỉ là số thứ tự tăng đơn điệu.

## Development

```bash
pnpm nx run @ecoma-io/staff-access-domain:lint
pnpm nx run @ecoma-io/staff-access-domain:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm module mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/staff-access-domain:test        # vitest — spec colocated trong src/
```

Spec colocated: `staff-status.spec.ts` (tập giá trị, guard, tính terminal, đối xứng với contracts layer) và `errors.spec.ts`.

## Related Documentation

- [`docs/domains/staff-access/README.md`](../../docs/domains/staff-access/README.md) — bounded context `staff-access`.
- [`docs/domains/staff-access/domain-model.md`](../../docs/domains/staff-access/domain-model.md) — staff status là trục riêng với account status (§3.2), permission catalog và role (§3.3, §3.4), invariant (§8).
- [`docs/domains/staff-access/adr/`](../../docs/domains/staff-access/adr/) — index ADR của context.
- [`docs/applications/staff-access/01-architecture.md`](../../docs/applications/staff-access/01-architecture.md) — composition và API surface của deploy unit `staff-access`.
- [`libs/staff-access-contracts/`](../staff-access-contracts/) — wire type mirror phía contracts layer.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — dependency rule cho `type:domain` (§7).
