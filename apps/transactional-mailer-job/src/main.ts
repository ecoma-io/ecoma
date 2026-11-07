/**
 * `transactional-mailer-job` — Queue consumer của mail bounded context.
 *
 * Ba đường kích hoạt, không có HTTP route nào:
 *   - `queue` — Mail Command `{version: 1, delivery_id}` từ `ecoma-mail-delivery`;
 *     một message một lần `processMailCommand`, disposition quyết định ack/retry.
 *   - `scheduled` — ba sweep (stale execution lease, pending report, blocked backlog),
 *     chỉ alert + báo nốt outcome, không claim execution.
 *
 * KHÔNG có `fetch` export: worker này không expose HTTP (wrangler.jsonc không có route);
 * Hono không được dùng ở đây — một HTTP surface là một ranh giới mới cần auth, và mọi
 * endpoint của nó đều chưa được định nghĩa trong tài liệu.
 */

import {
  type MailCommandOutcome,
  type ProcessMailCommandDeps,
  processMailCommand,
  ingestLifecycleEventMessage,
  computeQuarantineId,
  encodeUtf8,
  runBlockedBacklogSweep,
  runReportSweep,
  runStaleLeaseSweep,
  type ReportSweepAlert,
} from '@ecoma-io/transactional-mailer-job-application';
import {
  createCloudflareMailProvider,
  createGateway,
  createResendMailProvider,
  D1LifecycleEventStore,
  D1MailJobRepository,
  D1QuarantineRepository,
  FakeMailProvider,
  InternalDeliveryClient,
  resolveInternalAuthSecret,
  type D1DatabaseLike,
  type SendEmailBindingLike,
} from '@ecoma-io/transactional-mailer-job-infrastructure';

import {
  loadMailerJobConfig,
  type LoadedMailerJobConfig,
  type MailerJobEnv,
  SEND_EMAIL_BINDING_NAME,
} from './config';

/**
 * D1 `mail-job` binding ở đúng subset mà repository nhận — cast tường minh qua `unknown`,
 * cùng lý do với `mailDb` của control plane: tương thích subset↔`D1Database` được ghim ở
 * spec của infrastructure, không chứng minh lại tại call site.
 */
function jobDb(env: MailerJobEnv): D1DatabaseLike {
  return env['mail-job'] as unknown as D1DatabaseLike;
}

/** Service Binding sang control plane — chỉ cần `fetch`. */
interface ServiceBindingLike {
  fetch(request: Request): Promise<Response>;
}

function serviceBinding(env: MailerJobEnv): ServiceBindingLike {
  return env['TRANSACTIONAL_MAIL_SERVICE'] as unknown as ServiceBindingLike;
}

/** Ghi một dòng alert JSON — chỉ token đã sanitize, không recipient/raw error. */
function logAlert(event: Record<string, unknown>): void {
  try {
    // oxlint-disable-next-line no-console
    console.log(JSON.stringify(event));
  } catch {
    // Cố tình im lặng — observability không được nằm trên serving path.
  }
}

/** Adapter alert của sweep sang logger JSON một dòng. */
function reportSweepAlert(alert: ReportSweepAlert): void {
  logAlert({ event: 'report_sweep_alert', ...alert });
}

/* -------------------------------------------------------------------------------------------- */
/* Deps dựng mỗi lần chạy                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** Deps của queue handler — dựng mỗi lần chạy, không giữ qua hai invocation. */
function queueDeps(env: MailerJobEnv, config: LoadedMailerJobConfig): ProcessMailCommandDeps {
  const secret = resolveInternalAuthSecret(env);
  const client = new InternalDeliveryClient({
    binding: serviceBinding(env),
    secret,
  });
  const provider =
    config.provider.kind === 'cloudflare'
      ? createCloudflareMailProvider({
          // Binding đã được loader kiểm tra hình dạng; cast tường minh qua `unknown`
          // sang subset mà adapter khai — tương thích subset được ghim ở spec adapter.
          binding: env[SEND_EMAIL_BINDING_NAME] as unknown as SendEmailBindingLike,
          sender: config.provider.cloudflare.sender,
          timeoutMs: config.provider.cloudflare.timeoutMs,
        })
      : config.provider.kind === 'resend'
        ? createResendMailProvider({
            endpoint: config.provider.resend.endpoint,
            token: config.provider.resend.token,
            from: config.provider.resend.from,
            timeoutMs: config.provider.resend.timeoutMs,
          })
        : new FakeMailProvider();
  // B5 — fail-NOISY cho fake provider: không mail thật nào được gửi khi `MAIL_PROVIDER_KIND
  // = fake`, và việc đó phải hiện ra ở log mỗi lần dựng deps (mỗi invocation) thay vì im
  // lặng tới khi một thư "đã gửi" không bao giờ tới nơi. Event là hằng cố định, không mang
  // endpoint/token — chỉ trạng thái cấu hình.
  if (config.provider.kind === 'fake') {
    logAlert({ event: 'fake_provider_in_use' });
  }
  // Trả object literal (không phải biến `deps`): rule `security-sensitive-value-in-http-response`
  // loại `return {...}` khỏi nhánh sink giá trị-trần, nên hình dạng này là ranh giới đã ghim —
  // gói `deps` vào biến rồi `return deps` thì taint từ `…resend.token` lan qua biến và sink khớp.
  return {
    jobs: new D1MailJobRepository({ db: jobDb(env) }),
    quarantine: new D1QuarantineRepository({ db: jobDb(env) }),
    gateway: createGateway(client),
    provider,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Lifecycle event ingest — Queue consumer thứ hai (§11.3)                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * Tên Queue lifecycle event mà worker consume (convention-derived từ
 * `ecoma-mail-delivery` → `ecoma-mail-lifecycle-events`; §9 bảng convention).
 *
 * Event Subscriptions của Cloudflare Email Service publish lifecycle event vào Queue;
 * provision subscription thật KHÔNG nằm trong phạm vi implementation này — queue chưa
 * có ở môi trường thật thì consumer chỉ không nhận message nào, mọi path khác vô hại.
 *
 * KHÔNG export: workerd coi MỌI named export của entry module là map entry
 * `function | ExportedHandler` — một string export làm runtime từ chối boot
 * cả Worker ("Incorrect type for map entry", đo được trong E2E local runtime
 * 2026-10-24). Test cùng package đọc tên queue qua literal riêng.
 */
const LIFECYCLE_QUEUE_NAME = 'ecoma-mail-lifecycle-events' as const;

/**
 * Xử lý một batch lifecycle event — MỘT message một lần ingest, per-message ack/retry.
 *
 * Disposition từ `ingestLifecycleEventMessage`:
 * - `stored`/`duplicate` → ack: duplicate là dedupe hoạt động đúng, không phải lỗi;
 * - `quarantined` → ack kèm row quarantine (payload hỏng không bao giờ retry được —
 *   cùng bảng `quarantine` với Mail Command nhưng reason riêng);
 * - `transient` → retry: chưa có gì bền vững, Queue redelivery sẽ giao lại.
 *
 * Persist TRƯỚC ack nằm trong chính seam `store` — outcome `stored` chỉ trả sau khi
 * D1 đã xác nhận ghi, nên ack sau `stored` không bao giờ là mất event.
 */
async function lifecycleQueueBatch(
  messages: readonly {
    id: string;
    body: unknown;
    retry(): Promise<void>;
    ack(): Promise<void>;
  }[],
  env: MailerJobEnv,
): Promise<void> {
  const store = new D1LifecycleEventStore({ db: jobDb(env) });
  const quarantine = new D1QuarantineRepository({ db: jobDb(env) });

  for (const message of messages) {
    // Body phải là string — cùng quy tắc với Mail Command (digest băm đúng byte nhận
    // được); non-string được serialize MỘT lần đại diện trung thực cho những gì nhận.
    const rawBody = typeof message.body === 'string' ? message.body : JSON.stringify(message.body);

    const outcome = await ingestLifecycleEventMessage(rawBody, {
      store: (event) => store.store(event),
      nowMs: Date.now,
    });

    switch (outcome.kind) {
      case 'stored':
      case 'duplicate':
        await message.ack();
        break;
      case 'quarantined':
        await quarantine.upsertQuarantineRecord({
          // `quarantine_id` là HMAC của raw body — cùng `computeQuarantineId` với Mail
          // Command path, khoá là Worker Secret riêng của quarantine.
          quarantineId: await computeQuarantineId({
            keyHex: quarantineKeyHex(env),
            rawBody: encodeUtf8(rawBody),
          }),
          queueMessageId: message.id,
          reason: 'lifecycle-event-invalid',
          nowMs: Date.now(),
        });
        await message.ack();
        break;
      case 'transient':
        await message.retry();
        break;
    }
  }
}

/** Khoá HMAC quarantine (64 hex) — cùng biến với Mail Command path. */
function quarantineKeyHex(env: MailerJobEnv): string {
  const value = env['MAIL_QUARANTINE_HMAC_KEY'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('MAIL_QUARANTINE_HMAC_KEY chua duoc dat');
  }
  return value;
}

export default {
  /**
   * Queue consumer — MỘT message mỗi lần gọi (không `Promise.all` trên batch): orchestration
   * giữ lease/claim D1 theo delivery, chạy song song là hai execution tranh cùng row.
   *
   * Disposition của `processMailCommand` là toàn bộ hợp đồng với Queue runtime:
   * `ack-processed`/`quarantined`/`internal-blocked` → ack (không retry);
   * `retry` → `message.retry()` (chưa có gì bền vững để mất).
   *
   * Lỗi bất ngờ (port vi phạm hợp đồng, D1 chết trước khi orchestration phân loại được)
   * **throw** — để `max_retries` của Queue consumer và DLQ làm việc của nó, thay vì nuốt
   * thành ack: ack là tuyên bố "đã xử lý xong", mà chưa.
   */
  async queue(
    batch: {
      queue: string | undefined;
      messages: readonly {
        id: string;
        body: unknown;
        retry(): Promise<void>;
        ack(): Promise<void>;
      }[];
    },
    env: MailerJobEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    const config = loadMailerJobConfig(env);

    // Hai queue cùng handler: consumer config khai hai binding, Cloudflare gán
    // `batch.queue` theo tên queue của message. Lifecycle lifecycle event ingest là
    // đường độc lập với Mail Command — nó không claim lease, không gọi provider, không
    // đè state machine; chỉ persist + correlate rồi ack. Đường nào tự dựng deps riêng,
    // không dùng chung một object deps để taint-analysis của rule taint-value với
    // `resend.token` không phải lan qua object dùng chung hai đường.
    if (batch.queue === LIFECYCLE_QUEUE_NAME) {
      await lifecycleQueueBatch(batch.messages, env);
      return;
    }

    const deps = queueDeps(env, config);

    for (const message of batch.messages) {
      // Body contract: producer `QUEUE.send(string)`, nên body phải là string. Một body
      // không phải string là lệch producer/consumer version — orchestration tự quarantine
      // qua raw-body digest, nhưng nó cần string; đổi non-string thành string chuẩn hoá
      // KHÔNG được phép (digest phải băm đúng byte worker nhận được). Với non-string,
      // serialize một lần duy nhất để digest thấy đại diện trung thực của những gì nhận được.
      const rawBody =
        typeof message.body === 'string' ? message.body : JSON.stringify(message.body);

      let outcome: MailCommandOutcome;
      try {
        outcome = await processMailCommand(rawBody, message.id, deps, {
          executionLeaseMs: config.executionLeaseMs,
          maxExecutionAttempts: config.maxExecutionAttempts,
          providerTimeoutMs: config.providerTimeoutMs,
          providerCallSafeWindowMs: config.providerCallSafeWindowMs,
          reportLeaseMs: config.reportLeaseMs,
          owner: `exec_${crypto.randomUUID()}`,
          quarantineKeyHex: config.quarantineHmacKeyHex,
          nowMs: Date.now(),
        });
      } catch {
        // Lỗi ngoài phân loại của orchestration — để Queue retry theo `max_retries`.
        await message.retry();
        continue;
      }

      switch (outcome.kind) {
        case 'ack-processed':
        case 'quarantined':
        case 'internal-blocked':
          await message.ack();
          break;
        case 'retry':
          await message.retry();
          break;
      }
    }
    void ctx;
  },

  /**
   * Cron của worker — ba sweep, mỗi sweep một lần chạy, mỗi sweep tự biên lô.
   *
   * Thứ tự: report sweep chạy TRƯỚC hai sweep alert, vì nó là việc thật (báo nốt outcome
   * cho control plane), còn hai sweep kia chỉ phát tín hiệu vận hành. Mỗi sweep bắt lỗi
   * riêng — một sweep chết không cản sweep kia.
   */
  async scheduled(
    controller: { readonly cron: string },
    env: MailerJobEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    void controller;
    const config = loadMailerJobConfig(env);
    const secret = resolveInternalAuthSecret(env);
    const client = new InternalDeliveryClient({ binding: serviceBinding(env), secret });
    const jobs = new D1MailJobRepository({ db: jobDb(env) });
    const gateway = createGateway(client);
    const nowMs = Date.now();
    const sweepConfig = {
      owner: `sweep_${crypto.randomUUID()}`,
      nowMs,
      leaseMs: config.reportLeaseMs,
      maxReportAttempts: config.maxReportAttempts,
      batchLimit: config.sweepBatchLimit,
    } as const;

    // 1 — Report sweep: báo nốt outcome của row terminal chưa report xong.
    try {
      const summary = await runReportSweep(
        { jobs, gateway, logAlert: reportSweepAlert },
        sweepConfig,
      );
      logAlert({ event: 'scheduled_report_sweep', ...summary });
    } catch {
      logAlert({ event: 'scheduled_report_sweep_unexpected_error' });
    }

    // 2 — Stale execution lease: row `processing` quá lease — chỉ alert.
    try {
      const summary = await runStaleLeaseSweep(
        { jobs, gateway, logAlert: reportSweepAlert },
        sweepConfig,
      );
      logAlert({ event: 'scheduled_stale_lease_sweep', ...summary });
    } catch {
      logAlert({ event: 'scheduled_stale_lease_sweep_unexpected_error' });
    }

    // 3 — Blocked backlog: row `blocked` nằm quá ngưỡng — chỉ alert.
    try {
      const summary = await runBlockedBacklogSweep(
        { jobs, gateway, logAlert: reportSweepAlert },
        sweepConfig,
      );
      logAlert({ event: 'scheduled_blocked_backlog_sweep', ...summary });
    } catch {
      logAlert({ event: 'scheduled_blocked_backlog_sweep_unexpected_error' });
    }

    void ctx;
  },
};
