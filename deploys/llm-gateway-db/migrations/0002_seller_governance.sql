-- 0002_seller_governance.sql — bảng nghiệp vụ `llm_seller` của `db-llm-gateway` trong slice bootstrap/seed của Issue #23.
--
-- Bảng theo aggregate/invariant của hai bounded context mà db-llm-gateway lưu bền vững:
-- - llm-seller-tenant (ADR-0002, ADR-0025 §3, ADR-0027 §2): `seller_tenants`,
--   `seller_memberships`. Tenant **không có cột lifecycle/status** — tồn tại,
--   eligibility, verification và restriction là bốn trục độc lập; ba trục sau
--   là giá trị suy ra, không bao giờ được lưu thành status (ADR-0002).
-- - llm-seller-governance (ADR-0026 §4, ADR-0027 §3–§5, domain-model §3.1–§3.8):
--   `legal_principals`, `principal_legal_profiles`, `principal_tax_profiles`,
--   `principal_evidence`, `verification_cases`, `verification_submissions`,
--   `restriction_records`, `principal_associations`.
-- Natural key: tenant = `name` (định danh công khai, unique + immutable,
-- ADR-0027 §2); principal = `principal_id` (hằng số cấu hình trong code,
-- ADR-0020 Quyết định 12); case = `id`; evidence = `id`.
-- Owner là fact trên tenant (cột `owner_sub`), không phải membership role
-- (ADR-0025 §3). Classification là fact provisioning (`first_party`/`customer`),
-- không phải exemption: mọi seller vẫn chịu verification + restriction như nhau.
-- Re-run bootstrap là no-op theo natural key; seed lại sau xoá bị chặn bằng
-- kiểm tra divergence fail-closed ở runner (không có trạng thái resurrect —
-- không có cột status để "sống lại", ADR-0020 Quyết định 6).
-- Credential KHÔNG nằm ở DB này: upstream provider key chỉ xuất hiện ở
-- `db-llm-marketplace` dưới dạng hash (Issue #23, ADR-0027 §8).
-- DDL idempotent, không ledger, không down-migration (ADR-0025 §6, 02-delivery.md §3).
-- Forward-fix: stack đã provision trước slice này nhận bảng ở lần apply kế tiếp.

CREATE TABLE IF NOT EXISTS llm_seller.seller_tenants (
  id             text NOT NULL PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  classification text NOT NULL,
  owner_sub      text NOT NULL,
  created_at     bigint NOT NULL,
  CONSTRAINT seller_tenants_classification_check
    CHECK (classification IN ('first_party', 'customer'))
);

COMMENT ON TABLE llm_seller.seller_tenants IS
  'Seller tenant aggregate (llm-seller-tenant). Natural key: name (public provider identity, unique and immutable, ADR-0027 section 2). No lifecycle status column exists by design (ADR-0002): existence, operational eligibility, verification and restriction are independent axes and the latter three are derived values, never persisted. classification is a provisioning fact (first_party or customer), never an exemption from verification or restriction. owner_sub is the single owner fact on the tenant (ADR-0025 section 3), not a membership role. Idempotent bootstrap by natural key; reseeding a removed tenant is rejected fail-closed by the runner (ADR-0020 decision 6).';

COMMENT ON COLUMN llm_seller.seller_tenants.name IS
  'Public provider identity. Key shape and immutability are owned by the domain contract (ADR-0027 section 2); the database keeps uniqueness only.';

CREATE TABLE IF NOT EXISTS llm_seller.seller_memberships (
  tenant_id  text NOT NULL REFERENCES llm_seller.seller_tenants (id),
  id         text NOT NULL,
  actor      text NOT NULL,
  status     text NOT NULL,
  created_at bigint NOT NULL,
  revoked_at bigint,
  revoked_by text,
  CONSTRAINT seller_memberships_pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT seller_memberships_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT seller_memberships_revoked_window_check
    CHECK ((status = 'active') = (revoked_at IS NULL))
);

COMMENT ON TABLE llm_seller.seller_memberships IS
  'Seller tenant membership (llm-seller-tenant). Grants attach to the membership, not to the owner fact. The one-active-membership-per-actor invariant is carried by the partial unique index below, mirror of the domain guard used by ownership transfer.';

CREATE UNIQUE INDEX IF NOT EXISTS seller_memberships_one_active_actor_idx
  ON llm_seller.seller_memberships (tenant_id, actor) WHERE status = 'active';

COMMENT ON INDEX llm_seller.seller_memberships_one_active_actor_idx IS
  'Partial unique index enforcing at most one active membership per actor per tenant (llm-seller-tenant invariant used by ownership transfer).';

CREATE TABLE IF NOT EXISTS llm_seller.legal_principals (
  principal_id       text NOT NULL PRIMARY KEY,
  status             text NOT NULL,
  status_changed_at  bigint,
  status_changed_by  text,
  created_at         bigint NOT NULL,
  created_by         text NOT NULL,
  CONSTRAINT legal_principals_status_check
    CHECK (status IN ('active', 'reverification_required', 'blocked')),
  CONSTRAINT legal_principals_status_audit_check
    CHECK ((status_changed_at IS NULL) = (status_changed_by IS NULL))
);

COMMENT ON TABLE llm_seller.legal_principals IS
  'First-party legal principal aggregate (llm-seller-governance, ADR-0027 section 3). principal_id is the canonical identity constant held in bootstrap code (ADR-0020 decision 12). status transitions (reverification_required to active on real approval, blocked by review) always carry the deciding actor and time as audit.';

CREATE TABLE IF NOT EXISTS llm_seller.principal_legal_profiles (
  principal_id          text NOT NULL REFERENCES llm_seller.legal_principals (principal_id),
  version               bigint NOT NULL,
  legal_name            text NOT NULL,
  legal_type            text NOT NULL,
  jurisdiction          text NOT NULL,
  registration_reference text NOT NULL,
  effective_from        bigint NOT NULL,
  recorded_at           bigint NOT NULL,
  recorded_by           text NOT NULL,
  CONSTRAINT principal_legal_profiles_pk PRIMARY KEY (principal_id, version),
  CONSTRAINT principal_legal_profiles_version_positive CHECK (version >= 1)
);

COMMENT ON TABLE llm_seller.principal_legal_profiles IS
  'Append-only legal profile revisions of a first-party legal principal (llm-seller-governance). Facts describe the authoritative legal entity behind the first-party provider; provenance points to authoritative documents outside the product via llm_seller.principal_evidence.';

CREATE TABLE IF NOT EXISTS llm_seller.principal_tax_profiles (
  principal_id          text NOT NULL REFERENCES llm_seller.legal_principals (principal_id),
  version               bigint NOT NULL,
  tax_residency         text NOT NULL,
  tax_identifier        text NOT NULL,
  declaration_reference text NOT NULL,
  effective_from        bigint NOT NULL,
  recorded_at           bigint NOT NULL,
  recorded_by           text NOT NULL,
  CONSTRAINT principal_tax_profiles_pk PRIMARY KEY (principal_id, version),
  CONSTRAINT principal_tax_profiles_version_positive CHECK (version >= 1)
);

COMMENT ON TABLE llm_seller.principal_tax_profiles IS
  'Append-only tax profile revisions of a first-party legal principal (llm-seller-governance). A new revision invalidates approved coverage of older revisions (ADR-0027 sections 4-5): eligibility flips to false until a new principal-scoped case is approved on the new revision pair.';

CREATE TABLE IF NOT EXISTS llm_seller.principal_evidence (
  id           text NOT NULL PRIMARY KEY,
  principal_id text NOT NULL REFERENCES llm_seller.legal_principals (principal_id),
  kind         text NOT NULL,
  storage_ref  text NOT NULL,
  content_hash text NOT NULL,
  recorded_at  bigint NOT NULL,
  recorded_by  text NOT NULL
);

COMMENT ON TABLE llm_seller.principal_evidence IS
  'Evidence references for a principal (llm-seller-governance). Rows are pointers, not documents: storage_ref addresses the authoritative Ecoma-io record kept outside the product, content_hash pins its bytes. Principal-scoped evidence is never attached to a Seller tenant.';

CREATE TABLE IF NOT EXISTS llm_seller.verification_cases (
  id                      text NOT NULL PRIMARY KEY,
  tenant_id               text REFERENCES llm_seller.seller_tenants (id),
  principal_id            text REFERENCES llm_seller.legal_principals (principal_id),
  type                    text NOT NULL,
  status                  text NOT NULL,
  created_at              bigint NOT NULL,
  submitted_at            bigint,
  reviewed_at             bigint,
  reviewed_by             text,
  decided_at              bigint,
  decided_by              text,
  expires_at              bigint,
  expired_at              bigint,
  public_decision_reason  text,
  verified_profile_versions jsonb NOT NULL,
  CONSTRAINT verification_cases_subject_xor CHECK (
    (tenant_id IS NULL) <> (principal_id IS NULL)
  ),
  CONSTRAINT verification_cases_status_check CHECK (
    status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'expired')
  )
);

COMMENT ON TABLE llm_seller.verification_cases IS
  'Verification case (llm-seller-governance). Exactly one subject per case: a tenant-scoped case (tenant_id set, principal_id null) or a principal-scoped case (the reverse); the CHECK enforces the subject XOR invariant. Every approved status is reachable only through a real decideVerification decision that pins reviewedProfileVersions in verified_profile_versions; classification never auto-approves (ADR-0027 section 4). verified_profile_versions holds the array of {axis, version} pins recorded at decision time.';

CREATE INDEX IF NOT EXISTS verification_cases_tenant_idx
  ON llm_seller.verification_cases (tenant_id);

CREATE INDEX IF NOT EXISTS verification_cases_principal_idx
  ON llm_seller.verification_cases (principal_id);

CREATE TABLE IF NOT EXISTS llm_seller.verification_submissions (
  case_id      text NOT NULL REFERENCES llm_seller.verification_cases (id),
  id           text NOT NULL,
  tenant_id    text,
  principal_id text,
  evidence_ids jsonb NOT NULL,
  submitted_by text NOT NULL,
  submitted_at bigint NOT NULL,
  CONSTRAINT verification_submissions_pk PRIMARY KEY (case_id, id),
  CONSTRAINT verification_submissions_subject_xor CHECK (
    (tenant_id IS NULL) <> (principal_id IS NULL)
  )
);

COMMENT ON TABLE llm_seller.verification_submissions IS
  'Submissions of a verification case (llm-seller-governance). tenant_id and principal_id mirror the case subject chosen by the domain operation; evidence_ids references llm_seller.principal_evidence rows (principal-scoped) or tenant evidence (customer path, later slice).';

CREATE TABLE IF NOT EXISTS llm_seller.restriction_records (
  id              text NOT NULL PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES llm_seller.seller_tenants (id),
  policy          text NOT NULL,
  public_reason   text NOT NULL,
  internal_reason text NOT NULL,
  scope_kind      text NOT NULL,
  capability      text,
  activates_at    bigint NOT NULL,
  expires_at      bigint,
  lifted_at       bigint,
  appeal_deadline bigint,
  CONSTRAINT restriction_records_scope_check CHECK (
    (scope_kind = 'capability' AND capability IS NOT NULL)
    OR (scope_kind = 'tenant' AND capability IS NULL)
  )
);

COMMENT ON TABLE llm_seller.restriction_records IS
  'Restriction records of a Seller tenant (llm-seller-governance, ADR-0003, ADR-0026 section 4). Being restricted is a derived value over the effective record set at a read time; no restricted status exists anywhere. First-party sellers carry restrictions exactly like customer sellers: no exemption path exists. public_reason is the only reason allowed into public projections; internal_reason never leaves this database.';

CREATE TABLE IF NOT EXISTS llm_seller.principal_associations (
  tenant_id                     text NOT NULL PRIMARY KEY REFERENCES llm_seller.seller_tenants (id),
  principal_id                  text NOT NULL REFERENCES llm_seller.legal_principals (principal_id),
  accepted_legal_profile_version bigint NOT NULL,
  accepted_tax_profile_version   bigint NOT NULL,
  established_at                bigint NOT NULL,
  established_by                text NOT NULL,
  last_accepted_at              bigint NOT NULL,
  last_accepted_by              text NOT NULL
);

COMMENT ON TABLE llm_seller.principal_associations IS
  'Association between a first_party Seller tenant and the first-party legal principal (llm-seller-governance, ADR-0027 sections 3-4). One association per tenant (tenant_id is the primary key). accepted versions pin the exact principal revision pair the tenant accepted; a new principal revision makes the stale pair lose coverage and eligibility flips to blocker verification until the tenant accepts the new pair. Provenance of the association is readable from this row plus the verification and audit rows.';

CREATE TABLE IF NOT EXISTS llm_seller.bootstrap_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  runner      text NOT NULL,
  outcome     text NOT NULL,
  detail      jsonb NOT NULL,
  actor       text NOT NULL,
  occurred_at bigint NOT NULL,
  CONSTRAINT bootstrap_audit_runner_check CHECK (runner IN ('seller-governance', 'marketplace')),
  CONSTRAINT bootstrap_audit_outcome_check CHECK (outcome IN ('created', 'no-op'))
);

COMMENT ON TABLE llm_seller.bootstrap_audit IS
  'Append-only audit of bootstrap/seed runs against db-llm-gateway (ADR-0020 decisions 5-6). One row per successful run: outcome created or no-op, with a detail payload of natural keys and counts only. The payload never carries credentials, plaintext keys or profile document contents. Readable provenance of the first-party provisioning (ADR-0027 section 3) is the join of this table with principal profiles, evidence and verification attribution.';
