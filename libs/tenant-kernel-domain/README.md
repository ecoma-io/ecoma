# Tenant Kernel Domain

Thin shared kernel của các domain có tenant (`@ecoma-io/tenant-kernel-domain`): một danh sách **đóng** năm primitive (P1–P5) mà ADR-0025 chứng minh có cùng ngữ nghĩa ở các context tiêu thụ — opaque ID guard, epoch-millis guard, owned-tenant fact, membership reference và tenant-scoped collection. Kernel **không phải bounded context**: không database, không network, không aggregate, không lifecycle, không policy của sản phẩm nào.

Nx project `@ecoma-io/tenant-kernel-domain`, tags `type:domain`, `scope:shared`, `runtime:universal`.

## Purpose

- Loại trùng lặp của **cùng một bất biến** giữa các domain có tenant: trước kernel, hai module `shared.ts` của hai domain LLM khai lại cùng branded ID, `MAX_OPAQUE_ID_LENGTH` và `isEpochMillis` riêng biệt.
- Biết "owner không phải role" thành bất biến kiểm được bằng code thay vì quy ước — đúng một owner trên bản ghi tenant, ở cả bốn domain chịu bound bởi ADR-0025.

## Responsibilities

Năm nhóm primitive, một entry công khai duy nhất `src/index.ts` (không subpath export):

- **P1 — opaque ID guard** (`opaque-id.ts`): `isOpaqueId`, `MAX_OPAQUE_ID_LENGTH = 200`. Chuỗi opaque không mang ngữ nghĩa bên trong; kernel không ép kiểu branded — mỗi context giữ branded type của riêng mình.
- **P2 — epoch-millis guard** (`epoch-millis.ts`): `isEpochMillis` (số nguyên an toàn; từ chối `NaN`, số thực, `Infinity`, chuỗi).
- **P3 — owned-tenant fact** (`tenant.ts`): `OwnedTenant` `{ id, owner }`, `isOwnedTenant` (guard hình dạng chạy trước khi so sánh owner), `isTenantOwnedBy`.
- **P4 — membership reference** (`membership-ref.ts`): `TenantMembershipRef` `{ tenantId, actor }`, `isTenantMembershipRef` — không incarnation, không status, không timestamp.
- **P5 — tenant-scoped collection** (`membership-ref.ts`): `ensureTenantScopedMembershipRefs` — phần tử lệch tenant hay sai hình dạng làm **cả collection** bị từ chối với lý do `inconsistent_context`; không lọc lặng, không ném.

Mọi hàm guard **không ném**; tham số thời gian do caller truyền vào; module không đọc clock, không sinh số ngẫu nhiên, không đọc biến môi trường.

Consumer theo import thật trong source: `libs/llm-consumer-tenant-domain` (P1, P2, `isTenantOwnedBy`), `libs/llm-seller-tenant-domain` (P1, P2), `apps/pact-broker-api` (`db/bootstrap-tenant.mts`, P1) và `libs/pact-broker-api-infrastructure` (P1).

## Boundaries

- Kernel không định nghĩa và không bao giờ nhận: role, permission, grant, authorization, lifecycle, plan, quota, limit, deletion, retention, suspension, restriction, workspace, machine credential, entitlement. Thêm một khái niệm trong danh sách này phải qua ADR mới kèm bằng chứng hành vi dùng chung.
- Kernel không tạo đường phụ thuộc mới giữa các context: mọi scope nghiệp vụ đã được phép phụ thuộc `scope:shared`, nên Consumer và Seller cùng phụ thuộc kernel chứ không phụ thuộc nhau.
- Sản phẩm adapt tại boundary của mình — giữ branded ID riêng và error vocabulary của mình; kernel không áp vocabulary lên sản phẩm nào.
- Quy tắc vị trí và phụ thuộc của kernel → `docs/architecture/05-code-architecture.md` (§1 principle 5, §6.3).

## Development

```bash
pnpm nx run @ecoma-io/tenant-kernel-domain:lint
pnpm nx run @ecoma-io/tenant-kernel-domain:typecheck
```

Thêm primitive vào kernel là đổi danh sách đóng của ADR-0025 — không phải một commit code thuần.

## Testing

```bash
pnpm nx run @ecoma-io/tenant-kernel-domain:test    # vitest, environment node
```

Spec colocated cho từng primitive (`opaque-id.spec.ts`, `epoch-millis.spec.ts`, `tenant.spec.ts`, `membership-ref.spec.ts`) — mỗi nhóm primitive một spec.

## Related Documentation

- [`docs/domains/llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md`](../../docs/domains/llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md) — ADR chốt danh sách đóng P1–P5, quy tắc phụ thuộc và phần thuộc sản phẩm.
- [`docs/domains/README.md`](../../docs/domains/README.md) — catalog bounded context và quy tắc "không có bounded context `Tenant` dùng chung" (§2.1).
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — thin shared kernel là ngoại lệ duy nhất của rule "không generic `libs/domain`".
- [`libs/llm-consumer-tenant-domain/`](../../libs/llm-consumer-tenant-domain/) và [`libs/llm-seller-tenant-domain/`](../../libs/llm-seller-tenant-domain/) — consumer domain của hai context LLM.
