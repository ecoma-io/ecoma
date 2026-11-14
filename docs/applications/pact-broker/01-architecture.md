# Pact Broker — Solution Architecture

> Phạm vi: thiết kế của hai deploy unit `pact-broker-api` + `pact-broker-app` — boundary kỹ thuật, runtime, data model, auth model, invariants. Ranh giới bounded context, domain rules, tenant isolation, can-i-deploy fail-closed → [`docs/domains/pact-broker/domain-model.md`](../../domains/pact-broker/domain-model.md) (canonical).

## 1. Deploy units

- `pact-broker-api`: Cloudflare Worker (Hono), API-only, tương thích Pact CLI; Hyperdrive binding → `db-pact-broker` (PostgreSQL; query cache OFF). Trên local lane, API có host route riêng để Pact CLI trên máy dev gọi trực tiếp (kết luận #205 quyết định 11 — hiện trạng không-router trước đó chưa từng là quyết định canonical; comment "#238" trong deploy code trỏ tới issue không tồn tại và được sửa bởi slice đụng file, hiện thực qua #208). SR-003/SR-005 giữ nguyên: mọi endpoint domain đòi credential, CORS không mở thêm origin nào.
- `pact-broker-app`: Cloudflare Worker (Nuxt 4 + Nitro preset `cloudflare_module`); BFF server routes → gọi `pact-broker-api` bằng fetch nội bộ qua base URL cấu hình, forward **access token của người dùng** — [ADR-0031](../../domains/pact-broker/adr/0031-developer-portal-authentication-and-identity-propagation.md), hiện thực qua #206 (mọi `/api/broker/*` đòi phiên đã đăng nhập; không còn machine token nào của deploy unit); session store server-side trong DB riêng `db-pact-broker-app` (ADR-0031 §2); browser session qua OIDC `auth.ecoma.io`.

## 2. Runtime

```text
apps/pact-broker-api   (Cloudflare Worker, Hono; API-only, Pact CLI-compatible)
├── Hyperdrive binding → db-pact-broker   (PostgreSQL; query cache OFF)
└── Worker Secrets: PACT_BROKER_INTERNAL_SECRET (HMAC internal, target — xem §8)

apps/pact-broker-app   (Cloudflare Worker, Nuxt 4 + Nitro preset cloudflare_module)
├── BFF server routes → gọi pact-broker-api (fetch nội bộ qua base URL; forward access token
│   của user theo ADR-0031, #206 — không machine token nào của deploy unit)
├── Hyperdrive binding → db-pact-broker-app   (session store riêng của app; ADR-0031 §2)
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
- `machine_tokens`: chỉ lưu **hash** SHA-256 của token (`token_hash` UNIQUE, là index tra cứu của mọi request; PK là `id` uuid); `tenant_id`, `name`, `scopes` (text CSV hoặc jsonb), `purpose` (`developer|ci`, nullable — validated lúc tạo, không bao giờ là input authorization runtime — [ADR-0032](../../domains/pact-broker/adr/0032-developer-authorization-matrix-and-credential-policy.md) §2; migration thuộc #207), `created_by_sub` (opaque `sub`; expose trong list metadata theo [ADR-0032](../../domains/pact-broker/adr/0032-developer-authorization-matrix-and-credential-policy.md) §8), `revoked_at` (NULL = active). Không có `last_used_at` — ghi nó đòi UPDATE trên mọi request (observability thành serving-path dependency, trái bất biến); usage tracking khi cần thì đọc từ `audit_events` (append-only, off-path). Plaintext hiện **một lần** trong response của lệnh tạo; không đường nào đọc lại. Revoke = set `revoked_at`, hiệu lực **ngay lập tức** (mỗi request tra hash rồi check `revoked_at IS NULL`).
- Scopes: `read` (viewer trở lên), `write` (member trở lên: publish pact/verification), `admin` (environments, webhooks, membership). Token scope ≠ role của người — token là credential cấp sẵn quyền cố định. Creator-role→scope được enforce theo [ADR-0032](../../domains/pact-broker/adr/0032-developer-authorization-matrix-and-credential-policy.md) §3 (hiện thực qua #206/#207); owner của tenant (`tenants.owner_sub`) không phải role membership — authority riêng của owner được diễn đạt qua permission matrix ([ADR-0032](../../domains/pact-broker/adr/0032-developer-authorization-matrix-and-credential-policy.md) §1), không nằm trong thang scope token.

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
3. `INSERT INTO pact.tenant_members (tenant_id, sub, role) VALUES (...,'member') ON CONFLICT (tenant_id, sub) DO NOTHING` — idempotent; thành viên có sẵn role cũ thì giữ nguyên. Membership bootstrap ghi role `member` — giá trị được giữ nguyên theo [ADR-0032](../../domains/pact-broker/adr/0032-developer-authorization-matrix-and-credential-policy.md) §7, gồm lệch áp dụng đã chấp nhận so với nguyên văn "khởi đầu ở role thấp nhất" của [ADR-0025](../../domains/llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md) §4 (thang role tường minh có `viewer` thấp hơn); owner nằm trên `tenants.owner_sub`, không phải role, và authority của owner độc lập với role row này.
4. Race test: hai connection đồng thời cùng sub phải cho đúng một tenant + một membership `member`, không lỗi chết.

**Ranh giới bắt buộc:** quyền truy cập sản phẩm từ Staff Access không thay thế authorization bên trong Pact Broker; nhân sự nội bộ provision vào tenant `ecoma` **chỉ bắt đầu với quyền Member** trừ khi có quy trình cấp quyền quản trị rõ ràng; thu hồi entitlement không được vô tình xóa customer membership độc lập hoặc machine credentials không thuộc vòng đời nhân sự đó. `ecoma` phải được bootstrap tường minh và có kiểm soát.

## 5. Auth model

Hai đường credential tách biệt: browser/OIDC cho dashboard, machine token cho Pact CLI/CI. Credential của đường này không bao giờ chia sẻ với đường còn lại.

### 5.1 Dashboard path (`pact-broker-app`)

Quyết định auth/session/identity của portal: [ADR-0031](../../domains/pact-broker/adr/0031-developer-portal-authentication-and-identity-propagation.md); permission matrix và credential policy: [ADR-0032](../../domains/pact-broker/adr/0032-developer-authorization-matrix-and-credential-policy.md) — hiện thực qua #206 (auth + API-side enforcement) và #207 (credential self-service).

- **Hiện thực M1 (ADR-0031, qua #206):** đăng nhập qua OIDC `auth.ecoma.io` (authorization code + PKCE; access token ES256 TTL 300s verify offline bằng JWKS); session store server-side trong `db-pact-broker-app` (DB riêng của app — xem invariant 1 tại §9), cookie `__Host-` chỉ mang định danh phiên hash-only; CSRF double-submit cho mutation; không tin bất kỳ claim nào do client gửi — identity chỉ đến từ session đã verify. Mọi route `/api/broker/*` trả 401 khi không có phiên hợp lệ; API-side enforcement theo [ADR-0032](../../domains/pact-broker/adr/0032-developer-authorization-matrix-and-credential-policy.md) — forged principal header fail-closed, suspended tenant ⇒ 401, cross-tenant trả 404 không phân biệt. BFF forward **access token của người dùng** xuống API; API verify JWKS rồi resolve `sub` → membership trong DB của mình, mỗi request. Envelope `ecoma-internal-v2` không dùng cho portal (giữ nguyên semantic actor-sub audit-only). Machine token của deploy unit `pact-broker-app` đã **retire** cùng slice (#206, ADR-0031 §5): lane không còn provision machine token nào cho `pact-broker-app`, không machine token nào xuất hiện trong traffic/cookie browser; machine path của Pact CLI/CI giữ nguyên (§5.2).
- **RBAC (ADR-0032):** API tự enforce role/owner theo permission matrix — thang `viewer` < `member` < `admin`, authority owner qua `tenants.owner_sub` (Staff Access system role không tự map thành role nào); đường machine token giữ nguyên scope-based. Enforce cuối cùng ở API side; BFF chỉ mirror cho UX. Hiện thực: #206 enforce ma trận cho đường user đã verify (reads mở cho `viewer` trở lên; membership grant/revoke + environment delete theo matrix, audit đi kèm); #207 còn lại cho credential self-service (routes `machine-tokens` với authority user thay vì machine).
- **Bất biến read-only-BFF thu hẹp (ADR-0032 §5):** portal không có route write domain (publish/verify/record-deployment/environment mutation); write duy nhất là credential management theo ma trận, đòi principal đã verify. `read-only-bff.spec.ts` được #207 biến đổi khi thêm mutation route.
- Bề mặt đọc của portal compose từ endpoint HAL hiện có — **không tạo API read endpoint mới trong M1** (kết luận #205 quyết định 17); nếu composition không đủ, contract mới đòi Modelling riêng (non-goal giữ nguyên của #181).

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

Resolution của target `to` theo thứ tự **environment → tag → branch** (cùng thứ tự upstream — LATERAL priority trong `matrix-repo.ts`) được **giữ nguyên** (kết luận #205 quyết định 14): không thu hẹp schema `to` ở M1 vì đầu vào CLI hợp lệ có thể là tên environment, tag hoặc branch; scenario integration ghim thứ tự ưu tiên đó đã được liệt kê trong bản đồ bằng chứng của [`verify-contracts-and-gate-deployments.md`](../../features/pact-broker/verify-contracts-and-gate-deployments.md) §6 (closure declared-limit của #183).

## 7. Webhook (mặc định TẮT ở production path)

Upstream có webhook outbound. Cho đến khi có SSRF protection chứng minh được (HTTPS-only, block private/loopback/metadata IP ranges, chống DNS rebinding — SR-006), webhook outbound **không bật trong production path**: route trả 501 với lý do, flag config `PACT_BROKER_WEBHOOKS_ENABLED` mặc định `false` và production env không được phép set true. Schema vẫn tạo bảng để không phải expand/contract sau này.

## 8. Worker Secrets / bindings

| Binding/Secret                       | Loại                   | Ghi chú                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HYPERDRIVE` (hoặc `DB_PACT_BROKER`) | Hyperdrive             | Connection string tới `db-pact-broker`; query cache OFF                                                                                                                                                                                                                                  |
| `PACT_BROKER_WEBHOOKS_ENABLED`       | var                    | Mặc định `false`; production **không** được set `true`                                                                                                                                                                                                                                   |
| `PACT_BROKER_DASHBOARD_ORIGIN`       | var                    | Origin duy nhất được CORS mở; thiếu = CORS đóng hoàn toàn                                                                                                                                                                                                                                |
| `PACT_BROKER_INTERNAL_SECRET`        | Worker Secret (target) | HMAC internal cho envelope `ecoma-internal-v2`; **không wire cho portal** — identity propagation đi đường OIDC ([ADR-0031](../../domains/pact-broker/adr/0031-developer-portal-authentication-and-identity-propagation.md)); giữ target-unwired cho đến khi một consumer nội bộ khác cần |

Secrets không đặt trong PR/CI file — native Worker Secrets qua quy trình `02-delivery.md`.

## 9. Invariants (deploy-unit)

1. Một service một database: mỗi service chỉ chạm DB của mình — `pact-broker-api` chạm `db-pact-broker`, `pact-broker-app` chạm `db-pact-broker-app` (session store, [ADR-0031](../../domains/pact-broker/adr/0031-developer-portal-authentication-and-identity-propagation.md) §2); không DB nào chạm DB của service khác.
2. Tenant isolation là composite FK/unique ở DB level, không chỉ WHERE clause.
3. Token hash-only; plaintext hiện một lần; revoke hiệu lực tức thời.
4. `can-i-deploy` unknown ≠ safe (fail-closed tri-state).
5. Migration từ CI runner với advisory lock; Worker không bao giờ DDL.
6. Không down-migration; expand → compatible rollout → contract.
7. Bootstrap/build/test/migrate không phụ thuộc dịch vụ nào đang sống.
8. Pact CLI compatibility: index HAL công bố compatibility version `2.107.0` và các link `pb:publish-contracts`, `pb:pacticipant-branch-version`, `pb:provider-pacts-for-verification` mà CLI gate theo.
9. Audit append-only ở DB level.
10. Không log secret, token, credential.
