/**
 * Integration test của merge `displayName` trong `GET /api/staff` (issue #325)
 * — PostgreSQL thật, khung enforcement thật, merge + degrade thật.
 *
 * ## Vì sao suite này tồn tại
 *
 * Suite unit (`server/api/staff.get.spec.ts`) mock pool `pg`; suite này chạy
 * **query thật** với credential runtime role thật để chứng minh merge không phá
 * hình dạng response của issue #99 (`{ staff: [{sub, status}] }` giờ có thêm
 * `displayName`), và các nhánh degrade hoạt động khi Service Binding vắng hoặc
 * chết **trong khi DB sống** — tổ hợp mà unit suite không dựng được.
 *
 * ⚠️ P5.1 (issue #475): staff directory giờ đọc từ Staff Access management API
 * qua `STAFF_ACCESS_SERVICE` + `AUTH_INTERNAL_SECRET`, không còn từ DB
 * backoffice. Env của mọi test phải có cả hai binding staff-access, không thì
 * route trả 503 fail-closed.
 *
 * ⚠️ Account thật không có mặt ở đây (không container): binding
 * `ACCOUNT_SERVICE` là **fake `fetch`** gắn thẳng vào
 * `event.context.cloudflare.env` — cùng ranh giới mà client đọc trong production.
 * Đường account thật (envelope HMAC + PostgreSQL account) được chứng minh ở
 * phía provider (`apps/account` `profiles-route-e2e.spec.ts`), còn unit suite
 * của client đã ghim envelope và validation. Xếp lớp như vậy tránh dựng hai
 * container DB trong một suite.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS } from '@ecoma-io/backoffice-domain';

import { accountProfilesResponse } from '@ecoma-io/account-contracts';
import { resetDisplayNameCacheForTests } from '@ecoma-io/backoffice-application';
import {
  ACCOUNT_SERVICE_BINDING_NAME,
  AUTH_INTERNAL_SECRET_ENV,
  STAFF_ACCESS_SERVICE_BINDING_NAME,
} from '@ecoma-io/backoffice-infrastructure';

import staffRoute from '../../server/api/staff.get';
import { PRINCIPAL_CONTEXT_KEY } from '../../server/principal';
import { BACKOFFICE_DATABASE, type BackofficeDatabase, startBackofficeDatabase } from './harness';

const writeLog = vi.fn<(entry: Record<string, unknown>) => void>();
vi.mock('../../server/log', () => ({ writeLog: (...args: unknown[]) => writeLog(...args) }));

/**
 * Đọc entry log `event` mong muốn từ các call đã ghi.
 *
 * ⚠️ Assert qua wrapper `vi.fn` trực tiếp, không qua `vi.mocked()` của export
 * đã mock: trong config integration (`environment: node`, không `deps
 * optimizer`), `vi.mocked()` của export mock trả về tham chiếu không phải spy
 * và assert trên nó ném `TypeError ... is not a spy`. Unit tier không dính vì
 * config unit resolve mock theo cơ chế khác.
 */
function loggedEntry(eventName: string): Record<string, unknown> | undefined {
  return writeLog.mock.calls.map((call) => call[0]).find((entry) => entry.event === eventName);
}

afterEach(() => {
  // `writeLog` là state dùng chung mức file: không xoá calls thì entry degrade
  // của test trước lọt vào `loggedEntry` của test sau (mock giữ calls xuyên
  // test trong config này, không có restore tự động).
  writeLog.mockClear();
});

/** `sub_` + đúng số ký tự entropy của `backoffice-domain`. */
function accountId(seed: string): string {
  return `sub_${seed.padEnd(BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS, 'a').slice(0, BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS)}`;
}

const READER = accountId('a');
const NAMED_STAFF = accountId('b');
const UNNAMED_STAFF = accountId('c');

const SECRET = 'test-internal-hmac-secret-0123456789abcdef';

/** Service Binding giả trả staff directory (P5.1) — nhân sự đến từ Staff Access
 * management API, không từ DB backoffice. Mỗi test gán binding này kèm secret
 * để route đọc được sổ staff, rồi merge tên từ account qua account binding. */
const staffBinding = {
  fetch: vi.fn<() => Promise<Response>>(
    async () =>
      new Response(
        JSON.stringify({
          staff: [
            {
              id: 's-reader',
              sub: READER,
              status: 'active',
              display_name: 'Người Đọc',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
            {
              id: 's-named',
              sub: NAMED_STAFF,
              status: 'active',
              display_name: 'Nguyễn Văn B',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
            {
              id: 's-unnamed',
              sub: UNNAMED_STAFF,
              status: 'active',
              display_name: 'Chưa Đặt Tên',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
          ],
          next_cursor: null,
        }),
        { status: 200 },
      ),
  ),
};

/** Env chuẩn: DB thật + binding staff-access (P5.1) + binding account do test
 * chỉ định. Không có staff-access ⇒ route trả 503 fail-closed. */
function envWithAccount(accountBinding: unknown, connStr: string): Record<string, unknown> {
  return {
    DB_BACKOFFICE: { connectionString: connStr },
    [STAFF_ACCESS_SERVICE_BINDING_NAME]: staffBinding,
    [AUTH_INTERNAL_SECRET_ENV]: SECRET,
    [ACCOUNT_SERVICE_BINDING_NAME]: accountBinding,
  };
}

/** Binding fake trả một response profile sẵn — mock `fetch` của Service Binding. */
function fakeBinding(body: unknown): { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn<() => Promise<Response>>(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    ),
  };
}

async function get(env: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const app = createApp();
  app.use(
    defineEventHandler((event) => {
      event.context.cloudflare = { env };
      event.context[PRINCIPAL_CONTEXT_KEY] = { actorSub: READER };
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

describe('GET /api/staff — displayName merge (integration)', () => {
  let db: BackofficeDatabase;

  function runtimeConnectionString(): string {
    return `postgres://ecoma_backoffice_runtime:${db.rolePassword}@${db.host}:${db.port}/${BACKOFFICE_DATABASE}`;
  }

  beforeAll(async () => {
    db = await startBackofficeDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    resetDisplayNameCacheForTests();
    await db.truncateData();

    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO backoffice.permissions (id, domain, action, status) VALUES
           ('staff.read', 'staff', 'read', 'active')`,
      );
      await client.query(
        `INSERT INTO backoffice.staff (sub, status) VALUES
           ($1, 'active'), ($2, 'active'), ($3, 'active')`,
        [READER, NAMED_STAFF, UNNAMED_STAFF],
      );
      await client.query(
        `INSERT INTO backoffice.roles (id, is_system) VALUES ('sys_staff_reader', true)`,
      );
      await client.query(
        `INSERT INTO backoffice.role_permissions (role_id, permission_id)
           VALUES ('sys_staff_reader', 'staff.read')`,
      );
      await client.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id) VALUES ($1, 'sys_staff_reader')`,
        [READER],
      );
    } finally {
      await client.end();
    }
  });

  it('merges display names from the account batch into the staff directory', async () => {
    const binding = fakeBinding(
      accountProfilesResponse([
        { sub: NAMED_STAFF, displayName: 'Nguyễn Văn B' },
        { sub: UNNAMED_STAFF, displayName: null },
        { sub: READER, displayName: 'Người Đọc' },
      ]),
    );

    const { status, body } = await get(envWithAccount(binding, runtimeConnectionString()));

    expect(status).toBe(200);
    // Thứ tự `ORDER BY sub` của #99 giữ nguyên; `displayName` là trường thêm.
    expect(body).toEqual({
      staff: [
        {
          id: 's-reader',
          sub: READER,
          status: 'active',
          display_name: 'Người Đọc',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: 'Người Đọc',
        },
        {
          id: 's-named',
          sub: NAMED_STAFF,
          status: 'active',
          display_name: 'Nguyễn Văn B',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: 'Nguyễn Văn B',
        },
        {
          id: 's-unnamed',
          sub: UNNAMED_STAFF,
          status: 'active',
          display_name: 'Chưa Đặt Tên',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: null,
        },
      ],
    });
    expect(staffBinding.fetch).toHaveBeenCalledTimes(4);
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it('answers 200 with displayName null when the account binding is absent — controlled degrade', async () => {
    // DB sống (binding Hyperdrive thật), chỉ thiếu binding account.
    const { status, body } = await get({
      DB_BACKOFFICE: { connectionString: runtimeConnectionString() },
      [STAFF_ACCESS_SERVICE_BINDING_NAME]: staffBinding,
      [AUTH_INTERNAL_SECRET_ENV]: SECRET,
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      staff: [
        {
          id: 's-reader',
          sub: READER,
          status: 'active',
          display_name: 'Người Đọc',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: null,
        },
        {
          id: 's-named',
          sub: NAMED_STAFF,
          status: 'active',
          display_name: 'Nguyễn Văn B',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: null,
        },
        {
          id: 's-unnamed',
          sub: UNNAMED_STAFF,
          status: 'active',
          display_name: 'Chưa Đặt Tên',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: null,
        },
      ],
    });
    expect(loggedEntry('staff.account_degraded')).toMatchObject({
      reason: 'account_client_unconfigured',
    });
  });

  it('answers 200 with displayName null when the account call fails, and logs one degrade line', async () => {
    const binding = {
      fetch: vi.fn<() => Promise<Response>>(async () => {
        throw new Error('connection refused');
      }),
    };

    const { status, body } = await get(envWithAccount(binding, runtimeConnectionString()));

    expect(status).toBe(200);
    expect(body).toEqual({
      staff: [
        {
          id: 's-reader',
          sub: READER,
          status: 'active',
          display_name: 'Người Đọc',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: null,
        },
        {
          id: 's-named',
          sub: NAMED_STAFF,
          status: 'active',
          display_name: 'Nguyễn Văn B',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: null,
        },
        {
          id: 's-unnamed',
          sub: UNNAMED_STAFF,
          status: 'active',
          display_name: 'Chưa Đặt Tên',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: null,
        },
      ],
    });
    expect(loggedEntry('staff.account_degraded')).toMatchObject({ reason: 'unreachable' });
  });

  it('answers 200 with displayName null when account returns a contract-violating body — no data leak', async () => {
    // Body sai contract (mang trường định danh) phải bị validator từ chối, và
    // route degrade về null thay vì render dữ liệu không qua hợp đồng.
    const binding = fakeBinding({
      profiles: [{ sub: NAMED_STAFF, displayName: 'X', email: 'leak@example.com' }],
    });

    const { status, body } = await get(envWithAccount(binding, runtimeConnectionString()));

    expect(status).toBe(200);
    expect(body).toEqual({
      staff: [
        {
          id: 's-reader',
          sub: READER,
          status: 'active',
          display_name: 'Người Đọc',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: null,
        },
        {
          id: 's-named',
          sub: NAMED_STAFF,
          status: 'active',
          display_name: 'Nguyễn Văn B',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: null,
        },
        {
          id: 's-unnamed',
          sub: UNNAMED_STAFF,
          status: 'active',
          display_name: 'Chưa Đặt Tên',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          displayName: null,
        },
      ],
    });
    expect(loggedEntry('staff.account_degraded')).toMatchObject({ reason: 'invalid_response' });
  });

  it('sends exactly one batch with only the subs the directory returned', async () => {
    const binding = fakeBinding(
      accountProfilesResponse([
        { sub: READER, displayName: 'R' },
        { sub: NAMED_STAFF, displayName: 'B' },
        { sub: UNNAMED_STAFF, displayName: null },
      ]),
    );

    await get(envWithAccount(binding, runtimeConnectionString()));

    expect(binding.fetch).toHaveBeenCalledTimes(1);
    const request = binding.fetch.mock.calls[0]?.[0] as Request;
    const subs = new URL(request.url).searchParams.get('subs') ?? '';
    expect(subs.split(',').toSorted()).toEqual([NAMED_STAFF, READER, UNNAMED_STAFF].toSorted());
  });
});
