/**
 * Hợp đồng config staging của cặp worker mail (#355) — spec hợp đồng đọc
 * TRỰC TIẾP hai file `wrangler.jsonc` của app (tài sản review-able trong Git)
 * và đối chiếu với hằng tên tài nguyên của `staging-run.ts`. Đọc qua `node:fs`
 * chứ KHÔNG import xuyên project — hai file thuộc hai app, còn hợp đồng thuộc
 * bounded context mà deploy project này provision.
 *
 * Những bất biến được chốt ở đây:
 * 1. `env.staging` của MỖI app tồn tại, identity `stg-` + tên production
 *    (đúng derivation mà lane deploy staging dùng chung #535 preflight), và
 *    `workers_dev: false` — hai worker internal-only.
 * 2. Binding audit (02-delivery.md §9.1): Wrangler KHÔNG kế thừa binding
 *    top-level vào named environment, nên MỖI loại binding top-level khai
 *    phải được khai lại tường minh trong `env.staging` — audit là kiểm cấu
 *    trúc, không phải liệt kê tay.
 * 3. Chuỗi queue producer ↔ consumer ↔ DLQ ĐỒNG BỘ hai app với hằng
 *    `STAGING_QUEUE_NAMES` — provisioning tập trung ở `staging-program.ts`.
 * 4. `database_id` chưa khai (trạng thái "chưa provisioning" đúng §9.1) và
 *    KHÔNG có placeholder id nào trong cả hai file — wiring id thật là bước
 *    sau `staging-up` xanh đầu tiên, không điền id đoán.
 * 5. Consumer job trỏ service binding về worker staging của control plane,
 *    provider `cloudflare` khớp sender ghim của send_email (hai lớp chặn phải
 *    nói cùng một sự thật — loader fail-closed khi lệch).
 * 6. Cron staging kế thừa `triggers` top-level (Wrangler kế thừa key này) —
 *    cả hai app phải có nhịp khai ở top level.
 * 7. `env.production` CHƯA tồn tại ở M2 — khai sớm là vào matrix sai horizon.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STAGING_MAIL_DATABASE_NAME, STAGING_QUEUE_NAMES } from './staging-run.js';
import { parseJsonc } from './wrangler-jsonc.js';

/** Shape tối thiểu của một binding entry dùng trong audit — structural typing. */
interface D1Binding {
  binding: string;
  database_name: string;
  database_id?: string;
}
interface QueueProducerBinding {
  binding: string;
  queue: string;
}
interface QueueConsumerBinding {
  binding: string;
  queue: string;
  max_retries?: number;
  dead_letter_queue?: string;
}
interface ServiceBinding {
  binding: string;
  service: string;
}
interface SendEmailBinding {
  name: string;
  allowed_sender_addresses: string[];
}

interface WranglerConfig {
  name?: string;
  workers_dev?: boolean;
  triggers?: { crons?: string[] };
  d1_databases?: D1Binding[];
  queues?: {
    producers?: QueueProducerBinding[];
    consumers?: QueueConsumerBinding[];
  };
  services?: ServiceBinding[];
  send_email?: SendEmailBinding[];
  vars?: Record<string, string>;
  env?: Record<string, WranglerConfig>;
}

const APP_ROOT = join(import.meta.dirname, '..', '..', 'apps');

function loadWrangler(appDir: string): WranglerConfig {
  return parseJsonc<WranglerConfig>(readFileSync(join(APP_ROOT, appDir, 'wrangler.jsonc'), 'utf8'));
}

const mail = loadWrangler('transactional-mail');
const mailerJob = loadWrangler('transactional-mailer-job');

const STAGING_MAIL_PRODUCER_QUEUE = STAGING_QUEUE_NAMES[0] as string;
const DELIVERY_DLQ = STAGING_QUEUE_NAMES[1] as string;
const LIFECYCLE_QUEUE = STAGING_QUEUE_NAMES[2] as string;
const LIFECYCLE_DLQ = STAGING_QUEUE_NAMES[3] as string;

describe('env.staging identity', () => {
  it('both mail apps declare an env.staging derived as stg-<production name>', () => {
    for (const config of [mail, mailerJob]) {
      const staging = config.env?.staging;
      expect(staging, `env.staging of ${config.name ?? '(unknown)'}`).toBeDefined();
      expect(staging?.name).toBe(`stg-${config.name}`);
    }
    expect(mail.env?.staging?.name).toBe('stg-ecoma-transactional-mail');
    expect(mailerJob.env?.staging?.name).toBe('stg-ecoma-transactional-mailer-job');
  });

  it('both staging workers are internal-only (no workers.dev subdomain)', () => {
    expect(mail.env?.staging?.workers_dev).toBe(false);
    expect(mailerJob.env?.staging?.workers_dev).toBe(false);
  });

  it('no env.production exists at M2 — early declaration enters the wrong horizon', () => {
    expect(mail.env?.production).toBeUndefined();
    expect(mailerJob.env?.production).toBeUndefined();
  });
});

describe('binding audit — every top-level binding kind is re-declared in env.staging', () => {
  it('control plane re-declares d1 and queue producer bindings for its lane', () => {
    const topD1 = mail.d1_databases ?? [];
    const topProducers = mail.queues?.producers ?? [];
    const staging = mail.env?.staging;
    expect(topD1.length).toBeGreaterThan(0);
    expect(topProducers.length).toBeGreaterThan(0);
    expect(staging?.d1_databases ?? []).toHaveLength(topD1.length);
    expect(staging?.queues?.producers ?? []).toHaveLength(topProducers.length);
  });

  it('delivery job re-declares d1, queue consumers, services and send_email for its lane', () => {
    const topD1 = mailerJob.d1_databases ?? [];
    const topConsumers = mailerJob.queues?.consumers ?? [];
    const topServices = mailerJob.services ?? [];
    const topSendEmail = mailerJob.send_email ?? [];
    const staging = mailerJob.env?.staging;
    expect(topD1.length).toBeGreaterThan(0);
    expect(topConsumers.length).toBeGreaterThan(0);
    expect(topServices.length).toBeGreaterThan(0);
    expect(topSendEmail.length).toBeGreaterThan(0);
    expect(staging?.d1_databases ?? []).toHaveLength(topD1.length);
    expect(staging?.queues?.consumers ?? []).toHaveLength(topConsumers.length);
    expect(staging?.services ?? []).toHaveLength(topServices.length);
    expect(staging?.send_email ?? []).toHaveLength(topSendEmail.length);
  });
});

describe('staging queue chain matches the provisioning constants', () => {
  it('control plane produces onto the staging delivery queue', () => {
    const producer = mail.env?.staging?.queues?.producers?.[0];
    expect(producer?.binding).toBe('QUEUE');
    expect(producer?.queue).toBe(STAGING_MAIL_PRODUCER_QUEUE);
  });

  it('job consumes the same delivery queue and its DLQ with the pinned retry policy', () => {
    const consumers = mailerJob.env?.staging?.queues?.consumers ?? [];
    const delivery = consumers.find((entry) => entry.queue === STAGING_MAIL_PRODUCER_QUEUE);
    expect(delivery).toBeDefined();
    expect(delivery?.max_retries).toBe(3);
    expect(delivery?.dead_letter_queue).toBe(DELIVERY_DLQ);
  });

  it('job consumes the provider lifecycle queue with the lower retry policy and its DLQ', () => {
    const consumers = mailerJob.env?.staging?.queues?.consumers ?? [];
    const lifecycle = consumers.find((entry) => entry.queue === LIFECYCLE_QUEUE);
    expect(lifecycle).toBeDefined();
    expect(lifecycle?.max_retries).toBe(2);
    expect(lifecycle?.dead_letter_queue).toBe(LIFECYCLE_DLQ);
  });

  it('staging names never collide with the production queue names', () => {
    const productionQueues = [
      ...(mail.queues?.producers ?? []).map((entry) => entry.queue),
      ...(mailerJob.queues?.consumers ?? []).map((entry) => entry.queue),
      ...(mailerJob.queues?.consumers ?? []).map((entry) => entry.dead_letter_queue),
    ];
    for (const name of STAGING_QUEUE_NAMES) {
      expect(productionQueues).not.toContain(name);
    }
  });
});

describe('staging D1 bindings follow the not-yet-provisioned contract (9.1)', () => {
  it('database names are the per-lane staging names and no database_id is filled yet', () => {
    const mailBinding = mail.env?.staging?.d1_databases?.[0];
    expect(mailBinding?.binding).toBe('mail');
    expect(mailBinding?.database_name).toBe(STAGING_MAIL_DATABASE_NAME);
    expect(mailBinding?.database_id).toBeUndefined();

    const jobBinding = mailerJob.env?.staging?.d1_databases?.[0];
    expect(jobBinding?.binding).toBe('mail-job');
    expect(jobBinding?.database_name).toBe('stg-mail-job');
    expect(jobBinding?.database_id).toBeUndefined();
  });

  it('no placeholder id exists anywhere in either wrangler file', () => {
    const raw =
      readFileSync(join(APP_ROOT, 'transactional-mail', 'wrangler.jsonc'), 'utf8') +
      readFileSync(join(APP_ROOT, 'transactional-mailer-job', 'wrangler.jsonc'), 'utf8');
    expect(raw).not.toContain('00000000-0000-0000-0000-000000000000');
    expect(raw).not.toContain('00000000000000000000000000000000');
  });
});

describe('staging delivery plane wiring', () => {
  it('service binding targets the staging control plane worker', () => {
    const service = mailerJob.env?.staging?.services?.[0];
    expect(service?.binding).toBe('TRANSACTIONAL_MAIL_SERVICE');
    expect(service?.service).toBe(mail.env?.staging?.name);
    expect(service?.service).toBe('stg-ecoma-transactional-mail');
  });

  it('provider is the real cloudflare sender and agrees with the pinned send_email address', () => {
    // Continuous staging chạy provider thật (#348: candidate slot mới dùng
    // fake + D1 sink) — hai lớp chặn (vars vs allowed_sender_addresses) phải
    // nói cùng một địa chỉ.
    expect(mailerJob.env?.staging?.vars?.MAIL_PROVIDER_KIND).toBe('cloudflare');
    const sender = mailerJob.env?.staging?.send_email?.[0];
    expect(sender?.name).toBe('SEND_EMAIL');
    expect(sender?.allowed_sender_addresses).toEqual(['no-reply@ecoma.io']);
    expect(mailerJob.env?.staging?.vars?.MAIL_CF_SENDER).toBe('no-reply@ecoma.io');
  });
});

describe('cron triggers inherited from the top level', () => {
  it('both apps pin a top-level cron cadence that the staging env inherits', () => {
    expect(mail.triggers?.crons?.length ?? 0).toBeGreaterThan(0);
    expect(mailerJob.triggers?.crons?.length ?? 0).toBeGreaterThan(0);
  });
});
