# Pact Broker

Bounded context `pact-broker`: hợp đồng consumer-driven contract testing cho hệ sinh thái Ecoma, dogfooding-ready. Hai deploy unit:

- **`pact-broker-api`** (`apps/pact-broker-api`) — Worker Hono API-only, tương thích Pact CLI, sở hữu `db-pact-broker` (PostgreSQL qua Hyperdrive).
- **`pact-broker-app`** (`apps/pact-broker-app`) — Nuxt BFF + dashboard, không chạm database, xác thực qua OIDC của `auth`.

Thiết kế bounded context, tenant isolation, machine token, can-i-deploy fail-closed → [`domain-model.md`](./domain-model.md). Deploy unit và thiết kế kỹ thuật → [`docs/applications/pact-broker/`](../../applications/pact-broker/README.md).

Staff Access event/internal-auth contracts và permission catalog canonical source → [`docs/domains/staff-access/README.md`](../staff-access/README.md), [`docs/applications/staff-access/01-architecture.md`](../../applications/staff-access/01-architecture.md) §3, ADR-0009/ADR-0010; internal HMAC envelope → [`libs/internal-auth-contracts/src/internal-auth.ts`](../../../libs/internal-auth-contracts/src/internal-auth.ts). Permission identifiers không rest ở đây.

## Documents

| Document                               | Nội dung                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`domain-model.md`](./domain-model.md) | Mô hình nghiệp vụ: pact, verification, matrix, can-i-deploy, tenant/membership/role, machine credential, invariant |
