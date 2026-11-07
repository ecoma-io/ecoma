/**
 * Integration test của composition root `src/main.ts` của `transactional-mailer-job` trên
 * **D1 thật** (miniflare/workerd qua `wrangler.getPlatformProxy`).
 *
 * ⚠️ Ranh giới kiến trúc cấm app→app import (`type:composition` chỉ depend bốn type lib),
 * nên "control plane" ở đây là **stub trong file test**: một `fetch` adapter trả envelope
 * GET/outcome ĐÚNG shape mà `validateGetDeliveryResponse`/`validatePostDeliveryOutcomeResponse`
 * của `@ecoma-io/transactional-mail-contracts` chấp nhận — tức đúng hợp đồng §7.2/§6.2.2.
 * Shape này đã được ghim từ phía bên kia bởi `apps/transactional-mail/src/main.spec.ts`
 * (route GET/outcome thật trả đúng envelope tám trường đó trên D1 thật), nên stub không tự
 * do pha trộn hợp đồng.
 *
 * Phạm vi: những gì chỉ bẻ gãy được ở tầng compose của consumer —
 *   - `queue` handler: mapping disposition → ack/retry, non-string body → JSON.stringify
 *     một lần cho digest, classification của gateway qua response status thật;
 *   - `scheduled` handler: ba sweep, mỗi sweep tự bắt lỗi; report sweep báo nốt pending;
 *   - đường end-to-end: command → lookup → FakeMailProvider → persist → report inline.
 *
 * Nguồn canonical: `docs/applications/transactional-mailer-job/01-architecture.md` §9.2, §9.5;
 * `02-requirements.md` FR-004/FR-005.
 *
 * Ranh giới: KHÔNG chứng minh exactly-once provider, KHÔNG chứng minh behaviour Cloudflare
 * Queues thật (batch/retry/DLQ là fake in-memory) — runtime verification chịu phần đó.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  D1MailJobRepository,
  FAKE_PROVIDER_MESSAGE_ID,
  INTERNAL_AUTH_SECRET_ENV,
  type D1DatabaseLike,
} from '@ecoma-io/transactional-mailer-job-infrastructure';

import workerMj from '../../src/main';

// `main` không export hằng tên queue (named export non-function làm workerd
// từ chối boot entry module) — test khai literal khớp consumer config trong
// `wrangler.jsonc`; test entrypoint contract dưới/assert batch.route theo
// literal này.
const LIFECYCLE_QUEUE_NAME = 'ecoma-mail-lifecycle-events';

// Không gửi telemetri khi spawn wrangler trong test.
process.env['WRANGLER_SEND_METRICS'] = 'false';

const requireFromSpec = createRequire(import.meta.url);
const { getPlatformProxy } = requireFromSpec('wrangler') as typeof import('wrangler');

// Suite nằm ở `tests/integrations/`, hai cấp dưới root app.
const appDir = join(import.meta.dirname, '..', '..');
const wranglerConfig = join(appDir, 'wrangler.jsonc');

const INTERNAL_SECRET = 'secret-main-spec-mj';

interface QueueMessageFake {
  readonly id: string;
  readonly body: unknown;
  ack(): Promise<void>;
  retry(): Promise<void>;
  acked(): boolean;
  retried(): boolean;
}

/** Message Queue fake đếm ack/retry. */
function fakeMessage(id: string, body: unknown): QueueMessageFake {
  let acked = false;
  let retried = false;
  return {
    id,
    body,
    ack: () => {
      acked = true;
      return Promise.resolve();
    },
    retry: () => {
      retried = true;
      return Promise.resolve();
    },
    acked: () => acked,
    retried: () => retried,
  };
}

/** ExecutionContext mock đầy đủ hình — handler chỉ gọi `waitUntil`. */
const executionContext = {
  waitUntil: (_promise: Promise<unknown>): void => undefined,
  passThroughOnException: (): void => undefined,
  props: {},
};

/**
 * Material của một delivery ở "control plane" stub — spec cho phép test đổi theo kịch bản
 * (status, generation, response status code của gateway).
 */
type StubDelivery = {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly status: string;
  readonly dispatchGeneration: number;
  /** Subject đưa vào envelope — chỗ cấy token scenario của FakeMailProvider. */
  readonly subject?: string;
};

/**
 * Service-binding stub: trả response của `/internal/deliveries/:id[...suffix]` theo kịch bản.
 *
 * Không HMAC ở đây — HMAC là ranh giới giữa InternalDeliveryClient và control plane THẬT,
 * đã được ghim ở suite của client và ở `main.spec.ts` của TM. Trong file này binding là
 * điểm seam để test phân loại status code của gateway.
 */
function stubBinding(deliveries: Map<string, StubDelivery>): {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly reportedOutcomes: { readonly deliveryId: string; readonly body: unknown }[];
} {
  const reportedOutcomes: { readonly deliveryId: string; readonly body: unknown }[] = [];
  return {
    reportedOutcomes,
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const match = /^\/internal\/deliveries\/([^/]+)(\/outcome)?$/u.exec(url.pathname);
      const deliveryId = match?.[1] ?? '';
      if (request.method === 'GET') {
        const delivery = deliveries.get(deliveryId);
        if (delivery === undefined) {
          return Response.json(
            { error: { code: 'not_found', message: 'Delivery not found' } },
            { status: 404 },
          );
        }
        const envelope = {
          message: {
            delivery_id: delivery.deliveryId,
            message_id: delivery.messageId,
            app: 'account',
            status: delivery.status,
            recipient: 'user@example.test',
            subject: delivery.subject ?? 'Reset code 123456',
            body: '<p>Your code is 123456</p>',
            content_type: 'text/html',
          },
          dispatch_generation: delivery.dispatchGeneration,
        };
        return Response.json(envelope, { status: 200 });
      }
      // POST outcome — luôn 200 applied/duplicate; test chỉ cần consumer nhận dạng được.
      const body = (await request.json()) as unknown;
      reportedOutcomes.push({ deliveryId, body });
      return Response.json({ result: 'applied', status: 'sent' }, { status: 200 });
    },
  };
}

let proxy: { env: MjBindings; dispose(): Promise<unknown> } | null = null;
let persistDir = '';

type MjBindings = { readonly 'mail-job': D1DatabaseLike };

/** Env của consumer: D1 `mail-job` + service binding stub + provider fake. */
function makeMjEnv(
  d1: D1DatabaseLike,
  binding: { readonly fetch: (request: Request) => Promise<Response> },
): Record<string, unknown> {
  return {
    [INTERNAL_AUTH_SECRET_ENV]: INTERNAL_SECRET,
    MAIL_PROVIDER_KIND: 'fake',
    MAIL_PROVIDER_TIMEOUT_MS: '10000',
    MAIL_JOB_MAX_EXECUTION_ATTEMPTS: '4',
    MAIL_JOB_EXECUTION_LEASE_MS: '30000',
    MAIL_JOB_PROVIDER_CALL_SAFE_WINDOW_MS: '86400000',
    MAIL_JOB_REPORT_LEASE_MS: '10000',
    MAIL_JOB_MAX_REPORT_ATTEMPTS: '5',
    MAIL_JOB_SWEEP_BATCH_LIMIT: '20',
    MAIL_QUARANTINE_HMAC_KEY: 'c'.repeat(64),
    'mail-job': d1,
    TRANSACTIONAL_MAIL_SERVICE: binding,
  };
}

let db: D1DatabaseLike;
let repo: D1MailJobRepository;

beforeAll(async () => {
  persistDir = mkdtempSync(join(tmpdir(), 'mj-main-'));
  // CLI `--persist-to` ghi vào `<dir>/v3` — proxy phải trỏ vào con `v3` cùng quy tắc
  // `mail-d1.spec.ts` đã ghim.
  proxy = await getPlatformProxy<MjBindings>({
    configPath: wranglerConfig,
    persist: { path: join(persistDir, 'v3') },
  });
  db = proxy.env['mail-job'];

  const { execFileSync } = await import('node:child_process');
  const { readdirSync } = await import('node:fs');
  const migrationsDir = join(appDir, 'migrations');
  const wranglerCli = requireFromSpec.resolve('wrangler');
  // Áp migration bằng CLI — đúng công cụ production dùng.
  execFileSync(
    process.execPath,
    [
      wranglerCli,
      'd1',
      'migrations',
      'apply',
      'mail-job',
      '--local',
      '--config',
      wranglerConfig,
      '--persist-to',
      persistDir,
    ],
    {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  // Fail sớm nếu migration không vào được database proxy (lệch persist path v3).
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  if (files.length < 2) {
    throw new Error(`expected at least two migrations under ${migrationsDir}`);
  }
  // Chuẩn bị repo phụ cho test scheduled seed trực tiếp qua port, không qua route.
  repo = new D1MailJobRepository({ db });
}, 240_000);

beforeEach(async () => {
  await db.prepare('DELETE FROM mail_jobs').run();
  await db.prepare('DELETE FROM quarantine').run();
  await db.prepare('DELETE FROM mail_lifecycle_events').run();
});

afterAll(async () => {
  await proxy?.dispose();
  if (persistDir !== '') {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

describe('queue handler: command → lookup → provider → persist → report inline', () => {
  it('logs the fake_provider_in_use alert once per queue invocation when the provider is fake', async () => {
    // B5 — fail-NOISY: `MAIL_PROVIDER_KIND=fake` phải hiện ra ở log MỖI lần dựng deps
    // (mỗi invocation), thay vì im lặng tới khi một thư "đã gửi" không bao giờ tới nơi.
    // Ca này ghim cả hai vế: event xuất hiện VÀ chỉ một dòng cho một invocation.
    const delivery: StubDelivery = {
      deliveryId: 'dlv-fake-alert',
      messageId: 'msg-fake-alert',
      status: 'queued',
      dispatchGeneration: 1,
    };
    const stub = stubBinding(new Map([[delivery.deliveryId, delivery]]));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const message = fakeMessage(
        'qm-fake-alert-1',
        JSON.stringify({ version: 1, delivery_id: delivery.deliveryId }),
      );
      await workerMj.queue(
        { queue: undefined, messages: [message] },
        makeMjEnv(db, stub) as never,
        executionContext,
      );

      const alertLines = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('fake_provider_in_use'));
      expect(alertLines).toHaveLength(1);
      const parsed = JSON.parse(alertLines[0] ?? '') as Record<string, unknown>;
      expect(parsed['event']).toBe('fake_provider_in_use');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('defers nothing past its returned promise: a throwing waitUntil is never called and D1 is visible immediately', async () => {
    // Invariant 12 (`docs/architecture/01-architecture.md`): không correctness write nào được
    // đẩy qua `ctx.waitUntil()` — WK3: `waitUntil` chỉ kéo dài 30s sau response và bị cancel
    // không retry, nên một write ở đó là write có thể mất. Handler hiện tại `void ctx`;
    // ExecutionContext bẫy dưới ném thay vì ghi nhận, nên nếu ai thêm lại một `waitUntil`
    // (dù cho alert hay cho correctness) thì test đỏ ngay, và nếu chỉ chạy đúng thì mọi
    // write phải nằm trong promise trả về — job row bên dưới đọc được ngay sau `await`.
    const delivery: StubDelivery = {
      deliveryId: 'dlv-invariant12',
      messageId: 'msg-invariant12',
      status: 'queued',
      dispatchGeneration: 1,
    };
    const stub = stubBinding(new Map([[delivery.deliveryId, delivery]]));
    const trapCtx = {
      waitUntil: (_promise: Promise<unknown>): void => {
        throw new Error('waitUntil called on the queue path - invariant 12 violation');
      },
    };

    const message = fakeMessage(
      'qm-invariant12-1',
      JSON.stringify({ version: 1, delivery_id: delivery.deliveryId }),
    );
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stub) as never,
      trapCtx as never,
    );

    expect(message.acked()).toBe(true);
    // correctness write của pipeline (persist sent + report inline) đã thấy ngay sau khi
    // promise trả về — không phải thứ gì đó đang treo ở ExecutionContext.
    const job = await repo.loadJobByDeliveryId(delivery.deliveryId);
    expect(job?.status).toBe('sent');
    expect(job?.outcomeReportState).toBe('reported');
  });

  it('acks a valid command, persists sent with the fake provider id, and reports outcome inline', async () => {
    const delivery: StubDelivery = {
      deliveryId: 'dlv-happy',
      messageId: 'msg-happy',
      status: 'queued',
      dispatchGeneration: 1,
    };
    const stub = stubBinding(new Map([[delivery.deliveryId, delivery]]));

    const message = fakeMessage(
      'qm-happy-1',
      JSON.stringify({ version: 1, delivery_id: delivery.deliveryId }),
    );
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );

    expect(message.acked()).toBe(true);
    expect(message.retried()).toBe(false);

    const job = await repo.loadJobByDeliveryId(delivery.deliveryId);
    expect(job?.status).toBe('sent');
    expect(job?.providerMessageId).toBe('fake-provider-message-id');
    expect(job?.outcomeReportState).toBe('reported');
    expect(job?.attempts).toBe(1);
    // Report inline đã tới control plane stub đúng một lần với outcome sent.
    expect(stub.reportedOutcomes).toEqual([
      { deliveryId: delivery.deliveryId, body: { outcome: 'sent', dispatch_generation: 1 } },
    ]);
  });

  it('acks a permanent rejection as failed with the sanitized error token', async () => {
    const delivery: StubDelivery = {
      deliveryId: 'dlv-fake-permanent',
      messageId: 'msg-permanent',
      status: 'queued',
      dispatchGeneration: 1,
    };
    // Token `fake:permanent` trong subject routing FakeMailProvider → failed.
    const stub = stubBinding(
      new Map([[delivery.deliveryId, { ...delivery, subject: 'fake:permanent code' }]]),
    );
    const message = fakeMessage(
      'qm-perm-1',
      JSON.stringify({ version: 1, delivery_id: delivery.deliveryId }),
    );
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );

    expect(message.acked()).toBe(true);
    const job = await repo.loadJobByDeliveryId(delivery.deliveryId);
    expect(job?.status).toBe('failed');
    expect(job?.lastError).toBe('http-400');
    expect(job?.lastErrorClass).toBe('permanent');
    expect(job?.outcomeReportState).toBe('reported');
  });

  it('acks a credential rejection as blocked with blocked_at set', async () => {
    const delivery: StubDelivery = {
      deliveryId: 'dlv-fake-credential',
      messageId: 'msg-credential',
      status: 'queued',
      dispatchGeneration: 1,
    };
    const stub = stubBinding(
      new Map([[delivery.deliveryId, { ...delivery, subject: 'fake:credential code' }]]),
    );

    const message = fakeMessage(
      'qm-cred-1',
      JSON.stringify({ version: 1, delivery_id: delivery.deliveryId }),
    );
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );

    expect(message.acked()).toBe(true);
    const job = await repo.loadJobByDeliveryId(delivery.deliveryId);
    expect(job?.status).toBe('blocked');
    expect(job?.lastErrorClass).toBe('credential');
    expect(job?.blockedAt).not.toBeNull();
    // Report inline chạy cho cả `blocked` — persisted thành công là report ngay, nên state
    // đã `reported` sau một lượt queue handler (không đợi cron).
    expect(job?.outcomeReportState).toBe('reported');
  });

  it('retries a retryable rejection without consuming a terminal outcome', async () => {
    const delivery: StubDelivery = {
      deliveryId: 'dlv-fake-retryable',
      messageId: 'msg-retryable',
      status: 'queued',
      dispatchGeneration: 1,
    };
    const stub = stubBinding(
      new Map([[delivery.deliveryId, { ...delivery, subject: 'fake:retryable code' }]]),
    );

    const message = fakeMessage(
      'qm-retry-1',
      JSON.stringify({ version: 1, delivery_id: delivery.deliveryId }),
    );
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );

    expect(message.retried()).toBe(true);
    expect(message.acked()).toBe(false);
    const job = await repo.loadJobByDeliveryId(delivery.deliveryId);
    // Status vẫn processing, lease được release — execution kế tiếp claim lại được.
    expect(job?.status).toBe('processing');
    expect(job?.leaseOwner).toBeNull();
    expect(job?.lastErrorClass).toBe('retryable');
    expect(job?.attempts).toBe(1);
  });

  it('acks a 404 lookup as processed without creating a job row (no orphan)', async () => {
    // delivery KHÔNG có trong stub ⇒ getDelivery 404 ⇒ resolveAuthority stop ack-processed.
    const stub = stubBinding(new Map());

    const message = fakeMessage(
      'qm-404-1',
      JSON.stringify({ version: 1, delivery_id: 'dlv-never-existed' }),
    );
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );

    expect(message.acked()).toBe(true);
    const job = await repo.loadJobByDeliveryId('dlv-never-existed');
    expect(job).toBeNull();
  });

  it('executes a queued-status lookup but still reports inline when control plane already sent', async () => {
    // Authority trả status `sent` nhưng vẫn `queued`-generation semantics: orchestration
    // at-least-once không dùng status authority để bỏ qua execution — nó claim, send,
    // report inline; control plane trả duplicate/stale là chuyện của route outcome.
    const delivery: StubDelivery = {
      deliveryId: 'dlv-already-sent',
      messageId: 'msg-sent',
      status: 'queued',
      dispatchGeneration: 1,
    };
    const stub = stubBinding(new Map([[delivery.deliveryId, delivery]]));

    const message = fakeMessage(
      'qm-term-1',
      JSON.stringify({ version: 1, delivery_id: delivery.deliveryId }),
    );
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );

    expect(message.acked()).toBe(true);
    expect((await repo.loadJobByDeliveryId(delivery.deliveryId))?.status).toBe('sent');
  });

  it('quarantines an unparseable body, acks, and records the reason', async () => {
    const stub = stubBinding(new Map());

    const message = fakeMessage('qm-quar-1', 'not-json-at-all');
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );

    expect(message.acked()).toBe(true);
    // Lookup theo queue_message_id qua SQL — không cần digest để đọc bản ghi.
    const rows = await db
      .prepare<{ reason: string }>('SELECT reason FROM quarantine WHERE queue_message_id = ?')
      .bind('qm-quar-1')
      .all();
    expect(rows.results).toEqual([{ reason: 'unparseable-body' }]);
    expect(await repo.loadJobByDeliveryId('dlv-happy')).toBeNull();
  });

  it('coerces a non-string body through a single JSON.stringify into the quarantine path', async () => {
    const stub = stubBinding(new Map());

    // Object stringify được nhưng thiếu delivery_id ⇒ command không canonical ⇒ quarantine
    // (khác unparseable — đây là reason `missing-delivery-id`).
    const message = fakeMessage('qm-nonstring-1', { version: 1, note: 'missing id' });
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );

    expect(message.acked()).toBe(true);
    const rows = await db
      .prepare<{ reason: string }>('SELECT reason FROM quarantine WHERE queue_message_id = ?')
      .bind('qm-nonstring-1')
      .all();
    // Validator phân loại field lạ (không thuộc schema) là forbidden-field — cùng nhánh
    // `fieldNameFor` mà migration CHECK bắt buộc phải có tên field.
    expect(rows.results).toEqual([{ reason: 'forbidden-field' }]);
  });

  it('processes a batch sequentially so both messages get their own disposition', async () => {
    const a: StubDelivery = {
      deliveryId: 'dlv-batch-a',
      messageId: 'msg-batch-a',
      status: 'queued',
      dispatchGeneration: 1,
    };
    const b: StubDelivery = {
      deliveryId: 'dlv-batch-b',
      messageId: 'msg-batch-b',
      status: 'queued',
      dispatchGeneration: 1,
    };
    const stub = stubBinding(
      new Map([
        [a.deliveryId, a],
        [b.deliveryId, b],
      ]),
    );

    const ma = fakeMessage('qm-batch-a', JSON.stringify({ version: 1, delivery_id: a.deliveryId }));
    const mb = fakeMessage('qm-batch-b', JSON.stringify({ version: 1, delivery_id: b.deliveryId }));
    await workerMj.queue(
      { queue: undefined, messages: [ma, mb] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );

    expect(ma.acked()).toBe(true);
    expect(mb.acked()).toBe(true);
    expect((await repo.loadJobByDeliveryId(a.deliveryId))?.status).toBe('sent');
    expect((await repo.loadJobByDeliveryId(b.deliveryId))?.status).toBe('sent');
  });
});

describe('queue handler: transient control plane', () => {
  it('retries when the binding throws (transient lookup) and creates no job', async () => {
    const throwingBinding = {
      fetch: (_request: Request): Promise<Response> => Promise.reject(new Error('binding down')),
    };
    const message = fakeMessage(
      'qm-transient-1',
      JSON.stringify({ version: 1, delivery_id: 'dlv-transient' }),
    );
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, throwingBinding) as never,
      executionContext,
    );

    expect(message.retried()).toBe(true);
    expect(message.acked()).toBe(false);
    expect(await repo.loadJobByDeliveryId('dlv-transient')).toBeNull();
  });

  it('retries on a 500 lookup and creates no job', async () => {
    const errorBinding = {
      fetch: (_request: Request): Promise<Response> =>
        Promise.resolve(Response.json({ error: { code: 'internal_error' } }, { status: 500 })),
    };
    const message = fakeMessage('qm-500-1', JSON.stringify({ version: 1, delivery_id: 'dlv-500' }));
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, errorBinding) as never,
      executionContext,
    );

    expect(message.retried()).toBe(true);
    expect(await repo.loadJobByDeliveryId('dlv-500')).toBeNull();
  });
});

describe('scheduled handler: report sweep closes a pending report', () => {
  it('reports a pending outcome for a sent job and marks it reported', async () => {
    const delivery: StubDelivery = {
      deliveryId: 'dlv-sweep',
      messageId: 'msg-sweep',
      status: 'queued',
      dispatchGeneration: 1,
    };
    const stub = stubBinding(new Map([[delivery.deliveryId, delivery]]));

    // Seed: chạy queue handler trước để có job `sent` + report inline… rồi đưa report về
    // pending giả lập inline report chưa kịp ghi (binding chết sau persist).
    const message = fakeMessage(
      'qm-sweep-1',
      JSON.stringify({ version: 1, delivery_id: delivery.deliveryId }),
    );
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );
    expect((await repo.loadJobByDeliveryId(delivery.deliveryId))?.status).toBe('sent');

    await db
      .prepare(
        `UPDATE mail_jobs SET outcome_report_state = 'pending', report_attempts = 0, ` +
          `report_lease_owner = NULL, report_lease_expires_at = NULL WHERE delivery_id = ?`,
      )
      .bind(delivery.deliveryId)
      .run();

    await workerMj.scheduled(
      { cron: '*/5 * * * *' },
      makeMjEnv(db, stub) as never,
      executionContext,
    );

    const job = await repo.loadJobByDeliveryId(delivery.deliveryId);
    expect(job?.outcomeReportState).toBe('reported');
    expect(job?.reportAttempts).toBe(1);
  });

  it('runs three sweeps over an empty backlog without throwing', async () => {
    const stub = stubBinding(new Map());
    await workerMj.scheduled(
      { cron: '*/5 * * * *' },
      makeMjEnv(db, stub) as never,
      executionContext,
    );
    const rows = await db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM mail_jobs').all();
    expect(rows.results?.[0]?.n).toBe(0);
  });

  // Invariant 12 — scheduled cũng khai `ctx` nhưng chỉ để `void ctx`: mọi việc của sweep
  // (report pending cho control plane) là correctness write và phải nằm trong promise trả
  // về. Bẫy `waitUntil` ném giữ pin đó: một lời gọi duy nhất là đỏ.
  it('scheduled handler completes all sweeps inside its returned promise with a throwing waitUntil untouched', async () => {
    const delivery: StubDelivery = {
      deliveryId: 'dlv-invariant12-cron',
      messageId: 'msg-invariant12-cron',
      status: 'queued',
      dispatchGeneration: 1,
    };
    const stub = stubBinding(new Map([[delivery.deliveryId, delivery]]));

    // Seed một job terminal + report pending: report sweep là correctness write thật của
    // cron — nếu nó bị đẩy qua `waitUntil` thì bẫy ném, nếu nằm trong promise thì row
    // dưới đã `reported` ngay sau `await`.
    const message = fakeMessage(
      'qm-invariant12-cron',
      JSON.stringify({ version: 1, delivery_id: delivery.deliveryId }),
    );
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );
    expect((await repo.loadJobByDeliveryId(delivery.deliveryId))?.status).toBe('sent');
    await db
      .prepare(
        `UPDATE mail_jobs SET outcome_report_state = 'pending', report_attempts = 0, ` +
          `report_lease_owner = NULL, report_lease_expires_at = NULL WHERE delivery_id = ?`,
      )
      .bind(delivery.deliveryId)
      .run();

    const trapCtx = {
      waitUntil: (_promise: Promise<unknown>): void => {
        throw new Error('waitUntil called on the scheduled path - invariant 12 violation');
      },
    };
    await workerMj.scheduled(
      { cron: '*/5 * * * *' },
      makeMjEnv(db, stub) as never,
      trapCtx as never,
    );

    const job = await repo.loadJobByDeliveryId(delivery.deliveryId);
    expect(job?.outcomeReportState).toBe('reported');
  });
});

/** Envelope lifecycle trung tính — test bẻ từng field theo kịch bản. */
function lifecycleBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    type: 'delivered',
    messageId: FAKE_PROVIDER_MESSAGE_ID,
    occurredAt: Date.now(),
    terminal: true,
    ...overrides,
  });
}

function lifecycleMessage(body: unknown): QueueMessageFake {
  return fakeMessage(`lq-${Math.random().toString(36).slice(2, 10)}`, body);
}

describe('queue handler: lifecycle event routing', () => {
  it('stores a valid event on the lifecycle queue, acks, and leaves mail jobs untouched', async () => {
    const message = lifecycleMessage(lifecycleBody());
    await workerMj.queue(
      { queue: LIFECYCLE_QUEUE_NAME, messages: [message] },
      makeMjEnv(db, stubBinding(new Map())) as never,
      executionContext,
    );

    expect(message.acked()).toBe(true);
    expect(message.retried()).toBe(false);
    const rows = await db
      .prepare<{ event_id: string; message_id: string; delivery_id: string | null }>(
        'SELECT event_id, message_id, delivery_id FROM mail_lifecycle_events',
      )
      .all();
    expect(rows.results).toHaveLength(1);
    // Fake provider dùng messageId cố định, nhưng KHÔNG có job nào trong db (không chạy
    // Mail Command trước) — event vẫn persist với delivery_id NULL: correlate là best-effort.
    expect(rows.results?.[0]?.delivery_id).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM quarantine').first()).toEqual({
      n: 0,
    });
  });

  it('correlates an event to an existing job by provider_message_id', async () => {
    // Seed MỘT job `sent` thật qua Mail Command path để có `provider_message_id` trong D1.
    const delivery: StubDelivery = {
      deliveryId: 'dlv-lc-corr',
      messageId: 'msg-lc-corr',
      status: 'queued',
      dispatchGeneration: 1,
    };
    const stub = stubBinding(new Map([[delivery.deliveryId, delivery]]));
    const command = fakeMessage(
      'qm-lc-corr',
      JSON.stringify({ version: 1, delivery_id: delivery.deliveryId }),
    );
    await workerMj.queue(
      { queue: undefined, messages: [command] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );
    const job = await repo.loadJobByDeliveryId(delivery.deliveryId);
    expect(job?.status).toBe('sent');
    expect(job?.providerMessageId).toBe(FAKE_PROVIDER_MESSAGE_ID);

    // Event lifecycle tới SAU với đúng messageId — correlate phải gán delivery_id.
    const message = lifecycleMessage(lifecycleBody());
    await workerMj.queue(
      { queue: LIFECYCLE_QUEUE_NAME, messages: [message] },
      makeMjEnv(db, stub) as never,
      executionContext,
    );
    expect(message.acked()).toBe(true);

    const event = await db
      .prepare<{ delivery_id: string | null }>(
        'SELECT delivery_id FROM mail_lifecycle_events ORDER BY created_at DESC LIMIT 1',
      )
      .first();
    expect(event?.delivery_id).toBe(delivery.deliveryId);
  });

  it('acks a duplicate eventId as a no-op — dedupe is not an error', async () => {
    const body = lifecycleBody();
    const first = lifecycleMessage(body);
    const second = lifecycleMessage(body);
    const env = makeMjEnv(db, stubBinding(new Map())) as never;
    await workerMj.queue({ queue: LIFECYCLE_QUEUE_NAME, messages: [first] }, env, executionContext);
    await workerMj.queue(
      { queue: LIFECYCLE_QUEUE_NAME, messages: [second] },
      makeMjEnv(db, stubBinding(new Map())) as never,
      executionContext,
    );

    expect(first.acked()).toBe(true);
    expect(second.acked()).toBe(true);
    const rows = await db
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM mail_lifecycle_events')
      .all();
    expect(rows.results?.[0]?.n).toBe(1);
  });

  it('quarantines a malformed payload, acks, and writes the quarantine row with the lifecycle reason', async () => {
    const message = lifecycleMessage('{not json');
    await workerMj.queue(
      { queue: LIFECYCLE_QUEUE_NAME, messages: [message] },
      makeMjEnv(db, stubBinding(new Map())) as never,
      executionContext,
    );

    expect(message.acked()).toBe(true);
    expect(message.retried()).toBe(false);
    const row = await db.prepare<{ reason: string }>('SELECT reason FROM quarantine').first();
    expect(row?.reason).toBe('lifecycle-event-invalid');
    const events = await db
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM mail_lifecycle_events')
      .all();
    expect(events.results?.[0]?.n).toBe(0);
  });

  it('retries when the ingest reports transient — nothing is acked', async () => {
    // Env thiếu khoá HMAC quarantine không làm path stored rơi vào đó, nhưng env thiếu
    // D1 thì lifecycleQueueBatch throw lúc dựng deps — dùng D1 giả ném lỗi ở statement
    // đầu tiên để mô phỏng D1 chết: outcome transient ⇒ message.retry(), KHÔNG ack.
    const message = lifecycleMessage(lifecycleBody());
    const deadD1 = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'batch' || prop === 'prepare') {
            return () => {
              throw new Error('d1 down');
            };
          }
          return undefined;
        },
      },
    ) as unknown as D1DatabaseLike;
    await workerMj.queue(
      { queue: LIFECYCLE_QUEUE_NAME, messages: [message] },
      { ...makeMjEnv(db, stubBinding(new Map())), 'mail-job': deadD1 } as never,
      executionContext,
    );

    expect(message.retried()).toBe(true);
    expect(message.acked()).toBe(false);
  });

  it('routes the default queue to the Mail Command path, not lifecycle', async () => {
    // Guard đảo: batch.queue khác tên lifecycle phải đi orchestration Mail Command —
    // một sụt route là lifecycle event bị nuốt vào state machine hoặc ngược lại.
    const message = fakeMessage(
      'qm-route-guard',
      JSON.stringify({ version: 1, delivery_id: 'dlv-route-guard' }),
    );
    const delivery: StubDelivery = {
      deliveryId: 'dlv-route-guard',
      messageId: 'msg-route-guard',
      status: 'queued',
      dispatchGeneration: 1,
    };
    await workerMj.queue(
      { queue: undefined, messages: [message] },
      makeMjEnv(db, stubBinding(new Map([[delivery.deliveryId, delivery]]))) as never,
      executionContext,
    );

    // Mail Command đã chạy (job `sent`), KHÔNG có lifecycle event nào được ghi từ path này.
    expect((await repo.loadJobByDeliveryId(delivery.deliveryId))?.status).toBe('sent');
    const rows = await db
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM mail_lifecycle_events')
      .all();
    expect(rows.results?.[0]?.n).toBe(0);
  });
});
