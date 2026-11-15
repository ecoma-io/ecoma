/**
 * Integration test cho ba write route của issue #191 — `POST /api/staff`,
 * `POST /api/staff/:id/assignments`, `POST /api/assignments/revoke`.
 *
 * ## Ranh giới được ghim
 *
 * BFF **không** phải nguồn quyết định quyền thứ hai (ADR-0023 Quyết định 2):
 * route chỉ kiểm session (principal) + CSRF double-submit, rồi forward tới
 * staff-access qua write client đã ký HMAC. Vì vậy bộ test này chứng minh:
 *
 * 1. **401** — không có principal (middleware authn là đường duy nhất gắn nó).
 * 2. **403** — CSRF cookie vắng hoặc header không khớp (write fail closed,
 *    khác logout nơi thiếu cookie là no-op).
 * 3. **400** — body sai contract (validate trước khi chạm staff-access).
 * 4. **503** — binding staff-access vắng / không ký được (fail-closed).
 * 5. **Happy path + forward nguyên vẹn** — 201/200 với payload của
 *    staff-access; **403 denial** (`role.assign` thiếu) và **403
 *    `self_revocation_last_administrator`** được forward kèm `message` đúng
 *    của staff-access, không bị nuốt.
 *
 * staff-access được thay bằng Service Binding giả: các write route **không**
 * đọc DB (khác read route), nên không cần PostgreSQL — binding giả khớp
 * contract là đủ để thấy đúng đường đi request.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import createStaffRoute from '../../server/api/staff.post';
import createAssignmentRoute from '../../server/api/staff/[id]/assignments/index.post';
import revokeAssignmentRoute from '../../server/api/assignments/revoke.post';
import { PRINCIPAL_CONTEXT_KEY } from '../../server/principal';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  STAFF_ACCESS_SERVICE_BINDING_NAME,
  AUTH_INTERNAL_SECRET_ENV,
} from '@ecoma-io/backoffice-infrastructure';

const ACTOR = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW_STAFF_SUB = 'sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const CSRF_COOKIE = `${CSRF_COOKIE_NAME}=csrf-token-test`;
const CSRF_HEADER = 'csrf-token-test';

/** Binding giả staff-access — mỗi test cấu hình route → (status, body). */
type FakeRoute = (
  path: string,
  method: string,
) => { readonly status: number; readonly body: unknown };

function bindingWith(respond: FakeRoute): { fetch: (input: Request) => Promise<Response> } {
  return {
    fetch: async (input: Request) => {
      const url = new URL(input.url);
      const route = respond(url.pathname, input.method);
      return new Response(JSON.stringify(route.body), { status: route.status });
    },
  };
}

/** Env chuẩn: binding + secret. DB binding không cần cho write route. */
function envWith(binding: {
  fetch: (input: Request) => Promise<Response>;
}): Record<string, unknown> {
  return {
    [STAFF_ACCESS_SERVICE_BINDING_NAME]: binding,
    [AUTH_INTERNAL_SECRET_ENV]: 'test-internal-hmac-secret-0123456789abcdef',
  };
}

/**
 * Dựng h3 app với ba write route thật rồi POST một path.
 *
 * Middleware gắn `event.context.cloudflare.env` + principal — cùng mô hình với
 * `read-routes.spec.ts`: hai thứ mà middleware authn thật gắn trước route.
 */
async function post(
  path: string,
  options: {
    readonly body?: unknown;
    readonly env?: Record<string, unknown>;
    readonly principal?: { readonly actorSub: string };
    readonly csrfCookie?: string;
    readonly csrfHeader?: string;
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
      if (options.csrfCookie !== undefined) {
        const existing = event.node.req.headers.cookie;
        event.node.req.headers.cookie =
          existing === undefined ? options.csrfCookie : `${existing}; ${options.csrfCookie}`;
      }
    }),
  );
  const router = createRouter();
  router.post('/api/staff', createStaffRoute);
  router.post('/api/staff/:id/assignments', createAssignmentRoute);
  router.post('/api/assignments/revoke', revokeAssignmentRoute);
  app.use(router.handler);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.csrfHeader !== undefined) {
    headers[CSRF_HEADER_NAME] = options.csrfHeader;
  }
  const response = await toWebHandler(app)(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body ?? {}),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

describe('write routes: session + CSRF only, permission verdict lives in staff-access', () => {
  /** Binding mặc định — không test nào trong describe này tới được nó. */
  let binding: { fetch: (input: Request) => Promise<Response> };
  let env: Record<string, unknown>;

  beforeAll(() => {
    binding = bindingWith(() => ({ status: 500, body: { error: 'unexpected' } }));
    env = envWith(binding);
  });

  afterAll(() => {
    // Binding giả không giữ tài nguyên nào — không dọn gì.
  });

  describe('authentication (401)', () => {
    it('answers 401 on POST /api/staff without a principal', async () => {
      const { status } = await post('/api/staff', {
        env,
        body: { sub: NEW_STAFF_SUB, display_name: 'Nhân Viên Mới' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });
      expect(status).toBe(401);
    });

    it('answers 401 on POST /api/staff/:id/assignments without a principal', async () => {
      const { status } = await post('/api/staff/s-1/assignments', {
        env,
        body: { role_id: 'role-1' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });
      expect(status).toBe(401);
    });

    it('answers 401 on POST /api/assignments/revoke without a principal', async () => {
      const { status } = await post('/api/assignments/revoke', {
        env,
        body: { id: 'asg-1' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });
      expect(status).toBe(401);
    });
  });

  describe('CSRF double-submit (403, fail closed)', () => {
    it('answers 403 on POST /api/staff when the CSRF cookie is absent', async () => {
      const { status } = await post('/api/staff', {
        env,
        principal: { actorSub: ACTOR },
        body: { sub: NEW_STAFF_SUB, display_name: 'Nhân Viên Mới' },
        // Không cookie, không header.
      });
      expect(status).toBe(403);
    });

    it('answers 403 when the header does not echo the cookie', async () => {
      const { status } = await post('/api/assignments/revoke', {
        env,
        principal: { actorSub: ACTOR },
        body: { id: 'asg-1' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: 'other-token',
      });
      expect(status).toBe(403);
    });

    it('answers 403 on POST /api/staff/:id/assignments when the header is missing', async () => {
      const { status } = await post('/api/staff/s-1/assignments', {
        env,
        principal: { actorSub: ACTOR },
        body: { role_id: 'role-1' },
        csrfCookie: CSRF_COOKIE,
        // Không header.
      });
      expect(status).toBe(403);
    });
  });

  describe('body validation (400, before staff-access is called)', () => {
    it('answers 400 on POST /api/staff with a malformed sub', async () => {
      const { status } = await post('/api/staff', {
        env,
        principal: { actorSub: ACTOR },
        body: { sub: 'not-a-sub', display_name: 'Nhân Viên Mới' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });
      expect(status).toBe(400);
    });

    it('answers 400 on POST /api/staff with a forbidden identity field', async () => {
      const { status } = await post('/api/staff', {
        env,
        principal: { actorSub: ACTOR },
        body: { sub: NEW_STAFF_SUB, display_name: 'Nhân Viên Mới', email: 'x@y.z' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });
      expect(status).toBe(400);
    });

    it('answers 400 on POST /api/assignments/revoke with a missing id', async () => {
      const { status } = await post('/api/assignments/revoke', {
        env,
        principal: { actorSub: ACTOR },
        body: {},
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });
      expect(status).toBe(400);
    });

    it('answers 400 on POST /api/staff/:id/assignments with a missing role_id', async () => {
      const { status } = await post('/api/staff/s-1/assignments', {
        env,
        principal: { actorSub: ACTOR },
        body: {},
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });
      expect(status).toBe(400);
    });
  });

  describe('fail-closed infrastructure (503)', () => {
    it('answers 503 on POST /api/staff when the staff-access binding is absent', async () => {
      const { status } = await post('/api/staff', {
        env: { [AUTH_INTERNAL_SECRET_ENV]: 'test-internal-hmac-secret-0123456789abcdef' },
        principal: { actorSub: ACTOR },
        body: { sub: NEW_STAFF_SUB, display_name: 'Nhân Viên Mới' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });
      expect(status).toBe(503);
    });

    it('answers 503 on POST /api/assignments/revoke when the secret is absent', async () => {
      const { status } = await post('/api/assignments/revoke', {
        env: { [STAFF_ACCESS_SERVICE_BINDING_NAME]: binding },
        principal: { actorSub: ACTOR },
        body: { id: 'asg-1' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });
      expect(status).toBe(503);
    });
  });

  describe('happy path + forward of the staff-access verdict, unchanged', () => {
    it('returns 201 with the created staff on POST /api/staff', async () => {
      const staff = {
        id: 's-new',
        sub: NEW_STAFF_SUB,
        status: 'active',
        display_name: 'Nhân Viên Mới',
        created_at: '2026-11-15T00:00:00Z',
        updated_at: '2026-11-15T00:00:00Z',
      };
      const fake = bindingWith((path, method) =>
        path === '/staff' && method === 'POST'
          ? { status: 201, body: staff }
          : { status: 404, body: { error: 'not found' } },
      );

      const { status, body } = await post('/api/staff', {
        env: envWith(fake),
        principal: { actorSub: ACTOR },
        body: { sub: NEW_STAFF_SUB, display_name: 'Nhân Viên Mới' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });

      expect(status).toBe(201);
      expect(body).toEqual(staff);
    });

    it('returns 201 with the created assignment on POST /api/staff/:id/assignments', async () => {
      const assignment = {
        id: 'asg-new',
        staff_id: 's-1',
        role_id: 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b',
        scope: { label: 'global' },
        effective_from: '2026-11-15T00:00:00Z',
        effective_until: null,
        granted_by: null,
        created_at: '2026-11-15T00:00:00Z',
        revoked_at: null,
      };
      const fake = bindingWith((path, method) =>
        path === '/staff/s-1/assignments' && method === 'POST'
          ? { status: 201, body: assignment }
          : { status: 404, body: { error: 'not found' } },
      );

      const { status, body } = await post('/api/staff/s-1/assignments', {
        env: envWith(fake),
        principal: { actorSub: ACTOR },
        body: { role_id: 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });

      expect(status).toBe(201);
      expect(body).toEqual(assignment);
    });

    it('returns the assignment on POST /api/assignments/revoke', async () => {
      const assignment = {
        id: 'asg-1',
        staff_id: 's-1',
        role_id: 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b',
        scope: { label: 'global' },
        effective_from: '2026-11-15T00:00:00Z',
        effective_until: null,
        granted_by: null,
        created_at: '2026-11-15T00:00:00Z',
        revoked_at: '2026-11-15T01:00:00Z',
      };
      const fake = bindingWith((path, method) =>
        path === '/assignments/revoke' && method === 'POST'
          ? { status: 200, body: assignment }
          : { status: 404, body: { error: 'not found' } },
      );

      const { status, body } = await post('/api/assignments/revoke', {
        env: envWith(fake),
        principal: { actorSub: ACTOR },
        body: { id: 'asg-1' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });

      expect(status).toBe(200);
      expect(body).toEqual(assignment);
    });

    it('forwards the 403 permission denial with its message (role.assign missing)', async () => {
      // staff-access trả 403 + audit `denied` đã commit; BFF không được nuốt
      // hay đổi verdict — message domain phải tới UI nguyên vẹn.
      const fake = bindingWith((path, method) =>
        path === '/staff/s-1/assignments' && method === 'POST'
          ? {
              status: 403,
              body: { error: 'forbidden', message: 'Permission role.assign is not granted.' },
            }
          : { status: 404, body: { error: 'not found' } },
      );

      const { status, body } = await post('/api/staff/s-1/assignments', {
        env: envWith(fake),
        principal: { actorSub: ACTOR },
        body: { role_id: 'role-1' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });

      expect(status).toBe(403);
      // h3 bọc `createError` thành envelope `{ statusCode, statusMessage }`:
      // `statusMessage` chính là message domain của staff-access, đi tới UI
      // nguyên vẹn qua `BackofficeRouteError` của adapter.
      expect(body).toEqual({
        statusCode: 403,
        statusMessage: 'Permission role.assign is not granted.',
        stack: [],
      });
    });

    it('forwards the 403 self-revocation-of-last-administrator guard with its message', async () => {
      // Guard của #44: administrator cuối cùng không tự thu hồi mình — message
      // `self_revocation_last_administrator` phải đi tới UI để operator hiểu lý do.
      const fake = bindingWith((path, method) =>
        path === '/assignments/revoke' && method === 'POST'
          ? {
              status: 403,
              body: {
                error: 'forbidden',
                message: 'Cannot revoke the last administrator assignment (self-revocation).',
              },
            }
          : { status: 404, body: { error: 'not found' } },
      );

      const { status, body } = await post('/api/assignments/revoke', {
        env: envWith(fake),
        principal: { actorSub: ACTOR },
        body: { id: 'asg-last-admin' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });

      expect(status).toBe(403);
      expect(body).toEqual({
        statusCode: 403,
        statusMessage: 'Cannot revoke the last administrator assignment (self-revocation).',
        stack: [],
      });
    });

    it('forwards the 409 conflict (duplicate staff) with its message', async () => {
      const fake = bindingWith((path, method) =>
        path === '/staff' && method === 'POST'
          ? { status: 409, body: { error: 'conflict', message: 'Staff already exists.' } }
          : { status: 404, body: { error: 'not found' } },
      );

      const { status, body } = await post('/api/staff', {
        env: envWith(fake),
        principal: { actorSub: ACTOR },
        body: { sub: NEW_STAFF_SUB, display_name: 'Nhân Viên Mới' },
        csrfCookie: CSRF_COOKIE,
        csrfHeader: CSRF_HEADER,
      });

      expect(status).toBe(409);
      expect(body).toEqual({
        statusCode: 409,
        statusMessage: 'Staff already exists.',
        stack: [],
      });
    });
  });
});
