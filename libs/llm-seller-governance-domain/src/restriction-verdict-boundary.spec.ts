import { describe, expect, it } from 'vitest';

import {
  createSellerTenantId,
  isSellerRestrictionVerdict,
  type SellerRestrictionVerdict,
} from '@ecoma-io/llm-seller-tenant-domain';
import { createRestrictionId } from './shared';
import {
  createRestrictionRecord,
  evaluateRestrictions,
  type RestrictionEvaluation,
} from './restriction';

/**
 * Ghim hợp đồng biên giữa governance (owner của evaluation) và tenant (consumer
 * của verdict).
 *
 * Tenant tự khai báo `SellerRestrictionVerdict` tại biên thay vì import
 * governance (ADR-0018). Spec này là chốt chặn hai chiều:
 * - **Compile-time**: `RestrictionEvaluation` phải assignable được vào
 *   `SellerRestrictionVerdict`; đổi shape một bên mà quên bên kia sẽ làm hỏng
 *   build.
 * - **Runtime**: output thật của `evaluateRestrictions` phải qua được guard của
 *   tenant, để guard không từ chối chính payload hợp lệ.
 */
const assignable: (value: RestrictionEvaluation) => SellerRestrictionVerdict = (value) => value;

const TENANT = createSellerTenantId('tenant-1');
const AT = 1_700_000_000_000;

describe('restriction verdict boundary', () => {
  it('exposes the governance evaluation as the verdict shape declared by the tenant', () => {
    const created = createRestrictionRecord({
      id: createRestrictionId('r-1'),
      tenantId: TENANT,
      policy: 'compliance',
      publicReason: 'Regulatory review in progress.',
      internalReason: 'Case INV-77.',
      scope: { kind: 'tenant' },
      activatesAt: AT,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const evaluated = evaluateRestrictions({
      tenantId: TENANT,
      records: [created.value],
      policies: { compliance: { restrictive: true } },
      target: { kind: 'tenant' },
      now: AT,
    });
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) {
      return;
    }
    const verdict = assignable(evaluated.value);
    expect(isSellerRestrictionVerdict(verdict)).toBe(true);
    expect(verdict.blocked).toBe(true);
    expect(verdict.unevaluable).toBe(false);
  });
});
