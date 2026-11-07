/**
 * Unit test của `GET /api/entitlements` sau P5.4 (issue #478): entitlement của
 * một staff đọc từ Staff Access management API qua `fetchStaffEntitlements`,
 * không từ `db-backoffice` trực tiếp. Giam sát fail-closed: client chưa cấu
 * hình / gọi thất bại ⇒ `503`; thiếu `staff_id` ⇒ `400`.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PRINCIPAL_CONTEXT_KEY } from '../principal';
import entitlementsRoute from './entitlements.get';
import {
  fetchStaffEntitlements,
  staffAccessClientConfig,
} from '@ecoma-io/backoffice-infrastructure';
import type { StaffEntitlementsCallResult } from '@ecoma-io/backoffice-infrastructure';

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
    staffAccessClientConfig: vi.fn<[unknown], StaffEntitlementsCallResult | null>(
      () => staffConfig as unknown as StaffEntitlementsCallResult | null,
    ),
    fetchStaffEntitlements: vi.fn<[unknown, string], StaffEntitlementsCallResult>(async () => ({
      ok: true,
      entitlements: ENTITLEMENTS,
    })),
  };
});

let readEnv: Record<string, unknown> = {};
const staffBinding = vi.hoisted(() =>
  fakeBinding(JSON.stringify({ entitlements: [], next_cursor: null })),
);
const staffConfig = vi.hoisted(() => ({
  binding: staffBinding,
  signHeaders: vi.fn<[string], Record<string, string>>().mockResolvedValue({}),
}));

const SUB = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ENTITLEMENTS = [
  { product: 'backoffice', status: 'entitled' },
  { product: 'mail', status: 'revoked' },
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
  router.get('/api/entitlements', entitlementsRoute);
  app.use(router.handler);

  const response = await toWebHandler(app)(
    new Request(`http://localhost/api/entitlements${query}`),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

describe('GET /api/entitlements — staff-access source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readEnv = { DB_BACKOFFICE: { connectionString: 'postgres://fake' } };
    (staffAccessClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(staffConfig);
    (fetchStaffEntitlements as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      entitlements: ENTITLEMENTS,
    });
    staffBinding.fetch.mockClear();
  });

  it('answers 400 when staff_id is missing', async () => {
    const { status } = await get('');

    expect(status).toBe(400);
    expect(fetchStaffEntitlements).not.toHaveBeenCalled();
  });

  it('answers 400 when staff_id is empty', async () => {
    const { status } = await get('?staff_id=');

    expect(status).toBe(400);
    expect(fetchStaffEntitlements).not.toHaveBeenCalled();
  });

  it('answers 503 when the staff-access client is unconfigured', async () => {
    (staffAccessClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const { status } = await get('?staff_id=s1');

    expect(status).toBe(503);
    expect(fetchStaffEntitlements).not.toHaveBeenCalled();
  });

  it('answers 503 when staff-access call fails', async () => {
    (fetchStaffEntitlements as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'unreachable',
    });

    const { status, body } = await get('?staff_id=s1');

    expect(status).toBe(503);
    expect(body).toEqual(expect.objectContaining({ statusCode: 503 }));
  });

  it('answers 200 with entitlements mapped from staff-access wire shape', async () => {
    const { status, body } = await get('?staff_id=s1');

    expect(status).toBe(200);
    expect(body).toEqual({
      entitlements: [
        { product: 'backoffice', status: 'entitled' },
        { product: 'mail', status: 'revoked' },
      ],
    });
    expect(fetchStaffEntitlements).toHaveBeenCalledTimes(1);
    expect(staffBinding.fetch).not.toHaveBeenCalled();
  });

  it('passes staff_id to the staff-access call through fetchStaffEntitlements', async () => {
    await get('?staff_id=s1');

    expect(fetchStaffEntitlements).toHaveBeenCalledWith(staffConfig, 's1');
  });
});
