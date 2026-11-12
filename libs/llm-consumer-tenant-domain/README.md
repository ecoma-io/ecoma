# LLM Consumer Tenant Domain

Tầng domain thuần của bounded context `llm-consumer-tenant` (`@ecoma-io/llm-consumer-tenant-domain`): tenant (đúng một owner), membership, workspace, permission grant theo scope và suspension record — ranh giới cách ly đa tenant phía Consumer của hệ sinh thái LLM.

Đây là Consumer tenant, **không** phải Seller tenant: hai ownership boundary độc lập; membership/grant ở tenant này không ngụy quyền ở tenant kia (ADR-0018 §2, ADR-0019). Thư viện **không** import Nx project khác ngoài `@ecoma-io/tenant-kernel-domain` (thin shared kernel: định danh opaque, owned-tenant fact, epoch millis — cùng ngữ nghĩa primitive, không chồng chéo), **không** SQL, **không** Node builtin, **không** I/O; thời gian do caller truyền vào.

Nx project `@ecoma-io/llm-consumer-tenant-domain`, tags `type:domain`, `scope:llm-consumer`, `runtime:universal`.

## Purpose

- Tập trung luật tenant Consumer — bảo đảm "đúng một owner", lifecycle membership, scope grant và đánh giá suspension — thành thư viện thuần.
- Entry công khai duy nhất là `src/index.ts` (`main` của package).

## Responsibilities

Exports công khai (từ `src/index.ts`):

- **Domain errors**: `LlmTenantDomainErrorCode`, `LLM_TENANT_DOMAIN_ERROR_MESSAGES` — message tiếng Anh (`errors.ts`).
- **Identifiers và shared guards** (`shared.ts`): `TenantId`, `WorkspaceId`, `MembershipId`, `PermissionId`, `TenantActorId` với `create*`/`is*` tương ứng, `MAX_OPAQUE_ID_LENGTH`, `LLM_TENANT_BILLING_MANAGEMENT_PERMISSION`, `llmTenantOk`/`llmTenantFailure`.
- **Tenant** (`tenant.ts`): `createTenant` (owner duy nhất), `isTenantOwner`, `isTenantName` với `MAX_TENANT_NAME_LENGTH`.
- **Membership** (`membership.ts`): `LLM_TENANT_MEMBERSHIP_STATUS`/`_STATUSES`, `provisionMembership`, `revokeMembership`, `isMembershipActive`, `findMembership`.
- **Workspace** (`workspace.ts`): `createWorkspace`, `findWorkspace`, `assertWorkspaceBelongsToTenant`.
- **Permission grant** (`grants.ts`): `createGrant`, `isPermissionGrant`, `isGrantEffectiveForMembership`, scope `TenantGrantScope`/`WorkspaceGrantScope`, `GrantIssuanceContext`.
- **Authorization** (`authorization.ts`): `authorizeTenantAction` trả `TenantAuthorizationDecision` với `AuthorizationBasis`/`AuthorizationDenialReason`; `PermissionSemantics`.
- **Billing authorization** (`billing.ts`): `authorizeBillingManagement` — quyết định authorization, không thực thi giao dịch.
- **Suspension** (`suspension.ts`): `createSuspensionRecord`, `evaluateSuspensions`, `isSuspensionEffective`, `isSuspensionRecordShapeValid` với `SuspensionScope`/`SuspensionTarget`/`SuspensionPolicyDefinition`.

Consumer trong workspace: `tools/dx/src/architecture/llm-boundaries.spec.ts` ghim ranh giới scope của các lib LLM theo đúng tên project này.

## Boundaries

- Chuyển ownership tenant, vòng đời pháp lý (archive/terminate/delete, retention), nội dung permission catalog và danh mục lý do suspension là các ranh giới để mở của context — lib bảo đảm "đúng một owner" bằng cấu trúc dữ liệu và không có operation nào chốt giúp.
- Thực thi billing (giao dịch, số dư, ledger) thuộc `llm-financial`/`payment`; lib chỉ trả quyết định authorization.
- Không phụ thuộc `scope:llm-seller` và `scope:llm-shared` — chiều phụ thuộc ghim bởi ADR-0019 và `docs/architecture/05-code-architecture.md` §6.3.

## Development

```bash
pnpm nx run @ecoma-io/llm-consumer-tenant-domain:lint
pnpm nx run @ecoma-io/llm-consumer-tenant-domain:typecheck    # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; thêm module mới = thêm file và spec colocated, rồi export qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/llm-consumer-tenant-domain:test         # vitest — spec colocated trong src/
```

Spec colocated theo module: `tenant.spec.ts`, `membership.spec.ts`, `workspace.spec.ts`, `grants.spec.ts`, `authorization.spec.ts`, `billing.spec.ts`, `suspension.spec.ts`, `errors.spec.ts`, `shared.spec.ts`.

## Related Documentation

- [`docs/domains/llm-consumer-tenant/README.md`](../../docs/domains/llm-consumer-tenant/README.md) — bounded context; [`domain-model.md`](../../docs/domains/llm-consumer-tenant/domain-model.md).
- [`docs/domains/llm-consumer-tenant/adr/`](../../docs/domains/llm-consumer-tenant/adr/) — ADR-0019 (scope/dependency matrix), ADR-0025 (thin shared tenant kernel).
- [`libs/tenant-kernel-domain/`](../tenant-kernel-domain/) — shared kernel mà lib này tiêu thụ.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — §6.3 scope `llm-consumer`, §3 dependency direction.
