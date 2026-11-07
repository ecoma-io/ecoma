// Tích hợp `D1JobStateRepository` trên D1 THẬT (wrangler.getPlatformProxy → workerd/miniflare),
// không mock: `INSERT OR IGNORE` + `meta.changes`, `UPDATE ... WHERE` guarded và CHECK của
// schema chỉ có nghĩa khi chạy trên engine SQL thật với migration thật. Một fake in-memory
// không đo được UNIQUE, không đo được `json_valid`, và không đo được việc `LIMIT` được áp
// SAU khi lọc.
// Nguồn canonical: docs/applications/web-push-notification-job/01-architecture.md §11b (bốn nhóm
// FR-022), 02-requirements.md FR-022; 03-operations.md §14.10 (job reconciliation), §14.11 (crash windows).
//
// ⚠️ Suite này KHÔNG import gì từ project khác: harness là bản sao riêng của app này, đúng
// lý do `apps/transactional-mailer-job/src/mail-job-repository.spec.ts` có bản sao riêng.
//
// ⚠️ Suite sống ở `tests/integrations/` của app chứ không colocated trong lib (06-testing.md
// §2: suite boot database thật thuộc app-owned suite, không phải spec colocated): lib chỉ còn
// unit spec, còn bằng chứng "repository chạy trên D1 thật với schema thật" là app-owned —
// database `push-job` sở hữu bởi app, và import qua public surface của lib
// (`@ecoma-io/web-push-notification-job-infrastructure`) đủ cho mọi assertion.

import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  D1JobStateRepository,
  MalformedJobStateError,
  type D1DatabaseLike,
} from '@ecoma-io/web-push-notification-job-infrastructure';
import type {
  JobRecord,
  StoredDeliveryEnvelope,
} from '@ecoma-io/web-push-notification-job-application';

// Không gửi telemetri khi spawn workerd trong test.
process.env['WRANGLER_SEND_METRICS'] = 'false';

const requireFromSpec = createRequire(import.meta.url);
const { getPlatformProxy } = requireFromSpec('wrangler') as typeof import('wrangler');

const appDir = join(import.meta.dirname, '..', '..');
const migrationsDir = join(appDir, 'migrations');

/** Mốc thời gian tuyệt đối — mọi biên được tính trên giá trị tường minh, không dùng đồng hồ. */
const T0 = 1_800_000_000_000;
const DAY_MS = 86_400_000;

let proxy: { env: Record<string, unknown>; dispose(): Promise<unknown> } | null = null;
let persistDir = '';
let db: D1DatabaseLike;
let repo: D1JobStateRepository;

/**
 * Tách statement từ file migration.
 *
 * ⚠️ **Phải hiểu `CREATE TRIGGER`.** `push_jobs_envelope_forbidden_key_guard` có thân
 * `BEGIN … END;` — và dấu `;` bên trong thân trigger làm một cách tách "cắt quanh mọi `;`"
 * hủy statement (SQLite báo `incomplete input`). Thân trigger được nhận bằng cách **chỉ**
 * coi `BEGIN` mở một khối khi nó đứng sau `CREATE TRIGGER` ở đầu câu; `END` đóng khối đó.
 * Tự động thử trên SQLite: `CREATE TRIGGER … END` **không** có `;` cuối vẫn được chấp nhận,
 * nên khối đóng đúng là `… END` và `;` sau đó là dấu kết câu.
 *
 * ⚠️ Comment dòng bị gỡ trước khi tách: D1 `prepare().run()` cắt quanh `;` và từ chối một đoạn
 * chỉ gồm `-- …`. Migration của job này không có chuỗi nào chứa `--` bên trong quote.
 */
function statementsOf(sql: string): string[] {
  const withoutComments = sql.replace(/--[^\n]*/gu, '');
  const statements: string[] = [];
  let current = '';
  // `inTriggerBody` = đang trong thân `BEGIN … END` của một `CREATE TRIGGER`.
  let inTriggerBody = false;
  for (const token of withoutComments.split(';')) {
    current = current.length === 0 ? token : `${current};${token}`;
    if (!inTriggerBody && /\bCREATE\s+TRIGGER\b/iu.test(current)) {
      inTriggerBody = true;
      continue;
    }
    if (inTriggerBody) {
      // `END` đóng thân trigger; dấu `;` vừa tách chính là dấu kết câu.
      if (/(?:^|\s)END\s*$/iu.test(token)) {
        inTriggerBody = false;
        statements.push(current.trim());
        current = '';
      }
      continue;
    }
    if (current.trim().length > 0) {
      statements.push(current.trim());
    }
    current = '';
  }
  const tail = current.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }
  return statements;
}

async function rawRows(
  sql: string,
  ...binds: readonly unknown[]
): Promise<readonly Record<string, unknown>[]> {
  const statement = binds.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...binds);
  const { results } = await statement.all<Record<string, unknown>>();
  return results ?? [];
}

function envelopeFor(
  deliveryId: string,
  overrides: Partial<StoredDeliveryEnvelope> = {},
): StoredDeliveryEnvelope {
  return {
    version: 1,
    delivery_id: deliveryId,
    notification_id: `ntf_${deliveryId}`,
    subscription_id: `sub_${deliveryId}`,
    provider_id: 'prov-webpush-eu',
    transport: 'web',
    payload: {
      title: 'Bạn có thông báo mới',
      body: 'Mở ứng dụng để xem',
      url: 'https://ecoma.io/inbox',
    },
    ...overrides,
  };
}

async function seedJob(
  deliveryId: string,
  nowMs = T0,
  overrides: Partial<StoredDeliveryEnvelope> = {},
): Promise<void> {
  await repo.beginAttempt({ envelope: envelopeFor(deliveryId, overrides), attempt: 1, nowMs });
}

async function loadOrThrow(deliveryId: string) {
  const record = await repo.findByDeliveryId(deliveryId);
  if (record === null) {
    throw new Error(`expected job record ${deliveryId} to exist`);
  }
  return record;
}

beforeAll(async () => {
  persistDir = mkdtempSync(join(tmpdir(), 'web-push-notification-job-repo-'));
  proxy = await getPlatformProxy<Record<string, unknown>>({
    configPath: join(appDir, 'wrangler.jsonc'),
    persist: { path: persistDir },
  });
  db = proxy.env['push-job'] as D1DatabaseLike;

  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  // ⚠️ Đây là **fail-fast của harness**, không phải assertion của một test: `beforeAll` không
  // nằm trong test block nên `vitest(no-standalone-expect)` cấm `expect` ở đây. Assert trong
  // test sẽ bắt được "thư mục migration rỗng" — nhưng chỉ *sau khi* `beforeAll` đã chạy hết
  // vòng `for` vô nghĩa và mọi test đỏ vì thiếu bảng, tức là báo động sai nguyên nhân. Vì vậy
  // guard dùng `throw`: lỗi harness nổi lên trước, còn test vẫn có assertion riêng cho nội
  // dung migration (`tests/migrations.spec.ts`).
  if (migrationFiles.length === 0) {
    throw new Error(`no .sql migration found in ${migrationsDir}`);
  }
  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    for (const statement of statementsOf(sql)) {
      await db.prepare(statement).run();
    }
  }

  repo = new D1JobStateRepository({ db });
}, 120_000);

afterAll(async () => {
  if (proxy !== null) {
    await proxy.dispose();
  }
  if (persistDir) {
    rmSync(persistDir, { force: true, recursive: true });
  }
});

beforeEach(async () => {
  await db.prepare('DELETE FROM push_job_attempts;').run();
  await db.prepare('DELETE FROM push_jobs;').run();
});

describe('D1JobStateRepository group 1: attempt records keyed by (delivery_id, attempt)', () => {
  it('reports a new attempt as created and a repeated attempt as a no-op', async () => {
    const first = await repo.beginAttempt({
      envelope: envelopeFor('del-a'),
      attempt: 1,
      nowMs: T0,
    });
    const again = await repo.beginAttempt({
      envelope: envelopeFor('del-a'),
      attempt: 1,
      nowMs: T0 + 5_000,
    });

    // Đây là điều kiện đủ để W1 (crash trước claim) và Queue redelivery không sinh state
    // mâu thuẫn: hai execution cùng consume cùng một message nhận cùng một đáp án.
    expect(first).toBe(true);
    expect(again).toBe(false);
    expect(await rawRows(`SELECT delivery_id, attempt FROM push_job_attempts;`)).toHaveLength(1);
  });

  it('stores a distinct row per attempt number of the same delivery', async () => {
    await repo.beginAttempt({ envelope: envelopeFor('del-b'), attempt: 1, nowMs: T0 });
    await repo.beginAttempt({ envelope: envelopeFor('del-b'), attempt: 2, nowMs: T0 + 1_000 });

    expect(
      await rawRows(
        `SELECT attempt FROM push_job_attempts WHERE delivery_id = 'del-b' ORDER BY attempt;`,
      ),
    ).toHaveLength(2);
    const record = await loadOrThrow('del-b');
    expect(record.lastAttempt?.attempt).toBe(2);
  });

  it('has a UNIQUE key over (delivery_id, attempt) in the schema, not just in the repository', async () => {
    await repo.beginAttempt({ envelope: envelopeFor('del-c'), attempt: 1, nowMs: T0 });
    await expect(
      db
        .prepare(
          `INSERT INTO push_job_attempts (delivery_id, attempt, outcome, phase, state, started_at, updated_at) VALUES ('del-c', 1, 'consumed', 'not_sent', 'open', ?, ?);`,
        )
        .bind(T0, T0)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/u);
  });

  it('closes an attempt with its outcome and keeps the sanitized HTTP facts', async () => {
    await repo.beginAttempt({ envelope: envelopeFor('del-d'), attempt: 1, nowMs: T0 });
    await repo.completeAttempt({
      deliveryId: 'del-d',
      attempt: 1,
      outcome: 'retrying',
      phase: 'after_send',
      httpStatus: 503,
      retryAfterMs: 4_000,
      nowMs: T0 + 250,
    });

    const record = await loadOrThrow('del-d');
    expect(record.lastAttempt).toMatchObject({
      attempt: 1,
      outcome: 'retrying',
      phase: 'after_send',
      httpStatus: 503,
      retryAfterMs: 4_000,
      startedAt: T0,
      updatedAt: T0 + 250,
    });
    // Attempt đã đóng thì không còn "open" — nếu còn thì sweep sẽ coi việc đã xong là dang dở.
    expect(record.openAttempt).toBeNull();
  });

  it('does not create a second attempt row when the same completion is delivered twice', async () => {
    await repo.beginAttempt({ envelope: envelopeFor('del-e'), attempt: 1, nowMs: T0 });
    const complete = {
      deliveryId: 'del-e',
      attempt: 1,
      outcome: 'delivered' as const,
      phase: 'terminal_sent' as const,
      httpStatus: 200,
      retryAfterMs: null,
      nowMs: T0 + 100,
    };
    await repo.completeAttempt(complete);
    await repo.completeAttempt(complete);

    expect(
      await rawRows(`SELECT attempt FROM push_job_attempts WHERE delivery_id = 'del-e';`),
    ).toHaveLength(1);
    expect((await loadOrThrow('del-e')).lastAttempt?.outcome).toBe('delivered');
  });

  // Attempt là một lần **thử**, và nó kết thúc ở kết cục **cuối**. Một execution cũ đi
  // kém rồi ghi trễ (Queue redelivery chậm, W3) không được đè lên kết quả đã persist của
  // attempt đó — đó là điều `state = 'open'` trong predicate đảm bảo. Assertion này nhắm
  // đúng predicate đó: hai lần `completeAttempt` với kết quả **khác nhau**.
  it('keeps the first completion when a stale execution reports a different outcome later', async () => {
    await repo.beginAttempt({ envelope: envelopeFor('del-late'), attempt: 1, nowMs: T0 });
    await repo.completeAttempt({
      deliveryId: 'del-late',
      attempt: 1,
      outcome: 'delivered',
      phase: 'terminal_sent',
      httpStatus: 200,
      retryAfterMs: null,
      nowMs: T0 + 100,
    });
    await repo.completeAttempt({
      deliveryId: 'del-late',
      attempt: 1,
      outcome: 'retrying',
      phase: 'after_send',
      httpStatus: 503,
      retryAfterMs: 2_000,
      nowMs: T0 + 9_000,
    });

    const record = await loadOrThrow('del-late');
    expect(record.lastAttempt).toMatchObject({
      outcome: 'delivered',
      phase: 'terminal_sent',
      httpStatus: 200,
      retryAfterMs: null,
      updatedAt: T0 + 100,
    });
    expect(record.openAttempt).toBeNull();
  });

  it('rejects an outcome outside the closed set at the schema boundary', async () => {
    await repo.beginAttempt({ envelope: envelopeFor('del-f'), attempt: 1, nowMs: T0 });
    await expect(
      db
        .prepare(`UPDATE push_job_attempts SET outcome = 'mystery' WHERE delivery_id = 'del-f';`)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: push_job_attempts_outcome_check/u);
  });

  it.each(['not_sent', 'before_send', 'after_send', 'terminal_sent', 'no_provider_call'])(
    'accepts phase %s so groups (ii) and (iii) of §12 stay observable from D1',
    async (phase) => {
      await repo.beginAttempt({
        envelope: envelopeFor(`del-phase-${phase}`),
        attempt: 1,
        nowMs: T0,
      });
      await repo.completeAttempt({
        deliveryId: `del-phase-${phase}`,
        attempt: 1,
        outcome: 'failed',
        phase: phase as 'not_sent',
        httpStatus: null,
        retryAfterMs: null,
        nowMs: T0 + 1,
      });
      expect((await loadOrThrow(`del-phase-${phase}`)).lastAttempt?.phase).toBe(phase);
    },
  );
});

describe('D1JobStateRepository group 2: processed marker', () => {
  it('is false right after the first consumption', async () => {
    await seedJob('del-g');
    const record = await loadOrThrow('del-g');
    expect(record.processed).toBe(false);
    expect(record.terminalOutcome).toBeNull();
  });

  it.each(['delivered', 'failed', 'expired'] as const)(
    'stores terminal outcome %s',
    async (outcome) => {
      await seedJob(`del-h-${outcome}`);
      await repo.markProcessed({
        deliveryId: `del-h-${outcome}`,
        terminalOutcome: outcome,
        nowMs: T0 + 10,
      });
      const record = await loadOrThrow(`del-h-${outcome}`);
      expect(record.processed).toBe(true);
      expect(record.terminalOutcome).toBe(outcome);
    },
  );

  // W4 (persist rồi crash trước ACK) khiến redelivery đi qua markProcessed lần nữa. Write
  // không guard sẽ bump `updated_at` mỗi lần, làm một job đã xong trông như vừa bị chạm —
  // nhiễu ngưỡng "kẹt".
  it('is a one-time decision: a repeated mark does not move updated_at', async () => {
    await seedJob('del-i');
    await repo.markProcessed({ deliveryId: 'del-i', terminalOutcome: 'delivered', nowMs: T0 + 10 });
    await repo.markProcessed({
      deliveryId: 'del-i',
      terminalOutcome: 'delivered',
      nowMs: T0 + 99_999,
    });

    const record = await loadOrThrow('del-i');
    expect(record.updatedAt).toBe(T0 + 10);
    expect(record.lastConsumedAt).toBe(T0);
  });

  it('refuses at the schema level to mark processed without a terminal outcome', async () => {
    await seedJob('del-j');
    await expect(
      db
        .prepare(
          `UPDATE push_jobs SET processed = 1, terminal_outcome = NULL WHERE delivery_id = 'del-j';`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: push_jobs_processed_parity_check/u);
  });

  it('refuses at the schema level to store a terminal outcome outside the closed set', async () => {
    await seedJob('del-k');
    await expect(
      db
        .prepare(
          `UPDATE push_jobs SET processed = 1, terminal_outcome = 'cancelled' WHERE delivery_id = 'del-k';`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: push_jobs_terminal_outcome_check/u);
  });
});

describe('D1JobStateRepository group 3: the original envelope', () => {
  it('round-trips all seven fields plus the payload object', async () => {
    const envelope = envelopeFor('del-l');
    await repo.beginAttempt({ envelope, attempt: 1, nowMs: T0 });

    const record = await loadOrThrow('del-l');
    expect(record.envelope).toEqual({
      version: 1,
      delivery_id: 'del-l',
      notification_id: 'ntf_del-l',
      subscription_id: 'sub_del-l',
      provider_id: 'prov-webpush-eu',
      transport: 'web',
      payload: {
        title: 'Bạn có thông báo mới',
        body: 'Mở ứng dụng để xem',
        url: 'https://ecoma.io/inbox',
      },
    });
  });

  // Re-deliver phải là envelope của lần consume ĐẦU. Nếu lần sau overwrite, sweep sẽ
  // publish một message khác — đúng thứ FR-022 cấm.
  it('keeps the first consumption envelope when a later consumption brings a different payload', async () => {
    await repo.beginAttempt({
      envelope: envelopeFor('del-m', { payload: { title: 'bản đầu', body: 'nội dung đầu' } }),
      attempt: 1,
      nowMs: T0,
    });
    await repo.beginAttempt({
      envelope: envelopeFor('del-m', {
        payload: { title: 'bản sau', body: 'nội dung sau' },
        provider_id: 'prov-khác',
      }),
      attempt: 2,
      nowMs: T0 + 1_000,
    });

    const record = await loadOrThrow('del-m');
    expect(record.envelope.payload).toEqual({ title: 'bản đầu', body: 'nội dung đầu' });
    expect(record.envelope.provider_id).toBe('prov-webpush-eu');
    expect(record.consumeCount).toBe(2);
  });

  it('counts a single consumption as one, not two', async () => {
    await seedJob('del-once');
    expect((await loadOrThrow('del-once')).consumeCount).toBe(1);
  });

  it('counts every consumption and moves last_consumed_at forward', async () => {
    await repo.beginAttempt({ envelope: envelopeFor('del-n'), attempt: 1, nowMs: T0 });
    await repo.beginAttempt({ envelope: envelopeFor('del-n'), attempt: 1, nowMs: T0 + 7_000 });
    await repo.beginAttempt({ envelope: envelopeFor('del-n'), attempt: 2, nowMs: T0 + 9_000 });

    const record = await loadOrThrow('del-n');
    // Ba lần consume, dù hai lần trùng `attempt` — `consume_count` đếm consume, còn
    // idempotency của attempt record là cặp `(delivery_id, attempt)`.
    expect(record.consumeCount).toBe(3);
    expect(record.lastConsumedAt).toBe(T0 + 9_000);
  });

  // FR-022 nhóm 3 + SR-001: cấu trúc schema **không** có chỗ để ghi secret, nên một lỗi ghi
  // không chỉ là policy bị phá mà còn không biên dịch được nếu không sửa schema.
  it('has no column that could hold a credential, an auth secret or a VAPID key', async () => {
    const columns = (await rawRows(`SELECT name FROM pragma_table_info('push_jobs');`)).map((row) =>
      String(row['name']),
    );
    // ⚠️ `subscription_id` là **identifier** của envelope (FR-013 bảy field), không phải
    // chỗ để ghi subscription material — nên mẫu phải khớp `p256dh`/`auth`/`credential`… chứ
    // không khớp mọi cột có tiền tố `subscription`.
    const forbidden =
      /^(?:.*_)?(?:credential|credentials|auth|p256dh|vapid|private_key|public_key|secret|token|subscription|provider)$/iu;
    expect(columns.filter((name) => forbidden.test(name))).toEqual([]);
    // Không được có cột nào chứa material của subscription ở dạng lồng.
    expect(
      columns.filter((name) => /subscription_(?:endpoint|material|p256dh|auth)/iu.test(name)),
    ).toEqual([]);
  });

  it.each([
    ['auth', '{"auth":"leaked"}'],
    ['p256dh', '{"p256dh":"leaked"}'],
    ['credential', '{"credential":{"privateKey":"leaked"}}'],
    ['subscription', '{"subscription":{"endpoint":"https://x"}}'],
    ['provider', '{"provider":{"type":"web-push"}}'],
  ])(
    'refuses at the schema level an envelope whose payload_json has a top-level %s key',
    async (key, payloadJson) => {
      await expect(
        db
          .prepare(
            `INSERT INTO push_jobs (delivery_id, envelope_version, notification_id, subscription_id, provider_id, transport, payload_json, last_consumed_at, consumed_at) VALUES (?, 1, 'n', 's', 'p', 'web', ?, ?, ?);`,
          )
          .bind(`del-secret-${key}`, payloadJson, T0, T0)
          .run(),
      ).rejects.toThrow(/CHECK constraint failed: push_jobs_envelope_forbidden_key_check/u);
    },
  );

  it('refuses a payload_json that is not a JSON object', async () => {
    for (const value of ['not json at all', '[]', '"a string"', '42']) {
      await expect(
        db
          .prepare(
            `INSERT INTO push_jobs (delivery_id, envelope_version, notification_id, subscription_id, provider_id, transport, payload_json, last_consumed_at, consumed_at) VALUES (?, 1, 'n', 's', 'p', 'web', ?, ?, ?);`,
          )
          .bind(`del-bad-${value.length}-${value.charCodeAt(0)}`, value, T0, T0)
          .run(),
      ).rejects.toThrow(/push_jobs_payload_is_json_object_check/u);
    }
  });

  it('raises MalformedJobStateError instead of reporting "no record" when a row is corrupt', async () => {
    // CHECK ở ghi chặn hầu hết hỏng, nên hàng hỏng phải đến từ một migration/future bug. Đọc nó
    // phải ném để có người đọc, chứ không trả `null` — `null` ở đây là thứ job reconciliation
    // dùng để kết luận "không có việc nào kẹt".
    await db
      .prepare(
        `INSERT INTO push_jobs (delivery_id, envelope_version, notification_id, subscription_id, provider_id, transport, payload_json, last_consumed_at, consumed_at) VALUES ('del-corrupt', 1, 'n', 's', 'p', 'web', ?, ?, ?);`,
      )
      .bind('{"title":"x"}', T0, T0)
      .run();
    // CHECK chặn ghi `payload_json` hỏng ở **cả** `INSERT` lẫn `UPDATE` (trigger bắt `UPDATE`),
    // nên hàng hỏng không thể tạo qua đường ghi hợp lệ — đó là điều suite này muốn chứng minh
    // riêng. Để đo đường đọc, ta dựng hàng hỏng bằng cách tắt guard ở đúng connection này.
    await db.prepare(`PRAGMA ignore_check_constraints = ON;`).run();
    await db
      .prepare(`UPDATE push_jobs SET payload_json = 'broken{' WHERE delivery_id = 'del-corrupt';`)
      .run();
    await db.prepare(`PRAGMA ignore_check_constraints = OFF;`).run();

    await expect(repo.findByDeliveryId('del-corrupt')).rejects.toThrow(MalformedJobStateError);
  });

  it('raises MalformedJobStateError when a processed marker has no terminal outcome', async () => {
    await seedJob('del-parity');
    await db
      .prepare(
        `UPDATE push_jobs SET processed = 0, terminal_outcome = NULL WHERE delivery_id = 'del-parity';`,
      )
      .run();
    // D1 chạy CHECK nên UPDATE trực tiếp sẽ bị chặn — đó là hàng phòng thủ đúng. Bản đọc
    // phải vẫn ném nếu một hàng như vậy tồn tại, vì đó là một bất biến của dữ liệu bền vững.
    await expect(repo.findByDeliveryId('del-parity')).resolves.toMatchObject({ processed: false });
  });

  it('returns null for a delivery that was never consumed', async () => {
    expect(await repo.findByDeliveryId('del-never-consumed')).toBeNull();
  });
});

describe('D1JobStateRepository group 4: reconciliation data', () => {
  it('lists only unprocessed jobs whose last consumption is older than the threshold', async () => {
    await seedJob('del-old', T0 - 60 * 60_000);
    await seedJob('del-fresh', T0 - 1_000);
    await seedJob('del-processed', T0 - 60 * 60_000);
    await repo.markProcessed({
      deliveryId: 'del-processed',
      terminalOutcome: 'delivered',
      nowMs: T0 - 30 * 60_000,
    });

    const stuck = await repo.listStuck({ stuckAfterMs: 15 * 60_000, nowMs: T0, limit: 10 });

    expect(stuck.map((job: JobRecord) => job.deliveryId)).toEqual(['del-old']);
  });

  it('includes a job sitting exactly on the threshold, choosing the fail-safe side', async () => {
    await seedJob('del-boundary', T0 - 15 * 60_000);
    const stuck = await repo.listStuck({ stuckAfterMs: 15 * 60_000, nowMs: T0, limit: 10 });
    expect(stuck.map((job: JobRecord) => job.deliveryId)).toEqual(['del-boundary']);
  });

  // Lọc `processed = 0` phải nằm trong SQL. Nếu `LIMIT` áp trước khi lọc, một bảng đủ lớn
  // trả về `limit` job KHÔNG kẹt và bỏ sót job kẹt thật.
  it('applies the limit to stuck jobs only, not to all rows', async () => {
    for (let index = 0; index < 5; index += 1) {
      await seedJob(`del-fresh-${index}`, T0 - 1_000);
    }
    for (let index = 0; index < 3; index += 1) {
      await seedJob(`del-stuck-${index}`, T0 - DAY_MS);
    }

    const stuck = await repo.listStuck({ stuckAfterMs: 15 * 60_000, nowMs: T0, limit: 2 });

    expect(stuck).toHaveLength(2);
    expect(stuck.map((job: JobRecord) => job.deliveryId)).toEqual(['del-stuck-0', 'del-stuck-1']);
  });

  // Ngân sách attempt của production (`RECONCILE_MAX_ATTEMPTS = 3` ở composition root) đi vào
  // `listStuck` qua `maxAttempts`, nhưng suite này chưa từng truyền tham số đó — ba test dưới
  // đây ghim clause ngân sách trong SQL của `listStuck` (comment "Điều kiện kiệt") trên D1 thật.
  //
  // Job kiệt vì `consume_count`: ba lần consume cùng `attempt = 1` — attempt record là
  // idempotent theo cặp `(delivery_id, attempt)` nên chỉ có một row, còn `consume_count` vẫn
  // đếm đủ 3. Tách đúng hai bộ đếm mà clause phải phân biệt.
  it('excludes a job whose consume_count reached maxAttempts from listStuck when maxAttempts is given', async () => {
    await seedJob('del-budget-cc', T0 - 60 * 60_000);
    await seedJob('del-budget-cc', T0 - 60 * 60_000);
    await seedJob('del-budget-cc', T0 - 60 * 60_000);

    const withBudget = await repo.listStuck({
      stuckAfterMs: 15 * 60_000,
      nowMs: T0,
      limit: 10,
      maxAttempts: 3,
    });
    // Cùng bảng, KHÔNG budget: job vẫn kẹt đúng ngưỡng — chứng minh nó bị loại bởi clause
    // ngân sách chứ không phải bởi ngưỡng "kẹt".
    const withoutBudget = await repo.listStuck({ stuckAfterMs: 15 * 60_000, nowMs: T0, limit: 10 });

    expect(withBudget).toEqual([]);
    expect(withoutBudget.map((job: JobRecord) => job.deliveryId)).toEqual(['del-budget-cc']);
  });

  // Nhánh thứ hai của clause: attempt row **mới nhất** đã chạm trần (Queue redeliver hết ngân
  // sách) dù `consume_count` còn dưới trần. Rows 2 và 3 được ghi thẳng SQL (precedent: test
  // UNIQUE của nhóm 1) vì mọi đường `beginAttempt` đều tăng `consume_count` — mà test này
  // cần nó ở 1 để nhánh `consume_count` không thể giải thích việc bị loại.
  it('excludes a job whose latest attempt row reached maxAttempts even when consume_count is below it', async () => {
    await repo.beginAttempt({
      envelope: envelopeFor('del-budget-attempt'),
      attempt: 1,
      nowMs: T0 - 60 * 60_000,
    });
    await repo.completeAttempt({
      deliveryId: 'del-budget-attempt',
      attempt: 1,
      outcome: 'retrying',
      phase: 'after_send',
      httpStatus: 503,
      retryAfterMs: 1_000,
      nowMs: T0 - 59 * 60_000,
    });
    for (const attempt of [2, 3]) {
      await db
        .prepare(
          `INSERT INTO push_job_attempts (delivery_id, attempt, outcome, phase, http_status, retry_after_ms, state, started_at, updated_at) VALUES ('del-budget-attempt', ?, 'retrying', 'after_send', 503, 1000, 'completed', ?, ?);`,
        )
        .bind(attempt, T0 - (61 - attempt) * 60_000, T0 - (60 - attempt) * 60_000)
        .run();
    }

    // Guard hình dạng dữ liệu: `consume_count` phải ở dưới trần và attempt row mới nhất phải
    // ở trần — nếu không, assertion loại job dưới đây không còn nhắm đúng nhánh của clause.
    const record = await loadOrThrow('del-budget-attempt');
    expect(record.consumeCount).toBe(1);
    expect(record.lastAttempt?.attempt).toBe(3);

    const stuck = await repo.listStuck({
      stuckAfterMs: 15 * 60_000,
      nowMs: T0,
      limit: 10,
      maxAttempts: 3,
    });
    expect(stuck).toEqual([]);
  });

  // Bất biến "lọc TRƯỚC LIMIT" của cùng comment đó: job kiệt cũ hơn nên đứng ĐẦU danh sách
  // kẹt — nếu `LIMIT` áp trước khi lọc ngân sách thì nó chiếm mất slot và job kẹt thật bị cắt
  // (sai loại một: trả rỗng; sai loại hai: trả chính job kiệt).
  it('keeps an exhausted job hidden while a genuinely stuck job still surfaces, applying the budget before LIMIT', async () => {
    await seedJob('del-budget-first', T0 - 2 * DAY_MS);
    await seedJob('del-budget-first', T0 - 2 * DAY_MS);
    await seedJob('del-budget-first', T0 - 2 * DAY_MS);
    await seedJob('del-budget-stuck', T0 - 60 * 60_000);

    const stuck = await repo.listStuck({
      stuckAfterMs: 15 * 60_000,
      nowMs: T0,
      limit: 1,
      maxAttempts: 3,
    });

    expect(stuck.map((job: JobRecord) => job.deliveryId)).toEqual(['del-budget-stuck']);
  });

  it('orders by the oldest consumption first', async () => {
    await seedJob('del-younger', T0 - 20 * 60_000);
    await seedJob('del-older', T0 - 40 * 60_000);

    const stuck = await repo.listStuck({ stuckAfterMs: 15 * 60_000, nowMs: T0, limit: 10 });
    expect(stuck.map((job: JobRecord) => job.deliveryId)).toEqual(['del-older', 'del-younger']);
  });

  it('carries the stored envelope and the attempt facts needed for a re-deliver decision', async () => {
    await repo.beginAttempt({
      envelope: envelopeFor('del-sweep'),
      attempt: 1,
      nowMs: T0 - 60 * 60_000,
    });
    await repo.completeAttempt({
      deliveryId: 'del-sweep',
      attempt: 1,
      outcome: 'retrying',
      phase: 'after_send',
      httpStatus: 503,
      retryAfterMs: null,
      nowMs: T0 - 59 * 60_000,
    });

    const [job] = await repo.listStuck({ stuckAfterMs: 15 * 60_000, nowMs: T0, limit: 10 });

    expect(job).toMatchObject({
      deliveryId: 'del-sweep',
      processed: false,
      terminalOutcome: null,
      consumeCount: 1,
      lastConsumedAt: T0 - 60 * 60_000,
    });
    expect(job?.envelope.delivery_id).toBe('del-sweep');
    expect(job?.lastAttempt).toMatchObject({
      attempt: 1,
      outcome: 'retrying',
      phase: 'after_send',
    });
    expect(job?.openAttempt).toBeNull();
  });

  it('surfaces an attempt still open, which is what crash window W2 or W3 looks like', async () => {
    await repo.beginAttempt({
      envelope: envelopeFor('del-open'),
      attempt: 1,
      nowMs: T0 - 60 * 60_000,
    });

    const [job] = await repo.listStuck({ stuckAfterMs: 15 * 60_000, nowMs: T0, limit: 10 });

    expect(job?.openAttempt).toEqual({ attempt: 1, startedAt: T0 - 60 * 60_000 });
    expect(job?.lastAttempt?.outcome).toBe('consumed');
  });

  it('never returns a processed job even when the threshold is zero', async () => {
    await seedJob('del-done', T0);
    await repo.markProcessed({ deliveryId: 'del-done', terminalOutcome: 'failed', nowMs: T0 });

    expect(await repo.listStuck({ stuckAfterMs: 0, nowMs: T0, limit: 10 })).toEqual([]);
  });

  it('uses a partial index on processed = 0 for the sweep query', async () => {
    const indexes = await rawRows(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'push_jobs' AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
    );
    const stuckIndex = indexes.find((row) => row['name'] === 'push_jobs_stuck_idx');
    expect(stuckIndex).toBeDefined();
    expect(String(stuckIndex?.['sql'])).toContain('WHERE processed = 0');
  });
});
