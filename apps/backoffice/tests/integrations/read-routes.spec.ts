/**
 * Integration test cho 3 read route của issue #99 — `GET /api/staff`,
 * `GET /api/roles`, `GET /api/permissions`.
 *
 * ## Vì sao test này tồn tại
 *
 * Ba route đi qua **đúng** đường production: h3 app thật, handler thật của
 * `server/api/**`, `requirePermission` thật, `recordDecision` thật, và
 * PostgreSQL thật của testcontainers với **credential runtime role thật**
 * (`ecoma_backoffice_runtime`). Unit test với fake client không bắt được:
 * - grant của runtime role trên từng bảng (một `SELECT *` sai cột là fail
 *   lúc chạy thật, không phải lúc assert),
 * - đường audit `denied` ghi được vào `backoffice.authorization_audit` bằng
 *   credential runtime (bảng này chỉ grant SELECT+INSERT cho runtime),
 * - hình dạng response thật (403/503) sau khi h3 bọc lỗi.
 *
 * ## Ba nhánh fail-closed được ghim
 *
 * 1. **Happy path** — staff có assignment còn hiệu lực giữ `staff.read` ⇒
 *    `200` + payload đúng.
 * 2. **Denied path** — staff không có permission ⇒ `403` **và** một dòng
 *    audit `denied` trong `backoffice.authorization_audit` (audit trước khi
 *    throw — quy tắc của workstream B).
 * 3. **Unavailable path** — `401` khi request không có principal (ADR-0011 §3:
 *    thiếu/invalid credential là 401 — middleware authn của PR J2 flip từ 503;
 *    route giữ `503` cho binding `DB_BACKOFFICE` vắng hay DB không trả lời).
 *
 * ⚠️ Docker là phụ thuộc cứng: probe Docker ở `harness.ts` (qua `globalSetup`)
 * ném lỗi khi vắng Docker, làm **toàn bộ** lần chạy đỏ thay vì skip — chính
 * sách fail-loud của 06-testing.md §6.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS } from '@ecoma-io/backoffice-domain';

import staffRoute from '../../server/api/staff.get';
import rolesRoute from '../../server/api/roles.get';
import permissionsRoute from '../../server/api/permissions.get';
import { PRINCIPAL_CONTEXT_KEY } from '../../server/principal';
import {
  STAFF_ACCESS_SERVICE_BINDING_NAME,
  AUTH_INTERNAL_SECRET_ENV,
} from '@ecoma-io/backoffice-infrastructure';
import { BACKOFFICE_DATABASE, type BackofficeDatabase, startBackofficeDatabase } from './harness';

/**
 * Account ID hợp lệ theo `isBackofficeAccountId`: prefix `sub_` + 32 ký tự
 * base32 viết thường (`a`…`z`, `2`…`7`) — 160 bit, đúng bằng entropy mà
 * producer (`account`) cấp.
 *
 * ⚠️ Độ dài lấy từ hằng `BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS` chứ không viết
 * literal: `isBackofficeAccountId` từ chối mọi `sub` khác độ dài, nên một
 * literal lệch (52 ký tự — format local cũ đã bị gỡ ở F1, issue #101) làm
 * `readPrincipal` trả `null` ⇒ `requirePrincipal` ném `401` ⇒ mọi test ở đây
 * đỏ **vì lý do sai**.
 */
function accountId(char: string): string {
  return `sub_${char.repeat(BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS)}`;
}

const READER = accountId('a');
const NO_PERMISSION_STAFF = accountId('b');
const SUSPENDED_STAFF = accountId('c');

const SECRET = 'test-internal-hmac-secret-0123456789abcdef';

/** Service Binding giả trả staff directory (P5.1) — nhân sự bây giờ đến từ
 * Staff Access management API, không còn từ `db-backoffice`. Các sub dưới đây
 * khớp với staff được seed trong `beforeEach` để enforcement `staff.read`
 * vẫn đúng, còn dữ liệu danh sách đi qua binding này. */
const staffBinding = {
  fetch: async () =>
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
            id: 's-noperm',
            sub: NO_PERMISSION_STAFF,
            status: 'active',
            display_name: 'Không Quyền',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 's-suspended',
            sub: SUSPENDED_STAFF,
            status: 'suspended',
            display_name: 'Bị Khóa',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        next_cursor: null,
      }),
      { status: 200 },
    ),
};

/**
 * Dựng h3 app với 3 route thật rồi gọi một path.
 *
 * ⚠️ Middleware gắn `event.context.cloudflare.env` (binding Worker) và
 * `event.context.backofficePrincipal` (principal đã verify server-side) — hai
 * thứ mà **middleware xác thực tương lai** của app sẽ gắn. Route chỉ đọc
 * chúng, không tự verify.
 */
async function get(
  path: string,
  options: {
    readonly env?: Record<string, unknown>;
    readonly principal?: { readonly actorSub: string };
  } = {},
): Promise<{ status: number; body: unknown }> {
  const app = createApp();
  app.use(
    defineEventHandler((event) => {
      if (options.env !== undefined) {
        event.context.cloudflare = { env: options.env };
      }
      if (options.principal !== undefined) {
        event.context[PRINCIPAL_CONTEXT_KEY] = options.principal;
      }
    }),
  );
  const router = createRouter();
  router.get('/api/staff', staffRoute);
  router.get('/api/roles', rolesRoute);
  router.get('/api/permissions', permissionsRoute);
  app.use(router.handler);

  const response = await toWebHandler(app)(new Request(`http://localhost${path}`));
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

describe('read routes /api/staff, /api/roles, /api/permissions', () => {
  let db: BackofficeDatabase;

  /**
   * Connection string của runtime role trỏ tới container thật của test —
   * đúng hình dạng binding Hyperdrive (`{ connectionString }`).
   */
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
    await db.truncateData();

    // Staff có `staff.read` qua role system-defined `sys_staff_reader`.
    const client = await db.connect();
    try {
      // `truncateData` xoá cả `backoffice.permissions` — nên seed lại đúng 3
      // permission read mà migration `0003` đã seed (ADR-0010). Không seed lại
      // thì FK `role_permissions_permission_id_fkey` chặn mọi gán permission.
      await client.query(
        `INSERT INTO backoffice.permissions (id, domain, action, status) VALUES
           ('staff.read', 'staff', 'read', 'active'),
           ('role.read', 'role', 'read', 'active'),
           ('permission.read', 'permission', 'read', 'active')`,
      );
      await client.query(
        `INSERT INTO backoffice.staff (sub, status) VALUES
           ($1, 'active'), ($2, 'active'), ($3, 'suspended')`,
        [READER, NO_PERMISSION_STAFF, SUSPENDED_STAFF],
      );
      await client.query(
        `INSERT INTO backoffice.roles (id, is_system) VALUES ('sys_staff_reader', true)`,
      );
      await client.query(
        `INSERT INTO backoffice.role_permissions (role_id, permission_id)
           VALUES ('sys_staff_reader', 'staff.read'),
                  ('sys_staff_reader', 'role.read'),
                  ('sys_staff_reader', 'permission.read')`,
      );
      await client.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id) VALUES ($1, 'sys_staff_reader')`,
        [READER],
      );
    } finally {
      await client.end();
    }
  });

  describe('happy path', () => {
    it('returns 200 with the staff directory for a principal holding staff.read', async () => {
      const { status, body } = await get('/api/staff', {
        env: {
          DB_BACKOFFICE: { connectionString: runtimeConnectionString() },
          [STAFF_ACCESS_SERVICE_BINDING_NAME]: staffBinding,
          [AUTH_INTERNAL_SECRET_ENV]: SECRET,
        },
        principal: { actorSub: READER },
      });

      expect(status).toBe(200);
      // Thứ tự là `ORDER BY sub` — không phải thứ tự insert. `displayName` do
      // issue #325 thêm: env ở đây không có binding `ACCOUNT_SERVICE`, nên
      // merge degrade về `null` cho mọi hàng — controlled degrade của sổ staff.
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
            id: 's-noperm',
            sub: NO_PERMISSION_STAFF,
            status: 'active',
            display_name: 'Không Quyền',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            displayName: null,
          },
          {
            id: 's-suspended',
            sub: SUSPENDED_STAFF,
            status: 'suspended',
            display_name: 'Bị Khóa',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            displayName: null,
          },
        ],
      });
    });

    it('returns 403 for a principal without the read permission', async () => {
      const { status } = await get('/api/staff', {
        env: { DB_BACKOFFICE: { connectionString: runtimeConnectionString() } },
        principal: { actorSub: NO_PERMISSION_STAFF },
      });

      expect(status).toBe(403);
    });
  });

  describe('denied path writes an audit row', () => {
    it('records the denial in backoffice.authorization_audit before answering 403', async () => {
      const { status } = await get('/api/roles', {
        env: { DB_BACKOFFICE: { connectionString: runtimeConnectionString() } },
        principal: { actorSub: NO_PERMISSION_STAFF },
      });

      expect(status).toBe(403);

      const client = await db.connect();
      try {
        const { rows } = await client.query<{
          actor_sub: string;
          action: string;
          outcome: string;
          reason_code: string;
        }>(
          `SELECT actor_sub, action, outcome, reason_code
             FROM backoffice.authorization_audit
            WHERE actor_sub = $1
            ORDER BY occurred_at`,
          [NO_PERMISSION_STAFF],
        );
        expect(rows).toEqual([
          {
            actor_sub: NO_PERMISSION_STAFF,
            action: 'role.read',
            outcome: 'denied',
            reason_code: 'normal:permission_not_granted',
          },
        ]);
      } finally {
        await client.end();
      }
    });
  });

  describe('unavailable path', () => {
    it('answers 401 when the request carries no principal (ADR-0011 §3, was 503)', async () => {
      const { status } = await get('/api/permissions', {
        env: { DB_BACKOFFICE: { connectionString: runtimeConnectionString() } },
      });

      expect(status).toBe(401);
    });

    it('answers 503 when the DB binding is absent', async () => {
      const { status } = await get('/api/staff', {
        env: {},
        principal: { actorSub: READER },
      });

      expect(status).toBe(503);
    });

    it('answers 503 when the database is unreachable', async () => {
      // Port không có PostgreSQL ⇒ lỗi driver, không phải lỗi hình dạng
      // binding ⇒ vẫn phải là 503 (fail closed), không phải 500.
      const { status } = await get('/api/staff', {
        env: {
          DB_BACKOFFICE: {
            connectionString: `postgres://ecoma_backoffice_runtime:${db.rolePassword}@127.0.0.1:1/${BACKOFFICE_DATABASE}`,
          },
        },
        principal: { actorSub: READER },
      });

      expect(status).toBe(503);
    });
  });

  describe('no direct cross-domain database access (fail-closed when staff-access unavailable)', () => {
    it('answers 503 for /api/staff when staff-access binding is absent even though DB is present', async () => {
      const { status } = await get('/api/staff', {
        env: { DB_BACKOFFICE: { connectionString: runtimeConnectionString() } },
        principal: { actorSub: READER },
      });

      expect(status).toBe(503);
    });

    it('answers 503 for /api/roles when staff-access binding is absent even though DB is present', async () => {
      const { status } = await get('/api/roles', {
        env: { DB_BACKOFFICE: { connectionString: runtimeConnectionString() } },
        principal: { actorSub: READER },
      });

      expect(status).toBe(503);
    });

    it('answers 503 for /api/permissions when staff-access binding is absent even though DB is present', async () => {
      const { status } = await get('/api/permissions', {
        env: { DB_BACKOFFICE: { connectionString: runtimeConnectionString() } },
        principal: { actorSub: READER },
      });

      expect(status).toBe(503);
    });
  });
});
