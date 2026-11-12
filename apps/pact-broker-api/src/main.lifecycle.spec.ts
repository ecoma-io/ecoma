/**
 * Specs lifecycle Pool của middleware config (`src/main.ts`) — hợp đồng
 * pool-per-request ghim từ issue #118 (controlled experiment 2026-11-13:
 * socket mà `pg` mở qua `cloudflare:sockets` gắn với request context tạo ra
 * nó; Pool cache module-scope tái sử dụng socket chết xuyên request và treo
 * vĩnh viễn).
 *
 * `createPool` của infrastructure bị mock (cùng pattern
 * `entitlement-consumer.spec.ts`) — suite này chỉ đo **lifecycle ở composition
 * root**: bao nhiêu pool được tạo, pool nào được `end()` lúc nào, lỗi dọn dẹp
 * có che lỗi nghiệp vụ hay không, và những đường không chạm DB (`/health`,
 * CORS preflight, 503 fail-closed) có tạo pool hay không. SQL thật và Hono
 * chạy nguyên vẹn; PostgreSQL thật là việc của `tests/integrations/`.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { createPool } from '@ecoma-io/pact-broker-api-infrastructure';

import { buildApp, resetCachedConfig } from './main';

vi.mock('@ecoma-io/pact-broker-api-infrastructure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecoma-io/pact-broker-api-infrastructure')>();
  return {
    ...actual,
    createPool:
      vi.fn<
        (connectionString: Parameters<typeof createPool>[0]) => ReturnType<typeof createPool>
      >(),
  };
});

const mockedCreatePool = vi.mocked(createPool);

/** Host URL mà `app.request` cần để Hono parse path/query đúng (tiền lệ `api.spec.ts`). */
const BASE = 'https://broker.test';

interface FakePool {
  on: Mock<(event: string, listener: () => void) => void>;
  query: Mock<(sql: string, values?: unknown[]) => Promise<unknown>>;
  connect: Mock<() => Promise<unknown>>;
  end: Mock<() => Promise<void>>;
}

/**
 * Pool giả: `query` trả không có hàng nào (token lạ → 401 — response hoàn tất
 * KHÔNG lỗi), đủ shape cho `PgTokenRepo` chạy thật tới cùng.
 */
function makeFakePool(
  options: { query?: Mock<(sql: string, values?: unknown[]) => Promise<unknown>> } = {},
): FakePool {
  return {
    on: vi.fn<(event: string, listener: () => void) => void>(),
    query:
      options.query ??
      vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>().mockResolvedValue({
        rows: [],
        rowCount: 0,
      }),
    connect: vi.fn<() => Promise<unknown>>(),
    end: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

/** Env hợp lệ — Hyperdrive binding trỏ connection string giả. */
function makeEnv(): Record<string, unknown> {
  return { HYPERDRIVE: { connectionString: 'postgres://fake/db' } };
}

/** Bắt `console.error` của `onError`/cleanup, parse JSON mỗi dòng. */
function captureConsoleError(): { lines: Record<string, unknown>[]; restore(): void } {
  const lines: Record<string, unknown>[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown): void => {
    lines.push(typeof line === 'string' ? (JSON.parse(line) as Record<string, unknown>) : {});
    return undefined;
  });
  return { lines, restore: (): void => void spy.mockRestore() };
}

describe('config middleware pool lifecycle (issue #118)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCachedConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a fresh pool per request and never reuses one across requests', async () => {
    // Cốt lõi của #118: hai request liên tiếp trên cùng isolate phải thấy HAI
    // pool khác nhau — pool của request trước đã `end()` trước khi request sau
    // được tạo. Thứ tự create → end → create → end là bất biến của lifecycle.
    const events: string[] = [];
    const pools: FakePool[] = [];
    mockedCreatePool.mockImplementation((connectionString: string) => {
      expect(connectionString).toBe('postgres://fake/db');
      const pool = makeFakePool();
      pools.push(pool);
      events.push(`create:${pools.length}`);
      return pool as never;
    });

    const app = buildApp();
    await app.request(`${BASE}/`, { headers: { authorization: 'Bearer stale-token' } }, makeEnv());
    expect(pools).toHaveLength(1);
    await app.request(`${BASE}/`, { headers: { authorization: 'Bearer stale-token' } }, makeEnv());

    expect(mockedCreatePool).toHaveBeenCalledTimes(2);
    expect(pools[0]).not.toBe(pools[1]);
    expect(events).toEqual(['create:1', 'create:2']);
    expect(pools[0]?.end).toHaveBeenCalledTimes(1);
    expect(pools[1]?.end).toHaveBeenCalledTimes(1);
    // `end()` của request trước hoàn tất trước khi pool request sau được tạo
    // (thứ tự await trong middleware, không phải "đã gọi nhưng chưa chờ").
    expect(pools[0]?.end.mock.invocationCallOrder[0]).toBeLessThan(
      mockedCreatePool.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('ends the pool after the response completes on the success path', async () => {
    // Response 401 (hoàn tất, không throw) chỉ được trả về sau khi `end()` đã
    // được await trong `finally` — response không bao giờ thoát trước cleanup.
    const pool = makeFakePool();
    mockedCreatePool.mockReturnValue(pool as never);
    const app = buildApp();

    const res = await app.request(
      `${BASE}/`,
      { headers: { authorization: 'Bearer stale-token' } },
      makeEnv(),
    );

    expect(res.status).toBe(401);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('ends the pool when a downstream handler throws and returns the 500 envelope', async () => {
    // Route/middleware ném → `finally` vẫn `end()`; error handler trả 500 và
    // log lỗi GỐC (không phải lỗi pool).
    const pool = makeFakePool({
      query: vi
        .fn<(sql: string, values?: unknown[]) => Promise<unknown>>()
        .mockRejectedValue(new Error('db down')),
    });
    mockedCreatePool.mockReturnValue(pool as never);
    const capture = captureConsoleError();
    const app = buildApp();
    try {
      const res = await app.request(
        `${BASE}/`,
        { headers: { authorization: 'Bearer stale-token' } },
        makeEnv(),
      );
      expect(res.status).toBe(500);
      expect(pool.end).toHaveBeenCalledTimes(1);
      expect(
        capture.lines.some((l) => l['errorMessage'] === 'db down' && l['code'] === undefined),
      ).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it('does not let a pool.end() failure mask the original error or the response', async () => {
    // Cả query lẫn `end()` đều ném: caller phải thấy lỗi GỐC (500 + dòng log
    // `db down`), còn lỗi dọn dẹp chỉ là một dòng `pool_end_error` riêng.
    const pool = makeFakePool({
      query: vi
        .fn<(sql: string, values?: unknown[]) => Promise<unknown>>()
        .mockRejectedValue(new Error('db down')),
    });
    pool.end.mockRejectedValue(new Error('end failed'));
    mockedCreatePool.mockReturnValue(pool as never);
    const capture = captureConsoleError();
    const app = buildApp();
    try {
      const res = await app.request(
        `${BASE}/`,
        { headers: { authorization: 'Bearer stale-token' } },
        makeEnv(),
      );
      expect(res.status).toBe(500);
      expect(pool.end).toHaveBeenCalledTimes(1);
      expect(
        capture.lines.some((l) => l['errorMessage'] === 'db down' && l['code'] === undefined),
      ).toBe(true);
      expect(capture.lines.some((l) => l['code'] === 'pool_end_error')).toBe(true);
      expect(JSON.stringify(capture.lines)).not.toContain('end failed');
    } finally {
      capture.restore();
    }
  });

  it('creates no pool for /health', async () => {
    // /health nằm TRƯỚC middleware pool — infra probe không được phụ thuộc DB,
    // và không được khởi tạo pool nào chỉ vì được probe.
    const app = buildApp();
    const res = await app.request(`${BASE}/health`, {}, makeEnv());
    expect(res.status).toBe(200);
    expect(mockedCreatePool).not.toHaveBeenCalled();
  });

  it('creates no pool for a CORS preflight', async () => {
    // Preflight OPTIONS trả ngay tại middleware CORS (trước middleware pool) —
    // đường trả response sớm không được sở hữu pool. Không dashboard origin
    // nào được cấu hình trong env mặc định → origin không khớp → 403 cố định.
    const app = buildApp();
    const res = await app.request(
      `${BASE}/`,
      { method: 'OPTIONS', headers: { origin: 'https://dashboard.example' } },
      makeEnv(),
    );
    expect(res.status).toBe(403);
    expect(mockedCreatePool).not.toHaveBeenCalled();
  });

  it('creates no pool when config fails closed with 503', async () => {
    // Thiếu Hyperdrive binding → 503 fail-closed TRƯỚC khi pool nào được tạo.
    const app = buildApp();
    const res = await app.request(`${BASE}/`, { headers: { authorization: 'Bearer t' } }, {});
    expect(res.status).toBe(503);
    expect(mockedCreatePool).not.toHaveBeenCalled();
  });
});
