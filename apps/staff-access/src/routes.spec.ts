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

const ACTOR_STAFF_ID = 'stf_actor';

/**
 * Middleware test: config + requestId + actor envelope. Actor được set vào
 * context đúng hình middleware thật của `main.ts` (HMAC envelope phân giải
 * xong) — route đọc `actorStaffId`/`actorSub` từ context, không từ body.
 */
function buildTestApp(
  options: {
    actorStaffId?: string | null;
    actorSub?: string | null;
  } = {},
): Hono<AppEnv> {
  // Queryable fake được dùng chung giữa các test — dọn recorded calls ở đây để
  // mỗi test assert trên đúng những SQL mà chính nó gây ra.
  unsafeMock.mockClear();
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('config', CONFIG);
    c.set('requestId', 'req-test');
    c.set(
      'actorStaffId',
      options.actorStaffId === undefined ? ACTOR_STAFF_ID : options.actorStaffId,
    );
    c.set('actorSub', options.actorSub === undefined ? 'sub_actor' : options.actorSub);
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
    // Staff lookup tra row active, role lookup tra row active, permission check
    // tra role.assign, insert/revoke khong can row — begin chay fn voi cung
    // fake queryable.
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('SELECT DISTINCT rp.permission_id')) {
        return [{ permission_id: 'role.assign' }];
      }
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
      if (sql.includes('FROM staff_access.role_assignments') && sql.includes('WHERE id = $1')) {
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
      if (sql.includes('SELECT DISTINCT rp.permission_id')) {
        return [{ permission_id: 'role.revoke' }];
      }
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

/** Params của INSERT audit đầu tiên trong mock — undefined khi route chưa ghi hàng nào. */
function findAudit(): readonly unknown[] | undefined {
  const call = unsafeMock.mock.calls.find(([sql]) => String(sql).includes('authorization_audit'));
  if (call === undefined) return undefined;
  return (call[1] ?? []) as readonly unknown[];
}

describe('staff-access write authorization (issue #44, ADR-0034)', () => {
  const STAFF_ROW = {
    id: 'stf_target',
    sub: 'sub_target',
    display_name: 'Target',
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
  const ROLE_ROW = {
    id: 'role_admin',
    name: 'system-administrator',
    kind: 'system',
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
  };
  const ASSIGNMENT_ROW = {
    id: 'asg_1',
    staff_id: 'stf_target',
    role_id: 'role_admin',
    scope: null,
    effective_from: '2026-01-01T00:00:00Z',
    effective_until: null,
    granted_by: null,
    created_at: '2026-01-01T00:00:00Z',
    revoked_at: null,
  };

  it('rejects an assignment grant with 403 and a denied audit row when the actor lacks role.assign', async () => {
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('SELECT DISTINCT rp.permission_id')) {
        return [{ permission_id: 'staff.read' }];
      }
      return [];
    });
    withStaffAccessClientMock.mockClear();
    const app = buildTestApp();
    const response = await app.request('/staff/stf_target/assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: 'role_admin' }),
    });
    expect(response.status).toBe(403);
    // Audit denied commit TRƯỚC khi response trả về — helper ghi trong cùng
    // client (một INSERT, tự commit), đúng hình ADR-0033 Quyết định 3.
    const params = findAudit();
    expect(params).toBeDefined();
    expect(params).toContain('role.assign');
    expect(params).toContain('denied');
    expect(params).toContain('permission_denied');
    expect(params).toContain('req-test');
    // Không insert assignment nào: enforcement đứng trước mọi đọc nghiệp vụ.
    expect(
      unsafeMock.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO staff_access.role_assignments'),
      ),
    ).toBe(false);
  });

  it('rejects an assignment grant with 401 when the envelope carries no actor principal', async () => {
    withStaffAccessClientMock.mockClear();
    const app = buildTestApp({ actorStaffId: null, actorSub: null });
    const response = await app.request('/staff/stf_target/assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: 'role_admin' }),
    });
    expect(response.status).toBe(401);
    // Không principal ⇒ không phải một lần từ chối quyền ⇒ không có hàng audit.
    expect(unsafeMock.mock.calls.some(([sql]) => String(sql).includes('authorization_audit'))).toBe(
      false,
    );
  });

  it('rejects self-assignment with 403 and a denied audit row', async () => {
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('SELECT DISTINCT rp.permission_id')) {
        return [{ permission_id: 'role.assign' }];
      }
      if (sql.includes('FROM staff_access.staff')) {
        return [{ ...STAFF_ROW, id: ACTOR_STAFF_ID }];
      }
      if (sql.includes('FROM staff_access.roles')) {
        return [ROLE_ROW];
      }
      return [];
    });
    beginMock.mockImplementation(beginPassingClientAsTx());
    const app = buildTestApp();
    const response = await app.request(`/staff/${ACTOR_STAFF_ID}/assignments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: 'role_admin' }),
    });
    expect(response.status).toBe(403);
    const params = findAudit();
    expect(params).toContain('self_assignment');
    expect(params).toContain('denied');
    expect(
      unsafeMock.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO staff_access.role_assignments'),
      ),
    ).toBe(false);
  });

  it('rejects a suspended target staff (domain error thrown, mapped to 409 at composition root)', async () => {
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('SELECT DISTINCT rp.permission_id')) {
        return [{ permission_id: 'role.assign' }];
      }
      if (sql.includes('FROM staff_access.staff')) {
        return [{ ...STAFF_ROW, status: 'suspended' }];
      }
      return [];
    });
    beginMock.mockImplementation(beginPassingClientAsTx());
    const app = buildTestApp();
    const response = app.request('/staff/stf_target/assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: 'role_admin' }),
    });
    // Domain error StaffAccessDomainError được ném ra từ transaction; map HTTP
    // 409 thuộc composition root (onError của main.ts, có spec riêng).
    await expect(response).rejects.toMatchObject({ code: 'staff_suspended' });
  });

  it('returns the existing assignment without creating a duplicate for a live (staff_id, role_id)', async () => {
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('SELECT DISTINCT rp.permission_id')) {
        return [{ permission_id: 'role.assign' }];
      }
      if (sql.includes('FROM staff_access.staff')) {
        return [STAFF_ROW];
      }
      if (sql.includes('FROM staff_access.roles')) {
        return [ROLE_ROW];
      }
      if (
        sql.includes('FROM staff_access.role_assignments') &&
        sql.includes('revoked_at IS NULL')
      ) {
        return [ASSIGNMENT_ROW];
      }
      if (sql.includes('FROM staff_access.role_assignments') && sql.includes('WHERE id = $1')) {
        return [ASSIGNMENT_ROW];
      }
      return [];
    });
    beginMock.mockImplementation(beginPassingClientAsTx());
    const app = buildTestApp();
    const response = await app.request('/staff/stf_target/assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: 'role_admin' }),
    });
    // No-op có audit: 200 với assignment hiện có, không 201, không INSERT mới.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    expect(body.id).toBe('asg_1');
    expect(
      unsafeMock.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO staff_access.role_assignments'),
      ),
    ).toBe(false);
    const params = findAudit();
    expect(params).toContain('duplicate_live_assignment');
    expect(params).toContain('success');
  });

  it('rejects self-revocation of the last live canonical administrator assignment with 403 and a denied audit row', async () => {
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('SELECT DISTINCT rp.permission_id')) {
        return [{ permission_id: 'role.revoke' }];
      }
      if (sql.includes('FROM staff_access.role_assignments') && sql.includes('WHERE id = $1')) {
        return [{ ...ASSIGNMENT_ROW, staff_id: ACTOR_STAFF_ID }];
      }
      if (sql.includes('FROM staff_access.roles')) {
        return [ROLE_ROW];
      }
      if (sql.includes('count(*)')) {
        return [{ count: '1' }];
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
    expect(response.status).toBe(403);
    const params = findAudit();
    expect(params).toContain('self_revocation_last_administrator');
    expect(params).toContain('denied');
    // Không UPDATE revoked_at: từ chối trước khi ghi nghiệp vụ.
    expect(
      unsafeMock.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE staff_access.role_assignments'),
      ),
    ).toBe(false);
  });

  it('allows self-revocation when another live canonical administrator assignment exists', async () => {
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('SELECT DISTINCT rp.permission_id')) {
        return [{ permission_id: 'role.revoke' }];
      }
      if (sql.includes('FROM staff_access.role_assignments') && sql.includes('WHERE id = $1')) {
        return [{ ...ASSIGNMENT_ROW, staff_id: ACTOR_STAFF_ID, id: 'asg_actor' }];
      }
      if (sql.includes('FROM staff_access.roles')) {
        return [ROLE_ROW];
      }
      if (sql.includes('count(*)')) {
        return [{ count: '2' }];
      }
      if (sql.includes('UPDATE staff_access.role_assignments')) {
        return [{ id: 'asg_actor' }];
      }
      if (sql.includes('FROM staff_access.role_assignments') && sql.includes('WHERE id = $1')) {
        return [{ ...ASSIGNMENT_ROW, staff_id: ACTOR_STAFF_ID, id: 'asg_actor' }];
      }
      return [];
    });
    beginMock.mockImplementation(beginPassingClientAsTx());
    const app = buildTestApp();
    const response = await app.request('/assignments/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'asg_actor' }),
    });
    expect(response.status).toBe(200);
  });

  it('rejects a staff create with 403 and a denied audit row when the actor lacks staff.create', async () => {
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('SELECT DISTINCT rp.permission_id')) {
        return [{ permission_id: 'role.assign' }];
      }
      return [];
    });
    const app = buildTestApp();
    const response = await app.request('/staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: `sub_${'a'.repeat(32)}`, display_name: 'New Staff' }),
    });
    expect(response.status).toBe(403);
    const params = findAudit();
    expect(params).toContain('staff.create');
    expect(params).toContain('permission_denied');
  });

  it('creates a staff entry with 201 and a success audit row when the actor holds staff.create', async () => {
    const newSub = `sub_${'a'.repeat(32)}`;
    unsafeMock.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('SELECT DISTINCT rp.permission_id')) {
        return [{ permission_id: 'staff.create' }];
      }
      if (sql.includes('FROM staff_access.staff') && sql.includes('WHERE sub = $1')) {
        return [];
      }
      if (sql.includes('FROM staff_access.staff') && sql.includes('WHERE id = $1')) {
        return [
          {
            id: 'stf_new',
            sub: newSub,
            display_name: 'New Staff',
            status: 'active',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ];
      }
      return [];
    });
    beginMock.mockImplementation(beginPassingClientAsTx());
    const app = buildTestApp();
    const response = await app.request('/staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: newSub, display_name: 'New Staff' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { sub: string; display_name: string; status: string };
    expect(body.sub).toBe(newSub);
    expect(body.display_name).toBe('New Staff');
    expect(body.status).toBe('active');
    expect(
      unsafeMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO staff_access.staff')),
    ).toBe(true);
    const params = findAudit();
    expect(params).toContain('staff.create');
    expect(params).toContain('success');
  });

  it('rejects a staff create body with an invalid sub with 400 before touching the database', async () => {
    withStaffAccessClientMock.mockClear();
    const app = buildTestApp();
    const response = await app.request('/staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: 'not-a-sub', display_name: 'New Staff' }),
    });
    expect(response.status).toBe(400);
    expect(withStaffAccessClientMock).not.toHaveBeenCalled();
  });
});
