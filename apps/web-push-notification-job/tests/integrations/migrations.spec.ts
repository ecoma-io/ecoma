/**
 * Migration của D1 `push-job` trên engine thật — `wrangler.getPlatformProxy` + **đúng file
 * trong `migrations/`**, theo đúng thứ tự tên file.
 *
 * ⚠️ Vì sao test này tồn tại: `push-job` là nơi duy nhất lưu envelope gốc để re-deliver, và
 * một schema không áp được là một Worker không deploy được. Có hai lỗi chỉ lộ ra ở đây:
 * `CHECK` chứa subquery (`subqueries prohibited in CHECK constraints` — khiến cả
 * `CREATE TABLE` fail), và một trigger `json_each` không có guard `json_valid` (ném
 * `malformed JSON`). Cả hai đều không thể thấy bằng một fake.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createD1Harness, migrationFiles, migrationStatements, type D1Harness } from './d1-harness';

const CONFIG_PATH = new URL('../../wrangler.jsonc', import.meta.url).pathname;

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness(CONFIG_PATH);
  await harness.applyMigrations();
});

afterAll(async () => {
  await harness.dispose();
});

beforeEach(async () => {
  await harness.reset();
});

/* -------------------------------------------------------------------------------------- */
/* Áp migration                                                                              */
/* -------------------------------------------------------------------------------------- */

describe('push-job migrations apply cleanly', () => {
  it('applies every statement without error', () => {
    // `beforeAll` đã áp; áp lại phải **không** ném, vì đây là câu hỏi "file migration này có
    // hợp lệ không" chứ không phải "đã áp chưa".
    expect(() => migrationStatements()).not.toThrow();
    expect(migrationStatements().length).toBeGreaterThan(0);
  });

  it('creates both tables the four FR-022 groups need', async () => {
    const tables = await harness.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all<{ readonly name: string }>();

    const names = tables.results.map((row) => row.name);
    expect(names).toContain('push_jobs');
    expect(names).toContain('push_job_attempts');
  });

  it('applies migrations in filename order, not directory order', () => {
    const files = migrationFiles();
    expect(files).toEqual([...files].toSorted((a, b) => a.localeCompare(b, 'en')));
    // Tên file phải zero-padded để thứ tự chữ = thứ tự thời gian.
    for (const name of files) {
      expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/u);
    }
  });
});

/* -------------------------------------------------------------------------------------- */
/* Constraint                                                                                */
/* -------------------------------------------------------------------------------------- */

describe('push_job_attempts uniqueness', () => {
  // (1) idempotent theo `(delivery_id, attempt)` — đây là điều kiện đủ để W1 và Queue
  // redelivery không sinh state mâu thuẫn. Hai worker cùng consume cùng message phải ghi
  // cùng một phím.
  it('rejects a second attempt row for the same (delivery_id, attempt)', async () => {
    await insertAttempt('del_u', 1);

    await expect(insertAttempt('del_u', 1)).rejects.toThrow(
      /UNIQUE constraint failed: push_job_attempts/u,
    );
  });

  it('accepts a different attempt number for the same delivery', async () => {
    await insertAttempt('del_u', 1);

    await expect(insertAttempt('del_u', 2)).resolves.toBeDefined();
  });

  it('accepts the same attempt number for a different delivery', async () => {
    await insertAttempt('del_a', 1);

    await expect(insertAttempt('del_b', 1)).resolves.toBeDefined();
  });

  it('declares the pair as the primary key, so uniqueness is structural rather than an index', async () => {
    const columns = await harness.db
      .prepare(`SELECT name, pk FROM pragma_table_info('push_job_attempts')`)
      .all<{ readonly name: string; readonly pk: number }>();

    expect(
      columns.results
        .filter((row) => row.pk > 0)
        .map((row) => row.name)
        .toSorted(),
    ).toEqual(['attempt', 'delivery_id']);
  });
});

describe('push_jobs constraints', () => {
  it('rejects a transport outside the FR-013 vocabulary', async () => {
    await expect(insertJob({ delivery_id: 'del_t', transport: 'sms' })).rejects.toThrow(
      /push_jobs_transport_check/u,
    );
  });

  it('rejects a terminal outcome that is not part of the closed set', async () => {
    await expect(
      insertJob({ delivery_id: 'del_o', processed: 1, terminal_outcome: 'cancelled' }),
    ).rejects.toThrow(/push_jobs_terminal_outcome_check/u);
  });

  // Parity: có marker ⇔ có kết cục. Một marker không có kết cục là một row mà reconciliation
  // không biết có re-deliver hay không.
  it('rejects a processed marker with no terminal outcome', async () => {
    await expect(insertJob({ delivery_id: 'del_p', processed: 1 })).rejects.toThrow(
      /push_jobs_processed_parity_check/u,
    );
  });

  it('rejects a terminal outcome with no processed marker', async () => {
    await expect(
      insertJob({ delivery_id: 'del_p2', processed: 0, terminal_outcome: 'delivered' }),
    ).rejects.toThrow(/push_jobs_processed_parity_check/u);
  });

  it.each(['delivery_id', 'notification_id', 'subscription_id', 'provider_id'])(
    'rejects an empty %s rather than a silent empty-key bug',
    async (column) => {
      await expect(insertJob({ [column]: '' })).rejects.toThrow(
        new RegExp(`${column}_non_empty_check`, 'u'),
      );
    },
  );

  it('rejects a consume_count below 1', async () => {
    await expect(insertJob({ delivery_id: 'del_c', consume_count: 0 })).rejects.toThrow(
      /push_jobs_consume_count_check/u,
    );
  });

  it('rejects a payload_json that is not a JSON object', async () => {
    await expect(
      insertJob({ delivery_id: 'del_pj', payload_json: 'không phải json' }),
    ).rejects.toThrow(/push_jobs_payload_is_json_object_check/u);
  });

  // ⚠️ Đây là lỗi chỉ lộ ra trên engine thật: `CHECK` chứa subquery làm **cả** `CREATE TABLE`
  // fail, tức hàng phòng thủ đó biến thành bảng không tồn tại. Bảng đã tồn tại ở đây chính là
  // bằng chứng rằng guard phải là trigger, không phải `CHECK` với `NOT EXISTS`.
  it('accepts a payload_json with no forbidden keys, proving the guard is not a broken CHECK', async () => {
    await expect(
      insertJob({
        delivery_id: 'del_ok',
        payload_json: JSON.stringify({ title: 'A', body: 'B', url: 'https://ecoma.io/x' }),
      }),
    ).resolves.toBeDefined();
  });
});

/* -------------------------------------------------------------------------------------- */
/* Guard secret                                                                              */
/* -------------------------------------------------------------------------------------- */

describe('push_jobs forbids credential material in the stored envelope', () => {
  it.each([
    'auth',
    'p256dh',
    'vapid_private_key',
    'vapid_public_key',
    'private_key',
    'public_key',
    'credential',
    'subscription',
  ])('rejects an envelope whose payload carries a top-level %s key', async (key) => {
    await expect(
      insertJob({
        delivery_id: 'del_forbidden',
        payload_json: JSON.stringify({ title: 'A', body: 'B', [key]: 'secret-value' }),
      }),
    ).rejects.toThrow(/push_jobs_envelope_forbidden_key_check/u);
  });

  // ⚠️ Hai trigger, không một: một trigger không bắt được loại write còn lại. Nếu chỉ có
  // `BEFORE INSERT`, một `UPDATE` sẽ lách được secret vào một row đã tồn tại.
  it('also blocks an UPDATE that introduces a forbidden key', async () => {
    await insertJob({
      delivery_id: 'del_upd',
      payload_json: JSON.stringify({ title: 'A', body: 'B' }),
    });

    await expect(
      harness.db
        .prepare(`UPDATE push_jobs SET payload_json = ? WHERE delivery_id = ?`)
        .bind(JSON.stringify({ title: 'A', body: 'B', auth: 'secret' }), 'del_upd')
        .run(),
    ).rejects.toThrow(/push_jobs_envelope_forbidden_key_check/u);
  });

  // `payload.data` là dữ liệu opaque của App — khoá lồng ở đó không bị chặn ở tầng schema,
  // và **được** cho phép: chặn nó sẽ phá use case notification có deep-link.
  it('allows a nested key inside payload data, because data is App-owned opaque data', async () => {
    await expect(
      insertJob({
        delivery_id: 'del_nested',
        payload_json: JSON.stringify({ title: 'A', body: 'B', data: { auth: 'nested-is-opaque' } }),
      }),
    ).resolves.toBeDefined();
  });

  // Trigger phải **tự bảo vệ**: `json_each` trên JSON hỏng ném `malformed JSON`, biến một lỗi
  // dữ liệu thành một lỗi hạ tầng khó chẩn đoán. CHECK loại JSON hỏng trước, nhưng nếu ai đó
  // sau này bỏ CHECK thì trigger không được trở thành nguồn lỗi mới.
  it('reports the payload CHECK rather than a malformed-JSON error for invalid JSON', async () => {
    await expect(
      insertJob({ delivery_id: 'del_bad', payload_json: '{không đóng' }),
    ).rejects.toThrow(/push_jobs_payload_is_json_object_check/u);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Index                                                                                     */
/* -------------------------------------------------------------------------------------- */

describe('push_jobs query paths for reconciliation', () => {
  // Partial index `WHERE processed = 0`: sweep **chỉ** hỏi vế này, nên index phải loại trừ
  // job đã xong khỏi cây.
  it('has a partial index on last_consumed_at restricted to unprocessed jobs', async () => {
    const indexes = await harness.db
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'push_jobs'`,
      )
      .all<{ readonly name: string; readonly sql: string | null }>();

    const stuck = indexes.results.find((row) => row.name === 'push_jobs_stuck_idx');
    expect(stuck?.sql).toContain('last_consumed_at');
    expect(stuck?.sql).toContain('processed = 0');
  });

  it('has a partial index on attempts still open, which is the W2/W3 signal', async () => {
    const indexes = await harness.db
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'push_job_attempts'`,
      )
      .all<{ readonly name: string; readonly sql: string | null }>();

    const open = indexes.results.find((row) => row.name === 'push_job_attempts_open_idx');
    expect(open?.sql).toContain('started_at');
    expect(open?.sql).toContain("state = 'open'");
  });
});

/* -------------------------------------------------------------------------------------- */
/* Không có chỗ cho credential                                                                 */
/* -------------------------------------------------------------------------------------- */

describe('push_jobs schema has nowhere to put a credential', () => {
  // Ràng buộc của FR-022 nhóm 3 và SR-001 là ràng buộc **cấu trúc**: không có cột nào để ghi
  // vào, nên một lỗi ghi secret không chỉ phá policy mà còn **không biên dịch được** nếu không
  // sửa schema. Test này ghim bất biến đó thay vì chỉ ghim hành vi.
  it('declares no column whose name could hold a subscription or VAPID secret', async () => {
    const columns = await harness.db
      .prepare(`SELECT name FROM pragma_table_info('push_jobs')`)
      .all<{
        readonly name: string;
      }>();

    const forbidden =
      /(?:^|_)(?:auth|p256dh|credential|credentials|private_key|public_key|secret|token|endpoint)(?:$|_)/u;
    expect(columns.results.map((row) => row.name).filter((name) => forbidden.test(name))).toEqual(
      [],
    );
  });

  it('declares no column holding the endpoint, because it belongs to the control plane', async () => {
    const columns = await harness.db
      .prepare(`SELECT name FROM pragma_table_info('push_jobs')`)
      .all<{
        readonly name: string;
      }>();

    // `subscription_id` là **identifier** của control plane, không phải endpoint — nó hợp lệ
    // và cần cho reconciliation. `endpoint` thì không: nó là secret của subscription.
    expect(columns.results.map((row) => row.name)).not.toContain('endpoint');
    expect(columns.results.map((row) => row.name)).toContain('subscription_id');
  });
});

/* -------------------------------------------------------------------------------------- */
/* Helper                                                                                    */
/* -------------------------------------------------------------------------------------- */

const NOW = 1_800_000_000_000;

async function insertJob(overrides: Record<string, unknown>): Promise<unknown> {
  return harness.db
    .prepare(
      `INSERT INTO push_jobs (
         delivery_id, envelope_version, notification_id, subscription_id, provider_id,
         transport, payload_json, consume_count, last_consumed_at, consumed_at,
         processed, terminal_outcome, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      (overrides['delivery_id'] ?? 'del_fixture') as string,
      (overrides['envelope_version'] ?? 1) as number,
      (overrides['notification_id'] ?? 'ntf_fixture') as string,
      (overrides['subscription_id'] ?? 'sub_fixture') as string,
      (overrides['provider_id'] ?? 'prov_fixture') as string,
      (overrides['transport'] ?? 'web') as string,
      (overrides['payload_json'] ?? JSON.stringify({ title: 'A', body: 'B' })) as string,
      (overrides['consume_count'] ?? 1) as number,
      (overrides['last_consumed_at'] ?? NOW) as number,
      (overrides['consumed_at'] ?? NOW) as number,
      (overrides['processed'] ?? 0) as number,
      (overrides['terminal_outcome'] ?? null) as string | null,
      (overrides['updated_at'] ?? NOW) as number,
    )
    .run();
}

async function insertAttempt(deliveryId: string, attempt: number): Promise<unknown> {
  return harness.db
    .prepare(
      `INSERT INTO push_job_attempts (
         delivery_id, attempt, outcome, phase, http_status, retry_after_ms, state,
         started_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(deliveryId, attempt, 'delivered', 'terminal_sent', 201, null, 'completed', NOW, NOW)
    .run();
}
