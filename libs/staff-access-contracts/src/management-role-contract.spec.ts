import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_ROLE_FIELDS,
  isRoleKind,
  isRoleStatus,
  ROLE_KINDS,
  ROLE_LIST_MAX_LIMIT,
  ROLE_STATUSES,
  roleListResponse,
  validateRoleListResponse,
  validateStaffRole,
  type RoleContractRejectionReason,
  type RoleListValidation,
  type StaffRole,
} from './management-role-contract';

function makeRole(overrides: Partial<StaffRole> = {}): StaffRole {
  return {
    id: 'sys_ops',
    name: 'Operations',
    kind: 'system',
    permissions: ['staff.read', 'role.read'],
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Assert payload bị từ chối với `reason` và `detail` chứa `fragment`. */
function expectRejectedBy(
  result:
    | { ok: true; payload: unknown }
    | { ok: false; reason: RoleContractRejectionReason; detail: string },
  reason: RoleContractRejectionReason,
  fragment: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the payload to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(fragment);
}

function unwrap(result: RoleListValidation): {
  readonly roles: readonly StaffRole[];
  readonly next_cursor: string | null;
} {
  if (!result.ok) {
    throw new Error(`Expected a valid role list, got ${result.reason}: ${result.detail}`);
  }
  return result.payload;
}

describe('validateStaffRole — accept', () => {
  it('accepts a system role referencing permission ids', () => {
    const role = makeRole();
    expect(validateStaffRole(role)).toEqual({ ok: true, payload: role });
  });

  it('accepts a custom role shape even though administration is off in v1', () => {
    // ADR-0004: custom role administration KHÔNG bật v1 — nhưng shape của cả
    // hai kind phải hợp lệ để catalog đọc được mà không đổi contract khi bật.
    const role = makeRole({ id: 'custom_ops', kind: 'custom' });
    expect(validateStaffRole(role).ok).toBe(true);
  });

  it('accepts an empty permission set', () => {
    expect(validateStaffRole(makeRole({ permissions: [] })).ok).toBe(true);
  });
});

describe('validateStaffRole — forbidden fields', () => {
  it.each([...FORBIDDEN_ROLE_FIELDS])('rejects a role carrying %s', (field) => {
    const role = { ...makeRole(), [field]: 'x' };
    const result = validateStaffRole(role);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', field);
  });

  it('rejects is_admin even when false — the flag itself is the leak', () => {
    // SR-016: không có bypass role. Cờ false trên wire vẫn là đường bypass tiềm
    // năng, chặn shape chứ không chỉ giá trị.
    const role = { ...makeRole(), is_admin: false };
    expect(validateStaffRole(role)).toMatchObject({ ok: false, reason: 'forbidden_field' });
  });

  it('rejects an unknown extra field', () => {
    const role = { ...makeRole(), mystery_field: 1 };
    const result = validateStaffRole(role);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'mystery_field');
  });
});

describe('validateStaffRole — invalid shapes', () => {
  it.each([
    ['null', null],
    ['a string', 'role'],
    ['a number', 1],
    ['an array', [makeRole()]],
  ])('rejects %s as an entry', (_label, entry) => {
    expect(validateStaffRole(entry)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([['missing id'], ['missing name'], ['missing permissions'], ['missing created_at']])(
    'rejects a role with %s',
    (label) => {
      const field = label.replace('missing ', '') as keyof StaffRole;
      // Rest-spread thay cho `delete` (no-dynamic-delete): role bị cắt field
      // vẫn mang ý nghĩa "thiếu field" mà không cần xóa key động.
      const { [field]: _removed, ...rest } = makeRole();
      const role: Record<string, unknown> = { ...rest };
      expect(validateStaffRole(role)).toMatchObject({ ok: false, reason: 'invalid_entry' });
    },
  );

  it.each(['admin', 'bypass', '', 1, null])('rejects kind %p', (kind) => {
    const role = makeRole({ kind: kind as StaffRole['kind'] });
    expect(validateStaffRole(role)).toMatchObject({ ok: false, reason: 'invalid_kind' });
  });

  it.each(['enabled', '', 1, null])('rejects status %p', (status) => {
    const role = makeRole({ status: status as StaffRole['status'] });
    expect(validateStaffRole(role)).toMatchObject({ ok: false, reason: 'invalid_status' });
  });

  it.each([
    ['a bare string', 'staff.read'],
    ['an object permission', [{ id: 'staff.read' }]],
    ['an empty string entry', ['']],
    ['a numeric entry', [1]],
  ])('rejects permissions containing %s', (_label, permissions) => {
    const role = makeRole({ permissions: permissions as StaffRole['permissions'] });
    expect(validateStaffRole(role)).toMatchObject({ ok: false, reason: 'invalid_entry' });
  });
});

describe('validateRoleListResponse — accept and pagination bounds', () => {
  it('accepts a page with roles and a cursor', () => {
    const response = roleListResponse([makeRole()], 'tok');
    expect(validateRoleListResponse(response)).toEqual({ ok: true, payload: response });
  });

  it('accepts an empty page', () => {
    expect(unwrap(validateRoleListResponse(roleListResponse([], null)))).toEqual({
      roles: [],
      next_cursor: null,
    });
  });

  it('accepts a page at the ceiling', () => {
    const roles = Array.from({ length: ROLE_LIST_MAX_LIMIT }, (_, i) =>
      makeRole({ id: `sys_${i}` }),
    );
    expect(validateRoleListResponse(roleListResponse(roles, null)).ok).toBe(true);
  });

  it('rejects a page larger than the ceiling', () => {
    const roles = Array.from({ length: ROLE_LIST_MAX_LIMIT + 1 }, (_, i) =>
      makeRole({ id: `sys_${i}` }),
    );
    const result = validateRoleListResponse(roleListResponse(roles, null));
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'oversized_page', String(ROLE_LIST_MAX_LIMIT));
  });

  it('rejects a field outside the contract', () => {
    const result = validateRoleListResponse({ roles: [], next_cursor: null, total_count: 1 });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_payload', 'total_count');
  });

  it('rejects a page whose entry is invalid', () => {
    const roles = [makeRole(), { ...makeRole(), kind: 'root' }];
    expect(validateRoleListResponse(roleListResponse(roles as StaffRole[], null))).toMatchObject({
      ok: false,
      reason: 'invalid_kind',
    });
  });
});

describe('write path is deliberately absent', () => {
  it('exposes no create/update role shape in the module surface', () => {
    // ADR-0004: v1 chỉ system-defined role qua migration. Contract này CỐ Ý
    // không có request create/update — nếu một thay đổi sau thêm write path,
    // test này phải bị xóa cùng một PR có ADR tương ứng.
    const spec = import.meta.glob('./management-role-contract.ts', {
      eager: true,
      import: 'default',
    });
    const mod = spec['./management-role-contract.ts'] as Record<string, unknown>;
    const exported = Object.keys(mod ?? {});
    const writeNames = exported.filter((name) =>
      /^(create|update|upsert|delete).*Role/iu.test(name),
    );
    expect(writeNames).toEqual([]);
  });
});

describe('isRoleKind / isRoleStatus', () => {
  it.each([...ROLE_KINDS])('accepts kind %s', (kind) => {
    expect(isRoleKind(kind)).toBe(true);
  });

  it.each([...ROLE_STATUSES])('accepts status %s', (status) => {
    expect(isRoleStatus(status)).toBe(true);
  });

  it.each(['Admin', 'disabled', null, 1])('rejects kind %p', (kind) => {
    expect(isRoleKind(kind)).toBe(false);
  });

  it.each(['ACTIVE', null, 1])('rejects status %p', (status) => {
    expect(isRoleStatus(status)).toBe(false);
  });
});
