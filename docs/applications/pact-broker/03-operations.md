# Pact Broker — Operations (deploy-unit)

> Vận hành deploy unit `pact-broker-api` + `pact-broker-app`. Bounded context operations (business) → [`docs/domains/pact-broker/domain-model.md`](../../domains/pact-broker/domain-model.md) (canonical).

## Migration

- Thư mục: `apps/pact-broker-api/db/migrations/*.sql` — thứ tự tên file, idempotent (apply lại là no-op), **không down-migration**, mọi file bọc `BEGIN`/`COMMIT` (`migration-transaction-wrap-required`).
- Chạy: `pnpm nx run pact-broker-api:db:migrate` với `DATABASE_URL` của role `ecoma_pact_broker_migrator` từ CI secret store. Runner lấy `pg_advisory_lock(hashtext('db-pact-broker'))` — cùng một đường code `applyAllMigrations` cho CLI và integration test (một đường apply duy nhất, pattern `apps/account/db/apply.mts`).
- Role: ba tầng như mọi service — `ecoma_owner` (hạ tầng, không chạy trong Worker), `ecoma_pact_broker_migrator` (chỉ CI secret), `ecoma_pact_broker_runtime` (Worker secret, chỉ DML schema `pact`).
- Provisioning step 1 (admin/owner, ngoài migration): `CREATE DATABASE db-pact-broker`, `GRANT CREATE` database cho migrator, `REVOKE CONNECT` chéo giữa `db-pact-broker` và các database khác cho runtime role. Migration chỉ **assert** kết quả provisioning, không tự revoke database khác.
- Hyperdrive binding của Worker là placeholder cho tới khi provisioning thật — Worker fail-closed khi thiếu binding, đúng pattern `db-account`/`db-auth`.

## Worker config

| Binding/Secret                       | Loại       | Ghi chú                                                            |
| ------------------------------------ | ---------- | ------------------------------------------------------------------ |
| `HYPERDRIVE` (hoặc `DB_PACT_BROKER`) | Hyperdrive | Connection string tới `db-pact-broker`; query cache OFF            |
| `PACT_BROKER_WEBHOOKS_ENABLED`       | var        | Mặc định `false`; production **không** được set `true` (SR-006)    |
| `PACT_BROKER_DASHBOARD_ORIGIN`       | var        | Origin duy nhất được CORS mở (SR-005); thiếu = CORS đóng hoàn toàn |

Secrets không đặt trong PR/CI file — native Worker Secrets qua quy trình `02-delivery.md`; repository không chứa secret nào (không đưa secret vào log/artifact).

## Bootstrap (dogfooding)

1. Provision DB + role (bước 1 ở trên, tay/admin một lần).
2. `db:migrate` từ CI runner.
3. Tạo tenant đầu + token đầu: chạy một lần bằng seed script local/test **hoặc** API với bootstrap credential do operator cấp — không tự sinh qua đường production không kiểm soát. Token plaintext hiện một lần; operator tự lưu.
4. Pact CLI publish đầu tiên: `PACT_BROKER_BROKER_BASE_URL` + token → `pact-broker publish ...`.

Build/test/migrate/bootstrap **không** đòi Account/Auth đang sống.

## Monitoring / failure modes

- `GET /health` — không chạm DB trên đường health (observability không thành serving-path dependency).
- DB unreachable / config thiếu → `503` fail-closed trên mọi route cần DB; error body không lộ driver message. Chưa có `Retry-After` (không có reconnect-delay config); client Pact CLI tự retry theo schedule của nó.
- Audit events là bằng chứng vận hành cho token/membership change; đọc bằng owner, không bằng runtime role.

## Runbook tóm tắt

| Tình huống                           | Hành động                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Migration fail giữa file             | Dừng, không rollback tự động; sửa file mới (forward-fix), apply lại — file idempotent |
| Token leak                           | Revoke qua API/owner; audit ghi reason; cấp token mới                                 |
| Hyperdrive binding thiếu/placeholder | Worker fail-closed 503 — provision rồi deploy lại                                     |
| Webhook cần bật                      | Chỉ sau khi SSRF guard chứng minh được; không bật production trước đó (SR-006)        |
