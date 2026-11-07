/**
 * Unit test của `GET /api/roles` sau P5.1 (issue #475): role catalog đọc
 * từ Staff Access management API qua `fetchRoleCatalog`, không từ
 * `db-backoffice` trực tiếp. Giam sát fail-closed: client chưa cấu hình /
 * gọi thất bại ⇒ `503`.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PRINCIPAL_CONTEXT_KEY } from '../principal';
import rolesRoute from './roles.get';
import { staffAccessClientConfig, fetchRoleCatalog } from '@ecoma-io/backoffice-infrastructure';
import type { RoleCatalogCallResult } from '@ecoma-io/backoffice-infrastructure';

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
    staffAccessClientConfig: vi.fn<[unknown], RoleCatalogCallResult | null>(
      () => staffConfig as unknown as RoleCatalogCallResult | null,
    ),
    fetchRoleCatalog: vi.fn<[], RoleCatalogCallResult>(() => ({
      ok: true,
      roles: ROLE_ENTRIES,
    })),
  };
});

let readEnv: Record<string, unknown> = {};
const staffBinding = vi.hoisted(() =>
  fakeBinding(JSON.stringify({ roles: [], next_cursor: null })),
);
const staffConfig = vi.hoisted(() => ({
  binding: staffBinding,
  signHeaders: vi.fn<[string], Record<string, string>>().mockResolvedValue({}),
}));

const SUB = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ROLE_ENTRIES = [
  {
    id: 'operator',
    kind: 'system',
    permissions: ['staff.read'],
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'support',
    kind: 'custom',
    permissions: ['permission.read'],
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
  },
];

function fakeBinding(body: unknown): { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn<(input: Request) => Promise<Response>>(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    ),
  };
}

async function get(): Promise<{ status: number; body: unknown }> {
  const app = createApp();
  app.use(
    defineEventHandler((event) => {
      event.context.cloudflare = { env: readEnv };
      event.context[PRINCIPAL_CONTEXT_KEY] = { actorSub: SUB };
    }),
  );
  const router = createRouter();
  router.get('/api/roles', rolesRoute);
  app.use(router.handler);

  const response = await toWebHandler(app)(new Request('http://localhost/api/roles'));
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

describe('GET /api/roles — staff-access source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readEnv = { DB_BACKOFFICE: { connectionString: 'postgres://fake' } };
    (staffAccessClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(staffConfig);
    (fetchRoleCatalog as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      roles: ROLE_ENTRIES,
    });
    staffBinding.fetch.mockClear();
  });

  it('answers 503 when the staff-access client is unconfigured', async () => {
    (staffAccessClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const { status } = await get();

    expect(status).toBe(503);
    expect(fetchRoleCatalog).not.toHaveBeenCalled();
  });

  it('answers 503 when staff-access call fails', async () => {
    (fetchRoleCatalog as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'unreachable',
    });

    const { status, body } = await get();

    expect(status).toBe(503);
    expect(body).toEqual(expect.objectContaining({ statusCode: 503 }));
  });

  it('answers 200 with roles mapped from staff-access wire shape', async () => {
    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body).toEqual({
      roles: [
        { id: 'operator', isSystem: true },
        { id: 'support', isSystem: false },
      ],
    });
    expect(fetchRoleCatalog).toHaveBeenCalledTimes(1);
  });
});
