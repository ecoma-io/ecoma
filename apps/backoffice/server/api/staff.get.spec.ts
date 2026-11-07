/**
 * Unit test của `GET /api/staff` sau P5.1 (issue #475): staff directory đọc
 * từ Staff Access management API qua `fetchStaffDirectory`, sau đó merge
 * `displayName` từ `account` (issue #325, giữ nguyên).
 *
 * Suite ghim các quyết định chính sách: client staff-access chưa cấu hình
 * ⇒ `503`; staff-access trả lỗi ⇒ `503` + log; account hỏng ⇒ controlled
 * degrade (`200` với `displayName: null`). Service Binding của cả hai client
 * là mock duy nhất.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PRINCIPAL_CONTEXT_KEY } from '../principal';
import staffRoute from './staff.get';
import { resetDisplayNameCacheForTests, storeDisplayNames } from '@ecoma-io/backoffice-application';
import {
  accountClientConfig,
  fetchAccountProfiles,
  fetchStaffDirectory,
  staffAccessClientConfig,
} from '@ecoma-io/backoffice-infrastructure';
import type {
  AccountClientConfig,
  StaffAccessClientConfig,
  StaffDirectoryCallResult,
} from '@ecoma-io/backoffice-infrastructure';

const writeLog = vi.fn<(entry: Record<string, unknown>) => void>();
vi.mock('../log', () => ({ writeLog: (...args: unknown[]) => writeLog(...args) }));

// Enforcement giữ allow — subject của suite này là staff-access source +
// displayName merge, không phải permission checkpoint (có spec riêng).
vi.mock('../authorization', () => ({
  requirePermission: async () => ({
    allowed: true,
    stale: false,
    denial: null,
    riskClass: 'normal',
  }),
}));

// ⚠️ KHÔNG mock `../db`: `readWorkerEnv`/`poolBinding` giữ bản thật — đọc
// `event.context.cloudflare.env` (test gắn `readEnv` vào đó ở `get()` dưới),
// và `backofficeHyperdrive` của factory mock dưới trả `readEnv.DB_BACKOFFICE`
// ⇒ đường điều khiển enforcement không đổi.
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
    // staff-access client: config + fetch kiểm soát bởi test qua `vi.hoisted`.
    staffAccessClientConfig: vi.fn<[unknown], StaffAccessClientConfig | null>(() => staffConfig),
    fetchStaffDirectory: vi.fn<[], StaffDirectoryCallResult>(async () => ({
      ok: true,
      staff: STAFF_MEMBERS,
    })),
    // account client: config + profiles kiểm soát bởi test qua `vi.hoisted`.
    accountClientConfig: vi.fn<[unknown], AccountClientConfig | null>(() => accountConfig),
    fetchAccountProfiles: vi.fn<[Record<string, string>, readonly string[]]>(async () => ({
      ok: true,
      profiles: ACCOUNT_PROFILES,
    })),
  };
});

const staffBinding = vi.hoisted(() =>
  fakeBinding(JSON.stringify({ staff: [], next_cursor: null })),
);
const staffConfig = vi.hoisted(() => ({
  binding: staffBinding,
  signHeaders: vi.fn<[string], Record<string, string>>().mockResolvedValue({}),
}));

const accountBinding = vi.hoisted(() =>
  fakeBinding(JSON.stringify({ profiles: [], next_cursor: null })),
);
const accountConfig = vi.hoisted(() => ({
  binding: accountBinding,
  signHeaders: vi.fn<[string], Record<string, string>>().mockResolvedValue({}),
}));

let readEnv: Record<string, unknown> = {};

const SUB_A = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SUB_B = 'sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SECRET = 'unit-test-internal-secret-0123456789abcdef';

const STAFF_MEMBERS = [
  {
    id: 's1',
    sub: SUB_A,
    status: 'active',
    display_name: 'Nguyễn Văn A',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 's2',
    sub: SUB_B,
    status: 'suspended',
    display_name: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const ACCOUNT_PROFILES = [
  { sub: SUB_A, displayName: 'Nguyễn Văn A' },
  { sub: SUB_B, displayName: null },
];

/** Binding giả trả body sẵn. */
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
      event.context[PRINCIPAL_CONTEXT_KEY] = { actorSub: SUB_A };
    }),
  );
  const router = createRouter();
  router.get('/api/staff', staffRoute);
  app.use(router.handler);

  const response = await toWebHandler(app)(new Request('http://localhost/api/staff'));
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

const staffRow = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 's1',
  sub: SUB_A,
  status: 'active',
  display_name: 'Nguyễn Văn A',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('GET /api/staff — staff-access source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDisplayNameCacheForTests();
    // Enforcement đòi binding `DB_BACKOFFICE` trong env (fail-closed 503 khi
    // vắng). Mọi case đều có DB sống; biến số là staff-access + account.
    readEnv = { DB_BACKOFFICE: { connectionString: 'postgres://fake' } };
    (staffAccessClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(staffConfig);
    (fetchStaffDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      staff: STAFF_MEMBERS,
    });
    staffBinding.fetch.mockClear();
    accountBinding.fetch.mockClear();
  });

  it('answers 503 when the staff-access client is unconfigured', async () => {
    (staffAccessClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);
    readEnv = { DB_BACKOFFICE: { connectionString: 'postgres://fake' } };

    const { status } = await get();

    expect(status).toBe(503);
    expect(fetchStaffDirectory).not.toHaveBeenCalled();
  });

  it('answers 503 when staff-access call fails, and logs once', async () => {
    (fetchStaffDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'unreachable',
    });

    const { status, body } = await get();

    expect(status).toBe(503);
    expect(body).toEqual(expect.objectContaining({ statusCode: 503 }));
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'staff_access_directory_failed',
        route: '/api/staff',
        status: 503,
        reason: 'unreachable',
      }),
    );
  });

  it('answers 200 with staff from staff-access and displayName null when account is unconfigured', async () => {
    (accountClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body).toEqual({
      staff: [
        { ...staffRow(), displayName: null },
        {
          ...staffRow({ id: 's2', sub: SUB_B, status: 'suspended', display_name: null }),
          displayName: null,
        },
      ],
    });
    expect(fetchStaffDirectory).toHaveBeenCalledTimes(1);
    expect(fetchAccountProfiles).not.toHaveBeenCalled();
  });

  it('merges display names from a successful account batch call', async () => {
    (accountClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(accountConfig);
    (fetchAccountProfiles as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      profiles: ACCOUNT_PROFILES,
    });
    readEnv = {
      DB_BACKOFFICE: { connectionString: 'postgres://fake' },
      STAFF_ACCESS_SERVICE: staffBinding,
      AUTH_INTERNAL_SECRET: SECRET,
    };

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body).toEqual({
      staff: [
        { ...staffRow(), displayName: 'Nguyễn Văn A' },
        {
          ...staffRow({ id: 's2', sub: SUB_B, status: 'suspended', display_name: null }),
          displayName: null,
        },
      ],
    });
    expect(fetchAccountProfiles).toHaveBeenCalledWith(
      accountConfig,
      expect.arrayContaining([SUB_A, SUB_B]),
    );
    expect(writeLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'staff.account_degraded' }),
    );
  });

  it('asks account only for subs missing from the cache, in one batch', async () => {
    (accountClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(accountConfig);
    (fetchAccountProfiles as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      profiles: [{ sub: SUB_B, displayName: 'B' }],
    });
    readEnv = {
      DB_BACKOFFICE: { connectionString: 'postgres://fake' },
      STAFF_ACCESS_SERVICE: staffBinding,
      AUTH_INTERNAL_SECRET: SECRET,
    };

    storeDisplayNames([{ sub: SUB_A, displayName: 'Cached' }], Date.now());

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body).toEqual({
      staff: [
        { ...staffRow(), displayName: 'Cached' },
        {
          ...staffRow({ id: 's2', sub: SUB_B, status: 'suspended', display_name: null }),
          displayName: 'B',
        },
      ],
    });
    expect(fetchAccountProfiles).toHaveBeenCalledWith(
      accountConfig,
      expect.not.arrayContaining([SUB_A]),
    );
  });

  it('controlled degrade: 200 with displayName null when account fails, logs one line', async () => {
    (accountClientConfig as ReturnType<typeof vi.fn>).mockReturnValue(accountConfig);
    (fetchAccountProfiles as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));
    readEnv = {
      DB_BACKOFFICE: { connectionString: 'postgres://fake' },
      STAFF_ACCESS_SERVICE: staffBinding,
      AUTH_INTERNAL_SECRET: SECRET,
    };

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body).toEqual({
      staff: [
        { ...staffRow(), displayName: null },
        {
          ...staffRow({ id: 's2', sub: SUB_B, status: 'suspended', display_name: null }),
          displayName: null,
        },
      ],
    });
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'staff.account_degraded', reason: 'unreachable' }),
    );
  });
});
