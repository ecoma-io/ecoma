/**
 * Kết nối PostgreSQL của runtime TypeScript `llm-api` — MỘT `pg.Client` MỖI
 * PHÉP GỌI SQL (admission → connect → query → end), KHÔNG pool.
 *
 * ⚠️ Lệch có chủ đích so với pattern cached-Pool per isolate của
 * `pact-broker-api` (PERF-06): pg Pool tái dùng client idle qua workerd bị
 * vỡ ở tầng platform — đo trực tiếp trên một worker thí nghiệm tối giản
 * (chỉ `new Pool` + `pool.query('SELECT 1')`, không code app, không deadline
 * race): request đầu OK ~11ms, request kế tiếp bị workerd giết vì "code had
 * hung and would never generate a response", mô hình lặp lại xen kẽ rồi pool
 * kẹt hẳn ở connect-timeout 5s từ request thứ bảy. Với `pg.Client` mới mỗi
 * lần gọi: 20/20 lần liên tiếp OK, 5-16ms/lần. Runtime Rust đang bị thay thế
 * CŨNG mở một socket mới cho MỖI câu SQL rồi đóng ngay sau khi query xong
 * (`binding_simple_query`, `src/readiness.rs`) — lifecycle per-operation là
 * bản port trung thực của artifact, không phải workaround tạm.
 *
 * Hai giới hạn đã có ở tầng platform nhưng KHÔNG phải giới hạn của app (không
 * được dùng làm cớ để bỏ admission control — review P2 của PR #152):
 * - workerd chặn **6 kết nối đồng thời đang chờ response header trên MỖI
 *   invocation** (verify docs Cloudflare 2026-11-13; platform fact WK5) —
 *   phần thừa bị xếp hàng ở tầng runtime, không phải reject.
 * - Hyperdrive giới hạn phía origin (~20 Free / ~100 Paid connection mỗi
 *   config, soft — platform fact HD9): đây là bound duy nhất áp cho TOÀN
 *   deployment; giới hạn trong isolate này chỉ là best-effort shaping, vì
 *   nhiều isolate chạy song song không chia sẻ state (invariant 12).
 *
 * Admission control (review P2 của PR #152): mỗi binding có MỘT limiter
 * riêng (limit + queue hữu hạn) — không có bất kỳ đường tạo client nào đi
 * ngoài limiter. State limiter sống trong closure `buildApp()` của
 * `src/index.ts` (không phải module-level), best-effort, không bao giờ là
 * correctness state: thiếu/hỏng limiter không đổi kết quả 200/503 fail-closed.
 * Chệch có chủ đích so với policy vận hành đích ("pool cạn → 503 + Retry-After,
 * không queue chờ" — `docs/applications/llm-api/03-operations.md` §4): policy
 * đó thuộc control plane chưa xây; ở data plane M1 queue bounded + deadline
 * là hành vi xác định được chọn, deviation đã ghi nhận trong chính doc đó.
 *
 * Deadline (review P1 của PR #152): deadline của operation bao trùm CẢ thời
 * gian chờ admission. Khi deadline thắng, operation bị terminate THẬT —
 * không phải chỉ bỏ cuộc đua rồi bỏ mạng query chạy nền:
 * - Query phase: `client.end()` với active query đi nhánh force-destroy của
 *   pg (`client.js` 8.23.1 — "a hung query could block end forever" →
 *   `stream.destroy()`) — socket chấm dứt ngay, PostgreSQL hủy statement khi
 *   thấy EOF. `end()` nhánh graceful có thể treo vô hạn trên writer kẹt nên
 *   đường abort KHÔNG BAO GIỜ await nó.
 * - Connect phase: KHÔNG force end() giữa chừng — timer `connectionTimeoutMillis`
 *   5s của pg tự destroy stream (tối đa ~2s sau deadline 3s; end() mid-connect
 *   đi nhánh graceful lộn xộn không cải thiện bound nào).
 * - `Promise.race` đơn thuần CHỈ bỏ cầu nối promise, không đóng socket — vì
 *   vậy race ở đây luôn đi kèm teardown + lỗi typed, không dùng làm cơ chế
 *   cancellation một mình.
 *
 * ⚠️ Migration KHÔNG đi qua đường này (Hyperdrive không hỗ trợ advisory
 * lock); migration chạy từ CI runner bằng `db/apply.mts` với credential
 * migrator.
 *
 * Bất biến platform: KHÔNG BAO GIỜ log connection string hay credential.
 */
import { Client } from 'pg';

import { BINDING_GATEWAY, BINDING_MARKETPLACE, BINDING_TENANT, type BindingName } from './env';

/*
 * NĂM knob giới hạn, mỗi giá trị một nghĩa — không gộp một knob:
 *
 * 1. `CONNECTION_TIMEOUT_MS` — timeout mở connection (TCP connect + auth).
 *    Chặn request treo chờ database không trả lời; timer của pg tự destroy
 *    stream khi hết.
 * 2. `STATEMENT_TIMEOUT_MS` — `statement_timeout` phía server: trần thời gian
 *    cho MỌI statement (backstop server-side, kể cả khi deadline phía caller
 *    đã bỏ cuộc — statement còn chạy tối đa tới đây rồi bị server hủy).
 * 3. `READINESS_DEADLINE_MS` (định nghĩa ở `readiness.ts`) — deadline
 *    operation per-binding của probe readiness. 3s < 5s < 15s là thang chủ
 *    đích: `/ready` không bao giờ treo chờ database chết.
 * 4. `PER_BINDING_CONCURRENCY_LIMIT` — số operation đồng thời tối đa MỖI
 *    binding. Derivation: readiness cần 3 probe song song mỗi request NHƯNG
 *    mỗi binding chỉ 1 probe/request; catalogue chạy 2 query tuần tự. Limit 3
 *    là nhỏ nhất phục vụ pinned load (3 request `/ready` đồng thời — suite
 *    integration) với zero queuing, và nằm gọn trong trần 6 kết nối
 *    connect-pending của một invocation.
 * 5. `PER_BINDING_QUEUE_CAPACITY` — sức chứa queue chờ admission MỖI binding
 *    (tuyệt đối, không nhân limit). Derivation: một round burst thêm bằng
 *    đúng limit — burst pinned load vẫn xanh khi mọi slot bị giữ chốc lát;
 *    vượt queue là fail-fast ngay (`QueueCapacityExceededError`).
 *
 * Tổng bound per isolate TÍNH ĐƯỢC: (limit + queue) × 3 binding = 18 promise
 * in-flight-or-waiting tối đa — vô nghĩa so với 128MB/isolate, và mỗi request
 * đơn lẻ chỉ đặt tối đa 3 connect-pending < trần 6 của invocation.
 */

/** Timeout mở connection (TCP + auth) của một `pg.Client`. */
export const CONNECTION_TIMEOUT_MS = 5_000;

/** `statement_timeout` phía server cho statement chạy qua client này. */
export const STATEMENT_TIMEOUT_MS = 15_000;

/** Số operation SQL đồng thời tối đa trên MỘT binding (per isolate). */
export const PER_BINDING_CONCURRENCY_LIMIT = 3;

/** Sức chứa queue chờ admission của MỘT binding (tuyệt đối; đầy là fail-fast). */
export const PER_BINDING_QUEUE_CAPACITY = 3;

/**
 * Deadline của operation đã hết (admission hoặc connect hoặc query) — operation
 * bị terminate theo đúng semantics mô tả ở header. Caller map lỗi này thành
 * trạng thái `timeout` của readiness / 503 của catalogue.
 */
export class OperationDeadlineError extends Error {
  constructor() {
    super('sql operation deadline exceeded');
    this.name = 'OperationDeadlineError';
  }
}

/**
 * Queue admission của binding đã đầy — fail-fast xác định, không xếp hàng vô
 * hạn. Caller map thành `unavailable` (readiness) / `CatalogueError` (catalogue).
 */
export class QueueCapacityExceededError extends Error {
  constructor() {
    super('sql admission queue is full');
    this.name = 'QueueCapacityExceededError';
  }
}

/**
 * Một slot admission đã được yêu cầu: `wait()` chờ được cấp; `abandon()` rút
 * khỏi queue khi caller hết deadline trước khi được cấp (no-op nếu đã cấp —
 * slot khi đó đã thuộc caller); `release()` trả slot (chỉ gọi đúng một lần
 * sau khi `wait()` resolve).
 */
export interface Admission {
  wait(): Promise<void>;
  abandon(): void;
  release(): void;
}

/** Limiter admission hữu hạn của MỘT binding (per isolate). */
export interface BindingLimiter {
  /**
   * Yêu cầu một slot. Slot còn trống → cấp ngay. Queue còn chỗ → xếp hàng
   * FIFO. Queue đầy → fail-fast ngay bằng `QueueCapacityExceededError`
   * (không bao giờ xếp hàng vô hạn).
   */
  acquire(): Admission;
}

/**
 * Tạo limiter cho một binding. Slot nhả ra được bàn giao TRỰC TIẾP cho waiter
 * đầu hàng (handoff — không có cửa sổ caller khác chen ngang), nên số operation
 * active không bao giờ vượt `limit` trên mọi đường success/failure/timeout.
 */
export function createBindingLimiter(
  binding: BindingName,
  limit: number = PER_BINDING_CONCURRENCY_LIMIT,
  queueCapacity: number = PER_BINDING_QUEUE_CAPACITY,
): BindingLimiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('concurrency limit must be a positive integer');
  }
  if (!Number.isInteger(queueCapacity) || queueCapacity < 0) {
    throw new Error('queue capacity must be a non-negative integer');
  }
  let active = 0;
  const queue: Array<{ grant(): void }> = [];
  const releaseSlot = (): void => {
    const next = queue.shift();
    if (next !== undefined) {
      next.grant();
      return;
    }
    active -= 1;
  };
  return {
    acquire(): Admission {
      if (active < limit) {
        active += 1;
        return { wait: () => Promise.resolve(), abandon: () => undefined, release: releaseSlot };
      }
      if (queue.length >= queueCapacity) {
        throw new QueueCapacityExceededError();
      }
      let granted = false;
      let resolveGrant: (() => void) | undefined;
      const entry = {
        grant: (): void => {
          granted = true;
          resolveGrant?.();
        },
      };
      queue.push(entry);
      return {
        wait: () =>
          new Promise<void>((resolve) => {
            if (granted) {
              resolve();
            } else {
              resolveGrant = resolve;
            }
          }),
        abandon: () => {
          const index = queue.indexOf(entry);
          if (index >= 0) {
            queue.splice(index, 1);
          }
        },
        release: releaseSlot,
      };
    },
  };
}

/** Một bộ limiter cho cả ba binding — tạo MỘT LẦN trong closure `buildApp()`. */
export function createBindingLimiters(): Readonly<Record<BindingName, BindingLimiter>> {
  return {
    [BINDING_GATEWAY]: createBindingLimiter(BINDING_GATEWAY),
    [BINDING_TENANT]: createBindingLimiter(BINDING_TENANT),
    [BINDING_MARKETPLACE]: createBindingLimiter(BINDING_MARKETPLACE),
  };
}

/** Tùy chọn operation SQL: admission limiter và/hoặc deadline operation. */
export interface SqlOperationOptions {
  /** Limiter của binding đang gọi — mọi caller production PHẢI truyền. */
  readonly limiter?: BindingLimiter;
  /**
   * Deadline operation (ms) bao trùm admission + connect + query — một budget
   * duy nhất, không cộng dồn. Hết deadline: chờ admission → rút khỏi queue,
   * chưa mở client; đang query → terminate connection; đang connect → pg tự
   * destroy stream ở connect-timeout.
   */
  readonly deadlineMs?: number;
}

/**
 * Chạy `run` trên một client pg mới cho đúng một phép gọi SQL. Client bị
 * đóng ở mọi đường ra; slot admission được trả ở mọi đường ra; deadline hết
 * thì operation bị terminate (xem header). Không có client nào sống sót qua
 * request, nên không có kết nối idle phải dọn.
 */
export async function withClient<T>(
  connectionString: string,
  run: (client: Client) => Promise<T>,
  options: SqlOperationOptions = {},
): Promise<T> {
  const { limiter, deadlineMs } = options;

  // Deadline DUY NHẤT chạy từ trước admission: thời gian chờ slot nằm TRONG
  // budget, không cộng dồn với connect/query.
  let deadlineHit = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise: Promise<never> =
    deadlineMs === undefined
      ? NEVER_SETTLED
      : new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            deadlineHit = true;
            reject(new OperationDeadlineError());
          }, deadlineMs);
        });

  let admission: Admission | undefined;
  let granted = false;
  try {
    if (limiter !== undefined) {
      // Queue đầy nổ ngay TẠI ĐÂY (fail-fast, trước khi tạo bất cứ gì).
      admission = limiter.acquire();
      await Promise.race([admission.wait(), deadlinePromise]);
      granted = true;
    }

    // Static import — esbuild bundle build/index.js gộp pg vào artifact (như
    // bản port đầu: `await import('pg')` với module được bundle được esbuild
    // rewrite tĩnh, artifact không đổi). Static để mọi phép gọi dùng đúng MỘT
    // module instance — import động song song đã từng nạp client thật qua
    // vi.mock ở unit test (lệch module cache), đường production thì như nhau.
    const client = new Client({
      connectionString,
      // Hyperdrive khuyến nghị tắt keepalive dài hạn trên Workers.
      keepAlive: false,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
    // Bắt buộc có listener `error` (cùng lý do `createPool` của Pact Broker):
    // connection chết giữa chừng (VD database restart gửi FATAL 57P01) phát
    // sự kiện `error` trên EventEmitter — không listener là uncaught exception
    // trong isolate. Lỗi của PHÉP GỌI đã đi qua rejection của `run` (fail-closed
    // đúng hợp đồng); listener chỉ giữ isolate không chết vì sự kiện lẻ.
    client.on('error', () => undefined);

    let ended = false;
    let connected = false;
    /**
     * Terminate fire-and-forget khi deadline thắng: `end()` nhánh graceful có
     * thể treo vô hạn trên writer kẹt nên đường abort KHÔNG await; nhánh
     * active-query của pg là force-destroy nên socket chấm dứt ngay. Guard
     * `ended`/`connected` ở app-level — không phụ thuộc state nội bộ của pg.
     */
    const terminate = (): void => {
      if (ended || !connected) {
        return;
      }
      ended = true;
      void client.end().catch(() => undefined);
    };

    try {
      // Guard rejection float: connect/query có thể settle SAU khi deadline
      // đã thắng race — bản sao `.catch` hút rejection muộn, bản gốc vẫn được
      // await/race bình thường khi operation thắng.
      const connectPromise = client.connect();
      connectPromise.catch(() => undefined);
      await Promise.race([connectPromise, deadlinePromise]);
      connected = true;

      const runPromise = Promise.resolve(run(client));
      runPromise.catch(() => undefined);
      return await Promise.race([runPromise, deadlinePromise]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (deadlineHit) {
        // Đang connect: KHÔNG force end() — timer connect-timeout 5s của pg
        // tự destroy stream (≤2s sau deadline; end() mid-connect đi nhánh
        // graceful lộn xộn không cải thiện bound). Đang query: force-destroy.
        terminate();
      } else {
        // Đường thường: đóng client và CHỜ — response không được trả trước
        // khi socket đóng (semantics giữ nguyên từ bản port đầu).
        ended = true;
        await client.end().catch(() => undefined);
      }
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (admission !== undefined) {
      if (granted) {
        admission.release();
      } else {
        admission.abandon();
      }
    }
  }
}

/** Promise không bao giờ settle — placeholder khi operation không có deadline. */
const NEVER_SETTLED: Promise<never> = new Promise<never>(() => {
  // Không bao giờ gọi resolve/reject — đúng ý đồ.
});
