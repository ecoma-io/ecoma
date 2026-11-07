# Pact Broker — Applications

Solution spec của hai deploy unit `pact-broker-api` + `pact-broker-app` thuộc bounded context `pact-broker`. Bounded context và domain rules → [`docs/domains/pact-broker/`](../../domains/pact-broker/README.md) (canonical).

- `pact-broker-api`: Cloudflare Worker (Hono), API-only, tương thích Pact CLI; sở hữu `db-pact-broker` (PostgreSQL qua Hyperdrive).
- `pact-broker-app`: Cloudflare Worker (Nuxt 4 + Nitro preset `cloudflare_module`); BFF server routes → gọi `pact-broker-api` qua Service Binding hoặc fetch nội bộ; browser session qua OIDC `auth.ecoma.io`.

## Documents

| Document                                       | Nội dung                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| [`01-architecture.md`](./01-architecture.md)   | Ranh giới deploy unit, runtime, data model, auth model, invariants |
| [`02-requirements.md`](./02-requirements.md)   | FR/NFR/SR có ID, non-goals, acceptance                             |
| [`03-operations.md`](./03-operations.md)       | Migration, provisioning, runbook, monitoring                       |
| [`UPSTREAM_MAPPING.md`](./UPSTREAM_MAPPING.md) | Ánh xạ từng module của upstream `pact-broker-workers` → đích Ecoma |

Thiết kế chi tiết bounded context, tenant isolation, machine token, can-i-deploy fail-closed → [`docs/domains/pact-broker/domain-model.md`](../../domains/pact-broker/domain-model.md).
