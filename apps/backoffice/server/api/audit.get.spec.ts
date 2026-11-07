/**
 * Unit test của `GET /api/audit/entries` sau P5.4 (issue #478): bản ghi audit
 * đọc từ Staff Access management API qua `fetchAuditEntries`, không từ
 * `db-backoffice` trực tiếp. Giam sát fail-closed: client chưa cấu hình / gọi
 * thất bại ⇒ `503`.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PRINCIPAL_CONTEXT_KEY } from '../principal';
import auditRoute from './audit.get';
import { fetchAuditEntries, staffAccessClientConfig } from '@ecoma-io/backoffice-infrastructure';
import type { AuditListCallResult } from '@ecoma-io/backoffice-infrastructure';

const writeLog = vi.fn<(entry: Record<string, unknown>) => void>();
vi.mock('../log', () => ({ writeLog: (...args: unknown[]) => writeLog(...args) }));

vi.mock('../authorization', () => ({
  requirePermission: async () => ({
    allowed: true,
    stale: false,
    denial: null,
    riskClass: 'normal',
  }),
}));

vi.mock('@ecoma-io/backoffice-infrastructure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecoma-io/backoffice-infrastructure')>();
  return {
    ...actual,
    backofficeHyperdrive: (env: unknown) =>
      (env as { DB_BACKOFFICE?: unknown })?.DB_BACKOFFICE ?? null,
    backofficeNodeDatabaseUrl: () => null,
    loadPrincipalAuthorization: async () => ({ assignments: [] }),
    loadPrincipalAuthorizationProjection: async () => null,
    withBackofficePool: async <T>(_hyperdrive: unknown, callback: (pool: unknown) => Promise<T>) =>
      callback({
        connect: async () => ({
          release: () => undefined,
          query: async () => ({ rows: [], rowCount: 0 }),
        }),
      }),
    staffAccessClientConfig: vi.fn<[unknown], AuditListCallResult | null>(
      () => staffConfig as unknown as AuditListCallResult | null,
    ),
    fetchAuditEntries: vi.fn<[unknown, Record<string, string>], AuditListCallResult>(async () => ({
      ok: true,
      entries: ENTRIES,
    })),
  };
});

let readEnv: Record<string, unknown> = {};
const staffBinding = vi.hoisted(() =>
  fakeBinding(JSON.stringify({ entries: [], next_cursor: null })),
);
const staffConfig = vi.hoisted(() => ({
  binding: staffBinding,
  signHeaders: vi.fn<[string], Record<string, string>>().mockResolvedValue({}),
}));

const SUB = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ENTRIES = [
  {
    id: 'e1',
    actor_staff_id: 's1',
    actor_sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    target: 'staff/s2',
    action: 'role.assign',
    occurred_at: '2026-01-01T00:00:00Z',
    outcome: 'success',
    reason: null,
    correlation_id: 'c1',
  },
  {
    id: 'e2',
    actor_staff_id: null,
    actor_sub: null,
    target: 'permission/staff.read',
    action: 'permission.read',
    occurred_at: '2026-01-02T00:00:00Z',
    outcome: 'denied',
    reason: 'insufficient_role',
    correlation_id: null,
  },
];

function fakeBinding(body: unknown): { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn<(input: Request) => Promise<Response>>(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    ),
  };
}

async function get(query: string): Promise<{ status: number; body: unknown }> {
  const app = createApp();
  app.use(
    defineEventHandler((event) => {
      event.context.cloudflare = { env: readEnv };
      event.context[PRINCIPAL_CONTEXT_KEY] = { actorSub: SUB };
    }),
  );
  const router = createRouter();
  router.get('/api/audit/entries', auditRoute);
  app.use(router.handler);

  const response = await toWebHandler(app)(
    new Request(`http://localhost/api/audit/entries${query}`),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

describe('GET /api/audit/entries — staff-access source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readEnv = { DB_BACKOFFICE: { connectionString: 'postgres://fake' } };
    (staffAccessClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(staffConfig);
    (fetchAuditEntries as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      entries: ENTRIES,
    });
    staffBinding.fetch.mockClear();
  });

  it('answers 200 with local entries when the staff-access client is unconfigured', async () => {
    (staffAccessClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const { status, body } = await get('');

    expect(status).toBe(200);
    expect(body).toEqual({ entries: [] });
    expect(fetchAuditEntries).not.toHaveBeenCalled();
  });

  it('answers 503 when staff-access call fails', async () => {
    (fetchAuditEntries as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'unreachable',
    });

    const { status, body } = await get('');

    expect(status).toBe(503);
    expect(body).toEqual(expect.objectContaining({ statusCode: 503 }));
  });

  it('answers 200 with audit entries mapped from wire shape', async () => {
    const { status, body } = await get('');

    expect(status).toBe(200);
    expect(body).toEqual({
      entries: [
        {
          id: 'e1',
          actor_staff_id: 's1',
          actor_sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          target: 'staff/s2',
          action: 'role.assign',
          occurred_at: '2026-01-01T00:00:00Z',
          outcome: 'success',
          source: 'staff-access',
          correlation_id: 'c1',
        },
        {
          id: 'e2',
          actor_staff_id: null,
          actor_sub: null,
          target: 'permission/staff.read',
          action: 'permission.read',
          occurred_at: '2026-01-02T00:00:00Z',
          outcome: 'denied',
          reason: 'insufficient_role',
          source: 'staff-access',
        },
      ],
    });
    expect(fetchAuditEntries).toHaveBeenCalledTimes(1);
  });

  it('passes query params to staff-access call through fetchAuditEntries', async () => {
    await get('?actor_staff_id=s1&limit=10');

    expect(fetchAuditEntries).toHaveBeenCalledWith(staffConfig, {
      actor_staff_id: 's1',
      limit: '10',
    });
  });

  it('omits empty query params from the call', async () => {
    await get('?actor_staff_id=');

    expect(fetchAuditEntries).toHaveBeenCalledWith(staffConfig, {});
  });
});
