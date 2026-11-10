# `db-remote-cache` — schema, migration và test integration

Thư mục này là **nguồn sự thật duy nhất** cho schema của `db-remote-cache`. Không có ORM,
không có `drizzle-kit`, không có generate step: `db-remote-cache` là PostgreSQL thuần và
migration là file SQL thuần.

| Đường dẫn          | Vai trò                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `migrations/*.sql` | Migration, áp dụng **theo thứ tự tên file** (tên file có tiền tố số) |
| `migrate.mts`      | Hằng số và helper dùng chung cho runner và test harness              |
| `apply.mts`        | CLI runner, chạy trong CI                                            |

## `db-remote-cache` là greenfield provisioning

`db-remote-cache` là **greenfield provisioning**, không phải data migration. Trên `main`
chưa có schema, chưa có migration history, chưa có Hyperdrive binding — storage được xác
lập bởi [ADR-0015](../../../docs/domains/remote-cache/adr/0015-remote-cache-bounded-context.md)
(đã Accepted): database `db-remote-cache`, schema `remote_cache`, pattern ba role
`ecoma_owner`/`ecoma_remote_cache_migrator`/`ecoma_remote_cache_runtime`, chặn chéo
`REVOKE CONNECT` (kể cả rút khỏi `PUBLIC`). **Chung PostgreSQL instance ≠ chung write
authority** — `staff-access`, `pact-broker` không được ghi vào dữ liệu remote-cache.

Tenant của context này **khác tenant của pact-broker** (glossary §2.4): cùng giá trị id
không bao giờ nghĩa cùng entity trên hai context.

Migration history **độc lập** với các database khác: mỗi deploy unit rollout độc lập,
dùng chung bảng migration là cách buộc các service vào một release.

## Migrations hiện có

| File                        | Nội dung                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `0001_control_plane.sql`    | Schema `remote_cache`: `tenants`, `projects`, `tenant_members`, `api_keys` + trigger revoke-only    |
| `0002_roles_and_grants.sql` | Ba role, grant least-privilege per table, REVOKE dangerous privileges, REVOKE public, guard CONNECT |

## API key là machine credential hash-only

Bảng `api_keys` chỉ giữ SHA-256 hex của token (`token_hash` UNIQUE). Token nguyên bản
**show-once** lúc tạo qua `POST /projects`, sau đó hệ thống không có cách tái hiện.
Revocation là SET `revoked_at`, không DELETE; trigger `api_key_revocation_guard` chặn
un-revoke. **Không có `last_used_at`** — usage timestamp là observability, không được
đòi hỏi ghi serving path (pattern `pact.machine_tokens`).
