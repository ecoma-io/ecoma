/**
 * Bootstrap runner 8a — seed governance records của Seller tenant canonical
 * vào `db-llm-gateway` (schema `llm_seller`).
 *
 * Source of truth: ADR-0020 (Quyết định 4, 5, 6, 12, 13), ADR-0027 §2–§5,
 * Issue #23. Chạy sau `db:migrate gateway`, trước serving container; chạy lại
 * là no-op theo natural key, divergence dữ liệu là fail-closed (không có
 * trạng thái resurrect — tenant/principal không có cột lifecycle để "sống lại").
 *
 * Luồng (một transaction, all-or-nothing):
 * 1. Divergence pre-check: tên `ecoma` không được tồn tại (ADR-0027 §2 —
 *    `ecoma` là tên principal pháp lý, không phải Seller tenant).
 * 2. Tenant `dronie` (`first_party`, owner = `sub` Superadmin bootstrap).
 * 3. Principal pháp lý first-party + revision 1 của legal/tax profile với
 *    facts là hồ sơ Ecoma-io; evidence reference trỏ hồ sơ authoritative
 *    ngoài sản phẩm (`storageRef` + `contentHash`).
 * 4. Hai case principal-scoped (`legal-identity`, `tax`) đi qua ĐỦ chuỗi
 *    domain thật: tạo → nộp evidence → vào review → `decideVerification`
 *    `approved` với reviewer attribution, pin `verifiedProfileVersions`.
 *    Classification không bao giờ tự `approved` (ADR-0027 §4).
 * 5. Association tenant ↔ principal sau khi principal `active`, pin cặp
 *    revision được accept.
 * 6. Self-verify: suy ra operational eligibility qua `deriveOperationalEligibility`
 *    từ chính durable state vừa ghi; không eligible ⇒ fail-closed.
 * 7. Ghi một dòng `bootstrap_audit` (outcome `created` | `no-op`).
 *
 * stdout giữ máy đọc: `SELLER_ELIGIBILITY_VERDICT=<json>` rồi
 * `SELLER_GOVERNANCE_RESULT=<json>`; mọi log người đọc đi stderr.
 */

import { Client } from 'pg';
import {
  createFirstPartyLegalPrincipal,
  createPrincipalEvidenceReference,
  createVerificationCase,
  decideVerification,
  deriveOperationalEligibility,
  establishFirstPartyPrincipalAssociation,
  evaluateRestrictions,
  isFirstPartyLegalPrincipal,
  isPrincipalAssessment,
  isVerificationCase,
  principalLegalProfileVersionAt,
  principalTaxProfileVersionAt,
  startVerificationReview,
  submitPrincipalVerificationCase,
  type FirstPartyLegalPrincipal,
  type PrincipalApprovedCoverage,
  type PrincipalAssociation,
  type PrincipalCoverageSnapshot,
  type PrincipalEvidenceReference,
  type PrincipalLegalProfileVersion,
  type PrincipalTaxProfileVersion,
  type RestrictionRecord,
  type VerificationCase,
} from '@ecoma-io/llm-seller-governance-domain';
import { createSellerTenant } from '@ecoma-io/llm-seller-tenant-domain';
import {
  BOOTSTRAP_ACTOR_ENV,
  BOOTSTRAP_PROFILE_AXES,
  BOOTSTRAP_REQUIRED_TYPES,
  CANONICAL_SELLER_TENANT_NAME,
  LEGAL_EVIDENCE_ID,
  LEGAL_PRINCIPAL_ID,
  OWNER_SUB_ENV,
  PRINCIPAL_LEGAL_CASE_ID,
  PRINCIPAL_LEGAL_CASE_TYPE,
  PRINCIPAL_TAX_CASE_ID,
  PRINCIPAL_TAX_CASE_TYPE,
  SELLER_TENANT_ID,
  TAX_EVIDENCE_ID,
  assertBootstrapDatabase,
  fail,
  log,
  printResult,
  printResultJson,
  requireEnv,
  type BootstrapRunResult,
} from './bootstrap-shared.mts';

/** Facts hồ sơ pháp lý/thuế từ cấu hình môi trường của run. */
interface GovernanceSeedInput {
  readonly ownerSub: string;
  readonly actor: string;
  readonly legalName: string;
  readonly legalType: string;
  readonly jurisdiction: string;
  readonly registrationReference: string;
  readonly taxResidency: string;
  readonly taxIdentifier: string;
  readonly declarationReference: string;
  readonly legalEvidenceStorageRef: string;
  readonly legalEvidenceContentHash: string;
  readonly taxEvidenceStorageRef: string;
  readonly taxEvidenceContentHash: string;
}

/** Row shape của `llm_seller.seller_tenants` (bigint đọc về string qua pg). */
interface SellerTenantRow {
  id: string;
  name: string;
  classification: string;
  owner_sub: string;
  created_at: string | number;
}

/** Khẳng định và trả lại tenant canonical; divergence là fail-closed. */
async function upsertCanonicalTenant(
  client: Client,
  now: number,
  input: GovernanceSeedInput,
): Promise<'created' | 'existing'> {
  const reserved = await client.query<{ name: string }>(
    'SELECT name FROM llm_seller.seller_tenants WHERE name = $1',
    ['ecoma'],
  );
  if (reserved.rows.length > 0) {
    fail(
      'tenant name "ecoma" must never exist in llm-seller-tenant: it is the legal principal identity, not a Seller tenant (ADR-0027 section 2)',
    );
  }
  const existing = await client.query<SellerTenantRow>(
    'SELECT id, name, classification, owner_sub, created_at FROM llm_seller.seller_tenants WHERE name = $1',
    [CANONICAL_SELLER_TENANT_NAME],
  );
  const tenant = existing.rows[0];
  if (tenant !== undefined) {
    // Trùng natural key: khẳng định các fact bất biến của định danh.
    if (tenant.id !== SELLER_TENANT_ID) {
      fail(
        `tenant name "${CANONICAL_SELLER_TENANT_NAME}" is taken by id "${tenant.id}" but the canonical id is "${SELLER_TENANT_ID}"; divergent provisioning state`,
      );
    }
    if (tenant.classification !== 'first_party') {
      fail(
        `canonical tenant classification is "${tenant.classification}" but bootstrap seeds "first_party"; divergent provisioning state`,
      );
    }
    if (tenant.owner_sub !== input.ownerSub) {
      fail(
        'canonical tenant owner differs from the configured bootstrap superadmin sub; ownership is immutable and never resurrected through bootstrap',
      );
    }
    return 'existing';
  }
  // Tenant vắng mặt: association hay principal còn tồn tại nghĩa là tenant từng
  // được seed rồi bị xoá ngoài bề mặt provisioning — tên vẫn reserved, seed
  // lại bị chặn fail-closed (ADR-0020 Quyết định 6, ADR-0027 §2). Không có
  // trạng thái resurrect.
  const associationLingers = await client.query<{ c: string }>(
    'SELECT count(*)::text AS c FROM llm_seller.principal_associations WHERE tenant_id = $1',
    [SELLER_TENANT_ID],
  );
  const principalLingers = await client.query<{ c: string }>(
    'SELECT count(*)::text AS c FROM llm_seller.legal_principals WHERE principal_id = $1',
    [LEGAL_PRINCIPAL_ID],
  );
  if (
    (associationLingers.rows[0]?.c ?? '0') !== '0' ||
    (principalLingers.rows[0]?.c ?? '0') !== '0'
  ) {
    fail(
      `canonical tenant "${CANONICAL_SELLER_TENANT_NAME}" was removed while its principal governance state still exists; the removed tenant name stays reserved and bootstrap never reseeds it — restore through the governance surface`,
    );
  }
  const inserted = await client.query<SellerTenantRow>(
    `INSERT INTO llm_seller.seller_tenants (id, name, classification, owner_sub, created_at)
     VALUES ($1, $2, 'first_party', $3, $4)
     ON CONFLICT (name) DO NOTHING
     RETURNING id, name, classification, owner_sub, created_at`,
    ((): [string, string, string, number] => {
      // Domain op là đường code duy nhất: aggregate được dựng qua
      // `createSellerTenant` rồi mới ghi bền vững — không có SQL tự dựng field.
      const created = createSellerTenant({
        id: SELLER_TENANT_ID,
        name: CANONICAL_SELLER_TENANT_NAME,
        owner: input.ownerSub,
        createdAt: now,
      });
      if (!created.ok) {
        fail(`canonical tenant creation rejected by domain: ${created.error}`);
      }
      if (
        created.value.id !== SELLER_TENANT_ID ||
        created.value.name !== CANONICAL_SELLER_TENANT_NAME
      ) {
        fail('canonical tenant identity diverged from the constants held in code; fail-closed');
      }
      return [created.value.id, created.value.name, created.value.owner, created.value.createdAt];
    })(),
  );
  if (inserted.rows.length === 1) {
    return 'created';
  }
  // Concurrent bootstrap đã chèn row giữa hai bước — đọc lại ở run kế tiếp.
  fail('canonical tenant row appeared during concurrent bootstrap; rerun the step');
}

/** Ghép principal từ các row durable thành aggregate cho domain guards. */
function rehydratePrincipal(
  principalRow: {
    principal_id: string;
    status: string;
    status_changed_at: string | number | null;
    status_changed_by: string | null;
    created_at: string | number;
    created_by: string;
  },
  legalRows: PrincipalLegalProfileVersion[],
  taxRows: PrincipalTaxProfileVersion[],
): FirstPartyLegalPrincipal {
  const candidate = {
    principalId: principalRow.principal_id,
    status: principalRow.status,
    legalProfileVersions: legalRows,
    taxProfileVersions: taxRows,
    statusChangedAt:
      principalRow.status_changed_at === null ? null : Number(principalRow.status_changed_at),
    statusChangedBy: principalRow.status_changed_by,
    createdAt: Number(principalRow.created_at),
    createdBy: principalRow.created_by,
  };
  if (!isFirstPartyLegalPrincipal(candidate)) {
    fail('stored legal principal failed the domain shape guard; divergent provisioning state');
  }
  return candidate;
}

/** Đọc principal + mọi revision profile của nó. */
async function readPrincipal(client: Client): Promise<{
  principal: FirstPartyLegalPrincipal | undefined;
  legalRows: PrincipalLegalProfileVersion[];
  taxRows: PrincipalTaxProfileVersion[];
}> {
  const principalResult = await client.query<{
    principal_id: string;
    status: string;
    status_changed_at: string | number | null;
    status_changed_by: string | null;
    created_at: string | number;
    created_by: string;
  }>(
    'SELECT principal_id, status, status_changed_at, status_changed_by, created_at, created_by FROM llm_seller.legal_principals WHERE principal_id = $1',
    [LEGAL_PRINCIPAL_ID],
  );
  const principalRow = principalResult.rows[0];
  if (principalRow === undefined) {
    return { principal: undefined, legalRows: [], taxRows: [] };
  }
  const legalResult = await client.query<{
    principal_id: string;
    version: string | number;
    legal_name: string;
    legal_type: string;
    jurisdiction: string;
    registration_reference: string;
    effective_from: string | number;
    recorded_at: string | number;
    recorded_by: string;
  }>(
    'SELECT principal_id, version, legal_name, legal_type, jurisdiction, registration_reference, effective_from, recorded_at, recorded_by FROM llm_seller.principal_legal_profiles WHERE principal_id = $1 ORDER BY version',
    [LEGAL_PRINCIPAL_ID],
  );
  const taxResult = await client.query<{
    principal_id: string;
    version: string | number;
    tax_residency: string;
    tax_identifier: string;
    declaration_reference: string;
    effective_from: string | number;
    recorded_at: string | number;
    recorded_by: string;
  }>(
    'SELECT principal_id, version, tax_residency, tax_identifier, declaration_reference, effective_from, recorded_at, recorded_by FROM llm_seller.principal_tax_profiles WHERE principal_id = $1 ORDER BY version',
    [LEGAL_PRINCIPAL_ID],
  );
  const legalRows: PrincipalLegalProfileVersion[] = legalResult.rows.map((row) => ({
    principalId: row.principal_id,
    version: Number(row.version),
    legalName: row.legal_name,
    legalType: row.legal_type,
    jurisdiction: row.jurisdiction,
    registrationReference: row.registration_reference,
    effectiveFrom: Number(row.effective_from),
    recordedAt: Number(row.recorded_at),
    recordedBy: row.recorded_by,
  }));
  const taxRows: PrincipalTaxProfileVersion[] = taxResult.rows.map((row) => ({
    principalId: row.principal_id,
    version: Number(row.version),
    taxResidency: row.tax_residency,
    taxIdentifier: row.tax_identifier,
    declarationReference: row.declaration_reference,
    effectiveFrom: Number(row.effective_from),
    recordedAt: Number(row.recorded_at),
    recordedBy: row.recorded_by,
  }));
  return { principal: rehydratePrincipal(principalRow, legalRows, taxRows), legalRows, taxRows };
}

/** Seed principal + revision 1 nếu chưa có; kiểm divergence fact revision 1. */
async function upsertPrincipal(
  client: Client,
  now: number,
  input: GovernanceSeedInput,
): Promise<{ outcome: 'created' | 'existing'; principal: FirstPartyLegalPrincipal }> {
  const { principal, legalRows, taxRows } = await readPrincipal(client);
  if (principal !== undefined) {
    const legalV1 = legalRows.find((row) => row.version === 1);
    const taxV1 = taxRows.find((row) => row.version === 1);
    if (legalV1 === undefined || taxV1 === undefined) {
      fail(
        'legal principal exists without its revision 1 profile pair; divergent provisioning state',
      );
    }
    const factsDiverge =
      legalV1.legalName !== input.legalName ||
      legalV1.legalType !== input.legalType ||
      legalV1.jurisdiction !== input.jurisdiction ||
      legalV1.registrationReference !== input.registrationReference ||
      taxV1.taxResidency !== input.taxResidency ||
      taxV1.taxIdentifier !== input.taxIdentifier ||
      taxV1.declarationReference !== input.declarationReference;
    if (factsDiverge) {
      fail(
        'principal revision 1 profile facts differ from the configured bootstrap facts; revision 1 is immutable and new facts require a new revision through the governance surface, not bootstrap',
      );
    }
    if (principal.status !== 'active') {
      fail(
        `legal principal is "${principal.status}"; bootstrap never resurrects or re-approves an existing principal (no-resurrect, ADR-0020 decision 6) — resolve the status through the governance surface`,
      );
    }
    return { outcome: 'existing', principal };
  }
  const created = createFirstPartyLegalPrincipal({
    principalId: LEGAL_PRINCIPAL_ID,
    legalName: input.legalName,
    legalType: input.legalType,
    jurisdiction: input.jurisdiction,
    registrationReference: input.registrationReference,
    taxResidency: input.taxResidency,
    taxIdentifier: input.taxIdentifier,
    declarationReference: input.declarationReference,
    effectiveFrom: now,
    recordedAt: now,
    recordedBy: input.actor,
  });
  if (!created.ok) {
    fail(`legal principal creation rejected by domain: ${created.error}`);
  }
  const legalV1 = created.value.legalProfileVersions[0];
  const taxV1 = created.value.taxProfileVersions[0];
  await client.query(
    `INSERT INTO llm_seller.legal_principals (principal_id, status, status_changed_at, status_changed_by, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (principal_id) DO NOTHING`,
    [
      created.value.principalId,
      created.value.status,
      created.value.statusChangedAt,
      created.value.statusChangedBy,
      created.value.createdAt,
      created.value.createdBy,
    ],
  );
  await client.query(
    `INSERT INTO llm_seller.principal_legal_profiles
       (principal_id, version, legal_name, legal_type, jurisdiction, registration_reference, effective_from, recorded_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (principal_id, version) DO NOTHING`,
    [
      legalV1.principalId,
      legalV1.version,
      legalV1.legalName,
      legalV1.legalType,
      legalV1.jurisdiction,
      legalV1.registrationReference,
      legalV1.effectiveFrom,
      legalV1.recordedAt,
      legalV1.recordedBy,
    ],
  );
  await client.query(
    `INSERT INTO llm_seller.principal_tax_profiles
       (principal_id, version, tax_residency, tax_identifier, declaration_reference, effective_from, recorded_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (principal_id, version) DO NOTHING`,
    [
      taxV1.principalId,
      taxV1.version,
      taxV1.taxResidency,
      taxV1.taxIdentifier,
      taxV1.declarationReference,
      taxV1.effectiveFrom,
      taxV1.recordedAt,
      taxV1.recordedBy,
    ],
  );
  return { outcome: 'created', principal: created.value };
}

interface EvidenceSeedSpec {
  readonly id: string;
  readonly kind: string;
  readonly storageRef: string;
  readonly contentHash: string;
}

/** Seed một evidence reference; divergence pointer là fail-closed. */
async function upsertEvidence(
  client: Client,
  now: number,
  input: GovernanceSeedInput,
  spec: EvidenceSeedSpec,
): Promise<PrincipalEvidenceReference> {
  const existing = await client.query<{
    id: string;
    principal_id: string;
    kind: string;
    storage_ref: string;
    content_hash: string;
    recorded_at: string | number;
    recorded_by: string;
  }>(
    'SELECT id, principal_id, kind, storage_ref, content_hash, recorded_at, recorded_by FROM llm_seller.principal_evidence WHERE id = $1',
    [spec.id],
  );
  const row = existing.rows[0];
  if (row !== undefined) {
    const diverges =
      row.principal_id !== LEGAL_PRINCIPAL_ID ||
      row.kind !== spec.kind ||
      row.storage_ref !== spec.storageRef ||
      row.content_hash !== spec.contentHash;
    if (diverges) {
      fail(
        `evidence reference "${spec.id}" diverges from the configured authoritative document pointer; evidence provenance is immutable through bootstrap`,
      );
    }
    return {
      id: row.id,
      principalId: row.principal_id,
      kind: row.kind,
      storageRef: row.storage_ref,
      contentHash: row.content_hash,
      recordedAt: Number(row.recorded_at),
      recordedBy: row.recorded_by,
    };
  }
  const created = createPrincipalEvidenceReference({
    id: spec.id,
    principalId: LEGAL_PRINCIPAL_ID,
    kind: spec.kind,
    storageRef: spec.storageRef,
    contentHash: spec.contentHash,
    recordedAt: now,
    recordedBy: input.actor,
  });
  if (!created.ok) {
    fail(`evidence reference creation rejected by domain: ${created.error}`);
  }
  await client.query(
    `INSERT INTO llm_seller.principal_evidence (id, principal_id, kind, storage_ref, content_hash, recorded_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [
      created.value.id,
      created.value.principalId,
      created.value.kind,
      created.value.storageRef,
      created.value.contentHash,
      created.value.recordedAt,
      created.value.recordedBy,
    ],
  );
  return created.value;
}

interface VerificationCaseRow {
  id: string;
  tenant_id: string | null;
  principal_id: string | null;
  type: string;
  status: string;
  created_at: string | number;
  submitted_at: string | number | null;
  reviewed_at: string | number | null;
  reviewed_by: string | null;
  decided_at: string | number | null;
  decided_by: string | null;
  expires_at: string | number | null;
  expired_at: string | number | null;
  public_decision_reason: string | null;
  verified_profile_versions: { axis: 'legal' | 'tax'; version: number }[];
}

/** Ghép row + submissions thành VerificationCase cho domain guards. */
function rehydrateCase(row: VerificationCaseRow): VerificationCase {
  const candidate = {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    type: row.type,
    status: row.status,
    createdAt: Number(row.created_at),
    submissions: [],
    submittedAt: row.submitted_at === null ? null : Number(row.submitted_at),
    reviewedAt: row.reviewed_at === null ? null : Number(row.reviewed_at),
    reviewedBy: row.reviewed_by,
    decidedAt: row.decided_at === null ? null : Number(row.decided_at),
    decidedBy: row.decided_by,
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    expiredAt: row.expired_at === null ? null : Number(row.expired_at),
    publicDecisionReason: row.public_decision_reason,
    verifiedProfileVersions: row.verified_profile_versions,
  };
  if (!isVerificationCase(candidate)) {
    fail(
      `verification case "${row.id}" failed the domain shape guard; divergent provisioning state`,
    );
  }
  return candidate;
}

async function readCase(client: Client, caseId: string): Promise<VerificationCase | undefined> {
  const result = await client.query<VerificationCaseRow>(
    `SELECT id, tenant_id, principal_id, type, status, created_at, submitted_at, reviewed_at, reviewed_by,
            decided_at, decided_by, expires_at, expired_at, public_decision_reason, verified_profile_versions
     FROM llm_seller.verification_cases WHERE id = $1`,
    [caseId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : rehydrateCase(row);
}

/** Đọc các case tenant-scoped trên trục legal/tax của tenant (single-source check). */
async function readTenantScopedProfileCases(client: Client): Promise<VerificationCase[]> {
  const result = await client.query<VerificationCaseRow>(
    `SELECT id, tenant_id, principal_id, type, status, created_at, submitted_at, reviewed_at, reviewed_by,
            decided_at, decided_by, expires_at, expired_at, public_decision_reason, verified_profile_versions
     FROM llm_seller.verification_cases
     WHERE tenant_id = $1 AND type IN ($2, $3)`,
    [SELLER_TENANT_ID, PRINCIPAL_LEGAL_CASE_TYPE, PRINCIPAL_TAX_CASE_TYPE],
  );
  return result.rows.map(rehydrateCase);
}

/** Pin version của một trục từ tập pin của case. */
function pinVersion(testCase: VerificationCase, axis: 'legal' | 'tax'): number | undefined {
  return testCase.verifiedProfileVersions.find((pin) => pin.axis === axis)?.version;
}

/**
 * Seed một case principal-scoped qua ĐỦ chuỗi domain thật (tạo → nộp → review
 * → approve). Case đã tồn tại phải `approved` — bootstrap không bao giờ hoàn
 * tất nửa chừng một case của run khác.
 */
async function upsertPrincipalCase(
  client: Client,
  now: number,
  input: GovernanceSeedInput,
  spec: {
    caseId: string;
    caseType: string;
    evidenceId: string;
    evidence: PrincipalEvidenceReference;
  },
  principalBeforeDecision: FirstPartyLegalPrincipal,
  otherAxisCoverage: PrincipalCoverageSnapshot,
): Promise<{
  outcome: 'created' | 'existing';
  pinnedVersion: number;
  principal: FirstPartyLegalPrincipal;
}> {
  const existing = await readCase(client, spec.caseId);
  if (existing !== undefined) {
    if (existing.principalId !== LEGAL_PRINCIPAL_ID || existing.type !== spec.caseType) {
      fail(
        `verification case "${spec.caseId}" exists with a different subject or type; divergent provisioning state`,
      );
    }
    if (existing.status !== 'approved') {
      fail(
        `verification case "${spec.caseId}" exists with status "${existing.status}"; bootstrap only accepts its own approved cases and never completes a case it did not run end to end — resolve it through the governance surface`,
      );
    }
    const pinned = pinVersion(
      existing,
      spec.caseType === PRINCIPAL_LEGAL_CASE_TYPE ? 'legal' : 'tax',
    );
    if (pinned === undefined) {
      fail(
        `approved verification case "${spec.caseId}" carries no profile pin; an approval without coverage pins is not a real review (ADR-0027 section 4)`,
      );
    }
    return { outcome: 'existing', pinnedVersion: pinned, principal: principalBeforeDecision };
  }
  const caseCreated = createVerificationCase({
    id: spec.caseId,
    principalId: LEGAL_PRINCIPAL_ID,
    type: spec.caseType,
    createdAt: now,
  });
  if (!caseCreated.ok) {
    fail(`verification case creation rejected by domain: ${caseCreated.error}`);
  }
  await client.query(
    `INSERT INTO llm_seller.verification_cases
       (id, tenant_id, principal_id, type, status, created_at, submitted_at, reviewed_at, reviewed_by,
        decided_at, decided_by, expires_at, expired_at, public_decision_reason, verified_profile_versions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      caseCreated.value.id,
      caseCreated.value.tenantId,
      caseCreated.value.principalId,
      caseCreated.value.type,
      caseCreated.value.status,
      caseCreated.value.createdAt,
      caseCreated.value.submittedAt,
      caseCreated.value.reviewedAt,
      caseCreated.value.reviewedBy,
      caseCreated.value.decidedAt,
      caseCreated.value.decidedBy,
      caseCreated.value.expiresAt,
      caseCreated.value.expiredAt,
      caseCreated.value.publicDecisionReason,
      JSON.stringify(caseCreated.value.verifiedProfileVersions),
    ],
  );

  const submitted = submitPrincipalVerificationCase({
    verificationCase: caseCreated.value,
    submissionId: `${spec.caseId}-submission-1`,
    evidence: [spec.evidence],
    submittedBy: input.actor,
    submittedAt: now,
  });
  if (!submitted.ok) {
    fail(`verification submission rejected by domain: ${submitted.error}`);
  }
  await client.query(
    `INSERT INTO llm_seller.verification_submissions (case_id, id, tenant_id, principal_id, evidence_ids, submitted_by, submitted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (case_id, id) DO NOTHING`,
    [
      submitted.value.id,
      submitted.value.submissions[submitted.value.submissions.length - 1].id,
      submitted.value.tenantId,
      submitted.value.principalId,
      JSON.stringify(
        submitted.value.submissions[submitted.value.submissions.length - 1].evidenceIds,
      ),
      input.actor,
      now,
    ],
  );
  await client.query(
    `UPDATE llm_seller.verification_cases
     SET status = $2, submitted_at = $3
     WHERE id = $1`,
    [submitted.value.id, submitted.value.status, submitted.value.submittedAt],
  );

  const underReview = startVerificationReview({
    verificationCase: submitted.value,
    reviewer: input.actor,
    reviewedAt: now,
  });
  if (!underReview.ok) {
    fail(`verification review start rejected by domain: ${underReview.error}`);
  }
  await client.query(
    `UPDATE llm_seller.verification_cases
     SET status = $2, reviewed_at = $3, reviewed_by = $4
     WHERE id = $1`,
    [
      underReview.value.id,
      underReview.value.status,
      underReview.value.reviewedAt,
      underReview.value.reviewedBy,
    ],
  );

  const decision = decideVerification({
    verificationCase: underReview.value,
    decision: 'approved',
    decidedBy: input.actor,
    decidedAt: now,
    profileAxes: BOOTSTRAP_PROFILE_AXES,
    principal: principalBeforeDecision,
    principalCoverage: otherAxisCoverage,
  });
  if (!decision.ok) {
    fail(`verification approval rejected by domain: ${decision.error}`);
  }
  const pinned = pinVersion(
    decision.value.verificationCase,
    spec.caseType === PRINCIPAL_LEGAL_CASE_TYPE ? 'legal' : 'tax',
  );
  if (pinned === undefined) {
    fail(
      `approval of "${spec.caseId}" recorded no profile pin; fail-closed because an unpinned approval proves nothing`,
    );
  }
  await client.query(
    `UPDATE llm_seller.verification_cases
     SET status = $2, decided_at = $3, decided_by = $4, verified_profile_versions = $5::jsonb
     WHERE id = $1`,
    [
      decision.value.verificationCase.id,
      decision.value.verificationCase.status,
      decision.value.verificationCase.decidedAt,
      decision.value.verificationCase.decidedBy,
      JSON.stringify(decision.value.verificationCase.verifiedProfileVersions),
    ],
  );
  return {
    outcome: 'created',
    pinnedVersion: pinned,
    principal: decision.value.legalPrincipal ?? principalBeforeDecision,
  };
}

/** Ghép row thành association cho domain guards và self-verify. */
function rehydrateAssociation(row: {
  tenant_id: string;
  principal_id: string;
  accepted_legal_profile_version: string | number;
  accepted_tax_profile_version: string | number;
  established_at: string | number;
  established_by: string;
  last_accepted_at: string | number;
  last_accepted_by: string;
}): PrincipalAssociation {
  return {
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    acceptedLegalProfileVersion: Number(row.accepted_legal_profile_version),
    acceptedTaxProfileVersion: Number(row.accepted_tax_profile_version),
    establishedAt: Number(row.established_at),
    establishedBy: row.established_by,
    lastAcceptedAt: Number(row.last_accepted_at),
    lastAcceptedBy: row.last_accepted_by,
  };
}

/** Ghép row thành RestrictionRecord cho evaluateRestrictions. */
function rehydrateRestriction(row: {
  id: string;
  tenant_id: string;
  policy: string;
  public_reason: string;
  internal_reason: string;
  scope_kind: string;
  capability: string | null;
  activates_at: string | number;
  expires_at: string | number | null;
  lifted_at: string | number | null;
  appeal_deadline: string | number | null;
}): RestrictionRecord {
  const scope: RestrictionRecord['scope'] =
    row.scope_kind === 'capability'
      ? { kind: 'capability', capability: row.capability ?? '' }
      : { kind: 'tenant' };
  return {
    id: row.id,
    tenantId: row.tenant_id,
    policy: row.policy,
    publicReason: row.public_reason,
    internalReason: row.internal_reason,
    scope,
    activatesAt: Number(row.activates_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    liftedAt: row.lifted_at === null ? null : Number(row.lifted_at),
    appealDeadline: row.appeal_deadline === null ? null : Number(row.appeal_deadline),
  };
}

/** Bootstrap 8a: seed governance records và tự kiểm eligibility. */
export async function bootstrapSellerGovernance(
  client: Client,
  input: GovernanceSeedInput,
): Promise<{ result: BootstrapRunResult; verdictJson: string }> {
  const now = Date.now();

  const tenantOutcome = await upsertCanonicalTenant(client, now, input);
  const principalOutcome = await upsertPrincipal(client, now, input);
  const principal = principalOutcome.principal;

  const legalEvidence = await upsertEvidence(client, now, input, {
    id: LEGAL_EVIDENCE_ID,
    kind: PRINCIPAL_LEGAL_CASE_TYPE,
    storageRef: input.legalEvidenceStorageRef,
    contentHash: input.legalEvidenceContentHash,
  });
  const taxEvidence = await upsertEvidence(client, now, input, {
    id: TAX_EVIDENCE_ID,
    kind: PRINCIPAL_TAX_CASE_TYPE,
    storageRef: input.taxEvidenceStorageRef,
    contentHash: input.taxEvidenceContentHash,
  });

  // Case legal trước (pin trục legal), rồi case tax với coverage từ pin legal —
  // approval tax là quyết định kích hoạt principal (§7).
  const legalCase = await upsertPrincipalCase(
    client,
    now,
    input,
    {
      caseId: PRINCIPAL_LEGAL_CASE_ID,
      caseType: PRINCIPAL_LEGAL_CASE_TYPE,
      evidenceId: LEGAL_EVIDENCE_ID,
      evidence: legalEvidence,
    },
    principal,
    {},
  );
  const taxCase = await upsertPrincipalCase(
    client,
    now,
    input,
    {
      caseId: PRINCIPAL_TAX_CASE_ID,
      caseType: PRINCIPAL_TAX_CASE_TYPE,
      evidenceId: TAX_EVIDENCE_ID,
      evidence: taxEvidence,
    },
    legalCase.principal,
    { legal: legalCase.pinnedVersion },
  );
  const activePrincipal = taxCase.principal;
  if (activePrincipal.status !== 'active') {
    fail(
      `principal did not activate after both approvals (status "${activePrincipal.status}"); coverage does not prove the current revision pair — fail-closed`,
    );
  }
  await client.query(
    `UPDATE llm_seller.legal_principals
     SET status = $2, status_changed_at = $3, status_changed_by = $4
     WHERE principal_id = $1`,
    [
      LEGAL_PRINCIPAL_ID,
      activePrincipal.status,
      activePrincipal.statusChangedAt,
      activePrincipal.statusChangedBy,
    ],
  );

  // Association: principal đã active, pin đúng cặp revision hiện hành.
  const currentLegal = principalLegalProfileVersionAt(activePrincipal, now);
  const currentTax = principalTaxProfileVersionAt(activePrincipal, now);
  if (currentLegal === undefined || currentTax === undefined) {
    fail('principal has no profile revision effective at bootstrap time; fail-closed');
  }
  const associationResult = await client.query<{
    tenant_id: string;
    principal_id: string;
    accepted_legal_profile_version: string | number;
    accepted_tax_profile_version: string | number;
    established_at: string | number;
    established_by: string;
    last_accepted_at: string | number;
    last_accepted_by: string;
  }>(
    'SELECT tenant_id, principal_id, accepted_legal_profile_version, accepted_tax_profile_version, established_at, established_by, last_accepted_at, last_accepted_by FROM llm_seller.principal_associations WHERE tenant_id = $1',
    [SELLER_TENANT_ID],
  );
  let associationRow = associationResult.rows[0];
  let associationOutcome: 'created' | 'existing';
  if (associationRow === undefined) {
    const established = establishFirstPartyPrincipalAssociation({
      tenantId: SELLER_TENANT_ID,
      principal: activePrincipal,
      acceptedLegalProfileVersion: currentLegal.version,
      acceptedTaxProfileVersion: currentTax.version,
      approvedCoverage: { legal: legalCase.pinnedVersion, tax: taxCase.pinnedVersion },
      establishedBy: input.actor,
      establishedAt: now,
    });
    if (!established.ok) {
      fail(`principal association rejected by domain: ${established.error}`);
    }
    await client.query(
      `INSERT INTO llm_seller.principal_associations
         (tenant_id, principal_id, accepted_legal_profile_version, accepted_tax_profile_version,
          established_at, established_by, last_accepted_at, last_accepted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [
        established.value.tenantId,
        established.value.principalId,
        established.value.acceptedLegalProfileVersion,
        established.value.acceptedTaxProfileVersion,
        established.value.establishedAt,
        established.value.establishedBy,
        established.value.lastAcceptedAt,
        established.value.lastAcceptedBy,
      ],
    );
    associationRow = {
      tenant_id: established.value.tenantId,
      principal_id: established.value.principalId,
      accepted_legal_profile_version: established.value.acceptedLegalProfileVersion,
      accepted_tax_profile_version: established.value.acceptedTaxProfileVersion,
      established_at: established.value.establishedAt,
      established_by: established.value.establishedBy,
      last_accepted_at: established.value.lastAcceptedAt,
      last_accepted_by: established.value.lastAcceptedBy,
    };
    associationOutcome = 'created';
  } else {
    const association = rehydrateAssociation(associationRow);
    if (association.principalId !== LEGAL_PRINCIPAL_ID) {
      fail(
        `association of the canonical tenant points at principal "${association.principalId}" but bootstrap owns "${LEGAL_PRINCIPAL_ID}"; divergent provisioning state`,
      );
    }
    if (
      association.acceptedLegalProfileVersion !== currentLegal.version ||
      association.acceptedTaxProfileVersion !== currentTax.version
    ) {
      fail(
        'association pins a stale principal revision pair; the tenant must accept new revisions through the governance surface, not bootstrap',
      );
    }
    associationOutcome = 'existing';
  }

  // Self-verify: suy ra eligibility từ chính durable state vừa đọc/ghi.
  const restrictionRows = await client.query<{
    id: string;
    tenant_id: string;
    policy: string;
    public_reason: string;
    internal_reason: string;
    scope_kind: string;
    capability: string | null;
    activates_at: string | number;
    expires_at: string | number | null;
    lifted_at: string | number | null;
    appeal_deadline: string | number | null;
  }>(
    'SELECT id, tenant_id, policy, public_reason, internal_reason, scope_kind, capability, activates_at, expires_at, lifted_at, appeal_deadline FROM llm_seller.restriction_records WHERE tenant_id = $1',
    [SELLER_TENANT_ID],
  );
  const restrictionEvaluation = evaluateRestrictions({
    tenantId: SELLER_TENANT_ID,
    records: restrictionRows.rows.map(rehydrateRestriction),
    policies: {},
    target: { kind: 'tenant' },
    now,
  });
  if (!restrictionEvaluation.ok) {
    fail(`restriction evaluation rejected by domain: ${restrictionEvaluation.error}`);
  }
  const tenantScopedCases = await readTenantScopedProfileCases(client);
  const approvedCoverage: PrincipalApprovedCoverage = {
    legal: legalCase.pinnedVersion,
    tax: taxCase.pinnedVersion,
  };
  const assessment = {
    principal: activePrincipal,
    association: associationRow === undefined ? null : rehydrateAssociation(associationRow),
    approvedCoverage,
    assessedAt: now,
  };
  if (!isPrincipalAssessment(assessment)) {
    fail('principal assessment failed the domain shape guard; fail-closed');
  }
  const verdict = deriveOperationalEligibility({
    tenantId: SELLER_TENANT_ID,
    tenantClassification: 'first_party',
    principalAssessment: assessment,
    restrictions: restrictionEvaluation.value,
    cases: tenantScopedCases,
    requiredTypes: BOOTSTRAP_REQUIRED_TYPES,
    now,
    profileAxes: BOOTSTRAP_PROFILE_AXES,
  });
  if (!verdict.ok) {
    fail(`operational eligibility derivation rejected by domain: ${verdict.error}`);
  }
  if (!verdict.value.eligible) {
    fail(
      `canonical seller is not operationally eligible after bootstrap: blockers ${JSON.stringify(verdict.value.blockers)}`,
    );
  }

  const outcome: BootstrapRunResult['outcome'] =
    tenantOutcome === 'created' ||
    principalOutcome.outcome === 'created' ||
    legalCase.outcome === 'created' ||
    taxCase.outcome === 'created' ||
    associationOutcome === 'created'
      ? 'created'
      : 'no-op';
  await client.query(
    `INSERT INTO llm_seller.bootstrap_audit (runner, outcome, detail, actor, occurred_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [
      'seller-governance',
      outcome,
      JSON.stringify({
        tenant: CANONICAL_SELLER_TENANT_NAME,
        tenantId: SELLER_TENANT_ID,
        principal: LEGAL_PRINCIPAL_ID,
        legalCasePin: { type: PRINCIPAL_LEGAL_CASE_TYPE, version: legalCase.pinnedVersion },
        taxCasePin: { type: PRINCIPAL_TAX_CASE_TYPE, version: taxCase.pinnedVersion },
        association: associationOutcome,
      }),
      input.actor,
      now,
    ],
  );

  const verdictValue = {
    tenantId: SELLER_TENANT_ID,
    eligible: verdict.value.eligible,
    blockers: verdict.value.blockers,
    assessedAt: now,
  };
  return {
    verdictJson: JSON.stringify(verdictValue),
    result: {
      outcome,
      detail: {
        tenant: CANONICAL_SELLER_TENANT_NAME,
        principal: LEGAL_PRINCIPAL_ID,
        association: associationOutcome,
      },
    },
  };
}

/** CLI entry — env là kênh cấu hình duy nhất (ADR-0020 Quyết định 12). */
async function main(): Promise<void> {
  const input: GovernanceSeedInput = {
    ownerSub: requireEnv(OWNER_SUB_ENV),
    actor: requireEnv(BOOTSTRAP_ACTOR_ENV),
    legalName: requireEnv('ECOMA_FIRST_PARTY_LEGAL_NAME'),
    legalType: requireEnv('ECOMA_FIRST_PARTY_LEGAL_TYPE'),
    jurisdiction: requireEnv('ECOMA_FIRST_PARTY_JURISDICTION'),
    registrationReference: requireEnv('ECOMA_FIRST_PARTY_REGISTRATION_REFERENCE'),
    taxResidency: requireEnv('ECOMA_FIRST_PARTY_TAX_RESIDENCY'),
    taxIdentifier: requireEnv('ECOMA_FIRST_PARTY_TAX_IDENTIFIER'),
    declarationReference: requireEnv('ECOMA_FIRST_PARTY_DECLARATION_REFERENCE'),
    legalEvidenceStorageRef: requireEnv('ECOMA_LEGAL_EVIDENCE_STORAGE_REF'),
    legalEvidenceContentHash: requireEnv('ECOMA_LEGAL_EVIDENCE_CONTENT_HASH'),
    taxEvidenceStorageRef: requireEnv('ECOMA_TAX_EVIDENCE_STORAGE_REF'),
    taxEvidenceContentHash: requireEnv('ECOMA_TAX_EVIDENCE_CONTENT_HASH'),
  };
  const databaseUrl = requireEnv('DATABASE_URL');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await assertBootstrapDatabase(client, 'db-llm-gateway');
    await client.query('BEGIN');
    const { result, verdictJson } = await bootstrapSellerGovernance(client, input);
    await client.query('COMMIT');
    printResult('SELLER_ELIGIBILITY_VERDICT', verdictJson);
    printResultJson('SELLER_GOVERNANCE_RESULT', result);
    log(`seller governance bootstrap done: ${result.outcome}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
