/**
 * Unit test của khung chung của 3 read route (`withReadEnforcement`) —
 * classification của các nhánh fail-closed mà suite integration không phủ
 * được vì nó seed dữ liệu hợp lệ: lỗi driver `pg` thành `503`, `H3Error` giữ
 * nguyên status, và connection luôn được release kể cả khi enforcement ném.
 *
 * ⚠️ Mock dừng ở đúng hai ranh giới mà module này nhìn thấy: pool `pg` (06 §9:
 * spec colocated không boot DB thật) và `requirePermission` (mô phỏng cả nhánh
 * allow lẫn ném 403/503 của checkpoint) — mọi thứ khác là code thật.
 */

import { createError, type H3Event } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { withReadEnforcement } from './read-route';

// ⚠️ Mock `requirePermission` — subject của module này là *khung*, không phải
// checkpoint (checkpoint có spec riêng của nó).
const enforcement = vi.hoisted(() => ({ behavior: 'allow' as 'allow' | 'deny403' | 'unavail503' }));
vi.mock('./authorization', () => ({
  requirePermission: async () => {
    if (enforcement.behavior === 'deny403') {
      throw createError({ statusCode: 403, statusMessage: 'forbidden' });
    }
    if (enforcement.behavior === 'unavail503') {
      throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
    }
    return { allowed: true, stale: false, denial: null, riskClass: 'normal' };
  },
}));

// ⚠️ Mock pool — `withBackofficePool` thật mở connection tới binding; pool giả
// cho phép mô phỏng lỗi driver và đếm release.
const pool = vi.hoisted(() => ({
  failOnConnect: null as Error | null,
  released: 0,
}));

// ⚠️ Hai mock ranh giới: `./db` (đọc nguồn connection string ra khỏi
// `H3Event` — phần h3 của app) và `@ecoma-io/backoffice-infrastructure`
// (pool — phần lib). Subject của module này là *khung*, không phải cách đọc
// env hay cách dựng pool.
vi.mock('./db', () => ({
  poolBinding: () => ({ connectionString: 'postgres://fake' }),
  readWorkerEnv: () => undefined,
}));

vi.mock('@ecoma-io/backoffice-infrastructure', () => ({
  loadPrincipalAuthorization: async () => ({ assignments: [] }),
  loadPrincipalAuthorizationProjection: async () => null,
  staffAccessClientConfig: () => null,
  withBackofficePool: async <T>(_hyperdrive: unknown, callback: (pool: Pool) => Promise<T>) => {
    if (pool.failOnConnect !== null) {
      throw pool.failOnConnect;
    }
    return callback({
      connect: async () => ({
        release: () => {
          pool.released += 1;
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

// Shuffle-proof (Phase 3 #357 bắt được khi shuffle): mỗi test tự lập trạng thái
// mock — không phụ thuộc thứ tự chạy.
beforeEach(() => {
  enforcement.behavior = 'allow';
  pool.failOnConnect = null;
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
    const releasedBefore = pool.released;
    await run(eventWithPrincipal(null));

    // Chưa mở pool: không có connect nào ⇒ không có release nào mới.
    expect(pool.released).toBe(releasedBefore);
  });
});

describe('withReadEnforcement — enforcement and data on the same client', () => {
  it('runs the read only after the checkpoint allows', async () => {
    enforcement.behavior = 'allow';
    const { status, body } = await run(eventWithPrincipal(VALID_SUB));

    expect(status).toBe(200);
    expect(body).toEqual({ data: true });
  });

  it('propagates the checkpoint 403 as-is without reading data', async () => {
    enforcement.behavior = 'deny403';
    const { status } = await run(eventWithPrincipal(VALID_SUB));

    // 403 của checkpoint là câu trả lời cuối của route — khung không hiện hoá
    // nó thành 503 (mất đúng phân loại của workstream B).
    expect(status).toBe(403);
  });

  it('propagates the checkpoint 503 as-is too', async () => {
    enforcement.behavior = 'unavail503';
    const { status } = await run(eventWithPrincipal(VALID_SUB));

    expect(status).toBe(503);
  });

  it('releases the pool client when the checkpoint throws mid-flight', async () => {
    enforcement.behavior = 'deny403';
    const releasedBefore = pool.released;
    await run(eventWithPrincipal(VALID_SUB));

    // Connection trở về pool kể cả khi callback ném — không rò connection tới
    // khi pool cạn (một route hỏng không được giết các route kế tiếp).
    expect(pool.released).toBe(releasedBefore + 1);
  });
});

describe('withReadEnforcement — driver errors become 503, H3Errors keep their status', () => {
  it('maps a pg driver failure to 503 without leaking its message', async () => {
    enforcement.behavior = 'allow';
    pool.failOnConnect = new Error('connect ECONNREFUSED 10.0.0.1:5432 user=secret_admin');
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
