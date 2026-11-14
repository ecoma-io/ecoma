/**
 * Unit test của khung chung của 3 read route (`withReadEnforcement`) —
 * classification của các nhánh fail-closed mà suite integration không phủ
 * được vì nó seed dữ liệu hợp lệ: lỗi driver `pg` thành `503`, `H3Error` giữ
 * nguyên status, và connection luôn được release kể cả khi enforcement ném.
 *
 * ⚠️ Mock dừng ở đúng hai ranh giới mà module này nhìn thấy: pool `pg` (06 §9:
 * spec colocated không boot DB thật) và `requirePermission` (mô phỏng cả nhánh
 * allow lẫn ném 403/503 của checkpoint) — mọi thứ khác là code thật.
 *
 * Issue #241 thêm nhóm "nguồn quyết định authorization": cutover gate bật ⇒
 * projection Staff Access là nguồn; gate đóng / gate giá trị sai / projection
 * vắng hoặc quá TTL ⇒ legacy (fallback luôn kèm log — không chọn im lặng),
 * và allow ghi một audit row `success`.
 */

import { createError, type H3Event } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { withReadEnforcement } from './read-route';

/**
 * Trạng thái dùng chung của mock — hoisted để vi.mock factory đọc được.
 * Shuffle-proof: `beforeEach` reset về trạng thái nền trước mỗi test.
 */
const harness = vi.hoisted(() => ({
  behavior: 'allow' as 'allow' | 'deny403' | 'unavail503',
  failOnConnect: null as Error | null,
  released: 0,
  /** Giá trị trả về của `readWorkerEnv` — env container của Worker/preset. */
  workerEnv: undefined as unknown,
  /** Ảnh assignment mà legacy loader trả về. */
  legacyAssignments: [] as unknown[],
  /** Client staff-access có cấu hình không. */
  staffConfigured: false,
  /** Projection: object, null, hoặc 'throw' cho lỗi fetch. */
  projection: null as unknown,
  /** Assignments mà `requirePermission` thực sự nhận. */
  receivedAssignments: null as unknown,
  /** Các lần gọi `recordPrivilegedSuccess`. */
  successAudits: Array<{ actorSub?: string; operation?: string }>,
  /** Các dòng log `writeLog` đã ghi. */
  logs: Array<{ event: string; reason?: string }>,
}));

// ⚠️ Mock `requirePermission` — subject của module này là *khung*, không phải
// checkpoint (checkpoint có spec riêng của nó). Mock capture assignments để
// test nguồn quyết định khẳng định đúng ảnh đã được truyền vào enforcement.
vi.mock('./authorization', () => ({
  requirePermission: async (_permission: unknown, principal: { readonly assignments: unknown }) => {
    harness.receivedAssignments = principal.assignments;
    if (harness.behavior === 'deny403') {
      throw createError({ statusCode: 403, statusMessage: 'forbidden' });
    }
    if (harness.behavior === 'unavail503') {
      throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
    }
    return { allowed: true, stale: false, riskClass: 'normal' };
  },
}));

// ⚠️ Mock pool — `withBackofficePool` thật mở connection tới binding; pool giả
// cho phép mô phỏng lỗi driver và đếm release.
vi.mock('./db', () => ({
  poolBinding: () => ({ connectionString: 'postgres://fake' }),
  readWorkerEnv: () => harness.workerEnv,
}));

vi.mock('./log', () => ({
  writeLog: (fields: { event: string; reason?: string }) => {
    harness.logs.push(fields);
  },
}));

vi.mock('@ecoma-io/backoffice-infrastructure', () => ({
  AUTHZ_PROJECTION_CUTOVER_ENV: 'BACKOFFICE_AUTHZ_PROJECTION_CUTOVER_AT',
  loadPrincipalAuthorization: async () => ({ assignments: harness.legacyAssignments }),
  loadPrincipalAuthorizationProjection: async () => {
    if (harness.projection === 'throw') {
      throw new Error('projection fetch failed');
    }
    return harness.projection;
  },
  staffAccessClientConfig: () =>
    harness.staffConfigured
      ? { binding: { fetch: async () => new Response('{}') }, signHeaders: async () => ({}) }
      : null,
  recordPrivilegedSuccess: async (
    _client: unknown,
    input: { readonly actorSub: string; readonly operation: string },
  ) => {
    harness.successAudits.push({ actorSub: input.actorSub, operation: input.operation });
  },
  withBackofficePool: async <T>(_hyperdrive: unknown, callback: (pool: Pool) => Promise<T>) => {
    if (harness.failOnConnect !== null) {
      throw harness.failOnConnect;
    }
    return callback({
      connect: async () => ({
        release: () => {
          harness.released += 1;
        },
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    } as unknown as Pool);
  },
}));

/** Event giả — middleware authn gắn principal trước route; module đọc qua đó. */
function eventWithPrincipal(actorSub: string | null): H3Event {
  return {
    path: '/api/staff',
    context: actorSub === null ? {} : { backofficePrincipal: { actorSub } },
  } as unknown as H3Event;
}

const VALID_SUB = 'sub_' + 'a'.repeat(32);
const CUTOVER_VAR = 'BACKOFFICE_AUTHZ_PROJECTION_CUTOVER_AT';

/** Một assignment của projection — đủ hình dạng cho khung truyền xuống. */
function projectionAssignment(): Record<string, unknown> {
  return {
    permissions: ['staff.read'],
    validUntil: null,
    revokedAt: null,
    fetchedAt: new Date(),
    staffStatus: 'active',
  };
}

/** Bật cutover với mốc đã qua (1 giây trước). */
function enableCutover(env: Record<string, unknown>): Record<string, unknown> {
  return { ...env, [CUTOVER_VAR]: new Date(Date.now() - 1_000).toISOString() };
}

// Shuffle-proof (Phase 3 #357 bắt được khi shuffle): mỗi test tự lập trạng thái
// mock — không phụ thuộc thứ tự chạy.
beforeEach(() => {
  harness.behavior = 'allow';
  harness.failOnConnect = null;
  harness.workerEnv = undefined;
  harness.legacyAssignments = [];
  harness.staffConfigured = false;
  harness.projection = null;
  harness.receivedAssignments = null;
  harness.successAudits = [];
  harness.logs = [];
});

async function run(event: H3Event): Promise<{ status: number; body: unknown }> {
  try {
    const payload = await withReadEnforcement(event, 'staff.read', async () => ({
      data: true,
    }));
    return { status: 200, body: payload };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    return { status: status ?? 500, body: { message: (error as Error).message } };
  }
}

describe('withReadEnforcement — principal boundary', () => {
  it('fails closed with 401 when the context carries no verified principal', async () => {
    const { status } = await run(eventWithPrincipal(null));

    // ADR-0011 §3: thiếu principal là "không có phiên hợp lệ" ⇒ 401 — trước
    // cả việc mở pool.
    expect(status).toBe(401);
  });

  it('does not touch the database on the 401 path', async () => {
    const releasedBefore = harness.released;
    await run(eventWithPrincipal(null));

    // Chưa mở pool: không có connect nào ⇒ không có release nào mới.
    expect(harness.released).toBe(releasedBefore);
  });
});

describe('withReadEnforcement — enforcement and data on the same client', () => {
  it('runs the read only after the checkpoint allows', async () => {
    harness.behavior = 'allow';
    const { status, body } = await run(eventWithPrincipal(VALID_SUB));

    expect(status).toBe(200);
    expect(body).toEqual({ data: true });
  });

  it('propagates the checkpoint 403 as-is without reading data', async () => {
    harness.behavior = 'deny403';
    const { status } = await run(eventWithPrincipal(VALID_SUB));

    // 403 của checkpoint là câu trả lời cuối của route — khung không hiện hoá
    // nó thành 503 (mất đúng phân loại của workstream B).
    expect(status).toBe(403);
  });

  it('propagates the checkpoint 503 as-is too', async () => {
    harness.behavior = 'unavail503';
    const { status } = await run(eventWithPrincipal(VALID_SUB));

    expect(status).toBe(503);
  });

  it('releases the pool client when the checkpoint throws mid-flight', async () => {
    harness.behavior = 'deny403';
    const releasedBefore = harness.released;
    await run(eventWithPrincipal(VALID_SUB));

    // Connection trở về pool kể cả khi callback ném — không rò connection tới
    // khi pool cạn (một route hỏng không được giết các route kế tiếp).
    expect(harness.released).toBe(releasedBefore + 1);
  });
});

describe('withReadEnforcement — driver errors become 503, H3Errors keep their status', () => {
  it('maps a pg driver failure to 503 without leaking its message', async () => {
    harness.behavior = 'allow';
    harness.failOnConnect = new Error('connect ECONNREFUSED 10.0.0.1:5432 user=secret_admin');
    const { status, body } = await run(eventWithPrincipal(VALID_SUB));

    expect(status).toBe(503);
    // Message của `pg` có thể chứa connection string — không vào response.
    expect(JSON.stringify(body)).not.toContain('secret_admin');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('keeps an H3Error status instead of re-wrapping it into 503', async () => {
    // `read()` của route ném H3Error (vd. 400 từ validate body) thì khung giữ
    // nguyên — đổi nó thành 503 là ẩn lỗi caller. Hàm xuất khai
    // `failClosedOnDatabaseError` là chính phép phân loại đó, ghim trực tiếp.
    const { failClosedOnDatabaseError } = await import('./read-route');

    expect(() => failClosedOnDatabaseError(createError({ statusCode: 400 }))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => failClosedOnDatabaseError(new Error('driver blew up'))).toThrowError(
      expect.objectContaining({ statusCode: 503 }),
    );
  });
});

describe('withReadEnforcement — authorization source cutover (issue #241)', () => {
  it('decides from a fresh projection after the cutover moment', async () => {
    const assignments = [projectionAssignment()];
    harness.workerEnv = enableCutover({});
    harness.staffConfigured = true;
    harness.projection = { assignments, fetchedAt: new Date(), source: 'staff-access' };

    const { status } = await run(eventWithPrincipal(VALID_SUB));

    expect(status).toBe(200);
    // Enforcement nhận ĐÚNG ảnh của projection — nguồn quyết định sau cutover.
    expect(harness.receivedAssignments).toEqual(assignments);
  });

  it('keeps legacy as the decision while the cutover gate is closed', async () => {
    const assignments = [projectionAssignment()];
    harness.workerEnv = {};
    harness.staffConfigured = true;
    harness.projection = { assignments, fetchedAt: new Date(), source: 'staff-access' };
    const legacy = [projectionAssignment()];
    harness.legacyAssignments = legacy;

    await run(eventWithPrincipal(VALID_SUB));

    // Gate chưa bật: projection chỉ quan sát — legacy vẫn là nguồn quyết định.
    expect(harness.receivedAssignments).toEqual(legacy);
  });

  it('treats an unparseable cutover value as gate closed (fail closed)', async () => {
    const assignments = [projectionAssignment()];
    harness.workerEnv = { [CUTOVER_VAR]: 'not-a-timestamp' };
    harness.staffConfigured = true;
    harness.projection = { assignments, fetchedAt: new Date(), source: 'staff-access' };

    await run(eventWithPrincipal(VALID_SUB));

    expect(harness.receivedAssignments).toEqual([]);
  });

  it('falls back to legacy with a log when the staff-access client is unconfigured post-cutover', async () => {
    harness.workerEnv = enableCutover({});
    harness.staffConfigured = false;
    const legacy = [projectionAssignment()];
    harness.legacyAssignments = legacy;

    await run(eventWithPrincipal(VALID_SUB));

    // Fallback legacy — không chọn im lặng: log mang lý do client chưa cấu hình.
    expect(harness.receivedAssignments).toEqual(legacy);
    expect(
      harness.logs.map((entry) => ({ event: entry.event, reason: entry.reason })),
    ).toContainEqual({
      event: 'backoffice.authz.projection_unavailable',
      reason: 'client_unconfigured',
    });
  });

  it('falls back to legacy with a log when the projection fetch fails post-cutover', async () => {
    harness.workerEnv = enableCutover({});
    harness.staffConfigured = true;
    harness.projection = 'throw';

    await run(eventWithPrincipal(VALID_SUB));

    expect(harness.receivedAssignments).toEqual([]);
    expect(
      harness.logs.map((entry) => ({ event: entry.event, reason: entry.reason })),
    ).toContainEqual({
      event: 'backoffice.authz.projection_unavailable',
      reason: 'projection_fetch_failed',
    });
  });

  it('falls back to legacy with the stale log when the projection exceeds the TTL', async () => {
    harness.workerEnv = enableCutover({});
    harness.staffConfigured = true;
    harness.projection = {
      assignments: [projectionAssignment()],
      fetchedAt: new Date(Date.now() - 61_000),
      source: 'staff-access',
    };

    await run(eventWithPrincipal(VALID_SUB));

    // TTL `normal` 60s (ADR-0002): ảnh quá hạn không được tin dù cutover bật.
    expect(harness.receivedAssignments).toEqual([]);
    expect(
      harness.logs.map((entry) => ({ event: entry.event, reason: entry.reason })),
    ).toContainEqual({
      event: 'backoffice.authz.projection_stale',
      reason: 'projection_ttl_exceeded',
    });
  });

  it('records a success audit row on the allow path and none on the deny path', async () => {
    harness.workerEnv = enableCutover({});
    harness.staffConfigured = true;
    harness.projection = {
      assignments: [projectionAssignment()],
      fetchedAt: new Date(),
      source: 'staff-access',
    };

    await run(eventWithPrincipal(VALID_SUB));
    expect(harness.successAudits).toEqual([{ actorSub: VALID_SUB, operation: 'staff.read' }]);

    harness.behavior = 'deny403';
    harness.successAudits = [];
    const { status } = await run(eventWithPrincipal(VALID_SUB));

    expect(status).toBe(403);
    // Deny được audit bởi checkpoint (`recordDecision`) — đường success
    // KHÔNG chạy khi enforcement từ chối.
    expect(harness.successAudits).toEqual([]);
  });
});
