// Kiểm chứng schema D1 của transactional-mailer-job trên D1 thật (Wrangler local, miniflare/workerd).
// Repo chưa có pattern test D1; wrangler đã cài sẵn ở root (devDependency) nên test chỉ spawn
// `wrangler d1 ... --local --persist-to <tmp>` qua node, không thêm dependency mới và không
// tạo migration runner riêng (vẫn là `wrangler d1 migrations apply`).
// Nguồn canonical: docs/applications/transactional-mailer-job/01-architecture.md §7, §9.2.1, §9.2.2, §9.5
// và 03-operations.md §3.1. Các câu lệnh "canonical statement" bên dưới chỉ là SQL test sao chép
// từ tài liệu để chứng minh schema chấp nhận; không phải implementation của worker.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_TIMEOUT = 120_000;

// Suite nằm ở `tests/integrations/`, hai cấp dưới root app — đi lên hai cấp mới ra appDir.
const appDir = dirname(dirname(import.meta.dirname));
const migrationsDir = join(appDir, 'migrations');
const req = createRequire(import.meta.url);
const wranglerCli = req.resolve('wrangler');

let stateDir: string;

type D1StatementResult = {
  results: Record<string, unknown>[];
  success: boolean;
};

type D1JsonOutput = D1StatementResult[] | { error: { text: string } };

function runWranglerJson(args: string[], timeoutMs = 120_000): D1StatementResult[] {
  const raw = execFileSync(
    process.execPath,
    [
      wranglerCli,
      'd1',
      'execute',
      'mail-job',
      '--local',
      '--config',
      join(appDir, 'wrangler.jsonc'),
      '--persist-to',
      stateDir,
      '--json',
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(raw.trim() || '[]') as D1JsonOutput;
  if (!Array.isArray(parsed)) {
    throw new Error(`d1 execute unexpected output: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function query(sql: string): Record<string, unknown>[] {
  return runWranglerJson(['--command', sql])[0].results;
}

function queryOne<T>(sql: string): T {
  const rows = query(sql);
  expect(rows).toHaveLength(1);
  return rows[0] as T;
}

function tableDdl(table: string): string {
  const row = queryOne<Record<string, unknown>>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${table}';`,
  );
  return String(row['sql']);
}

function applyMigrations(): string {
  return execFileSync(
    process.execPath,
    [
      wranglerCli,
      'd1',
      'migrations',
      'apply',
      'mail-job',
      '--local',
      '--config',
      join(appDir, 'wrangler.jsonc'),
      '--persist-to',
      stateDir,
    ],
    {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

// Mỗi statement sai trong một batch sẽ rollback cả batch (wrangler execute --file chạy nguyên
// một transaction), nên mỗi case vi phạm cần một lệnh riêng.
function runSqlFile(sql: string): D1StatementResult[] {
  const tmpFile = join(stateDir, `case-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmpFile, sql);
  try {
    return runWranglerJson(['--file', tmpFile]);
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

function rejectionOutput(sql: string): string {
  try {
    runSqlFile(sql);
  } catch (caught) {
    return String(
      (caught as { stdout?: string }).stdout ?? (caught as { stderr?: string }).stderr ?? caught,
    );
  }
  throw new Error(`statement was expected to be rejected: ${sql}`);
}

// Statement canonical (§9.2.1) và transition hợp lệ (§9.2.2) — chỉ để chứng minh schema chấp nhận.
// Lease expiry dùng thời điểm tương lai để lease còn hiệu lực, hoặc quá khứ xa để chứng minh
// guard "lease_expires_at <= now" của statement (a)/(d) chặn claim trên lease còn sống.
const now = 1700000000000;
const pastExpiry = 1000;
const futureExpiry = now + 3600000;
const canonicalSql = {
  initialInsert: (id: string) =>
    `INSERT INTO mail_jobs (delivery_id, message_id, dispatch_generation, execution_generation, status, attempts, outcome_report_state) VALUES ('${id}', 'msg-${id}', 1, 0, 'processing', 0, 'none');`,
  claimStatementA: (id: string, owner: string, expiresAt: number) =>
    `UPDATE mail_jobs SET execution_generation = execution_generation + 1, attempts = attempts + 1, lease_owner = '${owner}', lease_expires_at = ${expiresAt}, updated_at = ${now} WHERE delivery_id = '${id}' AND status = 'processing' AND (lease_owner IS NULL OR lease_expires_at <= ${now});`,
  persistResult: (
    id: string,
    status: 'sent' | 'failed' | 'blocked',
    blockedAt: number | null = null,
  ) =>
    `UPDATE mail_jobs SET status = '${status}', outcome_report_state = 'pending', lease_owner = NULL, lease_expires_at = NULL, blocked_at = ${blockedAt === null ? 'NULL' : blockedAt}, updated_at = ${now} WHERE delivery_id = '${id}';`,
  acquireReportLease: (id: string, owner: string, expiresAt: number) =>
    `UPDATE mail_jobs SET report_lease_owner = '${owner}', report_lease_expires_at = ${expiresAt}, report_attempts = report_attempts + 1, updated_at = ${now} WHERE delivery_id = '${id}' AND outcome_report_state = 'pending' AND (report_lease_owner IS NULL OR report_lease_expires_at <= ${now});`,
  releaseReportLeaseReported: (id: string) =>
    `UPDATE mail_jobs SET outcome_report_state = 'reported', report_lease_owner = NULL, report_lease_expires_at = NULL, updated_at = ${now} WHERE delivery_id = '${id}';`,
  generationAdvanceB: (
    id: string,
    owner: string,
    expiresAt: number,
    newDispatch: number,
    newExecution: number,
  ) =>
    `UPDATE mail_jobs SET dispatch_generation = ${newDispatch}, execution_generation = ${newExecution}, attempts = 1, lease_owner = '${owner}', lease_expires_at = ${expiresAt}, status = 'processing', outcome_report_state = 'none', report_lease_owner = NULL, report_lease_expires_at = NULL, report_attempts = 0, blocked_at = NULL, updated_at = ${now} WHERE delivery_id = '${id}';`,
  budgetExhaustedC: (id: string, owner: string, blockedAt: number) =>
    `UPDATE mail_jobs SET status = 'blocked', blocked_at = ${blockedAt}, lease_owner = NULL, lease_expires_at = NULL, last_error = 'max_execution_attempts_exhausted', last_error_class = 'execution-budget-exhausted', outcome_report_state = 'pending', updated_at = ${now} WHERE delivery_id = '${id}' AND lease_owner = '${owner}';`,
};

const quarantineSql = {
  insert: (id: string, msgId: string, reason: string, fieldName: string | null, attempts: number) =>
    `INSERT INTO quarantine (quarantine_id, queue_message_id, reason, field_name, attempts) VALUES ('${id}', '${msgId}', '${reason}', ${fieldName === null ? 'NULL' : `'${fieldName}'`}, ${attempts});`,
  upsertRepeat: (id: string, msgId: string) =>
    `INSERT INTO quarantine (quarantine_id, queue_message_id, reason, attempts) VALUES ('${id}', '${msgId}', 'missing-delivery-id', 1) ON CONFLICT (quarantine_id, queue_message_id) DO UPDATE SET attempts = attempts + 1, updated_at = ${now};`,
};

const QUARANTINE_COLUMNS = [
  'quarantine_id',
  'queue_message_id',
  'reason',
  'field_name',
  'attempts',
  'created_at',
  'updated_at',
];
/** Cột của `mail_lifecycle_events` (0004) — hợp đồng schema của lớp quan sát lifecycle. */
const MAIL_LIFECYCLE_EVENTS_COLUMNS = [
  'event_id',
  'event_type',
  'message_id',
  'delivery_id',
  'occurred_at',
  'terminal',
  'reason_token',
  'created_at',
];
const MAIL_JOBS_COLUMNS = [
  'delivery_id',
  'message_id',
  'dispatch_generation',
  'execution_generation',
  'lease_owner',
  'lease_expires_at',
  'status',
  'attempts',
  'last_error',
  'last_error_class',
  'provider_message_id',
  'outcome_report_state',
  'report_lease_owner',
  'report_lease_expires_at',
  'report_attempts',
  'blocked_at',
  'created_at',
  'updated_at',
  // Migration 0003 là `ALTER TABLE ... ADD COLUMN` — SQLite append cột mới vào **cuối**,
  // không chèn theo vị trí trong definion gốc của mail-job #1.
  'provider_call_at',
];

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'mail-job-d1-'));
  try {
    applyMigrations();
  } catch (error) {
    const detail = String(
      (error as { stdout?: string }).stdout ?? (error as { stderr?: string }).stderr ?? error,
    );
    throw new Error(`d1 migrations apply failed: ${detail}`, { cause: error });
  }
}, TEST_TIMEOUT * 2);

afterAll(() => {
  if (stateDir) {
    rmSync(stateDir, { force: true, recursive: true });
  }
});

describe('mail-job D1 migrations', () => {
  it(
    'applies every migration file from an empty database and records them in the ledger',
    () => {
      const expectedFiles = readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .toSorted();
      expect(expectedFiles.length).toBeGreaterThan(0);

      const ledger = query(
        `SELECT name FROM d1_migrations WHERE name IN (${expectedFiles.map((f) => `'${f}'`).join(', ')}) ORDER BY name;`,
      );
      const appliedNames = ledger.map((row) => row['name']);
      expect(appliedNames).toEqual(expectedFiles);
    },
    TEST_TIMEOUT,
  );

  it(
    'creates the canonical tables, columns and indexes',
    () => {
      const tables = query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('mail_jobs', 'quarantine') ORDER BY name;`,
      ).map((row) => row['name']);
      expect(tables).toEqual(['mail_jobs', 'quarantine']);

      const mailJobsColumns = query(`SELECT name FROM pragma_table_info('mail_jobs');`).map(
        (row) => row['name'],
      );
      expect(mailJobsColumns).toEqual(MAIL_JOBS_COLUMNS);

      const quarantineColumns = query(`SELECT name FROM pragma_table_info('quarantine');`).map(
        (row) => row['name'],
      );
      expect(quarantineColumns).toEqual(QUARANTINE_COLUMNS);

      const lifecycleColumns = query(
        `SELECT name FROM pragma_table_info('mail_lifecycle_events');`,
      ).map((row) => row['name']);
      expect(lifecycleColumns).toEqual(MAIL_LIFECYCLE_EVENTS_COLUMNS);

      const indexes = query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('mail_jobs', 'quarantine') AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
      ).map((row) => row['name']);
      expect(indexes).toEqual([
        // 0004 — correlation của lifecycle ingest (tra provider_message_id theo từng event)
        'mail_jobs_provider_message_id_idx',
        // 0001 — sweeps
        'mail_jobs_report_sweep_idx',
        'mail_jobs_status_lease_idx',
      ]);

      const lifecycleIndexes = query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mail_lifecycle_events' AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
      ).map((row) => row['name']);
      // `mail_lifecycle_events_pkey` là PRIMARY KEY (dedupe key), không phải index rời.
      expect(lifecycleIndexes).toEqual([
        'mail_lifecycle_events_delivery_idx',
        'mail_lifecycle_events_type_idx',
      ]);

      const reportSweep = queryOne<Record<string, string>>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'mail_jobs_report_sweep_idx';`,
      );
      expect(String(reportSweep['sql'])).toContain('(outcome_report_state, updated_at)');

      const leaseIdx = queryOne<Record<string, string>>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'mail_jobs_status_lease_idx';`,
      );
      expect(String(leaseIdx['sql'])).toContain('(status, lease_expires_at)');
    },
    TEST_TIMEOUT,
  );

  it(
    'names every constraint so a violation reports the rule and later migrations can reference it',
    () => {
      // Danh sách này là hợp đồng schema: migration sau tham chiếu constraint theo tên, nên đổi tên
      // phải là quyết định có ý thức và cập nhật ở đây.
      const expectedNames: Record<string, string[]> = {
        mail_jobs: [
          'mail_jobs_pkey',
          'mail_jobs_status_check',
          'mail_jobs_outcome_report_state_check',
          'mail_jobs_dispatch_generation_check',
          'mail_jobs_execution_generation_check',
          'mail_jobs_attempts_check',
          'mail_jobs_report_attempts_check',
          'mail_jobs_lease_pair_check',
          'mail_jobs_report_lease_pair_check',
          'mail_jobs_blocked_at_parity_check',
          'mail_jobs_report_state_parity_check',
          'mail_jobs_delivery_id_non_empty_check',
        ],
        quarantine: [
          'quarantine_pkey',
          'quarantine_reason_check',
          'quarantine_quarantine_id_non_empty_check',
          'quarantine_queue_message_id_non_empty_check',
          'quarantine_forbidden_field_name_check',
          'quarantine_attempts_check',
        ],
      };

      for (const [table, names] of Object.entries(expectedNames)) {
        const ddl = tableDdl(table);
        for (const name of names) {
          expect(ddl).toContain(`CONSTRAINT ${name} `);
        }

        // Không được còn CHECK vô danh: mọi đoạn đứng trước một `CHECK (` phải kết thúc bằng tên
        // constraint, nếu không SQLite chỉ trả về nguyên biểu thức và không tham chiếu được.
        const segmentsBeforeCheck = ddl.split('CHECK (').slice(0, -1);
        expect(segmentsBeforeCheck.length).toBe(names.length - 1);
        for (const segment of segmentsBeforeCheck) {
          expect(segment).toMatch(/CONSTRAINT\s+\w+\s*$/u);
        }
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'is idempotent: re-applying does not apply any file again',
    () => {
      const ledgerCountBefore = queryOne<{ n: number }>(`SELECT count(*) AS n FROM d1_migrations;`)[
        'n'
      ];
      const secondOutput = applyMigrations();
      expect(secondOutput).toContain('No migrations to apply');
      const ledgerCountAfter = queryOne<{ n: number }>(`SELECT count(*) AS n FROM d1_migrations;`)[
        'n'
      ];
      expect(ledgerCountAfter).toBe(ledgerCountBefore);
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects NULL primary keys on a rowid table (PK without NOT NULL would allow NULL)',
    () => {
      expect(
        rejectionOutput(
          `INSERT INTO mail_jobs (delivery_id, message_id, dispatch_generation, execution_generation, status, attempts, outcome_report_state) VALUES (NULL, 'msg-null', 1, 0, 'processing', 0, 'none');`,
        ),
      ).toContain('NOT NULL constraint failed: mail_jobs.delivery_id');
      expect(
        rejectionOutput(
          `INSERT INTO quarantine (quarantine_id, queue_message_id, reason, attempts) VALUES (NULL, 'q-msg-1', 'missing-delivery-id', 1);`,
        ),
      ).toContain('NOT NULL constraint failed: quarantine.quarantine_id');
    },
    TEST_TIMEOUT,
  );

  it(
    'inserts the documented initial state and other valid states',
    () => {
      runSqlFile(canonicalSql.initialInsert('d-init-1'));
      const row = queryOne<Record<string, unknown>>(
        `SELECT * FROM mail_jobs WHERE delivery_id = 'd-init-1';`,
      );
      expect(row).toMatchObject({
        delivery_id: 'd-init-1',
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
      });
      expect(typeof row['created_at']).toBe('number');
      expect(typeof row['updated_at']).toBe('number');
      expect(row['created_at']).toBeGreaterThan(0);
      // Timestamp phải lưu là INTEGER epoch ms, không phụ thuộc kiểu real của biểu thức mặc định
      expect(
        queryOne<Record<string, unknown>>(
          `SELECT typeof(created_at) AS created, typeof(updated_at) AS updated FROM mail_jobs WHERE delivery_id = 'd-init-1';`,
        ),
      ).toMatchObject({ created: 'integer', updated: 'integer' });
    },
    TEST_TIMEOUT,
  );

  it(
    'claims and releases the lease through the documented decision statements',
    () => {
      const id = 'd-lease-1';
      const owner = 'lease-owner-1';
      runSqlFile(canonicalSql.initialInsert(id));
      // First claim: sets a live lease (future expiry)
      runSqlFile(canonicalSql.claimStatementA(id, owner, futureExpiry));
      const claimed = queryOne<Record<string, unknown>>(
        `SELECT lease_owner, lease_expires_at, execution_generation, attempts, status, outcome_report_state FROM mail_jobs WHERE delivery_id = '${id}';`,
      );
      expect(claimed).toMatchObject({
        lease_owner: owner,
        lease_expires_at: futureExpiry,
        execution_generation: 1,
        attempts: 1,
        status: 'processing',
        outcome_report_state: 'none',
      });

      // Statement (a) with a live (unexpired) lease must not apply
      runSqlFile(canonicalSql.claimStatementA(id, 'lease-owner-2', futureExpiry));
      const stillOwns = queryOne<Record<string, unknown>>(
        `SELECT lease_owner, execution_generation, attempts FROM mail_jobs WHERE delivery_id = '${id}';`,
      );
      expect(stillOwns).toMatchObject({
        lease_owner: owner,
        execution_generation: 1,
        attempts: 1,
      });

      // Release: clear both lease fields via a valid conditional UPDATE (same owner, still processing)
      runSqlFile(
        `UPDATE mail_jobs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ${now} WHERE delivery_id = '${id}' AND lease_owner = '${owner}';`,
      );
      const released = queryOne<Record<string, unknown>>(
        `SELECT lease_owner, lease_expires_at, status FROM mail_jobs WHERE delivery_id = '${id}';`,
      );
      expect(released).toMatchObject({
        lease_owner: null,
        lease_expires_at: null,
        status: 'processing',
      });

      // After release a second claim succeeds (past expiry still allowed since lease is free)
      runSqlFile(canonicalSql.claimStatementA(id, 'lease-owner-2', pastExpiry));
      const reclaimed = queryOne<Record<string, unknown>>(
        `SELECT lease_owner, attempts FROM mail_jobs WHERE delivery_id = '${id}';`,
      );
      expect(reclaimed).toMatchObject({ lease_owner: 'lease-owner-2', attempts: 2 });
    },
    TEST_TIMEOUT,
  );

  it(
    'supports report lease acquire/release, generation advance and blocked transitions',
    () => {
      const id = 'd-report-1';
      const owner = 'lease-owner-r1';
      runSqlFile(canonicalSql.initialInsert(id));
      runSqlFile(canonicalSql.claimStatementA(id, owner, pastExpiry));
      runSqlFile(canonicalSql.persistResult(id, 'sent'));
      const sent = queryOne<Record<string, unknown>>(
        `SELECT status, outcome_report_state, lease_owner, lease_expires_at FROM mail_jobs WHERE delivery_id = '${id}';`,
      );
      expect(sent).toMatchObject({
        status: 'sent',
        outcome_report_state: 'pending',
        lease_owner: null,
        lease_expires_at: null,
      });

      // Report retry: acquire report lease increments report_attempts
      runSqlFile(canonicalSql.acquireReportLease(id, 'report-owner-1', pastExpiry));
      const reportClaimed = queryOne<Record<string, unknown>>(
        `SELECT report_lease_owner, report_lease_expires_at, report_attempts FROM mail_jobs WHERE delivery_id = '${id}';`,
      );
      expect(reportClaimed).toMatchObject({
        report_lease_owner: 'report-owner-1',
        report_attempts: 1,
      });

      // Report retry: acquire lại sau khi report lease hết hạn → report_attempts tăng tiếp
      runSqlFile(canonicalSql.acquireReportLease(id, 'report-owner-2', pastExpiry));
      const reportRetried = queryOne<Record<string, unknown>>(
        `SELECT report_lease_owner, report_attempts FROM mail_jobs WHERE delivery_id = '${id}';`,
      );
      expect(reportRetried).toMatchObject({
        report_lease_owner: 'report-owner-2',
        report_attempts: 2,
      });

      // Release report lease while marking reported
      runSqlFile(canonicalSql.releaseReportLeaseReported(id));
      const reported = queryOne<Record<string, unknown>>(
        `SELECT outcome_report_state, report_lease_owner, report_lease_expires_at FROM mail_jobs WHERE delivery_id = '${id}';`,
      );
      expect(reported).toMatchObject({
        outcome_report_state: 'reported',
        report_lease_owner: null,
        report_lease_expires_at: null,
      });

      // Generation advance (statement b): returns to processing, clears report lease and blocked_at
      runSqlFile(canonicalSql.generationAdvanceB(id, 'lease-owner-3', now + 400000, 2, 3));
      const advanced = queryOne<Record<string, unknown>>(
        `SELECT status, outcome_report_state, dispatch_generation, execution_generation, attempts, report_attempts, blocked_at FROM mail_jobs WHERE delivery_id = '${id}';`,
      );
      expect(advanced).toMatchObject({
        status: 'processing',
        outcome_report_state: 'none',
        dispatch_generation: 2,
        execution_generation: 3,
        attempts: 1,
        report_attempts: 0,
        blocked_at: null,
      });

      // Budget exhausted (statement c): blocked state with blocked_at
      runSqlFile(canonicalSql.budgetExhaustedC(id, 'lease-owner-3', now + 400000));
      const blocked = queryOne<Record<string, unknown>>(
        `SELECT status, blocked_at, outcome_report_state, lease_owner, lease_expires_at, last_error_class FROM mail_jobs WHERE delivery_id = '${id}';`,
      );
      expect(blocked).toMatchObject({
        status: 'blocked',
        blocked_at: now + 400000,
        outcome_report_state: 'pending',
        lease_owner: null,
        lease_expires_at: null,
        last_error_class: 'execution-budget-exhausted',
      });

      // Generation advance from blocked clears blocked_at and report lease
      runSqlFile(canonicalSql.generationAdvanceB(id, 'lease-owner-4', now + 500000, 3, 4));
      const reprocessed = queryOne<Record<string, unknown>>(
        `SELECT status, blocked_at, outcome_report_state, report_lease_owner, report_lease_expires_at FROM mail_jobs WHERE delivery_id = '${id}';`,
      );
      expect(reprocessed).toMatchObject({
        status: 'processing',
        blocked_at: null,
        outcome_report_state: 'none',
        report_lease_owner: null,
        report_lease_expires_at: null,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'accepts every canonical value of status, outcome_report_state and quarantine reason',
    () => {
      // status/outcome_report_state hợp lệ theo §7: none ⟺ processing, còn lại ∈ sent/failed/blocked
      const stateRows: [string, string, string][] = [
        ['canon-processing', 'processing', 'none'],
        ['canon-sent', 'sent', 'pending'],
        ['canon-failed', 'failed', 'pending'],
        ['canon-reported', 'sent', 'reported'],
        ['canon-superseded', 'sent', 'superseded'],
        ['canon-orphaned', 'sent', 'orphaned'],
      ];
      for (const [id, status, outcome] of stateRows) {
        runSqlFile(
          `INSERT INTO mail_jobs (delivery_id, dispatch_generation, status, outcome_report_state) VALUES ('${id}', 1, '${status}', '${outcome}');`,
        );
      }
      // blocked cần blocked_at đi kèm (invariant blocked ⟺ blocked_at NOT NULL)
      runSqlFile(
        `INSERT INTO mail_jobs (delivery_id, dispatch_generation, status, outcome_report_state, blocked_at) VALUES ('canon-blocked', 1, 'blocked', 'pending', ${now});`,
      );
      expect(
        query(`SELECT delivery_id FROM mail_jobs WHERE delivery_id LIKE 'canon-%';`),
      ).toHaveLength(stateRows.length + 1);

      // Cả bốn reason canonical của quarantine phải chèn được
      const reasons = [
        'missing-delivery-id',
        'unparseable-body',
        'unsupported-version',
        'forbidden-field',
      ];
      for (const reason of reasons) {
        const fieldName = reason === 'forbidden-field' ? 'extra' : null;
        runSqlFile(
          quarantineSql.insert(
            `canon-digest-${reason}`,
            `canon-msg-${reason}`,
            reason,
            fieldName,
            1,
          ),
        );
      }
      expect(
        queryOne<{ n: number }>(
          `SELECT count(*) AS n FROM quarantine WHERE queue_message_id LIKE 'canon-msg-%';`,
        )['n'],
      ).toBe(reasons.length);
    },
    TEST_TIMEOUT,
  );

  // Mỗi case chèn một row mới với id riêng và cố tình vi phạm ĐÚNG MỘT constraint, rồi assert TÊN
  // constraint đó trong thông báo lỗi. Không assert chung chung "có CHECK fail": một CHECK khác
  // (vd. reconcile report↔status) có thể che mất constraint đang muốn kiểm và làm test xanh giả dù
  // constraint mục tiêu đã bị xoá. Assert theo tên vừa chỉ đích danh constraint vừa chốt luôn
  // convention đặt tên constraint của repo.
  it.each([
    [
      'status outside the canonical enum',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, status, outcome_report_state) VALUES ('r-status-enum', 1, 'queued', 'pending');`,
      'CHECK constraint failed: mail_jobs_status_check',
    ],
    [
      'outcome report state outside the canonical enum',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, status, outcome_report_state) VALUES ('r-outcome-enum', 1, 'sent', 'done');`,
      'CHECK constraint failed: mail_jobs_outcome_report_state_check',
    ],
    [
      'report state none while status is not processing',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, status, outcome_report_state) VALUES ('r-reconcile', 1, 'sent', 'none');`,
      'CHECK constraint failed: mail_jobs_report_state_parity_check',
    ],
    [
      'blocked status without blocked_at',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, status, outcome_report_state) VALUES ('r-blocked-noat', 1, 'blocked', 'pending');`,
      'CHECK constraint failed: mail_jobs_blocked_at_parity_check',
    ],
    [
      'blocked_at on processing status',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, status, outcome_report_state, blocked_at) VALUES ('r-blockedat', 1, 'processing', 'none', ${now});`,
      'CHECK constraint failed: mail_jobs_blocked_at_parity_check',
    ],
    [
      'negative attempts',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, attempts) VALUES ('r-attempts', 1, -1);`,
      'CHECK constraint failed: mail_jobs_attempts_check',
    ],
    [
      'negative execution generation',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, execution_generation) VALUES ('r-execgen', 1, -1);`,
      'CHECK constraint failed: mail_jobs_execution_generation_check',
    ],
    [
      'negative report attempts',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, report_attempts) VALUES ('r-reportatt', 1, -1);`,
      'CHECK constraint failed: mail_jobs_report_attempts_check',
    ],
    [
      'zero dispatch generation',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation) VALUES ('r-dispatchgen', 0);`,
      'CHECK constraint failed: mail_jobs_dispatch_generation_check',
    ],
    [
      'lease owner without lease expiry',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, lease_owner) VALUES ('r-leaseowner', 1, 'owner-1');`,
      'CHECK constraint failed: mail_jobs_lease_pair_check',
    ],
    [
      'lease expiry without lease owner',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, lease_expires_at) VALUES ('r-leaseexp', 1, ${now});`,
      'CHECK constraint failed: mail_jobs_lease_pair_check',
    ],
    [
      'report lease owner without report lease expiry',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, report_lease_owner) VALUES ('r-rleaseowner', 1, 'owner-1');`,
      'CHECK constraint failed: mail_jobs_report_lease_pair_check',
    ],
    [
      'report lease expiry without report lease owner',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation, report_lease_expires_at) VALUES ('r-rleaseexp', 1, ${now});`,
      'CHECK constraint failed: mail_jobs_report_lease_pair_check',
    ],
    [
      'empty delivery id',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation) VALUES ('', 1);`,
      'CHECK constraint failed: mail_jobs_delivery_id_non_empty_check',
    ],
    [
      'quarantine reason outside the canonical enum',
      quarantineSql.insert('r-q-reason', 'r-q-msg-reason', 'missing-body', null, 1),
      'CHECK constraint failed: quarantine_reason_check',
    ],
    [
      'quarantine attempts below one',
      quarantineSql.insert('r-q-attempts', 'r-q-msg-attempts', 'missing-delivery-id', null, 0),
      'CHECK constraint failed: quarantine_attempts_check',
    ],
    [
      'forbidden-field reason without the offending key name',
      quarantineSql.insert('r-q-forbidden', 'r-q-msg-forbidden', 'forbidden-field', null, 1),
      'CHECK constraint failed: quarantine_forbidden_field_name_check',
    ],
    [
      'empty quarantine id',
      quarantineSql.insert('', 'r-q-msg-empty', 'missing-delivery-id', null, 1),
      'CHECK constraint failed: quarantine_quarantine_id_non_empty_check',
    ],
    [
      'quarantine missing queue message id',
      `INSERT INTO quarantine (quarantine_id, queue_message_id, reason, attempts) VALUES ('r-q-null-msg', NULL, 'missing-delivery-id', 1);`,
      'NOT NULL constraint failed: quarantine.queue_message_id',
    ],
    [
      'quarantine missing quarantine id',
      `INSERT INTO quarantine (quarantine_id, queue_message_id, reason, attempts) VALUES (NULL, 'r-q-msg-null-id', 'missing-delivery-id', 1);`,
      'NOT NULL constraint failed: quarantine.quarantine_id',
    ],
    // Hai insert trong cùng một batch: batch là một transaction nên insert thứ hai thất bại sẽ
    // rollback cả batch, không để lại row nào. Assertion bắt đúng tên cột của PRIMARY KEY.
    [
      'duplicate delivery id on the primary key',
      `INSERT INTO mail_jobs (delivery_id, dispatch_generation) VALUES ('r-dup', 1); INSERT INTO mail_jobs (delivery_id, dispatch_generation) VALUES ('r-dup', 1);`,
      'UNIQUE constraint failed: mail_jobs.delivery_id',
    ],
  ])(
    'rejects %s',
    (_name, sql, expected) => {
      expect(rejectionOutput(sql)).toContain(`${expected}:`);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps sanitized quarantine records keyed by (quarantine_id, queue_message_id) without loss or duplicate rows',
    () => {
      const bodyDigest = 'same-hmac-of-raw-body';
      // Two different messages, identical raw body -> same HMAC digest
      runSqlFile(quarantineSql.insert(bodyDigest, 'q-msg-a', 'unparseable-body', null, 1));
      runSqlFile(quarantineSql.insert(bodyDigest, 'q-msg-b', 'unparseable-body', null, 1));
      const rows = query(
        `SELECT queue_message_id, reason, attempts FROM quarantine WHERE quarantine_id = '${bodyDigest}' ORDER BY queue_message_id;`,
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r['queue_message_id'])).toEqual(['q-msg-a', 'q-msg-b']);

      // Re-processing the same message is idempotent: no new row, only attempts increments
      runSqlFile(quarantineSql.upsertRepeat(bodyDigest, 'q-msg-a'));
      const afterRepeat = query(
        `SELECT queue_message_id, reason, attempts FROM quarantine WHERE quarantine_id = '${bodyDigest}' ORDER BY queue_message_id;`,
      );
      expect(afterRepeat).toHaveLength(2);
      expect(afterRepeat.find((r) => r['queue_message_id'] === 'q-msg-a')).toMatchObject({
        reason: 'unparseable-body',
        attempts: 2,
      });
      expect(afterRepeat.find((r) => r['queue_message_id'] === 'q-msg-b')).toMatchObject({
        attempts: 1,
      });

      // forbidden-field records store the key NAME only (never the value)
      runSqlFile(
        quarantineSql.insert(
          'q-forbidden-field-digest',
          'q-msg-forbidden',
          'forbidden-field',
          'extra',
          1,
        ),
      );
      const forbidden = queryOne<Record<string, unknown>>(
        `SELECT reason, field_name, attempts FROM quarantine WHERE queue_message_id = 'q-msg-forbidden';`,
      );
      expect(forbidden).toMatchObject({ reason: 'forbidden-field', field_name: 'extra' });
    },
    TEST_TIMEOUT,
  );

  it(
    'has no columns or indexes based on recipient, rendered content or credentials',
    () => {
      const forbiddenName = /recipient|subject|body|payload|content|secret|credential|token/iu;
      const allColumns = [
        ...query(`SELECT name FROM pragma_table_info('mail_jobs');`).map((row) =>
          String(row['name']),
        ),
        ...query(`SELECT name FROM pragma_table_info('quarantine');`).map((row) =>
          String(row['name']),
        ),
      ];
      expect(allColumns.filter((name) => forbiddenName.test(name))).toEqual([]);

      const indexSql = query(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('mail_jobs', 'quarantine') AND name NOT LIKE 'sqlite_%';`,
      ).map((row) => String(row['sql']));
      expect(indexSql.every((sql) => !forbiddenName.test(sql))).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
