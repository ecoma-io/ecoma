# Staff Access — Application Architecture

`staff-access` là executable component hiện thực nghiệp vụ **Staff Access** (bounded context): sổ staff, catalog role/permission, staff-role assignment, entitlement, authorization audit và privileged-operation workflow, phục vụ Composition `backoffice` qua internal API/BFF.

> Phần business semantics (khái niệm, quy tắc nghiệp vụ, invariant, sự kiện domain) thuộc [`docs/domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md); tài liệu này chỉ mô tả runtime/component và trỏ về Domain Model nơi cần.

## 1. Composition và ranh giới runtime

- **Component type:** UI/BFF + Worker API nội bộ (deploy unit `apps/staff-access`).
- **Runtime boundary:** `apps/staff-access` chạy trên Cloudflare Worker/Nitro, đồng tiến với BFF `backoffice` qua Service Binding hoặc HTTP contract tùy môi trường.
- **Người dùng trực tiếp:** staff nội bộ qua UI `backoffice`; internal clients khác gọi contract profiles/entitlement qua envelope HMAC.
- **Không phải bounded context:** component này **không sở hữu** domain `staff-access` — nó chỉ host implementation của nó. Domain knowledge ở [`docs/domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md).

## 2. Application flow và orchestration

1. Client (browser qua `backoffice` BFF) gọi routes BFF (`/api/staff`, `/api/onboarding-status`, `/api/me`) sau `requirePrincipal` — chỉ staff đã đăng nhập mới chạm được; `sub` của principal là khóa tra cứu duy nhất.
2. BFF `backoffice` đọc `displayName` từ contract `GET /internal/account/profiles` của `account`; cơ chế gate/cache/degrade thuộc composition đó → [`applications/backoffice/01-architecture.md`](../backoffice/01-architecture.md) §2.1.
3. Mọi thao tác đặc quyền (gán role, thay entitlement, …) là privileged operation: principal lấy từ server-side verified token, audit append-only (actor, target, action, time, result, reason, correlation ID).
4. Thay đổi entitlement/role được ghi cùng transactional outbox trong một transaction (A8) và truyền đến các sản phẩm bằng event bất đồng bộ.
5. `staff-access-relay` (Worker cron) claim outbox chưa publish, publish vào Cloudflare Queues với idempotency key = `event_id`.

## 3. API/protocol surfaces

- **Internal contract:** `GET /internal/account/profiles?subs=…` (tiêu thụ profiles của `account`); envelope HMAC (signature + timestamp + nonce, chống replay) xác thực mọi lời gọi nội bộ — vị trí mạng nội bộ **không** là trust.
- **Authn boundary:** 401 cho credential vắng/hỏng, 503 cho credential không verify được lúc này (ADR-0011); Credential contract: Authorization Code + PKCE, BFF đổi code → token, verify access token offline JWKS, ánh xạ `sub` → staff (ADR-0012).
- **Không có** internal contract nhận kết quả authorization từ `staff-access` (ADR-0009) — chỉ batch/event-based sync.

## 4. Integrations và adapters

- `account`: tiêu thụ contract profiles qua Service Binding `ACCOUNT_SERVICE` (binding `ecoma-account-bridge`) + secret `AUTH_INTERNAL_SECRET` ký/xác minh envelope. Service Binding **không** có nghĩa là xác thực — envelope HMAC mới là lớp xác thực.
- `auth`: verify access token offline JWKS, ánh xạ `sub` → staff; step-up evidence chỉ đến từ trusted `auth` flow.
- Cloudflare Queues: delivery channel cho entitlement event (A8), idempotency key = `event_id`.

## 5. Persistence implementation

- **Database:** `db-staff-access`, PostgreSQL, schema `staff_access` (ADR-0013, thay tên trong khuôn ADR-0001).
- **Bảng:** staff, role, permission, role_permissions, role_assignment, authorization audit (append-only), `entitlement_outbox_events` (outbox source of truth).
- **Role ba tầng:** `ecoma_owner` / `ecoma_staff_access_migrator` / `ecoma_staff_access_runtime` — không dùng chung credential; chặn chéo `REVOKE CONNECT` (kể cả rút khỏi `PUBLIC`) và Hyperdrive riêng với query cache OFF.
- **Migration:** SQL thuần idempotent, forward-only, apply từ CI runner bằng migrator role với advisory lock theo tên database; migration history độc lập với `db-account`/`db-auth`.
- **Cache:** không giữ bản sao bền vững của `displayName`; cache và chính sách degrade thuộc BFF `backoffice` → [`applications/backoffice/01-architecture.md`](../backoffice/01-architecture.md) §2.1.

## 6. Runtime security

- Least-privilege runtime DB credential; runtime privilege ≠ migrator privilege.
- `account`/`auth` **không bao giờ** mutate dữ liệu staff/role/permission của `staff-access`, dù chung PostgreSQL instance.
- Server-side enforcement trên mọi protected request; deny-by-default; object-level + scope-level check bắt buộc.
- Internal call mang envelope HMAC; endpoint không phân biệt Service Binding với request Internet — Service Binding là đường đi, không phải xác thực.
- Principal lấy từ server-side verified token, không từ request body/param (tránh confused deputy).

## 7. Execution/failure model

- Chính sách lỗi khi đọc `displayName` từ `account` (gate fail-closed, controlled degrade, log event) thuộc BFF `backoffice` → [`applications/backoffice/01-architecture.md`](../backoffice/01-architecture.md) §2.1.
- Token validity ≠ privilege currency (A24): privilege check đọc trạng thái hiện hành, không suy từ token còn hạn; fail closed khi trạng thái không đọc được.
- Ngưỡng revocation latency: `normal` ≤ 60s, `high` ≤ 5s (ADR-0002), cơ chế event-driven invalidation (ADR-0014).

## 8. Dependency trên Domain contexts

- `staff-access` (host business semantics — trỏ [`docs/domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md)).
- `account` (tiêu thụ displayName qua contract — không mutates dữ liệu staff/RBAC).
- `auth` (verify token, internal HMAC envelope, step-up evidence).

## 9. Application-level invariants

- UI visibility ≠ authorization (A23): gọi trực tiếp API phải vẫn bị từ chối.
- Catalog là nguồn sự thật duy nhất của permission; resource-owning backend không tự phát minh permission ngoài catalog (ADR-0010).
- Authorization audit append-only, access-restricted, không chứa secret/token/PII.
- Staff status và account status là hai trục độc lập, không suy ra nhau.
- Không có bypass `isAdmin`/cờ chưa document; mọi privileged operation có audit.
