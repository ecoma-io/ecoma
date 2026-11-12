# LLM Seller Tenant Domain

Thư viện domain thuần của bounded context `llm-seller-tenant` (`@ecoma-io/llm-seller-tenant-domain`): Seller tenant và ownership transfer, membership, permission grant, authorization ladder và các hằng payout permission identifier/scope. Ngữ nghĩa nghiệp vụ là nội dung canonical của [`docs/domains/llm-seller-tenant/`](../../docs/domains/llm-seller-tenant/README.md) — thư viện hiện thực một phần tri thức đó bằng code.

Nx project `@ecoma-io/llm-seller-tenant-domain`, tags `type:domain`, `scope:llm-seller`, `runtime:universal`; dependency duy nhất là thin shared kernel `@ecoma-io/tenant-kernel-domain` cho identity/epoch primitive ([ADR-0025](../../docs/domains/llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md)).

## Purpose

- Cung cấp aggregate và invariant thuần của nửa **tenant** trong Seller context: tổ chức nào sở hữu Seller, ai là member, ai được làm gì.
- Tách ranh giới với nửa **governance**: restriction, appeal, verification, legal/tax profile và operational eligibility thuộc `@ecoma-io/llm-seller-governance-domain` ([ADR-0018](../../docs/domains/llm-seller-governance/adr/0018-seller-bounded-context-split.md)).

## Responsibilities

- **Seller tenant** (`seller-tenant.ts`): `createSellerTenant`, `transferSellerOwnership`, `isSellerOwner` — đúng một owner luôn tồn tại; owner là thuộc tính ownership của tenant, không phải role hay permission.
- **Membership** (`membership.ts`): `provisionMembership`, `revokeMembership`, `isMembershipActive`, `findActiveMemberships` — re-provision tạo membership mới; incarnation dùng chung với `llm-consumer-tenant` qua kernel ([ADR-0025](../../docs/domains/llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md)).
- **Permission grant** (`grants.ts`): `createGrant`, `revokeGrant`, `isGrantActiveForMembership` — cấp trực tiếp cho một lần membership, có lịch sử cấp/thu hồi; không có role entity.
- **Authorization ladder** (`authorization.ts`): `authorizeSellerAction`, `authorizeSellerPayout` — fail-closed theo thứ tự cố định: ngữ cảnh đọc được → tenant khớp → restriction → owner → đúng một membership active → grant active.
- **Restriction verdict biên** (`restriction-verdict.ts`): `isSellerRestrictionVerdict`, `isSameRestrictionTarget` — ladder nhận verdict như giá trị khai báo tại biên, không import governance.
- **Nhận dạng, lỗi, hằng payout** (`shared.ts`, `errors.ts`): `isSellerTenantId`, `isMembershipId`, `isPermissionId`, `LLM_SELLER_PAYOUT_PERMISSION`, `LLM_SELLER_AUTHORIZATION_SCOPE`, `LlmSellerResult`.

Consumer: `@ecoma-io/llm-seller-governance-domain` — import identity/value primitive qua `shared.ts` và dùng trong toàn bộ spec của nó.

## Boundaries

- Thuần TypeScript: không database/ORM, không HTTP/network, không Cloudflare Workers API, không filesystem, không đọc clock, không randomness, không global mutable state.
- Không import Nx project khác ngoài `tenant-kernel-domain`; ladder nhận restriction verdict qua biên nên tenant không bao giờ phụ thuộc governance.
- Không sở hữu: offer/provider topology (`llm-marketplace`), ledger/conversion/settlement/withholding (`llm-financial`, `payout`), Consumer tenant hay Consumer payment permission (`llm-consumer-tenant`), permission catalog (`staff-access`); các quyết định còn mở được ghi tại [domain model](../../docs/domains/llm-seller-tenant/domain-model.md) §8.
- Operation trả `LlmSellerResult`: lỗi dữ liệu là domain error, không ném exception; chỉ `create*Id` ném `TypeError` khi lập trình sai. Mọi giá trị trả về đã `Object.freeze`, input không bị mutate.

## Development

```bash
pnpm nx run @ecoma-io/llm-seller-tenant-domain:lint
pnpm nx run @ecoma-io/llm-seller-tenant-domain:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm module mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/llm-seller-tenant-domain:test        # vitest — spec colocated trong src/
```

Spec colocated cạnh subject, ví dụ `seller-tenant.spec.ts`, `authorization.spec.ts`, `restriction-verdict.spec.ts`; `shared.spec.ts` ghim việc uỷ quyền guard cho `@ecoma-io/tenant-kernel-domain`.

## Related Documentation

- [`docs/domains/llm-seller-tenant/README.md`](../../docs/domains/llm-seller-tenant/README.md) — bounded context `llm-seller-tenant`.
- [`docs/domains/llm-seller-tenant/domain-model.md`](../../docs/domains/llm-seller-tenant/domain-model.md) — khái niệm, ownership, membership, authorization ladder, quyết định chưa chốt (§8).
- [`docs/domains/llm-seller-tenant/adr/`](../../docs/domains/llm-seller-tenant/adr/) — index ADR của context (ownership, existence vs eligibility, permission boundary).
- [`docs/domains/llm-seller-governance/README.md`](../../docs/domains/llm-seller-governance/README.md) — context phụ thuộc một chiều vào tenant.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — ba scope LLM và thin shared kernel `tenant-kernel-domain` (§6.3).
