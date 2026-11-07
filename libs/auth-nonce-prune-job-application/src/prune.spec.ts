/**
 * Unit specs của thuật toán prune (`src/prune.ts`) — chạy trên **pool `pg` fake**, không
 * cần PostgreSQL thật.
 *
 * ⚠️ KHÔNG testcontainers: chạy trên PostgreSQL thật chỉ chứng minh được PostgreSQL tính
 * đúng chuỗi SQL của mình (cái mà integration suite bên `apps/auth`/`apps/account` đã phủ
 * cho bảng cùng schema), KHÔNG chứng minh được logic lặp/retry/cap của **thuật toán** —
 * phần cần ghim ở đây là thứ tự gọi, điều kiện dừng, phân loại lỗi và hình dạng output,
 * mà một fake pool điều khiển được chính xác từng câu trả lời.
 *
 * Hợp đồng của mọi assert: **hợp đồng của `PRUNE_SCRIPT`** (workflow cũ bị xoá bởi PR
 * này; nguồn là `docs/applications/auth-nonce-prune-job/01-architecture.md` §5 và comment
 * đầu file `src/prune.ts`):
 *   - dừng bình thường khi lô rỗng (kho sạch — chạy lại phải `ok`);
 *   - dừng khi lô trả < `BATCH_SIZE` (không thêm vòng chắc chắn trả 0);
 *   - chạm trần batches/seconds phải **probe** `EXISTS`: còn backlog → `cap_hit` **throw**
 *     (cron đỏ); đã drain hết → `ok` kèm `cap=`;
 *   - `identity_mismatch` TRƯỚC batch đầu — KHÔNG DELETE nào chạy;
 *   - transport-class SQLSTATE được retry ≤ `MAX_ATTEMPTS` với backoff `attempt × 5` giây;
 *   - `statement_failed` (SQLSTATE 42501 / 57014) và output sai shape không retry.
 *
 * ⚠️ Clock giả: `targetWith` đặt mặc định `now: () => 0` — elapsed luôn 0 nên trần
 * `MAX_SECONDS` không bao giờ chạm trừ khi test **chủ động** đẩy đồng hồ trong callback
 * của fake pool. Một test quên inject clock là một test chạy hết vòng lô bình thường,
 * KHÔNG phải một test treo vì `Date.now()` thực.
 */

import { describe, expect, it, vi } from 'vitest';

import { BATCH_SIZE, MAX_ATTEMPTS, MAX_BATCHES, MAX_SECONDS } from './prune-caps';
import { pruneTarget, type PruneTarget, type QueryPool } from './prune';

/** Identity của kho giả — cùng hình `<role>|<trạng thái>` mà server trả string. */
const EXPECTED_IDENTITY = 'ecoma_auth_nonce_pruner|deletable';

/**
 * Đồng hồ giả — `now` trả giá trị hiện tại, `advance` đẩy thời gian (ms). Test seconds-cap
 * gọi `advance` **bên trong** callback của fake pool: mọi `await` của `pruneTarget` đều là
 * microtask, nên đó là điểm duy nhất để thời gian trôi giữa hai checkpoint của vòng lô.
 */
function fakeClock() {
  let current = 0;
  return {
    now: (): number => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

/** Lỗi marker của test — một callback bị gọi khi test không mong nó chạy là lỗi tường minh. */
function mustNotCall(what: string): never {
  throw new Error(`${what} must not run in this scenario`);
}

/** Phân loại một câu SQL thành route — so trên **chuỗi đã trim** (CTE mở đầu bằng `\n`). */
type Route = 'identity' | 'batch' | 'probe' | 'control';

function classify(text: string): Route {
  const t = text.trim();
  if (t.includes('current_user')) return 'identity';
  if (t.startsWith('WITH deleted AS')) return 'batch';
  if (t.includes('EXISTS')) return 'probe';
  return 'control';
}

/** Kịch bản câu SQL của fake pool — mỗi route một callback; mặc định là kho sạch. */
interface PoolScript {
  /** Giá trị `current_user || '|' || …` của preflight. */
  readonly identity?: () => string;
  /** Giá trị boolean của probe `EXISTS` — mặc định throw (probe không được gọi). */
  readonly probe?: () => boolean;
  /**
   * Số hàng của một lô — mặc định 0 (kho sạch). Trả một `Error` để throw từ trong
   * `client.query` (lỗi `pg` thật có SQLSTATE ở field `code`).
   */
  readonly batch?: () => number | Error;
  /** Hook ghi nhận MỌI câu query của client transaction (kể cả `BEGIN`/`SET LOCAL`). */
  readonly onClientQuery?: (route: Route, text: string) => void;
  /** Hook ghi nhận `release()` của client — ghim "client được trả về pool". */
  readonly onRelease?: () => void;
}

/** Pool fake + sổ ghi route của mọi query đã chạy — nguồn assert "gì đã được gọi". */
interface FakePool extends QueryPool {
  readonly calls: { readonly route: Route; readonly text: string }[];
}

function makePool(script: PoolScript = {}): FakePool {
  const calls: { route: Route; text: string }[] = [];
  const identity = script.identity ?? ((): string => EXPECTED_IDENTITY);
  const probe = script.probe ?? ((): boolean => mustNotCall('probe'));
  const batch = script.batch ?? ((): number | Error => 0);

  const makeClient = (): {
    query(
      text: string,
      values?: unknown[],
    ): Promise<{
      rows: Record<string, unknown>[];
      rowCount: number | null;
    }>;
    release(err?: boolean | Error): void;
  } => ({
    async query(text: string): Promise<{
      rows: Record<string, unknown>[];
      rowCount: number | null;
    }> {
      const route = classify(text);
      calls.push({ route, text });
      script.onClientQuery?.(route, text);
      if (route === 'batch') {
        const out = batch();
        if (out instanceof Error) {
          throw out;
        }
        return { rows: [{ count: String(out) }], rowCount: 1 };
      }
      // BEGIN / SET LOCAL / COMMIT / ROLLBACK — route `control`, không trả data.
      return { rows: [], rowCount: null };
    },
    release(err?: boolean | Error): void {
      void err;
      script.onRelease?.();
    },
  });

  return {
    calls,
    async query(text: string): Promise<{
      rows: Record<string, unknown>[];
      rowCount: number | null;
    }> {
      const route = classify(text);
      calls.push({ route, text });
      if (route === 'identity') {
        return { rows: [{ identity: identity() }], rowCount: 1 };
      }
      if (route === 'probe') {
        return { rows: [{ exists: probe() }], rowCount: 1 };
      }
      // Pool-level không nhận câu control nào từ thuật toán — câu lạ là lỗi test.
      return mustNotCall(`pool.query control route: ${text.slice(0, 60)}`);
    },
    async connect() {
      return makeClient();
    },
  };
}

/**
 * Dựng {@link PruneTarget} với pool fake.
 *
 * ⚠️ Mặc định `now: () => 0` — xem comment đầu file. Test seconds-cap override `now`
 * bằng clock giả của nó; mọi test khác không bao giờ chạm trần thời gian.
 */
function targetWith(pool: QueryPool, overrides?: Partial<PruneTarget>): PruneTarget {
  return {
    service: 'auth',
    schema: 'auth',
    expectedIdentity: EXPECTED_IDENTITY,
    pool: pool as unknown as PruneTarget['pool'],
    ...overrides,
  };
}

describe('normal drain paths', () => {
  it('returns ok outcome when the first batch returns zero rows', async () => {
    // Kho sạch: preflight ok, lô đầu trả 0 → dừng bình thường. Chạy lại trên một kho đã
    // sạch phải thành công (bất biến (7): không có trạng thái tiến độ nào để hỏng).
    const pool = makePool({ batch: () => 0 });
    const result = await pruneTarget(targetWith(pool), { startedAtMs: 0, now: () => 0 });
    expect(result.outcome).toBe('ok');
    expect(result.pruned).toBe(0);
    expect(result.batches).toBe(0);
    expect(result.retries).toBe(0);
    // Đúng một lô trả 0; probe không bao giờ chạy trên đường bình thường.
    expect(pool.calls.filter((c) => c.route === 'batch')).toHaveLength(1);
    expect(pool.calls.filter((c) => c.route === 'probe')).toHaveLength(0);
  });

  it('stops as soon as a batch returns fewer than BATCH_SIZE rows', async () => {
    // Lô cuối luôn nhỏ hơn size; một vòng thêm dư thừa chắc chắn trả 0 — script cũ dừng
    // luôn ("dừng luôn thay vì thêm một vòng chắc chắn trả 0"). Ghim: DELETE chỉ được
    // gọi đúng một lần, không có vòng thứ hai.
    const pool = makePool({ batch: () => BATCH_SIZE - 1 });
    const result = await pruneTarget(targetWith(pool), { startedAtMs: 0, now: () => 0 });
    expect(result.outcome).toBe('ok');
    expect(result.pruned).toBe(BATCH_SIZE - 1);
    expect(result.batches).toBe(1);
    expect(pool.calls.filter((c) => c.route === 'batch')).toHaveLength(1);
    expect(pool.calls.filter((c) => c.route === 'probe')).toHaveLength(0);
  });

  it('checks identity BEFORE any DELETE and stops at identity_mismatch without touching data', async () => {
    // Preflight: sai identity (role runtime của service khác — DSN dán nhầm) → throw,
    // KHÔNG lô nào chạy. Ghim bằng callback throw marker: nếu thuật toán chạy DELETE,
    // lỗi marker đó thay thế lỗi identity_mismatch trong assert bên dưới.
    const pool = makePool({
      identity: (): string => 'ecoma_account_runtime|deletable',
      probe: (): boolean => mustNotCall('probe'),
      batch: (): number | Error => mustNotCall('batch delete'),
    });
    await expect(pruneTarget(targetWith(pool), { startedAtMs: 0, now: () => 0 })).rejects.toThrow(
      /outcome=identity_mismatch connected_as=ecoma_account_runtime/u,
    );
    expect(pool.calls.filter((c) => c.route === 'batch')).toHaveLength(0);
    expect(pool.calls.filter((c) => c.route === 'probe')).toHaveLength(0);
  });

  it('treats a missing table (to_regclass NULL) as identity mismatch and never removes rows', async () => {
    // `to_regclass` NULL → CASE ra 'missing' — sai expected → throw trước lô đầu.
    const pool = makePool({
      identity: (): string => 'ecoma_auth_nonce_pruner|missing',
      probe: (): boolean => mustNotCall('probe'),
      batch: (): number | Error => mustNotCall('batch delete'),
    });
    await expect(pruneTarget(targetWith(pool), { startedAtMs: 0, now: () => 0 })).rejects.toThrow(
      /connected_as=ecoma_auth_nonce_pruner\|missing/u,
    );
    expect(pool.calls.filter((c) => c.route === 'batch')).toHaveLength(0);
  });
});

describe('cap behaviour', () => {
  it('stops at the batches cap after MAX_BATCHES full batches and reports ok when the probe shows the backlog was drained', async () => {
    // 50 lô full liên tiếp → checkpoint `batches >= MAX_BATCHES` trước lô 51 → chạm trần
    // `batches` → probe `EXISTS` (bắt buộc — trần không tự chứng minh còn backlog) → probe
    // `false`: đã xoá vừa đủ lúc chạm trần → `ok` kèm `cap=batches`, KHÔNG throw.
    let batchCalls = 0;
    const pool = makePool({
      batch: (): number => {
        batchCalls += 1;
        return BATCH_SIZE;
      },
      probe: (): boolean => false,
    });
    const result = await pruneTarget(targetWith(pool), { startedAtMs: 0, now: () => 0 });
    expect(result.outcome).toBe('ok');
    expect(result.cap).toBe('batches');
    expect(result.batches).toBe(MAX_BATCHES);
    expect(result.pruned).toBe(MAX_BATCHES * BATCH_SIZE);
    // Lô 51 không bao giờ chạy — trần kiểm TRƯỚC mỗi lô.
    expect(batchCalls).toBe(MAX_BATCHES);
    expect(pool.calls.filter((c) => c.route === 'probe')).toHaveLength(1);
  });

  it('throws cap_hit when the batches cap is hit and the probe confirms remaining backlog', async () => {
    // Trần batches + probe còn backlog → throw (cron đỏ). Message mang đúng shape dòng
    // lỗi script cũ: `service=… outcome=cap_hit cap=batches pruned=… batches=…`.
    const pool = makePool({ batch: (): number => BATCH_SIZE, probe: (): boolean => true });
    await expect(pruneTarget(targetWith(pool), { startedAtMs: 0, now: () => 0 })).rejects.toThrow(
      /outcome=cap_hit cap=batches .*batches=50 /u,
    );
  });

  it('hits the seconds cap when MAX_SECONDS elapse and reports ok when the probe shows the backlog was drained', async () => {
    // Trần seconds: đồng hồ giả được đẩy lên đúng MAX_SECONDS ở lô đầu — checkpoint kế
    // thấy `elapsed >= MAX_SECONDS` → chạm trần `seconds` → probe false → ok.
    const clock = fakeClock();
    const pool = makePool({
      batch: (): number => {
        clock.advance(MAX_SECONDS * 1000);
        return BATCH_SIZE;
      },
      probe: (): boolean => false,
    });
    const result = await pruneTarget(targetWith(pool), {
      startedAtMs: 0,
      now: clock.now,
    });
    expect(result.outcome).toBe('ok');
    expect(result.cap).toBe('seconds');
    expect(result.batches).toBe(1);
    expect(result.duration_s).toBe(MAX_SECONDS);
  });

  it('throws cap_hit with cap=seconds when time runs out and the probe confirms remaining backlog', async () => {
    // Cùng trần seconds nhưng probe còn backlog → throw với `cap=seconds` (fail closed).
    const clock = fakeClock();
    const pool = makePool({
      batch: (): number => {
        clock.advance(MAX_SECONDS * 1000);
        return BATCH_SIZE;
      },
      probe: (): boolean => true,
    });
    await expect(pruneTarget(targetWith(pool), { startedAtMs: 0, now: clock.now })).rejects.toThrow(
      /outcome=cap_hit cap=seconds .*backlog_remains=true/u,
    );
  });
});

/**
 * Lỗi `pg` thật mang SQLSTATE ở field `code` — lớp nhỏ để raise được SQLSTATE trong tests
 * mà không phải dựng EventEmitter/connection stream của `pg.Pool` thật.
 */
class TransportPgError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`fake pg error with SQLSTATE ${code}`);
    this.name = 'TransportPgError';
    this.code = code;
  }
}

describe('retry policy', () => {
  it('retries a transport-class SQLSTATE up to MAX_ATTEMPTS with linear backoff and then returns ok', async () => {
    // 2 lần lỗi 08006 (connection_failure — transport class), lượt 3 thành công: đúng
    // MAX_ATTEMPTS, backoff 5s + 10s tuyến tính theo `attempt × 5`.
    const sleepSpy = vi.fn<(ms: number) => Promise<void>>((_ms: number) => Promise.resolve());
    let batchCalls = 0;
    const pool = makePool({
      batch: (): number | Error => {
        batchCalls += 1;
        if (batchCalls <= 2) {
          return new TransportPgError('08006');
        }
        return BATCH_SIZE - 1;
      },
    });
    const result = await pruneTarget(targetWith(pool), {
      sleep: sleepSpy,
      startedAtMs: 0,
      now: () => 0,
    });
    expect(result.outcome).toBe('ok');
    expect(result.retries).toBe(2);
    expect(sleepSpy.mock.calls.map((c) => c[0])).toEqual([5000, 10000]);
  });

  it('gives up after MAX_ATTEMPTS transport failures and throws the driver error', async () => {
    // Lỗi transport mỗi lượt — tới MAX_ATTEMPTS vẫn fail → throw ra composition root
    // (outcome `db_unreachable` ở `main.ts`): đúng MAX_ATTEMPTS lần thực thi, không lượt
    // thứ MAX_ATTEMPTS + 1 nào, và sleep chỉ chạy giữa các lần (MAX_ATTEMPTS - 1).
    let batchCount = 0;
    const pool = makePool({
      batch: (): number | Error => {
        batchCount += 1;
        return new TransportPgError('08006');
      },
    });
    const sleepSpy = vi.fn<(ms: number) => Promise<void>>((_ms: number) => Promise.resolve());
    await expect(
      pruneTarget(targetWith(pool), { sleep: sleepSpy, startedAtMs: 0, now: () => 0 }),
    ).rejects.toThrow(TransportPgError);
    expect(batchCount).toBe(MAX_ATTEMPTS);
    expect(sleepSpy.mock.calls).toHaveLength(MAX_ATTEMPTS - 1);
  });

  it('does not retry a statement-class error (missing DELETE privilege, SQLSTATE 42501)', async () => {
    // Thiếu quyền (42501) — không thuộc transport; như script cũ exit 1 ngay, không sleep
    // và không lượt thứ hai: một lô chậm hay thiếu quyền KHÔNG bị thử lại ba lần.
    let batchCount = 0;
    const pool = makePool({
      batch: (): number | Error => {
        batchCount += 1;
        return new TransportPgError('42501');
      },
    });
    const sleepSpy = vi.fn<(ms: number) => Promise<void>>((_ms: number) => Promise.resolve());
    await expect(
      pruneTarget(targetWith(pool), { sleep: sleepSpy, startedAtMs: 0, now: () => 0 }),
    ).rejects.toThrow(TransportPgError);
    expect(batchCount).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('does not retry a statement_timeout termination (SQLSTATE 57014)', async () => {
    // Statement chạy chậm vượt trần 60s (57014) là lỗi cấp câu — như script cũ psql exit 1,
    // không retry: thử lại chỉ kéo dài giữ khoá, mà một lô bị kill thì cũng rollback sạch.
    const pool = makePool({ batch: (): number | Error => new TransportPgError('57014') });
    const sleepSpy = vi.fn<(ms: number) => Promise<void>>((_ms: number) => Promise.resolve());
    await expect(
      pruneTarget(targetWith(pool), { sleep: sleepSpy, startedAtMs: 0, now: () => 0 }),
    ).rejects.toThrow(TransportPgError);
    expect(sleepSpy).not.toHaveBeenCalled();
  });
});

describe('per-target bookkeeping', () => {
  it('reports a nonzero pruned count when a later batch fails after earlier batches committed', async () => {
    // Counters của dòng lỗi phải là số đã xoá THẬT: hai lô commit rồi lô 3 hỏng transport
    // mãi mãi → throw, và số lô đã commit không được bịa thành 0 (tín hiệu sai theo hướng
    // nguy hiểm). Ghim bằng số lần callback batch được gọi: 2 lô commit + đủ MAX_ATTEMPTS
    // lần thử của lô 3 — không lượt thử nào nữa sau khi hết ngân sách.
    let batchCalls = 0;
    const pool = makePool({
      batch: (): number | Error => {
        batchCalls += 1;
        if (batchCalls <= 2) {
          return BATCH_SIZE; // hai lô commit trong im lặng
        }
        return new TransportPgError('08006');
      },
    });
    await expect(
      pruneTarget(targetWith(pool), {
        sleep: () => Promise.resolve(),
        startedAtMs: 0,
        now: () => 0,
      }),
    ).rejects.toThrow(TransportPgError);
    expect(batchCalls).toBe(2 + MAX_ATTEMPTS);
  });

  it('uses SET LOCAL per batch and never a connection-level SET', async () => {
    // HD5: timeout phải `SET LOCAL` trong transaction, KHÔNG SET cấp connection. Ghim bằng
    // fake pool ghi lại mọi câu của client transaction: BEGIN → SET LOCAL ×2 → CTE →
    // COMMIT, và KHÔNG câu `SET` nào thiếu `LOCAL`.
    const texts: string[] = [];
    const pool = makePool({
      batch: (): number => BATCH_SIZE - 1,
      onClientQuery: (_route, text): void => {
        texts.push(text);
      },
    });
    await pruneTarget(targetWith(pool), { startedAtMs: 0, now: () => 0 });
    expect(texts.some((t) => t.trim().startsWith('SET LOCAL statement_timeout'))).toBe(true);
    expect(texts.some((t) => t.trim().startsWith('SET LOCAL lock_timeout'))).toBe(true);
    // Cứng: KHÔNG có `SET ` (non-LOCAL) nào được phát — pattern này bắt regression khi
    // một SET cấp connection nhẩy vào không ghi chú.
    expect(texts.some((t) => /^SET (?!LOCAL)/u.test(t.trim()))).toBe(false);
  });

  it('rolls back and releases the client when a batch statement fails mid-transaction', async () => {
    // Lỗi statement giữa transaction → ROLLBACK được gọi trước release — một aborted
    // transaction không rò sang lần connect kế (PostgreSQL từ chối câu query kế trên
    // transaction đang aborted nếu không rollback).
    let rollbackSeen = false;
    let released = false;
    const pool = makePool({
      batch: (): number | Error => new TransportPgError('42501'),
      onClientQuery: (_route, text): void => {
        if (text.trim().startsWith('ROLLBACK')) {
          rollbackSeen = true;
        }
      },
      onRelease: (): void => {
        released = true;
      },
    });
    await expect(
      pruneTarget(targetWith(pool), {
        sleep: () => Promise.resolve(),
        startedAtMs: 0,
        now: () => 0,
      }),
    ).rejects.toThrow(TransportPgError);
    expect(rollbackSeen).toBe(true);
    expect(released).toBe(true);
  });
});
