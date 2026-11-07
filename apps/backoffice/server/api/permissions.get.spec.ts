/**
 * Unit test của `GET /api/permissions` sau P5.1 (issue #475): permission
 * catalog đọc từ Staff Access management API qua `fetchPermissionCatalog`,
 * không từ `db-backoffice` trực tiếp. Giam sát fail-closed: client chưa
 * cấu hình / gọi thất bại ⇒ `503`.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PRINCIPAL_CONTEXT_KEY } from '../principal';
import permissionsRoute from './permissions.get';
import {
  staffAccessClientConfig,
  fetchPermissionCatalog,
} from '@ecoma-io/backoffice-infrastructure';
import type { PermissionCatalogCallResult } from '@ecoma-io/backoffice-infrastructure';

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
    staffAccessClientConfig: vi.fn<[unknown], PermissionCatalogCallResult | null>(
      () => staffConfig as unknown as PermissionCatalogCallResult | null,
    ),
    fetchPermissionCatalog: vi.fn<[], PermissionCatalogCallResult>(() => ({
      ok: true,
      permissions: PERMISSION_ENTRIES,
    })),
  };
});

let readEnv: Record<string, unknown> = {};
const staffBinding = vi.hoisted(() =>
  fakeBinding(JSON.stringify({ permissions: [], next_cursor: null })),
);
const staffConfig = vi.hoisted(() => ({
  binding: staffBinding,
  signHeaders: vi.fn<[string], Record<string, string>>().mockResolvedValue({}),
}));

const SUB = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const PERMISSION_ENTRIES = [
  {
    id: 'staff.read',
    domain: 'staff',
    action: 'read',
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'role.read',
    domain: 'role',
    action: 'read',
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
  router.get('/api/permissions', permissionsRoute);
  app.use(router.handler);

  const response = await toWebHandler(app)(new Request('http://localhost/api/permissions'));
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

describe('GET /api/permissions — staff-access source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readEnv = { DB_BACKOFFICE: { connectionString: 'postgres://fake' } };
    (staffAccessClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(staffConfig);
    (fetchPermissionCatalog as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      permissions: PERMISSION_ENTRIES,
    });
    staffBinding.fetch.mockClear();
  });

  it('answers 503 when the staff-access client is unconfigured', async () => {
    (staffAccessClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const { status } = await get();

    expect(status).toBe(503);
    expect(fetchPermissionCatalog).not.toHaveBeenCalled();
  });

  it('answers 503 when staff-access call fails', async () => {
    (fetchPermissionCatalog as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'http_error',
    });

    const { status, body } = await get();

    expect(status).toBe(503);
    expect(body).toEqual(expect.objectContaining({ statusCode: 503 }));
  });

  it('answers 200 with permissions mapped from staff-access wire shape', async () => {
    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body).toEqual({
      permissions: [
        { id: 'staff.read', domain: 'staff', action: 'read', status: 'active' },
        { id: 'role.read', domain: 'role', action: 'read', status: 'active' },
      ],
    });
    expect(fetchPermissionCatalog).toHaveBeenCalledTimes(1);
  });
});
