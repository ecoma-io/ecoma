/**
 * Unit test vòng đời operation SQL của `connections.ts` — review P1/P2 của
 * PR #152. Fake `pg.Client` điều khiển được (connect/query/end treo hay settle
 * theo kịch bản) cho phép khẳng định TRẠNG THÁI operation/resource sau mỗi
 * đường, không chỉ HTTP 503:
 *
 * - P1: deadline trùm cả admission; hết deadline trong query phase → client
 *   bị terminate (fire-and-forget — `end()` không được await trên đường abort);
 *   kết quả đến muộn không thể đổi kết quả operation; rejection muộn không
 *   thành unhandled rejection; connect phase không bị force-close giữa chừng.
 * - P2: admission per-binding hữu hạn; queue hữu hạn, đầy là fail-fast; waiter
 *   hết deadline không bao giờ tạo client; slot trả đúng trên mọi đường
 *   success/failure/timeout/abandon; hai binding cách ly capacity.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createBindingLimiter,
  OperationDeadlineError,
  QueueCapacityExceededError,
  withClient,
  PER_BINDING_CONCURRENCY_LIMIT,
  PER_BINDING_QUEUE_CAPACITY,
  type SqlOperationOptions,
} from './connections';

/**
 * Fake `pg.Client` cài qua `vi.mock('pg')` — connect/query là deferred điều
 * khiển từ test; `end()` đếm số lần gọi (assert idempotency) và có thể bị
 * buộc treo (assert đường abort KHÔNG await end).
 */
const pgHoisted = vi.hoisted(() => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- định nghĩa trong factory của vi.hoisted là chủ đích (chạy trước import)
  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  } {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  class FakeClient {
    static readonly instances: FakeClient[] = [];
    static reset(): void {
      FakeClient.instances.length = 0;
    }
    // oxlint-disable-next-line typescript/no-invalid-void-type -- `void` chỉ là type argument của Promise<void> deferred, không phải tham số thật
    readonly connectDeferred = deferred<void>();
    readonly queryDeferred = deferred<unknown>();
    endCalls = 0;
    endHangs = false;
    constructor(_config: unknown) {
      FakeClient.instances.push(this);
    }
    on(): undefined {
      return undefined;
    }
    connect(): Promise<void> {
      return this.connectDeferred.promise;
    }
    query(): Promise<unknown> {
      return this.queryDeferred.promise;
    }
    end(): Promise<void> {
      this.endCalls += 1;
      return this.endHangs
        ? new Promise<void>(() => {
            // Không bao giờ settle — chủ đích của kịch bản end() treo.
          })
        : Promise.resolve();
    }
  }
  return { FakeClient };
});

vi.mock('pg', () => ({ Client: pgHoisted.FakeClient }));

const { FakeClient } = pgHoisted;

/** Diện rộng của fake client mà helpers dùng — vi.hoisted xoá instance type của class. */
interface DeferredControls<T> {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}
interface FakeClientLike {
  readonly connectDeferred: DeferredControls<void>;
  readonly queryDeferred: DeferredControls<unknown>;
  endCalls: number;
  endHangs: boolean;
}

/** Nhả microtask + timer pending để handoff slot / teardown fire-and-forget kịp chạy. */
async function flush(ms = 0): Promise<void> {
  await new Promise<void>((resolveFlush) => {
    setTimeout(resolveFlush, ms);
  });
}

/**
 * Chờ điều kiện xảy ra trong trần thời gian — dynamic `import('pg')` qua
 * optimizer cần nhiều tick hơn một flush, nên mọi assert TRẠNG THÁI phải
 * chờ bằng điều kiện, không được đoán số tick.
 */
async function until(condition: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met in time: ${what}`);
    }
    await flush(5);
  }
}

/** Settle mọi connect/query deferred hiện có, lặp cho tới khi chuỗi handoff cạn. */
async function drainAll(): Promise<void> {
  for (let round = 0; round < 16; round += 1) {
    for (const instance of FakeClient.instances) {
      instance.connectDeferred.resolve();
      instance.queryDeferred.resolve({ rows: [] });
    }
    await flush(5);
  }
}

/** Bắt đầu một phép gọi SQL qua withClient (chưa await — caller điều khiển kịch bản). */
function call(options: SqlOperationOptions = {}): Promise<unknown> {
  return withClient(
    'postgresql://probe.invalid/db-llm-gateway',
    (client) => client.query('SELECT 1'),
    options,
  );
}

function lastInstance(): FakeClientLike {
  const instance = FakeClient.instances.at(-1);
  if (instance === undefined) {
    throw new Error('no fake client constructed');
  }
  return instance;
}

/** Bước một instance qua connect + query thành công (đường lành mạnh). */
async function runThrough(instance: FakeClientLike): Promise<void> {
  instance.connectDeferred.resolve();
  instance.queryDeferred.resolve({ rows: [] });
  await flush();
}

describe('sql operation lifecycle (success path)', () => {
  it('runs the query and closes the client exactly once', async () => {
    FakeClient.reset();
    const pending = call();
    await until(() => FakeClient.instances.length === 1, 'client constructed');
    const instance = lastInstance();
    await runThrough(instance);
    await expect(pending).resolves.toEqual({ rows: [] });
    expect(instance.endCalls).toBe(1);
    // Timer deadline (nếu có) đã được dọn — không terminate muộn bắn thêm.
    await flush(50);
    expect(instance.endCalls).toBe(1);
  });
});

describe('per-binding admission limit (review P2)', () => {
  it('a burst above the limit never has more operations in flight than the limit', async () => {
    FakeClient.reset();
    const limiter = createBindingLimiter('DB_LLM_GATEWAY');
    const pending = Array.from({ length: PER_BINDING_CONCURRENCY_LIMIT + 3 }, () =>
      call({ limiter }),
    );

    // Chỉ `limit` caller đầu được tạo client (được admit); phần thừa đang chờ.
    await until(
      () => FakeClient.instances.length === PER_BINDING_CONCURRENCY_LIMIT,
      'limit clients admitted',
    );
    await flush(20);
    expect(FakeClient.instances.length).toBe(PER_BINDING_CONCURRENCY_LIMIT);

    // Nhả từng slot: số operation chưa xong không bao giờ vượt limit.
    const snapshot = [...FakeClient.instances];
    for (let settled = 1; settled <= snapshot.length; settled += 1) {
      snapshot[settled - 1].connectDeferred.resolve();
      snapshot[settled - 1].queryDeferred.resolve({ rows: [] });
      await flush(10);
      expect(FakeClient.instances.length - settled).toBeLessThanOrEqual(
        PER_BINDING_CONCURRENCY_LIMIT,
      );
    }
    await drainAll();
    for (const result of pending) {
      await expect(result).resolves.toEqual({ rows: [] });
    }
    expect(FakeClient.instances.length).toBe(PER_BINDING_CONCURRENCY_LIMIT + 3);
  });

  it('rejects immediately with a typed error once the queue is full', async () => {
    FakeClient.reset();
    const limiter = createBindingLimiter('DB_LLM_TENANT');
    // Lấp đầy: limit slot active (query treo) + queue capacity waiter.
    const holders = Array.from({ length: PER_BINDING_CONCURRENCY_LIMIT }, () => call({ limiter }));
    await until(
      () => FakeClient.instances.length === PER_BINDING_CONCURRENCY_LIMIT,
      'holders admitted',
    );
    for (const instance of FakeClient.instances) {
      instance.connectDeferred.resolve();
    }
    const queued = Array.from({ length: PER_BINDING_QUEUE_CAPACITY }, () => call({ limiter }));
    await flush(20);
    expect(FakeClient.instances.length).toBe(PER_BINDING_CONCURRENCY_LIMIT);

    // Queue đầy: caller kế tiếp fail-fast ngay, KHÔNG tạo client, KHÔNG chờ.
    const overflow = call({ limiter });
    await expect(overflow).rejects.toBeInstanceOf(QueueCapacityExceededError);
    expect(FakeClient.instances.length).toBe(PER_BINDING_CONCURRENCY_LIMIT);

    await drainAll();
    for (const result of [...holders, ...queued]) {
      await expect(result).resolves.toEqual({ rows: [] });
    }
  });

  it('a waiter whose deadline expires in the queue never opens a client', async () => {
    FakeClient.reset();
    const limiter = createBindingLimiter('DB_LLM_MARKETPLACE');
    const holders = Array.from({ length: PER_BINDING_CONCURRENCY_LIMIT }, () => call({ limiter }));
    await until(
      () => FakeClient.instances.length === PER_BINDING_CONCURRENCY_LIMIT,
      'holders admitted',
    );
    for (const instance of FakeClient.instances) {
      instance.connectDeferred.resolve();
    }
    const lastSlot = call({ limiter }); // chiếm waiter đầu hàng
    await flush(10);
    const expired = call({ limiter, deadlineMs: 80 }); // waiter sẽ hết deadline
    await flush(10);
    expect(FakeClient.instances.length).toBe(PER_BINDING_CONCURRENCY_LIMIT);

    await expect(expired).rejects.toBeInstanceOf(OperationDeadlineError);
    // Chưa bao giờ được cấp slot → CHƯA BAO GIỜ có client được tạo cho nó.
    expect(FakeClient.instances.length).toBe(PER_BINDING_CONCURRENCY_LIMIT);

    // abandon đã rút nó khỏi queue → còn chỗ: caller mới vào hàng được
    // (không bị fail-fast nhầm vì queue "ảo" đầy).
    const joinsQueue = call({ limiter });
    await flush(10);

    // Nhả holder đầu: slot bàn giao cho waiter đầu hàng (lastSlot), KHÔNG
    // thể hồi sinh `expired` đã bỏ hàng.
    FakeClient.instances[0].queryDeferred.resolve({ rows: [] });
    await until(
      () => FakeClient.instances.length === PER_BINDING_CONCURRENCY_LIMIT + 1,
      'handoff constructed exactly one client',
    );
    await expect(holders[0]).resolves.toEqual({ rows: [] });

    await drainAll();
    await expect(lastSlot).resolves.toEqual({ rows: [] });
    await expect(joinsQueue).resolves.toEqual({ rows: [] });
  });

  it('admission wait counts INSIDE the operation deadline, not additively', async () => {
    FakeClient.reset();
    const limiter = createBindingLimiter('DB_LLM_GATEWAY');
    const holders = Array.from({ length: PER_BINDING_CONCURRENCY_LIMIT }, () => call({ limiter }));
    await until(
      () => FakeClient.instances.length === PER_BINDING_CONCURRENCY_LIMIT,
      'holders admitted',
    );
    for (const instance of FakeClient.instances) {
      instance.connectDeferred.resolve();
    }
    const started = Date.now();
    const pending = call({ limiter, deadlineMs: 100 });
    await expect(pending).rejects.toBeInstanceOf(OperationDeadlineError);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    // Một budget duy nhất: nếu admission và operation cộng dồn, cận dưới sẽ
    // phải vượt 100ms đáng kể (100ms chờ admission + 100ms deadline operation).
    expect(elapsed).toBeLessThan(250);

    await drainAll();
    for (const result of holders) {
      await expect(result).resolves.toEqual({ rows: [] });
    }
  });

  it('capacity is released on every exit path', async () => {
    FakeClient.reset();
    const limiter = createBindingLimiter('DB_LLM_TENANT');
    const paths: Array<() => Promise<void>> = [
      // success
      async () => {
        const before = FakeClient.instances.length;
        const pending = call({ limiter });
        await until(() => FakeClient.instances.length === before + 1, 'client constructed');
        await runThrough(lastInstance());
        await expect(pending).resolves.toEqual({ rows: [] });
      },
      // query failure
      async () => {
        const before = FakeClient.instances.length;
        const pending = call({ limiter });
        await until(() => FakeClient.instances.length === before + 1, 'client constructed');
        const instance = lastInstance();
        instance.connectDeferred.resolve();
        instance.queryDeferred.reject(new Error('query failed'));
        await expect(pending).rejects.toThrow('query failed');
      },
      // connect failure
      async () => {
        const before = FakeClient.instances.length;
        const pending = call({ limiter });
        await until(() => FakeClient.instances.length === before + 1, 'client constructed');
        lastInstance().connectDeferred.reject(new Error('connect failed'));
        await expect(pending).rejects.toThrow('connect failed');
      },
      // operation deadline (query phase)
      async () => {
        const before = FakeClient.instances.length;
        const pending = call({ limiter, deadlineMs: 60 });
        await until(() => FakeClient.instances.length === before + 1, 'client constructed');
        lastInstance().connectDeferred.resolve();
        await expect(pending).rejects.toBeInstanceOf(OperationDeadlineError);
      },
    ];
    for (const path of paths) {
      await path();
      await flush();
      // Sau mỗi đường, limiter phải admit trọn vẹn limit caller đồng thời —
      // nếu slot lộ thì caller cuối sẽ bị đẩy vào queue (ít client được tạo).
      FakeClient.reset();
      const probe = Array.from({ length: PER_BINDING_CONCURRENCY_LIMIT }, () => call({ limiter }));
      await until(
        () => FakeClient.instances.length === PER_BINDING_CONCURRENCY_LIMIT,
        'limiter admits a full batch right after the exit path',
      );
      expect(FakeClient.instances.length).toBe(PER_BINDING_CONCURRENCY_LIMIT);
      await drainAll();
      for (const result of probe) {
        await expect(result).resolves.toEqual({ rows: [] });
      }
    }
  });
});

describe('operation deadline termination (review P1)', () => {
  it('a hanging query is terminated: client ended, fire-and-forget (end not awaited)', async () => {
    FakeClient.reset();
    const started = Date.now();
    const pending = call({ deadlineMs: 80 });
    await until(() => FakeClient.instances.length === 1, 'client constructed');
    const instance = lastInstance();
    instance.connectDeferred.resolve();
    // end() bị buộc TREO VÔ HẠN — đường abort không được phép await nó.
    instance.endHangs = true;

    await expect(pending).rejects.toBeInstanceOf(OperationDeadlineError);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(250);
    // Terminate đã được gọi NGAY khi deadline thắng (không chờ query settle).
    expect(instance.endCalls).toBe(1);
  });

  it('a result arriving after the deadline cannot flip the outcome', async () => {
    FakeClient.reset();
    const pending = call({ deadlineMs: 80 });
    await until(() => FakeClient.instances.length === 1, 'client constructed');
    const instance = lastInstance();
    instance.connectDeferred.resolve();
    await expect(pending).rejects.toBeInstanceOf(OperationDeadlineError);

    // Query settle THÀNH CÔNG muộn — kết quả phải bị bỏ, outcome đã chốt.
    instance.queryDeferred.resolve({ rows: [{ late: true }] });
    await flush(120);
    await expect(pending).rejects.toBeInstanceOf(OperationDeadlineError);
  });

  it('a query rejecting late after the deadline does not become unhandled', async () => {
    FakeClient.reset();
    const pending = call({ deadlineMs: 80 });
    await until(() => FakeClient.instances.length === 1, 'client constructed');
    const instance = lastInstance();
    instance.connectDeferred.resolve();
    await expect(pending).rejects.toBeInstanceOf(OperationDeadlineError);

    // Rejection muộn của promise query bị bỏ nền — guard `.catch` phải hút nó.
    // Vitest fail toàn bộ run khi có unhandled rejection, nên test này xanh
    // ĐÍCH THỰC là bằng chứng không rò rejection.
    instance.queryDeferred.reject(new Error('late termination fallout'));
    await flush(120);
  });

  it('a deadline during the connect phase does not force-close mid-connect', async () => {
    FakeClient.reset();
    const pending = call({ deadlineMs: 80 });
    await until(() => FakeClient.instances.length === 1, 'client constructed');
    const instance = lastInstance();
    // connect treo — deadline thắng trong connect phase.

    await expect(pending).rejects.toBeInstanceOf(OperationDeadlineError);
    // Thiết kế có chủ đích: KHÔNG force end() giữa chừng connect (timer
    // connect-timeout 5s của pg tự destroy stream ≤2s sau deadline) — vì vậy
    // endCalls === 0 tại thời điểm caller nhận lỗi.
    expect(instance.endCalls).toBe(0);

    // pg timer cuối cũng destroy stream → connect reject muộn: phải được hút,
    // không thành unhandled rejection.
    instance.connectDeferred.reject(new Error('timeout expired'));
    await flush(120);
  });

  it('terminating at the deadline races benignly with prompt query completion', async () => {
    FakeClient.reset();
    const pending = call({ deadlineMs: 80 });
    await until(() => FakeClient.instances.length === 1, 'client constructed');
    const instance = lastInstance();
    instance.connectDeferred.resolve();
    instance.queryDeferred.resolve({ rows: [] }); // query thắng deadline
    await expect(pending).resolves.toEqual({ rows: [] });
    await flush(150); // nếu timer deadline còn sống sẽ bắn terminate → endCalls 2
    expect(instance.endCalls).toBe(1); // chỉ end đường thường — timer đã dọn
  });
});

describe('binding isolation (review P2)', () => {
  it('saturating one binding does not delay admission of another', async () => {
    FakeClient.reset();
    const gateway = createBindingLimiter('DB_LLM_GATEWAY');
    const tenant = createBindingLimiter('DB_LLM_TENANT');
    const saturating = Array.from({ length: PER_BINDING_CONCURRENCY_LIMIT }, () =>
      call({ limiter: gateway }),
    );
    await until(
      () => FakeClient.instances.length === PER_BINDING_CONCURRENCY_LIMIT,
      'gateway saturated',
    );
    expect(FakeClient.instances.length).toBe(PER_BINDING_CONCURRENCY_LIMIT);

    // Binding tenant vẫn admit NGAY, không chờ gateway nhả slot.
    const other = call({ limiter: tenant });
    await until(
      () => FakeClient.instances.length === PER_BINDING_CONCURRENCY_LIMIT + 1,
      'tenant admitted immediately',
    );
    expect(FakeClient.instances.length).toBe(PER_BINDING_CONCURRENCY_LIMIT + 1);
    await runThrough(lastInstance());
    await expect(other).resolves.toEqual({ rows: [] });

    await drainAll();
    for (const result of saturating) {
      await expect(result).resolves.toEqual({ rows: [] });
    }
  });
});

describe('limiter configuration', () => {
  it('rejects a non-positive limit and a negative queue capacity', () => {
    expect(() => createBindingLimiter('DB_LLM_GATEWAY', 0)).toThrow(
      'concurrency limit must be a positive integer',
    );
    expect(() => createBindingLimiter('DB_LLM_GATEWAY', 3, -1)).toThrow(
      'queue capacity must be a non-negative integer',
    );
  });
});
