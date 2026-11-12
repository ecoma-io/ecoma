-- 0004_marketplace_offering.sql — bảng nghiệp vụ `llm_marketplace` của `db-llm-marketplace` trong slice bootstrap/seed của Issue #23.
--
-- Bảng theo aggregate/invariant của bounded context llm-marketplace (domain-model §3.5–§3.7,
-- ADR-0027 §7–§8): `model_offers`, `endpoint_pools`, `upstream_endpoints`, `provider_credentials`.
-- `seller_tenant_id` KHÔNG có FK: Seller tenant sống ở `db-llm-gateway` (`llm_seller.seller_tenants`)
-- — một service một DB, integrity liên DB do runner + natural key đảm bảo (ADR-0027 §8, ADR-0020 §4).
-- Credential: chỉ lưu HASH (SHA-256 hex, show-once/hash-only) — plaintext KHÔNG BAO GIỜ
-- xuất hiện ở bất kỳ cột nào; hai trục scope là `provider` (upstream) và `seller_tenant_id`
-- (owning tenant). Không có index/constraint theo `provider` một mình: đường lookup
-- credential xuyên tenant không tồn tại (ADR-0027 §8) — selection chỉ bao giờ resolves
-- trong tập credential của owning tenant.
-- DDL idempotent, không ledger, không down-migration (ADR-0025 §6, 02-delivery.md §3).
-- Forward-fix: stack đã provision trước slice này nhận bảng ở lần apply kế tiếp.

CREATE TABLE IF NOT EXISTS llm_marketplace.model_offers (
  id                  text NOT NULL PRIMARY KEY,
  seller_tenant_id    text NOT NULL,
  normalized_model_id text NOT NULL,
  status              text NOT NULL,
  public_alias        text UNIQUE,
  capabilities        jsonb NOT NULL,
  created_at          bigint NOT NULL,
  updated_at          bigint NOT NULL,
  activated_at        bigint,
  deactivated_at      bigint,
  retired_at          bigint,
  CONSTRAINT model_offers_status_check
    CHECK (status IN ('draft', 'active', 'inactive', 'retired'))
);

COMMENT ON TABLE llm_marketplace.model_offers IS
  'Model offer aggregate (llm-marketplace). seller_tenant_id names the owning Seller tenant in db-llm-gateway (cross-database by design; no foreign key across services). normalized_model_id is the canonical upstream model identity; the public model list exposes it as the model id. Activation requires a valid eligible verdict for the owning tenant and at least one healthy endpoint pool of this offer (domain guards); the lifecycle audit columns keep the last transition time per axis.';

COMMENT ON COLUMN llm_marketplace.model_offers.capabilities IS
  'JSON array of capability labels from the capability set operation; non-empty by domain guard.';

CREATE INDEX IF NOT EXISTS model_offers_serving_idx
  ON llm_marketplace.model_offers (seller_tenant_id, status);

CREATE TABLE IF NOT EXISTS llm_marketplace.endpoint_pools (
  id         text NOT NULL PRIMARY KEY,
  offer_id   text NOT NULL REFERENCES llm_marketplace.model_offers (id),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

COMMENT ON TABLE llm_marketplace.endpoint_pools IS
  'Endpoint pool of a model offer (llm-marketplace). A pool never exists outside an offer (offer_id is mandatory); pool health is a derived value over its endpoints, never a stored status.';

CREATE TABLE IF NOT EXISTS llm_marketplace.upstream_endpoints (
  id                  text NOT NULL PRIMARY KEY,
  pool_id             text NOT NULL REFERENCES llm_marketplace.endpoint_pools (id),
  url                 text NOT NULL,
  protocol            text NOT NULL,
  health              text NOT NULL DEFAULT 'degraded',
  weight              bigint NOT NULL,
  created_at          bigint NOT NULL,
  health_recorded_at  bigint,
  updated_at          bigint NOT NULL,
  CONSTRAINT upstream_endpoints_health_check
    CHECK (health IN ('healthy', 'degraded', 'down')),
  CONSTRAINT upstream_endpoints_weight_check CHECK (weight >= 1 AND weight <= 1000)
);

COMMENT ON TABLE llm_marketplace.upstream_endpoints IS
  'Upstream endpoint of a pool (llm-marketplace). health defaults to degraded: a freshly seeded endpoint never claims healthy without a real probe — the bootstrap smoke check is the only writer of healthy at seed time. weight is the bounded routing weight (1 to 1000). health_recorded_at is the time the current health value was recorded (null until the first health change).';

CREATE TABLE IF NOT EXISTS llm_marketplace.provider_credentials (
  id               text NOT NULL PRIMARY KEY,
  provider         text NOT NULL,
  seller_tenant_id text NOT NULL,
  credential_hash  text NOT NULL,
  created_by       text NOT NULL,
  created_at       bigint NOT NULL,
  revoked_at       bigint,
  revoked_by       text,
  CONSTRAINT provider_credentials_tenant_hash_unique
    UNIQUE (seller_tenant_id, credential_hash),
  CONSTRAINT provider_credentials_hash_bounded CHECK (length(credential_hash) <= 512)
);

COMMENT ON TABLE llm_marketplace.provider_credentials IS
  'Upstream provider credential of an owning Seller tenant (ADR-0027 section 8). Hash-only: credential_hash is the SHA-256 hex of the show-once plaintext key; plaintext is never persisted in any column of any database and is never logged. Two scope axes: provider names the upstream (provider key axis) and seller_tenant_id names the owning tenant (tenant axis); a credential is valid only when both match the serving context. There is deliberately no index or constraint on provider alone: no provider-only cross-tenant credential lookup path exists; credential selection always resolves within the owning tenant set. Natural key for rotation: (seller_tenant_id, credential_hash).';

COMMENT ON COLUMN llm_marketplace.provider_credentials.credential_hash IS
  'SHA-256 hex digest of the upstream key. Printable, whitespace-free, bounded at 512 characters (domain guard). Never the plaintext itself.';

CREATE INDEX IF NOT EXISTS provider_credentials_tenant_provider_idx
  ON llm_marketplace.provider_credentials (seller_tenant_id, provider);

CREATE TABLE IF NOT EXISTS llm_marketplace.bootstrap_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  runner      text NOT NULL,
  outcome     text NOT NULL,
  detail      jsonb NOT NULL,
  actor       text NOT NULL,
  occurred_at bigint NOT NULL,
  CONSTRAINT marketplace_bootstrap_audit_runner_check
    CHECK (runner IN ('seller-governance', 'marketplace')),
  CONSTRAINT marketplace_bootstrap_audit_outcome_check
    CHECK (outcome IN ('created', 'no-op', 'created-draft-unhealthy'))
);

COMMENT ON TABLE llm_marketplace.bootstrap_audit IS
  'Append-only audit of bootstrap/seed runs against db-llm-marketplace (ADR-0020 decisions 5-6). One row per successful run: outcome created, no-op, or created-draft-unhealthy (seeded but the upstream smoke probe failed so the offer stays draft), with natural keys and counts only — never credential values or hashes-attribution beyond key ids.';
