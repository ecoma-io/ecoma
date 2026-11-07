import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PERMISSION_FIELDS,
  isPermissionIdFormat,
  isPermissionStatus,
  PERMISSION_LIST_DEFAULT_LIMIT,
  PERMISSION_LIST_MAX_LIMIT,
  PERMISSION_STATUSES,
  permissionEntry,
  permissionListResponse,
  validatePermission,
  validatePermissionListResponse,
  type Permission,
  type PermissionContractRejectionReason,
} from './management-permission-contract';

function makePermission(overrides: Partial<Permission> = {}): Permission {
  return {
    id: 'staff.read',
    domain: 'staff',
    action: 'read',
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Assert payload bị từ chối với `reason` và `detail` chứa `fragment`. */
function expectRejectedBy(
  result:
    | { ok: true; payload: unknown }
    | { ok: false; reason: PermissionContractRejectionReason; detail: string },
  reason: PermissionContractRejectionReason,
  fragment: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the payload to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(fragment);
}

describe('validatePermission — accept', () => {
  it('accepts an entry whose id equals the dot-joined halves', () => {
    const entry = makePermission();
    expect(validatePermission(entry)).toEqual({ ok: true, payload: entry });
  });

  it('accepts retired as a valid terminal status', () => {
    expect(validatePermission(makePermission({ status: 'retired' })).ok).toBe(true);
  });

  it('builds an id-consistent entry via permissionEntry', () => {
    const entry = permissionEntry('delivery', 'redrive', 'active', '2026-01-01T00:00:00Z');
    expect(entry).toEqual({
      id: 'delivery.redrive',
      domain: 'delivery',
      action: 'redrive',
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(validatePermission(entry).ok).toBe(true);
  });
});

describe('validatePermission — id format (ADR-0010)', () => {
  it.each([
    ['no dot', 'staffread'],
    ['empty domain', '.read'],
    ['empty action', 'staff.'],
    ['two dots', 'staff.read.extra'],
    ['bare dot', '.'],
    ['a number', 1],
    ['null', null],
  ])('rejects id %p as invalid format', (_label, id) => {
    const entry = makePermission({ id: id as string });
    expect(validatePermission(entry)).toMatchObject({ ok: false, reason: 'invalid_id_format' });
  });

  it('rejects halves that do not match the id', () => {
    const entry = makePermission({ id: 'staff.read', domain: 'role', action: 'read' });
    const result = validatePermission(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'id_parts_mismatch', 'domain/action');
  });

  it('rejects mismatched action half', () => {
    const entry = makePermission({ id: 'staff.read', domain: 'staff', action: 'write' });
    expect(validatePermission(entry)).toMatchObject({ ok: false, reason: 'id_parts_mismatch' });
  });
});

describe('validatePermission — forbidden fields', () => {
  it.each([...FORBIDDEN_PERMISSION_FIELDS])('rejects an entry carrying %s', (field) => {
    const entry = { ...makePermission(), [field]: 'x' };
    const result = validatePermission(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', field);
  });

  it('rejects a wildcard id even though it has one dot', () => {
    // ADR-0010 phương án 4 loại permission bao trùm; hình `*` qua validator
    // không được looks-like-valid: chặn ở id format trước khi tới shape.
    expect(isPermissionIdFormat('*.read')).toBe(false);
  });

  it('rejects an unknown extra field', () => {
    const entry = { ...makePermission(), mystery_field: true };
    const result = validatePermission(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'mystery_field');
  });
});

describe('validatePermission — invalid shapes', () => {
  it.each([
    ['null', null],
    ['a string', 'staff.read'],
    ['an array', [makePermission()]],
  ])('rejects %s as an entry', (_label, entry) => {
    expect(validatePermission(entry)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([['missing domain'], ['missing status'], ['missing created_at']])(
    'rejects a permission with %s',
    (label) => {
      const field = label.replace('missing ', '') as keyof Permission;
      // Rest-spread thay cho `delete` (no-dynamic-delete): entry bị cắt field
      // vẫn mang ý nghĩa "thiếu field" mà không cần xóa key động.
      const { [field]: _removed, ...rest } = makePermission();
      const entry: Record<string, unknown> = { ...rest };
      expect(validatePermission(entry)).toMatchObject({ ok: false, reason: 'invalid_entry' });
    },
  );

  it.each(['enabled', '', 1, null])('rejects status %p', (status) => {
    const entry = makePermission({ status: status as Permission['status'] });
    expect(validatePermission(entry)).toMatchObject({ ok: false, reason: 'invalid_status' });
  });

  it('rejects an empty created_at', () => {
    const entry = makePermission({ created_at: '' });
    expect(validatePermission(entry)).toMatchObject({ ok: false, reason: 'invalid_entry' });
  });
});

describe('validatePermissionListResponse — accept and pagination bounds', () => {
  it('accepts a page with entries and a cursor', () => {
    const response = permissionListResponse([makePermission()], 'tok');
    expect(validatePermissionListResponse(response)).toEqual({ ok: true, payload: response });
  });

  it('accepts an empty page', () => {
    const response = permissionListResponse([], null);
    expect(validatePermissionListResponse(response)).toEqual({ ok: true, payload: response });
  });

  it('accepts a page at the ceiling', () => {
    const permissions = Array.from({ length: PERMISSION_LIST_MAX_LIMIT }, (_, i) =>
      makePermission({ id: `d${i}.read`, domain: `d${i}` }),
    );
    expect(validatePermissionListResponse(permissionListResponse(permissions, null)).ok).toBe(true);
  });

  it('rejects a page larger than the ceiling', () => {
    const permissions = Array.from({ length: PERMISSION_LIST_MAX_LIMIT + 1 }, (_, i) =>
      makePermission({ domain: `d${i}` }),
    );
    const result = validatePermissionListResponse(permissionListResponse(permissions, null));
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'oversized_page', String(PERMISSION_LIST_MAX_LIMIT));
  });

  it('rejects a field outside the contract', () => {
    const result = validatePermissionListResponse({
      permissions: [],
      next_cursor: null,
      total_count: 9,
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_payload', 'total_count');
  });

  it('rejects a page whose entry fails', () => {
    const permissions = [
      makePermission(),
      makePermission({ id: 'broken', domain: 'x', action: 'y' }),
    ];
    expect(validatePermissionListResponse(permissionListResponse(permissions, null))).toMatchObject(
      { ok: false, reason: 'invalid_id_format' },
    );
  });
});

describe('isPermissionIdFormat / isPermissionStatus', () => {
  it.each(['staff.read', 'permission.read', 'delivery.redrive', 'a.b'])('accepts id %s', (id) => {
    expect(isPermissionIdFormat(id)).toBe(true);
  });

  it.each(['nodot', 'a.b.c', '.a', 'a.', '', null, 1])('rejects id %p', (id) => {
    expect(isPermissionIdFormat(id)).toBe(false);
  });

  it.each([...PERMISSION_STATUSES])('accepts status %s', (status) => {
    expect(isPermissionStatus(status)).toBe(true);
  });

  it.each(['enabled', null, 1])('rejects status %p', (status) => {
    expect(isPermissionStatus(status)).toBe(false);
  });
});

describe('default limit constants are exported for callers', () => {
  it('keeps the default below the ceiling', () => {
    expect(PERMISSION_LIST_DEFAULT_LIMIT).toBeLessThanOrEqual(PERMISSION_LIST_MAX_LIMIT);
    expect(PERMISSION_LIST_DEFAULT_LIMIT).toBeGreaterThan(0);
  });
});
