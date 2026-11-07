/**
 * Ghim semantics suspension: nhiều record độc lập, hiệu lực suy ra tại một thời
 * điểm, biên nửa mở, scope không rò rỉ, và policy lạ fail closed.
 *
 * Không có `tenant.status = suspended` trong lib: mọi khẳng định "bị chặn" đều
 * được kiểm qua {@link evaluateSuspensions}.
 */

import { describe, expect, it } from 'vitest';

import { createTenantId } from './shared';
import { createWorkspace, type Workspace } from './workspace';
import {
  createSuspensionRecord,
  evaluateSuspensions,
  isSuspensionEffective,
  type CreateSuspensionRecordInput,
  type EvaluateSuspensionsInput,
  type SuspensionPolicyDefinition,
  type SuspensionRecord,
  type SuspensionScope,
} from './suspension';

const TENANT_ID = createTenantId('tnt_acme');

const BILLING_POLICY = 'billing_hold';
const SECURITY_POLICY = 'security_review';
const INFORMATIONAL_POLICY = 'informational_note';

const POLICIES: SuspensionPolicyDefinition[] = [
  { id: BILLING_POLICY, restrictive: true },
  { id: SECURITY_POLICY, restrictive: true },
  { id: INFORMATIONAL_POLICY, restrictive: false },
];

const MAIN: Workspace = (() => {
  const result = createWorkspace({
    id: 'wsp_main',
    tenantId: 'tnt_acme',
    name: 'Main',
    createdAt: 0,
  });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
})();

const SIBLING: Workspace = (() => {
  const result = createWorkspace({
    id: 'wsp_sibling',
    tenantId: 'tnt_acme',
    name: 'Sibling',
    createdAt: 0,
  });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
})();

let recordSequence = 0;

function record(overrides: Partial<CreateSuspensionRecordInput> = {}): SuspensionRecord {
  recordSequence += 1;
  const result = createSuspensionRecord({
    id: `susp_${recordSequence}`,
    tenantId: TENANT_ID,
    policy: BILLING_POLICY,
    reason: 'invoice_overdue',
    scope: { kind: 'tenant' },
    activatesAt: 1_000,
    expiresAt: null,
    liftedAt: null,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`fixture is invalid: ${result.error.code}`);
  }
  return result.value;
}

function workspaceScope(workspaceId: string): SuspensionScope {
  return { kind: 'workspace', workspaceId: workspaceId as never };
}

function evaluate(
  overrides: Partial<EvaluateSuspensionsInput> & { records: readonly SuspensionRecord[] },
): ReturnType<typeof evaluateSuspensions> {
  return evaluateSuspensions({
    tenantId: TENANT_ID,
    policies: POLICIES,
    target: { kind: 'tenant' },
    workspaces: [MAIN, SIBLING],
    now: 5_000,
    ...overrides,
  });
}

function blocked(
  records: readonly SuspensionRecord[],
  overrides: Partial<EvaluateSuspensionsInput> = {},
) {
  const result = evaluate({ records, ...overrides });
  if (!result.ok) {
    throw new Error(`unexpected failure: ${result.error.code}`);
  }
  return result.value.blocked;
}

describe('independence of suspension records', () => {
  it('lets multiple active suspensions coexist', () => {
    const billing = record({ policy: BILLING_POLICY });
    const security = record({ policy: SECURITY_POLICY });
    const result = evaluate({ records: [billing, security] });
    if (!result.ok) {
      throw new Error('evaluation must not fail');
    }
    expect(result.value.blocked).toBe(true);
    expect([...result.value.blockingRecordIds].toSorted()).toEqual(
      [billing.id, security.id].toSorted(),
    );
  });

  it('does not lift another suspension when one is lifted', () => {
    const billing = record({ policy: BILLING_POLICY });
    const security = record({ policy: SECURITY_POLICY });
    const liftedBilling = record({ policy: BILLING_POLICY, liftedAt: 4_000 });
    // Lift record billing không đụng record security.
    expect(blocked([liftedBilling, security])).toBe(true);
    // Nếu tất cả record restrictive đều lift, mới hết bị chặn.
    expect(blocked([liftedBilling, record({ policy: SECURITY_POLICY, liftedAt: 4_000 })])).toBe(
      false,
    );
    expect(blocked([liftedBilling])).toBe(false);
    // Record gốc vẫn hiệu lực trong tập khác — hai record độc lập.
    expect(blocked([billing])).toBe(true);
  });

  it('keeps a record that only records information from blocking', () => {
    expect(blocked([record({ policy: INFORMATIONAL_POLICY })])).toBe(false);
  });
});

describe('effective evaluation', () => {
  it('does not block before the record becomes effective', () => {
    expect(blocked([record({ activatesAt: 6_000 })], { now: 5_000 })).toBe(false);
    expect(blocked([record({ activatesAt: 5_000 })], { now: 5_000 })).toBe(true);
  });

  it('stops blocking once the record has expired', () => {
    expect(blocked([record({ activatesAt: 1_000, expiresAt: 5_000 })], { now: 5_000 })).toBe(false);
    expect(blocked([record({ activatesAt: 1_000, expiresAt: 5_001 })], { now: 5_000 })).toBe(true);
  });

  it('stops blocking once the record is lifted, unless the lift is scheduled in the future', () => {
    expect(blocked([record({ liftedAt: 5_000 })], { now: 5_000 })).toBe(false);
    expect(blocked([record({ liftedAt: 5_001 })], { now: 5_000 })).toBe(true);
  });

  it('treats a record with no expiry as effective until lifted', () => {
    const openEnded = record({ expiresAt: null });
    expect(isSuspensionEffective(openEnded, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('blocks when one record expired while another is still effective', () => {
    const expired = record({ policy: BILLING_POLICY, expiresAt: 2_000 });
    const active = record({ policy: SECURITY_POLICY });
    const result = evaluate({ records: [expired, active] });
    if (!result.ok) {
      throw new Error('evaluation must not fail');
    }
    expect(result.value.blockingRecordIds).toEqual([active.id]);
  });
});

describe('scope matching', () => {
  it('does not block unrelated operations when scope is a different workspace', () => {
    const onMain = record({ scope: workspaceScope('wsp_main') });
    expect(blocked([onMain], { target: { kind: 'workspace', workspaceId: 'wsp_main' } })).toBe(
      true,
    );
    expect(blocked([onMain], { target: { kind: 'workspace', workspaceId: 'wsp_sibling' } })).toBe(
      false,
    );
  });

  it('does not apply a workspace-scoped record to the tenant as a whole', () => {
    expect(
      blocked([record({ scope: workspaceScope('wsp_main') })], { target: { kind: 'tenant' } }),
    ).toBe(false);
  });

  it('applies a tenant-scoped record to tenant and workspace targets', () => {
    const tenantWide = record({ scope: { kind: 'tenant' } });
    expect(blocked([tenantWide], { target: { kind: 'tenant' } })).toBe(true);
    expect(blocked([tenantWide], { target: { kind: 'workspace', workspaceId: 'wsp_main' } })).toBe(
      true,
    );
  });

  it('fails closed when the target workspace belongs to another tenant', () => {
    expect(
      evaluate({
        records: [],
        target: { kind: 'workspace', workspaceId: 'wsp_foreign' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'workspace_not_in_tenant' } });
  });
});

describe('policy evaluation fails closed', () => {
  it('blocks on an unknown policy rather than assuming it is harmless', () => {
    const unknown = record({ policy: 'policy_not_configured' });
    const result = evaluate({ records: [unknown] });
    if (!result.ok) {
      throw new Error('evaluation must not fail');
    }
    expect(result.value.blocked).toBe(true);
    expect(result.value.unknownPolicies).toEqual(['policy_not_configured']);
  });

  it('marks an unknown policy as unevaluable as well as blocking', () => {
    const result = evaluate({ records: [record({ policy: 'policy_not_configured' })] });
    if (!result.ok) {
      throw new Error('evaluation must not fail');
    }
    expect(result.value.unevaluable).toBe(true);
    expect(result.value.unknownPolicies).toEqual(['policy_not_configured']);
  });

  it('reports a fully evaluated allow as neither blocked nor unevaluable', () => {
    const result = evaluate({ records: [record({ liftedAt: 4_000 })] });
    if (!result.ok) {
      throw new Error('evaluation must not fail');
    }
    expect(result.value).toMatchObject({ blocked: false, unevaluable: false, unknownPolicies: [] });
  });

  it('does not let an unknown policy be normalized into allow by an empty policy list', () => {
    expect(blocked([record({ policy: 'whatever' })], { policies: [] })).toBe(true);
  });

  it('blocks when the policy list is structurally unreadable', () => {
    // Policy entry hỏng không được coi là "restrictive: false" — nó không được
    // ghi vào map, nên policy của record thành unknown ⇒ vẫn chặn.
    expect(
      blocked([record()], {
        policies: [{ id: '', restrictive: true }, null as unknown as SuspensionPolicyDefinition],
      }),
    ).toBe(true);
  });
});

describe('evaluation refuses malformed input instead of allowing', () => {
  it('refuses records belonging to another tenant', () => {
    expect(
      evaluate({ records: [record({ tenantId: createTenantId('tnt_other') as never })] }),
    ).toMatchObject({ ok: false, error: { code: 'inconsistent_context' } });
  });

  it('refuses a malformed record shape', () => {
    expect(
      evaluate({ records: [{ ...record(), activatesAt: Number.NaN } as SuspensionRecord] }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_suspension_record' } });
  });

  it('refuses a non-finite evaluation instant', () => {
    for (const now of [undefined, null, Number.NaN, 1.5, '5000']) {
      expect(evaluate({ records: [], now })).toMatchObject({
        ok: false,
        error: { code: 'invalid_timestamp' },
      });
    }
  });

  it('refuses an ambiguous target', () => {
    expect(evaluate({ records: [], target: { kind: 'unknown' } as never })).toMatchObject({
      ok: false,
      error: { code: 'ambiguous_context' },
    });
    expect(evaluate({ records: [], target: null as never })).toMatchObject({
      ok: false,
      error: { code: 'ambiguous_context' },
    });
  });
});

describe('record construction', () => {
  it('rejects an expiry that is not after activation', () => {
    expect(
      createSuspensionRecord({
        id: 'susp_x',
        tenantId: TENANT_ID,
        policy: BILLING_POLICY,
        reason: 'invoice_overdue',
        scope: { kind: 'tenant' },
        activatesAt: 1_000,
        expiresAt: 1_000,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_suspension_window' } });
  });

  it('rejects a lift before activation', () => {
    expect(
      createSuspensionRecord({
        id: 'susp_x',
        tenantId: TENANT_ID,
        policy: BILLING_POLICY,
        reason: 'invoice_overdue',
        scope: { kind: 'tenant' },
        activatesAt: 1_000,
        liftedAt: 999,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_suspension_window' } });
  });

  it('rejects unreadable policy/reason identifiers', () => {
    expect(
      createSuspensionRecord({
        id: 'susp_x',
        tenantId: TENANT_ID,
        policy: '',
        reason: 'invoice_overdue',
        scope: { kind: 'tenant' },
        activatesAt: 1_000,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_suspension_record' } });
  });

  it('allows any open-ended reason identifier instead of a fixed catalog', () => {
    // Không có enum lý do trong lib: một định danh mới là dữ liệu cấu hình,
    // không phải thay đổi domain model.
    for (const reason of ['invoice_overdue', 'voluntary_pause', 'regulator_request_2026']) {
      const result = createSuspensionRecord({
        id: 'susp_x',
        tenantId: TENANT_ID,
        policy: BILLING_POLICY,
        reason,
        scope: { kind: 'tenant' },
        activatesAt: 1_000,
      });
      expect(result.ok).toBe(true);
    }
  });
});

describe('no second source of truth', () => {
  it('exposes no mutable suspended status anywhere in the evaluation result', () => {
    const result = evaluate({ records: [record()] });
    if (!result.ok) {
      throw new Error('evaluation must not fail');
    }
    expect(Object.hasOwn(result.value, 'status')).toBe(false);
    expect(Object.keys(result.value).toSorted()).toEqual([
      'blocked',
      'blockingRecordIds',
      'unevaluable',
      'unknownPolicies',
    ]);
  });
});
