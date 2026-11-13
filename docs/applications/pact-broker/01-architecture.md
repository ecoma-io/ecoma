# Pact Broker — Solution Architecture

> Phạm vi: thiết kế của hai deploy unit `pact-broker-api` + `pact-broker-app` — boundary kỹ thuật, runtime, data model, auth model, invariants. Ranh giới bounded context, domain rules, tenant isolation, can-i-deploy fail-closed → [`docs/domains/pact-broker/domain-model.md`](../../domains/pact-broker/domain-model.md) (canonical).

## 1. Deploy units

- `pact-broker-api`: Cloudflare Worker (Hono), API-only, tương thích Pact CLI; Hyperdrive binding → `db-pact-broker` (PostgreSQL; query cache OFF).
- `pact-broker-app`: Cloudflare Worker (Nuxt 4 + Nitro preset `cloudflare_module`); BFF server routes → gọi `pact-broker-api` bằng fetch nội bộ qua base URL cấu hình kèm machine token server-side (không dùng Service Binding); browser session qua OIDC `auth.ecoma.io` — target M1, hiện thực qua #206 (hiện trạng: `/api/broker/*` chưa có xác thực — xem §5.1).

## 2. Runtime

```text
apps/pact-broker-api   (Cloudflare Worker, Hono; API-only, Pact CLI-compatible)
├── Hyperdrive binding → db-pact-broker   (PostgreSQL; query cache OFF)
└── Worker Secrets: PACT_BROKER_INTERNAL_SECRET (HMAC internal, target — xem §8)

apps/pact-broker-app   (Cloudflare Worker, Nuxt 4 + Nitro preset cloudflare_module)
├── BFF server routes → gọi pact-broker-api (fetch nội bộ qua base URL + machine token server-side)
└── Browser session: OIDC qua auth.ecoma.io; browser KHÔNG chạm DB, KHÔNG tin
    userId/sub/role/permission do client gửi
```

- Migration chạy từ **CI runner** bằng credential `_migrator` qua `nx run pact-broker-api:db:migrate` — **không bao giờ** chạy DDL từ Worker (HD6: Hyperdrive không hỗ trợ advisory lock; runner cần `pg_advisory_lock`).
- Không chạy advisory lock, `LISTEN/NOTIFY`, `PREPARE` qua Hyperdrive ở serving path (HD6).

## 3. Data model — `db-pact-broker`

Schema ứng dụng tên `pact`. Ba nhóm bảng:

### 3.1 Tenant + membership + machine token (lớp Ecoma, viết mới)

- `tenants`: `id` (uuid), `name` (unique, regex giống `nameSchema` upstream), `status` (`active|suspended|deleted`), `owner_sub` (NOT NULL, opaque `sub` của đúng một owner — không phải role membership), `classification` (NOT NULL, `first_party|customer` — immutable sau provisioning), `plan` (nullable, `free|paid`, chỉ khi `classification='customer'`; invariant "đúng một Free slot mỗi owner" enforce bằng partial unique index `tenants_one_free_per_owner_key` — `WHERE plan = 'free' AND status <> 'deleted'`), timestamps. Default tenant per sub được provision **tường minh** (deterministic từ sub, qua bootstrap script — xem §4; không tự động khi signup/login), **idempotent + race-safe** (INSERT ON CONFLICT); tenant canonical `ecoma` đi qua script bootstrap riêng (first_party, không có plan — xem §4).
- `tenant_members`: `UNIQUE (tenant_id, sub)`; `role` CHECK IN ('admin','member','viewer') — role `owner` đã bị loại, ownership nằm ở `tenants.owner_sub`. Composite FK về `tenants` và (khi thêm) unique-sub constraint cho phép DB-level enforce "member thuộc đúng tenant".
- `machine_tokens`: chỉ lưu **hash** SHA-256 của token (`token_hash` UNIQUE, là index tra cứu của mọi request; PK là `id` uuid); `tenant_id`, `name`, `scopes` (text CSV hoặc jsonb), `created_by_sub`, `revoked_at` (NULL = active). Không có `last_used_at` — ghi nó đòi UPDATE trên mọi request (observability thành serving-path dependency, trái bất biến); usage tracking khi cần thì đọc từ `audit_events` (append-only, off-path). Plaintext hiện **một lần** trong response của lệnh tạo; không đường nào đọc lại. Revoke = set `revoked_at`, hiệu lực **ngay lập tức** (mỗi request tra hash rồi check `revoked_at IS NULL`).
- Scopes: `read` (viewer trở lên), `write` (member trở lên: publish pact/verification), `admin` (environments, webhooks, membership). Token scope ≠ role của người — token là credential cấp sẵn quyền cố định. Người tạo phải có role đủ cao (quy tắc này chưa được enforce trên đường request nào — permission matrix và cơ chế enforce thuộc #205, hiện thực qua #206/#207); owner của tenant (`tenants.owner_sub`) không phải role membership — authority riêng của owner được diễn đạt qua authorization rules của broker (§5.1), không nằm trong thang scope token.

Ngữ nghĩa business của tenant/membership/role, machine credential, plan và Free slot → [`docs/domains/pact-broker/domain-model.md`](../../domains/pact-broker/domain-model.md) §2.5, §2.6 (canonical; schema `classification`/`plan` và invariant Free slot đã được migration `0004_tenant_classification_and_plan.sql` hiện thực hoá).

### 3.2 Domain Pact (port từ upstream, thêm `tenant_id`)

Toàn bộ bảng upstream (`pacticipants`, `versions`, `tags`, `pacts`, `verifications`, `environments`, `deployed_versions`, `webhooks`, `webhook_executions`) được port sang PostgreSQL với:

- **`tenant_id uuid NOT NULL` trên mọi bảng domain** + composite UNIQUE/FK chéo bảng để isolation là thuộc tính của **schema**, không phải chỉ của query. Ví dụ:
  - `pacts`: `UNIQUE (tenant_id, consumer_version_id, provider_id)`; FK `(tenant_id, consumer_version_id) → versions (tenant_id, id)`.
  - `verifications`: FK `(tenant_id, pact_id) → pacts (tenant_id, id)` và `(tenant_id, provider_version_id) → versions (tenant_id, id)`.
  - `tags`: FK `(tenant_id, version_id) → versions (tenant_id, id)`, `UNIQUE (tenant_id, version_id, name)`.
- Như vậy một row "lệch tenant" (tham chiếu version của tenant khác) bị **FK từ chối ở tầng database**, ngay cả khi code có bug.
- Kết quả verification, content SHA, semantics branch/tag/buildUrl giữ nguyên behaviour upstream: `getOrCreateVersion` backfill-only; publish pact SHA-256 content, update-khi-đổi, 201/200; `deployed_versions.undeployed_at NULL` = đang deploy.
- Timestamps `timestamptz` (thay TEXT datetime của SQLite upstream).

Ngữ nghĩa business của pact, verification, matrix, environment/deployment record → [`docs/domains/pact-broker/domain-model.md`](../../domains/pact-broker/domain-model.md) §2.1–2.4.

### 3.3 Audit + append-only

- `pact.audit_events`: append-only (trigger chặn UPDATE), ghi token tạo/revoke, membership change, environment change. Không log prompt/response.

Ngữ nghĩa audit business → [`docs/domains/pact-broker/domain-model.md`](../../domains/pact-broker/domain-model.md) §2.7.

## 4. Default tenant provisioning (race-safe)

`ensureDefaultTenant(name, ownerSub)` là primitive race-safe của tenant repo cho **tenant mặc định của customer** — lần tạo đầu ghi `classification='customer'`, `plan='free'`; **không** có đường HTTP nào tự gọi nó khi account đăng ký hay đăng nhập. Tenant canonical `ecoma` **không** đi qua primitive này: nó được provision tường minh bởi script service-owned `db/bootstrap-tenant.mts` (first_party, không có plan — hợp đồng canonical → [`architecture/02-delivery.md`](../../architecture/02-delivery.md) §3.2, [ADR-0020](../../domains/staff-access/adr/0020-bootstrap-seed-contract.md), [`docs/domains/pact-broker/domain-model.md`](../../domains/pact-broker/domain-model.md) §2.6).

Khi được gọi (trong bootstrap có kiểm soát), primitive thực hiện:

1. `INSERT INTO pact.tenants (name, owner_sub, classification, plan, ...) VALUES ($defaultName, $ownerSub, 'customer', 'free', ...) ON CONFLICT (name) DO NOTHING RETURNING id` — `name` suy deterministic từ sub (vd `tenant-<sub-prefix>`), nên retry/concurrency hội tụ cùng một tên; `owner_sub` và `classification` chỉ được ghi trên lần tạo đầu, bên thua không ghi đè owner của bên thắng.
2. Nếu `ON CONFLICT` không trả row → SELECT row hiện có; nếu tenant đó `deleted`/`suspended` → fail-closed (không tự hồi sinh).
3. `INSERT INTO pact.tenant_members (tenant_id, sub, role) VALUES (...,'member') ON CONFLICT (tenant_id, sub) DO NOTHING` — idempotent; thành viên có sẵn role cũ thì giữ nguyên. Membership bootstrap hiện ghi role `member` (giá trị trong code; [ADR-0025](../../domains/llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md) §4 chỉ quy định "khởi đầu ở role thấp nhất" không gọi tên, còn thang role có `viewer` thấp hơn — role bootstrap của owner và đường tự thăng hạng là quyết định đang mở của #205); owner nằm trên `tenants.owner_sub`, không phải role.
4. Race test: hai connection đồng thời cùng sub phải cho đúng một tenant + một membership `member`, không lỗi chết.

**Ranh giới bắt buộc:** quyền truy cập sản phẩm từ Staff Access không thay thế authorization bên trong Pact Broker; nhân sự nội bộ provision vào tenant `ecoma` **chỉ bắt đầu với quyền Member** trừ khi có quy trình cấp quyền quản trị rõ ràng; thu hồi entitlement không được vô tình xóa customer membership độc lập hoặc machine credentials không thuộc vòng đời nhân sự đó. `ecoma` phải được bootstrap tường minh và có kiểm soát.

## 5. Auth model

Hai đường credential tách biệt: browser/OIDC cho dashboard, machine token cho Pact CLI/CI. Credential của đường này không bao giờ chia sẻ với đường còn lại.

### 5.1 Dashboard path (`pact-broker-app`)

- **Hiện trạng (audit 2026-11-13):** route `/api/broker/*` chưa có xác thực nào (public); BFF giữ **một machine token server-side** của deploy unit `pact-broker-app` và forward kèm token của chính mình — source `apps/pact-broker-app/server/utils/broker-client.ts`; bất biến read-only của BFF có test chốt (`apps/pact-broker-app/tests/read-only-bff.spec.ts`) và BFF fail-closed khi thiếu config. Trên lane local token được provision scope `admin`; scope chuẩn của token này là quyết định đang mở — #205.
- **Target M1 (phạm vi portal đã accept qua #185; thiết kế chi tiết chờ #205 — hiện thực qua #206):** browser đăng nhập qua OIDC `auth.ecoma.io` (authorization code + PKCE; access token ES256 TTL 300s verify offline bằng JWKS); BFF giữ credential server-side, browser chỉ thấy session cookie `__Host-…` (hash-only ở server, đúng pattern `apps/account`); không tin bất kỳ claim nào do client gửi — identity chỉ đến từ session đã verify; CSRF cho mutation. API tự enforce role/owner độc lập với BFF — enforce cuối cùng ở API side.
- Identity propagation BFF→API: candidate là internal HMAC envelope `ecoma-internal-v2` (`libs/internal-auth-contracts/src/internal-auth.ts` — actor-sub integrity-bound, replay-protected, giới hạn body 64 KiB) hoặc per-user machine token — **quyết định đang mở, thuộc #205**; chưa wire gì, không claim đã implement.
- **RBAC:** target M1 kiểm ở cả BFF và API theo permission matrix được chốt tại #205 (role membership `viewer`/`member`/`admin`; authority cấp owner qua `tenants.owner_sub` — Staff Access system role không tự map thành role nào). Hiện trạng: chưa có đường request nào đọc role — deviation được ghi nhận, hiện thực qua #206/#207.
- Machine token server-side của BFF là trạng thái hiện hành cho tới khi #206 land; disposition của bất biến read-only-bff sau đó do #205 chốt.

### 5.2 Machine token (Pact CLI + CI)

- `Authorization: Bearer <token>` — token là chuỗi base64url 32-byte không prefix (generator `libs/pact-broker-api-application/src/hashing.ts`); tra `SHA-256(token)` trong `machine_tokens`; so hash — không so plaintext, không timing leak (tra cứu hash qua PK là constant-time theo index).
- Fail: 401 đồng nhất cho mọi lý do (thiếu header, token lạ, token đã revoke, tenant suspended) — không phân biệt "token không tồn tại" vs "đã revoke" trong body (chỉ audit phân biệt). Source: `apps/pact-broker-api/src/auth/token-auth.ts`.
- Token có scope; endpoint check scope **và** tenant của token; không có cross-tenant token.

### 5.3 Bootstrap independence

Build/test/migrate/bootstrap của broker **không yêu cầu** Account/Auth production đang sống:

- Unit + integration test dùng testcontainers PostgreSQL (`postgres:17-alpine`) — không Hyperdrive, không dịch vụ ngoài.
- Machine token cho CLI được tạo qua API có auth riêng trong test; seed credential cho lane local/test chỉ tồn tại trên bề mặt provisioning/CLI, không nằm trong migration ([`02` §3.2](../../architecture/02-delivery.md)).
- Dashboard không bắt buộc để publish/verify (CLI path độc lập hoàn toàn).

## 6. `can-i-deploy` — nghĩa vụ của deploy unit

Quy tắc nghiệp vụ tri-state `deployable: boolean | null`, fail-closed khi `null` và nghĩa vụ CLI exit fail → [`domain-model.md`](../../domains/pact-broker/domain-model.md) §2.3 (canonical). Phần thuộc deploy unit: port `summarizeMatrix` gần nguyên xi (pure, đã có unit test upstream) và trả `deployable` đúng tri-state thay vì tự quyết định.

## 7. Webhook (mặc định TẮT ở production path)

Upstream có webhook outbound. Cho đến khi có SSRF protection chứng minh được (HTTPS-only, block private/loopback/metadata IP ranges, chống DNS rebinding — SR-006), webhook outbound **không bật trong production path**: route trả 501 với lý do, flag config `PACT_BROKER_WEBHOOKS_ENABLED` mặc định `false` và production env không được phép set true. Schema vẫn tạo bảng để không phải expand/contract sau này.

## 8. Worker Secrets / bindings

| Binding/Secret                       | Loại                   | Ghi chú                                                                                      |
| ------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------- |
| `HYPERDRIVE` (hoặc `DB_PACT_BROKER`) | Hyperdrive             | Connection string tới `db-pact-broker`; query cache OFF                                      |
| `PACT_BROKER_WEBHOOKS_ENABLED`       | var                    | Mặc định `false`; production **không** được set `true`                                       |
| `PACT_BROKER_DASHBOARD_ORIGIN`       | var                    | Origin duy nhất được CORS mở; thiếu = CORS đóng hoàn toàn                                    |
| `PACT_BROKER_INTERNAL_SECRET`        | Worker Secret (target) | HMAC internal cho envelope `ecoma-internal-v2`; chỉ dùng khi BFF→API internal auth được wire |

Secrets không đặt trong PR/CI file — native Worker Secrets qua quy trình `02-delivery.md`.

## 9. Invariants (deploy-unit)

1. Một service một database: chỉ `pact-broker-api` chạm `db-pact-broker`. Dashboard không có Hyperdrive binding nào.
2. Tenant isolation là composite FK/unique ở DB level, không chỉ WHERE clause.
3. Token hash-only; plaintext hiện một lần; revoke hiệu lực tức thời.
4. `can-i-deploy` unknown ≠ safe (fail-closed tri-state).
5. Migration từ CI runner với advisory lock; Worker không bao giờ DDL.
6. Không down-migration; expand → compatible rollout → contract.
7. Bootstrap/build/test/migrate không phụ thuộc dịch vụ nào đang sống.
8. Pact CLI compatibility: index HAL công bố compatibility version `2.107.0` và các link `pb:publish-contracts`, `pb:pacticipant-branch-version`, `pb:provider-pacts-for-verification` mà CLI gate theo.
9. Audit append-only ở DB level.
10. Không log secret, token, credential.
