-- 0004_sponsor_funding.sql — bảng sponsor funding của schema `llm_financial`
-- trong slice P3 của Issue #24 (ADR-0028 §3–§6): seed giá trị khởi tạo cho
-- tenant consumer qua nguồn tài trợ nội bộ, B1–B4 của ADR-0028 §6.
--
-- Bảng (mỗi bảng khớp một record của `llm-financial-domain`, module `sponsor`):
-- - `sponsors`: chủ thể chịu trách nhiệm funding nội bộ (B1). Natural key =
--   `sponsor_id`; `ceiling` là input cấu hình bắt buộc (số nguyên ≥ 0, minor
--   units) — không có sponsor vô trần (ADR-0028 §5: trần chỉ đổi qua operation
--   có kiểm, không qua bootstrap).
-- - `billing_accounts`: billing account chính của tenant consumer (B2).
--   Natural key = `tenant_ref`; `tenant_ref` là tham chiếu opaque tới
--   `llm_tenant.tenants.id` ở `db-llm-tenant` — KHÔNG FK xuyên database
--   (ADR-0020 Quyết định 4), integrity do runner + natural key bảo đảm.
-- - `sponsor_funding_authorizations`: ủy quyền funding sponsor → billing
--   account (B3). Natural key = `(sponsor_id, billing_account_id)`;
--   `ceiling` nullable — NULL là explicit "không trần per-account" (ADR-0028
--   §6 B3), không phải thiếu cấu hình; `evidence_ref` trỏ ra quyết định ngân
--   sách authoritative ngoài database sản phẩm, bắt buộc.
-- - `sponsor_grants`: bút toán cấp UC từ nguồn tài trợ (B4), lifecycle
--   `pending → credited → reversed`. `sponsor_id`/`billing_account_id` là
--   provenance bất biến suy từ authorization tại thời điểm register.
-- - `bootstrap_audit`: audit append-only một row mỗi transaction thành công
--   của runner bước 10 trên database này (ADR-0020).
--
-- ⚠️ Phạm vi slice: bốn bảng aggregate + audit. Các bảng projection
-- ledger/wallet (ledger entries, wallet balances) thuộc slice serving kế tiếp
-- — bút toán `sponsor_funding_clearing → wallet_available` của B4 thực thi
-- in-memory qua `creditGrant` với transaction id tất định
-- `sponsor_grant:<grant_id>:credit`; net credited của sponsor/authorization
-- tái dựng được từ trạng thái `sponsor_grants.state` (Σ `credited`), nên trần
-- (§5) kiểm đúng trên state bền này.
--
-- Mọi FK nằm trong cùng schema `llm_financial` (cùng database, cùng service —
-- được phép); không có FK nào ra ngoài database. DDL idempotent, không ledger,
-- không down-migration (ADR-0025 §6, 02-delivery.md §3).

-- ---------------------------------------------------------------------------
-- B1 — sponsors
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS llm_financial.sponsors (
  sponsor_id           text NOT NULL PRIMARY KEY,
  owner_ref            text NOT NULL,
  ceiling_minor        bigint NOT NULL,
  ceiling_denomination text NOT NULL,
  status               text NOT NULL,
  created_at           bigint NOT NULL,
  created_by           text NOT NULL,
  CONSTRAINT sponsors_ceiling_non_negative_check CHECK (ceiling_minor >= 0),
  CONSTRAINT sponsors_denomination_check CHECK (ceiling_denomination IN ('UC', 'EC')),
  CONSTRAINT sponsors_status_check CHECK (status IN ('active', 'suspended'))
);

COMMENT ON TABLE llm_financial.sponsors IS
  'Sponsor - internal party that accepts financial responsibility for funding consumer tenant resources (ADR-0028 section 3.1). Not a tenant, not a sub, not a seller tenant, not a legal principal. ceiling is a mandatory configuration input in minor units (no uncapped sponsor exists; ceilings change only through controlled operations later, never through bootstrap). status suspended blocks new grants without touching already granted balances. Seeded by the step-10 bootstrap runner of Issue #24.';

COMMENT ON COLUMN llm_financial.sponsors.owner_ref IS
  'Opaque sub reference kept for provenance/audit only. It implies no permission, ownership or classification anywhere else.';

COMMENT ON COLUMN llm_financial.sponsors.ceiling_minor IS
  'Cumulative funding ceiling in minor units (integer >= 0) within ceiling_denomination. creditGrant measures the currently credited grant sum against it (ADR-0028 section 5.1); a breach fails closed with sponsor_ceiling_exceeded and the grant stays pending.';

COMMENT ON COLUMN llm_financial.sponsors.ceiling_denomination IS
  'Denomination domain of the ceiling (UC or EC). Grants of a different denomination can never be credited against this sponsor (checked before wallet resolution).';

-- ---------------------------------------------------------------------------
-- B2 — billing_accounts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS llm_financial.billing_accounts (
  billing_account_id text NOT NULL PRIMARY KEY,
  tenant_ref         text NOT NULL,
  owner_ref          text NOT NULL,
  created_at         bigint NOT NULL,
  CONSTRAINT billing_accounts_tenant_ref_unique UNIQUE (tenant_ref)
);

COMMENT ON TABLE llm_financial.billing_accounts IS
  'Billing account of one consumer tenant inside the llm-financial domain (ADR-0028 section 6 B2). Natural key: tenant_ref. Wallet projection of this account belongs to the serving slice - the bootstrap runner seeds the account row only. tenant_ref is an opaque reference to llm_tenant.tenants.id in db-llm-tenant: deliberately no foreign key across services (ADR-0020 decision 4).';

COMMENT ON COLUMN llm_financial.billing_accounts.tenant_ref IS
  'Opaque id of the owning consumer tenant in db-llm-tenant (llm_tenant.tenants.id), consumed from the step-9 bootstrap result. Cross-database by design; no foreign key across services.';

COMMENT ON COLUMN llm_financial.billing_accounts.owner_ref IS
  'Opaque owner reference of the account (the bootstrap superadmin sub). Provenance/audit only.';

-- ---------------------------------------------------------------------------
-- B3 — sponsor_funding_authorizations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS llm_financial.sponsor_funding_authorizations (
  authorization_id     text NOT NULL PRIMARY KEY,
  sponsor_id           text NOT NULL,
  billing_account_id   text NOT NULL,
  ceiling_minor        bigint,
  ceiling_denomination text,
  status               text NOT NULL,
  evidence_ref         text NOT NULL,
  created_at           bigint NOT NULL,
  created_by           text NOT NULL,
  CONSTRAINT sponsor_funding_authorizations_pair_unique UNIQUE (sponsor_id, billing_account_id),
  CONSTRAINT sponsor_funding_authorizations_ceiling_pair_check
    CHECK ((ceiling_minor IS NULL) = (ceiling_denomination IS NULL)),
  CONSTRAINT sponsor_funding_authorizations_ceiling_non_negative_check
    CHECK (ceiling_minor IS NULL OR ceiling_minor >= 0),
  CONSTRAINT sponsor_funding_authorizations_denomination_check
    CHECK (ceiling_denomination IS NULL OR ceiling_denomination IN ('UC', 'EC')),
  CONSTRAINT sponsor_funding_authorizations_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT sponsor_funding_authorizations_sponsor_fk
    FOREIGN KEY (sponsor_id) REFERENCES llm_financial.sponsors (sponsor_id),
  CONSTRAINT sponsor_funding_authorizations_billing_account_fk
    FOREIGN KEY (billing_account_id) REFERENCES llm_financial.billing_accounts (billing_account_id)
);

COMMENT ON TABLE llm_financial.sponsor_funding_authorizations IS
  'Funding authorization binding one sponsor to one billing account (ADR-0028 section 3.2). Natural key: (sponsor_id, billing_account_id). ceiling nullable: NULL means explicitly no per-account cap (a deliberate configuration, not missing configuration); when present it bounds the concentration per beneficiary (ADR-0028 section 5.2). evidence_ref points to the authoritative out-of-product budget decision and is mandatory - an authorization without evidence does not exist. status revoked blocks new grants without touching already credited balances.';

COMMENT ON COLUMN llm_financial.sponsor_funding_authorizations.evidence_ref IS
  'Opaque reference to the authoritative budget decision outside the product database. Bootstrap refuses to seed an authorization without it; the referenced decision is not stored here.';

-- ---------------------------------------------------------------------------
-- B4 — sponsor_grants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS llm_financial.sponsor_grants (
  grant_id            text NOT NULL PRIMARY KEY,
  authorization_id    text NOT NULL,
  sponsor_id          text NOT NULL,
  billing_account_id  text NOT NULL,
  amount_minor        bigint NOT NULL,
  amount_denomination text NOT NULL,
  state               text NOT NULL,
  actor_ref           text NOT NULL,
  created_at          bigint NOT NULL,
  CONSTRAINT sponsor_grants_amount_positive_check CHECK (amount_minor > 0),
  CONSTRAINT sponsor_grants_denomination_check CHECK (amount_denomination IN ('UC', 'EC')),
  CONSTRAINT sponsor_grants_state_check CHECK (state IN ('pending', 'credited', 'reversed')),
  CONSTRAINT sponsor_grants_authorization_fk
    FOREIGN KEY (authorization_id)
    REFERENCES llm_financial.sponsor_funding_authorizations (authorization_id),
  CONSTRAINT sponsor_grants_sponsor_fk
    FOREIGN KEY (sponsor_id) REFERENCES llm_financial.sponsors (sponsor_id),
  CONSTRAINT sponsor_grants_billing_account_fk
    FOREIGN KEY (billing_account_id) REFERENCES llm_financial.billing_accounts (billing_account_id)
);

COMMENT ON TABLE llm_financial.sponsor_grants IS
  'Sponsor grant - a UC amount granted from the internal sponsorship source (ADR-0028 section 4). Lifecycle pending -> credited -> reversed is terminal-symmetric with deposits: pending is not wallet money, credit posts sponsor_funding_clearing -> wallet_available (transaction id sponsor_grant:<grant_id>:credit, deterministic), reversal is full-only, once, from available. sponsor_id and billing_account_id are immutable provenance derived from the authorization at register time. The currently credited grant sum per sponsor/authorization reconstructs both spending ceilings (ADR-0028 section 5).';

COMMENT ON COLUMN llm_financial.sponsor_grants.state IS
  'pending (registered, no posting), credited (wallet credited; ceiling sums include it), reversed (clawed back in full; the reversal cancels its own credit, so net contribution is zero). reversed is terminal; a credited grant only reverses while available covers the full amount.';

CREATE INDEX IF NOT EXISTS sponsor_grants_sponsor_idx
  ON llm_financial.sponsor_grants (sponsor_id);

CREATE INDEX IF NOT EXISTS sponsor_grants_authorization_idx
  ON llm_financial.sponsor_grants (authorization_id);

COMMENT ON INDEX llm_financial.sponsor_grants_sponsor_idx IS
  'Sponsor-scoped net-credited computation (ADR-0028 section 5.1) and per-sponsor grant listing.';

COMMENT ON INDEX llm_financial.sponsor_grants_authorization_idx IS
  'Authorization-scoped net-credited computation (ADR-0028 section 5.2) and bootstrap divergence checks.';

-- ---------------------------------------------------------------------------
-- Bootstrap audit (runner bước 10)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS llm_financial.bootstrap_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  runner      text NOT NULL,
  outcome     text NOT NULL,
  detail      jsonb NOT NULL,
  actor       text NOT NULL,
  occurred_at bigint NOT NULL,
  CONSTRAINT financial_bootstrap_audit_runner_check CHECK (runner IN ('financial')),
  CONSTRAINT financial_bootstrap_audit_outcome_check
    CHECK (outcome IN ('created', 'no-op'))
);

COMMENT ON TABLE llm_financial.bootstrap_audit IS
  'Append-only audit of bootstrap/seed runs against the llm_financial schema (ADR-0020). One row per committed transaction of the step-10 runner: outcome created or no-op, with natural keys and per-step outcomes only - never amounts beyond grant ids and never credential-like values.';
