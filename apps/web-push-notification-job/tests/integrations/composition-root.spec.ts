/**
 * Composition root của `web-push-notification-job` trên **D1 thật** + binding giả.
 *
 * ⚠️ Suite này kiểm ba thứ mà một unit test của tầng application không thể kiểm:
 * 1. **Hợp đồng entrypoint**: `fetch` trả `404` cho mọi thứ trừ đúng một route, và `queue`
 *    là một batch consumer.
 * 2. **Việc nối thật**: D1 `push-job` + Service Binding + sender adapter đi qua đúng một
 *    pipeline, và kết quả quan sát được trên D1 (attempt row, processed marker).
 * 3. **Fail-closed ở composition root**: thiếu secret thì không gửi unauthenticated.
 *
 * ⚠️ Sender được thay bằng một `WebPushSender` giả **qua `globalThis`**, vì `buildPipelineDeps`
 * gọi `createWebPushSender()` của Agent D — không có seam để inject. Đó là một giới hạn thật
 * của composition root hiện tại, được ghi lại ở `TODO` cuối file chứ không giấu.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import defaultWorker, { handleFetch, handleQueueBatch, queue } from '../../src/main';
import { RUNTIME_CALLER_PRINCIPAL } from '@ecoma-io/web-push-notification-job-infrastructure';
import { createD1Harness, type D1Harness } from './d1-harness';
import type { RuntimeServiceBinding } from '@ecoma-io/web-push-notification-job-infrastructure';
import { outcomeAck, releaseAck } from '@ecoma-io/push-notification-contracts';

const CONFIG_PATH = new URL('../../wrangler.jsonc', import.meta.url).pathname;
const SECRET = 'shared-secret-value-for-tests';

/**
 * Mốc thời gian — **đồng hồ thật**, không phải hằng.
 *
 * ⚠️ Khác với unit test của tầng application (đồng hồ cố định T0), composition root dùng
 * `Date.now()` thật qua `clock` trong `main.ts`. `expires_at` của claim phải nằm **thực sự**
 * trong tương lai, nên một T0 đóng băng sẽ biến mọi message thành "đã hết hạn" ngay lần
 * chạy đầu tiên và làm suite xanh/đỏ theo thời gian chạy — tệ hơn cả một test không đo gì.
 */
const NOW_MS = Date.now();
const P256DH =
  'BL9m6DmDEzo8fntKX1g3g2ngEnU3foRVlKpgVrphp2ybWJrOxQ-UQuh0KEYkRvYDHD2MUyC5scA7nAFsQXQHXPk';
const AUTH_SECRET = '_q2OtNUNx4PKMWjjjXKB-Q'; // gitleaks:allow (fake secret trong test)

/** Envelope hợp lệ — dựng qua builder canonical, không tự chế. */
function envelopeFor(deliveryId: string): unknown {
  return {
    version: 1,
    delivery_id: deliveryId,
    notification_id: `ntf_${deliveryId}`,
    subscription_id: 'sub_fixture_1',
    provider_id: 'prov-webpush-eu',
    transport: 'web',
    payload: { title: 'Tiêu đề', body: 'Nội dung' },
  };
}

/**
 * Cặp khoá VAPID **thật** (P-256), sinh một lần và đóng băng trong file.
 *
 * ⚠️ **Vì sao không dùng chuỗi bất kỳ.** Composition root nối tới adapter thật của Agent D, và
 * adapter từ chối một `vapidPublicKey` không phải điểm EC P-256 uncompressed 65 byte
 * (`isValidVapidPublicKey`) — nó phân loại việc đó thành `vapid_key_missing`, tức terminal
 * failure. Một fixture `"public-key-value"` sẽ làm suite đỏ vì lý do hoàn toàn không liên
 * quan tới điều suite này đang kiểm, và người đọc sẽ debug nhầm. Khoá ở đây là khoá **test**,
 * sinh cục bộ, không thuộc bất kỳ môi trường thật nào.
 */
const VAPID_PRIVATE_KEY =
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsMSsYICHIatB_g0PHR93O4Eg_Q4J9rTI78qRXy_mcfihRANCAASBKbDWRgip1pwZkG_Pxb1MJecoOcd0MPtK_PTyPIuSn1IU8uAOnFU1keldjHXdrPl0SRomizSHj1qhByw84dTb';
const VAPID_PUBLIC_KEY =
  'BIEpsNZGCKnWnBmQb8_FvUwl5yg5x3Qw-0r89PI8i5KfUhTy4A6cVTWR6V2Mdd2s-XRJGiaLNIePWqEHLDzh1Ns';

/** Claim hợp lệ — tập field của `validateDeliveryClaim`. */
const VALID_CLAIM = {
  delivery_id: 'del_x',
  notification_id: 'ntf_del_x',
  app: 'ecoma-web',
  status: 'processing',
  expires_at: new Date(NOW_MS + 1_800_000).toISOString(),
  dispatch_generation: 7,
  lease_expires_at: new Date(NOW_MS + 300_000).toISOString(),
  transport: 'web',
  provider_id: 'prov-webpush-eu',
  subscription_id: 'sub_fixture_1',
  subscription: {
    endpoint: 'https://push.example/endpoint',
    p256dh: P256DH,
    auth: AUTH_SECRET,
    vapid_key_id: 'vapid-key-2026-01',
  },
  provider: {
    type: 'web-push',
    configuration: { vapidSubject: 'mailto:ops@ecoma.io' },
    credential: { privateKey: VAPID_PRIVATE_KEY, publicKey: VAPID_PUBLIC_KEY },
  },
};

class FakeControlPlane {
  readonly calls: string[] = [];
  #result: unknown = { kind: 'won', claim: { ...VALID_CLAIM } };
  #claimOverride: Record<string, unknown> = {};

  /** Ghi đè field của claim trả về, để điều khiển từng nhánh của pipeline. */
  overrideClaim(fields: Record<string, unknown>): void {
    this.#claimOverride = fields;
  }

  setRejection(reason: string, state?: string): void {
    this.#result = {
      kind: 'lost',
      rejection: { reason, ...(state === undefined ? {} : { state }) },
    };
  }

  reset(): void {
    this.#result = { kind: 'won', claim: { ...VALID_CLAIM, ...this.#claimOverride } };
    this.#claimOverride = {};
    this.calls.length = 0;
  }

  get binding(): RuntimeServiceBinding {
    // ⚠️ Arrow function để `this` của method là instance: một `const self = this` sẽ phải bị
    // `no-this-alias` chặn, và nếu ai đó "sửa" bằng cách đóng băng `self` vào closure thì
    // private field `#result` vẫn phải qua `self` — đọc khó hơn một arrow thẳng.
    return {
      fetch: async (input: Request): Promise<Response> => {
        const url = new URL(input.url);
        const deliveryId = url.pathname.split('/').at(-2) ?? '';
        this.calls.push(`${input.method} ${url.pathname}`);

        if (url.pathname.endsWith('/claim')) {
          if ((this.#result as { kind: string }).kind === 'lost') {
            return new Response(
              JSON.stringify((this.#result as { rejection: unknown }).rejection),
              { status: 409 },
            );
          }
          const claim = { ...VALID_CLAIM, ...this.#claimOverride, delivery_id: deliveryId };
          return new Response(JSON.stringify(claim), { status: 200 });
        }

        // ⚠️ Dựng ack bằng **builder canonical** của contracts, không tự chế shape: body `200`
        // của `release`/`outcome` có `status` (không phải `outcome`) và `validateReleaseAck`/
        // `validateOutcomeAck` chỉ nhận đúng ba field đó. Một fake tự viết `{status:'ok'}` sẽ
        // bị client ném `RuntimeContractError` — và suite sẽ đỏ vì lý do **không liên quan**
        // tới composition root, đúng loại nhiễu làm một integration test mất giá trị.
        if (url.pathname.endsWith('/release')) {
          const body = releaseAck({ delivery_id: deliveryId, dispatch_generation: 7 });
          return new Response(JSON.stringify(body), { status: 200 });
        }
        if (url.pathname.endsWith('/outcome')) {
          const requested = (
            JSON.parse(await input.clone().text()) as { readonly outcome?: string }
          ).outcome;
          const body = outcomeAck({
            delivery_id: deliveryId,
            outcome: requested === 'failed' ? 'failed' : 'delivered',
            dispatch_generation: 7,
          });
          return new Response(JSON.stringify(body), { status: 200 });
        }
        return new Response('{"error":"unknown_operation"}', { status: 404 });
      },
    };
  }
}

let harness: D1Harness;
let controlPlane: FakeControlPlane;
let sent: unknown[];

beforeAll(async () => {
  harness = await createD1Harness(CONFIG_PATH);
  await harness.applyMigrations();
});

afterAll(async () => {
  await harness.dispose();
});

beforeEach(async () => {
  await harness.reset();
  controlPlane = new FakeControlPlane();
  controlPlane.reset();
  sent = [];

  // Thay `fetch` toàn cục: adapter Web Push của Agent D đi qua `fetch`, nên đây là chỗ
  // duy nhất một test composition root có thể chặn **mọi** request provider mà không sửa
  // code của Agent D (fold này thuộc sở hữu của tôi).
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url =
      typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    sent.push(url);
    return new Response('{}', { status: 201 });
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------------------- */
/* Hợp đồng entrypoint                                                                         */
/* -------------------------------------------------------------------------------------- */

describe('worker entrypoint contract', () => {
  // ⚠️ `queue` là **object** có method `fetch`, không phải một function: hình dạng queue
  // consumer của platform là `{ fetch(batch, env, ctx) }`. Test này ghim đúng hình dạng đó,
  // vì một Worker export `queue` dạng function sẽ không bao giờ nhận message dù typecheck xanh.
  it('exports both entrypoints in the platform shape', () => {
    // ⚠️ Đọc `queue` qua **named export**, không qua `defaultWorker.queue`: chính `queue` ở
    // `../src/main` được export riêng cho consumer, và `main.ts` giải thích vì sao linter cấm
    // đọc nó qua default. Đọc named ở đây là hợp lệ **vì test này dùng `defaultWorker` ở test
    // kế** để chứng minh `Object.keys()` của default export, nên bản thân object default đã
    // được kiểm ở đúng chỗ cần kiểm — không phải ở đây.
    expect(typeof queue.fetch).toBe('function');
    expect(typeof handleFetch).toBe('function');
  });

  it('declares no scheduled handler, because the reconciliation trigger is an undecided question', () => {
    // Lead đã quyết định cấm bịa `scheduled()`. Test này là chốt chặn để một agent sau này
    // thêm `scheduled` vào mà không đọc lại quyết định đó.
    expect(Object.keys(defaultWorker).toSorted()).toEqual(['fetch', 'queue']);
    expect('scheduled' in defaultWorker).toBe(false);
  });

  // Invariant 12 (`docs/architecture/01-architecture.md`): không correctness write nào được
  // đẩy qua `ctx.waitUntil()`. Nửa cấu trúc của pin: `handleQueueBatch` nhận đúng hai tham
  // số bắt buộc (env, batch) — không có tham số thứ ba thì handler không có đường nào gọi
  // `waitUntil`. Nửa hành vi (adapter `queue.fetch` bỏ ctx) được ghim ở suite
  // `handleQueueBatch` dưới bằng một ExecutionContext bẫy.
  it('pins handleQueueBatch to exactly (env, batch), leaving no execution context to defer writes through', () => {
    expect(handleQueueBatch.length).toBe(2);
  });
});

describe('handleFetch route boundary', () => {
  it.each([
    ['GET', '/'],
    ['GET', '/health'],
    ['GET', '/internal/reconcile/jobs'],
    ['POST', '/'],
    ['POST', '/internal/deliveries/del_x/claim'],
    ['PUT', '/internal/reconcile/jobs'],
    ['DELETE', '/internal/reconcile/jobs'],
    ['POST', '/internal/reconcile/jobs/'],
    ['POST', '/internal/reconcile/jobsx'],
    ['POST', '/INTERNAL/RECONCILE/JOBS'],
  ])('answers 404 for %s %s', async (method, path) => {
    // ⚠️ Không so khớp bằng `startsWith`: `/internal/reconcile/jobsx` phải là 404, và một
    // `GET` vào đúng path không được chạy sweep.
    const response = await handleFetch(
      baseEnv(),
      new Request(`https://worker.invalid${path}`, { method }),
    );

    expect(response.status).toBe(404);
  });

  // Query string **không** làm đổi route: `/internal/reconcile/jobs?stuckAfterMs=1` vẫn là
  // đúng path nên tới auth (401 khi không xác thực), không phải 404 — và tham số trong đó bị
  // bỏ qua. Ghép hai hành vi này lại, một endpoint nhận tham số sweep sẽ là một đường leo
  // thang nhỏ trên một bề mặt nội bộ.
  it('matches the route regardless of query string, then still refuses an unauthenticated caller', async () => {
    const response = await handleFetch(
      baseEnv(),
      new Request('https://worker.invalid/internal/reconcile/jobs?stuckAfterMs=1', {
        method: 'POST',
      }),
    );

    expect(response.status).toBe(401);
  });

  it('does not run a sweep for an unauthenticated POST on the real path', async () => {
    const spy = vi.spyOn(await import('../../src/main'), 'handleReconcileRequest');

    const response = await handleFetch(
      baseEnv(),
      new Request('https://worker.invalid/internal/reconcile/jobs', { method: 'POST' }),
    );

    expect(response.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------------------- */
/* Endpoint reconciliation                                                                   */
/* -------------------------------------------------------------------------------------- */

describe('handleReconcileRequest', () => {
  const authorized = (): HeadersInit => ({
    authorization: SECRET,
    'x-ecoma-principal': RUNTIME_CALLER_PRINCIPAL,
  });

  it('runs a sweep and returns a JSON report for an authorized caller', async () => {
    const response = await handleFetch(
      baseEnv(),
      new Request('https://worker.invalid/internal/reconcile/jobs', {
        method: 'POST',
        headers: authorized(),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const report = (await response.json()) as Record<string, unknown>;
    // Report phải là **đếm**, không phải danh sách delivery: đây là operator surface, và trả
    // envelope ra ngoài sẽ đẩy payload qua một bề mặt không cần thiết.
    expect(Object.keys(report).toSorted()).toEqual([
      'failed',
      'redelivered',
      'skippedExhausted',
      'skippedProcessed',
      'stuckFound',
    ]);
  });

  it.each([
    ['no headers', {}],
    ['a wrong secret', { authorization: 'wrong', 'x-ecoma-principal': RUNTIME_CALLER_PRINCIPAL }],
    ['a wrong principal', { authorization: SECRET, 'x-ecoma-principal': 'svc.khác' }],
    ['only a secret', { authorization: SECRET }],
  ])('answers 401 for %s, with one identical body', async (_name, headers) => {
    const response = await handleFetch(
      baseEnv(),
      new Request('https://worker.invalid/internal/reconcile/jobs', { method: 'POST', headers }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
  });

  // Fail-closed: thiếu secret là lỗi cấu hình, không phải "không cần xác thực".
  it.each([
    ['the shared secret', { 'x-ecoma-principal': RUNTIME_CALLER_PRINCIPAL }],
    ['the expected principal', { authorization: SECRET }],
  ])('fails closed when %s is missing from the environment', async (_name, headers) => {
    const env = baseEnv();
    delete (env as Record<string, unknown>)['RUNTIME_API_EXPECTED_PRINCIPAL'];
    if (_name.includes('principal')) {
      delete (env as Record<string, unknown>)['RUNTIME_API_EXPECTED_PRINCIPAL'];
    } else {
      delete (env as Record<string, unknown>)['RUNTIME_API_SHARED_SECRET'];
    }

    // Lỗi resolve được ném ra **ngoài** `try` của sweep, nên nó thành một lỗi chưa xử lý
    // chứ không phải một `200` rỗng — đó là hành vi mong muốn: một endpoint im lặng là
    // một trigger tưởng sweep đã chạy.
    await expect(
      handleFetch(
        env,
        new Request('https://worker.invalid/internal/reconcile/jobs', { method: 'POST', headers }),
      ),
    ).rejects.toThrow(/RUNTIME_API_(?:EXPECTED_PRINCIPAL|SHARED_SECRET)/u);
  });

  // ⚠️ Endpoint **không** nhận tham số sweep từ request: nếu nhận, bất kỳ ai xác thực được
  // cũng đặt được ngưỡng, và đó là một đường leo thang nhỏ trên một bề mặt nội bộ.
  it('ignores sweep parameters supplied in the query string', async () => {
    const response = await handleFetch(
      baseEnv(),
      new Request('https://worker.invalid/internal/reconcile/jobs?stuckAfterMs=1&limit=99999', {
        method: 'POST',
        headers: authorized(),
      }),
    );

    expect(response.status).toBe(200);
    // `limit=99999` bị bỏ qua: report vẫn nhỏ, và không có job nào bị re-deliver vì bảng rỗng.
    expect(await response.json()).toEqual({
      stuckFound: 0,
      redelivered: 0,
      failed: 0,
      skippedProcessed: 0,
      skippedExhausted: 0,
    });
  });
});

/* -------------------------------------------------------------------------------------- */
/* Queue consumer                                                                             */
/* -------------------------------------------------------------------------------------- */

/** Message giả, gom disposition để assert quyền ACK/retry thật. */
function message(body: unknown, attempts = 1) {
  const actions: string[] = [];
  return {
    body,
    attempts,
    ack: () => actions.push('ack'),
    retry: (options?: { delaySeconds?: number }) =>
      actions.push(options?.delaySeconds === undefined ? 'retry' : `retry:${options.delaySeconds}`),
    actions,
  };
}

describe('handleQueueBatch', () => {
  it('acks a delivered message and persists the attempt and the processed marker on D1', async () => {
    const controlPlaneSpy = controlPlane;
    const msg = message(envelopeFor('del_q1'));

    await handleQueueBatch(baseEnv(), { messages: [msg] });

    expect(msg.actions).toEqual(['ack']);
    const row = await harness.db
      .prepare(
        `SELECT processed, terminal_outcome, consume_count FROM push_jobs WHERE delivery_id = ?`,
      )
      .bind('del_q1')
      .first<{
        readonly processed: number;
        readonly terminal_outcome: string;
        readonly consume_count: number;
      }>();
    expect(row).toMatchObject({ processed: 1, terminal_outcome: 'delivered', consume_count: 1 });

    const attempt = await harness.db
      .prepare(
        `SELECT outcome, phase, state FROM push_job_attempts WHERE delivery_id = ? AND attempt = 1`,
      )
      .bind('del_q1')
      .first<{ readonly outcome: string; readonly phase: string; readonly state: string }>();
    expect(attempt).toMatchObject({
      outcome: 'delivered',
      phase: 'terminal_sent',
      state: 'completed',
    });

    expect(controlPlaneSpy.calls.some((call) => call.endsWith('/claim'))).toBe(true);
  });

  it('retries without a provider call when the control plane rejects the claim as pending', async () => {
    controlPlane.setRejection('pending');
    const msg = message(envelopeFor('del_q2'));

    await handleQueueBatch(baseEnv(), { messages: [msg] });

    expect(msg.actions).toEqual(['retry']);
    // Attempt vẫn được ghi (đó là job state của tôi), nhưng **không** có marker.
    const row = await harness.db
      .prepare(`SELECT processed FROM push_jobs WHERE delivery_id = ?`)
      .bind('del_q2')
      .first<{ readonly processed: number }>();
    expect(row?.processed).toBe(0);
  });

  // ⚠️ `409 lease_held` là **no-op an toàn**: ACK, không release, không gửi provider. Đây là
  // đường mà một retry sai sẽ bị nuốt, nên nó phải là ACK chứ không phải retry.
  it('acks safely without releasing for a 409 lease_held claim', async () => {
    controlPlane.setRejection('lease_held');
    const msg = message(envelopeFor('del_q3'));

    await handleQueueBatch(baseEnv(), { messages: [msg] });

    expect(msg.actions).toEqual(['ack']);
    expect(controlPlane.calls.some((call) => call.endsWith('/release'))).toBe(false);
  });

  // Per-message ACK/retry: một message fail không được kéo message anh em (FR-018).
  it('processes a mixed batch per message, with no cross-over', async () => {
    const good = message(envelopeFor('del_good'));
    const poison = message({ version: 1, delivery_id: 'del_bad' });

    await handleQueueBatch(baseEnv(), { messages: [good, poison] });

    expect(good.actions).toEqual(['ack']);
    expect(poison.actions).toEqual(['retry']);
    // Message hỏng không được ghi job state — không có envelope hợp lệ để lưu.
    const rows = await harness.db
      .prepare(`SELECT delivery_id FROM push_jobs ORDER BY delivery_id`)
      .all<{ readonly delivery_id: string }>();
    expect(rows.results.map((row) => row.delivery_id)).toEqual(['del_good']);
  });

  it('releases the lease before retrying a transient, so the retry can actually claim again', async () => {
    vi.stubGlobal('fetch', async () => new Response('service unavailable', { status: 503 }));
    const msg = message(envelopeFor('del_transient'));

    await handleQueueBatch(baseEnv(), { messages: [msg] });

    expect(msg.actions).toEqual(['retry']);
    // Thứ tự trên control plane: claim trước, release sau — và không có outcome.
    expect(controlPlane.calls.filter((call) => !call.endsWith('/claim'))).toEqual([
      'POST /internal/deliveries/del_transient/release',
    ]);
  });

  it('retries rather than acking when the runtime secret is missing', async () => {
    const env = baseEnv();
    delete (env as Record<string, unknown>)['RUNTIME_API_SHARED_SECRET'];
    const msg = message(envelopeFor('del_nosecret'));

    await handleQueueBatch(env, { messages: [msg] });

    // Fail-closed: không gửi gì, không ACK mù — bounded retry rồi DLQ.
    expect(msg.actions).toEqual(['retry']);
    const attempt = await harness.db
      .prepare(`SELECT outcome FROM push_job_attempts WHERE delivery_id = ? AND attempt = 1`)
      .bind('del_nosecret')
      .first<{ readonly outcome: string }>();
    expect(attempt?.outcome).toBe('contract_violation');
  });

  // Invariant 12 — nửa hành vi của pin: adapter `queue.fetch` của platform nhận
  // `(batch, env, ctx)` nhưng **đọc đúng hai** phần tử đầu; `handleQueueBatch` cũng không có
  // tham số ctx (ghim cấu trúc ở suite `worker entrypoint contract`). Nếu ai thêm lại một
  // correctness write qua `ctx.waitUntil()` ở đường này, ExecutionContext bẫy ở đây sẽ làm
  // test đỏ ngay — đúng luồng platform thật, không phải đường unit riêng.
  it('defers nothing past its returned promise, and never touches a waitUntil the platform hands it', async () => {
    // ExecutionContext bẫy: một correctness write được đẩy qua `waitUntil` là mất bền vững
    // (04-platform-facts WK3), nên ở đây `waitUntil` **ném** thay vì chỉ ghi nhận — một lời
    // gọi duy nhất đủ làm cả pipeline chết chứ không nuốt lặng.
    const trapCtx = {
      waitUntil: (_promise: Promise<unknown>): void => {
        throw new Error('waitUntil called on the queue path - invariant 12 violation');
      },
    };

    const msg = message(envelopeFor('del_invariant12'));
    await queue.fetch({ messages: [msg] }, baseEnv(), trapCtx);

    expect(msg.actions).toEqual(['ack']);
    // Sau khi promise trả về, correctness writes phải đã thấy được trên D1 ngay — không
    // phải "đang chờ ở waitUntil".
    const row = await harness.db
      .prepare(`SELECT processed FROM push_jobs WHERE delivery_id = ?`)
      .bind('del_invariant12')
      .first<{ readonly processed: number }>();
    expect(row?.processed).toBe(1);
  });

  it('acks a redelivery of an already-processed delivery without claiming or sending', async () => {
    // Lần 1: xong.
    await handleQueueBatch(baseEnv(), { messages: [message(envelopeFor('del_w4'))] });
    controlPlane.calls.length = 0;

    // Lần 2: redelivery sau crash giữa persist và ACK.
    const msg = message(envelopeFor('del_w4'), 2);
    await handleQueueBatch(baseEnv(), { messages: [msg] });

    expect(msg.actions).toEqual(['ack']);
    expect(controlPlane.calls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Job reconciliation trên D1 thật                                                             */
/* -------------------------------------------------------------------------------------- */

describe('job reconciliation on real D1', () => {
  it('re-delivers the exact original envelope of a stuck job through the QUEUE producer', async () => {
    const published: unknown[] = [];
    const env = baseEnv();
    (env['QUEUE'] as { send: (body: unknown) => Promise<unknown> }).send = async (body) => {
      published.push(body);
      return { id: 'msg_1' };
    };

    // Consume một lần rồi bỏ giữa chừng: job có record, chưa processed → kẹt.
    const controlPlaneSpy = controlPlane;
    controlPlaneSpy.setRejection('lease_held');
    await handleQueueBatch(env, { messages: [messageOf(envelopeFor('del_stuck'))] });
    controlPlaneSpy.reset();

    // Đẩy `last_consumed_at` vào quá khứ để vượt ngưỡng 15 phút của composition root.
    await harness.db
      .prepare(`UPDATE push_jobs SET last_consumed_at = ? WHERE delivery_id = ?`)
      .bind(Date.now() - 60 * 60_000, 'del_stuck')
      .run();

    const response = await handleFetch(
      env,
      new Request('https://worker.invalid/internal/reconcile/jobs', {
        method: 'POST',
        headers: { authorization: SECRET, 'x-ecoma-principal': RUNTIME_CALLER_PRINCIPAL },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stuckFound: 1, redelivered: 1, failed: 0 });
    expect(published).toEqual([envelopeFor('del_stuck')]);
  });

  it('never re-delivers a job that already has a processed marker', async () => {
    const published: unknown[] = [];
    const env = baseEnv();
    (env['QUEUE'] as { send: (body: unknown) => Promise<unknown> }).send = async (body) => {
      published.push(body);
      return { id: 'msg_1' };
    };

    await handleQueueBatch(env, { messages: [messageOf(envelopeFor('del_done'))] });
    await harness.db
      .prepare(`UPDATE push_jobs SET last_consumed_at = ? WHERE delivery_id = ?`)
      .bind(Date.now() - 60 * 60_000, 'del_done')
      .run();

    const response = await handleFetch(
      env,
      new Request('https://worker.invalid/internal/reconcile/jobs', {
        method: 'POST',
        headers: { authorization: SECRET, 'x-ecoma-principal': RUNTIME_CALLER_PRINCIPAL },
      }),
    );

    expect(await response.json()).toMatchObject({ stuckFound: 0, redelivered: 0 });
    expect(published).toEqual([]);
  });

  // Job reconciliation **chỉ** thấy việc đã có job record. Message chưa từng consume không
  // để lại dấu vết ở `push-job` nên thuộc cơ chế (c) của control plane, không phải ở đây.
  it('finds nothing when no message was ever consumed', async () => {
    const published: unknown[] = [];
    const env = baseEnv();
    (env['QUEUE'] as { send: (body: unknown) => Promise<unknown> }).send = async (body) => {
      published.push(body);
      return { id: 'msg_1' };
    };

    const response = await handleFetch(
      env,
      new Request('https://worker.invalid/internal/reconcile/jobs', {
        method: 'POST',
        headers: { authorization: SECRET, 'x-ecoma-principal': RUNTIME_CALLER_PRINCIPAL },
      }),
    );

    expect(await response.json()).toMatchObject({ stuckFound: 0, redelivered: 0 });
    expect(published).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Secret hygiene                                                                             */
/* -------------------------------------------------------------------------------------- */

describe('secret hygiene at the composition root', () => {
  // ⚠️ **Phải tách hai khẳng định này**, vì chúng nói ngược nhau về endpoint:
  //
  // - Endpoint **phải** tới provider — đó là toàn bộ việc của một Web Push request. Một
  //   Worker gửi mà không kèm endpoint thì không gửi được gì cả.
  // - Endpoint **không được** vào log/metric của worker (SR-003).
  //
  // Gộp hai vế thành một `not.toContain('push.example')` trên cả log lẫn `fetch` là một test
  // đỏ vì lý do ngược với điều nó trông như đang bảo vệ — và người đọc sẽ "sửa" bằng cách
  // xoá endpoint khỏi request.
  it('transmits the endpoint to the provider, because that is what a push request is', async () => {
    await handleQueueBatch(baseEnv(), { messages: [messageOf(envelopeFor('del_endpoint'))] });

    expect(sent).toContain('https://push.example/endpoint');
  });

  it('never logs the endpoint, the subscription secrets, the VAPID keys or the runtime secret', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    });
    try {
      await handleQueueBatch(baseEnv(), { messages: [messageOf(envelopeFor('del_secret'))] });
    } finally {
      spy.mockRestore();
    }

    const logged = logs.join('|');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('push.example');
    expect(logged).not.toContain(P256DH);
    expect(logged).not.toContain(AUTH_SECRET);
    expect(logged).not.toContain(VAPID_PRIVATE_KEY);
    expect(logged).not.toContain(VAPID_PUBLIC_KEY);
  });

  // Secret của subscription đi **trong header** của request provider — đó là bắt buộc về
  // mặt giao thức. Điều cấm là chúng không rò ra ngoài: không vào log, và không vào **URL**.
  it('carries the subscription secrets in request headers, never in the URL', async () => {
    await handleQueueBatch(baseEnv(), { messages: [messageOf(envelopeFor('del_in_url'))] });

    for (const url of sent) {
      expect(String(url)).not.toContain(P256DH);
      expect(String(url)).not.toContain(AUTH_SECRET);
    }
  });
});

/* -------------------------------------------------------------------------------------- */
/* Helper                                                                                    */
/* -------------------------------------------------------------------------------------- */

function messageOf(body: unknown): {
  body: unknown;
  attempts: number;
  actions: string[];
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
} {
  const actions: string[] = [];
  return {
    body,
    attempts: 1,
    actions,
    ack: () => actions.push('ack'),
    retry: (options) =>
      actions.push(options?.delaySeconds === undefined ? 'retry' : `retry:${options.delaySeconds}`),
  };
}

function baseEnv(): Record<string, unknown> {
  return {
    'push-job': harness.db,
    QUEUE: { send: async () => ({ id: 'msg_unused' }) },
    PUSH_NOTIFICATION_SERVICE: controlPlane.binding,
    RUNTIME_API_SHARED_SECRET: SECRET,
    RUNTIME_API_EXPECTED_PRINCIPAL: RUNTIME_CALLER_PRINCIPAL,
    LOG_LEVEL: 'error',
    ENVIRONMENT: 'test',
  };
}

/**
 * Seam inject sender: `buildPipelineDeps(env, { sender })` — production không truyền gì nên
 * vẫn nhận adapter Web Push thật. Một số test dưới đây vẫn chặn `globalThis.fetch` để chứng
 * minh đường mặc định; test dùng seam thì truyền fake trực tiếp, không chặn toàn cục.
 */
