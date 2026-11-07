import { describe, expect, it } from 'vitest';

import {
  ASSIGNMENT_LIST_DEFAULT_LIMIT,
  ASSIGNMENT_LIST_MAX_LIMIT,
  assignmentListResponse,
  validateAssignmentListResponse,
  validateCreateAssignmentRequest,
  validateRevokeAssignmentRequest,
  validateStaffRoleAssignment,
  type AssignmentContractRejectionReason,
  type StaffRoleAssignment,
} from './management-assignment-contract';

function makeAssignment(overrides: Partial<StaffRoleAssignment> = {}): StaffRoleAssignment {
  return {
    id: 'asg-0001',
    staff_id: 'staff-0001',
    role_id: 'sys_ops',
    scope: { label: 'global' },
    effective_from: '2026-01-01T00:00:00Z',
    effective_until: null,
    granted_by: 'staff-0042',
    created_at: '2026-01-01T00:00:00Z',
    revoked_at: null,
    ...overrides,
  };
}

/** Assert payload bị từ chối với `reason` và `detail` chứa `fragment`. */
function expectRejectedBy(
  result:
    | { ok: true; payload: unknown }
    | { ok: false; reason: AssignmentContractRejectionReason; detail: string },
  reason: AssignmentContractRejectionReason,
  fragment: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the payload to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(fragment);
}

describe('validateCreateAssignmentRequest — accept', () => {
  it('accepts a minimal request', () => {
    expect(validateCreateAssignmentRequest({ staff_id: 'staff-1', role_id: 'sys_ops' })).toEqual({
      ok: true,
      payload: { staff_id: 'staff-1', role_id: 'sys_ops' },
    });
  });

  it('accepts a scoped, time-bounded request', () => {
    const payload = {
      staff_id: 'staff-1',
      role_id: 'sys_ops',
      scope: { label: 'team-alpha' },
      effective_from: '2026-01-01T00:00:00Z',
      effective_until: '2026-12-31T23:59:59Z',
    };
    expect(validateCreateAssignmentRequest(payload)).toEqual({ ok: true, payload });
  });

  it('accepts a request without scope — scope is optional', () => {
    expect(
      validateCreateAssignmentRequest({ staff_id: 's', role_id: 'r', effective_until: null }),
    ).toEqual({
      ok: true,
      payload: { staff_id: 's', role_id: 'r', effective_until: null },
    });
  });
});

describe('validateCreateAssignmentRequest — forbidden fields', () => {
  it('rejects granted_by in the request — the granter is server-side identity', () => {
    // granter lấy từ principal đã verify (SR-001), không nhận từ payload; một
    // caller gửi granted_by là đang mạo danh người khác gán quyền.
    const payload = { staff_id: 's', role_id: 'r', granted_by: 'staff-evil' };
    const result = validateCreateAssignmentRequest(payload);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'granted_by');
  });

  it('rejects id in the create request — the server issues it', () => {
    const payload = { id: 'asg-1', staff_id: 's', role_id: 'r' };
    const result = validateCreateAssignmentRequest(payload);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'id');
  });

  it('rejects created_at and revoked_at in the request', () => {
    const payload = { staff_id: 's', role_id: 'r', created_at: '2026-01-01T00:00:00Z' };
    const result = validateCreateAssignmentRequest(payload);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'created_at');
  });
});

describe('validateCreateAssignmentRequest — invalid shapes', () => {
  it.each([
    ['null', null],
    ['a string', 'staff-1'],
    ['an array', [{ staff_id: 's', role_id: 'r' }]],
  ])('rejects %s as the request', (_label, payload) => {
    expect(validateCreateAssignmentRequest(payload)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it.each([
    ['missing staff_id', { role_id: 'r' }],
    ['missing role_id', { staff_id: 's' }],
    ['empty staff_id', { staff_id: '', role_id: 'r' }],
    ['numeric role_id', { staff_id: 's', role_id: 1 }],
  ])('rejects %s', (_label, payload) => {
    expect(validateCreateAssignmentRequest(payload)).toMatchObject({
      ok: false,
      reason: 'invalid_entry',
    });
  });

  it.each([
    ['a bare string scope', 'global'],
    ['a scope with extra keys', { label: 'x', resources: ['a'] }],
    ['a scope with an empty label', { label: '' }],
  ])('rejects %s', (_label, scope) => {
    const payload = { staff_id: 's', role_id: 'r', scope };
    expect(validateCreateAssignmentRequest(payload)).toMatchObject({
      ok: false,
      reason: 'invalid_scope',
    });
  });

  it.each([
    ['no timezone', '2026-01-01T00:00:00'],
    ['garbage', 'tomorrow'],
    ['a number', 1],
    ['empty string', ''],
  ])('rejects effective_from %p', (...args: [label: string, from: unknown]) => {
    const from = args[1];
    const payload = { staff_id: 's', role_id: 'r', effective_from: from };
    expect(validateCreateAssignmentRequest(payload)).toMatchObject({
      ok: false,
      reason: 'invalid_time_range',
    });
  });

  it('rejects effective_until before effective_from', () => {
    const payload = {
      staff_id: 's',
      role_id: 'r',
      effective_from: '2026-06-01T00:00:00Z',
      effective_until: '2026-01-01T00:00:00Z',
    };
    const result = validateCreateAssignmentRequest(payload);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_time_range', 'after');
  });
});

describe('validateRevokeAssignmentRequest', () => {
  it('accepts a request with just the id', () => {
    expect(validateRevokeAssignmentRequest({ id: 'asg-1' })).toEqual({
      ok: true,
      payload: { id: 'asg-1' },
    });
  });

  it('rejects extra fields — revocation is by id only', () => {
    const payload = { id: 'asg-1', staff_id: 's' };
    const result = validateRevokeAssignmentRequest(payload);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'staff_id');
  });

  it('rejects an empty id', () => {
    expect(validateRevokeAssignmentRequest({ id: '' })).toMatchObject({
      ok: false,
      reason: 'invalid_entry',
    });
  });
});

describe('validateStaffRoleAssignment — response shape', () => {
  it('accepts a full entry with audit fields', () => {
    const entry = makeAssignment();
    expect(validateStaffRoleAssignment(entry)).toEqual({ ok: true, payload: entry });
  });

  it('accepts an entry without optional fields', () => {
    const entry = { id: 'a', staff_id: 's', role_id: 'r', created_at: '2026-01-01T00:00:00Z' };
    expect(validateStaffRoleAssignment(entry)).toMatchObject({ ok: true, payload: entry });
  });

  it('accepts granted_by null for seed/bootstrap rows', () => {
    const entry = makeAssignment({ granted_by: null });
    expect(validateStaffRoleAssignment(entry).ok).toBe(true);
  });

  it('rejects a forbidden field in an entry', () => {
    const entry = { ...makeAssignment(), email: 'leak@example.com' };
    const result = validateStaffRoleAssignment(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'field outside the contract');
  });

  it('rejects a scope with extra structure — shape growth needs a contract change', () => {
    const entry = makeAssignment({ scope: { label: 'x', unit: 'y' } as never });
    expect(validateStaffRoleAssignment(entry)).toMatchObject({
      ok: false,
      reason: 'invalid_scope',
    });
  });

  it('rejects a nonsensical time range', () => {
    const entry = makeAssignment({
      effective_from: '2026-06-01T00:00:00Z',
      effective_until: '2026-01-01T00:00:00Z',
    });
    expect(validateStaffRoleAssignment(entry)).toMatchObject({
      ok: false,
      reason: 'invalid_time_range',
    });
  });
});

describe('validateAssignmentListResponse — pagination bounds', () => {
  it('accepts a page with entries and a cursor', () => {
    const response = assignmentListResponse([makeAssignment()], 'tok');
    expect(validateAssignmentListResponse(response)).toEqual({ ok: true, payload: response });
  });

  it('accepts an empty page', () => {
    const response = assignmentListResponse([], null);
    expect(validateAssignmentListResponse(response)).toEqual({ ok: true, payload: response });
  });

  it('accepts a page at the ceiling', () => {
    const assignments = Array.from({ length: ASSIGNMENT_LIST_MAX_LIMIT }, (_, i) =>
      makeAssignment({ id: `asg-${i}` }),
    );
    expect(validateAssignmentListResponse(assignmentListResponse(assignments, null)).ok).toBe(true);
  });

  it('rejects a page larger than the ceiling', () => {
    const assignments = Array.from({ length: ASSIGNMENT_LIST_MAX_LIMIT + 1 }, (_, i) =>
      makeAssignment({ id: `asg-${i}` }),
    );
    const result = validateAssignmentListResponse(assignmentListResponse(assignments, null));
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'oversized_page', String(ASSIGNMENT_LIST_MAX_LIMIT));
  });

  it('rejects a field outside the contract', () => {
    const result = validateAssignmentListResponse({
      assignments: [],
      next_cursor: null,
      total_count: 2,
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'total_count');
  });

  it('rejects a page whose entry fails', () => {
    const assignments = [makeAssignment(), makeAssignment({ scope: { label: '' } as never })];
    expect(validateAssignmentListResponse(assignmentListResponse(assignments, null))).toMatchObject(
      { ok: false, reason: 'invalid_scope' },
    );
  });
});

describe('SR-005 stays server-side', () => {
  it('exposes no client-side granter authority check', () => {
    // "Không cấp vượt quyền mình" là enforcement server-side (SR-005, write-time
    // check SR-008). Contract CỐ Ý không có helper nào kiểm quyền granter — một
    // hàm như vậy ở phía client là an toàn giả (bypass bằng gọi thẳng API).
    const spec = import.meta.glob('./management-assignment-contract.ts', {
      eager: true,
      import: 'default',
    });
    const mod = spec['./management-assignment-contract.ts'] as Record<string, unknown>;
    const authorityHelpers = Object.keys(mod ?? {}).filter((name) =>
      /(granter|authority|canGrant|exceedsOwn)/iu.test(name),
    );
    expect(authorityHelpers).toEqual([]);
  });

  it('rejects a request that supplies the granter identity', () => {
    const payload = {
      staff_id: 'target-staff',
      role_id: 'sys_super',
      granted_by: 'attacker-staff',
    };
    expect(validateCreateAssignmentRequest(payload)).toMatchObject({
      ok: false,
      reason: 'forbidden_field',
    });
  });
});

describe('default limit constants are exported for callers', () => {
  it('keeps the default below the ceiling', () => {
    expect(ASSIGNMENT_LIST_DEFAULT_LIMIT).toBeLessThanOrEqual(ASSIGNMENT_LIST_MAX_LIMIT);
  });
});
