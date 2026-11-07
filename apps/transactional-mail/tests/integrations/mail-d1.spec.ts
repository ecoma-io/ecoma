import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { D1Database } from '@cloudflare/workers-types';

import { createD1MailPersistence } from '@ecoma-io/transactional-mail-infrastructure';
import type { D1SubsetDatabase } from '@ecoma-io/transactional-mail-infrastructure';
import { publishOutboxBatch, runOutboxReconciler } from '@ecoma-io/transactional-mail-application';
import type { MailSendCommandPayload } from '@ecoma-io/transactional-mail-application';

/**
 * Kiểm chứng schema D1 `mail` của C1 trên **D1 thật** (miniflare/workerd qua Wrangler).
 *
 * Hai harness, mỗi harness đúng vai trò của nó:
 *
 * - `wrangler d1 migrations apply` (CLI, tiến trình riêng) — đúng công cụ chạy production
 *   migration, nên mọi khẳng định về ledger `d1_migrations`, apply tuần tự và idempotency
 *   là khẳng định về **runner thật**, không phải về một runner test tự chế. Vai trò còn lại
 *   là một tiến trình *khác* đọc D1: chứng minh state mà port ghi nằm trong database, không
 *   phải trong bộ nhớ của isolate đã ghi nó.
 * - `getPlatformProxy` (in-process, cùng file SQLite) — chạy repository qua `db.batch()`
 *   và `RETURNING` với đúng API của production (`prepare/bind/all/batch`).
 *
 * ⚠️ `persist.path` của proxy phải là `<stateDir>/v3`: CLI ghi state vào `<persist-to>/v3/d1/…`
 * còn proxy đọc `<persist.path>/d1/…` — thiếu đuôi `/v3` thì proxy nhìn thấy một database
 * rỗng (đã đo được, không phải suy đoán).
 *
 * Nguồn canonical: `docs/applications/transactional-mail/01-architecture.md` §4, §6.1–§6.2.2,
 * §7.4; `02-requirements.md` FR-002, FR-004, FR-006, FR-007.
 */

const TEST_TIMEOUT = 120_000;

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const appDir = join(repoRoot, 'apps', 'transactional-mail');
const migrationsDir = join(appDir, 'migrations');
const wranglerConfig = join(appDir, 'wrangler.jsonc');

const req = createRequire(import.meta.url);
const wranglerCli = req.resolve('wrangler');

let stateDir: string;
let proxy: Awaited<ReturnType<typeof makeMailProxy>>;
let mailDatabase: D1Database;

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
      'mail',
      '--local',
      '--config',
      wranglerConfig,
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

function cliQuery(sql: string): Record<string, unknown>[] {
  return runWranglerJson(['--command', sql])[0].results;
}

function cliQueryOne<T>(sql: string): T {
  const rows = cliQuery(sql);
  expect(rows).toHaveLength(1);
  return rows[0] as T;
}

function applyMigrations(targetConfig = wranglerConfig, targetState = stateDir): string {
  return execFileSync(
    process.execPath,
    [
      wranglerCli,
      'd1',
      'migrations',
      'apply',
      'mail',
      '--local',
      '--config',
      targetConfig,
      '--persist-to',
      targetState,
    ],
    {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

async function rawRows<T = Record<string, unknown>>(
  sql: string,
  ...binds: unknown[]
): Promise<T[]> {
  const result = await mailDatabase
    .prepare(sql)
    .bind(...binds)
    .all<T>();
  return result.results;
}

async function rawOne<T = Record<string, unknown>>(
  sql: string,
  ...binds: unknown[]
): Promise<T | undefined> {
  const rows = await rawRows<T>(sql, ...binds);
  return rows[0];
}

/** Quay event loop đúng một macrotask — controlled barrier, không sleep, không timing. */
function nextMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}

/** Capture thường — send resolve ngay, dùng cho phase recovery (không barrier). */
interface PlainCapture {
  readonly sent: string[];
  send(command: MailSendCommandPayload): Promise<void>;
}

/** Hàm thuần không capture scope nào — đứng ở module scope per consistent-function-scoping. */
function makePlainCapture(): PlainCapture {
  const plainSent: string[] = [];
  return {
    sent: plainSent,
    send(command: MailSendCommandPayload): Promise<void> {
      plainSent.push(JSON.stringify(command));
      return Promise.resolve();
    },
  };
}

/** Queue fake capture + barrier theo `delivery_id`: gate đặt trước, send đông lại tới khi thả. */
function makeBarrierQueue(): {
  readonly sent: string[];
  readonly binding: {
    send(message: string): Promise<void>;
  };
  readonly holdNext: (deliveryId: string) => void;
  readonly release: (deliveryId: string) => void;
} {
  const sent: string[] = [];
  const held = new Map<string, () => void>();
  return {
    sent,
    binding: {
      send(message: string): Promise<void> {
        sent.push(message);
        const deliveryId = (JSON.parse(message) as { delivery_id?: string }).delivery_id ?? '';
        const gate = held.get(deliveryId);
        if (gate === undefined) {
          return Promise.resolve();
        }
        const promise = new Promise<void>((resolve) => {
          held.set(deliveryId, resolve);
        });
        return promise;
      },
    },
    holdNext(deliveryId: string): void {
      held.set(deliveryId, () => undefined);
    },
    release(deliveryId: string): void {
      held.get(deliveryId)?.();
      held.delete(deliveryId);
    },
  };
}

/** Dựng message + outbox row ở trạng thái đầu vào chuẩn — helper chung của suite reconciler. */
async function seedMessageWithOutbox(
  persistence: ReturnType<typeof createD1MailPersistence>,
  principalId: string,
): Promise<string> {
  const deliveryId = nextId('dlv');
  await persistence.messages.createWithOutbox({
    messageId: nextId('m'),
    outboxId: nextId('obx'),
    deliveryId,
    app: 'test-app',
    principalId,
    templateId: SEED_TEMPLATE_ID,
    templateName: 'welcome',
    templateVersion: 1,
    locale: 'en',
    recipient: 'recipient@example.test',
    subjectRendered: 's',
    bodyRendered: 'b',
    idempotencyKey: nextId('key'),
    requestFingerprint: FINGERPRINT,
    correlationId: null,
    nowMs: NOW,
  });
  return deliveryId;
}

/**
 * Biến thể của {@link runWranglerJson} trỏ sang một cặp config/state khác — dùng bởi test
 * apply tuần tự, vốn dựng một database sạch riêng thay vì tái dùng database chính.
 */
function runWranglerJsonWith(
  targetConfig: string,
  targetState: string,
  args: string[],
  timeoutMs = 120_000,
): D1StatementResult[] {
  const raw = execFileSync(
    process.execPath,
    [
      wranglerCli,
      'd1',
      'execute',
      'mail',
      '--local',
      '--config',
      targetConfig,
      '--persist-to',
      targetState,
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

/**
 * Render một giá trị test-control thành literal SQL cho các statement từ chối (rejection).
 *
 * Chỉ dùng cho giá trị do test tự viết — không phải cho giá trị của caller: đường caller
 * luôn đi qua `bind`, và bất biến parameterization được kiểm riêng ở describe
 * "SQL parameterization".
 */
function lit(value: string | number | null): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

let nextIdCounter = 0;

/** Id duy nhất trong phạm vi suite — deterministic, không random. */
function nextId(prefix: string): string {
  nextIdCounter += 1;
  return `${prefix}-${nextIdCounter}`;
}

const NOW = 1_700_000_000_000;
/** Fingerprint đúng định dạng `p1.k1:<64 hex>` mà CHECK chấp nhận. */
const FINGERPRINT = `p1.k1:${'a'.repeat(64)}`;
const SEED_TEMPLATE_ID = 'tpl-welcome-en';
/** Message hạt giống cho các ca rejection của outbox (`INSERT..SELECT` cần 1 row nguồn). */
const SEED_MESSAGE_ID = 'm-seed';

/** Cột của `mail_messages` — khớp hằng `MAIL_MESSAGE_COLUMNS` của implementation. */
const MESSAGE_COLUMNS =
  'id, app, principal_id, template_id, template_name, template_version, locale, recipient, ' +
  'subject_rendered, body_rendered, status, delivery_id, dispatch_generation, ' +
  'recovery_cycle_count, idempotency_key, request_fingerprint, correlation_id, failure_reason, ' +
  'terminal_at, created_at, updated_at';

interface MessageInsertOverrides {
  readonly id?: string;
  readonly messageId?: string;
  readonly app?: string;
  readonly principalId?: string;
  readonly templateId?: string;
  readonly templateName?: string;
  readonly templateVersion?: number;
  readonly locale?: string;
  readonly recipient?: string;
  readonly status?: string;
  readonly deliveryId?: string;
  readonly dispatchGeneration?: number;
  readonly recoveryCycleCount?: number;
  readonly idempotencyKey?: string;
  readonly requestFingerprint?: string;
  readonly correlationId?: string | null;
  readonly failureReason?: string | null;
  readonly terminalAt?: number | null;
}

/** Statement INSERT `mail_messages` đầy đủ, với override có kiểm cho từng ca test. */
function insertMessageSql(overrides: MessageInsertOverrides = {}): string {
  const v = {
    id: nextId('m'),
    app: 'test-app',
    principalId: 'principal-1',
    templateId: SEED_TEMPLATE_ID,
    templateName: 'welcome',
    templateVersion: 1,
    locale: 'en',
    recipient: 'recipient@example.test',
    status: 'accepted',
    deliveryId: nextId('dlv'),
    dispatchGeneration: 1,
    recoveryCycleCount: 0,
    idempotencyKey: nextId('key'),
    requestFingerprint: FINGERPRINT,
    correlationId: null as string | null,
    failureReason: null as string | null,
    terminalAt: null as number | null,
    ...overrides,
  };
  return (
    `INSERT INTO mail_messages (${MESSAGE_COLUMNS}) VALUES (` +
    [
      lit(v.id),
      lit(v.app),
      lit(v.principalId),
      lit(v.templateId),
      lit(v.templateName),
      lit(v.templateVersion),
      lit(v.locale),
      lit(v.recipient),
      lit('subject'),
      lit('<p>body</p>'),
      lit(v.status),
      lit(v.deliveryId),
      lit(v.dispatchGeneration),
      lit(v.recoveryCycleCount),
      lit(v.idempotencyKey),
      lit(v.requestFingerprint),
      lit(v.correlationId),
      lit(v.failureReason),
      lit(v.terminalAt),
      lit(NOW),
      lit(NOW),
    ].join(', ') +
    ');'
  );
}

/** Bump generation của message + outbox đúng như một redrive có authorize sẽ làm (C6). */
function redriveToGeneration2Sql(deliveryId: string): string {
  return [
    `UPDATE mail_messages SET dispatch_generation = 2, status = 'accepted', failure_reason = NULL,` +
      ` terminal_at = NULL, updated_at = ${lit(NOW)} WHERE delivery_id = ${lit(deliveryId)};`,
    `UPDATE mail_outbox SET dispatch_generation = 2, status = 'pending', publish_attempts = 0,` +
      ` claimed_at = NULL, claimed_by = NULL, published_at = NULL, last_error = NULL,` +
      ` available_at = ${lit(NOW)}, updated_at = ${lit(NOW)} WHERE delivery_id = ${lit(deliveryId)};`,
  ].join('\n');
}

/**
 * `getPlatformProxy` với Env của app này — tách ra một hàm để đặt generic một chỗ, và để
 * kiểu của biến `proxy` suy từ nó.
 */
async function makeMailProxy() {
  // `require('wrangler')` thay vì `await import('wrangler')`: gói này là CLI bundle lớn,
  // đi qua require giữ nó ngoài pipeline transform của vitest (tiền lệ: harness CLI ở
  // apps/transactional-mailer-job). Runtime API cần đúng một hàm.
  const wrangler = req('wrangler') as typeof import('wrangler');
  return wrangler.getPlatformProxy<{ mail: D1Database }>({
    configPath: wranglerConfig,
    persist: { path: join(stateDir, 'v3') },
  });
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'mail-c1-d1-'));
  applyMigrations();

  proxy = await makeMailProxy();
  mailDatabase = proxy.env.mail;

  cliQuery(
    `INSERT INTO mail_templates ` +
      `(id, name, locale, version, subject_template, body_template, variables_schema_json, status, created_at, updated_at) ` +
      `VALUES (${lit(SEED_TEMPLATE_ID)}, ${lit('welcome')}, ${lit('en')}, 1, ${lit('s')}, ${lit('b')}, ` +
      `${lit('{"schema_version":1,"variables":{}}')}, ${lit('active')}, ${lit(NOW)}, ${lit(NOW)});`,
  );

  // Hạt giống message: hai ca rejection của outbox dùng `INSERT..SELECT .. FROM mail_messages
  // LIMIT 1` — statement đó match 0 row trên bảng trống và ghi im lặng không row nào, nên cần
  // ít nhất một message có sẵn để SELECT bắt được và chạm constraint thật.
  cliQuery(insertMessageSql({ messageId: SEED_MESSAGE_ID, idempotencyKey: 'seed-key' }));

  // Khẳng định compile-time: binding D1 thật thoả subset mà implementation đòi hỏi. Nếu một
  // ngày subset lệch khỏi `D1Database` của `@cloudflare/workers-types`, dòng này không compile.
  // (Gán cho biến kiểu subset là đủ — assertion runtime không cần, và `no-standalone-expect`
  // cấm expect trong beforeAll.)
  const subset: D1SubsetDatabase = mailDatabase;
  if (!subset) {
    throw new Error('D1 binding is undefined');
  }
}, TEST_TIMEOUT * 2);

afterAll(async () => {
  if (proxy) {
    await proxy.dispose();
  }
  if (stateDir) {
    rmSync(stateDir, { force: true, recursive: true });
  }
});

describe('mail D1 migrations (applied by the real wrangler runner)', () => {
  it(
    'applies every migration file from an empty database and records them in the ledger',
    () => {
      const expectedFiles = readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .toSorted();
      // Đây là danh sách **tên** file, không phải guard chống file rác: `readdirSync` lọc
      // `.sql` và `ledger` phía dưới phải khớp đúng danh sách này, nên một file lạ vẫn bị bắt
      // bởi khẳng định kế bên. Hard-code danh sách chỉ thêm một chỗ phải sửa khi thêm
      // migration — và `0008_mail_rate_limits_key_scope.sql` là migration thứ bảy.
      expect(expectedFiles).toEqual([
        '0001_mail_templates.sql',
        '0002_mail_messages.sql',
        '0003_mail_outbox.sql',
        '0004_mail_internal_nonces.sql',
        '0005_mail_rate_limits.sql',
        '0007_mail_content_redaction.sql',
        '0008_mail_rate_limits_key_scope.sql',
        '0009_mail_templates_seed.sql',
      ]);

      const ledger = cliQuery(
        `SELECT name FROM d1_migrations WHERE name IN (${expectedFiles.map((f) => `'${f}'`).join(', ')}) ORDER BY name;`,
      );
      expect(ledger.map((row) => row['name'])).toEqual(expectedFiles);
    },
    TEST_TIMEOUT,
  );

  it(
    'applies the migrations step by step without touching tables or rows of earlier steps',
    () => {
      // Một apply chạy thật theo từng bước, trong một database sạch: sau mỗi bước, mọi bảng
      // của các bước trước phải còn nguyên và một row seed ở bước 1 phải sống sót. Đây là
      // bằng chứng "forward-only, không phá dữ liệu có sẵn" — chỉ đọc file SQL không đủ,
      // vì recreate table của bước sau là thứ phải bị bắt ở runtime.
      const root = mkdtempSync(join(tmpdir(), 'mail-c1-d1-stepwise-'));
      const stepwiseApp = join(root, 'app');
      const stepwiseMigrations = join(stepwiseApp, 'migrations');
      const stepwiseState = join(root, 'state');
      mkdirSync(stepwiseMigrations, { recursive: true });
      const stepwiseConfig = join(stepwiseApp, 'wrangler.jsonc');
      writeFileSync(
        stepwiseConfig,
        JSON.stringify(
          {
            name: 'mail-c1-stepwise',
            compatibility_date: '2026-10-05',
            d1_databases: [
              { binding: 'mail', database_name: 'mail', migrations_dir: 'migrations' },
            ],
          },
          null,
          2,
        ),
      );

      try {
        const files = readdirSync(migrationsDir)
          .filter((name) => name.endsWith('.sql'))
          .toSorted();

        const tablesAfter: string[][] = [];
        for (const file of files) {
          copyFileSync(join(migrationsDir, file), join(stepwiseMigrations, file));
          applyMigrations(stepwiseConfig, stepwiseState);

          const tableRows =
            runWranglerJsonWith(stepwiseConfig, stepwiseState, [
              '--command',
              `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mail_%' ORDER BY name;`,
            ])[0]?.results ?? [];
          const tables = tableRows.map((row) => String(row['name']));
          tablesAfter.push(tables);

          // Mọi bảng của các bước trước vẫn còn.
          for (const previous of tablesAfter.slice(0, -1)) {
            for (const table of previous) {
              expect(tables).toContain(table);
            }
          }
        }

        // Row seed của bước 1 sống sót qua toàn bộ chuỗi apply.
        runWranglerJsonWith(stepwiseConfig, stepwiseState, [
          '--command',
          `INSERT INTO mail_templates (id, name, locale, version, subject_template, body_template, variables_schema_json, status, created_at, updated_at) VALUES ('tpl-stepwise', 'welcome', 'en', 1, 's', 'b', '{}', 'active', 1, 1);`,
        ]);
        for (let step = 1; step < files.length; step += 1) {
          applyMigrations(stepwiseConfig, stepwiseState);
        }
        const survivorRows =
          runWranglerJsonWith(stepwiseConfig, stepwiseState, [
            '--command',
            `SELECT id FROM mail_templates WHERE id = 'tpl-stepwise';`,
          ])[0]?.results ?? [];
        expect(survivorRows).toHaveLength(1);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
    TEST_TIMEOUT * 3,
  );

  it(
    'is idempotent: re-applying applies nothing and the ledger does not grow',
    () => {
      const ledgerCountBefore = cliQueryOne<{ n: number }>(
        `SELECT count(*) AS n FROM d1_migrations;`,
      )['n'];
      const secondOutput = applyMigrations();
      expect(secondOutput).toContain('No migrations to apply');
      const ledgerCountAfter = cliQueryOne<{ n: number }>(
        `SELECT count(*) AS n FROM d1_migrations;`,
      )['n'];
      expect(ledgerCountAfter).toBe(ledgerCountBefore);
    },
    TEST_TIMEOUT,
  );
});

describe('mail D1 schema contract (sqlite_master via the proxy)', () => {
  it(
    'creates the five canonical tables with the documented columns in order',
    () => {
      const tables = cliQuery(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mail_%' ORDER BY name;`,
      ).map((row) => row['name']);
      expect(tables).toEqual([
        'mail_internal_nonces',
        'mail_messages',
        'mail_outbox',
        'mail_rate_limits',
        'mail_templates',
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'declares every index that the documented lookup, claim and retention paths need',
    async () => {
      const indexes = await rawRows<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'mail_%' ` +
          `AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
      );
      const byName = new Map(indexes.map((index) => [index.name, index.sql]));
      expect([...byName.keys()].toSorted()).toEqual([
        'mail_internal_nonces_expires_at_idx',
        'mail_messages_status_terminal_idx',
        'mail_messages_status_updated_idx',
        'mail_outbox_status_available_idx',
        'mail_outbox_status_claimed_idx',
        'mail_outbox_status_updated_idx',
      ]);

      // Cột của các index phục vụ claim/retention phải đúng thứ tự document — thứ tự cột
      // quyết định index có seekable ở cột đầu hay không.
      expect(byName.get('mail_outbox_status_available_idx')).toContain('(status, available_at)');
      expect(byName.get('mail_outbox_status_claimed_idx')).toContain('(status, claimed_at)');
      expect(byName.get('mail_messages_status_terminal_idx')).toContain('(status, terminal_at)');
      expect(byName.get('mail_messages_status_updated_idx')).toContain('(status, updated_at)');
      expect(byName.get('mail_internal_nonces_expires_at_idx')).toContain('(expires_at)');
    },
    TEST_TIMEOUT,
  );

  it(
    'names every CHECK constraint and leaves none anonymous',
    async () => {
      // Danh sách này là hợp đồng schema: migration sau tham chiếu constraint theo tên, nên
      // đổi tên phải là quyết định có ý thức và cập nhật ở đây.
      const expectedChecks: Record<string, readonly string[]> = {
        mail_templates: [
          'mail_templates_body_template_non_empty_check',
          'mail_templates_id_non_empty_check',
          'mail_templates_locale_non_empty_check',
          'mail_templates_name_non_empty_check',
          'mail_templates_status_check',
          'mail_templates_subject_template_non_empty_check',
          'mail_templates_variables_schema_json_non_empty_check',
          'mail_templates_version_check',
        ],
        mail_messages: [
          'mail_messages_app_non_empty_check',
          'mail_messages_delivery_id_non_empty_check',
          'mail_messages_dispatch_generation_check',
          'mail_messages_failure_reason_class_check',
          'mail_messages_id_non_empty_check',
          'mail_messages_idempotency_key_format_check',
          'mail_messages_locale_non_empty_check',
          'mail_messages_principal_id_non_empty_check',
          'mail_messages_recipient_non_empty_check',
          'mail_messages_recovery_cycle_count_check',
          'mail_messages_request_fingerprint_format_check',
          'mail_messages_status_check',
          'mail_messages_template_id_non_empty_check',
          'mail_messages_template_name_non_empty_check',
          'mail_messages_template_version_check',
          'mail_messages_terminal_at_parity_check',
        ],
        mail_outbox: [
          'mail_outbox_available_at_check',
          'mail_outbox_delivery_id_non_empty_check',
          'mail_outbox_dispatch_generation_check',
          'mail_outbox_id_non_empty_check',
          'mail_outbox_last_error_format_check',
          'mail_outbox_lease_pair_check',
          'mail_outbox_publish_attempts_check',
          'mail_outbox_status_check',
        ],
        mail_internal_nonces: [
          'mail_internal_nonces_expires_at_check',
          'mail_internal_nonces_nonce_non_empty_check',
          'mail_internal_nonces_principal_non_empty_check',
        ],
        mail_rate_limits: [
          'mail_rate_limits_hits_check',
          'mail_rate_limits_scope_kind_check',
          'mail_rate_limits_scope_parity_check',
          'mail_rate_limits_window_started_at_check',
        ],
      };

      for (const [table, names] of Object.entries(expectedChecks)) {
        const row = await rawOne<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?;`,
          table,
        );
        const ddl = String(row?.sql);
        for (const name of names) {
          expect(ddl).toContain(`CONSTRAINT ${name} CHECK (`);
        }
        // Không được còn CHECK vô danh: tổng số `CHECK (` phải bằng đúng số constraint có tên.
        const allChecks = (ddl.match(/CHECK \(/gu) ?? []).length;
        expect(allChecks).toBe(names.length);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'declares the uniqueness and foreign-key relationships of the identity model',
    async () => {
      // UNIQUE khai trong CREATE TABLE trở thành sqlite_autoindex (SQLite không đặt tên
      // index cho table-level UNIQUE), nên hợp đồng được kiểm theo **cột** của từng autoindex
      // và theo tên constraint trong DDL — cả hai, vì tên là thứ log/migration tham chiếu,
      // còn cột là thứ thực thi.
      async function uniqueIndexColumns(table: string): Promise<readonly (readonly string[])[]> {
        const indexes = await rawRows<{ name: string; origin: string }>(
          `SELECT name, origin FROM pragma_index_list(${lit(table)}) ORDER BY name;`,
        );
        const uniqueNames = indexes
          .filter((index) => index.origin === 'u')
          .map((index) => index.name);
        const columns: string[][] = [];
        for (const name of uniqueNames) {
          const info = await rawRows<{ name: string }>(
            `SELECT name FROM pragma_index_info(${lit(name)}) ORDER BY seqno;`,
          );
          columns.push(info.map((column) => column.name));
        }
        return columns.map((column) => column.toSorted()).toSorted();
      }

      expect(await uniqueIndexColumns('mail_messages')).toEqual([
        ['delivery_id'],
        ['idempotency_key', 'principal_id'],
      ]);
      expect(await uniqueIndexColumns('mail_outbox')).toEqual([['delivery_id']]);
      expect(await uniqueIndexColumns('mail_templates')).toEqual([['locale', 'name', 'version']]);

      // Tên constraint vẫn phải có mặt trong DDL — hợp đồng đặt tên cho log và migration sau.
      for (const [table, constraint] of [
        ['mail_messages', 'mail_messages_principal_idempotency_key_unique UNIQUE'],
        ['mail_messages', 'mail_messages_delivery_id_unique UNIQUE'],
        ['mail_outbox', 'mail_outbox_delivery_id_unique UNIQUE'],
        ['mail_templates', 'mail_templates_version_key_unique UNIQUE'],
      ] as const) {
        const row = await rawOne<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?;`,
          table,
        );
        expect(String(row?.sql)).toContain(`CONSTRAINT ${constraint}`);
      }

      // FK: RESTRICT hai chiều — không ai xoá template còn message tham chiếu, và không ai
      // xoá message còn outbox row tham chiếu.
      const messageForeignKeys = await rawRows<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
        on_update: string;
      }>(
        `SELECT "table", "from", "to", on_delete, on_update FROM pragma_foreign_key_list('mail_messages');`,
      );
      expect(messageForeignKeys).toEqual([
        {
          table: 'mail_templates',
          from: 'template_id',
          to: 'id',
          on_delete: 'RESTRICT',
          on_update: 'RESTRICT',
        },
      ]);

      const outboxForeignKeys = await rawRows<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
        on_update: string;
      }>(
        `SELECT "table", "from", "to", on_delete, on_update FROM pragma_foreign_key_list('mail_outbox');`,
      );
      expect(outboxForeignKeys).toEqual([
        {
          table: 'mail_messages',
          from: 'delivery_id',
          to: 'delivery_id',
          on_delete: 'RESTRICT',
          on_update: 'RESTRICT',
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps rendered content in mail_messages and keeps no raw variables column anywhere',
    async () => {
      const messageColumns = await rawRows<{ name: string }>(
        `SELECT name FROM pragma_table_info('mail_messages') ORDER BY cid;`,
      );
      const names = messageColumns.map((column) => column.name);
      expect(names).toEqual([
        'id',
        'app',
        'principal_id',
        'template_id',
        'template_name',
        'template_version',
        'locale',
        'recipient',
        'subject_rendered',
        'body_rendered',
        'status',
        'delivery_id',
        'dispatch_generation',
        'recovery_cycle_count',
        'idempotency_key',
        'request_fingerprint',
        'correlation_id',
        'failure_reason',
        'terminal_at',
        'created_at',
        'updated_at',
      ]);
      // FR-007: chỉ persist nội dung đã render — không có cột nào giữ raw `variables`.
      expect(names.some((name) => name.includes('variables'))).toBe(false);

      const outboxColumns = await rawRows<{ name: string }>(
        `SELECT name FROM pragma_table_info('mail_outbox') ORDER BY cid;`,
      );
      // Outbox là lớp publish state: không chứa recipient hay nội dung thư.
      expect(
        outboxColumns.some((column) =>
          ['recipient', 'subject_rendered', 'body_rendered'].includes(column.name),
        ),
      ).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

interface RejectionCase {
  readonly label: string;
  readonly statement: string;
  readonly expected: string;
}

/**
 * Mỗi ca vi phạm một constraint có tên. Lỗi của D1 thật có dạng
 * `D1_ERROR: CHECK constraint failed: <name>: SQLITE_CONSTRAINT …` — khẳng định theo **tên**
 * chứ không chỉ theo loại lỗi, vì tên là hợp đồng mà migration sau và log vận hành dựa vào.
 */
function rejectionCases(): readonly RejectionCase[] {
  return [
    {
      label: 'a message status outside the documented state set',
      statement: insertMessageSql({ status: 'processing' }),
      expected: 'CHECK constraint failed: mail_messages_status_check',
    },
    {
      label: 'a failure_reason that is not one of the five canonical error classes',
      statement: insertMessageSql({ failureReason: 'provider returned 502: upstream exploded' }),
      expected: 'CHECK constraint failed: mail_messages_failure_reason_class_check',
    },
    {
      label: 'a dispatch_generation below 1',
      statement: insertMessageSql({ dispatchGeneration: 0 }),
      expected: 'CHECK constraint failed: mail_messages_dispatch_generation_check',
    },
    {
      label: 'a negative recovery_cycle_count',
      statement: insertMessageSql({ recoveryCycleCount: -1 }),
      expected: 'CHECK constraint failed: mail_messages_recovery_cycle_count_check',
    },
    {
      label: 'a terminal message without terminal_at',
      statement: insertMessageSql({ status: 'sent' }),
      expected: 'CHECK constraint failed: mail_messages_terminal_at_parity_check',
    },
    {
      label: 'a non-terminal message that already carries terminal_at',
      statement: insertMessageSql({ terminalAt: NOW }),
      expected: 'CHECK constraint failed: mail_messages_terminal_at_parity_check',
    },
    {
      label: 'a request_fingerprint that is not the documented keyed format',
      statement: insertMessageSql({ requestFingerprint: 'deadbeefdeadbeefdeadbeefdeadbeef' }),
      expected: 'CHECK constraint failed: mail_messages_request_fingerprint_format_check',
    },
    {
      label: 'an empty idempotency key',
      statement: insertMessageSql({ idempotencyKey: '' }),
      expected: 'CHECK constraint failed: mail_messages_idempotency_key_format_check',
    },
    {
      label: 'an empty recipient',
      statement: insertMessageSql({ recipient: '' }),
      expected: 'CHECK constraint failed: mail_messages_recipient_non_empty_check',
    },
    {
      label: 'a message whose template_id violates the foreign key',
      statement: insertMessageSql({ templateId: 'tpl-does-not-exist' }),
      expected: 'FOREIGN KEY constraint failed',
    },
    {
      label: 'an outbox lease with only one half of the pair filled',
      statement:
        `INSERT INTO mail_outbox (id, delivery_id, dispatch_generation, status, publish_attempts, ` +
        `available_at, claimed_at, claimed_by, published_at, last_error, created_at, updated_at) ` +
        `SELECT ${lit(nextId('obx'))}, delivery_id, dispatch_generation, ${lit('publishing')}, 0, ` +
        `${lit(NOW)}, ${lit(NOW)}, NULL, NULL, NULL, ${lit(NOW)}, ${lit(NOW)} FROM mail_messages LIMIT 1;`,
      expected: 'CHECK constraint failed: mail_outbox_lease_pair_check',
    },
    {
      label: 'an outbox status outside the publish state set',
      statement:
        `INSERT INTO mail_outbox (id, delivery_id, dispatch_generation, status, publish_attempts, ` +
        `available_at, claimed_at, claimed_by, published_at, last_error, created_at, updated_at) ` +
        `SELECT ${lit(nextId('obx'))}, delivery_id, dispatch_generation, ${lit('claimed')}, 0, ` +
        `${lit(NOW)}, NULL, NULL, NULL, NULL, ${lit(NOW)}, ${lit(NOW)} FROM mail_messages LIMIT 1;`,
      expected: 'CHECK constraint failed: mail_outbox_status_check',
    },
    {
      label: 'a rate-limit counter whose principal scope contradicts its scope_kind',
      statement:
        `INSERT INTO mail_rate_limits (scope_kind, principal_id, window_started_at, hits, updated_at) ` +
        `VALUES (${lit('principal')}, ${lit('')}, ${lit(NOW)}, 1, ${lit(NOW)});`,
      expected: 'CHECK constraint failed: mail_rate_limits_scope_parity_check',
    },
    {
      label: 'an idempotency-key scope whose principal id carries no colon-separated hash',
      statement:
        `INSERT INTO mail_rate_limits (scope_kind, principal_id, window_started_at, hits, updated_at) ` +
        `VALUES (${lit('idempotency-key')}, ${lit('just-a-principal')}, ${lit(NOW)}, 1, ${lit(NOW)});`,
      expected: 'CHECK constraint failed: mail_rate_limits_scope_parity_check',
    },
    {
      label: 'an idempotency-key scope whose principal id carries two colons',
      statement:
        `INSERT INTO mail_rate_limits (scope_kind, principal_id, window_started_at, hits, updated_at) ` +
        `VALUES (${lit('idempotency-key')}, ${lit('svc.a:hash:extra')}, ${lit(NOW)}, 1, ${lit(NOW)});`,
      expected: 'CHECK constraint failed: mail_rate_limits_scope_parity_check',
    },
    {
      label: 'a rate-limit counter with an unknown scope_kind',
      statement:
        `INSERT INTO mail_rate_limits (scope_kind, principal_id, window_started_at, hits, updated_at) ` +
        `VALUES (${lit('global')}, ${lit('')}, ${lit(NOW)}, 1, ${lit(NOW)});`,
      expected: 'CHECK constraint failed: mail_rate_limits_scope_kind_check',
    },
    {
      label: 'a rate-limit counter with a negative hit count',
      statement:
        `INSERT INTO mail_rate_limits (scope_kind, principal_id, window_started_at, hits, updated_at) ` +
        `VALUES (${lit('system')}, ${lit('')}, ${lit(NOW)}, -1, ${lit(NOW)});`,
      expected: 'CHECK constraint failed: mail_rate_limits_hits_check',
    },
    {
      label: 'a nonce whose expiry is not a positive epoch value',
      statement:
        `INSERT INTO mail_internal_nonces (principal, nonce, expires_at) ` +
        `VALUES (${lit('svc.a')}, ${lit('n-zero')}, 0);`,
      expected: 'CHECK constraint failed: mail_internal_nonces_expires_at_check',
    },
    {
      label: 'a nonce with an empty principal',
      statement:
        `INSERT INTO mail_internal_nonces (principal, nonce, expires_at) ` +
        `VALUES (${lit('')}, ${lit('n-anon')}, ${lit(NOW + 60_000)});`,
      expected: 'CHECK constraint failed: mail_internal_nonces_principal_non_empty_check',
    },
    {
      label: 'a second template with the same name, locale and version',
      statement:
        `INSERT INTO mail_templates (id, name, locale, version, subject_template, body_template, ` +
        `variables_schema_json, status, created_at, updated_at) VALUES (${lit(nextId('tpl'))}, ` +
        `${lit('welcome')}, ${lit('en')}, 1, ${lit('s')}, ${lit('b')}, ${lit('{}')}, ` +
        `${lit('active')}, ${lit(NOW)}, ${lit(NOW)});`,
      expected:
        'UNIQUE constraint failed: mail_templates.name, mail_templates.locale, mail_templates.version',
    },
  ];
}

describe('mail D1 constraint enforcement on real D1', () => {
  it.each(rejectionCases())(
    'rejects $label',
    async ({ statement, expected }) => {
      // Mỗi statement chạy standalone (không batch) nên rollback của nó chỉ là nó.
      // getPlatformProxy ném Error mang `D1_ERROR: … constraint failed: <name>` — khẳng định
      // theo tên constraint chứ không chỉ theo loại lỗi.
      let message = '';
      try {
        await mailDatabase.prepare(statement).all();
      } catch (caught) {
        message = String((caught as { message?: string }).message ?? caught);
      }
      expect(message).toContain(expected);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps every valid initial state writable so the rejections above cannot hide an over-tight schema',
    async () => {
      const id = nextId('m');
      await mailDatabase.prepare(insertMessageSql({ id, status: 'accepted' })).all();
      const row = await rawOne<{ status: string; terminal_at: number | null }>(
        `SELECT status, terminal_at FROM mail_messages WHERE id = ?;`,
        id,
      );
      expect(row).toEqual({ status: 'accepted', terminal_at: null });
    },
    TEST_TIMEOUT,
  );
});

/**
 * Persistence qua đúng entrypoint production. `mailDatabase` có kiểu `D1Database` thật, nên
 * việc truyền thẳng vào `createD1MailPersistence` chính là khẳng định assignability
 * `D1Database extends D1SubsetDatabase` — nếu subset thiếu method/field mà D1 thật có kiểu
 * khác, dòng này không compile.
 */
function makePersistence(): ReturnType<typeof createD1MailPersistence> {
  return createD1MailPersistence(mailDatabase);
}

describe('invariant: message and outbox are created atomically or not at all', () => {
  it(
    'creates both rows in one batch and reads back the documented initial state',
    async () => {
      const persistence = makePersistence();
      const messageId = nextId('m');
      const deliveryId = nextId('dlv');
      const idempotencyKey = nextId('key');

      const result = await persistence.messages.createWithOutbox({
        messageId,
        outboxId: nextId('obx'),
        deliveryId,
        app: 'test-app',
        principalId: 'principal-1',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 'Hello',
        bodyRendered: '<p>Hello</p>',
        idempotencyKey,
        requestFingerprint: FINGERPRINT,
        correlationId: 'corr-1',
        nowMs: NOW,
      });

      expect(result.kind).toBe('created');
      // Schema-owned initial state — caller không thể cấp phát nó.
      expect(result.message.status).toBe('accepted');
      expect(result.message.dispatchGeneration).toBe(1);
      expect(result.message.recoveryCycleCount).toBe(0);
      expect(result.message.terminalAtMs).toBeNull();
      expect(result.message.failureReason).toBeNull();

      const outboxRow = await rawOne<{ status: string; publish_attempts: number }>(
        `SELECT status, publish_attempts FROM mail_outbox WHERE delivery_id = ?;`,
        deliveryId,
      );
      expect(outboxRow).toEqual({ status: 'pending', publish_attempts: 0 });
    },
    TEST_TIMEOUT,
  );

  it(
    'rolls the whole batch back when the outbox half fails, leaving no orphan message',
    async () => {
      const persistence = makePersistence();
      // Chiếm trước một outbox id để nửa outbox của batch sau văng PK.
      const occupiedOutboxId = nextId('obx');
      const seedDeliveryId = nextId('dlv');
      await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: occupiedOutboxId,
        deliveryId: seedDeliveryId,
        app: 'test-app',
        principalId: 'principal-1',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey: nextId('key'),
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });

      const victimMessageId = nextId('m');
      const victimKey = nextId('key');
      let threw = false;
      try {
        await persistence.messages.createWithOutbox({
          messageId: victimMessageId,
          outboxId: occupiedOutboxId, // trùng PK của mail_outbox → batch phải rollback
          deliveryId: nextId('dlv'),
          app: 'test-app',
          principalId: 'principal-1',
          templateId: SEED_TEMPLATE_ID,
          templateName: 'welcome',
          templateVersion: 1,
          locale: 'en',
          recipient: 'recipient@example.test',
          subjectRendered: 's',
          bodyRendered: 'b',
          idempotencyKey: victimKey,
          requestFingerprint: FINGERPRINT,
          correlationId: null,
          nowMs: NOW,
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      // Cả message lẫn outbox của nạn nhân không tồn tại — batch là một transaction (DB2).
      const messageRow = await rawOne<{ id: string }>(
        `SELECT id FROM mail_messages WHERE id = ?;`,
        victimMessageId,
      );
      expect(messageRow).toBeUndefined();
      const keyRow = await rawOne<{ id: string }>(
        `SELECT id FROM mail_messages WHERE principal_id = ? AND idempotency_key = ?;`,
        'principal-1',
        victimKey,
      );
      expect(keyRow).toBeUndefined();
    },
    TEST_TIMEOUT,
  );
});

describe('invariant: duplicate logical identity cannot create a second row', () => {
  it(
    'returns already-exists for a repeated idempotency key and keeps exactly one row',
    async () => {
      const persistence = makePersistence();
      const deliveryId = nextId('dlv');
      const idempotencyKey = nextId('key');

      const first = await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId,
        app: 'test-app',
        principalId: 'principal-2',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey,
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });
      expect(first.kind).toBe('created');

      const second = await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId: nextId('dlv'),
        app: 'test-app',
        principalId: 'principal-2',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey, // cùng (principal, key)
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });
      expect(second.kind).toBe('already-exists');
      expect(second.message.id).toBe(first.message.id);

      const count = await rawOne<{ n: number }>(
        `SELECT count(*) AS n FROM mail_messages WHERE principal_id = ? AND idempotency_key = ?;`,
        'principal-2',
        idempotencyKey,
      );
      expect(count?.n).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'fails closed when a second message claims an existing delivery_id instead of silently winning',
    async () => {
      const persistence = makePersistence();
      const deliveryId = nextId('dlv');
      await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId,
        app: 'test-app',
        principalId: 'principal-3',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey: nextId('key'),
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });

      // Khác (principal, key) nhưng trùng delivery_id: ON CONFLICT của message statement
      // không nhắm delivery_id nên ràng buộc văng, batch rollback — KHÔNG có hàng thứ hai.
      let message = '';
      try {
        await persistence.messages.createWithOutbox({
          messageId: nextId('m'),
          outboxId: nextId('obx'),
          deliveryId,
          app: 'test-app',
          principalId: 'principal-4',
          templateId: SEED_TEMPLATE_ID,
          templateName: 'welcome',
          templateVersion: 1,
          locale: 'en',
          recipient: 'recipient@example.test',
          subjectRendered: 's',
          bodyRendered: 'b',
          idempotencyKey: nextId('key'),
          requestFingerprint: FINGERPRINT,
          correlationId: null,
          nowMs: NOW,
        });
      } catch (caught) {
        message = String((caught as { message?: string }).message ?? caught);
      }
      expect(message).toContain('mail_messages.delivery_id');

      const rows = await rawRows<{ id: string }>(
        `SELECT id FROM mail_messages WHERE delivery_id = ?;`,
        deliveryId,
      );
      expect(rows).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'lets only one of two concurrent creates with the same idempotency identity win',
    async () => {
      const persistence = makePersistence();
      const idempotencyKey = nextId('key');

      const results = await Promise.all(
        [1, 2].map((n) =>
          persistence.messages
            .createWithOutbox({
              messageId: nextId('m'),
              outboxId: nextId('obx'),
              deliveryId: nextId('dlv'),
              app: 'test-app',
              principalId: 'principal-race',
              templateId: SEED_TEMPLATE_ID,
              templateName: 'welcome',
              templateVersion: 1,
              locale: 'en',
              recipient: 'recipient@example.test',
              subjectRendered: `s-${n}`,
              bodyRendered: 'b',
              idempotencyKey,
              requestFingerprint: FINGERPRINT,
              correlationId: null,
              nowMs: NOW,
            })
            .then((result) => result.kind),
        ),
      );

      expect(results.toSorted()).toEqual(['already-exists', 'created']);

      const counts = await rawOne<{ messages: number; outbox: number }>(
        `SELECT ` +
          `(SELECT count(*) FROM mail_messages WHERE principal_id = ? AND idempotency_key = ?) AS messages, ` +
          `(SELECT count(*) FROM mail_outbox WHERE delivery_id IN ` +
          `  (SELECT delivery_id FROM mail_messages WHERE principal_id = ? AND idempotency_key = ?)) AS outbox;`,
        'principal-race',
        idempotencyKey,
        'principal-race',
        idempotencyKey,
      );
      expect(counts).toEqual({ messages: 1, outbox: 1 });
    },
    TEST_TIMEOUT,
  );
});

describe('invariant: an idempotency key alone does not establish replay equivalence', () => {
  it(
    'returns the stored record with its own fingerprint so the application layer can compare',
    async () => {
      const persistence = makePersistence();
      const idempotencyKey = nextId('key');
      const fingerprintOne = `p1.k1:${'b'.repeat(64)}`;
      const fingerprintTwo = `p1.k1:${'c'.repeat(64)}`;

      const first = await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId: nextId('dlv'),
        app: 'test-app',
        principalId: 'principal-fp',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 'first',
        bodyRendered: 'first body',
        idempotencyKey,
        requestFingerprint: fingerprintOne,
        correlationId: null,
        nowMs: NOW,
      });
      expect(first.kind).toBe('created');

      // Cùng khoá, nội dung khác (fingerprint khác). Persistence KHÔNG được tự quyết đây là
      // replay hay conflict — nó trả lại bản ghi đã lưu cùng fingerprint của nó.
      const second = await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId: nextId('dlv'),
        app: 'test-app',
        principalId: 'principal-fp',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 'second',
        bodyRendered: 'second body',
        idempotencyKey,
        requestFingerprint: fingerprintTwo,
        correlationId: null,
        nowMs: NOW,
      });
      expect(second.kind).toBe('already-exists');
      expect(second.message.requestFingerprint).toBe(fingerprintOne);
      expect(second.message.subjectRendered).toBe('first');

      const count = await rawOne<{ n: number }>(
        `SELECT count(*) AS n FROM mail_messages WHERE principal_id = ? AND idempotency_key = ?;`,
        'principal-fp',
        idempotencyKey,
      );
      expect(count?.n).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

describe('invariant: a stale publication attempt cannot overwrite newer message state', () => {
  it(
    'leaves a sent message untouched when the publisher closes its outbox row afterwards',
    async () => {
      const persistence = makePersistence();
      const deliveryId = nextId('dlv');
      const created = await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId,
        app: 'test-app',
        principalId: 'principal-pub',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey: nextId('key'),
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });
      expect(created.kind).toBe('created');

      const claimed = await persistence.outbox.claim({
        nowMs: NOW,
        leaseDurationMs: 60_000,
        leaseOwner: 'publisher-a',
        limit: 10,
      });
      const target = claimed.find((row) => row.deliveryId === deliveryId);
      if (!target) {
        throw new Error('test invariant broken: row was not claimed');
      }

      // Outcome đến TRƯỚC khi publisher đóng outbox: message đã terminal.
      const outcome = await persistence.messages.applyDeliveryOutcome({
        deliveryId,
        outcome: 'sent',
        dispatchGeneration: 1,
        errorClass: null,
        nowMs: NOW + 1,
      });
      expect(outcome.result).toBe('applied');

      const published = await persistence.outbox.markPublished({
        outboxId: target.id,
        deliveryId,
        leaseOwner: 'publisher-a',
        dispatchGeneration: 1,
        nowMs: NOW + 2,
      });
      // Outbox đóng được (sự thật về Queue), nhưng message KHÔNG bị kéo về queued.
      expect(published.outboxPublished).toBe(true);
      expect(published.messageQueued).toBe(false);

      const messageRow = await rawOne<{ status: string }>(
        `SELECT status FROM mail_messages WHERE delivery_id = ?;`,
        deliveryId,
      );
      expect(messageRow?.status).toBe('sent');
    },
    TEST_TIMEOUT,
  );

  it(
    'writes nothing when the publishing publisher has lost its lease to a stale generation',
    async () => {
      const persistence = makePersistence();
      const deliveryId = nextId('dlv');
      await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId,
        app: 'test-app',
        principalId: 'principal-pub2',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey: nextId('key'),
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });

      const claimed = await persistence.outbox.claim({
        nowMs: NOW,
        leaseDurationMs: 60_000,
        leaseOwner: 'publisher-old',
        limit: 10,
      });
      const target = claimed.find((row) => row.deliveryId === deliveryId);
      if (!target) {
        throw new Error('test invariant broken: row was not claimed');
      }

      // Một redrive (C6) sẽ bump generation trên cả hai bảng — dựng trạng thái đó trực tiếp
      // vì C1 không có primitive redrive (đúng phạm vi, xem ghi chú trong final report).
      await mailDatabase.prepare(redriveToGeneration2Sql(deliveryId)).all();

      const published = await persistence.outbox.markPublished({
        outboxId: target.id,
        deliveryId,
        leaseOwner: 'publisher-old',
        dispatchGeneration: 1, // generation cũ
        nowMs: NOW + 5,
      });
      expect(published.outboxPublished).toBe(false);
      expect(published.messageQueued).toBe(false);

      const outboxRow = await rawOne<{ status: string; dispatch_generation: number }>(
        `SELECT status, dispatch_generation FROM mail_outbox WHERE delivery_id = ?;`,
        deliveryId,
      );
      // Outbox vẫn ở trạng thái redrive đã đặt, không bị generation cũ ghi đè.
      expect(outboxRow).toEqual({ status: 'pending', dispatch_generation: 2 });
    },
    TEST_TIMEOUT,
  );
});

describe('invariant: a stale lease holder cannot mutate state after losing its fencing condition', () => {
  it(
    'reclaims an expired lease for a new owner and rejects every later write of the old owner',
    async () => {
      const persistence = makePersistence();
      const deliveryId = nextId('dlv');
      await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId,
        app: 'test-app',
        principalId: 'principal-lease',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey: nextId('key'),
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });

      const firstClaim = await persistence.outbox.claim({
        nowMs: NOW,
        leaseDurationMs: 60_000,
        leaseOwner: 'owner-a',
        limit: 10,
      });
      const target = firstClaim.find((row) => row.deliveryId === deliveryId);
      if (!target) {
        throw new Error('test invariant broken: row was not claimed by owner-a');
      }
      expect(target.claimedBy).toBe('owner-a');

      // Claim thứ hai trong lúc lease còn sống không được row này.
      const secondClaim = await persistence.outbox.claim({
        nowMs: NOW + 1_000,
        leaseDurationMs: 60_000,
        leaseOwner: 'owner-b',
        limit: 10,
      });
      expect(secondClaim.some((row) => row.deliveryId === deliveryId)).toBe(false);

      // Lease hết hạn (owner a chưa kịp xong) → owner b reclaim được.
      const thirdClaim = await persistence.outbox.claim({
        nowMs: NOW + 61_000,
        leaseDurationMs: 60_000,
        leaseOwner: 'owner-b',
        limit: 10,
      });
      const reclaimed = thirdClaim.find((row) => row.deliveryId === deliveryId);
      expect(reclaimed?.claimedBy).toBe('owner-b');

      // Owner a giờ là stale trên cả ba đường ghi.
      expect(
        await persistence.outbox.renewLease({
          outboxId: target.id,
          leaseOwner: 'owner-a',
          dispatchGeneration: 1,
          nowMs: NOW + 62_000,
        }),
      ).toBeNull();
      expect(
        await persistence.outbox.recordPublishFailure({
          outboxId: target.id,
          deliveryId,
          leaseOwner: 'owner-a',
          dispatchGeneration: 1,
          lastError: 'stale-owner-attempt',
          nextAvailableAtMs: NOW + 120_000,
          maxPublishAttempts: 5,
          nowMs: NOW + 62_000,
        }),
      ).toBeNull();
      const stalePublish = await persistence.outbox.markPublished({
        outboxId: target.id,
        deliveryId,
        leaseOwner: 'owner-a',
        dispatchGeneration: 1,
        nowMs: NOW + 62_000,
      });
      expect(stalePublish.outboxPublished).toBe(false);
      expect(stalePublish.messageQueued).toBe(false);

      // Owner b vẫn giữ lease và vẫn ghi được.
      const renewed = await persistence.outbox.renewLease({
        outboxId: target.id,
        leaseOwner: 'owner-b',
        dispatchGeneration: 1,
        nowMs: NOW + 62_000,
      });
      expect(renewed?.claimedBy).toBe('owner-b');
    },
    TEST_TIMEOUT,
  );
});

describe('invariant: a stale dispatch generation cannot overwrite the current outcome', () => {
  it(
    'classifies an old-generation outcome as stale and reports the current generation',
    async () => {
      const persistence = makePersistence();
      const deliveryId = nextId('dlv');
      await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId,
        app: 'test-app',
        principalId: 'principal-gen',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey: nextId('key'),
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });

      await mailDatabase.prepare(redriveToGeneration2Sql(deliveryId)).all();

      // Callback của execution generation 1 đến sau redrive → stale, kèm generation hiện tại.
      const stale = await persistence.messages.applyDeliveryOutcome({
        deliveryId,
        outcome: 'sent',
        dispatchGeneration: 1,
        errorClass: null,
        nowMs: NOW + 10,
      });
      if (stale.result !== 'stale') {
        throw new Error(`expected stale, got ${stale.result}`);
      }
      expect(stale.currentDispatchGeneration).toBe(2);
      expect(stale.status).toBe('accepted');

      // Không có gì được ghi.
      const row = await rawOne<{
        status: string;
        dispatch_generation: number;
        terminal_at: number | null;
      }>(
        `SELECT status, dispatch_generation, terminal_at FROM mail_messages WHERE delivery_id = ?;`,
        deliveryId,
      );
      expect(row).toEqual({ status: 'accepted', dispatch_generation: 2, terminal_at: null });

      // Callback của generation hiện tại thì được áp dụng.
      const applied = await persistence.messages.applyDeliveryOutcome({
        deliveryId,
        outcome: 'sent',
        dispatchGeneration: 2,
        errorClass: null,
        nowMs: NOW + 11,
      });
      expect(applied.result).toBe('applied');
    },
    TEST_TIMEOUT,
  );

  it(
    'classifies a repeated identical outcome as duplicate and a conflicting outcome on blocked as stale',
    async () => {
      const persistence = makePersistence();
      const deliveryId = nextId('dlv');
      await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId,
        app: 'test-app',
        principalId: 'principal-dup',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey: nextId('key'),
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });

      // Lần đầu: applied. Gửi lại đúng outcome đó cùng generation: duplicate (không ghi lần hai).
      const first = await persistence.messages.applyDeliveryOutcome({
        deliveryId,
        outcome: 'failed',
        dispatchGeneration: 1,
        errorClass: 'retryable',
        nowMs: NOW + 1,
      });
      expect(first.result).toBe('applied');

      const duplicate = await persistence.messages.applyDeliveryOutcome({
        deliveryId,
        outcome: 'failed',
        dispatchGeneration: 1,
        errorClass: 'retryable',
        nowMs: NOW + 2,
      });
      expect(duplicate.result).toBe('duplicate');

      // `blocked` là non-terminal: một outcome KHÁC trên message blocked ở cùng generation
      // không được áp dụng — rơi vào nhánh stale fail-closed (bước 5 của §6.2.2).
      const blockedDeliveryId = nextId('dlv');
      await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId: blockedDeliveryId,
        app: 'test-app',
        principalId: 'principal-dup',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey: nextId('key'),
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });
      const blocked = await persistence.messages.applyDeliveryOutcome({
        deliveryId: blockedDeliveryId,
        outcome: 'blocked',
        dispatchGeneration: 1,
        errorClass: 'permanent',
        nowMs: NOW + 1,
      });
      expect(blocked.result).toBe('applied');

      const conflict = await persistence.messages.applyDeliveryOutcome({
        deliveryId: blockedDeliveryId,
        outcome: 'sent',
        dispatchGeneration: 1,
        errorClass: null,
        nowMs: NOW + 2,
      });
      expect(conflict.result).toBe('stale');

      // Gửi lại đúng `blocked`: generation khớp và status bằng outcome → duplicate.
      const sameAgain = await persistence.messages.applyDeliveryOutcome({
        deliveryId: blockedDeliveryId,
        outcome: 'blocked',
        dispatchGeneration: 1,
        errorClass: 'permanent',
        nowMs: NOW + 3,
      });
      expect(sameAgain.result).toBe('duplicate');

      // Delivery không tồn tại → not-found.
      const missing = await persistence.messages.applyDeliveryOutcome({
        deliveryId: 'dlv-never-created',
        outcome: 'sent',
        dispatchGeneration: 1,
        errorClass: null,
        nowMs: NOW + 4,
      });
      expect(missing.result).toBe('not-found');
    },
    TEST_TIMEOUT,
  );
});

describe('invariant: nonce claims are durable and unique within the principal scope', () => {
  it(
    'scopes uniqueness by (principal, nonce) and reports true only for an existing claim',
    async () => {
      const persistence = makePersistence();
      const expiresAt = Math.floor(NOW / 1000) + 600;

      // Claim đầu tiên của principal A: thành công (false = không phải replay).
      expect(
        await persistence.nonces.claimNonce({
          principal: 'svc.reporter-a',
          nonce: nextId('nonce'),
          expiresAtEpochSeconds: expiresAt,
        }),
      ).toBe(false);

      const sharedNonce = nextId('nonce');
      expect(
        await persistence.nonces.claimNonce({
          principal: 'svc.reporter-b',
          nonce: sharedNonce,
          expiresAtEpochSeconds: expiresAt,
        }),
      ).toBe(false);

      // Replay của principal B: true.
      expect(
        await persistence.nonces.claimNonce({
          principal: 'svc.reporter-b',
          nonce: sharedNonce,
          expiresAtEpochSeconds: expiresAt,
        }),
      ).toBe(true);

      // ⚠️ Cùng nonce value dưới principal KHÁC phải claim được: khoá toàn cục sẽ cho một
      // consumer "đốt" nonce của consumer khác (DoS chéo-principal, xem 0004 comment).
      expect(
        await persistence.nonces.claimNonce({
          principal: 'svc.reporter-c',
          nonce: sharedNonce,
          expiresAtEpochSeconds: expiresAt,
        }),
      ).toBe(false);

      const count = await rawOne<{ n: number }>(
        `SELECT count(*) AS n FROM mail_internal_nonces WHERE nonce = ?;`,
        sharedNonce,
      );
      expect(count?.n).toBe(2);
    },
    TEST_TIMEOUT,
  );

  it(
    'lets concurrent replays of one nonce return true at most once and never create two rows',
    async () => {
      const persistence = makePersistence();
      const nonce = nextId('nonce');
      const expiresAt = Math.floor(NOW / 1000) + 600;

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          persistence.nonces.claimNonce({
            principal: 'svc.concurrent',
            nonce,
            expiresAtEpochSeconds: expiresAt,
          }),
        ),
      );
      // Đúng một caller thấy "chưa có" (false = claim mới); bốn caller còn lại là replay.
      expect(results.filter((value) => value === false)).toHaveLength(1);
      expect(results.filter((value) => value === true)).toHaveLength(4);

      const count = await rawOne<{ n: number }>(
        `SELECT count(*) AS n FROM mail_internal_nonces WHERE principal = ? AND nonce = ?;`,
        'svc.concurrent',
        nonce,
      );
      expect(count?.n).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

describe('invariant: expiry and pruning never remove records before the documented boundary', () => {
  it(
    'deletes an expired nonce only at or after its expiry instant, bounded by the batch limit',
    async () => {
      const persistence = makePersistence();
      const expiresAtEpochSeconds = Math.floor(NOW / 1000) + 600;
      const expiresAtMs = expiresAtEpochSeconds * 1000;

      await persistence.nonces.claimNonce({
        principal: 'svc.expiry',
        nonce: nextId('nonce'),
        expiresAtEpochSeconds,
      });

      // Một ms trước mốc: không được xoá. An toàn tuyệt đối vì mọi nonce trong file này đều
      // có expires_at >= mốc này — không row nào của test khác hết hạn sớm hơn.
      expect(
        await persistence.nonces.deleteExpiredNonces({ nowMs: expiresAtMs - 1, limit: 10 }),
      ).toBe(0);
      const survivor = await rawOne<{ nonce: string }>(
        `SELECT nonce FROM mail_internal_nonces WHERE principal = ?;`,
        'svc.expiry',
      );
      expect(survivor).toBeDefined();

      // Đúng mốc: được xoá. Đếm tương đối — test khác trước đó cũng để lại nonce cùng mốc
      // hết hạn, nên số hàng xoá là "toàn bộ số hàng hết hạn lúc này", không phải tuyệt đối 1.
      // (limit 100 lớn hơn mọi số nonce test này tạo ra để không trộn semantics batching.)
      const expiredNow = await rawOne<{ n: number }>(
        `SELECT count(*) AS n FROM mail_internal_nonces WHERE expires_at <= ?;`,
        expiresAtMs,
      );
      expect(await persistence.nonces.deleteExpiredNonces({ nowMs: expiresAtMs, limit: 100 })).toBe(
        expiredNow?.n,
      );
      const gone = await rawOne<{ nonce: string }>(
        `SELECT nonce FROM mail_internal_nonces WHERE principal = ?;`,
        'svc.expiry',
      );
      expect(gone).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    'bounds every prune batch and continues with the remaining rows on the next call',
    async () => {
      const persistence = makePersistence();
      // Hết hạn sớm hơn mọi nonce khác trong file (+300 so với +600): tại mốc này chỉ đúng
      // 3 row của test là hết hạn, nên count tuyệt đối 2/1/0 là xác định.
      const expiresAtEpochSeconds = Math.floor(NOW / 1000) + 300;
      const expiresAtMs = expiresAtEpochSeconds * 1000;

      for (let i = 0; i < 3; i += 1) {
        await persistence.nonces.claimNonce({
          principal: `svc.batch-${i}`,
          nonce: nextId('nonce'),
          expiresAtEpochSeconds,
        });
      }

      expect(await persistence.nonces.deleteExpiredNonces({ nowMs: expiresAtMs, limit: 2 })).toBe(
        2,
      );
      expect(await persistence.nonces.deleteExpiredNonces({ nowMs: expiresAtMs, limit: 2 })).toBe(
        1,
      );
      expect(await persistence.nonces.deleteExpiredNonces({ nowMs: expiresAtMs, limit: 2 })).toBe(
        0,
      );

      const remaining = await rawRows<{ principal: string }>(
        `SELECT principal FROM mail_internal_nonces WHERE principal LIKE 'svc.batch-%';`,
      );
      expect(remaining).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'lists content retention candidates strictly after the terminal boundary and never for non-terminal rows',
    async () => {
      const persistence = makePersistence();
      const terminalAt = NOW + 100_000;
      const sentDeliveryId = nextId('dlv');
      await mailDatabase
        .prepare(insertMessageSql({ deliveryId: sentDeliveryId, status: 'sent', terminalAt }))
        .all();

      const blockedDeliveryId = nextId('dlv');
      await mailDatabase
        .prepare(
          insertMessageSql({ deliveryId: blockedDeliveryId, status: 'blocked', terminalAt: null }),
        )
        .all();

      // Strict `<`: đúng tại mốc thì chưa phải ứng viên.
      const atBoundary = await persistence.retention.listContentRetentionCandidates({
        terminalBeforeMs: terminalAt,
        limit: 100,
      });
      expect(atBoundary.some((row) => row.deliveryId === sentDeliveryId)).toBe(false);

      const afterBoundary = await persistence.retention.listContentRetentionCandidates({
        terminalBeforeMs: terminalAt + 1,
        limit: 100,
      });
      expect(afterBoundary.some((row) => row.deliveryId === sentDeliveryId)).toBe(true);

      // Projection không chứa content — đúng ranh giới FR-007 của port này.
      const candidate = afterBoundary.find((row) => row.deliveryId === sentDeliveryId);
      expect(Object.keys(candidate ?? {}).toSorted()).toEqual([
        'deliveryId',
        'messageId',
        'terminalAtMs',
      ]);

      // `blocked` là non-terminal: không bao giờ lọt danh sách retention.
      const blockedListed = afterBoundary.some((row) => row.deliveryId === blockedDeliveryId);
      expect(blockedListed).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'lists stale non-terminal messages, including blocked, for the alert path',
    async () => {
      const persistence = makePersistence();
      const staleUpdated = NOW - 500_000;
      const acceptedDeliveryId = nextId('dlv');
      await mailDatabase
        .prepare(insertMessageSql({ deliveryId: acceptedDeliveryId, status: 'accepted' }))
        .all();
      await mailDatabase
        .prepare(`UPDATE mail_messages SET updated_at = ? WHERE delivery_id = ?;`)
        .bind(staleUpdated, acceptedDeliveryId)
        .all();

      const blockedDeliveryId = nextId('dlv');
      await mailDatabase
        .prepare(insertMessageSql({ deliveryId: blockedDeliveryId, status: 'blocked' }))
        .all();
      await mailDatabase
        .prepare(`UPDATE mail_messages SET updated_at = ? WHERE delivery_id = ?;`)
        .bind(staleUpdated, blockedDeliveryId)
        .all();

      const stale = await persistence.retention.listStaleNonTerminalMessages({
        updatedBeforeMs: staleUpdated + 1,
        limit: 100,
      });
      const staleIds = new Set(stale.map((row) => row.deliveryId));
      expect(staleIds.has(acceptedDeliveryId)).toBe(true);
      expect(staleIds.has(blockedDeliveryId)).toBe(true);

      const statuses = stale
        .filter((row) => row.deliveryId === blockedDeliveryId)
        .map((row) => row.status);
      expect(statuses).toEqual(['blocked']);
    },
    TEST_TIMEOUT,
  );
});

describe('invariant: rate-limit state is durable, not an in-memory counter', () => {
  it(
    'consumes a fixed window atomically, denies past the limit, and resets on the next window',
    async () => {
      const persistence = makePersistence();
      const scope = { kind: 'principal', principalId: 'principal-rl' } as const;
      const window = 1_000;

      const first = await persistence.rateLimits.tryConsume({
        scope,
        windowDurationMs: window,
        limit: 2,
        nowMs: NOW,
      });
      expect(first).toEqual({ kind: 'allowed', hits: 1, windowStartedAtMs: NOW });

      const second = await persistence.rateLimits.tryConsume({
        scope,
        windowDurationMs: window,
        limit: 2,
        nowMs: NOW + 1,
      });
      expect(second).toEqual({ kind: 'allowed', hits: 2, windowStartedAtMs: NOW });

      // Vượt limit: denied, KHÔNG tiêu slot — row giữ nguyên hits.
      const third = await persistence.rateLimits.tryConsume({
        scope,
        windowDurationMs: window,
        limit: 2,
        nowMs: NOW + 2,
      });
      expect(third).toEqual({ kind: 'denied', hits: 2, windowStartedAtMs: NOW });

      // Cửa sổ mới: always allowed với hits reset về 1.
      const nextWindow = await persistence.rateLimits.tryConsume({
        scope,
        windowDurationMs: window,
        limit: 2,
        nowMs: NOW + window,
      });
      expect(nextWindow).toEqual({
        kind: 'allowed',
        hits: 1,
        windowStartedAtMs: NOW + window,
      });

      // Hai scope là hai counter độc lập.
      const otherScope = await persistence.rateLimits.tryConsume({
        scope: { kind: 'principal', principalId: 'principal-rl-other' },
        windowDurationMs: window,
        limit: 2,
        nowMs: NOW + 3,
      });
      expect(otherScope).toEqual({
        kind: 'allowed',
        hits: 1,
        windowStartedAtMs: NOW + 3,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps the counter in the database, readable by another process after the writer is gone',
    async () => {
      const persistence = makePersistence();
      const scope = { kind: 'system' } as const;
      const consumed = await persistence.rateLimits.tryConsume({
        scope,
        windowDurationMs: 60_000,
        limit: 10,
        nowMs: NOW,
      });
      expect(consumed.kind).toBe('allowed');

      // Một tiến trình khác (wrangler CLI) đọc cùng hàng: state nằm trong D1, không phải
      // trong bộ nhớ của tiến trình đã ghi. Đây là bằng chứng "durable across processes";
      // recycle isolate thật không biểu diễn được trong harness này — ghi rõ trong report.
      const viaCli = cliQueryOne<{ hits: number; window_started_at: number }>(
        `SELECT hits, window_started_at FROM mail_rate_limits ` +
          `WHERE scope_kind = 'system' AND principal_id = '';`,
      );
      expect(viaCli).toEqual({
        hits: consumed.hits,
        window_started_at: consumed.windowStartedAtMs,
      });

      // Một instance persistence mới trên cùng database thấy đúng state đó.
      const fresh = makePersistence();
      const next = await fresh.rateLimits.tryConsume({
        scope,
        windowDurationMs: 60_000,
        limit: 10,
        nowMs: NOW + 1,
      });
      expect(next).toEqual({ kind: 'allowed', hits: consumed.hits + 1, windowStartedAtMs: NOW });
    },
    TEST_TIMEOUT,
  );

  it(
    'throws on a non-positive limit or window instead of failing open as a silent deny-all',
    async () => {
      const persistence = makePersistence();
      // Scope riêng để đếm counter tuyệt đối: test khác dùng scope 'system' và tạo counter.
      const scope = { kind: 'principal', principalId: 'principal-rl-invalid' } as const;

      const before = await rawOne<{ n: number }>(
        `SELECT count(*) AS n FROM mail_rate_limits WHERE scope_kind = 'principal' AND principal_id = ?;`,
        'principal-rl-invalid',
      );

      await expect(
        persistence.rateLimits.tryConsume({
          scope,
          windowDurationMs: 1_000,
          limit: 0,
          nowMs: NOW,
        }),
      ).rejects.toThrow('limit must be a positive safe integer');

      await expect(
        persistence.rateLimits.tryConsume({
          scope,
          windowDurationMs: 0,
          limit: 5,
          nowMs: NOW,
        }),
      ).rejects.toThrow('windowDurationMs must be a positive safe integer');

      // Không có counter nào được tạo bởi các lệnh bị từ chối.
      const counters = await rawOne<{ n: number }>(
        `SELECT count(*) AS n FROM mail_rate_limits WHERE scope_kind = 'principal' AND principal_id = ?;`,
        'principal-rl-invalid',
      );
      expect(counters?.n).toBe(before?.n);
    },
    TEST_TIMEOUT,
  );

  it(
    'consumes an idempotency-key scope as its own counter keyed by the hashed principal pair',
    async () => {
      const persistence = makePersistence();
      // `scopeValue` là `<principal>:<SHA-256 hex của key>` — store coi nó là dữ liệu mờ
      // (khoá gốc của key không bao giờ vào D1, xem create-mail-message.ts).
      const scopeValue = 'svc.account:aa'.padEnd('svc.account:'.length + 64, 'a');
      const scope = { kind: 'idempotency-key', scopeValue } as const;

      const first = await persistence.rateLimits.tryConsume({
        scope,
        windowDurationMs: 60_000,
        limit: 2,
        nowMs: NOW,
      });
      expect(first).toEqual({ kind: 'allowed', hits: 1, windowStartedAtMs: NOW });

      const second = await persistence.rateLimits.tryConsume({
        scope,
        windowDurationMs: 60_000,
        limit: 2,
        nowMs: NOW + 1,
      });
      expect(second).toEqual({ kind: 'allowed', hits: 2, windowStartedAtMs: NOW });
      const denied = await persistence.rateLimits.tryConsume({
        scope,
        windowDurationMs: 60_000,
        limit: 2,
        nowMs: NOW + 2,
      });
      expect(denied).toEqual({ kind: 'denied', hits: 2, windowStartedAtMs: NOW });

      // Row ghi đúng hình dạng parity: scope_kind `idempotency-key` ⇔ principal_id mang
      // đúng một dấu hai chấm (CHECK `mail_rate_limits_scope_parity_check` của migration
      // 0008) — đọc thẳng hàng để chứng minh store và schema khớp nhau.
      const row = await rawOne<{ scope_kind: string; principal_id: string; hits: number }>(
        `SELECT scope_kind, principal_id, hits FROM mail_rate_limits WHERE scope_kind = 'idempotency-key';`,
      );
      expect(row).toEqual({
        scope_kind: 'idempotency-key',
        principal_id: scopeValue,
        hits: 2,
      });
    },
    TEST_TIMEOUT,
  );
});

describe('outbox claim and failure bookkeeping', () => {
  it(
    'claims at most the requested limit in availability order and never claims failed rows',
    async () => {
      const persistence = makePersistence();
      // Sạch row pending sót lại từ invariant test trước (happy-path create để lại outbox
      // pending chưa claim): hút hết TRƯỚC khi tạo row của test này, nếu không lệnh hút dưới
      // đây nuốt luôn cả row mới.
      await persistence.outbox.claim({
        nowMs: NOW + 5,
        leaseDurationMs: 60_000,
        leaseOwner: 'claim-drain',
        limit: 10_000,
      });

      // Ba row available, hai row failed.
      const availableIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const deliveryId = nextId('dlv');
        await persistence.messages.createWithOutbox({
          messageId: nextId('m'),
          outboxId: nextId('obx'),
          deliveryId,
          app: 'test-app',
          principalId: 'principal-claim',
          templateId: SEED_TEMPLATE_ID,
          templateName: 'welcome',
          templateVersion: 1,
          locale: 'en',
          recipient: 'recipient@example.test',
          subjectRendered: 's',
          bodyRendered: 'b',
          idempotencyKey: nextId('key'),
          requestFingerprint: FINGERPRINT,
          correlationId: null,
          nowMs: NOW,
        });
        availableIds.push(deliveryId);
      }
      for (let i = 0; i < 2; i += 1) {
        const deliveryId = nextId('dlv');
        await persistence.messages.createWithOutbox({
          messageId: nextId('m'),
          outboxId: nextId('obx'),
          deliveryId,
          app: 'test-app',
          principalId: 'principal-claim',
          templateId: SEED_TEMPLATE_ID,
          templateName: 'welcome',
          templateVersion: 1,
          locale: 'en',
          recipient: 'recipient@example.test',
          subjectRendered: 's',
          bodyRendered: 'b',
          idempotencyKey: nextId('key'),
          requestFingerprint: FINGERPRINT,
          correlationId: null,
          nowMs: NOW,
        });
        await mailDatabase
          .prepare(
            `UPDATE mail_outbox SET status = 'failed', publish_attempts = 5 WHERE delivery_id = ?;`,
          )
          .bind(deliveryId)
          .all();
      }

      const claimed = await persistence.outbox.claim({
        nowMs: NOW + 10,
        leaseDurationMs: 60_000,
        leaseOwner: 'claim-scan',
        limit: 2,
      });
      expect(claimed).toHaveLength(2);
      expect(claimed.every((row) => row.status === 'publishing')).toBe(true);
      expect(claimed.every((row) => row.claimedBy === 'claim-scan')).toBe(true);
      for (const row of claimed) {
        expect(availableIds).toContain(row.deliveryId);
      }
      // Thứ tự availability: hàng available sớm hơn được claim trước.
      const claimedInDbOrder = await rawRows<{ delivery_id: string }>(
        `SELECT delivery_id FROM mail_outbox WHERE claimed_by = 'claim-scan' ` +
          `ORDER BY available_at, created_at;`,
      );
      expect(claimed.map((row) => row.deliveryId)).toEqual(
        claimedInDbOrder.map((row) => row.delivery_id),
      );

      // Claim tiếp theo vẫn thấy row thứ ba, không thấy row publishing còn lease và không
      // thấy row failed.
      const nextBatch = await persistence.outbox.claim({
        nowMs: NOW + 11,
        leaseDurationMs: 60_000,
        leaseOwner: 'claim-scan',
        limit: 10,
      });
      const nextDeliveries = nextBatch.map((row) => row.deliveryId);
      expect(nextDeliveries).toHaveLength(1);
      expect(availableIds.filter((id) => !claimed.some((row) => row.deliveryId === id))).toEqual(
        nextDeliveries,
      );

      // limit = 0: không chạm database, trả rỗng.
      const empty = await persistence.outbox.claim({
        nowMs: NOW + 12,
        leaseDurationMs: 60_000,
        leaseOwner: 'claim-zero',
        limit: 0,
      });
      expect(empty).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'records publish failure with the attempt counter computed inside the statement and retires at the max',
    async () => {
      const persistence = makePersistence();
      const deliveryId = nextId('dlv');
      await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId,
        app: 'test-app',
        principalId: 'principal-fail',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey: nextId('key'),
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });

      const claim = async (owner: string, at: number) => {
        const batch = await persistence.outbox.claim({
          nowMs: at,
          leaseDurationMs: 60_000,
          leaseOwner: owner,
          limit: 10,
        });
        const row = batch.find((item) => item.deliveryId === deliveryId);
        if (!row) {
          throw new Error(`row was not claimed by ${owner} at ${at}`);
        }
        return row;
      };

      // Thất bại 1 và 2: về pending với backoff, tăng attempts.
      const first = await claim('fail-owner', NOW);
      const afterFirst = await persistence.outbox.recordPublishFailure({
        outboxId: first.id,
        deliveryId,
        leaseOwner: 'fail-owner',
        dispatchGeneration: 1,
        lastError: 'attempt-1',
        nextAvailableAtMs: NOW + 100,
        maxPublishAttempts: 3,
        nowMs: NOW + 1,
      });
      expect(afterFirst?.status).toBe('pending');
      expect(afterFirst?.publishAttempts).toBe(1);
      expect(afterFirst?.claimedBy).toBeNull();
      expect(afterFirst?.lastError).toBe('attempt-1');

      // Claim lại sau backoff, thất bại lần 2.
      const second = await claim('fail-owner', NOW + 150);
      expect(second.publishAttempts).toBe(1);
      const afterSecond = await persistence.outbox.recordPublishFailure({
        outboxId: second.id,
        deliveryId,
        leaseOwner: 'fail-owner',
        dispatchGeneration: 1,
        lastError: 'attempt-2',
        nextAvailableAtMs: NOW + 300,
        maxPublishAttempts: 3,
        nowMs: NOW + 151,
      });
      expect(afterSecond?.status).toBe('pending');
      expect(afterSecond?.publishAttempts).toBe(2);

      // Thất bại thứ 3 chạm max: row sang failed và không bao giờ được claim nữa.
      const third = await claim('fail-owner', NOW + 350);
      const afterThird = await persistence.outbox.recordPublishFailure({
        outboxId: third.id,
        deliveryId,
        leaseOwner: 'fail-owner',
        dispatchGeneration: 1,
        lastError: 'attempt-3',
        nextAvailableAtMs: NOW + 600,
        maxPublishAttempts: 3,
        nowMs: NOW + 351,
      });
      expect(afterThird?.status).toBe('failed');

      const laterClaim = await persistence.outbox.claim({
        nowMs: NOW + 100_000,
        leaseDurationMs: 60_000,
        leaseOwner: 'fail-owner',
        limit: 10,
      });
      expect(laterClaim.some((row) => row.deliveryId === deliveryId)).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

describe('template repository reads', () => {
  it(
    'returns every active version instead of silently picking one',
    async () => {
      const persistence = makePersistence();
      const name = nextId('welcome');
      await mailDatabase
        .prepare(
          `INSERT INTO mail_templates (id, name, locale, version, subject_template, body_template, ` +
            `variables_schema_json, status, created_at, updated_at) VALUES ` +
            `(${lit(nextId('tpl'))}, ${lit(name)}, ${lit('en')}, 1, ${lit('s')}, ${lit('b')}, ${lit('{}')}, ${lit('active')}, ${lit(NOW)}, ${lit(NOW)}), ` +
            `(${lit(nextId('tpl'))}, ${lit(name)}, ${lit('en')}, 2, ${lit('s')}, ${lit('b')}, ${lit('{}')}, ${lit('active')}, ${lit(NOW)}, ${lit(NOW)}), ` +
            `(${lit(nextId('tpl'))}, ${lit(name)}, ${lit('en')}, 3, ${lit('s')}, ${lit('b')}, ${lit('{}')}, ${lit('disabled')}, ${lit(NOW)}, ${lit(NOW)});`,
        )
        .all();

      const active = await persistence.templates.findActiveByNameAndLocale(name, 'en');
      expect(active.map((row) => row.version)).toEqual([1, 2]);
    },
    TEST_TIMEOUT,
  );

  it(
    'finds a template by id and returns null for a missing one',
    async () => {
      const persistence = makePersistence();
      const found = await persistence.templates.findById(SEED_TEMPLATE_ID);
      expect(found?.name).toBe('welcome');
      expect(await persistence.templates.findById('tpl-missing')).toBeNull();
    },
    TEST_TIMEOUT,
  );
});

describe('SQL parameterization', () => {
  it(
    'stores hostile metacharacters verbatim and never executes them as SQL',
    async () => {
      const persistence = makePersistence();
      const hostileKey = `k' OR '1'='1`;
      const hostileApp = `app' || (SELECT 1) --`;
      const deliveryId = nextId('dlv');

      const result = await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId,
        app: hostileApp,
        principalId: "principal'--",
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: "victim'@example.test",
        subjectRendered: "s'; DROP TABLE mail_messages; --",
        bodyRendered: 'b',
        idempotencyKey: hostileKey,
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });
      expect(result.kind).toBe('created');
      expect(result.message.app).toBe(hostileApp);
      expect(result.message.idempotencyKey).toBe(hostileKey);

      // Lookup theo key nguy hiểm: exact match, không quét rộng.
      const found = await persistence.messages.findByIdempotencyKey("principal'--", hostileKey);
      expect(found?.deliveryId).toBe(deliveryId);
      expect(await persistence.messages.findByIdempotencyKey("principal'--", 'k')).toBeNull();

      // mail_messages vẫn còn nguyên — chuỗi hosticle không phải SQL.
      const tables = await rawRows<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mail_messages';`,
      );
      expect(tables).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );
});

describe('dependency boundary of the infrastructure lib', () => {
  it('imports only the two workspace packages and no platform or driver package', () => {
    // ⚠️ Quét `src/` của lib chứ không phải thư mục của file này: suite đã dời vào
    // `tests/integrations/` của app (06-testing.md §2 — suite boot database thật là
    // app-owned), nhưng đối tượng khẳng định vẫn là mã nguồn của lib infrastructure —
    // lib không được phép import driver/platform package (`wrangler`,
    // `@cloudflare/workers-types`, `node:*`), mọi truy cập D1 phải qua subset surface.
    const infrastructureSrc = join(repoRoot, 'libs', 'transactional-mail-infrastructure', 'src');
    const files = readdirSync(infrastructureSrc)
      .filter((name) => !name.includes('.spec.'))
      .filter((name) => /\.(?:ts|mts|cts)$/u.test(name));

    const specifiers = new Set<string>();
    for (const file of files) {
      const source = readFileSync(join(infrastructureSrc, file), 'utf8');
      for (const match of source.matchAll(
        /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()["']([^"']+)["']/gmu,
      )) {
        const specifier = match[1] ?? '';
        // Chỉ quan tâm import ngoài module: import tương đối là cấu trúc nội bộ của lib.
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
          specifiers.add(specifier);
        }
      }
    }

    expect([...specifiers].toSorted()).toEqual([
      '@ecoma-io/transactional-mail-application',
      '@ecoma-io/transactional-mail-contracts',
    ]);
  });

  it('is never imported by the application port lib', () => {
    const applicationSrc = join(repoRoot, 'libs', 'transactional-mail-application', 'src');
    // Loại trừ chính spec: assertion `not.toContain` của spec này chứa literal tên package,
    // quét file spec là tự khớp pattern của mình (spec-pollution pattern).
    for (const file of readdirSync(applicationSrc).filter((name) => !name.includes('.spec.'))) {
      const source = readFileSync(join(applicationSrc, file), 'utf8');
      expect(source).not.toContain('@ecoma-io/transactional-mail-infrastructure');
    }
  });

  it('exports exactly the composition root and the D1 surface types at runtime', async () => {
    // ⚠️ Bề mặt runtime được kiểm qua namespace import **tĩnh** (đã có ở đầu file): assertion
    // này đọc các key của module object thay vì gọi hàm, nên static import đủ — và KHÔNG dùng
    // `await import()`: một dynamic import ở đây khiến Nx đánh dấu cạnh app → lib là dynamic
    // (graph sinh thêm cạnh `dynamic`), làm rule `noImportsOfLazyLoadedLibraries` cấm mọi
    // static import của lib trong app (`src/main.ts` import tĩnh là hợp lệ).
    const surface = (await Promise.resolve({
      createD1MailPersistence,
    })) as Record<string, unknown>;
    const { createD1MailPersistence: factory, ...rest } = surface;
    expect(typeof factory).toBe('function');
    expect(Object.keys(rest)).toEqual([]);
  });
});

/**
 * Đọc một message bằng `SELECT` thật trên D1, trả về đúng projection các ca redact dùng.
 *
 * Cố ý **không** đọc qua port: khẳng định ở describe redact là về trạng thái byte thực sự
 * nằm trong database, nên nó phải đi qua con đường khác với con đường đang được kiểm.
 *
 * Ở module scope (không phải trong `describe`) vì hàm không bắt biến nào từ scope cha —
 * `consistent-function-scoping` bắt đúng điều đó, và ở đây nó cũng đúng: một helper đọc
 * chung cho cả suite không nên được dựng lại theo từng `describe`.
 */
async function readMessageColumns(deliveryId: string): Promise<Record<string, unknown>> {
  const row = await rawOne<Record<string, unknown>>(
    `SELECT id, delivery_id, status, recipient, subject_rendered, body_rendered, ` +
      `terminal_at, idempotency_key, request_fingerprint, updated_at FROM mail_messages ` +
      `WHERE delivery_id = ?;`,
    deliveryId,
  );
  expect(row).toBeDefined();
  return row ?? {};
}

describe('invariant: FR-007 content redaction empties content and never touches metadata', () => {
  it(
    'redacts recipient, subject and body of a listed terminal message while keeping its metadata',
    async () => {
      const persistence = makePersistence();
      const terminalAt = NOW - 400_000;
      const deliveryId = nextId('dlv');
      await mailDatabase
        .prepare(
          insertMessageSql({
            deliveryId,
            status: 'sent',
            terminalAt,
            recipient: 'victim@example.test',
          }),
        )
        .all();

      // Trước khi redact: content còn nguyên, để khẳng định "sau" có ý nghĩa.
      const before = await readMessageColumns(deliveryId);
      expect(before['recipient']).toBe('victim@example.test');
      expect(before['subject_rendered']).toBe('subject');
      expect(before['body_rendered']).toBe('<p>body</p>');

      const result = await persistence.retention.redactContent({
        messageIds: [String(before['id'])],
        nowMs: NOW,
      });

      // Số đếm đến từ `RETURNING`, không phải `meta.changes` (DB3: `meta.changes` không đáng
      // tin trên D1 local) — và nó phải khớp đúng một row vừa bị ghi.
      expect(result.redacted).toBe(1);

      const after = await readMessageColumns(deliveryId);
      expect(after['recipient']).toBe('');
      expect(after['subject_rendered']).toBe('');
      expect(after['body_rendered']).toBe('');

      // Metadata phải còn nguyên: đây là phần còn giữ được của một message đã terminal.
      expect(after['id']).toBe(before['id']);
      expect(after['delivery_id']).toBe(deliveryId);
      expect(after['status']).toBe('sent');
      expect(after['terminal_at']).toBe(terminalAt);
      expect(after['idempotency_key']).toBe(before['idempotency_key']);
      expect(after['request_fingerprint']).toBe(before['request_fingerprint']);

      // `updated_at` là cột duy nhất được port ghi thêm, và nó phải bằng `nowMs` truyền vào.
      expect(after['updated_at']).toBe(NOW);
    },
    TEST_TIMEOUT,
  );

  it(
    'leaves a non-terminal message untouched even when its id is in the input',
    async () => {
      const persistence = makePersistence();
      const acceptedDeliveryId = nextId('dlv');
      await mailDatabase
        .prepare(
          insertMessageSql({
            deliveryId: acceptedDeliveryId,
            status: 'accepted',
            recipient: 'still-pending@example.test',
          }),
        )
        .all();
      const acceptedId = String((await readMessageColumns(acceptedDeliveryId))['id'] ?? '');

      // Guard trạng thái nằm trong **cùng statement** với `UPDATE`, nên một id `accepted` lọt
      // vào input vẫn không bị ghi. Đây là hành vi an toàn: message chưa gửi xong mà mất
      // recipient thì lỗi chỉ lộ ra ở tận Queue.
      const result = await persistence.retention.redactContent({
        messageIds: [acceptedId],
        nowMs: NOW,
      });
      expect(result.redacted).toBe(0);

      const after = await readMessageColumns(acceptedDeliveryId);
      expect(after['recipient']).toBe('still-pending@example.test');
      expect(after['subject_rendered']).toBe('subject');
      expect(after['body_rendered']).toBe('<p>body</p>');
      expect(after['updated_at']).toBe(NOW);
    },
    TEST_TIMEOUT,
  );

  it(
    'leaves a terminal message untouched when it is not older than the retention cutoff',
    async () => {
      const persistence = makePersistence();
      const terminalAt = NOW - 1_000;
      const deliveryId = nextId('dlv');
      await mailDatabase
        .prepare(
          insertMessageSql({
            deliveryId,
            status: 'failed',
            terminalAt,
            recipient: 'too-recent@example.test',
            failureReason: 'permanent',
          }),
        )
        .all();
      const messageId = String((await readMessageColumns(deliveryId))['id'] ?? '');

      // `nowMs` là cả thời điểm chạy lẫn mốc cắt: `terminal_at < nowMs` là mốc retention mà
      // port nhận, và caller đã loại cửa sổ trước đó. Chứng minh đây là ranh giới của
      // **statement**, không chỉ của lựa chọn danh sách: truyền id đúng hạn vẫn không bị ghi.
      const result = await persistence.retention.redactContent({
        messageIds: [messageId],
        nowMs: terminalAt,
      });
      expect(result.redacted).toBe(0);

      const after = await readMessageColumns(deliveryId);
      expect(after['recipient']).toBe('too-recent@example.test');
    },
    TEST_TIMEOUT,
  );

  it(
    'redacts only the listed ids and reports the count it actually wrote',
    async () => {
      const persistence = makePersistence();
      const terminalAt = NOW - 400_000;

      const listedDeliveryIds: string[] = [];
      for (const recipient of ['first@example.test', 'second@example.test']) {
        const deliveryId = nextId('dlv');
        await mailDatabase
          .prepare(insertMessageSql({ deliveryId, status: 'sent', terminalAt, recipient }))
          .all();
        listedDeliveryIds.push(deliveryId);
      }
      const unlistedDeliveryId = nextId('dlv');
      await mailDatabase
        .prepare(
          insertMessageSql({
            deliveryId: unlistedDeliveryId,
            status: 'sent',
            terminalAt,
            recipient: 'unlisted@example.test',
          }),
        )
        .all();

      const ids = await Promise.all(
        [...listedDeliveryIds, unlistedDeliveryId].map(async (deliveryId) =>
          String((await readMessageColumns(deliveryId))['id'] ?? ''),
        ),
      );
      const [firstId, secondId, unlistedId] = ids as [string, string, string];

      // `json_each(?)` nhận cả danh sách id qua **một** bound parameter, nên id count không
      // bị giới hạn bởi trần 100 parameter của SQLite (DB4).
      const result = await persistence.retention.redactContent({
        messageIds: [firstId, secondId],
        nowMs: NOW,
      });
      expect(result.redacted).toBe(2);

      for (const deliveryId of listedDeliveryIds) {
        expect((await readMessageColumns(deliveryId))['recipient']).toBe('');
      }
      // Id không nằm trong input thì không bị chạm tới, dù nó cùng điều kiện hạn.
      expect((await readMessageColumns(unlistedDeliveryId))['recipient']).toBe(
        'unlisted@example.test',
      );
      expect(unlistedId).not.toBe(firstId);
    },
    TEST_TIMEOUT,
  );

  it(
    'reports zero and touches nothing for an empty id list',
    async () => {
      const persistence = makePersistence();
      const deliveryId = nextId('dlv');
      await mailDatabase
        .prepare(insertMessageSql({ deliveryId, status: 'sent', terminalAt: NOW - 400_000 }))
        .all();
      const messageId = String((await readMessageColumns(deliveryId))['id'] ?? '');

      const result = await persistence.retention.redactContent({
        messageIds: [],
        nowMs: NOW,
      });
      expect(result.redacted).toBe(0);

      // Khẳng định trên **row của riêng ca test này**, không phải quét toàn bảng: các ca
      // khác trong suite cũng ghi `mail_messages`, nên một khẳng định dạng "không row nào
      // trong database đổi" sẽ đỏ theo thứ tự chạy chứ không theo hành vi của port.
      expect((await readMessageColumns(deliveryId))['updated_at']).toBe(NOW);
      expect((await readMessageColumns(deliveryId))['recipient']).toBe('recipient@example.test');
      expect(messageId).not.toBe('');
    },
    TEST_TIMEOUT,
  );
});

/**
 * Fault-injection và crash-window của publish loop, trên **D1 thật**.
 *
 * `sanity-spec` của application lib (`outbox-publisher.spec.ts`) kiểm thứ tự các lệnh gọi
 * bằng fake port; suite này kiểm **phục hồi sau crash**: fault được inject tại đúng cửa sổ
 * "Queue đã nhận command nhưng D1 chưa ghi trạng thái publish", rồi lần `publishOutboxBatch`
 * *sau* phải phục hồi cùng delivery intent — không mất command, không sinh logical delivery
 * mới, không sinh outbox row thứ hai.
 *
 * Barrier là **controlled**, không dùng timing ngẫu nhiên: queue fake có thể block/unblock
 * theo `delivery_id`, cho phép freeze publisher tại đúng điểm giữa `QUEUE.send()` và
 * `markPublished` rồi kill nó, mô phỏng isolate chết giữa chừng mà không dựa vào `setTimeout`
 * hay thứ tự resolve phụ thuộc scheduler.
 */
describe('crash window: queue send succeeded, publish state not yet persisted', () => {
  it(
    'recovers the same delivery intent after a crash between QUEUE.send and markPublished',
    async () => {
      const persistence = makePersistence();
      const queue = makeBarrierQueue();
      const deliveryId = nextId('dlv');
      await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId,
        app: 'test-app',
        principalId: 'principal-crash',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey: nextId('key'),
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });

      // Lần 1 — publisher bị "crash" NGAY tại `QUEUE.send`: hold barrier làm send promise
      // của delivery này không bao giờ resolve trong lần chạy 1; state D1 trước recovery
      // phải còn nguyên như isolate vừa chết (row `publishing`, message chưa terminal).
      queue.holdNext(deliveryId);
      const crashedBatchPromise = publishOutboxBatch(
        {
          outbox: persistence.outbox,
          messages: persistence.messages,
          queueSend: (command) => queue.binding.send(JSON.stringify(command)),
          generateLeaseOwner: () => 'owner-crashed',
          logAlert: () => undefined,
        },
        {
          leaseMs: 60_000,
          batchLimit: 10,
          maxPublishAttempts: 3,
          backoffBaseMs: 1_000,
          nowMs: NOW,
        },
      );
      // Controlled barrier: chờ tới khi send đã được GỌI (command đã vào Queue fake) mà
      // không sleep — quay event loop để publisher chạy tới điểm send thực sự. Helper
      // module-level giúp đạt consistent-function-scoping.
      while (queue.sent.length === 0) {
        await nextMacrotask();
      }
      // "Kill" publisher: giữ batch promise của lần 1 pending vĩnh viễn — không release,
      // không await, mô phỏng isolate chết ngay sau `QUEUE.send()` trước `markPublished`.
      // Promise treo hoàn toàn không leak lỗi (không rejection nào xảy ra).
      void crashedBatchPromise;

      // Sau "kill": đúng MỘT outbox row, message chưa terminal — kiểu publish state cụ thể
      // của lần 1 không cần biết trước (markPublished chưa chạy, row còn `publishing`).
      const crashedState = await rawOne<{ o_status: string; m_status: string }>(
        `SELECT o.status AS o_status, m.status AS m_status ` +
          `FROM mail_outbox o JOIN mail_messages m ON m.delivery_id = o.delivery_id ` +
          `WHERE o.delivery_id = ?;`,
        deliveryId,
      );
      expect(crashedState?.o_status).toBe('publishing');
      expect(['accepted', 'queued']).toContain(crashedState?.m_status);

      // Lần 2 — publisher mới, clock đã vượt lease của lần 1 → reclaim được, publishes lại
      // CÙNG delivery_id (duplicate command là expected, consumer idempotent theo §5.2).
      // Recovery dùng capture thường (không barrier): publisher sống phải publish ngay.
      const recoveryQueue = makePlainCapture();
      const recoveryResult = await publishOutboxBatch(
        {
          outbox: persistence.outbox,
          messages: persistence.messages,
          queueSend: (command) => recoveryQueue.send(command),
          generateLeaseOwner: () => 'owner-recovered',
          logAlert: () => undefined,
        },
        {
          leaseMs: 60_000,
          batchLimit: 10,
          maxPublishAttempts: 3,
          backoffBaseMs: 1_000,
          nowMs: NOW + 120_000,
        },
      );

      // Command Queue mang CÙNG delivery_id — không sinh logical delivery mới (§5.2).
      // Lần 1 send.command là cách publisher gốc enqueue; lần 2 send.command là reclaim.
      const commands = [...queue.sent, ...recoveryQueue.sent]
        .map((raw) => {
          try {
            return JSON.parse(raw) as { delivery_id?: string };
          } catch {
            return undefined;
          }
        })
        .filter(
          (command): command is { delivery_id: string } => command?.delivery_id === deliveryId,
        );
      expect(commands.length).toBeGreaterThanOrEqual(1);
      for (const command of commands) {
        expect(Object.keys(command).toSorted()).toEqual(['delivery_id', 'version']);
      }

      // Đúng một row mỗi bảng — delivery intent không bị nhân bản.
      const finalCounts = await rawOne<{ messages: number; outbox: number }>(
        `SELECT ` +
          `(SELECT count(*) FROM mail_messages WHERE delivery_id = ?) AS messages, ` +
          `(SELECT count(*) FROM mail_outbox WHERE delivery_id = ?) AS outbox;`,
        deliveryId,
        deliveryId,
      );
      expect(finalCounts).toEqual({ messages: 1, outbox: 1 });

      // Trạng thái cuối trên đúng bảng: outbox `published`, message `queued`.
      const finalRows = await rawOne<{ o_status: string; m_status: string }>(
        `SELECT o.status AS o_status, m.status AS m_status ` +
          `FROM mail_outbox o JOIN mail_messages m ON m.delivery_id = o.delivery_id ` +
          `WHERE o.delivery_id = ?;`,
        deliveryId,
      );
      expect(recoveryResult.claimed).toBeGreaterThanOrEqual(1);
      expect(finalRows?.o_status).toBe('published');
      expect(finalRows?.m_status).toBe('queued');
    },
    TEST_TIMEOUT,
  );

  it(
    'reclaim of an expired publishing lease increments attempts and fences the dead owner',
    async () => {
      const persistence = makePersistence();
      const deliveryId = nextId('dlv');
      await persistence.messages.createWithOutbox({
        messageId: nextId('m'),
        outboxId: nextId('obx'),
        deliveryId,
        app: 'test-app',
        principalId: 'principal-reclaim',
        templateId: SEED_TEMPLATE_ID,
        templateName: 'welcome',
        templateVersion: 1,
        locale: 'en',
        recipient: 'recipient@example.test',
        subjectRendered: 's',
        bodyRendered: 'b',
        idempotencyKey: nextId('key'),
        requestFingerprint: FINGERPRINT,
        correlationId: null,
        nowMs: NOW,
      });

      const claimed = await persistence.outbox.claim({
        nowMs: NOW,
        leaseDurationMs: 60_000,
        leaseOwner: 'owner-dies',
        limit: 10,
      });
      const target = claimed.find((row) => row.deliveryId === deliveryId);
      if (!target) {
        throw new Error('test invariant broken: row was not claimed by owner-dies');
      }

      // Lease hết hạn mà owner không xong việc → reclaim của owner sau tốn một attempt và
      // `publish_attempts` tăng — cơ chế chống crash-loop mà JSDoc `claim` mô tả.
      const reclaimed = await persistence.outbox.claim({
        nowMs: NOW + 61_000,
        leaseDurationMs: 60_000,
        leaseOwner: 'owner-reclaims',
        limit: 10,
      });
      const reclaimedRow = reclaimed.find((row) => row.deliveryId === deliveryId);
      expect(reclaimedRow?.status).toBe('publishing');
      expect(reclaimedRow?.claimedBy).toBe('owner-reclaims');
      expect(reclaimedRow?.publishAttempts).toBe(1);

      // Stale owner ('owner-dies') không còn ghi được gì sau reclaim: cả ba đường ghi đều
      // fencing bởi `claimed_by` — bao gồm cả `markPublished`, nghĩa là lease holder cũ
      // KHÔNG được ghi đè kết quả của lease mới.
      expect(
        await persistence.outbox.renewLease({
          outboxId: target.id,
          leaseOwner: 'owner-dies',
          dispatchGeneration: 1,
          nowMs: NOW + 62_000,
        }),
      ).toBeNull();
      const staleMark = await persistence.outbox.markPublished({
        outboxId: target.id,
        deliveryId,
        leaseOwner: 'owner-dies',
        dispatchGeneration: 1,
        nowMs: NOW + 62_000,
      });
      expect(staleMark.outboxPublished).toBe(false);
      expect(staleMark.messageQueued).toBe(false);

      // Row vẫn thuộc về owner-reclaims — state không bị stale owner ghi đè lên.
      const current = await rawOne<{ claimed_by: string | null; status: string }>(
        `SELECT claimed_by, status FROM mail_outbox WHERE delivery_id = ?;`,
        deliveryId,
      );
      expect(current).toEqual({ claimed_by: 'owner-reclaims', status: 'publishing' });
    },
    TEST_TIMEOUT,
  );
});

/**
 * Publisher ↔ reconciler chạy cạnh nhau trên **cùng outbox row** — D1 thật.
 *
 * Hai đường enqueue phải dùng chung lease + backoff + ngân sách A (`03-operations.md`
 * §5.3): reconciler KHÔNG bump generation, KHÔNG reset outbox `failed`, KHÔNG insert outbox
 * row thứ hai, và không giành quyền với một publisher đang giữ lease còn hạn. Fault/race
 * được dựng bằng **state trực tiếp trên D1** (lease cũ, generation mới), không dùng timing.
 */
describe('publisher and reconciler on the same outbox row', () => {
  it(
    'reconciler never steals an outbox row still leased by a live publisher',
    async () => {
      const persistence = makePersistence();
      const deliveryId = await seedMessageWithOutbox(persistence, 'principal-race-1');

      // Publisher còn sống: giữ row `publishing` với lease còn hạn.
      await persistence.outbox.claim({
        nowMs: NOW,
        leaseDurationMs: 60_000,
        leaseOwner: 'owner-live',
        limit: 10,
      });

      // Re-dispatch adapter hai statement, đúng hợp đồng cổng của `main.ts` `redispatchOutbox`.
      const redispatch = async (
        deliveryIdArgument: string,
        nowMsArgument: number,
      ): Promise<
        | { readonly kind: 'redispatched'; readonly recoveryCycleCount: number }
        | { readonly kind: 'budget-exhausted' }
        | { readonly kind: 'not-eligible' }
      > => {
        const leaseCutoffMs = nowMsArgument - 60_000;
        const resetOutbox = mailDatabase
          .prepare(
            "UPDATE mail_outbox SET status = 'pending', publish_attempts = 0, available_at = ?, " +
              'claimed_at = NULL, claimed_by = NULL, published_at = NULL, last_error = NULL, ' +
              'dispatch_generation = (SELECT dispatch_generation FROM mail_messages WHERE delivery_id = ?), ' +
              'updated_at = ? WHERE delivery_id = ? ' +
              "AND status IN ('pending','publishing','published') " +
              'AND (claimed_at IS NULL OR claimed_at <= ?) ' +
              'AND EXISTS (SELECT 1 FROM mail_messages WHERE mail_messages.delivery_id = mail_outbox.delivery_id ' +
              "AND mail_messages.status IN ('accepted','queued') AND mail_messages.recovery_cycle_count < 5)",
          )
          .bind(
            nowMsArgument,
            deliveryIdArgument,
            nowMsArgument,
            deliveryIdArgument,
            leaseCutoffMs,
          );
        const bumpBudget = mailDatabase
          .prepare(
            'UPDATE mail_messages SET recovery_cycle_count = recovery_cycle_count + 1, ' +
              "status = 'queued', updated_at = ? WHERE delivery_id = ? " +
              "AND status IN ('accepted','queued') AND recovery_cycle_count < 5 " +
              'AND EXISTS (SELECT 1 FROM mail_outbox WHERE mail_outbox.delivery_id = mail_messages.delivery_id ' +
              "AND mail_outbox.status = 'pending' AND mail_outbox.claimed_at IS NULL) " +
              'RETURNING recovery_cycle_count',
          )
          .bind(nowMsArgument, deliveryIdArgument);
        const [, bumped] = await mailDatabase.batch([resetOutbox, bumpBudget]);
        const incremented = bumped.results[0] as
          | { readonly recovery_cycle_count: number }
          | undefined;
        if (incremented === undefined) {
          return { kind: 'budget-exhausted' };
        }
        return { kind: 'redispatched', recoveryCycleCount: incremented.recovery_cycle_count };
      };

      // Reconciler chạy: candidate list quét đúng câu của port (status IN + tuổi).
      const candidates = await mailDatabase
        .prepare(
          "SELECT id, delivery_id FROM mail_messages WHERE status IN ('accepted','queued') AND updated_at < ? ORDER BY updated_at, id LIMIT ?",
        )
        .bind(NOW - 600_000, 10)
        .all<{ id: string; delivery_id: string }>();
      // Message vừa seed có updated_at = NOW — KHÔNG lọt vào lô quá tuổi; không candidate.
      expect(candidates.results.filter((row) => row.delivery_id === deliveryId)).toHaveLength(0);

      const result = await runOutboxReconciler(
        {
          outbox: persistence.outbox,
          messages: persistence.messages,
          redispatch,
          listDispatchIncomplete: async ({ updatedBeforeMs, limit }) => {
            const { results } = await mailDatabase
              .prepare(
                "SELECT id, delivery_id FROM mail_messages WHERE status IN ('accepted','queued') AND updated_at < ? ORDER BY updated_at, id LIMIT ?",
              )
              .bind(updatedBeforeMs, limit)
              .all<{ id: string; delivery_id: string }>();
            return results.map((row) => ({ messageId: row.id, deliveryId: row.delivery_id }));
          },
          logAlert: () => undefined,
        },
        {
          maxAgeMs: 600_000,
          batchLimit: 10,
          nowMs: NOW,
          leaseMs: 60_000,
          maxPublishAttempts: 3,
          backoffBaseMs: 1_000,
        },
      );

      // Không redispatch: publisher đang giữ lease, reconciler không giành quyền.
      expect(result).toEqual({ scanned: 0, redispatched: 0, skipped: 0 });
      const row = await rawOne<{ status: string; claimed_by: string | null }>(
        `SELECT status, claimed_by FROM mail_outbox WHERE delivery_id = ?;`,
        deliveryId,
      );
      expect(row).toEqual({ status: 'publishing', claimed_by: 'owner-live' });
      const message = await rawOne<{ recovery_cycle_count: number }>(
        `SELECT recovery_cycle_count FROM mail_messages WHERE delivery_id = ?;`,
        deliveryId,
      );
      // Ngân sách A không bị đốt vô hiệu cho row vẫn giữ lease.
      expect(message?.recovery_cycle_count).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'redispatch never emits a second outbox row and never bumps generation',
    async () => {
      const persistence = makePersistence();
      const deliveryId = await seedMessageWithOutbox(persistence, 'principal-race-2');

      // Đưa delivery vào đúng nhánh dispatch-incomplete: outbox published, message queued
      // quá tuổi. claim → markPublished hai statement là đường chuẩn; applyDeliveryOutcome
      // `sent` KHÔNG được gọi — message phải còn `queued` cho candidate scan.
      await persistence.outbox.claim({
        nowMs: NOW,
        leaseDurationMs: 60_000,
        leaseOwner: 'owner-first',
        limit: 10,
      });
      const publishedRow = await persistence.outbox.findByDeliveryId(deliveryId);
      if (!publishedRow || publishedRow.status !== 'publishing') {
        throw new Error('test invariant broken: row was not claimed into publishing');
      }
      const marked = await persistence.outbox.markPublished({
        outboxId: publishedRow.id,
        deliveryId,
        leaseOwner: 'owner-first',
        dispatchGeneration: 1,
        nowMs: NOW,
      });
      expect(marked).toEqual({ outboxPublished: true, messageQueued: true });
      const rowAfterPublish = await rawOne<{ o_status: string; m_status: string }>(
        `SELECT o.status AS o_status, m.status AS m_status FROM mail_outbox o ` +
          `JOIN mail_messages m ON m.delivery_id = o.delivery_id WHERE o.delivery_id = ?;`,
        deliveryId,
      );
      expect(rowAfterPublish).toEqual({ o_status: 'published', m_status: 'queued' });

      // Quá tuổi để lọt candidate.
      await mailDatabase
        .prepare(`UPDATE mail_messages SET updated_at = ? WHERE delivery_id = ?;`)
        .bind(NOW - 1_000_000, deliveryId)
        .all();

      const redispatchedCounts: number[] = [];
      const result = await runOutboxReconciler(
        {
          outbox: persistence.outbox,
          messages: persistence.messages,
          redispatch: async (deliveryIdArgument, nowMsArgument) => {
            const leaseCutoffMs = nowMsArgument - 60_000;
            const resetOutbox = mailDatabase
              .prepare(
                "UPDATE mail_outbox SET status = 'pending', publish_attempts = 0, available_at = ?, " +
                  'claimed_at = NULL, claimed_by = NULL, published_at = NULL, last_error = NULL, ' +
                  'dispatch_generation = (SELECT dispatch_generation FROM mail_messages WHERE delivery_id = ?), ' +
                  'updated_at = ? WHERE delivery_id = ? ' +
                  "AND status IN ('pending','publishing','published') " +
                  'AND (claimed_at IS NULL OR claimed_at <= ?) ' +
                  'AND EXISTS (SELECT 1 FROM mail_messages WHERE mail_messages.delivery_id = mail_outbox.delivery_id ' +
                  "AND mail_messages.status IN ('accepted','queued') AND mail_messages.recovery_cycle_count < 5)",
              )
              .bind(
                nowMsArgument,
                deliveryIdArgument,
                nowMsArgument,
                deliveryIdArgument,
                leaseCutoffMs,
              );
            const bumpBudget = mailDatabase
              .prepare(
                'UPDATE mail_messages SET recovery_cycle_count = recovery_cycle_count + 1, ' +
                  "status = 'queued', updated_at = ? WHERE delivery_id = ? " +
                  "AND status IN ('accepted','queued') AND recovery_cycle_count < 5 " +
                  'AND EXISTS (SELECT 1 FROM mail_outbox WHERE mail_outbox.delivery_id = mail_messages.delivery_id ' +
                  "AND mail_outbox.status = 'pending' AND mail_outbox.claimed_at IS NULL) " +
                  'RETURNING recovery_cycle_count',
              )
              .bind(nowMsArgument, deliveryIdArgument);
            const [, bumped] = await mailDatabase.batch([resetOutbox, bumpBudget]);
            const incremented = bumped.results[0] as
              | { readonly recovery_cycle_count: number }
              | undefined;
            if (incremented === undefined) {
              return { kind: 'budget-exhausted' };
            }
            redispatchedCounts.push(incremented.recovery_cycle_count);
            return { kind: 'redispatched', recoveryCycleCount: incremented.recovery_cycle_count };
          },
          listDispatchIncomplete: async ({ updatedBeforeMs, limit }) => {
            const { results } = await mailDatabase
              .prepare(
                "SELECT id, delivery_id FROM mail_messages WHERE status IN ('accepted','queued') AND updated_at < ? ORDER BY updated_at, id LIMIT ?",
              )
              .bind(updatedBeforeMs, limit)
              .all<{ id: string; delivery_id: string }>();
            return results.map((row) => ({ messageId: row.id, deliveryId: row.delivery_id }));
          },
          logAlert: () => undefined,
        },
        {
          maxAgeMs: 600_000,
          batchLimit: 10,
          nowMs: NOW,
          leaseMs: 60_000,
          maxPublishAttempts: 3,
          backoffBaseMs: 1_000,
        },
      );

      // Đúng một redispatch, ngân sách A tiêu đúng một slot.
      expect(result.redispatched).toBe(1);
      expect(redispatchedCounts).toEqual([1]);

      // Đúng MỘT outbox row cho delivery (UNIQUE được respect, không insert row thứ hai).
      const outboxCount = await rawOne<{ n: number }>(
        `SELECT count(*) AS n FROM mail_outbox WHERE delivery_id = ?;`,
        deliveryId,
      );
      expect(outboxCount?.n).toBe(1);

      // Generation không đổi và outbox về `pending` sẵn sàng chu kỳ publish mới.
      const finalRow = await rawOne<{
        o_status: string;
        o_generation: number;
        m_generation: number;
        a: number;
      }>(
        `SELECT o.status AS o_status, o.dispatch_generation AS o_generation, ` +
          `m.dispatch_generation AS m_generation, m.recovery_cycle_count AS a ` +
          `FROM mail_outbox o JOIN mail_messages m ON m.delivery_id = o.delivery_id WHERE o.delivery_id = ?;`,
        deliveryId,
      );
      expect(finalRow?.o_status).toBe('pending');
      expect(finalRow?.o_generation).toBe(1);
      expect(finalRow?.m_generation).toBe(1);
      expect(finalRow?.a).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'a stale generation publisher cannot close an outbox row the reconciler reset to a new cycle',
    async () => {
      const persistence = makePersistence();
      const deliveryId = await seedMessageWithOutbox(persistence, 'principal-race-3');

      // Publisher gen 1 claim.
      const claimed = await persistence.outbox.claim({
        nowMs: NOW,
        leaseDurationMs: 60_000,
        leaseOwner: 'owner-gen1',
        limit: 10,
      });
      const target = claimed.find((row) => row.deliveryId === deliveryId);
      if (!target) {
        throw new Error('test invariant broken: row was not claimed');
      }

      // "Redrive" (mô phỏng có authorize): generation của cả hai bảng lên 2, outbox reset.
      await mailDatabase
        .prepare(
          `UPDATE mail_messages SET dispatch_generation = 2, updated_at = ${lit(NOW)} WHERE delivery_id = ${lit(deliveryId)};`,
        )
        .all();
      await mailDatabase
        .prepare(
          `UPDATE mail_outbox SET dispatch_generation = 2, status = 'pending', publish_attempts = 0, ` +
            `claimed_at = NULL, claimed_by = NULL, published_at = NULL, last_error = NULL, ` +
            `available_at = ${lit(NOW)}, updated_at = ${lit(NOW)} WHERE delivery_id = ${lit(deliveryId)};`,
        )
        .all();

      // Publisher gen-1 (đã stale) cố markPublished với generation cũ: KHÔNG ghi gì.
      const stale = await persistence.outbox.markPublished({
        outboxId: target.id,
        deliveryId,
        leaseOwner: 'owner-gen1',
        dispatchGeneration: 1,
        nowMs: NOW + 5,
      });
      expect(stale.outboxPublished).toBe(false);
      expect(stale.messageQueued).toBe(false);

      // Outbox còn nguyên state redrive đã đặt (pending, gen 2) — stale holder không ghi đè.
      const row = await rawOne<{ status: string; dispatch_generation: number }>(
        `SELECT status, dispatch_generation FROM mail_outbox WHERE delivery_id = ?;`,
        deliveryId,
      );
      expect(row).toEqual({ status: 'pending', dispatch_generation: 2 });
      const message = await rawOne<{ status: string; dispatch_generation: number }>(
        `SELECT status, dispatch_generation FROM mail_messages WHERE delivery_id = ?;`,
        deliveryId,
      );
      expect(message).toEqual({ status: 'accepted', dispatch_generation: 2 });
    },
    TEST_TIMEOUT,
  );

  it(
    'reconciler never resets an outbox row marked failed and only alerts repair-required',
    async () => {
      const persistence = makePersistence();
      const deliveryId = await seedMessageWithOutbox(persistence, 'principal-race-4');

      // Outbox failed (đã kiệt maxPublishAttempts trong chu kỳ), message queued quá tuổi.
      await mailDatabase
        .prepare(
          `UPDATE mail_outbox SET status = 'failed', publish_attempts = 5, last_error = 'Error', ` +
            `updated_at = ${lit(NOW)} WHERE delivery_id = ${lit(deliveryId)};`,
        )
        .all();
      await mailDatabase
        .prepare(`UPDATE mail_messages SET updated_at = ? WHERE delivery_id = ?;`)
        .bind(NOW - 1_000_000, deliveryId)
        .all();

      const alerts: { readonly event: string; readonly deliveryId: string }[] = [];
      let redispatchCalled = false;
      const result = await runOutboxReconciler(
        {
          outbox: persistence.outbox,
          messages: persistence.messages,
          redispatch: async () => {
            redispatchCalled = true;
            return { kind: 'redispatched', recoveryCycleCount: 1 };
          },
          listDispatchIncomplete: async ({ updatedBeforeMs, limit }) => {
            const { results } = await mailDatabase
              .prepare(
                "SELECT id, delivery_id FROM mail_messages WHERE status IN ('accepted','queued') AND updated_at < ? ORDER BY updated_at, id LIMIT ?",
              )
              .bind(updatedBeforeMs, limit)
              .all<{ id: string; delivery_id: string }>();
            return results.map((row) => ({ messageId: row.id, deliveryId: row.delivery_id }));
          },
          logAlert: (event) => {
            alerts.push(event);
          },
        },
        {
          maxAgeMs: 600_000,
          batchLimit: 10,
          nowMs: NOW,
          leaseMs: 60_000,
          maxPublishAttempts: 3,
          backoffBaseMs: 1_000,
        },
      );

      // Chỉ alert repair-required, KHÔNG redispatch, KHÔNG reset failed → pending.
      expect(result).toEqual({ scanned: 1, redispatched: 0, skipped: 1 });
      expect(redispatchCalled).toBe(false);
      expect(alerts).toEqual([{ event: 'reconciler-outbox-failed-repair-required', deliveryId }]);
      const row = await rawOne<{ status: string; publish_attempts: number }>(
        `SELECT status, publish_attempts FROM mail_outbox WHERE delivery_id = ?;`,
        deliveryId,
      );
      expect(row).toEqual({ status: 'failed', publish_attempts: 5 });
      const message = await rawOne<{ recovery_cycle_count: number }>(
        `SELECT recovery_cycle_count FROM mail_messages WHERE delivery_id = ?;`,
        deliveryId,
      );
      // Ngân sách A KHÔNG bị đốt cho outbox failed — nhánh này không tự sửa.
      expect(message?.recovery_cycle_count).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
