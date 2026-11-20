/**
 * Hợp đồng config staging của delivery plane (#355) — spec hợp đồng đọc
 * TRỰC TIẾP `wrangler.jsonc` của `apps/transactional-mailer-job` (tài sản
 * review-able trong Git) và đối chiếu với hằng tên tài nguyên của
 * `staging-run.ts`. Đọc qua `node:fs` chứ KHÔNG import app — app là sản phẩm
 * build của lane Wrangler, project này chỉ provision tài nguyên D1 của làn.
 *
 * Chuỗi queue producer↔consumer↔DLQ và service binding ĐỐI CHIẾU CHÉO với
 * control plane được spec `transactional-mail-deploy/staging-config.spec.ts`
 * nắm (provisioning tập trung ở project đó); spec này chốt phần bên phía
 * consumer bằng HẰNG SỐ hợp đồng — trôi lệch một bên là một trong hai spec đỏ.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STAGING_MAIL_JOB_DATABASE_NAME } from './staging-run.js';
import { parseJsonc } from './wrangler-jsonc.js';

/** Hằng hợp đồng chuỗi queue staging — tên provision bởi `transactional-mail-deploy`. */
const STAGING_DELIVERY_QUEUE = 'stg-ecoma-mail-delivery';
const STAGING_DELIVERY_DLQ = 'stg-ecoma-mail-delivery-dlq';
const STAGING_LIFECYCLE_QUEUE = 'stg-ecoma-mail-lifecycle-events';
const STAGING_LIFECYCLE_DLQ = 'stg-ecoma-mail-lifecycle-events-dlq';
/** Worker staging của control plane — service binding trỏ về đúng identity này. */
const STAGING_CONTROL_PLANE_WORKER = 'stg-ecoma-transactional-mail';

/** Shape tối thiểu của wrangler.jsonc dùng trong audit — structural typing. */
interface D1Binding {
  binding: string;
  database_name: string;
  database_id?: string;
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
  queues?: { consumers?: QueueConsumerBinding[] };
  services?: ServiceBinding[];
  send_email?: SendEmailBinding[];
  vars?: Record<string, string>;
  env?: Record<string, WranglerConfig>;
}

const config = parseJsonc<WranglerConfig>(
  readFileSync(
    join(import.meta.dirname, '..', '..', 'apps', 'transactional-mailer-job', 'wrangler.jsonc'),
    'utf8',
  ),
);
const staging = config.env?.staging;

describe('env.staging identity', () => {
  it('the delivery job declares an env.staging derived as stg-<production name>', () => {
    expect(staging, 'env.staging of the delivery job').toBeDefined();
    expect(staging?.name).toBe(`stg-${config.name}`);
    expect(staging?.name).toBe('stg-ecoma-transactional-mailer-job');
  });

  it('the staging worker is internal-only (no workers.dev subdomain)', () => {
    expect(staging?.workers_dev).toBe(false);
  });

  it('no env.production exists at M2 — early declaration enters the wrong horizon', () => {
    expect(config.env?.production).toBeUndefined();
  });
});

describe('binding audit — every top-level binding kind is re-declared in env.staging', () => {
  it('d1, queue consumers, services and send_email are all re-declared for the lane', () => {
    const topD1 = config.d1_databases ?? [];
    const topConsumers = config.queues?.consumers ?? [];
    const topServices = config.services ?? [];
    const topSendEmail = config.send_email ?? [];
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

describe('staging D1 binding follows the not-yet-provisioned contract (9.1)', () => {
  it('the database name is the per-lane staging name and no database_id is filled yet', () => {
    const binding = staging?.d1_databases?.[0];
    expect(binding?.binding).toBe('mail-job');
    expect(binding?.database_name).toBe(STAGING_MAIL_JOB_DATABASE_NAME);
    expect(binding?.database_id).toBeUndefined();
  });

  it('no placeholder id exists anywhere in the wrangler file', () => {
    const raw = readFileSync(
      join(import.meta.dirname, '..', '..', 'apps', 'transactional-mailer-job', 'wrangler.jsonc'),
      'utf8',
    );
    expect(raw).not.toContain('00000000-0000-0000-0000-000000000000');
    expect(raw).not.toContain('00000000000000000000000000000000');
  });
});

describe('staging queue consumers pin the per-lane chain with the retry policy', () => {
  it('delivery queue consumes with its DLQ and the platform default retries', () => {
    const delivery = (staging?.queues?.consumers ?? []).find(
      (entry) => entry.queue === STAGING_DELIVERY_QUEUE,
    );
    expect(delivery).toBeDefined();
    expect(delivery?.max_retries).toBe(3);
    expect(delivery?.dead_letter_queue).toBe(STAGING_DELIVERY_DLQ);
  });

  it('provider lifecycle queue consumes with the lower retry policy and its DLQ', () => {
    const lifecycle = (staging?.queues?.consumers ?? []).find(
      (entry) => entry.queue === STAGING_LIFECYCLE_QUEUE,
    );
    expect(lifecycle).toBeDefined();
    expect(lifecycle?.max_retries).toBe(2);
    expect(lifecycle?.dead_letter_queue).toBe(STAGING_LIFECYCLE_DLQ);
  });

  it('staging queue names never collide with the production names', () => {
    const productionQueues = (config.queues?.consumers ?? []).map((entry) => entry.queue);
    for (const name of [
      STAGING_DELIVERY_QUEUE,
      STAGING_DELIVERY_DLQ,
      STAGING_LIFECYCLE_QUEUE,
      STAGING_LIFECYCLE_DLQ,
    ]) {
      expect(productionQueues).not.toContain(name);
    }
  });
});

describe('staging delivery plane wiring', () => {
  it('service binding targets the staging control plane worker', () => {
    const service = staging?.services?.[0];
    expect(service?.binding).toBe('TRANSACTIONAL_MAIL_SERVICE');
    expect(service?.service).toBe(STAGING_CONTROL_PLANE_WORKER);
  });

  it('provider is the real cloudflare sender and agrees with the pinned send_email address', () => {
    // Continuous staging chạy provider thật (#348: candidate slot mới dùng
    // fake + D1 sink) — hai lớp chặn (vars vs allowed_sender_addresses) phải
    // nói cùng một địa chỉ.
    expect(staging?.vars?.MAIL_PROVIDER_KIND).toBe('cloudflare');
    const sender = staging?.send_email?.[0];
    expect(sender?.name).toBe('SEND_EMAIL');
    expect(sender?.allowed_sender_addresses).toEqual(['no-reply@ecoma.io']);
    expect(staging?.vars?.MAIL_CF_SENDER).toBe('no-reply@ecoma.io');
  });
});

describe('cron triggers inherited from the top level', () => {
  it('the app pins a top-level cron cadence that the staging env inherits', () => {
    expect(config.triggers?.crons?.length ?? 0).toBeGreaterThan(0);
  });
});
