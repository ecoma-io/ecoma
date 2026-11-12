# Backoffice Domain

Value object, policy authorization thuần và vocabulary trạng thái mà composition `backoffice` dùng: staff status, định danh `BackofficeAccountId`, và hàm `can()` đánh giá authorization trên dữ liệu đã đồng bộ về backend.

Thư viện **không** import Nx project khác, **không** SQL, **không** Node builtin, **không** I/O; mọi tham số thời gian (`now`, `fetchedAt`) do caller truyền vào. Tag runtime là `runtime:universal`.

Nx project `@ecoma-io/backoffice-domain`, tags `type:domain`, `scope:backoffice`, `runtime:universal`.

⚠️ Về tên gọi: `backoffice` **không phải** bounded context — nó là composition UI/BFF vận hành nội bộ (`docs/domains/README.md` §3); nghiệp vụ staff/RBAC mà các module này lập luận trên thuộc bounded context `staff-access` (ADR-0013 đã chuyển ownership từ `backoffice`). Scope tag `scope:backoffice` là trục sở hữu code trong Nx, không tạo ra một context mới.

## Purpose

- Giữ policy authorization thuần: quyết định `can()` dựa trên staff status hiện hành và cửa sổ assignment đã đồng bộ, không suy từ token còn hạn — token validity ≠ privilege currency.
- Cung cấp trục và vocabulary dùng chung cho BFF `backoffice` và các lib application/infrastructure của nó.

## Responsibilities

Exports công khai (từ `src/index.ts`):

- **Staff status**: `BACKOFFICE_STAFF_STATUS`, `BACKOFFICE_STAFF_STATUSES`, `isBackofficeStaffStatus`, `isTerminalStaffStatus` (`staff-status.ts`).
- **Định danh account**: `BackofficeAccountId` với prefix và entropy riêng, `createBackofficeAccountId`, `isBackofficeAccountId`, `backofficeAccountIdEntropy`, `BACKOFFICE_ACCOUNT_ID_PREFIX`, `BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS` (`account-id.ts`).
- **Authorization policy**: `can` với `CatalogPermission` (`domain.action`), `GrantedAssignment`, `AuthorizationRiskClass` (`normal` | `high` gắn theo operation), `AuthorizationDecision`, `AuthorizationDenialReason`, và `REVOCATION_FRESHNESS_TTL_SECONDS` — TTL re-read tối đa mà policy nhận là đủ mới, theo target revocation latency của ADR-0002 (`authorization-policy.ts`).
- **Domain errors**: `BackofficeDomainError`, `BackofficeDomainErrorCode`, `BACKOFFICE_DOMAIN_ERROR_MESSAGES` (`errors.ts`).

Consumer hiện tại: `apps/backoffice` (`server/authorization.ts`, `server/principal.ts`, `server/read-route.ts`), `libs/backoffice-application` (`authorization.ts`, `authorization-audit-port.ts`), `libs/backoffice-infrastructure` (`queries.ts`, `authorization-audit.ts`).

## Boundaries

- Không có policy runtime nào cấm self-assignment hay cơ chế token/revocation ở đây — enforcement thuộc tầng application và resource-owning backend; các quyết định để mở của `staff-access` (bootstrap first-admin, revocation latency, custom role, step-up) nằm ở `docs/domains/staff-access/` và các ADR của nó.
- Không phát minh permission cụ thể: catalog chỉ định nghĩa hình thức `domain` × `action`; nội dung catalog là dữ liệu governance.
- Không persistence, không decode token, không sync-call sang backend nào.

## Development

```bash
pnpm nx run @ecoma-io/backoffice-domain:lint
pnpm nx run @ecoma-io/backoffice-domain:typecheck    # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; thêm module mới = thêm file và spec colocated, rồi export qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/backoffice-domain:test         # vitest — spec colocated trong src/
```

Spec colocated: `authorization-policy.spec.ts`, `account-id.spec.ts`, `staff-status.spec.ts`, `errors.spec.ts`.

## Related Documentation

- [`docs/domains/staff-access/README.md`](../../docs/domains/staff-access/README.md) — bounded context sở hữu nghiệp vụ staff/RBAC; [`domain-model.md`](../../docs/domains/staff-access/domain-model.md).
- [`docs/domains/staff-access/adr/`](../../docs/domains/staff-access/adr/) — ADR-0002 (revocation latency/risk class), ADR-0006/0007 (RBAC phẳng, không ABAC/hierarchy), ADR-0013 (ownership transfer).
- [`docs/applications/backoffice/README.md`](../../docs/applications/backoffice/README.md) — composition mà lib này phục vụ.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — §6.3 `scope:backoffice`, §3 dependency direction.
