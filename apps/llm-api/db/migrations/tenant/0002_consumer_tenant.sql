-- 0002_consumer_tenant.sql — bảng nghiệp vụ `llm_tenant` của `db-llm-tenant`
-- trong slice bootstrap/seed bước 9 của Issue #24.
--
-- Bảng theo aggregate/invariant của bounded context llm-consumer-tenant
-- (domain-model §1, ADR-0025 §2–§3, ADR-0026 §1):
-- - `tenants`: `id`, `name`, `classification`, `owner_sub`, `created_at`.
--   Tenant **không có cột lifecycle/status** — trạng thái vận hành là giá trị
--   suy ra từ suspension record (thuộc slice sau), không phải cột thứ hai có
--   thể lệch nguồn sự thật. `owner_sub` là fact đúng-một-owner trên bản ghi
--   tenant (ADR-0025 §3), không phải membership role. `classification`
--   (`first_party`/`customer`) là quan hệ tổ chức, không phải commercial plan
--   (ADR-0026 §1); chỉ được thiết lập qua đường provisioning sản phẩm kiểm
--   soát (ADR-0020 Quyết định 3) và bất biến sau khi thiết lập.
-- - `memberships`: membership mang danh tính riêng theo **lần** cấp quyền
--   (`id`), không mang role (quyền đến từ grant — thuộc slice sau); tối đa một
--   membership `active` cho một actor trong một tenant (partial unique), row
--   `revoked` giữ lại làm lịch sử, revoke là terminal.
-- Natural key: tenant = `name` (canonical `ecoma`, ADR-0020 Quyết định 9 —
-- không có biến thể `ecoma-internal`); membership = `(tenant_id, id)` của lần
-- cấp quyền và `(tenant_id, actor) WHERE status = 'active'`. Re-run bootstrap
-- là no-op theo natural key; seed lại tenant đã bị xoá bị chặn fail-closed ở
-- runner (không có trạng thái resurrect — không có cột status để "sống lại",
-- ADR-0020 Quyết định 6).
-- `bootstrap_audit` — audit append-only một row mỗi run thành công
-- (ADR-0020: audit trail của mọi lần chạy), chỉ mang khoá natural và outcome,
-- không bao giờ mang giá trị credential.
-- DDL idempotent, không ledger, không down-migration (ADR-0025 §6,
-- 02-delivery.md §3). Forward-fix: stack đã provision trước slice này nhận
-- bảng ở lần apply kế tiếp.

CREATE TABLE IF NOT EXISTS llm_tenant.tenants (
  id             text NOT NULL PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  classification text NOT NULL,
  owner_sub      text NOT NULL,
  created_at     bigint NOT NULL,
  CONSTRAINT tenants_classification_check
    CHECK (classification IN ('first_party', 'customer'))
);

COMMENT ON TABLE llm_tenant.tenants IS
  'Consumer tenant aggregate (llm-consumer-tenant). Natural key: name (canonical bootstrap identity "ecoma", ADR-0020 decision 9; no "ecoma-internal" variant exists). No lifecycle status column exists by design: operational state is derived from suspension records, never persisted as a second source of truth. classification is the organizational-relation axis (first_party or customer), a provisioning fact set only through the product-controlled bootstrap surface and immutable afterwards (ADR-0026 section 1) - it is not a commercial plan. owner_sub is the single owner fact on the tenant (ADR-0025 section 3), not a membership role. Idempotent bootstrap by natural key; reseeding a removed tenant is rejected fail-closed by the runner (ADR-0020 decision 6).';

CREATE TABLE IF NOT EXISTS llm_tenant.memberships (
  tenant_id  text NOT NULL REFERENCES llm_tenant.tenants (id),
  id         text NOT NULL,
  actor      text NOT NULL,
  status     text NOT NULL,
  created_at bigint NOT NULL,
  revoked_at bigint,
  CONSTRAINT memberships_pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT memberships_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT memberships_revoked_window_check
    CHECK ((status = 'active') = (revoked_at IS NULL))
);

COMMENT ON TABLE llm_tenant.memberships IS
  'Consumer tenant membership (llm-consumer-tenant). id is the identity of one membership grant instance: permission grants (later slice) attach to this id, so rights of a revoked membership never revive when the actor is provisioned again. Membership carries no role - authority comes from owner fact or explicit grants only. Revocation is terminal for the row; re-provisioning creates a new row with a new id.';

CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_active_actor_idx
  ON llm_tenant.memberships (tenant_id, actor) WHERE status = 'active';

COMMENT ON INDEX llm_tenant.memberships_one_active_actor_idx IS
  'Partial unique index enforcing at most one active membership per actor per tenant (llm-consumer-tenant domain model section 1).';

CREATE TABLE IF NOT EXISTS llm_tenant.bootstrap_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  runner      text NOT NULL,
  outcome     text NOT NULL,
  detail      jsonb NOT NULL,
  actor       text NOT NULL,
  occurred_at bigint NOT NULL,
  CONSTRAINT tenant_bootstrap_audit_runner_check CHECK (runner IN ('consumer-tenant')),
  CONSTRAINT tenant_bootstrap_audit_outcome_check
    CHECK (outcome IN ('created', 'no-op'))
);

COMMENT ON TABLE llm_tenant.bootstrap_audit IS
  'Append-only audit of bootstrap/seed runs against db-llm-tenant (ADR-0020 decisions 5-6). One row per successful run: outcome created or no-op, with natural keys and counts only - never credential values.';
