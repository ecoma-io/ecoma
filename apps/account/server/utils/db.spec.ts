import type { Hyperdrive } from '@cloudflare/workers-types';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { attachPoolErrorHandler, buildPoolOptions, createPool, withRequestPool } from './db';
import { writeLog } from './logger';

vi.mock('./logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));

const mockedWriteLog = vi.mocked(writeLog);

/**
 * `Pool` giả cho {@link createPool} / {@link withRequestPool}: ghi lại listener `error`
 * mà factory (phải) gắn, và không mở connection thật. `vi.mock('pg')` ở mức module
 * vì `createPool` tự `new Pool(...)` — không có hook nào khác chen vào giữa.
 * `vi.hoisted` vì factory của `vi.mock` được đẩy lên trên mọi khai báo top-level.
 */
const { poolRegistrations } = vi.hoisted(() => ({ poolRegistrations: [] as string[] }));
vi.mock('pg', () => ({
  Pool: class {
    on(event: string): void {
      poolRegistrations.push(event);
    }

    async end(): Promise<void> {
      // Không mở connection thật — unit test, không cần database.
    }
  },
}));

/** Pool giả chỉ đủ để ghi nhận handler theo tên sự kiện. */
function fakeEmitterPool(): {
  pool: Pool;
  emit: (event: string, error: Error) => void;
  registered: string[];
} {
  const handlers = new Map<string, (error: Error) => void>();
  const registered: string[] = [];
  const pool = {
    on(event: string, handler: (error: Error) => void): void {
      handlers.set(event, handler);
      registered.push(event);
    },
  } as unknown as Pool;
  return {
    pool,
    registered,
    emit: (event, error) => {
      const handler = handlers.get(event);
      if (handler === undefined) {
        // Đúng kịch bản crash: không listener cho 'error'.
        throw new Error(`Unhandled 'error' event: ${event}`);
      }
      handler(error);
    },
  };
}

/**
 * `pg-pool` phát `error` khi idle client chết; **không** có listener là crash
 * process (EventEmitter: "Unhandled 'error' event"). Đây không phải lý thuyết:
 * HD10 nói Hyperdrive đóng idle connection sau 10 phút — đúng mốc
 * `idleTimeoutMillis` mà `buildPoolOptions` đặt — nên mỗi lần Worker nhàn rỗi
 * đúng mốc là một lần `error` phát trên idle client.
 */
describe('attachPoolErrorHandler', () => {
  it('registers an error listener so an idle-client error cannot crash the isolate', () => {
    const { pool, registered, emit } = fakeEmitterPool();
    attachPoolErrorHandler(pool);
    expect(registered).toEqual(['error']);
    // Emit không ném ra caller — đúng hợp đồng: lỗi idle không thuộc request nào.
    expect(() => {
      emit('error', new Error('Connection terminated unexpectedly'));
    }).not.toThrow();
  });

  it('logs a fixed redacted code, never the driver message', () => {
    const { pool, emit } = fakeEmitterPool();
    attachPoolErrorHandler(pool);
    mockedWriteLog.mockClear();
    // Message của `pg` có thể chứa connection string — SR-001/invariant 9 cấm
    // đưa nó vào log; chỉ mã sự kiện cố định được phép.
    emit('error', new Error('connect ECONNREFUSED 10.0.0.1:5432 db-account secret-pw'));

    expect(mockedWriteLog).toHaveBeenCalledTimes(1);
    const entry = mockedWriteLog.mock.calls[0]?.[0];
    expect(entry).toEqual({ event: 'db_pool.idle_client_error', error_code: 'idle_client_error' });
    expect(JSON.stringify(entry)).not.toContain('secret-pw');
  });
});

describe('buildPoolOptions', () => {
  it('keeps idleTimeoutMillis at Hyperdrive idle close so pg retires dead clients', () => {
    // HD10: Hyperdrive đóng idle connection sau 10 phút. `pg` chỉ trả connection
    // chết về pool khi idle timeout của nó khớp mốc đó; lệch thì pool giữ
    // connection đã bị Hyperdrive đóng và mọi query kế tiếp nhận lỗi transport.
    const options = buildPoolOptions({ connectionString: 'postgres://example' });
    expect(options.idleTimeoutMillis).toBe(600_000);
    expect(options.connectionTimeoutMillis).toBeLessThanOrEqual(15_000);
    // Không đặt `ssl`: Hyperdrive đã kết nối origin bằng TLS (HD2).
    expect(options).not.toHaveProperty('ssl');
  });
});

describe('createPool', () => {
  it('attaches the idle-client error handler before returning the pool', () => {
    // Gọi factory thật (không chỉ hàm attach rời): bỏ `attachPoolErrorHandler`
    // khỏi `createPool` thì test này đỏ — mọi pool production (request pool lẫn
    // probe readiness của `/ready`) không còn listener và idle-client error trở
    // lại thành crash isolate. `createPool` là đường duy nhất dựng pool, nên một
    // mutation trong factory hỏng đúng lớp thay vì sót một call site.
    poolRegistrations.length = 0;
    const hyperdrive = { connectionString: 'postgres://example' } as Hyperdrive;

    createPool(hyperdrive);

    expect(poolRegistrations).toEqual(['error']);
  });
});

describe('withRequestPool', () => {
  it('attaches the idle-client error handler to every pool it creates', () => {
    // Gọi hàm thật (không chỉ hàm attach rời): bỏ `attachPoolErrorHandler`
    // khỏi `createPool` (đường dựng pool của `withRequestPool`) thì test này đỏ
    // — pool production không listener và idle-client error trở lại thành crash
    // isolate.
    poolRegistrations.length = 0;
    const hyperdrive = { connectionString: 'postgres://example' } as Hyperdrive;

    return expect(
      withRequestPool(hyperdrive, async () => {
        expect(poolRegistrations).toEqual(['error']);
        return 'ok';
      }),
    ).resolves.toBe('ok');
  });
});
