import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { staffAccessRoutes } from './routes';
import { decodeKeysetCursor, encodeKeysetCursor } from './cursor';
import type { AppEnv } from './types';
import type {
  StaffAccessClient,
  StaffAccessTransaction,
} from '@ecoma-io/staff-access-infrastructure';

/**
 * Routes spec — kiem duong ong HTTP: request -> validate contract -> repo
 * fake -> response dung wire shape. Khong co PostgreSQL: `withStaffAccessClient`
 * bi mock de truyen mot queryable fake ghi nhan SQL (duong audit trong
 * transaction duoc kiem qua `begin`).
 */

// Mock khong generic (vi.fn khong round-trip signature generic cua
// StaffAccessClient); fake client duoc cast o bien nho mot lan.
const { withStaffAccessClientMock, unsafeMock, beginMock, endMock } = vi.hoisted(() => {
  const unsafe = vi.fn<(sql: string, params?: readonly unknown[]) => Promise<unknown[]>>();
  const begin = vi.fn<(fn: (tx: StaffAccessTransaction) => Promise<unknown>) => Promise<unknown>>();
  const end = vi.fn<() => Promise<void>>();
  const withClient =
    vi.fn<(config: unknown, fn: (db: StaffAccessClient) => Promise<unknown>) => Promise<unknown>>();
  return {
    withStaffAccessClientMock: withClient,
    unsafeMock: unsafe,
    beginMock: begin,
    endMock: end,
  };
});

function buildFakeClient(): StaffAccessClient {
  return { unsafe: unsafeMock, begin: beginMock, end: endMock } as unknown as StaffAccessClient;
}

vi.mock('@ecoma-io/staff-access-infrastructure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecoma-io/staff-access-infrastructure')>();
  return {
    ...actual,
    withStaffAccessClient: withStaffAccessClientMock.mockImplementation(
      async (config: unknown, fn: (db: StaffAccessClient) => Promise<unknown>) => {
        return fn(buildFakeClient());
      },
    ),
  };
});

/**
 * Fake `begin` của mock truyền client vào callback — đúng vi phạm brand của
 * {@link StaffAccessTransaction} mà runtime thật không bao giờ có; cast tại
 * **một** chỗ ghi nhận lệch loại (client ≠ tx), không để loang ra các test.
 */
function beginPassingClientAsTx(): (
  fn: (tx: StaffAccessTransaction) => Promise<unknown>,
) => Promise<unknown> {
  return async (fn: (tx: StaffAccessTransaction) => Promise<unknown>): Promise<unknown> =>
    fn(buildFakeClient() as unknown as StaffAccessTransaction);
}

const CONFIG = {
  hyperdrive: { connectionString: 'postgres://hyperdrive.invalid/db' },
  internalSecret: 'internal-secret-test',
  internalKid: undefined,
  internalSecretsByKid: new Map<string, string>(),
  internalAuthSkewSeconds: 300,
};

function buildTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('config', CONFIG);
    c.set('requestId', 'req-test');
    await next();
  });
  app.route('/', staffAccessRoutes());
  return app;
}

describe('staff-access management routes', () => {
  it('lists staff through one client per request', async () => {
    unsafeMock.mockResolvedValue([]);
    withStaffAccessClientMock.mockClear();
    const app = buildTestApp();
    const response = await app.request('/staff');
    expect(response.status).toBe(200);
    expect(withStaffAccessClientMock).toHaveBeenCalledTimes(1);
    expect(withStaffAccessClientMock.mock.calls[0]?.[0]).toBe(CONFIG);
    const body = (await response.json()) as { staff: unknown[]; next_cursor: string | null };
    expect(body.staff).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it('rejects an invalid limit with 400 before touching the database', async () => {
    withStaffAccessClientMock.mockClear();
    const app = buildTestApp();
    const response = await app.request('/staff?limit=0');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Bad Request');
    expect(withStaffAccessClientMock).not.toHaveBeenCalled();
  });

  it('rejects an unparseable cursor token with 400 before touching the database', async () => {
    withStaffAccessClientMock.mockClear();
    const app = buildTestApp();
    const response = await app.request('/staff?cursor=not-a-token');
    expect(response.status).toBe(400);
    expect(withStaffAccessClientMock).not.toHaveBeenCalled();
  });

  it('passes decoded cursor fields and limit+1 to the staff list query', async () => {
    unsafeMock.mockResolvedValue([]);
    const app = buildTestApp();
    const token = encodeKeysetCursor({
      axis: 'staff-created-at',
      at: '2026-01-01T00:00:00Z',
      id: 'stf_1',
    });
    await app.request(`/staff?cursor=${encodeURIComponent(token)}&limit=10`);
    expect(unsafeMock).toHaveBeenCalled();
    const params = (unsafeMock.mock.calls.at(-1)?.[1] ?? []) as readonly unknown[];
    expect(params).toContain('2026-01-01T00:00:00Z');
    expect(params).toContain('stf_1');
    expect(params).toContain(11);
  });

  it('binds cursor to its axis: an audit token is rejected on the staff list', async () => {
    const auditToken = encodeKeysetCursor({
      axis: 'audit-occurred-at',
      at: '2026-01-01T00:00:00Z',
      id: 'aud_1',
    });
    expect(decodeKeysetCursor(auditToken, 'staff-created-at')).toBeNull();
    const staffToken = encodeKeysetCursor({
      axis: 'staff-created-at',
      at: '2026-01-01T00:00:00Z',
      id: 'stf_1',
    });
    expect(decodeKeysetCursor(staffToken, 'staff-created-at') ?? null).not.toBeNull();
  });

  it('returns 404 when the staff entry does not exist', async () => {
    unsafeMock.mockResolvedValue([]);
    const app = buildTestApp();
    const response = await app.request('/staff/staff_missing');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Not Found');
  });

  it('returns an empty assignment list for a staff member without assignments', async () => {
    unsafeMock.mockResolvedValue([]);
    const app = buildTestApp();
    const response = await app.request('/staff/staff_1/assignments');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      assignments: unknown[];
      next_cursor: string | null;
    };
    expect(body.assignments).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it('rejects a revoke body without an id with 400 before touching the database', async () => {
    withStaffAccessClientMock.mockClear();
    const app = buildTestApp();
    const response = await app.request('/assignments/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(withStaffAccessClientMock).not.toHaveBeenCalled();
  });

  it('rejects a non-object JSON body with 400', async () => {
    const app = buildTestApp();
    const response = await app.request('/assignments/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2]',
    });
    expect(response.status).toBe(400);
  });

  it('rejects invalid JSON with 400', async () => {
    const app = buildTestApp();
    const response = await app.request('/assignments/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'nope',
    });
    expect(response.status).toBe(400);
  });

  it('serves the audit query route with validated filters', async () => {
    unsafeMock.mockResolvedValue([]);
    const app = buildTestApp();
    const response = await app.request('/audit/entries?actor_staff_id=stf_1&limit=20');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: unknown[]; next_cursor: string | null };
    expect(body.entries).toEqual([]);
    expect(body.next_cursor).toBeNull();
    const lastCall = unsafeMock.mock.calls.at(-1);
    const params = (lastCall !== undefined ? lastCall[1] : undefined) ?? [];
    expect(params).toContain('stf_1');
    expect(params).toContain(21);
  });

  it('writes the grant audit entry with the request id as correlationId inside the transaction', async () => {
    // Staff lookup tra row active, role lookup tra row active, insert/revoke
    // khong can row — begin chay fn voi cung fake queryable.
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('FROM staff_access.staff')) {
        return [
          {
            id: 'stf_1',
            sub: 'sub_1',
            display_name: 'Staff One',
            status: 'active',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ];
      }
      if (sql.includes('FROM staff_access.roles')) {
        return [
          {
            id: 'role_admin',
            name: 'Administrator',
            kind: 'system',
            status: 'active',
            created_at: '2026-01-01T00:00:00Z',
          },
        ];
      }
      if (sql.includes('FROM staff_access.role_assignments')) {
        // Doc lai assignment sau commit (duong 201).
        return [
          {
            id: 'asg_created',
            staff_id: 'stf_1',
            role_id: 'role_admin',
            scope: null,
            effective_from: '2026-01-01T00:00:00Z',
            effective_until: null,
            granted_by: null,
            created_at: '2026-01-01T00:00:00Z',
            revoked_at: null,
          },
        ];
      }
      return [];
    });
    beginMock.mockImplementation(beginPassingClientAsTx());
    const app = buildTestApp();
    const response = await app.request('/staff/stf_1/assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: 'role_admin' }),
    });
    expect(response.status).toBe(201);
    const auditInsert = unsafeMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO staff_access.authorization_audit'),
    );
    expect(auditInsert).toBeDefined();
    const params = ((auditInsert as unknown[])[1] ?? []) as readonly unknown[];
    expect(params).toContain('req-test');
  });

  it('writes the revoke audit entry with the request id as correlationId', async () => {
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('FROM staff_access.role_assignments') && sql.includes('WHERE id = $1')) {
        return [
          {
            id: 'asg_1',
            staff_id: 'stf_1',
            role_id: 'role_admin',
            scope: null,
            effective_from: null,
            effective_until: null,
            granted_by: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            revoked_at: null,
          },
        ];
      }
      if (sql.includes('UPDATE staff_access.role_assignments')) {
        // revokeAssignment: UPDATE ... WHERE id = $1 AND revoked_at IS NULL
        // RETURNING id — tra 1 hang nghia la revoke co hieu luc.
        return [{ id: 'asg_1' }];
      }
      return [];
    });
    beginMock.mockImplementation(beginPassingClientAsTx());
    const app = buildTestApp();
    const response = await app.request('/assignments/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'asg_1' }),
    });
    expect(response.status).toBe(200);
    const auditInsert = unsafeMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO staff_access.authorization_audit'),
    );
    expect(auditInsert).toBeDefined();
    const params = ((auditInsert as unknown[])[1] ?? []) as readonly unknown[];
    expect(params).toContain('req-test');
  });

  it('rejects an audit query limit that is not an integer with 400', async () => {
    const app = buildTestApp();
    const response = await app.request('/audit/entries?limit=not-a-number');
    expect(response.status).toBe(400);
  });

  it('lists active roles with their permission ids from the same client', async () => {
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('FROM staff_access.roles')) {
        return [
          {
            id: 'role_admin',
            name: 'Administrator',
            kind: 'system',
            status: 'active',
            created_at: '2026-01-01T00:00:00Z',
          },
        ];
      }
      return [{ permission_id: 'staff.read' }];
    });
    const app = buildTestApp();
    const response = await app.request('/roles');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      roles: Array<{ id: string; permissions: string[] }>;
      next_cursor: string | null;
    };
    expect(body.roles).toHaveLength(1);
    expect(body.roles[0]?.permissions).toEqual(['staff.read']);
  });

  it('returns 404 for a permission outside the catalog', async () => {
    unsafeMock.mockResolvedValue([]);
    const app = buildTestApp();
    const response = await app.request('/permissions/unknown.action');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Not Found');
  });

  it('returns 404 for the entitlement of an unknown staff and product', async () => {
    unsafeMock.mockResolvedValue([]);
    const app = buildTestApp();
    const response = await app.request('/staff/staff_missing/entitlements/unknown.product');
    expect(response.status).toBe(404);
  });
});
