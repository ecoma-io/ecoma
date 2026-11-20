-- 0003_gateway_runtime.sql — schema `llm_gateway` của `db-llm-gateway` trong
-- slice bootstrap/seed bước 9 của Issue #24: bề mặt runtime/control của chính
-- `llm-api` trong database gateway (không thuộc bounded context tài chính hay
-- seller — hai schema kia đã có ownership riêng qua `0001`/`0002`).
--
-- Bảng:
-- - `api_keys`: API key của consumer tenant, bề mặt auth của data plane
--   (ownership: "API key, quota, usage, reservation, settlement → llm-api →
--   db-llm-gateway"). Natural key = `key_hash` = SHA-256 hex của plaintext
--   (ADR-0020 Quyết định 5); `id` suy ra deterministic từ hash (pattern
--   `provider_credentials`). KHÔNG có cột plaintext, không bao giờ — chỉ lưu
--   hash (show-once/hash-only). `tenant_id` là tham chiếu opaque tới
--   `llm_tenant.tenants.id` ở `db-llm-tenant`: KHÔNG FK xuyên database
--   (ADR-0020 Quyết định 4), integrity do runner + natural key bảo đảm.
-- - `bootstrap_audit`: audit append-only một row mỗi run thành công của bước 9
--   trên database này (ADR-0020: audit trail của mọi lần chạy).
-- DDL idempotent, không ledger, không down-migration (ADR-0025 §6,
-- 02-delivery.md §3). Forward-fix: stack đã provision trước slice này nhận
-- schema + bảng ở lần apply kế tiếp.

CREATE SCHEMA IF NOT EXISTS llm_gateway;

COMMENT ON SCHEMA llm_gateway IS
  'Gateway runtime schema of db-llm-gateway. Owning surface: the llm-api gateway itself (API keys of consumer tenants - data-plane auth surface). Not a bounded-context schema: llm_financial and llm_seller keep their own ownership per migrations 0001/0002. Business tables are seeded by the step-9 bootstrap runner of Issue #24.';

-- Runtime chạm được schema (USAGE); DML trên bảng tương lai được cấp qua default
-- privileges bên dưới — migrator tạo bảng sau này thì runtime tự có
-- SELECT/INSERT/UPDATE/DELETE (cùng pattern của `0001`).
GRANT USAGE ON SCHEMA llm_gateway TO ecoma_llm_gateway_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE ecoma_llm_gateway_migrator IN SCHEMA llm_gateway
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecoma_llm_gateway_runtime;

CREATE TABLE IF NOT EXISTS llm_gateway.api_keys (
  id         text NOT NULL PRIMARY KEY,
  tenant_id  text NOT NULL,
  key_hash   text NOT NULL,
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  revoked_at bigint,
  revoked_by text,
  CONSTRAINT api_keys_hash_unique UNIQUE (key_hash),
  CONSTRAINT api_keys_hash_bounded CHECK (length(key_hash) <= 512),
  CONSTRAINT api_keys_revoked_window_check
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

COMMENT ON TABLE llm_gateway.api_keys IS
  'API key of a consumer tenant (llm-api gateway runtime ownership). Natural key: key_hash = SHA-256 hex of the plaintext; the plaintext itself is shown exactly once by the bootstrap runner on the creating run and is never stored, logged or derivable (show-once/hash-only). id is derived deterministically from the hash (pattern of llm_marketplace.provider_credentials). tenant_id is an opaque reference to llm_tenant.tenants.id in db-llm-tenant - deliberately no foreign key across services (ADR-0020 decision 4). Revocation is one-way: a revoked key is never reactivated; revocation attribution is kept for audit.';

COMMENT ON COLUMN llm_gateway.api_keys.tenant_id IS
  'Opaque id of the owning consumer tenant in db-llm-tenant (llm_tenant.tenants.id). Cross-database by design; no foreign key across services.';

COMMENT ON COLUMN llm_gateway.api_keys.key_hash IS
  'SHA-256 hex of the key plaintext - the only stored form of the credential. Lookup on the serving path resolves by this hash; no plaintext column exists by design.';

CREATE INDEX IF NOT EXISTS api_keys_tenant_idx
  ON llm_gateway.api_keys (tenant_id);

COMMENT ON INDEX llm_gateway.api_keys_tenant_idx IS
  'Tenant-scoped lookup of keys (bootstrap divergence checks and per-tenant key listing); the serving-path auth lookup resolves by the unique key_hash.';

CREATE TABLE IF NOT EXISTS llm_gateway.bootstrap_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  runner      text NOT NULL,
  outcome     text NOT NULL,
  detail      jsonb NOT NULL,
  actor       text NOT NULL,
  occurred_at bigint NOT NULL,
  CONSTRAINT gateway_bootstrap_audit_runner_check CHECK (runner IN ('consumer-tenant')),
  CONSTRAINT gateway_bootstrap_audit_outcome_check
    CHECK (outcome IN ('created', 'no-op'))
);

COMMENT ON TABLE llm_gateway.bootstrap_audit IS
  'Append-only audit of bootstrap/seed runs against db-llm-gateway (ADR-0020 decisions 5-6). One row per successful run: outcome created or no-op, with natural keys and counts only - never credential values or hashes beyond key ids.';
