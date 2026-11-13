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

Thứ tự bước, database đích, idempotency và kiểm tra sau bước theo hợp đồng canonical → [`architecture/02-delivery.md`](../../architecture/02-delivery.md) §3.2 ([ADR-0020](../../domains/staff-access/adr/0020-bootstrap-seed-contract.md)). Tên tenant nội bộ canonical là `ecoma`; `local` chỉ là nhãn environment, không phải tên tenant.

1. Provision DB + role (bước 1 ở trên, tay/admin một lần).
2. `db:migrate` từ CI runner.
3. **Bootstrap tenant + membership owner** — `db:bootstrap` (`db/bootstrap-tenant.mts`, bước 5a §3.2): một transaction tạo tenant `ecoma` (`active`, `first_party`, không có plan) kèm membership owner (role `member`, `source = 'bootstrap'`) và đúng một audit `tenant.bootstrap`; idempotent theo natural key, fail-closed khi tenant `suspended`/`deleted`, owner/classification/plan lệch, hoặc membership xung đột role/provenance.
4. **Provision machine token** — `db:provision-machine-token` (`db/provision-machine-token.mts`, bước 6 §3.2): resolve tenant `ecoma` fail-closed (không bao giờ tạo tenant), hash `SHA-256` tính trong script; trong một transaction, revoke token active cùng `(tenant, name)` khác hash rồi insert, verify cuối: đúng một token active cho natural key `(tenant ecoma, token name)` — lane local: `pact-broker-app-bff`.
5. Pact CLI publish đầu tiên: `PACT_BROKER_BROKER_BASE_URL` + token → `pact-broker publish ...` (runbook tay; việc pin phiên bản CLI và bộ lệnh chuẩn thuộc #205/#208 — journey hệ thống kiểm chứng CLI thật thuộc #27).
6. Kiểm tra: đọc lại tenant `active` + token chưa revoke, rồi publish thật bằng token đó.

Nguồn `owner_sub` của tenant: `sub` của Superadmin, lấy từ đường bootstrap administrator đo được — `pnpm dx bootstrap-superadmin --resolve-if-bootstrapped --json` (môi trường đã bootstrap → chỉ đọc sub; môi trường mới → bootstrap đầy đủ có guard). Không phải giá trị cấu hình tự do: lane local resolve sub này trước `pulumi up` rồi truyền qua env cho bước bootstrap, đúng thứ tự §3.2 (bước 3–4 trước bước 5a).

Hợp đồng lifecycle của machine token provisioning: plaintext ổn định theo environment, lấy từ cấu hình (không sinh mới mỗi lần chạy); DB chỉ giữ hash, plaintext đổi là rotation — revoke hàng active cũ trước khi ghi hàng mới, không bao giờ hai token active cho cùng `(tenant, name)`; provisioning không hồi sinh token đã revoke tay. Token này là credential server-side của BFF `pact-broker-app` cho đường đọc hiện hành; xác thực per-user cho dashboard đã vào phạm vi M1 (Modelling #205 → Delivery #206) — cho tới khi #206 land, token tĩnh này vẫn là trạng thái hiện hành và limitation tương ứng còn giữ trong #28. Scope chuẩn của token là quyết định đang mở của #205 (lane local hiện provision `admin`).

Consumer entitlement trên serving path **đọc** tenant `ecoma` (read-only) và không cần biến env chủ thể owner nào; nó đòi tenant được provision trước: grant gặp tenant thiếu/không `active` → fail-closed (throw → message retry → DLQ sau `max_retries`); revoke gặp tenant thiếu → no-op (`reason 'no-tenant'`), không tạo gì.

Build/test/migrate/bootstrap **không** đòi Account/Auth đang sống; riêng tenant bootstrap cần `sub` Superadmin đã được bootstrap trước — dữ liệu bền từ bootstrap account/staff (§3.2), không phải service đang sống.

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
