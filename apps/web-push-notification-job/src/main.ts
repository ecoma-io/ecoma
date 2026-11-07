/**
 * Composition root của `web-push-notification-job` — **nơi duy nhất** các tầng được nối lại.
 *
 * ⚠️ Worker này có **hai** entrypoint của platform và **không có** application API:
 * - `queue`  — consumer của Queue `ecoma-push-delivery` (FR-018, §12.1): per-message
 *   ACK/retry, không `ackAll`/`retryAll`.
 * - `fetch`  — trả `404` cho mọi thứ, **trừ** `POST /internal/reconcile/jobs` (xem dưới).
 *
 * ⚠️ **Không có `scheduled()`.** Trigger của job reconciliation là một quyết định **chưa
 * chốt** (lịch sweep là operational gate chưa quyết định — chưa có section canonical trong
 * `docs/applications/web-push-notification-job/03-operations.md`; ngưỡng liên quan
 * `delivery_reconciliation_age` thuộc control plane, canonical →
 * `docs/applications/push-notification/03-operations.md` §4.2/§11), và Lead đã quyết định cấm
 * bịa một cron trigger. Vì vậy
 * sweep tồn tại như một hàm thuần (`runJobReconciliation`) được expose tại một endpoint có
 * xác thực; khi trigger chốt, chỉ cần gọi hàm đó. Xem `main.ts` của composition root này.
 *
 * ⚠️ **Không compose từ `JobStatePort` của control plane, không import Hono, không import
 * router nào.** Khác với `apps/push-notification/src/main.ts`, worker này **không** có HTTP
 * application API: đường HTTP duy nhất là endpoint reconciliation một hàm, và viết nó bằng
 * router là thêm một tầng (và một bề mặt) cho đúng ba nhánh.
 */

import {
  RuntimeAuthResolutionError,
  RuntimeContractError,
  authenticateReconciliationCaller,
  consumeQueueBatch,
  readRequestHeader,
  runJobReconciliation,
  type ConsumableMessage,
  type DeliveryPipelineDeps,
  type JobReconciliationReport,
  type PipelineClock,
  type ReconciliationAuthConfig,
} from '@ecoma-io/web-push-notification-job-application';
import {
  D1JobStateRepository,
  RuntimeControlPlaneClient,
  createLogger,
  createMetrics,
  resolveLogLevel,
  type RuntimeServiceBinding,
} from '@ecoma-io/web-push-notification-job-infrastructure';
import { createWebPushSender } from '@ecoma-io/web-push-notification-job-infrastructure/web-push';

import type { JobStateEnv, ReconcileRequest } from './env';

/* -------------------------------------------------------------------------------------- */
/* Dependency của hai entrypoint                                                              */
/* -------------------------------------------------------------------------------------- */

/**
 * Bundle binding của Worker — khai **bề mặt hẹp**, không phải global của `workers-types`.
 *
 * ⚠️ Cộng thêm index signature `[key: string]: unknown` **có chủ đích**: `env` của Worker còn
 * mang `vars` và Worker Secrets (`RUNTIME_API_SHARED_SECRET`, `RUNTIME_API_EXPECTED_PRINCIPAL`),
 * và tầng resolve đọc chúng bằng tên. Không có index signature thì mọi lần đọc một biến cấu
 * hình đều là một lỗi type — tức công cụ kiểu **ép** việc đọc binding bằng index, chứ không phải
 * làm cho nó dễ hơn. Binding `QUEUE` và `PUSH_NOTIFICATION_SERVICE` vẫn được khai tường minh
 * nên thiếu một binding là lỗi compile.
 */
export interface JobWorkerEnv extends JobStateEnv {
  readonly [key: string]: unknown;
  /** Queue producer `ecoma-push-delivery` (binding `QUEUE`). */
  readonly QUEUE: { send(message: unknown): Promise<unknown> };
  /** Service Binding `PUSH_NOTIFICATION_SERVICE` tới control plane. */
  readonly PUSH_NOTIFICATION_SERVICE: RuntimeServiceBinding;
}

/**
 * Ngưỡng "kẹt" và trần sweep — **giá trị test/placeholder, CHƯA phải quyết định vận hành**.
 *
 * ⚠️ `delivery_reconciliation_age` là **operational gate chưa chốt** (canonical →
 * `docs/applications/push-notification/03-operations.md` §4.2/§11; §4 của docs
 * web-push-notification-job liệt kê batch size / batch timeout của consumer là tham số
 * phải kiểm soát nhưng **chưa có giá trị**). Agent này
 * không có quyền chốt hai thứ đó, nên chúng là hằng số **đặt tên rõ** ở đây: một test khẳng
 * định ngưỡng bằng cách truyền `stuckAfterMs` riêng, và khi operator chốt chỉ có **hai** hằng
 * này phải sửa. `wrangler.jsonc` cũng chưa đặt `max_batch_timeout`/`max_batch_size` cho
 * cùng lý do.
 */
const RECONCILE_STUCK_AFTER_MS = 15 * 60_000;
const RECONCILE_LIMIT = 100;
/**
 * Trần attempt cho attempt budget của job reconciliation — placeholder/gate, **chưa phải
 * quyết định vận hành** (xem JSDoc của `JobReconciliationOptions.maxAttempts`). Giá trị 3
 * khớp `max_retries` mặc định của Queue trong `wrangler.jsonc` (QU2), nhưng hai con số
 * này là **hai cơ chế khác nhau** và operator có thể chốt riêng; khi chốt chỉ có hằng này
 * phải sửa.
 */
const RECONCILE_MAX_ATTEMPTS = 3;

/** Clock của isolate — epoch millis. */
const clock: PipelineClock = {
  now: () => Date.now(),
};

/* -------------------------------------------------------------------------------------- */
/* Queue consumer                                                                             */
/* -------------------------------------------------------------------------------------- */

/**
 * Thu hẹp `MessageBatch` của platform xuống đúng ba thứ `consumeQueueBatch` dùng.
 *
 * ⚠️ `body` là `unknown` và `attempts` là **số**: `Message<any>` sẽ làm mất kiểm soát kiểu ở
 * `validateDeliveryCommand`, còn `attempts` là input của backoff nên phải là con số thật.
 *
 * ⚠️ `Message.retry({ delaySeconds })` là hình dạng của platform: `undefined` ⇒ Queue tự áp
 * policy backoff của nó (xem `queueRetryDelaySeconds`).
 */
type PlatformMessageBatch = {
  readonly messages: readonly {
    readonly body: unknown;
    readonly attempts: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }[];
};

/**
 * Xử lý một batch của Queue.
 *
 * ⚠️ Không `ackAll`/`retryAll`, không `abort()`: per-message ACK/retry là yêu cầu bắt buộc, và
 * `abort()` sẽ cắt các message chưa xử lý — biến một lỗi thành mất việc.
 */
export async function handleQueueBatch(
  env: JobWorkerEnv,
  batch: PlatformMessageBatch,
): Promise<void> {
  const deps = buildPipelineDeps(env);
  const messages: ConsumableMessage[] = batch.messages.map((message) => ({
    body: message.body,
    attempts: message.attempts,
    ack: () => {
      message.ack();
    },
    retry: (options?: { delaySeconds?: number }) => {
      message.retry(options);
    },
  }));
  await consumeQueueBatch(deps, messages);
}

/**
 * Dựng dependency của pipeline — **mỗi lần gọi một bản mới**, không cache.
 *
 * ⚠️ `RuntimeControlPlaneClient` giữ `env` chứ **không** giữ secret đã resolve: secret phải
 * được resolve ở **từng** request để một deploy thiếu secret sinh ra `runtime_resolution_errors`
 * + bounded retry → DLQ thay vì chết ở tầng compose với không một metric nào.
 *
 * ⚠️ `D1JobStateRepository` không giữ state giữa các message: mọi lần đọc/ghi là một statement
 * với guard trong SQL (không row-locking — DB3/DB11), nên hai Worker cùng consume cùng một
 * `delivery_id` không cần một khoá nào ở đây.
 */
export function buildPipelineDeps(
  env: JobWorkerEnv,
  /**
   * Seam inject cho test — production KHÔNG truyền gì: `sender` mặc định là adapter Web Push
   * thật. Tham số này tồn tại vì composition test cần thay provider bằng fake mà không phải
   * chặn `globalThis.fetch` (cách chặn đó bắt cả request ngoài scope delivery, dễ che lỗi).
   */
  overrides: { readonly sender?: DeliveryPipelineDeps['sender'] } = {},
): DeliveryPipelineDeps {
  const jobs = new D1JobStateRepository({ db: env['push-job'] });
  const runtime = new RuntimeControlPlaneClient({ binding: env.PUSH_NOTIFICATION_SERVICE, env });
  return {
    runtime,
    jobs,
    sender: overrides.sender ?? createWebPushSender(),
    clock,
    metrics: createMetrics({ service: 'web-push-notification-job' }),
    logger: createLogger({
      service: 'web-push-notification-job',
      environment: resolveEnvironment(env),
      level: resolveLogLevel(env),
    }),
  };
}

/* -------------------------------------------------------------------------------------- */
/* Endpoint reconciliation nội bộ                                                             */
/* -------------------------------------------------------------------------------------- */

/**
 * `POST /internal/reconcile/jobs` — chạy một lần sweep job reconciliation.
 *
 * ⚠️ **Đây là operator surface, không phải application API** (invariant 1 §19). Nó tồn tại vì
 * trigger chưa chốt: một endpoint có xác thực là hình thức duy nhất để sweep chạy được mà không
 * bịa một cron. Auth dùng **cùng** cơ chế với private API của control plane
 * (`Authorization` mang secret nguyên văn + `X-ECOMA-PRINCIPAL`), so **constant-time**,
 * `401` trước mọi việc khác, và fail-closed khi thiếu secret lẫn principal.
 *
 * ⚠️ Endpoint **không** nhận tham số sweep từ request: `stuckAfterMs`/`limit` là quyết định
 * vận hành của composition root, không phải của caller — nếu nhận từ query string thì bất kỳ
 * ai xác thực được cũng đặt được ngưỡng, và đó là một cách cho một endpoint nội bộ thành
 * một đường leo thang nhỏ.
 */
export async function handleReconcileRequest(
  env: JobWorkerEnv,
  request: ReconcileRequest,
): Promise<Response> {
  const config: ReconciliationAuthConfig = {
    sharedSecret: resolveReconcileSharedSecret(env),
    expectedPrincipal: resolveExpectedPrincipal(env),
  };
  const caller = authenticateReconciliationCaller(readRequestHeader(request.headers), config);
  if (caller === null) {
    // Một câu trả lời duy nhất cho thiếu/sai/loại sai method — không tiết lộ route tồn tại.
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const report: JobReconciliationReport = await runJobReconciliation(
      {
        jobs: new D1JobStateRepository({ db: env['push-job'] }),
        queue: env.QUEUE,
        clock,
        metrics: createMetrics({ service: 'web-push-notification-job' }),
        logger: createLogger({
          service: 'web-push-notification-job',
          environment: resolveEnvironment(env),
          level: resolveLogLevel(env),
        }),
      },
      {
        stuckAfterMs: RECONCILE_STUCK_AFTER_MS,
        limit: RECONCILE_LIMIT,
        maxAttempts: RECONCILE_MAX_ATTEMPTS,
      },
    );
    return new Response(JSON.stringify(report), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    // Sweep fail không được là endpoint fail kiểu 500 im lặng: log ở mức `error` với **lý do
    // đã phân loại**, và trả `503` để trigger (khi chốt) biết là phải thử lại chứ không phải
    // coi là xong.
    createLogger({
      service: 'web-push-notification-job',
      environment: resolveEnvironment(env),
      level: resolveLogLevel(env),
    }).log('error', 'reconcile.sweep_failed', {
      error_kind:
        error instanceof RuntimeAuthResolutionError
          ? 'auth_resolution'
          : error instanceof RuntimeContractError
            ? 'contract'
            : 'unknown',
    });
    return new Response('Service Unavailable', { status: 503 });
  }
}

/**
 * Resolve secret của endpoint reconciliation — **fail-closed**.
 *
 * ⚠️ Dùng **cùng** tên biến với private API (`RUNTIME_API_SHARED_SECRET`) là một quyết định
 * có chủ đích của tầng này: endpoint reconciliation là **operator surface của chính worker**
 * trong cùng Cloudflare account, và nó không nhận traffic từ Internet. Thêm một secret thứ hai
 * sẽ là một bản sao cấu hình phải xoay vòng hai lần cho cùng một trust domain — mà không thêm
 * biên bảo vệ nào (Cloudflare không phân biệt binding với Internet, §6.1).
 */
function resolveReconcileSharedSecret(env: Readonly<Record<string, unknown>>): string {
  const value = env['RUNTIME_API_SHARED_SECRET'];
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    // Ném đúng lớp lỗi mà `runtime-control-plane.ts` dùng: cùng một nguyên nhân ("thiếu cấu
    // hình secret") phải đi vào cùng một nhánh chẩn đoán, không phải một lớp lỗi thứ tư.
    throw new RuntimeAuthResolutionError(
      'Thieu Worker Secret RUNTIME_API_SHARED_SECRET cho endpoint reconciliation.',
    );
  }
  return value;
}

function resolveExpectedPrincipal(env: Readonly<Record<string, unknown>>): string {
  const value = env['RUNTIME_API_EXPECTED_PRINCIPAL'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeAuthResolutionError(
      'Thieu RUNTIME_API_EXPECTED_PRINCIPAL cho endpoint reconciliation.',
    );
  }
  return value;
}

/** Principal mà operator/trigger dùng — chỉ là **giá trị mặc định** khi env không đặt. */

function resolveEnvironment(env: Readonly<Record<string, unknown>>): string {
  const value = env['ENVIRONMENT'];
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

/* -------------------------------------------------------------------------------------- */
/* Worker entrypoint                                                                          */
/* -------------------------------------------------------------------------------------- */

/**
 * `fetch` của Worker — `404` cho mọi thứ, trừ `POST /internal/reconcile/jobs`.
 *
 * ⚠️ Không có route `GET /`, không có healthcheck, không có metrics endpoint. Invariant 1 §19:
 * worker không có application API; một route "xem qua cho dễ" là một bề mặt tấn công mà không
 * có use case nào đứng sau nó.
 *
 * ⚠️ So khớp route bằng **phân đoạn path**, không bằng `startsWith`: `/internal/reconcile/jobsx`
 * phải là `404`, không phải một lần sweep. Và thứ tự là `method` → `path` → auth: một `GET`
 * vào đúng path đó không được chạy sweep chỉ vì không xác thực.
 */
export async function handleFetch(env: JobWorkerEnv, request: Request): Promise<Response> {
  if (request.method === 'POST') {
    const url = new URL(request.url);
    if (url.pathname === '/internal/reconcile/jobs') {
      return handleReconcileRequest(env, request);
    }
  }
  return new Response('Not Found', { status: 404 });
}

/** `queue` của platform — adapter mỏng giữa `MessageBatch` và {@link handleQueueBatch}. */
export const queue = {
  /**
   * ⚠️ **Cố ý dùng `fetch` làm tên method** — không phải `consume`, không phải `handle`: đây
   * chính là hình dạng hợp đồng mà platform `queue()` gọi, và `queue` được export **riêng** (không
   * chỉ nằm trong default export) là để queue consumer của một Worker được đăng ký như một
   * consumer bình thường. Vì tên member trùng tên export named, linter cấm đọc nó qua
   * `defaultWorker.queue` (`import/no-named-as-default-member`) — hãy import `queue` named ở nơi
   * chỉ cần consumer, và chỉ đọc `defaultWorker.queue` khi cần **chứng minh** rằng default
   * export mang đúng object đó (test `worker entrypoint contract` làm việc này, kèm một
   * chỉ dẫn cục bộ).
   */
  async fetch(...args: readonly unknown[]): Promise<void> {
    // Hình dạng thật của platform là `queue(batch, env, ctx)`; tham số được khai ở dưới bằng
    // kiểu cụ thể, hàm này chỉ là chỗ gom để `handleQueueBatch` không phải biết về platform.
    const [batch, env] = args as [PlatformMessageBatch, JobWorkerEnv];
    await handleQueueBatch(env, batch);
  },
};

/**
 * Contract của deployment — **một object**, không phải `export default app`.
 *
 * ⚠️ Worker này có **hai** entrypoint (`queue` + `fetch`) và không có `scheduled`. Object thay
 * vì default export là để contract deployment đọc được đủ: thiếu một entrypoint là một
 * `undefined` ở đây thay vì một Worker deploy chạy nhưng không bao giờ nhận message.
 */
export default { queue, fetch: handleFetch };
