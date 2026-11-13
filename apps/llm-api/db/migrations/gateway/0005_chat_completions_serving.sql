-- 0005_chat_completions_serving.sql — bảng serving của slice P4 trong Issue #24
-- (POST /v1/chat/completions): quota operational, journal thực thi, projection
-- tài chính (wallet/ledger) và pricing snapshot, theo ADR-0028 §5 (financial
-- admission) và 01-architecture §11 (chuỗi admission).
--
-- Bảng `llm_seller` (pricing — DECISION của slice P4):
-- - `pricing_snapshots`: snapshot giá versioned theo model (nguồn giá serving;
--   OB-7/OB-8 KHÔNG đổi — snapshot này là trạng thái serving, không phải hợp
--   đồng pricing schedule của provider). Một snapshot `active` duy nhất mỗi
--   model (partial unique index). Seed tất định cho offer Dronie do chính
--   migration này thực hiện (ON CONFLICT DO NOTHING — idempotent, không cần
--   thay đổi runner); giá là MVP serving prices của đường nội bộ
--   sponsor-funded, không phải giá comercial.
--
-- Bảng `llm_gateway` (quota + journal — ownership "API key, quota, usage,
-- reservation, settlement → llm-api"):
-- - `tenant_quota`: trần token operational lũy kế của một consumer tenant
--   (mức vận hành MVP; policy quota qua control plane là pha sau).
-- - `quota_reservations`: giữ chỗ token tất định từ `request_id` — identity
--   thứ nhất trong cặp hai identity độc lập của admission (01-architecture
--   §11; ADR-0028 §5). Một logical request đúng một reservation.
-- - `logical_requests`: journal mức request — metadata thực thi và usage
--   cuối cùng. KHÔNG BAO GIỜ có prompt/response body (bất biến platform).
-- - `attempts`: journal mức attempt — provenance routing (offer, seller
--   tenant, pricing snapshot, upstream model/endpoint), số tiền giữ, hai
--   reservation id, evidence; persist TRƯỚC dispatch (01-architecture §11).
--
-- Bảng `llm_financial` (projection mà `0004` để lại cho slice serving):
-- - `wallets` + `ledger_transactions` + `ledger_entries`: state bền của
--   FinancialBook — bút toán do `llm-financial-domain` post (transaction id và
--   idempotency key tất định), balance là projection của ledger.
-- - `financial_reservations`: giữ tiền admission (available → held), identity
--   thứ hai của cặp hai identity — suy từ `(request_id, attempt_id)`, KHÔNG
--   bao giờ trùng identity quota.
-- - `customer_charges`: charge khách hàng sau settlement (ADR-0028 §4).
--
-- Mọi FK nằm trong cùng schema hoặc cùng database (cùng service sở hữu —
-- được phép); không có FK nào ra ngoài database. DDL idempotent, không ledger,
-- không down-migration (ADR-0025 §6, 02-delivery.md §3). Forward-fix: apply
-- trên stack hiện có tạo các bảng này ở lần apply kế tiếp.

-- ---------------------------------------------------------------------------
-- llm_seller.pricing_snapshots — nguồn giá serving (DECISION slice P4)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS llm_seller.pricing_snapshots (
  snapshot_id                    text NOT NULL PRIMARY KEY,
  model                          text NOT NULL,
  currency                       text NOT NULL,
  input_rate_per_1m_tokens_minor  bigint NOT NULL,
  output_rate_per_1m_tokens_minor bigint NOT NULL,
  max_input_tokens_per_request    bigint NOT NULL,
  max_output_tokens_per_request   bigint NOT NULL,
  status                          text NOT NULL,
  created_at                      bigint NOT NULL,
  created_by                      text NOT NULL,
  CONSTRAINT pricing_snapshots_currency_check CHECK (currency IN ('VND')),
  CONSTRAINT pricing_snapshots_rates_non_negative_check
    CHECK (input_rate_per_1m_tokens_minor >= 0 AND output_rate_per_1m_tokens_minor >= 0),
  CONSTRAINT pricing_snapshots_bounds_positive_check
    CHECK (max_input_tokens_per_request > 0 AND max_output_tokens_per_request > 0),
  CONSTRAINT pricing_snapshots_status_check CHECK (status IN ('active', 'retired'))
);

COMMENT ON TABLE llm_seller.pricing_snapshots IS
  'Versioned per-model serving price snapshot (P4 of Issue #24). The admission path resolves the active snapshot for the resolved model and fails closed when none exists or when the schedule is not expressible in VND (ADR-0028 section 13.4). Rates are minor units per 1,000,000 tokens; per-request bounds cap the token estimate before pricing. Exactly one active snapshot per model is enforced by a partial unique index; retirement is explicit (status retired), never an overwrite. Not a provider pricing-schedule contract (OB-7/OB-8 untouched): this is serving state of the sponsor-funded internal path.';

COMMENT ON COLUMN llm_seller.pricing_snapshots.model IS
  'Normalized model id the snapshot prices (opaque reference to llm_marketplace.model_offers.normalized_model_id; deliberately no cross-schema foreign key).';

COMMENT ON COLUMN llm_seller.pricing_snapshots.currency IS
  'Currency domain of both rates. Only VND is expressible in MVP (ADR-0028 section 13.4): admission fails closed on any other value. Minor units of VND are the single monetary scale of the UC ledger (ADR-0004), so snapshot rates and wallet money share one scale.';

CREATE UNIQUE INDEX IF NOT EXISTS pricing_snapshots_one_active_per_model
  ON llm_seller.pricing_snapshots (model) WHERE status = 'active';

COMMENT ON INDEX llm_seller.pricing_snapshots_one_active_per_model IS
  'At most one active snapshot per model: resolution by model is total, never ambiguous.';

-- Seed tất định của snapshot giá cho offer Dronie. ON CONFLICT DO NOTHING:
-- apply lại không đè cấu hình giá đã thiết lập — đổi giá là operation có kiểm
-- (snapshot mới + retire cũ), không phải side-effect của migration.
INSERT INTO llm_seller.pricing_snapshots
  (snapshot_id, model, currency,
   input_rate_per_1m_tokens_minor, output_rate_per_1m_tokens_minor,
   max_input_tokens_per_request, max_output_tokens_per_request,
   status, created_at, created_by)
VALUES
  ('pricing-snapshot-dronie-flash-v1', 'dronie-flash', 'VND',
   5000, 15000, 8192, 4096, 'active', 1760000000000, 'migration:0005')
ON CONFLICT (snapshot_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- llm_gateway — quota operational
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS llm_gateway.tenant_quota (
  tenant_id    text NOT NULL PRIMARY KEY,
  token_ceiling bigint NOT NULL,
  created_at   bigint NOT NULL,
  created_by   text NOT NULL,
  CONSTRAINT tenant_quota_ceiling_positive_check CHECK (token_ceiling > 0)
);

COMMENT ON TABLE llm_gateway.tenant_quota IS
  'Cumulative operational token ceiling of one consumer tenant (llm-api ownership). The ceiling bounds settled plus actively-reserved estimate tokens; the row is created lazily by the serving path with the code-level MVP default (policy management through the control plane is future work). No node-local quota state exists anywhere: the database row is the only quota authority (invariant 2).';

COMMENT ON COLUMN llm_gateway.tenant_quota.token_ceiling IS
  'Upper bound on settled_tokens plus the sum of active reservation estimates, in tokens, cumulative over the tenant lifetime. Admission fails closed with insufficient_quota when the reservation would breach it.';

CREATE TABLE IF NOT EXISTS llm_gateway.quota_reservations (
  reservation_id text NOT NULL PRIMARY KEY,
  request_id     text NOT NULL,
  tenant_id      text NOT NULL,
  token_amount   bigint NOT NULL,
  settled_tokens bigint,
  state          text NOT NULL,
  created_at     bigint NOT NULL,
  settled_at     bigint,
  released_at    bigint,
  CONSTRAINT quota_reservations_request_unique UNIQUE (request_id),
  CONSTRAINT quota_reservations_amount_positive_check CHECK (token_amount > 0),
  CONSTRAINT quota_reservations_settled_non_negative_check
    CHECK (settled_tokens IS NULL OR settled_tokens >= 0),
  CONSTRAINT quota_reservations_state_check CHECK (state IN ('active', 'settled', 'released')),
  CONSTRAINT quota_reservations_window_check CHECK (
    (state = 'active'
      AND settled_tokens IS NULL AND settled_at IS NULL AND released_at IS NULL)
    OR
    (state = 'settled'
      AND settled_tokens IS NOT NULL AND settled_at IS NOT NULL AND released_at IS NULL)
    OR
    (state = 'released'
      AND settled_tokens IS NULL AND settled_at IS NULL AND released_at IS NOT NULL)
  )
);

COMMENT ON TABLE llm_gateway.quota_reservations IS
  'Durable token reservation of one logical request - the first identity of the two independent admission identities (01-architecture section 11, ADR-0028 section 5): reservation_id is derived from request_id, never from the financial identity. request_id is unique so a replayed request finds its original reservation instead of opening a second one. active -> settled (actual usage, capped by the estimate when usage is unknown) or active -> released (financial rejection or confirmed non-execution); both transitions are idempotent compensations, never timeout-driven.';

COMMENT ON COLUMN llm_gateway.quota_reservations.token_amount IS
  'Token estimate held at admission: input bound (character estimate) plus output bound (client max_tokens), each capped by the pricing snapshot per-request bounds.';

COMMENT ON COLUMN llm_gateway.quota_reservations.settled_tokens IS
  'Token count the reservation settled to. When usage is unknown the estimate (token_amount) is settled conservatively - the database stays the quota authority without trusting a missing usage payload.';

CREATE INDEX IF NOT EXISTS quota_reservations_tenant_state_idx
  ON llm_gateway.quota_reservations (tenant_id, state);

COMMENT ON INDEX llm_gateway.quota_reservations_tenant_state_idx IS
  'Ceiling computation of the admission path: settled plus active reservation sum per tenant.';

-- ---------------------------------------------------------------------------
-- llm_gateway — execution journal (metadata only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS llm_gateway.logical_requests (
  request_id          text NOT NULL PRIMARY KEY,
  tenant_id           text NOT NULL,
  api_key_id          text NOT NULL,
  payload_hash        text NOT NULL,
  requested_model     text NOT NULL,
  resolved_model      text NOT NULL,
  offer_id            text NOT NULL,
  pricing_snapshot_id text NOT NULL,
  status              text NOT NULL,
  evidence            text,
  usage_status        text,
  input_tokens        bigint,
  output_tokens       bigint,
  charge_minor        bigint,
  error_code          text,
  created_at          bigint NOT NULL,
  completed_at        bigint,
  CONSTRAINT logical_requests_payload_hash_bounded CHECK (length(payload_hash) <= 128),
  CONSTRAINT logical_requests_status_check CHECK (status IN ('admitted', 'completed', 'failed')),
  CONSTRAINT logical_requests_evidence_check
    CHECK (evidence IS NULL OR evidence IN
      ('not_sent', 'may_have_executed', 'confirmed_completed', 'confirmed_not_executed')),
  CONSTRAINT logical_requests_usage_status_check
    CHECK (usage_status IS NULL OR usage_status IN ('known', 'missing', 'malformed', 'partial')),
  CONSTRAINT logical_requests_tokens_non_negative_check
    CHECK ((input_tokens IS NULL OR input_tokens >= 0)
      AND (output_tokens IS NULL OR output_tokens >= 0)),
  CONSTRAINT logical_requests_charge_non_negative_check
    CHECK (charge_minor IS NULL OR charge_minor >= 0),
  CONSTRAINT logical_requests_terminal_window_check CHECK (
    (status = 'admitted'
      AND evidence IS NULL AND usage_status IS NULL
      AND input_tokens IS NULL AND output_tokens IS NULL
      AND charge_minor IS NULL AND error_code IS NULL AND completed_at IS NULL)
    OR (
      status IN ('completed', 'failed')
      AND evidence IS NOT NULL AND usage_status IS NOT NULL AND completed_at IS NOT NULL
      AND (status = 'completed') = (error_code IS NULL)
    )
  )
);

COMMENT ON TABLE llm_gateway.logical_requests IS
  'Execution journal at the logical-request level (01-architecture section 13): identity, routing provenance, final evidence, usage and settled charge. Metadata only - prompt and response bodies are never stored here or anywhere (platform invariant); the payload_hash exists solely to distinguish a replayed request_id from an idempotency conflict, never to reconstruct content. The row is persisted at admission time together with its first attempt. Usage columns are the request-level usage record, idempotent by request_id (01-architecture section 14).';

COMMENT ON COLUMN llm_gateway.logical_requests.payload_hash IS
  'SHA-256 hex of the canonical request payload. Same request_id with the same hash is a replay (stable rejection, no new reservation); a different hash is an idempotency conflict.';

CREATE TABLE IF NOT EXISTS llm_gateway.attempts (
  attempt_id              text NOT NULL PRIMARY KEY,
  request_id              text NOT NULL REFERENCES llm_gateway.logical_requests (request_id),
  attempt_no              bigint NOT NULL,
  offer_ref               text NOT NULL,
  seller_tenant_ref       text NOT NULL,
  pricing_snapshot_ref    text NOT NULL,
  upstream_model          text NOT NULL,
  upstream_endpoint_url   text NOT NULL,
  admission_mode          text NOT NULL,
  quota_reservation_id    text NOT NULL,
  financial_reservation_id text NOT NULL,
  settlement_id           text NOT NULL,
  charge_id               text NOT NULL,
  amount_minor            bigint NOT NULL,
  evidence                text NOT NULL,
  usage_status            text,
  input_tokens            bigint,
  output_tokens           bigint,
  started_at              bigint NOT NULL,
  ended_at                bigint,
  CONSTRAINT attempts_attempt_no_positive_check CHECK (attempt_no >= 1),
  CONSTRAINT attempts_request_attempt_unique UNIQUE (request_id, attempt_no),
  CONSTRAINT attempts_amount_non_negative_check CHECK (amount_minor >= 0),
  CONSTRAINT attempts_admission_mode_check CHECK (admission_mode IN ('lease-local', 'durable-reserve')),
  CONSTRAINT attempts_evidence_check CHECK (evidence IN
    ('not_sent', 'may_have_executed', 'confirmed_completed', 'confirmed_not_executed')),
  CONSTRAINT attempts_usage_status_check
    CHECK (usage_status IS NULL OR usage_status IN ('known', 'missing', 'malformed', 'partial')),
  CONSTRAINT attempts_tokens_non_negative_check
    CHECK ((input_tokens IS NULL OR input_tokens >= 0)
      AND (output_tokens IS NULL OR output_tokens >= 0)),
  CONSTRAINT attempts_evidence_window_check CHECK (
    (evidence = 'not_sent' AND ended_at IS NULL
      AND usage_status IS NULL AND input_tokens IS NULL AND output_tokens IS NULL)
    OR (evidence <> 'not_sent' AND ended_at IS NOT NULL)
  )
);

COMMENT ON TABLE llm_gateway.attempts IS
  'Execution journal at the attempt level - per-attempt routing provenance and financial admission facts (01-architecture section 13). The row is persisted with evidence not_sent BEFORE upstream dispatch; that pre-dispatch write is the only durable decisioning exception of the serving path. evidence only strengthens (llm-inference-domain canTransitionEvidence); it never moves backwards. settlement_id and charge_id are derived deterministically from (request_id, attempt_id) so settlement is idempotent without any lookup protocol.';

COMMENT ON COLUMN llm_gateway.attempts.upstream_model IS
  'Raw upstream model identity sent to the provider - the offer identity as the upstream knows it, not the public alias (01-architecture section 11).';

COMMENT ON COLUMN llm_gateway.attempts.amount_minor IS
  'Financial admission upper bound held for this attempt, UC minor units (ADR-0028 section 5): capture is capped by this amount, never above it.';

CREATE INDEX IF NOT EXISTS attempts_request_idx
  ON llm_gateway.attempts (request_id);

COMMENT ON INDEX llm_gateway.attempts_request_idx IS
  'Attempt listing per logical request (fallback re-admission reads it; MVP has a single attempt per request).';

-- ---------------------------------------------------------------------------
-- llm_financial — projection wallet/ledger (0004 đã để lại cho slice serving)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS llm_financial.wallets (
  wallet_id         text NOT NULL PRIMARY KEY,
  billing_account_id text NOT NULL REFERENCES llm_financial.billing_accounts (billing_account_id),
  denomination      text NOT NULL,
  fencing_token     text NOT NULL,
  created_at        bigint NOT NULL,
  created_by        text NOT NULL,
  CONSTRAINT wallets_denomination_check CHECK (denomination IN ('UC', 'EC')),
  CONSTRAINT wallets_account_denomination_unique UNIQUE (billing_account_id, denomination)
);

COMMENT ON TABLE llm_financial.wallets IS
  'Durable wallet projection of the in-memory wallet the step-10 bootstrap ran creditGrant on (0004 deferred this table to the serving slice). One wallet per (billing account, denomination). The fencing token written at creation is the token every money-moving operation must present; a stale token fails closed with stale_fencing_token instead of trusting temporal order (invariant 6 of ADR-0028 section 10).';

CREATE TABLE IF NOT EXISTS llm_financial.ledger_transactions (
  transaction_id  text NOT NULL PRIMARY KEY,
  idempotency_key text NOT NULL,
  wallet_id       text NOT NULL REFERENCES llm_financial.wallets (wallet_id),
  billing_account_id text NOT NULL REFERENCES llm_financial.billing_accounts (billing_account_id),
  denomination    text NOT NULL,
  reference       text NOT NULL,
  fingerprint     text NOT NULL,
  fencing_token   text NOT NULL,
  created_at      bigint NOT NULL,
  posting_seq     bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT ledger_transactions_denomination_check CHECK (denomination IN ('UC', 'EC')),
  CONSTRAINT ledger_transactions_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT ledger_transactions_reference_bounded CHECK (length(reference) <= 512),
  CONSTRAINT ledger_transactions_fingerprint_bounded CHECK (length(fingerprint) <= 256)
);

COMMENT ON COLUMN llm_financial.ledger_transactions.posting_seq IS
  'Database-assigned append order of the transaction within this table. created_at is millisecond resolution, so two postings in the same millisecond carry equal created_at; wallet balances re-derived from the ledger must replay postings in true append order or a per-account running total can transiently dip negative and fail conservation on a healthy ledger. Writers never insert this column; the database owns it.';

COMMENT ON TABLE llm_financial.ledger_transactions IS
  'Durable ledger transactions of the financial domain - the append-only source the wallet balances are a projection of (ADR-0028 section 3). transaction_id and idempotency_key are deterministic (llm-financial-domain derivedTransactionId/derivedIdempotencyKey), so replaying the same operation reproduces the same row instead of a second posting. fingerprint carries the content hash the domain uses to distinguish a replay from a conflicting replay; reference is the serialized {type,id} pair naming the entity that produced the posting. posting_seq encodes the append order the balances re-derivation replays in.';

CREATE TABLE IF NOT EXISTS llm_financial.ledger_entries (
  entry_id       text NOT NULL PRIMARY KEY,
  transaction_id text NOT NULL REFERENCES llm_financial.ledger_transactions (transaction_id),
  wallet_id      text NOT NULL REFERENCES llm_financial.wallets (wallet_id),
  account        text NOT NULL,
  direction      text NOT NULL,
  amount_minor   bigint NOT NULL,
  CONSTRAINT ledger_entries_account_check CHECK (account IN
    ('wallet_available', 'wallet_held', 'wallet_charged', 'funding_clearing',
     'earnings_clearing', 'conversion_clearing', 'sponsor_funding_clearing')),
  CONSTRAINT ledger_entries_direction_check CHECK (direction IN ('debit', 'credit')),
  CONSTRAINT ledger_entries_amount_non_negative_check CHECK (amount_minor >= 0)
);

COMMENT ON TABLE llm_financial.ledger_entries IS
  'Legs of a ledger transaction (entry id = "<transaction_id>#<index>", deterministic). Conservation per transaction (debits equal credits) and per wallet (available + held + charged = total) are properties of this table, re-derived on every load - never stored as free balances.';

CREATE INDEX IF NOT EXISTS ledger_entries_wallet_idx
  ON llm_financial.ledger_entries (wallet_id);

COMMENT ON INDEX llm_financial.ledger_entries_wallet_idx IS
  'Wallet-scoped ledger hydration of the serving path (balance derivation reads only this wallet legs).';

CREATE TABLE IF NOT EXISTS llm_financial.financial_reservations (
  reservation_id    text NOT NULL PRIMARY KEY,
  wallet_id         text NOT NULL REFERENCES llm_financial.wallets (wallet_id),
  billing_account_id text NOT NULL REFERENCES llm_financial.billing_accounts (billing_account_id),
  denomination      text NOT NULL,
  reserved_minor    bigint NOT NULL,
  captured_minor    bigint NOT NULL DEFAULT 0,
  released_minor    bigint NOT NULL DEFAULT 0,
  state             text NOT NULL,
  fencing_token     text NOT NULL,
  created_at        bigint NOT NULL,
  finalized_at      bigint,
  CONSTRAINT financial_reservations_denomination_check CHECK (denomination IN ('UC', 'EC')),
  CONSTRAINT financial_reservations_amounts_non_negative_check
    CHECK (reserved_minor >= 0 AND captured_minor >= 0 AND released_minor >= 0),
  CONSTRAINT financial_reservations_state_check
    CHECK (state IN ('reserved', 'captured', 'released', 'expired')),
  CONSTRAINT financial_reservations_window_check CHECK (
    (state = 'reserved' AND captured_minor = 0 AND released_minor = 0 AND finalized_at IS NULL)
    OR (
      state IN ('captured', 'released', 'expired')
      AND finalized_at IS NOT NULL
      AND (state = 'captured') = (captured_minor > 0)
      AND (state = 'released') = (released_minor > 0)
    )
  )
);

COMMENT ON TABLE llm_financial.financial_reservations IS
  'Financial admission hold of one attempt - the second identity of the two independent admission identities (ADR-0028 section 5): reservation_id is derived from (request_id, attempt_id) and never collides with the quota identity derived from request_id alone. reserved moves available -> held; capture moves min(charge, reserved) held -> charged; release returns the remainder held -> available. Cross-request settle or release is impossible: every operation names its own reservation id (invariant F7).';

CREATE TABLE IF NOT EXISTS llm_financial.customer_charges (
  charge_id      text NOT NULL PRIMARY KEY,
  settlement_id  text NOT NULL,
  reservation_id text NOT NULL,
  wallet_id      text NOT NULL REFERENCES llm_financial.wallets (wallet_id),
  billing_account_id text NOT NULL REFERENCES llm_financial.billing_accounts (billing_account_id),
  denomination   text NOT NULL,
  amount_minor   bigint NOT NULL,
  refunded_minor bigint NOT NULL DEFAULT 0,
  increase_minor bigint NOT NULL DEFAULT 0,
  decrease_minor bigint NOT NULL DEFAULT 0,
  state          text NOT NULL,
  created_at     bigint NOT NULL,
  posted_at      bigint,
  CONSTRAINT customer_charges_denomination_check CHECK (denomination IN ('UC', 'EC')),
  CONSTRAINT customer_charges_settlement_unique UNIQUE (settlement_id),
  CONSTRAINT customer_charges_amount_non_negative_check
    CHECK (amount_minor >= 0 AND refunded_minor >= 0
      AND increase_minor >= 0 AND decrease_minor >= 0),
  CONSTRAINT customer_charges_state_check
    CHECK (state IN ('pending', 'posted', 'refunded', 'adjusted')),
  CONSTRAINT customer_charges_window_check CHECK (
    (state = 'pending' AND posted_at IS NULL) OR (state <> 'pending' AND posted_at IS NOT NULL)
  )
);

COMMENT ON TABLE llm_financial.customer_charges IS
  'Customer charge produced by settlement (ADR-0028 section 4): the customer price actually charged, capped by the admission hold. One charge per settlement (unique settlement_id) makes settle idempotent at the storage layer as well as in the domain. Amount is append-only in the domain; refund and adjustment are future records, never in-place edits. First-party serving (the Dronie offer) settles with no seller share, so no payable accrues from these charges.';
