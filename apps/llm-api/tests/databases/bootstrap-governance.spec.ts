/**
 * Bootstrap runner 8a (`db/bootstrap-seller-governance.mts`) trên PostgreSQL
 * thật, qua **runner production** chạy bằng `tsx` — đúng lệnh mà bootstrap
 * command chạy trên lane local (ADR-0020 Quyết định 12, Issue #23).
 *
 * Phủ các điều kiện hoàn thành của Issue #23: seed tenant `dronie` + principal
 * Ecoma-io + hai case `approved` thật (chuỗi domain đầy đủ, có reviewer
 * attribution), association, evidence provenance; re-run là no-op; divergence
 * owner là fail-closed; seed lại sau xoá bị chặn (tên vẫn reserved); restriction
 * mới đẩy eligibility về `false` (không exemption cho `first_party`); các điều
 * kiện eligibility `false` → `true` được kiểm chứng qua `deriveOperationalEligibility`
 * trên chính durable state (ADR-0027 §4–§5).
 *
 * Credential plaintext KHÔNG xuất hiện ở runner này — suite này cũng không có
 * secret nào; các giá trị evidence là fixture mô phỏng hồ sơ authoritative
 * thật của Ecoma-io, tài liệu thật nằm ngoài repository.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  migratorUrl,
  runBootstrapCli,
  startLlmApiDatabase,
  type LlmApiDatabase,
} from '../integrations/harness.ts';
import {
  BOOTSTRAP_PROFILE_AXES,
  BOOTSTRAP_REQUIRED_TYPES,
  CANONICAL_SELLER_TENANT_NAME,
  LEGAL_PRINCIPAL_ID,
  SELLER_TENANT_ID,
} from '../../db/bootstrap-shared.mts';
import {
  acceptPrincipalRevision,
  appendPrincipalLegalProfileVersion,
  appendPrincipalTaxProfileVersion,
  createVerificationCase,
  decideVerification,
  deriveOperationalEligibility,
  evaluateRestrictions,
  isFirstPartyLegalPrincipal,
  isPrincipalAssessment,
  isVerificationCase,
  principalLegalProfileVersionAt,
  principalTaxProfileVersionAt,
  startVerificationReview,
  submitPrincipalVerificationCase,
  type FirstPartyLegalPrincipal,
  type LlmGovernanceDomainError,
  type PrincipalApprovedCoverage,
  type PrincipalAssociation,
  type PrincipalCoverageSnapshot,
  type VerificationCase,
} from '@ecoma-io/llm-seller-governance-domain';

const OWNER_SUB = 'bootstrap-superadmin-sub';
const ACTOR = 'ecoma-bootstrap';

/** Fixture hồ sơ pháp lý/thuế — mô phỏng hồ sơ authoritative Ecoma-io (thật nằm ngoài repo). */
const GOVERNANCE_FACTS = {
  legalName: 'Ecoma-io Company Limited',
  legalType: 'company',
  jurisdiction: 'VN',
  registrationReference: '0312345678',
  taxResidency: 'VN',
  taxIdentifier: 'PQN0312345678',
  declarationReference: 'tax-declaration-2026-01',
};

/** Fixture provenance evidence: con trỏ + hash của tài liệu thật ngoài repo. */
const EVIDENCE_FACTS = {
  legalStorageRef: 'vault://ecoma-authoritative/legal-profile-2026.pdf',
  legalContentHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  taxStorageRef: 'vault://ecoma-authoritative/tax-declaration-2026.pdf',
  taxContentHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
};

let db: LlmApiDatabase;

beforeAll(async () => {
  db = await startLlmApiDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

/** NẠT Result của domain: !ok là ném với mã lỗi domain — không nuốt im lặng. */
function okOrThrow<Value>(
  result: { ok: true; value: Value } | { ok: false; error: LlmGovernanceDomainError },
): Value {
  if (!result.ok) {
    throw new Error(`domain operation rejected: ${result.error}`);
  }
  return result.value;
}

/** Env đầy đủ cho một run 8a. */
function governanceEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ECOMA_SELLER_TENANT_OWNER_SUB: OWNER_SUB,
    ECOMA_GOVERNANCE_ACTOR: ACTOR,
    ECOMA_FIRST_PARTY_LEGAL_NAME: GOVERNANCE_FACTS.legalName,
    ECOMA_FIRST_PARTY_LEGAL_TYPE: GOVERNANCE_FACTS.legalType,
    ECOMA_FIRST_PARTY_JURISDICTION: GOVERNANCE_FACTS.jurisdiction,
    ECOMA_FIRST_PARTY_REGISTRATION_REFERENCE: GOVERNANCE_FACTS.registrationReference,
    ECOMA_FIRST_PARTY_TAX_RESIDENCY: GOVERNANCE_FACTS.taxResidency,
    ECOMA_FIRST_PARTY_TAX_IDENTIFIER: GOVERNANCE_FACTS.taxIdentifier,
    ECOMA_FIRST_PARTY_DECLARATION_REFERENCE: GOVERNANCE_FACTS.declarationReference,
    ECOMA_LEGAL_EVIDENCE_STORAGE_REF: EVIDENCE_FACTS.legalStorageRef,
    ECOMA_LEGAL_EVIDENCE_CONTENT_HASH: EVIDENCE_FACTS.legalContentHash,
    ECOMA_TAX_EVIDENCE_STORAGE_REF: EVIDENCE_FACTS.taxStorageRef,
    ECOMA_TAX_EVIDENCE_CONTENT_HASH: EVIDENCE_FACTS.taxContentHash,
    ...overrides,
  };
}

function runGovernance(env: Record<string, string>) {
  return runBootstrapCli({
    script: 'db/bootstrap-seller-governance.mts',
    databaseUrl: migratorUrl('gateway', db.host, db.port),
    env,
  });
}

/** Trích dòng máy đọc `KEY=value` cuối cùng từ stdout. */
function stdoutLine(stdout: string, key: string): string {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(`${key}=`));
  if (line === undefined) {
    throw new Error(`stdout must carry a ${key}= line; got: ${stdout}`);
  }
  return line.slice(key.length + 1);
}

interface GatewayClientRow {
  id: string;
  name: string;
  classification: string;
  owner_sub: string;
}

/** Ghép principal từ DB thành aggregate — cùng shape runner dùng. */
async function readPrincipalFromDb(): Promise<FirstPartyLegalPrincipal> {
  const client = await db.connectAsMigrator('gateway');
  try {
    const principalResult = await client.query<{
      principal_id: string;
      status: string;
      status_changed_at: string | null;
      status_changed_by: string | null;
      created_at: string;
      created_by: string;
    }>(
      'SELECT principal_id, status, status_changed_at, status_changed_by, created_at, created_by FROM llm_seller.legal_principals WHERE principal_id = $1',
      [LEGAL_PRINCIPAL_ID],
    );
    const principalRow = principalResult.rows[0];
    expect(principalRow, 'principal row must exist').toBeDefined();
    const legalResult = await client.query<{
      principal_id: string;
      version: string;
      legal_name: string;
      legal_type: string;
      jurisdiction: string;
      registration_reference: string;
      effective_from: string;
      recorded_at: string;
      recorded_by: string;
    }>(
      'SELECT principal_id, version, legal_name, legal_type, jurisdiction, registration_reference, effective_from, recorded_at, recorded_by FROM llm_seller.principal_legal_profiles WHERE principal_id = $1 ORDER BY version',
      [LEGAL_PRINCIPAL_ID],
    );
    const taxResult = await client.query<{
      principal_id: string;
      version: string;
      tax_residency: string;
      tax_identifier: string;
      declaration_reference: string;
      effective_from: string;
      recorded_at: string;
      recorded_by: string;
    }>(
      'SELECT principal_id, version, tax_residency, tax_identifier, declaration_reference, effective_from, recorded_at, recorded_by FROM llm_seller.principal_tax_profiles WHERE principal_id = $1 ORDER BY version',
      [LEGAL_PRINCIPAL_ID],
    );
    const candidate = {
      principalId: principalRow.principal_id,
      status: principalRow.status,
      legalProfileVersions: legalResult.rows.map((row) => ({
        principalId: row.principal_id,
        version: Number(row.version),
        legalName: row.legal_name,
        legalType: row.legal_type,
        jurisdiction: row.jurisdiction,
        registrationReference: row.registration_reference,
        effectiveFrom: Number(row.effective_from),
        recordedAt: Number(row.recorded_at),
        recordedBy: row.recorded_by,
      })),
      taxProfileVersions: taxResult.rows.map((row) => ({
        principalId: row.principal_id,
        version: Number(row.version),
        taxResidency: row.tax_residency,
        taxIdentifier: row.tax_identifier,
        declarationReference: row.declaration_reference,
        effectiveFrom: Number(row.effective_from),
        recordedAt: Number(row.recorded_at),
        recordedBy: row.recorded_by,
      })),
      statusChangedAt:
        principalRow.status_changed_at === null ? null : Number(principalRow.status_changed_at),
      statusChangedBy: principalRow.status_changed_by,
      createdAt: Number(principalRow.created_at),
      createdBy: principalRow.created_by,
    };
    if (!isFirstPartyLegalPrincipal(candidate)) {
      throw new Error('stored principal failed the domain shape guard');
    }
    return candidate;
  } finally {
    await client.end();
  }
}

/** Ghép association từ DB. */
async function readAssociationFromDb(): Promise<PrincipalAssociation> {
  const client = await db.connectAsMigrator('gateway');
  try {
    const result = await client.query<{
      tenant_id: string;
      principal_id: string;
      accepted_legal_profile_version: string;
      accepted_tax_profile_version: string;
      established_at: string;
      established_by: string;
      last_accepted_at: string;
      last_accepted_by: string;
    }>(
      'SELECT tenant_id, principal_id, accepted_legal_profile_version, accepted_tax_profile_version, established_at, established_by, last_accepted_at, last_accepted_by FROM llm_seller.principal_associations WHERE tenant_id = $1',
      [SELLER_TENANT_ID],
    );
    const row = result.rows[0];
    expect(row, 'association row must exist').toBeDefined();
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
  } finally {
    await client.end();
  }
}

/** deriveOperationalEligibility lắp từ durable state — cùng cách runner tự kiểm. */
async function deriveEligibilityFromDb(now: number) {
  const principal = await readPrincipalFromDb();
  const association = await readAssociationFromDb();
  const currentLegal = principalLegalProfileVersionAt(principal, now);
  const currentTax = principalTaxProfileVersionAt(principal, now);
  const approvedCoverage: PrincipalApprovedCoverage = {
    legal: currentLegal?.version ?? 0,
    tax: currentTax?.version ?? 0,
  };
  const assessment = { principal, association, approvedCoverage, assessedAt: now };
  expect(isPrincipalAssessment(assessment)).toBe(true);
  const client = await db.connectAsMigrator('gateway');
  try {
    const restrictionRows = await client.query<{
      id: string;
      tenant_id: string;
      policy: string;
      public_reason: string;
      internal_reason: string;
      scope_kind: string;
      capability: string | null;
      activates_at: string;
      expires_at: string | null;
      lifted_at: string | null;
      appeal_deadline: string | null;
    }>(
      'SELECT id, tenant_id, policy, public_reason, internal_reason, scope_kind, capability, activates_at, expires_at, lifted_at, appeal_deadline FROM llm_seller.restriction_records WHERE tenant_id = $1',
      [SELLER_TENANT_ID],
    );
    const restrictions = okOrThrow(
      evaluateRestrictions({
        tenantId: SELLER_TENANT_ID,
        records: restrictionRows.rows.map((row) => ({
          id: row.id,
          tenantId: row.tenant_id,
          policy: row.policy,
          publicReason: row.public_reason,
          internalReason: row.internal_reason,
          scope:
            row.scope_kind === 'capability'
              ? { kind: 'capability', capability: row.capability ?? '' }
              : { kind: 'tenant' },
          activatesAt: Number(row.activates_at),
          expiresAt: row.expires_at === null ? null : Number(row.expires_at),
          liftedAt: row.lifted_at === null ? null : Number(row.lifted_at),
          appealDeadline: row.appeal_deadline === null ? null : Number(row.appeal_deadline),
        })),
        policies: {},
        target: { kind: 'tenant' },
        now,
      }),
    );
    const verdict = okOrThrow(
      deriveOperationalEligibility({
        tenantId: SELLER_TENANT_ID,
        tenantClassification: 'first_party',
        principalAssessment: assessment,
        restrictions,
        cases: [],
        requiredTypes: BOOTSTRAP_REQUIRED_TYPES,
        now,
        profileAxes: BOOTSTRAP_PROFILE_AXES,
      }),
    );
    return verdict;
  } finally {
    await client.end();
  }
}

/** Tạo + nộp + xét + duyệt một case principal-scoped trên một trục, qua domain ops thật. */
async function approveCaseOnAxis(options: {
  principal: FirstPartyLegalPrincipal;
  caseId: string;
  caseType: 'legal-identity' | 'tax';
  evidenceId: string;
  otherAxisCoverage: PrincipalCoverageSnapshot;
  now: number;
}): Promise<{ pinnedVersion: number; principal: FirstPartyLegalPrincipal }> {
  const client = await db.connectAsMigrator('gateway');
  try {
    const caseCreated = okOrThrow(
      createVerificationCase({
        id: options.caseId,
        principalId: LEGAL_PRINCIPAL_ID,
        type: options.caseType,
        createdAt: options.now,
      }),
    );
    const evidence = await client.query<{
      id: string;
      principal_id: string;
      kind: string;
      storage_ref: string;
      content_hash: string;
      recorded_at: string;
      recorded_by: string;
    }>(
      'SELECT id, principal_id, kind, storage_ref, content_hash, recorded_at, recorded_by FROM llm_seller.principal_evidence WHERE id = $1',
      [options.evidenceId],
    );
    const evidenceRow = evidence.rows[0];
    expect(evidenceRow).toBeDefined();
    const submitted = okOrThrow(
      submitPrincipalVerificationCase({
        verificationCase: caseCreated,
        submissionId: `${options.caseId}-submission-1`,
        evidence: [
          {
            id: evidenceRow.id,
            principalId: evidenceRow.principal_id,
            kind: evidenceRow.kind,
            storageRef: evidenceRow.storage_ref,
            contentHash: evidenceRow.content_hash,
            recordedAt: Number(evidenceRow.recorded_at),
            recordedBy: evidenceRow.recorded_by,
          },
        ],
        submittedBy: ACTOR,
        submittedAt: options.now,
      }),
    );
    const underReview = okOrThrow(
      startVerificationReview({
        verificationCase: submitted,
        reviewer: ACTOR,
        reviewedAt: options.now,
      }),
    );
    const decision = okOrThrow(
      decideVerification({
        verificationCase: underReview,
        decision: 'approved',
        decidedBy: ACTOR,
        decidedAt: options.now,
        profileAxes: BOOTSTRAP_PROFILE_AXES,
        principal: options.principal,
        principalCoverage: options.otherAxisCoverage,
      }),
    );
    const decisionCase: VerificationCase = decision.verificationCase;
    expect(isVerificationCase(decisionCase)).toBe(true);
    const axis = options.caseType === 'legal-identity' ? 'legal' : 'tax';
    const pinnedVersion = decisionCase.verifiedProfileVersions.find(
      (pin) => pin.axis === axis,
    )?.version;
    expect(pinnedVersion).toBeDefined();
    await client.query(
      `INSERT INTO llm_seller.verification_cases
         (id, tenant_id, principal_id, type, status, created_at, submitted_at, reviewed_at, reviewed_by,
          decided_at, decided_by, expires_at, expired_at, public_decision_reason, verified_profile_versions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        decisionCase.id,
        decisionCase.tenantId,
        decisionCase.principalId,
        decisionCase.type,
        decisionCase.status,
        decisionCase.createdAt,
        decisionCase.submittedAt,
        decisionCase.reviewedAt,
        decisionCase.reviewedBy,
        decisionCase.decidedAt,
        decisionCase.decidedBy,
        decisionCase.expiresAt,
        decisionCase.expiredAt,
        decisionCase.publicDecisionReason,
        JSON.stringify(decisionCase.verifiedProfileVersions),
      ],
    );
    await client.query(
      `INSERT INTO llm_seller.verification_submissions (case_id, id, tenant_id, principal_id, evidence_ids, submitted_by, submitted_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (case_id, id) DO NOTHING`,
      [
        decisionCase.id,
        submitted.submissions[submitted.submissions.length - 1].id,
        submitted.tenantId,
        submitted.principalId,
        JSON.stringify(submitted.submissions[submitted.submissions.length - 1].evidenceIds),
        ACTOR,
        options.now,
      ],
    );
    return {
      pinnedVersion: pinnedVersion as number,
      principal: decision.legalPrincipal ?? options.principal,
    };
  } finally {
    await client.end();
  }
}

describe('bootstrap runner 8a (seller governance) on real PostgreSQL', () => {
  it('seeds the canonical tenant, principal, real approvals and association with an eligible verdict', async () => {
    const result = await runGovernance(governanceEnv());
    const verdict = JSON.parse(stdoutLine(result.stdout, 'SELLER_ELIGIBILITY_VERDICT')) as {
      tenantId: string;
      eligible: boolean;
      blockers: string[];
    };
    expect(verdict.tenantId).toBe(SELLER_TENANT_ID);
    expect(verdict.eligible).toBe(true);
    expect(verdict.blockers).toEqual([]);
    expect(stdoutLine(result.stdout, 'SELLER_GOVERNANCE_RESULT')).toContain('"outcome":"created"');

    const client = await db.connectAsMigrator('gateway');
    try {
      // Tenant canonical: đúng một owner, classification first_party, tên khóa.
      const tenants = await client.query<GatewayClientRow>(
        'SELECT id, name, classification, owner_sub FROM llm_seller.seller_tenants',
      );
      expect(tenants.rows).toHaveLength(1);
      expect(tenants.rows[0]).toMatchObject({
        id: SELLER_TENANT_ID,
        name: CANONICAL_SELLER_TENANT_NAME,
        classification: 'first_party',
        owner_sub: OWNER_SUB,
      });
      // Tên `ecoma` không bao giờ tồn tại trong llm-seller-tenant (ADR-0027 §2).
      const ecoma = await client.query('SELECT id FROM llm_seller.seller_tenants WHERE name = $1', [
        'ecoma',
      ]);
      expect(ecoma.rows).toHaveLength(0);

      // Principal active với audit của quyết định kích hoạt.
      const principals = await client.query<{ status: string; status_changed_by: string | null }>(
        'SELECT status, status_changed_by FROM llm_seller.legal_principals WHERE principal_id = $1',
        [LEGAL_PRINCIPAL_ID],
      );
      expect(principals.rows[0]).toMatchObject({ status: 'active', status_changed_by: ACTOR });

      // Hai case principal-scoped approved thật, đúng pin version 1, có attribution.
      const cases = await client.query<{
        id: string;
        type: string;
        status: string;
        decided_by: string | null;
        verified_profile_versions: { axis: string; version: number }[];
      }>(
        'SELECT id, type, status, decided_by, verified_profile_versions FROM llm_seller.verification_cases ORDER BY id',
      );
      expect(cases.rows).toHaveLength(2);
      for (const row of cases.rows) {
        expect(row.status).toBe('approved');
        expect(row.decided_by).toBe(ACTOR);
      }
      expect(
        cases.rows.find((row) => row.type === 'legal-identity')?.verified_profile_versions,
      ).toEqual([{ axis: 'legal', version: 1 }]);
      expect(cases.rows.find((row) => row.type === 'tax')?.verified_profile_versions).toEqual([
        { axis: 'tax', version: 1 },
      ]);

      // Evidence provenance đọc lại được: con trỏ + hash đúng fixture.
      const evidence = await client.query<{ storage_ref: string; content_hash: string }>(
        'SELECT storage_ref, content_hash FROM llm_seller.principal_evidence ORDER BY id',
      );
      expect(evidence.rows).toHaveLength(2);
      expect(evidence.rows.map((row) => row.storage_ref).toSorted()).toEqual(
        [EVIDENCE_FACTS.legalStorageRef, EVIDENCE_FACTS.taxStorageRef].toSorted(),
      );

      // Association pin đúng cặp revision 1, audit actor đúng.
      const associations = await client.query<{
        accepted_legal_profile_version: string;
        accepted_tax_profile_version: string;
        established_by: string;
      }>(
        'SELECT accepted_legal_profile_version, accepted_tax_profile_version, established_by FROM llm_seller.principal_associations',
      );
      expect(associations.rows).toHaveLength(1);
      expect(associations.rows[0]).toMatchObject({
        accepted_legal_profile_version: '1',
        accepted_tax_profile_version: '1',
        established_by: ACTOR,
      });

      // Một dòng audit outcome created, không chứa giá trị secret nào.
      const audit = await client.query<{ outcome: string; detail: string }>(
        'SELECT outcome, detail::text AS detail FROM llm_seller.bootstrap_audit',
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].outcome).toBe('created');
      expect(audit.rows[0].detail).not.toMatch(/sha256:/u);
    } finally {
      await client.end();
    }
  });

  it('reruns as a no-op without touching decided state', async () => {
    const before = await db.connectAsMigrator('gateway');
    const decidedBefore = await before.query<{ decided_at: string | null }>(
      'SELECT decided_at FROM llm_seller.verification_cases ORDER BY id',
    );
    await before.end();

    const result = await runGovernance(governanceEnv());
    expect(stdoutLine(result.stdout, 'SELLER_GOVERNANCE_RESULT')).toContain('"outcome":"no-op"');
    const verdict = JSON.parse(stdoutLine(result.stdout, 'SELLER_ELIGIBILITY_VERDICT')) as {
      eligible: boolean;
    };
    expect(verdict.eligible).toBe(true);

    const client = await db.connectAsMigrator('gateway');
    try {
      const decidedAfter = await client.query<{ decided_at: string | null }>(
        'SELECT decided_at FROM llm_seller.verification_cases ORDER BY id',
      );
      expect(decidedAfter.rows).toEqual(decidedBefore.rows);
      const audit = await client.query<{ outcome: string }>(
        'SELECT outcome FROM llm_seller.bootstrap_audit ORDER BY id',
      );
      expect(audit.rows.map((row) => row.outcome)).toEqual(['created', 'no-op']);
    } finally {
      await client.end();
    }
  });

  it('rejects a divergent owner sub fail-closed (ownership is immutable)', async () => {
    await expect(
      runGovernance(governanceEnv({ ECOMA_SELLER_TENANT_OWNER_SUB: 'bootstrap-someone-else' })),
    ).rejects.toThrow(/owner differs/u);
  });

  it('flips eligibility to false under a new restriction and never exempts the first_party classification', async () => {
    const now = Date.now();
    const client = await db.connectAsMigrator('gateway');
    try {
      await client.query(
        `INSERT INTO llm_seller.restriction_records
           (id, tenant_id, policy, public_reason, internal_reason, scope_kind, capability, activates_at, expires_at, lifted_at, appeal_deadline)
         VALUES ('restriction-bootstrap-hold', $1, 'abuse-hold', 'Under review', 'internal hold', 'tenant', NULL, $2, NULL, NULL, NULL)
         ON CONFLICT (id) DO NOTHING`,
        [SELLER_TENANT_ID, now - 1_000],
      );
    } finally {
      await client.end();
    }
    // Cả runner lẫn derive đều fail-closed: restriction áp cho seller first_party
    // như mọi seller — classification không phải exemption (ADR-0026 §4).
    await expect(runGovernance(governanceEnv())).rejects.toThrow(/not operationally eligible/u);
    const verdict = await deriveEligibilityFromDb(Date.now());
    expect(verdict.eligible).toBe(false);
    expect(verdict.blockers).toContain('restriction');

    const cleanup = await db.connectAsMigrator('gateway');
    try {
      await cleanup.query(
        `DELETE FROM llm_seller.restriction_records WHERE id = 'restriction-bootstrap-hold'`,
      );
    } finally {
      await cleanup.end();
    }
    const recovery = await runGovernance(governanceEnv());
    expect(stdoutLine(recovery.stdout, 'SELLER_GOVERNANCE_RESULT')).toContain('"outcome":"no-op"');
  });

  it('flips eligibility false on expired verification, then false on a new principal revision, then true after a new approved case', async () => {
    const now = Date.now();
    // (1) Verification hết hiệu lực: principal quay về reverification_required
    // (mô phỏng đúng hệ quả của expiry §5) ⇒ eligible false, blocker verification.
    const expiredClient = await db.connectAsMigrator('gateway');
    try {
      await expiredClient.query(
        `UPDATE llm_seller.legal_principals
         SET status = 'reverification_required', status_changed_at = $2, status_changed_by = $3
         WHERE principal_id = $1`,
        [LEGAL_PRINCIPAL_ID, now, ACTOR],
      );
    } finally {
      await expiredClient.end();
    }
    const expiredVerdict = await deriveEligibilityFromDb(now);
    expect(expiredVerdict.eligible).toBe(false);
    expect(expiredVerdict.blockers).toContain('verification');

    // (2) Revision profile mới của principal (publish mới, effectiveFrom tăng) ⇒
    // coverage cũ (v1) mất hiệu lực, association pin stale ⇒ blocker verification
    // — principal-wide qua profile validity, không case/approval cũ nào cứu được.
    const principalBeforeAppend = await readPrincipalFromDb();
    const appendedLegal = okOrThrow(
      appendPrincipalLegalProfileVersion({
        principal: principalBeforeAppend,
        legalName: GOVERNANCE_FACTS.legalName,
        legalType: GOVERNANCE_FACTS.legalType,
        jurisdiction: GOVERNANCE_FACTS.jurisdiction,
        registrationReference: GOVERNANCE_FACTS.registrationReference,
        effectiveFrom: now + 2_000,
        recordedAt: now,
        recordedBy: ACTOR,
      }),
    );
    const appendedTax = okOrThrow(
      appendPrincipalTaxProfileVersion({
        principal: appendedLegal,
        taxResidency: GOVERNANCE_FACTS.taxResidency,
        taxIdentifier: GOVERNANCE_FACTS.taxIdentifier,
        declarationReference: GOVERNANCE_FACTS.declarationReference,
        effectiveFrom: now + 2_000,
        recordedAt: now,
        recordedBy: ACTOR,
      }),
    );
    const principalV2 = appendedTax;
    expect(principalV2.status).toBe('reverification_required');
    const appendClient = await db.connectAsMigrator('gateway');
    try {
      const legalV2 = principalV2.legalProfileVersions[principalV2.legalProfileVersions.length - 1];
      const taxV2 = principalV2.taxProfileVersions[principalV2.taxProfileVersions.length - 1];
      expect(legalV2.version).toBe(2);
      expect(taxV2.version).toBe(2);
      await appendClient.query(
        `INSERT INTO llm_seller.principal_legal_profiles
           (principal_id, version, legal_name, legal_type, jurisdiction, registration_reference, effective_from, recorded_at, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (principal_id, version) DO NOTHING`,
        [
          legalV2.principalId,
          legalV2.version,
          legalV2.legalName,
          legalV2.legalType,
          legalV2.jurisdiction,
          legalV2.registrationReference,
          legalV2.effectiveFrom,
          legalV2.recordedAt,
          legalV2.recordedBy,
        ],
      );
      await appendClient.query(
        `INSERT INTO llm_seller.principal_tax_profiles
           (principal_id, version, tax_residency, tax_identifier, declaration_reference, effective_from, recorded_at, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (principal_id, version) DO NOTHING`,
        [
          taxV2.principalId,
          taxV2.version,
          taxV2.taxResidency,
          taxV2.taxIdentifier,
          taxV2.declarationReference,
          taxV2.effectiveFrom,
          taxV2.recordedAt,
          taxV2.recordedBy,
        ],
      );
      await appendClient.query(
        `UPDATE llm_seller.legal_principals
         SET status = 'reverification_required', status_changed_at = $2, status_changed_by = $3
         WHERE principal_id = $1`,
        [LEGAL_PRINCIPAL_ID, now, ACTOR],
      );
    } finally {
      await appendClient.end();
    }
    const staleVerdict = await deriveEligibilityFromDb(now + 3_000);
    expect(staleVerdict.eligible).toBe(false);
    expect(staleVerdict.blockers).toContain('verification');

    // (3) Case mới approved trên version mới (review thật, pin v2) ⇒ principal
    // active lại, association accept cặp mới ⇒ eligible TRUE trở lại.
    const legalDecision = await approveCaseOnAxis({
      principal: principalV2,
      caseId: 'verification-case-ecoma-io-legal-identity-v2',
      caseType: 'legal-identity',
      evidenceId: 'evidence-ecoma-io-legal-identity',
      otherAxisCoverage: {},
      now: now + 4_000,
    });
    expect(legalDecision.pinnedVersion).toBe(2);
    const taxDecision = await approveCaseOnAxis({
      principal: legalDecision.principal,
      caseId: 'verification-case-ecoma-io-tax-v2',
      caseType: 'tax',
      evidenceId: 'evidence-ecoma-io-tax',
      otherAxisCoverage: { legal: legalDecision.pinnedVersion },
      now: now + 4_000,
    });
    expect(taxDecision.principal.status).toBe('active');
    const association = await readAssociationFromDb();
    const accepted = okOrThrow(
      acceptPrincipalRevision({
        association,
        principal: taxDecision.principal,
        approvedCoverage: { legal: legalDecision.pinnedVersion, tax: taxDecision.pinnedVersion },
        acceptedBy: ACTOR,
        acceptedAt: now + 4_000,
      }),
    );
    const acceptClient = await db.connectAsMigrator('gateway');
    try {
      await acceptClient.query(
        `UPDATE llm_seller.legal_principals
         SET status = $2, status_changed_at = $3, status_changed_by = $4
         WHERE principal_id = $1`,
        [
          LEGAL_PRINCIPAL_ID,
          taxDecision.principal.status,
          taxDecision.principal.statusChangedAt,
          taxDecision.principal.statusChangedBy,
        ],
      );
      await acceptClient.query(
        `UPDATE llm_seller.principal_associations
         SET accepted_legal_profile_version = $2, accepted_tax_profile_version = $3,
             last_accepted_at = $4, last_accepted_by = $5
         WHERE tenant_id = $1`,
        [
          SELLER_TENANT_ID,
          accepted.acceptedLegalProfileVersion,
          accepted.acceptedTaxProfileVersion,
          accepted.lastAcceptedAt,
          accepted.lastAcceptedBy,
        ],
      );
    } finally {
      await acceptClient.end();
    }
    const recoveredVerdict = await deriveEligibilityFromDb(now + 5_000);
    expect(recoveredVerdict.eligible).toBe(true);
    expect(recoveredVerdict.blockers).toEqual([]);
  });

  it('blocks reseeding after the tenant row is removed while its association remains (name stays reserved)', async () => {
    // Đặt cuối file: xoá tenant + association nhưng GIỮ principal/cases/evidence —
    // đúng kịch bản "xoá rồi seed lại": bootstrap phải chặn, không resurrect.
    const teardown = await db.connectAsMigrator('gateway');
    try {
      await teardown.query('DELETE FROM llm_seller.principal_associations WHERE tenant_id = $1', [
        SELLER_TENANT_ID,
      ]);
      await teardown.query('DELETE FROM llm_seller.seller_tenants WHERE id = $1', [
        SELLER_TENANT_ID,
      ]);
    } finally {
      await teardown.end();
    }
    await expect(runGovernance(governanceEnv())).rejects.toThrow(/stays reserved/u);
  });
});
