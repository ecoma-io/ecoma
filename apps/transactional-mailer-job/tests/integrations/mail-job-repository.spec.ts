// Tích hợp contract persistence trên D1 THẬT (miniflare/workerd qua
// `wrangler.getPlatformProxy`), không mock: conditional UPDATE, `meta.changes`, lease và
// fencing chỉ có ý nghĩa khi chạy trên engine SQL thật cùng schema migration thật.
// Nguồn canonical: docs/applications/transactional-mailer-job/01-architecture.md §9.2.1,
// §9.2.2, §9.5, §10; docs/applications/transactional-mailer-job/03-operations.md §3.1.
//
// Suite này KHÔNG wire runtime: không Queue consumer, không provider call, không
// scheduled handler — đúng ranh giới J1.

import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  MailJobValidationError,
  MalformedMailJobStateError,
  dispositionForControlPlaneOutcome,
  type ExecutionResultOutcome,
} from '@ecoma-io/transactional-mailer-job-application';
import {
  D1MailJobRepository,
  D1QuarantineRepository,
  type D1DatabaseLike,
} from '@ecoma-io/transactional-mailer-job-infrastructure';

// Không gửi telemetri khi spawn wrangler trong test.
process.env['WRANGLER_SEND_METRICS'] = 'false';

const requireFromSpec = createRequire(import.meta.url);
// `wrangler` là devDependency ở root; getPlatformProxy khởi động workerd/miniflare
// trong tiến trình, cho D1 binding thật với bound parameter và `meta.changes`.
const { getPlatformProxy } = requireFromSpec('wrangler') as typeof import('wrangler');

// Suite nằm ở `tests/integrations/`, hai cấp dưới root app — đi lên hai cấp mới ra appDir.
const appDir = dirname(dirname(import.meta.dirname));
const migrationsDir = join(appDir, 'migrations');

/** Mốc thời gian tuyệt đối — mọi biên được tính trên giá trị tường minh, không dùng đồng hồ. */
const T0 = 1_800_000_000_000;
const LEASE_MS = 30_000;
const MAX_EXECUTION_ATTEMPTS = 3;
const REPORT_LEASE_MS = 10_000;
const MAX_REPORT_ATTEMPTS = 5;

type MailJobEnv = { readonly 'mail-job': D1DatabaseLike };

let proxy: { env: MailJobEnv; dispose(): Promise<unknown> } | null = null;
let persistDir = '';
let db: D1DatabaseLike;
let repo: D1MailJobRepository;
let quarantine: D1QuarantineRepository;

/**
 * Tách statement từ file migration.
 *
 * D1 `prepare().run()` từ chối "comment-only segment" (nó cắt quanh `;` nên một đoạn
 * chỉ có `-- ...` làm câu lệnh hỏng), nên comment dòng bị bỏ trước khi tách. Text của
 * statement giữ nguyên từng byte còn lại — không có chuỗi nào trong migration chứa
 * `--` bên trong quote nên cách cắt này an toàn với đúng bộ migration hiện có.
 */
function statementsOf(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/gu, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function rawRows(
  sql: string,
  ...binds: readonly unknown[]
): Promise<readonly Record<string, unknown>[]> {
  const statement =
    binds.length === 0
      ? db.prepare<Record<string, unknown>>(sql)
      : db.prepare<Record<string, unknown>>(sql).bind(...binds);
  const { results } = await statement.all();
  return results ?? [];
}

/** Chèn thẳng một row (parameterized) để dựng trạng thái mà port không tạo ra được. */
async function insertRawRow(
  deliveryId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const row: Record<string, unknown> = {
    delivery_id: deliveryId,
    message_id: null,
    dispatch_generation: 1,
    execution_generation: 0,
    lease_owner: null,
    lease_expires_at: null,
    status: 'processing',
    attempts: 0,
    last_error: null,
    last_error_class: null,
    provider_message_id: null,
    outcome_report_state: 'none',
    report_lease_owner: null,
    report_lease_expires_at: null,
    report_attempts: 0,
    blocked_at: null,
    created_at: T0 - 1_000,
    updated_at: T0 - 1_000,
    ...overrides,
  };
  const columns = Object.keys(row);
  await db
    .prepare(
      `INSERT INTO mail_jobs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .bind(...columns.map((column) => row[column]))
    .run();
}

/** Row đã tồn tại + chưa lease — trạng thái đầu vào chuẩn cho mọi claim. */
async function seedPending(deliveryId: string, dispatchGeneration = 1): Promise<void> {
  const result = await repo.createPendingJob({
    deliveryId,
    dispatchGeneration,
    createdAt: T0 - 1_000,
    updatedAt: T0 - 1_000,
  });
  expect(result.kind).toBe('created');
}

async function loadOrThrow(deliveryId: string) {
  const record = await repo.loadJobByDeliveryId(deliveryId);
  if (record === null) {
    throw new Error(`expected row ${deliveryId} to exist`);
  }
  return record;
}

async function claimOrThrow(
  deliveryId: string,
  owner: string,
  nowMs: number,
  dispatchGeneration = 1,
) {
  const result = await repo.claimSameGeneration({
    deliveryId,
    dispatchGeneration,
    owner,
    nowMs,
    leaseMs: LEASE_MS,
    maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
  });
  if (result.kind !== 'claimed') {
    throw new Error(`expected claim to succeed, got denied: ${result.reason}`);
  }
  return result.record;
}

/** Claim + persist `sent` — dựng trạng thái terminal có report `pending`. */
async function makeSentWithPendingReport(deliveryId: string): Promise<void> {
  await seedPending(deliveryId);
  await claimOrThrow(deliveryId, 'owner-a', T0);
  const persisted = await repo.persistExecutionResult({
    deliveryId,
    owner: 'owner-a',
    executionGeneration: 1,
    dispatchGeneration: 1,
    nowMs: T0 + 1_000,
    outcome: 'sent',
    providerMessageId: 'provider-message-1',
  });
  expect(persisted.kind).toBe('applied');
}

beforeAll(async () => {
  persistDir = mkdtempSync(join(tmpdir(), 'transactional-mailer-job-repo-'));
  proxy = await getPlatformProxy<MailJobEnv>({
    configPath: join(appDir, 'wrangler.jsonc'),
    persist: { path: persistDir },
  });
  db = proxy.env['mail-job'];

  // Áp toàn bộ migration hiện có theo đúng thứ tự tên file (0001, 0002, ...) trên
  // database tạm mới — cùng nội dung mà `wrangler d1 migrations apply` áp (ca riêng
  // của migrations.spec.ts).
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  if (migrationFiles.length < 2) {
    throw new Error(`expected at least two migrations under ${migrationsDir}`);
  }
  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    for (const statement of statementsOf(sql)) {
      await db.prepare(statement).run();
    }
  }

  repo = new D1MailJobRepository({ db });
  quarantine = new D1QuarantineRepository({ db });
}, 120_000);

afterAll(async () => {
  await proxy?.dispose();
  if (persistDir !== '') {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await db.prepare('DELETE FROM mail_jobs').run();
  await db.prepare('DELETE FROM quarantine').run();
});

describe('schema on a clean database', () => {
  it('creates both tables with every named constraint and sweep index', async () => {
    const tables = (await rawRows(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map(
      (row) => String(row['name']),
    );
    expect(tables).toEqual(expect.arrayContaining(['mail_jobs', 'quarantine']));

    const mailJobsSql = await rawRows(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_jobs'`,
    );
    const ddl = String(mailJobsSql[0]?.['sql'] ?? '');
    for (const constraint of [
      'mail_jobs_pkey',
      'mail_jobs_status_check',
      'mail_jobs_outcome_report_state_check',
      'mail_jobs_lease_pair_check',
      'mail_jobs_report_lease_pair_check',
      'mail_jobs_blocked_at_parity_check',
      'mail_jobs_report_state_parity_check',
      'mail_jobs_delivery_id_non_empty_check',
      'mail_jobs_dispatch_generation_check',
      'mail_jobs_attempts_check',
      'mail_jobs_report_attempts_check',
    ]) {
      expect(ddl).toContain(`CONSTRAINT ${constraint}`);
    }

    const quarantineSql = await rawRows(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quarantine'`,
    );
    const quarantineDdl = String(quarantineSql[0]?.['sql'] ?? '');
    for (const constraint of [
      'quarantine_pkey',
      'quarantine_reason_check',
      'quarantine_forbidden_field_name_check',
      'quarantine_attempts_check',
    ]) {
      expect(quarantineDdl).toContain(`CONSTRAINT ${constraint}`);
    }

    const indexes = (await rawRows(`SELECT name FROM sqlite_master WHERE type = 'index'`)).map(
      (row) => String(row['name']),
    );
    expect(indexes).toEqual(
      expect.arrayContaining(['mail_jobs_report_sweep_idx', 'mail_jobs_status_lease_idx']),
    );
  });

  it('rejects an unknown status at the schema level before any reader sees it', async () => {
    await seedPending('delivery-schema-check');

    // CHECK constraint của schema chặn status ngoài tập closed ngay tại statement —
    // lớp bảo vệ thứ hai sau assertClosedValue của repository.
    await expect(
      db
        .prepare(`UPDATE mail_jobs SET status = 'weird' WHERE delivery_id = ?`)
        .bind('delivery-schema-check')
        .run(),
    ).rejects.toThrow(/mail_jobs_status_check/u);
  });
});

describe('createPendingJob', () => {
  it('creates a row that holds no lease and consumes no budget', async () => {
    await seedPending('delivery-create');

    const record = await loadOrThrow('delivery-create');
    expect(record.status).toBe('processing');
    expect(record.dispatchGeneration).toBe(1);
    expect(record.executionGeneration).toBe(0);
    expect(record.attempts).toBe(0);
    expect(record.leaseOwner).toBeNull();
    expect(record.leaseExpiresAt).toBeNull();
    expect(record.outcomeReportState).toBe('none');
    expect(record.reportAttempts).toBe(0);
  });

  it('grants exactly one insert when executions race on the same delivery id', async () => {
    const outcomes = await Promise.all(
      [1, 2, 3].map(() =>
        repo.createPendingJob({
          deliveryId: 'delivery-race',
          dispatchGeneration: 1,
          createdAt: T0,
          updatedAt: T0,
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.kind === 'created')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'duplicate')).toHaveLength(2);
    const rows = await rawRows(
      `SELECT delivery_id FROM mail_jobs WHERE delivery_id = ?`,
      'delivery-race',
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects an empty delivery id before any statement runs', async () => {
    await expect(
      repo.createPendingJob({
        deliveryId: '',
        dispatchGeneration: 1,
        createdAt: T0,
        updatedAt: T0,
      }),
    ).rejects.toThrow(MailJobValidationError);

    const rows = await rawRows(`SELECT delivery_id FROM mail_jobs`);
    expect(rows).toHaveLength(0);
  });

  it('rejects an empty messageId before insert — decoder would reject "" forever', async () => {
    await expect(
      repo.createPendingJob({
        deliveryId: 'delivery-empty-message-id',
        messageId: '',
        dispatchGeneration: 1,
        createdAt: T0,
        updatedAt: T0,
      }),
    ).rejects.toThrow(MailJobValidationError);
    const rows = await rawRows(
      `SELECT delivery_id FROM mail_jobs WHERE delivery_id = ?`,
      'delivery-empty-message-id',
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects an over-bound delivery id', async () => {
    await expect(
      repo.createPendingJob({
        deliveryId: 'd'.repeat(129),
        dispatchGeneration: 1,
        createdAt: T0,
        updatedAt: T0,
      }),
    ).rejects.toThrow(/at most 128 code points/u);
    const rows = await rawRows(`SELECT COUNT(*) AS n FROM mail_jobs`);
    expect(rows).toEqual([{ n: 0 }]);
  });
});

describe('claimSameGeneration', () => {
  it('grants exactly one owner among concurrent claims and denies the rest as lease-active', async () => {
    await seedPending('delivery-concurrent-claim');

    const outcomes = await Promise.all(
      ['owner-1', 'owner-2', 'owner-3', 'owner-4', 'owner-5'].map((owner) =>
        repo.claimSameGeneration({
          deliveryId: 'delivery-concurrent-claim',
          dispatchGeneration: 1,
          owner,
          nowMs: T0,
          leaseMs: LEASE_MS,
          maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
        }),
      ),
    );

    const winners = outcomes.filter((outcome) => outcome.kind === 'claimed');
    expect(winners).toHaveLength(1);
    // Mọi denial phải đúng lý do "lease còn hiệu lực" — không phân loại lung tung.
    const denialReasons = outcomes.flatMap((outcome) =>
      outcome.kind === 'denied' ? [outcome.reason] : [],
    );
    expect(denialReasons).toHaveLength(outcomes.length - 1);
    expect(new Set(denialReasons)).toEqual(new Set(['lease-active']));

    const record = await loadOrThrow('delivery-concurrent-claim');
    expect(record.attempts).toBe(1);
    expect(record.executionGeneration).toBe(1);
    expect(record.leaseOwner).toBe(
      winners[0]?.kind === 'claimed' ? winners[0].record.leaseOwner : null,
    );
    expect(record.leaseExpiresAt).toBe(T0 + LEASE_MS);
    expect(record.status).toBe('processing');
    expect(record.outcomeReportState).toBe('none');
  });

  it('suppresses a duplicate queue delivery while the first lease is live', async () => {
    await seedPending('delivery-duplicate');
    const first = await claimOrThrow('delivery-duplicate', 'owner-a', T0);

    // Cùng owner và owner khác — cả hai đều là "message tới lần hai"; cả hai đều bị
    // từ chối, row không đổi (không attempt thứ hai, không execution thứ hai).
    const sameOwner = await repo.claimSameGeneration({
      deliveryId: 'delivery-duplicate',
      dispatchGeneration: 1,
      owner: 'owner-a',
      nowMs: T0 + 1,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    const otherOwner = await repo.claimSameGeneration({
      deliveryId: 'delivery-duplicate',
      dispatchGeneration: 1,
      owner: 'owner-b',
      nowMs: T0 + 1,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });

    expect(sameOwner).toEqual({ kind: 'denied', reason: 'lease-active' });
    expect(otherOwner).toEqual({ kind: 'denied', reason: 'lease-active' });
    const record = await loadOrThrow('delivery-duplicate');
    expect(record.attempts).toBe(first.attempts);
    expect(record.executionGeneration).toBe(first.executionGeneration);
    expect(record.leaseOwner).toBe('owner-a');
  });

  it('denies claims whose generation does not match the row', async () => {
    await seedPending('delivery-gen', 2);

    const stale = await repo.claimSameGeneration({
      deliveryId: 'delivery-gen',
      dispatchGeneration: 1,
      owner: 'owner-a',
      nowMs: T0,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(stale).toEqual({ kind: 'denied', reason: 'generation-mismatch' });

    const fresh = await repo.claimSameGeneration({
      deliveryId: 'delivery-gen',
      dispatchGeneration: 2,
      owner: 'owner-a',
      nowMs: T0,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(fresh.kind).toBe('claimed');
  });

  it('reports missing-job for an unknown delivery without creating anything', async () => {
    const result = await repo.claimSameGeneration({
      deliveryId: 'delivery-unknown',
      dispatchGeneration: 1,
      owner: 'owner-a',
      nowMs: T0,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });

    expect(result).toEqual({ kind: 'denied', reason: 'missing-job' });
    const rows = await rawRows(`SELECT delivery_id FROM mail_jobs`);
    expect(rows).toHaveLength(0);
  });

  it('hands the lease over exactly at the expiry boundary and consumes budget B', async () => {
    await seedPending('delivery-boundary');
    await claimOrThrow('delivery-boundary', 'owner-a', T0);

    // Còn 1ms trước khi hết hạn: chưa ai khác claim được.
    const tooEarly = await repo.claimSameGeneration({
      deliveryId: 'delivery-boundary',
      dispatchGeneration: 1,
      owner: 'owner-b',
      nowMs: T0 + LEASE_MS - 1,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(tooEarly).toEqual({ kind: 'denied', reason: 'lease-active' });

    // Đúng tại `lease_expires_at` guard `<= :now` mở: owner mới claim, B tăng.
    const handed = await repo.claimSameGeneration({
      deliveryId: 'delivery-boundary',
      dispatchGeneration: 1,
      owner: 'owner-b',
      nowMs: T0 + LEASE_MS,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(handed.kind).toBe('claimed');

    const record = await loadOrThrow('delivery-boundary');
    expect(record.attempts).toBe(2);
    expect(record.executionGeneration).toBe(2);
    expect(record.leaseOwner).toBe('owner-b');
    expect(record.leaseExpiresAt).toBe(T0 + LEASE_MS + LEASE_MS);
  });

  it('denies claiming a terminal row', async () => {
    await seedPending('delivery-terminal');
    await claimOrThrow('delivery-terminal', 'owner-a', T0);
    const persisted = await repo.persistExecutionResult({
      deliveryId: 'delivery-terminal',
      owner: 'owner-a',
      executionGeneration: 1,
      dispatchGeneration: 1,
      nowMs: T0 + 1_000,
      outcome: 'sent',
    });
    expect(persisted.kind).toBe('applied');

    const result = await repo.claimSameGeneration({
      deliveryId: 'delivery-terminal',
      dispatchGeneration: 1,
      owner: 'owner-b',
      nowMs: T0 + LEASE_MS + 1_000,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(result).toEqual({ kind: 'denied', reason: 'terminal' });
  });

  it('reports budget-exhausted once budget B is spent and no lease is held', async () => {
    await seedPending('delivery-budget');
    // Ba lần claim liên tiếp qua đúng ranh giới expiry → attempts = max.
    await claimOrThrow('delivery-budget', 'owner-1', T0);
    await claimOrThrow('delivery-budget', 'owner-2', T0 + LEASE_MS);
    await claimOrThrow('delivery-budget', 'owner-3', T0 + 2 * LEASE_MS);
    expect((await loadOrThrow('delivery-budget')).attempts).toBe(MAX_EXECUTION_ATTEMPTS);

    const result = await repo.claimSameGeneration({
      deliveryId: 'delivery-budget',
      dispatchGeneration: 1,
      owner: 'owner-4',
      nowMs: T0 + 3 * LEASE_MS,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(result).toEqual({ kind: 'denied', reason: 'budget-exhausted' });
  });

  it('rejects invalid ownership and lease parameters before touching D1', async () => {
    await expect(
      repo.claimSameGeneration({
        deliveryId: 'delivery-validation',
        dispatchGeneration: 1,
        owner: '',
        nowMs: T0,
        leaseMs: LEASE_MS,
        maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
      }),
    ).rejects.toThrow(MailJobValidationError);

    await expect(
      repo.claimSameGeneration({
        deliveryId: 'delivery-validation',
        dispatchGeneration: 1,
        owner: 'owner-a',
        nowMs: T0,
        leaseMs: 0,
        maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
      }),
    ).rejects.toThrow(MailJobValidationError);

    const rows = await rawRows(`SELECT delivery_id FROM mail_jobs`);
    expect(rows).toHaveLength(0);
  });
});

describe('claimGenerationAdvance', () => {
  it('advances a blocked row to a newer generation and resets budget B', async () => {
    // Dẫn row tới `blocked` qua đúng đường: B kiệt rồi statement (c).
    const blockedDeliveryId = 'delivery-advance';
    await seedPending(blockedDeliveryId);
    await claimOrThrow(blockedDeliveryId, 'owner-1', T0);
    await claimOrThrow(blockedDeliveryId, 'owner-2', T0 + LEASE_MS);
    await claimOrThrow(blockedDeliveryId, 'owner-3', T0 + 2 * LEASE_MS);
    const blocked = await repo.markBlockedBudgetExhausted({
      deliveryId: blockedDeliveryId,
      dispatchGeneration: 1,
      nowMs: T0 + 3 * LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(blocked.kind).toBe('applied');

    const advanced = await repo.claimGenerationAdvance({
      deliveryId: blockedDeliveryId,
      newDispatchGeneration: 2,
      owner: 'owner-redrive',
      nowMs: T0 + 4 * LEASE_MS,
      leaseMs: LEASE_MS,
    });
    expect(advanced.kind).toBe('claimed');

    const record = await loadOrThrow(blockedDeliveryId);
    expect(record.dispatchGeneration).toBe(2);
    expect(record.attempts).toBe(1);
    expect(record.executionGeneration).toBeGreaterThan(0);
    expect(record.status).toBe('processing');
    expect(record.blockedAt).toBeNull();
    expect(record.outcomeReportState).toBe('none');
    expect(record.leaseOwner).toBe('owner-redrive');
    expect(record.reportLeaseOwner).toBeNull();
    expect(record.reportAttempts).toBe(0);
  });

  it('waits for a live lease of the old generation before advancing', async () => {
    await seedPending('delivery-advance-lease');
    await claimOrThrow('delivery-advance-lease', 'owner-a', T0);

    const tooEarly = await repo.claimGenerationAdvance({
      deliveryId: 'delivery-advance-lease',
      newDispatchGeneration: 2,
      owner: 'owner-redrive',
      nowMs: T0 + LEASE_MS - 1,
      leaseMs: LEASE_MS,
    });
    expect(tooEarly).toEqual({ kind: 'denied', reason: 'lease-active' });

    const onTime = await repo.claimGenerationAdvance({
      deliveryId: 'delivery-advance-lease',
      newDispatchGeneration: 2,
      owner: 'owner-redrive',
      nowMs: T0 + LEASE_MS,
      leaseMs: LEASE_MS,
    });
    expect(onTime.kind).toBe('claimed');
  });

  it('refuses an authority that is not strictly newer and never regresses the row', async () => {
    await seedPending('delivery-advance-stale');
    const same = await repo.claimGenerationAdvance({
      deliveryId: 'delivery-advance-stale',
      newDispatchGeneration: 1,
      owner: 'owner-redrive',
      nowMs: T0,
      leaseMs: LEASE_MS,
    });
    expect(same).toEqual({ kind: 'denied', reason: 'generation-not-newer' });

    const advanced = await repo.claimGenerationAdvance({
      deliveryId: 'delivery-advance-stale',
      newDispatchGeneration: 3,
      owner: 'owner-redrive',
      nowMs: T0,
      leaseMs: LEASE_MS,
    });
    expect(advanced.kind).toBe('claimed');

    // Generation cũ hơn bao giờ giờ cũng bị từ chối — không có đường reset về cũ.
    const regress = await repo.claimGenerationAdvance({
      deliveryId: 'delivery-advance-stale',
      newDispatchGeneration: 2,
      owner: 'owner-old',
      nowMs: T0 + 1,
      leaseMs: LEASE_MS,
    });
    expect(regress).toEqual({ kind: 'denied', reason: 'generation-not-newer' });
    expect((await loadOrThrow('delivery-advance-stale')).dispatchGeneration).toBe(3);
  });

  it('clears a live report lease and report attempts of the old generation on advance', async () => {
    // Statement (b) phải xoá report-lease + report_attempts của generation cũ;
    // nếu giữ lại, acquire report-lease (d) của generation mới bị chặn tới
    // report_lease_expires_at. Row seed tay để có report lease đang sống.
    await insertRawRow('delivery-advance-report', {
      status: 'blocked',
      attempts: MAX_EXECUTION_ATTEMPTS,
      outcome_report_state: 'pending',
      report_lease_owner: 'reporter-old',
      report_lease_expires_at: T0 + REPORT_LEASE_MS,
      report_attempts: 2,
      blocked_at: T0 - 1_000,
    });

    const advanced = await repo.claimGenerationAdvance({
      deliveryId: 'delivery-advance-report',
      newDispatchGeneration: 2,
      owner: 'owner-redrive',
      nowMs: T0, // report lease của generation cũ vẫn đang sống tại đây
      leaseMs: LEASE_MS,
    });
    expect(advanced.kind).toBe('claimed');

    const record = await loadOrThrow('delivery-advance-report');
    expect(record.reportLeaseOwner).toBeNull();
    expect(record.reportLeaseExpiresAt).toBeNull();
    expect(record.reportAttempts).toBe(0);
    expect(record.outcomeReportState).toBe('none');
  });

  it('advances concurrently so that exactly one authority wins', async () => {
    // §9.2.2 #11: hai consumer advance đồng thời — đúng một người thắng,
    // người kia bị từ chối với generation-not-newer.
    await seedPending('delivery-advance-concurrent');
    const outcomes = await Promise.all([
      repo.claimGenerationAdvance({
        deliveryId: 'delivery-advance-concurrent',
        newDispatchGeneration: 2,
        owner: 'owner-redrive',
        nowMs: T0,
        leaseMs: LEASE_MS,
      }),
      repo.claimGenerationAdvance({
        deliveryId: 'delivery-advance-concurrent',
        newDispatchGeneration: 2,
        owner: 'owner-redrive',
        nowMs: T0,
        leaseMs: LEASE_MS,
      }),
    ]);
    const kinds = outcomes.map((outcome) => outcome.kind);
    expect(new Set(kinds)).toEqual(new Set(['claimed', 'denied']));
    const denied = outcomes.find((outcome) => outcome.kind === 'denied');
    expect(denied).toMatchObject({ reason: 'generation-not-newer' });

    const record = await loadOrThrow('delivery-advance-concurrent');
    expect(record.dispatchGeneration).toBe(2);
    expect(record.leaseOwner).toBe('owner-redrive');
  });

  it('lets the old generation persist its own result after a denied advance', async () => {
    // §9.2.2 #12: advance bị từ chối vì lease cũ còn sống — execution của
    // generation cũ vẫn persist được kết quả của chính nó, generation không đổi.
    await seedPending('delivery-advance-vs-persist');
    await claimOrThrow('delivery-advance-vs-persist', 'owner-a', T0);
    const denied = await repo.claimGenerationAdvance({
      deliveryId: 'delivery-advance-vs-persist',
      newDispatchGeneration: 2,
      owner: 'owner-redrive',
      nowMs: T0 + 1_000,
      leaseMs: LEASE_MS,
    });
    expect(denied).toEqual({ kind: 'denied', reason: 'lease-active' });

    const persisted = await repo.persistExecutionResult({
      deliveryId: 'delivery-advance-vs-persist',
      owner: 'owner-a',
      executionGeneration: 1,
      dispatchGeneration: 1,
      nowMs: T0 + 1_500,
      outcome: 'sent',
      providerMessageId: 'provider-message-1',
    });
    expect(persisted.kind).toBe('applied');

    const record = await loadOrThrow('delivery-advance-vs-persist');
    expect(record.dispatchGeneration).toBe(1);
    expect(record.status).toBe('sent');
    expect(record.providerMessageId).toBe('provider-message-1');
  });

  it('does not advance a terminal row', async () => {
    await seedPending('delivery-advance-terminal');
    await claimOrThrow('delivery-advance-terminal', 'owner-a', T0);
    await repo.persistExecutionResult({
      deliveryId: 'delivery-advance-terminal',
      owner: 'owner-a',
      executionGeneration: 1,
      dispatchGeneration: 1,
      nowMs: T0 + 1_000,
      outcome: 'failed',
      lastError: 'smtp-550',
      lastErrorClass: 'permanent',
    });

    const result = await repo.claimGenerationAdvance({
      deliveryId: 'delivery-advance-terminal',
      newDispatchGeneration: 2,
      owner: 'owner-redrive',
      nowMs: T0 + 2_000,
      leaseMs: LEASE_MS,
    });
    expect(result).toEqual({ kind: 'denied', reason: 'terminal' });
  });
});

describe('markBlockedBudgetExhausted', () => {
  it('marks an exhausted lease-free job blocked with a pending report', async () => {
    await seedPending('delivery-c');
    await claimOrThrow('delivery-c', 'owner-1', T0);
    await claimOrThrow('delivery-c', 'owner-2', T0 + LEASE_MS);
    await claimOrThrow('delivery-c', 'owner-3', T0 + 2 * LEASE_MS);

    // Lease của slot cuối còn hiệu lực tới T0 + 3*LEASE_MS: (c) KHÔNG được cắt ngang.
    const tooEarly = await repo.markBlockedBudgetExhausted({
      deliveryId: 'delivery-c',
      dispatchGeneration: 1,
      nowMs: T0 + 3 * LEASE_MS - 1,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(tooEarly).toEqual({ kind: 'denied', reason: 'lease-active' });

    const applied = await repo.markBlockedBudgetExhausted({
      deliveryId: 'delivery-c',
      dispatchGeneration: 1,
      nowMs: T0 + 3 * LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(applied.kind).toBe('applied');

    const record = await loadOrThrow('delivery-c');
    expect(record.status).toBe('blocked');
    expect(record.blockedAt).toBe(T0 + 3 * LEASE_MS);
    expect(record.lastErrorClass).toBe('execution-budget-exhausted');
    expect(record.outcomeReportState).toBe('pending');
    expect(record.leaseOwner).toBeNull();

    // Ứng dụng lần nữa là idempotent, không phải lỗi và không phải thành công giả.
    const again = await repo.markBlockedBudgetExhausted({
      deliveryId: 'delivery-c',
      dispatchGeneration: 1,
      nowMs: T0 + 4 * LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(again).toEqual({ kind: 'denied', reason: 'already-blocked' });
  });

  it('reports budget-not-exhausted before the bound', async () => {
    await seedPending('delivery-c-early');
    await claimOrThrow('delivery-c-early', 'owner-1', T0);

    const result = await repo.markBlockedBudgetExhausted({
      deliveryId: 'delivery-c-early',
      dispatchGeneration: 1,
      nowMs: T0 + LEASE_MS + 1,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(result).toEqual({ kind: 'denied', reason: 'budget-not-exhausted' });
    expect((await loadOrThrow('delivery-c-early')).status).toBe('processing');
  });
});

describe('markProviderCallBoundary — statement (e)', () => {
  it('writes the marker once under a live claim', async () => {
    await seedPending('delivery-boundary');
    const claimed = await claimOrThrow('delivery-boundary', 'owner-a', T0);

    const marked = await repo.markProviderCallBoundary({
      deliveryId: 'delivery-boundary',
      owner: 'owner-a',
      executionGeneration: claimed.executionGeneration,
      dispatchGeneration: claimed.dispatchGeneration,
      nowMs: T0 + 1,
    });
    if (marked.kind !== 'applied') {
      throw new Error('expected marker to apply');
    }
    expect(marked.record.providerCallAt).toBe(T0 + 1);

    // First-write-only: lần gọi thứ hai (caller lặp, crash replay…) KHÔNG đụng mốc.
    const again = await repo.markProviderCallBoundary({
      deliveryId: 'delivery-boundary',
      owner: 'owner-a',
      executionGeneration: claimed.executionGeneration,
      dispatchGeneration: claimed.dispatchGeneration,
      nowMs: T0 + 2,
    });
    expect(again).toEqual({
      kind: 'denied',
      reason: 'already-marked',
      record: await loadOrThrow('delivery-boundary'),
    });
    expect((await loadOrThrow('delivery-boundary')).providerCallAt).toBe(T0 + 1);
  });

  it('keeps the marker across lease reclaim and a newer execution generation', async () => {
    // Marker không reset khi execution khác reclaim (lease hết hạn, claim lại) — nó là
    // state theo **delivery**, không phải theo attempt; đúng cơ sở để cửa sổ an toàn của
    // auto-resend tính từ lần chạm provider đầu tiên.
    await seedPending('delivery-marker-persist');
    const claimed = await claimOrThrow('delivery-marker-persist', 'owner-a', T0);
    await repo.markProviderCallBoundary({
      deliveryId: 'delivery-marker-persist',
      owner: 'owner-a',
      executionGeneration: claimed.executionGeneration,
      dispatchGeneration: claimed.dispatchGeneration,
      nowMs: T0 + 1,
    });

    // Lease hết hạn, execution khác claim lại (token tăng) rồi cũng chạm ranh giới.
    const reclaimed = await claimOrThrow('delivery-marker-persist', 'owner-b', T0 + LEASE_MS);
    expect(reclaimed.executionGeneration).toBe(claimed.executionGeneration + 1);

    // Owner mới cũng nhận `already-marked` — marker KHÔNG reset theo generation mới.
    const markedByNewOwner = await repo.markProviderCallBoundary({
      deliveryId: 'delivery-marker-persist',
      owner: 'owner-b',
      executionGeneration: reclaimed.executionGeneration,
      dispatchGeneration: reclaimed.dispatchGeneration,
      nowMs: T0 + LEASE_MS + 1,
    });
    expect(markedByNewOwner).toEqual({
      kind: 'denied',
      reason: 'already-marked',
      record: await loadOrThrow('delivery-marker-persist'),
    });
    expect((await loadOrThrow('delivery-marker-persist')).providerCallAt).toBe(T0 + 1);
  });

  it('rejects a stale writer with lease-lost and writes nothing', async () => {
    await seedPending('delivery-stale-boundary');
    const claimed = await claimOrThrow('delivery-stale-boundary', 'owner-a', T0);
    // Lease của owner-a hết hạn, owner-b claim (token tăng).
    await claimOrThrow('delivery-stale-boundary', 'owner-b', T0 + LEASE_MS);

    const result = await repo.markProviderCallBoundary({
      deliveryId: 'delivery-stale-boundary',
      owner: 'owner-a',
      executionGeneration: claimed.executionGeneration,
      dispatchGeneration: claimed.dispatchGeneration,
      nowMs: T0 + LEASE_MS + 1,
    });
    expect(result).toEqual({
      kind: 'denied',
      reason: 'lease-lost',
      record: await loadOrThrow('delivery-stale-boundary'),
    });
    expect((await loadOrThrow('delivery-stale-boundary')).providerCallAt).toBeNull();
  });
});

describe('markProviderAmbiguityBlocked — statement (g)', () => {
  it('blocks an exhausted job outside the safe window with the ambiguity class', async () => {
    await seedPending('delivery-ambiguity');
    await claimOrThrow('delivery-ambiguity', 'owner-1', T0);
    await claimOrThrow('delivery-ambiguity', 'owner-2', T0 + LEASE_MS);
    const claimed = await claimOrThrow('delivery-ambiguity', 'owner-3', T0 + 2 * LEASE_MS);

    // Mark ranh giới (owner-3 đang giữ lease) để đóng dấu mơ hồ.
    await repo.markProviderCallBoundary({
      deliveryId: 'delivery-ambiguity',
      owner: 'owner-3',
      executionGeneration: claimed.executionGeneration,
      dispatchGeneration: claimed.dispatchGeneration,
      nowMs: T0 + 2 * LEASE_MS + 1,
    });

    const applied = await repo.markProviderAmbiguityBlocked({
      deliveryId: 'delivery-ambiguity',
      dispatchGeneration: 1,
      nowMs: T0 + 3 * LEASE_MS,
    });
    expect(applied.kind).toBe('applied');

    const record = await loadOrThrow('delivery-ambiguity');
    expect(record.status).toBe('blocked');
    expect(record.lastErrorClass).toBe('provider-ambiguous-outcome');
    expect(record.lastError).toBeNull();
    expect(record.blockedAt).toBe(T0 + 3 * LEASE_MS);
    expect(record.outcomeReportState).toBe('pending');
    expect(record.leaseOwner).toBeNull();
    // Marker KHÔNG bị đụng — vẫn là mốc attempt đầu tiên chạm provider.
    expect(record.providerCallAt).toBe(T0 + 2 * LEASE_MS + 1);
  });

  it('keeps the legacy budget-exhausted semantics intact for a job without the marker', async () => {
    // Cùng generation, nhưng KHÔNG marker ⇒ statement (g) từ chối với `unmarked`:
    // đặc tính của statement là chốt ambiguity, chỉ mở khi marker tồn tại — job chưa
    // từng chạm ranh giới gọi provider không thuộc đường chốt này.
    await seedPending('delivery-ambiguity-nomarker');
    await claimOrThrow('delivery-ambiguity-nomarker', 'owner-1', T0);
    await claimOrThrow('delivery-ambiguity-nomarker', 'owner-2', T0 + LEASE_MS);
    await claimOrThrow('delivery-ambiguity-nomarker', 'owner-3', T0 + 2 * LEASE_MS);

    const result = await repo.markProviderAmbiguityBlocked({
      deliveryId: 'delivery-ambiguity-nomarker',
      dispatchGeneration: 1,
      nowMs: T0 + 3 * LEASE_MS,
    });
    expect(result).toEqual({
      kind: 'denied',
      reason: 'unmarked',
      record: await loadOrThrow('delivery-ambiguity-nomarker'),
    });
    expect((await loadOrThrow('delivery-ambiguity-nomarker')).lastErrorClass).toBeNull();
  });

  it('denies with unmarked while the delivery has never reached the provider boundary', async () => {
    // Statement (g) là khép khóa theo tuổi marker, không theo ngân sách B: mơ hồ ngoài
    // cửa sổ phải chốt được ở bất kỳ attempt nào — chỉ chốt khi `attempts` cạn sẽ để
    // redelivery gọi lại provider ngoài cửa sổ (duplicate không chống được).
    await seedPending('delivery-ambiguity-early');

    const result = await repo.markProviderAmbiguityBlocked({
      deliveryId: 'delivery-ambiguity-early',
      dispatchGeneration: 1,
      nowMs: T0,
    });
    expect(result).toEqual({
      kind: 'denied',
      reason: 'unmarked',
      record: await loadOrThrow('delivery-ambiguity-early'),
    });
    expect((await loadOrThrow('delivery-ambiguity-early')).status).toBe('processing');
  });
});

describe('redrive of a provider-ambiguous-outcome job re-blocks on a stale marker', () => {
  it('re-blocks immediately on the first post-redrive attempt and never opens a second provider window', async () => {
    // Trạng thái đầu vào: job đã `blocked` (`provider-ambiguous-outcome`) với marker ngoài
    // cửa sổ từ trước khi block (đúng tình huống §9.4 bước 0 + `03-operations.md` §3.1
    // hàng 8a). Operator redrive có authorize ⇒ statement (b) claim sang generation mới.
    // Kỳ vọng: attempt đầu của generation mới KHÔNG mở lại cửa sổ gọi provider —
    // statement (e) trả `already-marked` với marker cũ (per-delivery, không reset), và
    // statement (g) chốt `blocked` lại ngay. Marker giữ nguyên mốc gốc xuyên generation.
    const newGen = 2;
    await insertRawRow('delivery-redrive-reblock', {
      status: 'blocked',
      last_error_class: 'provider-ambiguous-outcome',
      outcome_report_state: 'pending',
      provider_call_at: T0 - 25 * 60 * 60 * 1000, // marker stale: ngoài cửa sổ 24h từ T0
      blocked_at: T0 - 1_000,
    });

    // Redrive: statement (b) đưa row sang generation mới, nhận lease, trong khi marker
    // vẫn là mốc cũ của generation trước (SET clause của (b) không đụng cột này).
    const advanced = await repo.claimGenerationAdvance({
      deliveryId: 'delivery-redrive-reblock',
      newDispatchGeneration: 2,
      owner: 'owner-redrive',
      nowMs: T0,
      leaseMs: LEASE_MS,
    });
    expect(advanced.kind).toBe('claimed');
    expect((await loadOrThrow('delivery-redrive-reblock')).dispatchGeneration).toBe(newGen);

    // Attempt đầu của generation mới chạm ranh giới gọi provider: statement (e) trả
    // `already-marked` kèm marker cũ — KHÔNG phải `applied`, tức không mở cửa sổ mới.
    const marked = await repo.markProviderCallBoundary({
      deliveryId: 'delivery-redrive-reblock',
      owner: 'owner-redrive',
      executionGeneration: 1,
      dispatchGeneration: newGen,
      nowMs: T0 + 1,
    });
    if (marked.kind !== 'denied' || marked.reason !== 'already-marked') {
      throw new Error(`expected already-marked denial, got ${JSON.stringify(marked)}`);
    }
    // Denial kèm `record`: record này là nguồn executor dùng để đo tuổi marker —
    // marker trong record phải là mốc gốc của generation trước, không mốc mới.
    expect(marked.record?.providerCallAt ?? null).toBe(T0 - 25 * 60 * 60 * 1000);
    expect((await loadOrThrow('delivery-redrive-reblock')).providerCallAt).toBe(
      T0 - 25 * 60 * 60 * 1000,
    );

    // executor đánh giá tuổi marker (`isWithinProviderSafeWindow`): 25h > 24h ⇒ false,
    // release lease không-kết-quả rồi statement (g) chốt `blocked` lại ngay attempt đầu.
    const released = await repo.releaseExecutionLease({
      deliveryId: 'delivery-redrive-reblock',
      owner: 'owner-redrive',
      executionGeneration: 1,
      dispatchGeneration: newGen,
      nowMs: T0 + 2,
      lastError: undefined,
      lastErrorClass: 'provider-ambiguous-outcome',
    });
    expect(released.kind).toBe('applied');

    const reblocked = await repo.markProviderAmbiguityBlocked({
      deliveryId: 'delivery-redrive-reblock',
      dispatchGeneration: newGen,
      nowMs: T0 + 3,
    });
    expect(reblocked.kind).toBe('applied');

    const record = await loadOrThrow('delivery-redrive-reblock');
    expect(record.status).toBe('blocked');
    expect(record.lastErrorClass).toBe('provider-ambiguous-outcome');
    expect(record.blockedAt).toBe(T0 + 3);
    expect(record.outcomeReportState).toBe('pending');
    expect(record.leaseOwner).toBeNull();
    // Marker KHÔNG bị reset bởi bất kỳ statement nào — mốc gốc của provider attempt
    // đầu tiên vẫn là "sự thật về thế giới", đo cửa sổ xuyên generation.
    expect(record.providerCallAt).toBe(T0 - 25 * 60 * 60 * 1000);
  });

  it('does not open a provider window on the first attempt when the redrive lands within the old marker window', async () => {
    // Đối chiếu biên: marker chỉ 1h tuổi ⇒ `already-marked` NHƯNG vẫn trong cửa sổ ⇒
    // executor vẫn được gọi lại (provider còn giữ key) — hành vi in-window là đường bình
    // thường, khác hẳn ca stale-marker ở trên. Test này khoá biên còn lại của cùng cơ chế.
    await insertRawRow('delivery-redrive-inwindow', {
      status: 'blocked',
      last_error_class: 'provider-ambiguous-outcome',
      outcome_report_state: 'pending',
      provider_call_at: T0 - 1 * 60 * 60 * 1000,
      blocked_at: T0 - 1_000,
    });

    const advanced = await repo.claimGenerationAdvance({
      deliveryId: 'delivery-redrive-inwindow',
      newDispatchGeneration: 2,
      owner: 'owner-redrive',
      nowMs: T0,
      leaseMs: LEASE_MS,
    });
    expect(advanced.kind).toBe('claimed');

    const marked = await repo.markProviderCallBoundary({
      deliveryId: 'delivery-redrive-inwindow',
      owner: 'owner-redrive',
      executionGeneration: 1,
      dispatchGeneration: 2,
      nowMs: T0 + 1,
    });
    if (marked.kind !== 'denied' || marked.reason !== 'already-marked') {
      throw new Error(`expected already-marked denial, got ${JSON.stringify(marked)}`);
    }
    // Contract của (e): denial `already-marked` luôn kèm `record` — executor quyết bằng
    // record này, không read-back riêng.
    expect(marked.record?.providerCallAt ?? null).toBe(T0 - 1 * 60 * 60 * 1000);
    // In-window: neo cửa sổ vẫn là marker gốc — KHÔNG mở lại từ thời điểm redrive.
    expect((await loadOrThrow('delivery-redrive-inwindow')).providerCallAt).toBe(
      T0 - 1 * 60 * 60 * 1000,
    );
  });
});

describe('renewExecutionLease', () => {
  it('extends the lease only for the current owner token', async () => {
    await seedPending('delivery-renew');
    const claimed = await claimOrThrow('delivery-renew', 'owner-a', T0);

    const renewed = await repo.renewExecutionLease({
      deliveryId: 'delivery-renew',
      owner: 'owner-a',
      executionGeneration: claimed.executionGeneration,
      nowMs: T0 + 1_000,
      leaseMs: LEASE_MS,
    });
    expect(renewed.kind).toBe('applied');
    expect((await loadOrThrow('delivery-renew')).leaseExpiresAt).toBe(T0 + 1_000 + LEASE_MS);

    const wrongOwner = await repo.renewExecutionLease({
      deliveryId: 'delivery-renew',
      owner: 'owner-b',
      executionGeneration: claimed.executionGeneration,
      nowMs: T0 + 2_000,
      leaseMs: LEASE_MS,
    });
    expect(wrongOwner).toEqual({ kind: 'denied', reason: 'lease-lost' });

    const wrongToken = await repo.renewExecutionLease({
      deliveryId: 'delivery-renew',
      owner: 'owner-a',
      executionGeneration: claimed.executionGeneration + 1,
      nowMs: T0 + 2_000,
      leaseMs: LEASE_MS,
    });
    expect(wrongToken).toEqual({ kind: 'denied', reason: 'lease-lost' });
  });
});

describe('persistExecutionResult', () => {
  const persistParams = {
    deliveryId: 'delivery-persist',
    owner: 'owner-a',
    executionGeneration: 1,
    dispatchGeneration: 1,
    nowMs: T0 + 1_000,
  };

  it('persists an acceptance as sent with a pending report and a released lease', async () => {
    await seedPending(persistParams.deliveryId);
    await claimOrThrow(persistParams.deliveryId, 'owner-a', T0);

    const result = await repo.persistExecutionResult({
      ...persistParams,
      outcome: 'sent',
      providerMessageId: 'provider-message-1',
    });
    expect(result.kind).toBe('applied');

    const record = await loadOrThrow(persistParams.deliveryId);
    expect(record.status).toBe('sent');
    expect(record.outcomeReportState).toBe('pending');
    expect(record.leaseOwner).toBeNull();
    expect(record.leaseExpiresAt).toBeNull();
    expect(record.providerMessageId).toBe('provider-message-1');
    expect(record.blockedAt).toBeNull();
    expect(record.lastError).toBeNull();
  });

  it('persists a permanent failure with its sanitized error token', async () => {
    await seedPending(persistParams.deliveryId);
    await claimOrThrow(persistParams.deliveryId, 'owner-a', T0);

    const result = await repo.persistExecutionResult({
      ...persistParams,
      outcome: 'failed',
      lastError: 'smtp-550',
      lastErrorClass: 'permanent',
    });
    expect(result.kind).toBe('applied');

    const record = await loadOrThrow(persistParams.deliveryId);
    expect(record.status).toBe('failed');
    expect(record.lastError).toBe('smtp-550');
    expect(record.lastErrorClass).toBe('permanent');
    expect(record.blockedAt).toBeNull();
    expect(record.outcomeReportState).toBe('pending');
  });

  it('persists a credential rejection as blocked with blocked_at set', async () => {
    await seedPending(persistParams.deliveryId);
    await claimOrThrow(persistParams.deliveryId, 'owner-a', T0);

    const result = await repo.persistExecutionResult({
      ...persistParams,
      outcome: 'blocked',
      lastError: 'http-401',
      lastErrorClass: 'credential',
    });
    expect(result.kind).toBe('applied');

    const record = await loadOrThrow(persistParams.deliveryId);
    expect(record.status).toBe('blocked');
    // Parity `blocked_at`: status blocked ⇔ blocked_at NOT NULL — thiếu ghi cột này
    // là vi phạm `mail_jobs_blocked_at_parity_check`.
    expect(record.blockedAt).toBe(persistParams.nowMs);
    expect(record.lastError).toBe('http-401');
    expect(record.lastErrorClass).toBe('credential');
    expect(record.outcomeReportState).toBe('pending');
    expect(record.leaseOwner).toBeNull();
  });

  it('rejects an outcome outside the persistable set before touching D1', async () => {
    await seedPending(persistParams.deliveryId);
    await claimOrThrow(persistParams.deliveryId, 'owner-a', T0);

    await expect(
      repo.persistExecutionResult({
        ...persistParams,
        outcome: 'processing' as ExecutionResultOutcome,
      }),
    ).rejects.toThrow(MailJobValidationError);

    const record = await loadOrThrow(persistParams.deliveryId);
    expect(record.status).toBe('processing');
    expect(record.leaseOwner).toBe('owner-a');
  });

  it('rejects an unsanitized error token before touching D1', async () => {
    await seedPending(persistParams.deliveryId);
    await claimOrThrow(persistParams.deliveryId, 'owner-a', T0);

    await expect(
      repo.persistExecutionResult({
        ...persistParams,
        outcome: 'failed',
        lastError: 'nguoi-nhan@example.test',
      }),
    ).rejects.toThrow(MailJobValidationError);

    expect((await loadOrThrow(persistParams.deliveryId)).lastError).toBeNull();
  });

  it('rejects an empty providerMessageId before the terminal UPDATE commits', async () => {
    // Nếu để `''` đi qua, UPDATE terminal được commit rồi đọc-lại mới ném —
    // caller nhận exception cho một write đã commit. Chặn ở writer-side.
    await seedPending(persistParams.deliveryId);
    await claimOrThrow(persistParams.deliveryId, 'owner-a', T0);

    await expect(
      repo.persistExecutionResult({
        ...persistParams,
        outcome: 'sent',
        providerMessageId: '',
      }),
    ).rejects.toThrow(MailJobValidationError);

    const record = await loadOrThrow(persistParams.deliveryId);
    expect(record.status).toBe('processing');
    expect(record.leaseOwner).toBe('owner-a');
    expect(record.providerMessageId).toBeNull();
  });

  it('refuses a stale owner after another execution reclaimed the lease', async () => {
    await seedPending('delivery-stale-owner');
    const original = await claimOrThrow('delivery-stale-owner', 'owner-a', T0);
    await claimOrThrow('delivery-stale-owner', 'owner-b', T0 + LEASE_MS);

    // Owner cũ dùng token + generation cũ: cả ba đường ghi đều phải bị từ chối.
    const stalePersist = await repo.persistExecutionResult({
      deliveryId: 'delivery-stale-owner',
      owner: 'owner-a',
      executionGeneration: original.executionGeneration,
      dispatchGeneration: 1,
      nowMs: T0 + LEASE_MS + 1_000,
      outcome: 'sent',
    });
    expect(stalePersist).toEqual({ kind: 'denied', reason: 'lease-lost' });

    const staleRelease = await repo.releaseExecutionLease({
      deliveryId: 'delivery-stale-owner',
      owner: 'owner-a',
      executionGeneration: original.executionGeneration,
      dispatchGeneration: 1,
      nowMs: T0 + LEASE_MS + 1_000,
    });
    expect(staleRelease).toEqual({ kind: 'denied', reason: 'lease-lost' });

    const staleRenew = await repo.renewExecutionLease({
      deliveryId: 'delivery-stale-owner',
      owner: 'owner-a',
      executionGeneration: original.executionGeneration,
      nowMs: T0 + LEASE_MS + 1_000,
      leaseMs: LEASE_MS,
    });
    expect(staleRenew).toEqual({ kind: 'denied', reason: 'lease-lost' });

    // Kết quả provider của execution đang sống không bị đè.
    const record = await loadOrThrow('delivery-stale-owner');
    expect(record.status).toBe('processing');
    expect(record.leaseOwner).toBe('owner-b');
    expect(record.executionGeneration).toBe(2);
  });

  it('refuses a persist carrying a stale dispatch generation', async () => {
    await seedPending('delivery-stale-gen', 2);
    await claimOrThrow('delivery-stale-gen', 'owner-a', T0, 2);

    const result = await repo.persistExecutionResult({
      deliveryId: 'delivery-stale-gen',
      owner: 'owner-a',
      executionGeneration: 1,
      dispatchGeneration: 1,
      nowMs: T0 + 1_000,
      outcome: 'sent',
    });
    expect(result).toEqual({ kind: 'denied', reason: 'lease-lost' });
    expect((await loadOrThrow('delivery-stale-gen')).status).toBe('processing');
  });

  it('does not rewrite a result that was already persisted', async () => {
    await seedPending('delivery-double-persist');
    await claimOrThrow('delivery-double-persist', 'owner-a', T0);

    const first = await repo.persistExecutionResult({
      ...persistParams,
      deliveryId: 'delivery-double-persist',
      outcome: 'sent',
      providerMessageId: 'provider-message-1',
    });
    expect(first.kind).toBe('applied');

    const second = await repo.persistExecutionResult({
      ...persistParams,
      deliveryId: 'delivery-double-persist',
      outcome: 'failed',
      lastError: 'smtp-550',
      lastErrorClass: 'permanent',
    });
    expect(second).toEqual({ kind: 'denied', reason: 'lease-lost' });

    const record = await loadOrThrow('delivery-double-persist');
    expect(record.status).toBe('sent');
    expect(record.providerMessageId).toBe('provider-message-1');
    expect(record.lastError).toBeNull();
  });
});

describe('releaseExecutionLease', () => {
  it('releases for a retryable attempt with its error recorded and without consuming budget', async () => {
    await seedPending('delivery-release');
    const claimed = await claimOrThrow('delivery-release', 'owner-a', T0);
    expect(claimed.attempts).toBe(1);

    const released = await repo.releaseExecutionLease({
      deliveryId: 'delivery-release',
      owner: 'owner-a',
      executionGeneration: claimed.executionGeneration,
      dispatchGeneration: 1,
      nowMs: T0 + 500,
      lastError: 'timeout',
      lastErrorClass: 'retryable',
    });
    expect(released.kind).toBe('applied');

    // §9.2.2 hàng 6: vẫn `processing`, không lease, `last_error` ghi nguyên nhân,
    // `attempts` KHÔNG tăng — execution kế tiếp claim lại ngay được.
    const record = await loadOrThrow('delivery-release');
    expect(record.status).toBe('processing');
    expect(record.outcomeReportState).toBe('none');
    expect(record.leaseOwner).toBeNull();
    expect(record.leaseExpiresAt).toBeNull();
    expect(record.attempts).toBe(1);
    expect(record.lastError).toBe('timeout');
    expect(record.lastErrorClass).toBe('retryable');

    const reclaim = await claimOrThrow('delivery-release', 'owner-b', T0 + 1_000);
    expect(reclaim.attempts).toBe(2);
  });

  it('refuses a release from an owner that no longer holds the lease', async () => {
    await seedPending('delivery-release-stale');
    await claimOrThrow('delivery-release-stale', 'owner-a', T0);

    const result = await repo.releaseExecutionLease({
      deliveryId: 'delivery-release-stale',
      owner: 'owner-b',
      executionGeneration: 1,
      dispatchGeneration: 1,
      nowMs: T0 + 100,
    });
    expect(result).toEqual({ kind: 'denied', reason: 'lease-lost' });
    expect((await loadOrThrow('delivery-release-stale')).leaseOwner).toBe('owner-a');
  });
});

describe('recordLookupError', () => {
  // Đường lookup chạy TRƯỚC claim (§9.2.2 hàng 19): execution này chưa từng giữ lease,
  // owner token của nó sinh mới mỗi invocation, nên guard lease là bất khả thi — predicate
  // của statement chỉ là trạng thái row. Ca này ghim hình dạng đó bằng trạng thái D1 thật:
  // ghi lỗi lookup vào row KHÁC lease (lease của owner-a còn nguyên) mà không cần owner-b.

  it('records the error class on a processing row without touching its lease', async () => {
    await seedPending('delivery-lookup-error');
    await claimOrThrow('delivery-lookup-error', 'owner-a', T0);

    // owner-b chưa claim bao giờ — đúng hình dạng execution vừa lookup 401/403.
    const result = await repo.recordLookupError({
      deliveryId: 'delivery-lookup-error',
      dispatchGeneration: 1,
      nowMs: T0 + 500,
      lastErrorClass: 'internal-auth',
    });
    expect(result.kind).toBe('applied');

    const record = await loadOrThrow('delivery-lookup-error');
    expect(record.status).toBe('processing');
    expect(record.outcomeReportState).toBe('none');
    expect(record.lastError).toBeNull();
    expect(record.lastErrorClass).toBe('internal-auth');
    // Lease của owner-a KHÔNG bị đụng: execution kế tiếp vẫn phải chờ hết hạn lease đó.
    expect(record.leaseOwner).toBe('owner-a');
    expect(record.leaseExpiresAt).toBe(T0 + LEASE_MS);
  });

  it('skips a terminal row instead of rewriting its outcome', async () => {
    await makeSentWithPendingReport('delivery-lookup-terminal');

    const result = await repo.recordLookupError({
      deliveryId: 'delivery-lookup-terminal',
      dispatchGeneration: 1,
      nowMs: T0 + 500,
      lastErrorClass: 'internal-auth',
    });
    expect(result).toEqual({ kind: 'skipped' });

    const record = await loadOrThrow('delivery-lookup-terminal');
    expect(record.status).toBe('sent');
    expect(record.lastErrorClass).toBeNull();
  });

  it('skips when the dispatch generation does not match', async () => {
    await seedPending('delivery-lookup-generation', 1);

    const result = await repo.recordLookupError({
      deliveryId: 'delivery-lookup-generation',
      dispatchGeneration: 2,
      nowMs: T0 + 500,
      lastErrorClass: 'internal-auth',
    });
    expect(result).toEqual({ kind: 'skipped' });

    const record = await loadOrThrow('delivery-lookup-generation');
    expect(record.lastErrorClass).toBeNull();
  });
});

describe('outcome report lease and completion', () => {
  it('acquires a report lease exactly once while it is live', async () => {
    await makeSentWithPendingReport('delivery-report-lease');

    const outcomes = await Promise.all(
      ['sweeper-1', 'sweeper-2'].map((owner) =>
        repo.acquireReportLease({
          deliveryId: 'delivery-report-lease',
          dispatchGeneration: 1,
          owner,
          nowMs: T0 + 2_000,
          reportLeaseMs: REPORT_LEASE_MS,
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.kind === 'acquired')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'denied')).toHaveLength(1);
    // Mọi denial phải đúng lý do "report-lease còn hiệu lực".
    const denialReasons = outcomes.flatMap((outcome) =>
      outcome.kind === 'denied' ? [outcome.reason] : [],
    );
    expect(new Set(denialReasons)).toEqual(new Set(['report-lease-active']));

    const record = await loadOrThrow('delivery-report-lease');
    expect(record.reportAttempts).toBe(1);
    expect(record.reportLeaseExpiresAt).toBe(T0 + 2_000 + REPORT_LEASE_MS);

    // Hết report-lease đúng tại biên `<= :now` → lần báo tiếp theo claim lại được.
    const reacquired = await repo.acquireReportLease({
      deliveryId: 'delivery-report-lease',
      dispatchGeneration: 1,
      owner: 'sweeper-2',
      nowMs: T0 + 2_000 + REPORT_LEASE_MS,
      reportLeaseMs: REPORT_LEASE_MS,
    });
    expect(reacquired.kind).toBe('acquired');
    expect((await loadOrThrow('delivery-report-lease')).reportAttempts).toBe(2);
  });

  it('refuses to acquire when the outcome report is not pending', async () => {
    await seedPending('delivery-report-none');
    const notPending = await repo.acquireReportLease({
      deliveryId: 'delivery-report-none',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0,
      reportLeaseMs: REPORT_LEASE_MS,
    });
    expect(notPending).toEqual({ kind: 'denied', reason: 'not-pending' });

    await makeSentWithPendingReport('delivery-report-done');
    await repo.acquireReportLease({
      deliveryId: 'delivery-report-done',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 2_000,
      reportLeaseMs: REPORT_LEASE_MS,
    });
    const completed = await repo.completeReport({
      deliveryId: 'delivery-report-done',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 3_000,
      disposition: 'reported',
    });
    expect(completed.kind).toBe('applied');

    const second = await repo.acquireReportLease({
      deliveryId: 'delivery-report-done',
      dispatchGeneration: 1,
      owner: 'sweeper-2',
      nowMs: T0 + 4_000,
      reportLeaseMs: REPORT_LEASE_MS,
    });
    expect(second).toEqual({ kind: 'denied', reason: 'not-pending' });
  });

  it('refuses report operations for a stale generation', async () => {
    await seedPending('delivery-report-gen', 2);
    await claimOrThrow('delivery-report-gen', 'owner-a', T0, 2);
    await repo.persistExecutionResult({
      deliveryId: 'delivery-report-gen',
      owner: 'owner-a',
      executionGeneration: 1,
      dispatchGeneration: 2,
      nowMs: T0 + 1_000,
      outcome: 'sent',
    });

    const acquire = await repo.acquireReportLease({
      deliveryId: 'delivery-report-gen',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 2_000,
      reportLeaseMs: REPORT_LEASE_MS,
    });
    expect(acquire).toEqual({ kind: 'denied', reason: 'generation-mismatch' });
  });

  it('completes reporting for the lease owner and never reopens execution', async () => {
    await makeSentWithPendingReport('delivery-report-complete');
    await repo.acquireReportLease({
      deliveryId: 'delivery-report-complete',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 2_000,
      reportLeaseMs: REPORT_LEASE_MS,
    });

    const disposition = dispositionForControlPlaneOutcome('applied');
    expect(disposition.kind).toBe('reported');
    const completed = await repo.completeReport({
      deliveryId: 'delivery-report-complete',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 3_000,
      disposition: 'reported',
    });
    expect(completed.kind).toBe('applied');

    const record = await loadOrThrow('delivery-report-complete');
    expect(record.outcomeReportState).toBe('reported');
    expect(record.reportLeaseOwner).toBeNull();
    expect(record.reportAttempts).toBe(1);
    // Bất biến (6): báo xong KHÔNG đưa row về executable.
    expect(record.status).toBe('sent');

    const reclaim = await repo.claimSameGeneration({
      deliveryId: 'delivery-report-complete',
      dispatchGeneration: 1,
      owner: 'owner-b',
      nowMs: T0 + 4_000,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(reclaim).toEqual({ kind: 'denied', reason: 'terminal' });
  });

  it('records superseded and orphaned as terminal reporting results', async () => {
    await makeSentWithPendingReport('delivery-report-stale');
    await repo.acquireReportLease({
      deliveryId: 'delivery-report-stale',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 2_000,
      reportLeaseMs: REPORT_LEASE_MS,
    });
    const superseded = await repo.completeReport({
      deliveryId: 'delivery-report-stale',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 3_000,
      disposition: 'superseded',
    });
    expect(superseded.kind).toBe('applied');
    expect((await loadOrThrow('delivery-report-stale')).outcomeReportState).toBe('superseded');

    await makeSentWithPendingReport('delivery-report-orphaned');
    await repo.acquireReportLease({
      deliveryId: 'delivery-report-orphaned',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 2_000,
      reportLeaseMs: REPORT_LEASE_MS,
    });
    const orphaned = await repo.completeReport({
      deliveryId: 'delivery-report-orphaned',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 3_000,
      disposition: 'orphaned',
    });
    expect(orphaned.kind).toBe('applied');
    expect((await loadOrThrow('delivery-report-orphaned')).outcomeReportState).toBe('orphaned');
  });

  it('refuses completion from a non-owner and after another reporter finished', async () => {
    await makeSentWithPendingReport('delivery-report-guard');
    await repo.acquireReportLease({
      deliveryId: 'delivery-report-guard',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 2_000,
      reportLeaseMs: REPORT_LEASE_MS,
    });

    const wrongOwner = await repo.completeReport({
      deliveryId: 'delivery-report-guard',
      dispatchGeneration: 1,
      owner: 'sweeper-2',
      nowMs: T0 + 2_500,
      disposition: 'reported',
    });
    expect(wrongOwner).toEqual({ kind: 'denied', reason: 'report-lease-lost' });

    const applied = await repo.completeReport({
      deliveryId: 'delivery-report-guard',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 3_000,
      disposition: 'reported',
    });
    expect(applied.kind).toBe('applied');

    const late = await repo.completeReport({
      deliveryId: 'delivery-report-guard',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 4_000,
      disposition: 'reported',
    });
    expect(late).toEqual({ kind: 'denied', reason: 'not-pending' });
  });

  it('keeps the report pending, frees the lease and never resets the provider result', async () => {
    await makeSentWithPendingReport('delivery-report-retry');
    await repo.acquireReportLease({
      deliveryId: 'delivery-report-retry',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 2_000,
      reportLeaseMs: REPORT_LEASE_MS,
    });

    const kept = await repo.keepReportPending({
      deliveryId: 'delivery-report-retry',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 3_000,
    });
    expect(kept.kind).toBe('applied');

    const record = await loadOrThrow('delivery-report-retry');
    expect(record.outcomeReportState).toBe('pending');
    expect(record.reportLeaseOwner).toBeNull();
    expect(record.reportAttempts).toBe(1);
    // Retry report giữ nguyên kết quả provider; row không quay lại executable.
    expect(record.status).toBe('sent');

    const reclaim = await repo.claimSameGeneration({
      deliveryId: 'delivery-report-retry',
      dispatchGeneration: 1,
      owner: 'owner-b',
      nowMs: T0 + 4_000,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(reclaim).toEqual({ kind: 'denied', reason: 'terminal' });
  });

  it('refuses keep-pending from a non-owner', async () => {
    await makeSentWithPendingReport('delivery-report-keep-guard');
    await repo.acquireReportLease({
      deliveryId: 'delivery-report-keep-guard',
      dispatchGeneration: 1,
      owner: 'sweeper-1',
      nowMs: T0 + 2_000,
      reportLeaseMs: REPORT_LEASE_MS,
    });

    const result = await repo.keepReportPending({
      deliveryId: 'delivery-report-keep-guard',
      dispatchGeneration: 1,
      owner: 'sweeper-2',
      nowMs: T0 + 2_500,
    });
    expect(result).toEqual({ kind: 'denied', reason: 'report-lease-lost' });
  });
});

describe('recovery sweep queries', () => {
  it('selects expired execution leases at the inclusive boundary only', async () => {
    await insertRawRow('delivery-expired-equal', {
      lease_owner: 'owner-a',
      lease_expires_at: T0,
    });
    await insertRawRow('delivery-expired-later', {
      lease_owner: 'owner-b',
      lease_expires_at: T0 + 1,
    });
    await insertRawRow('delivery-no-lease');

    const candidates = await repo.findStaleLeaseCandidates({ nowMs: T0, limit: 10 });
    expect(candidates.map((item) => item.deliveryId)).toEqual(['delivery-expired-equal']);
  });

  it('selects pending reports without a live lease and below the attempt bound', async () => {
    // Hạng đủ điều kiện: pending, không report-lease, dưới bound.
    await insertRawRow('delivery-report-eligible', {
      status: 'sent',
      outcome_report_state: 'pending',
    });
    // Biên `report_lease_expires_at = now`: hết hiệu lực → vẫn quét.
    await insertRawRow('delivery-report-boundary', {
      status: 'sent',
      outcome_report_state: 'pending',
      report_lease_owner: 'sweeper-1',
      report_lease_expires_at: T0,
      report_attempts: 1,
    });
    // Report-lease còn hiệu lực → loại.
    await insertRawRow('delivery-report-live-lease', {
      status: 'sent',
      outcome_report_state: 'pending',
      report_lease_owner: 'sweeper-2',
      report_lease_expires_at: T0 + 1,
    });
    // Chạm bound `report_attempts < maxReportAttempts` → loại (dừng auto-retry).
    await insertRawRow('delivery-report-at-bound', {
      status: 'sent',
      outcome_report_state: 'pending',
      report_attempts: MAX_REPORT_ATTEMPTS,
    });
    // Chưa có kết quả nào để báo → loại.
    await insertRawRow('delivery-report-none-state');
    // Đã báo xong → loại.
    await insertRawRow('delivery-report-done-state', {
      status: 'sent',
      outcome_report_state: 'reported',
    });

    const candidates = await repo.findReportSweepCandidates({
      nowMs: T0,
      maxReportAttempts: MAX_REPORT_ATTEMPTS,
      limit: 10,
    });
    expect(candidates.map((item) => item.deliveryId).toSorted()).toEqual([
      'delivery-report-boundary',
      'delivery-report-eligible',
    ]);
  });

  it('selects blocked rows at or before the backlog cutoff, oldest first and bounded', async () => {
    await insertRawRow('delivery-blocked-newer', {
      status: 'blocked',
      outcome_report_state: 'pending',
      blocked_at: T0 + 1,
      attempts: MAX_EXECUTION_ATTEMPTS,
    });
    await insertRawRow('delivery-blocked-equal', {
      status: 'blocked',
      outcome_report_state: 'pending',
      blocked_at: T0,
      attempts: MAX_EXECUTION_ATTEMPTS,
    });
    await insertRawRow('delivery-blocked-older', {
      status: 'blocked',
      outcome_report_state: 'pending',
      blocked_at: T0 - 1_000,
      attempts: MAX_EXECUTION_ATTEMPTS,
    });
    await insertRawRow('delivery-not-blocked');

    const all = await repo.findBlockedBacklogCandidates({ cutoffMs: T0, limit: 10 });
    expect(all.map((item) => item.deliveryId)).toEqual([
      'delivery-blocked-older',
      'delivery-blocked-equal',
    ]);

    const bounded = await repo.findBlockedBacklogCandidates({ cutoffMs: T0, limit: 1 });
    expect(bounded.map((item) => item.deliveryId)).toEqual(['delivery-blocked-older']);
  });
});

describe('quarantine repository', () => {
  it('records a rejected command once and counts repeats idempotently', async () => {
    const first = await quarantine.upsertQuarantineRecord({
      quarantineId: 'digest-1',
      queueMessageId: 'queue-message-1',
      reason: 'unparseable-body',
      nowMs: T0,
    });
    expect(first.kind).toBe('created');

    const second = await quarantine.upsertQuarantineRecord({
      quarantineId: 'digest-1',
      queueMessageId: 'queue-message-1',
      reason: 'unparseable-body',
      nowMs: T0 + 100,
    });
    expect(second.kind).toBe('updated');
    expect(second.record.attempts).toBe(2);
    // Ghi lặp không đổi lý do phân loại gốc.
    expect(second.record.reason).toBe('unparseable-body');
    expect(second.record.createdAt).toBe(T0);

    const fetched = await quarantine.getQuarantineRecord({
      quarantineId: 'digest-1',
      queueMessageId: 'queue-message-1',
    });
    expect(fetched?.attempts).toBe(2);

    const missing = await quarantine.getQuarantineRecord({
      quarantineId: 'digest-unknown',
      queueMessageId: 'queue-message-1',
    });
    expect(missing).toBeNull();
  });

  it('keeps two queue messages with the same digest as two separate records', async () => {
    await quarantine.upsertQuarantineRecord({
      quarantineId: 'digest-shared',
      queueMessageId: 'queue-message-a',
      reason: 'unsupported-version',
      nowMs: T0,
    });
    await quarantine.upsertQuarantineRecord({
      quarantineId: 'digest-shared',
      queueMessageId: 'queue-message-b',
      reason: 'unsupported-version',
      nowMs: T0 + 1,
    });

    const rows = await rawRows(
      `SELECT queue_message_id FROM quarantine WHERE quarantine_id = ? ORDER BY queue_message_id`,
      'digest-shared',
    );
    expect(rows.map((row) => row['queue_message_id'])).toEqual([
      'queue-message-a',
      'queue-message-b',
    ]);
  });

  it('stores the documented forbidden key names, including api_key', async () => {
    // `api_key` là key cấm tường minh trong 02-requirements.md; sanitizer kebab-case
    // sẽ từ chối nó (`_` không thuộc tập), nên đây là ca bắt lỗi hồi quy đó.
    for (const fieldName of ['secret', 'token', 'recipient', 'api_key', 'subject', 'body']) {
      const result = await quarantine.upsertQuarantineRecord({
        quarantineId: `digest-${fieldName}`,
        queueMessageId: `queue-message-${fieldName}`,
        reason: 'forbidden-field',
        fieldName,
        nowMs: T0,
      });
      expect(result.kind).toBe('created');
      expect(result.record.fieldName).toBe(fieldName);
    }

    const rows = await rawRows(
      `SELECT field_name FROM quarantine WHERE reason = 'forbidden-field' ORDER BY field_name`,
    );
    expect(rows.map((row) => row['field_name'])).toEqual([
      'api_key',
      'body',
      'recipient',
      'secret',
      'subject',
      'token',
    ]);
  });

  it('requires a key name for forbidden-field and rejects free-form names', async () => {
    await expect(
      quarantine.upsertQuarantineRecord({
        quarantineId: 'digest-forbidden-missing',
        queueMessageId: 'queue-message-1',
        reason: 'forbidden-field',
        nowMs: T0,
      }),
    ).rejects.toThrow(MailJobValidationError);

    await expect(
      quarantine.upsertQuarantineRecord({
        quarantineId: 'digest-forbidden-freeform',
        queueMessageId: 'queue-message-1',
        reason: 'forbidden-field',
        fieldName: 'value with spaces',
        nowMs: T0,
      }),
    ).rejects.toThrow(MailJobValidationError);

    await expect(
      quarantine.upsertQuarantineRecord({
        quarantineId: 'digest-bad-reason',
        queueMessageId: 'queue-message-1',
        reason: 'other-reason' as 'unparseable-body',
        nowMs: T0,
      }),
    ).rejects.toThrow(MailJobValidationError);
  });

  it('treats identifiers containing SQL metacharacters as opaque data', async () => {
    const hostileId = `digest'; DROP TABLE mail_jobs; --`;
    const hostileMessage = `msg' OR '1'='1`;

    const result = await quarantine.upsertQuarantineRecord({
      quarantineId: hostileId,
      queueMessageId: hostileMessage,
      reason: 'missing-delivery-id',
      nowMs: T0,
    });
    expect(result.kind).toBe('created');

    const fetched = await quarantine.getQuarantineRecord({
      quarantineId: hostileId,
      queueMessageId: hostileMessage,
    });
    expect(fetched?.quarantineId).toBe(hostileId);
    expect(fetched?.queueMessageId).toBe(hostileMessage);

    // Bảng mail_jobs vẫn còn nguyên — chuỗi không hề được diễn giải thành SQL.
    const tables = await rawRows(`SELECT name FROM sqlite_master WHERE type = 'table'`);
    expect(tables.map((row) => row['name'])).toEqual(expect.arrayContaining(['mail_jobs']));
  });
});

describe('malformed persisted state', () => {
  it('fails closed when a stored row violates a decode invariant', async () => {
    // Cặp lease cùng "có mặt" nên CHECK của schema cho qua, nhưng owner rỗng là state
    // hỏng: không owner nào (kể cả owner rỗng) được coi là hợp lệ.
    await insertRawRow('delivery-corrupt', {
      lease_owner: '',
      lease_expires_at: T0 + LEASE_MS,
    });

    await expect(repo.loadJobByDeliveryId('delivery-corrupt')).rejects.toThrow(
      MalformedMailJobStateError,
    );
    // Claim cũng fail closed: không bao giờ trả "claimed" cho row hỏng.
    await expect(
      repo.claimSameGeneration({
        deliveryId: 'delivery-corrupt',
        dispatchGeneration: 1,
        owner: 'owner-a',
        nowMs: T0,
        leaseMs: LEASE_MS,
        maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
      }),
    ).rejects.toThrow(MalformedMailJobStateError);
  });

  it('treats a delivery id with SQL metacharacters as an opaque lookup key', async () => {
    const hostile = `x'; DROP TABLE mail_jobs; --`;

    const missing = await repo.loadJobByDeliveryId(hostile);
    expect(missing).toBeNull();

    const claim = await repo.claimSameGeneration({
      deliveryId: hostile,
      dispatchGeneration: 1,
      owner: 'owner-a',
      nowMs: T0,
      leaseMs: LEASE_MS,
      maxExecutionAttempts: MAX_EXECUTION_ATTEMPTS,
    });
    expect(claim).toEqual({ kind: 'denied', reason: 'missing-job' });

    const tables = await rawRows(`SELECT name FROM sqlite_master WHERE type = 'table'`);
    expect(tables.map((row) => row['name'])).toEqual(expect.arrayContaining(['mail_jobs']));
  });
});
