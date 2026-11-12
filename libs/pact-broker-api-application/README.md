# Pact Broker API Application

Tầng application của bounded context `pact-broker` cho deploy unit `pact-broker-api` (`@ecoma-io/pact-broker-api-application`): use case và port — machine-token authorization, `can-i-deploy`, structural validation khi publish, crypto primitives dùng chung, và provisioning entitlement membership trên tenant canonical.

Nx project `@ecoma-io/pact-broker-api-application`, tags `type:application`, `scope:pact`, `runtime:edge`; dependencies là `@ecoma-io/pact-broker-api-domain` và `@ecoma-io/staff-access-contracts`.

## Purpose

- Giữ lõi quyết định của API Worker tách khỏi HTTP framework và SQL: auth, eligibility và provisioning là use case thuần với I/O qua port.
- Áp dụng event entitlement của `staff-access` vào membership của broker mà không vỡ ranh giới entitlement ≠ authorization ([ADR-0009](../../docs/domains/staff-access/adr/0009-no-internal-authorization-result-contract.md)).

## Responsibilities

- **Machine-token auth** (`token-auth.ts`): `authorizeToken`, `scopeSatisfied`, `hashToken` và port `TokenRepo` — tra cứu theo hash SHA-256, revoke hiệu lực tức thời, `401` đồng nhất cho mọi lý do (thiếu header, token lạ, đã revoke, tenant suspended).
- **`can-i-deploy`** (`can-i-deploy.ts`): `evaluateCanIDeploy` trên kết quả matrix; nghĩa vụ tri-state là nội dung của [`docs/domains/pact-broker/domain-model.md`](../../docs/domains/pact-broker/domain-model.md) §2.3.
- **Publish** (`publish-pact.ts`): `validatePactStructure`, `MAX_PACT_INTERACTIONS` — kiểm cấu trúc pact trước khi lưu.
- **Crypto** (`hashing.ts`): `randomToken`, `sha256Hex` — token 32 byte entropy, base64url; chỉ hash nằm trong DB.
- **Entitlement membership** (`provision-entitlement-membership.ts`): `provisionEntitlementMembership`, `CANONICAL_TENANT_NAME` (`ecoma`), `CanonicalTenantUnavailableError`, với ports `MembershipRepo`, `EntitlementSyncRepo`, `TenantLookup`; quyết định áp dụng event dùng `shouldApplyEntitlementEvent` của `@ecoma-io/staff-access-contracts` (compare-and-drop theo `revision`).

Consumer: `apps/pact-broker-api` (`src/auth/token-auth.ts`, `src/routes/matrix.ts`, `src/routes/pacts.ts`, `src/entitlement-consumer.ts`, `src/main.ts`) và `libs/pact-broker-api-infrastructure` — cài `TokenRepo` (`PgTokenRepo`), `MembershipRepo`/`TenantLookup` (`PgTenantRepo`), `EntitlementSyncRepo` (`PgEntitlementSyncRepo`).

## Boundaries

- Không import infrastructure, không SQL, không HTTP framework (Hono), không Node builtin; WebCrypto (`crypto.subtle`) là Web API nền tảng duy nhất được dùng.
- Serving path không tạo tenant: tenant canonical được provision bởi đường bootstrap; grant gặp tenant thiếu/không active ném `CanonicalTenantUnavailableError` fail-closed, consumer chuyển thành message retry — không tự sửa dữ liệu.
- Event entitlement chỉ mang tính khả dụng sản phẩm: `entitlement.granted` cho `pact-broker` provision membership role `member`; `entitlement.revoked` chỉ ghi nhận revision; event của sản phẩm khác bị bỏ qua lặng. Thu hồi membership và logic role thuộc phía khác — không nằm ở use case này.

## Development

```bash
pnpm nx run @ecoma-io/pact-broker-api-application:lint
pnpm nx run @ecoma-io/pact-broker-api-application:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm use case mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/pact-broker-api-application:test       # vitest — spec colocated trong src/
```

Spec colocated: `token-auth.spec.ts`, `can-i-deploy.spec.ts`, `publish-pact.spec.ts`, `provision-entitlement-membership.spec.ts`; hành vi qua HTTP và PostgreSQL thật thuộc suite app-owned của `apps/pact-broker-api` (`tests/integrations/`, `tests/databases/`, chạy qua target `test-integration` của app đó).

## Related Documentation

- [`docs/domains/pact-broker/domain-model.md`](../../docs/domains/pact-broker/domain-model.md) — machine token, tenant/membership của broker, `can-i-deploy` tri-state (§2.3, §2.5).
- [`docs/applications/pact-broker/01-architecture.md`](../../docs/applications/pact-broker/01-architecture.md) — auth model và nghĩa vụ deploy unit (§5.2, §6).
- [`docs/domains/staff-access/adr/0009-no-internal-authorization-result-contract.md`](../../docs/domains/staff-access/adr/0009-no-internal-authorization-result-contract.md) — ranh giới entitlement ≠ authorization mà use case provisioning tuân theo.
- [`docs/applications/pact-broker/UPSTREAM_MAPPING.md`](../../docs/applications/pact-broker/UPSTREAM_MAPPING.md) — mapping use case với upstream broker.
- [`apps/pact-broker-api/`](../../apps/pact-broker-api/) — composition root gọi các use case này.
- [`libs/pact-broker-api-infrastructure/`](../pact-broker-api-infrastructure/) — implementation PostgreSQL của các port.
