/**
 * Bootstrap first-administrator phía `account` — A1 (create-or-resolve) và A2
 * (đọc lại) trên PostgreSQL thật, cộng chứng minh rằng Superadmin vẫn đăng nhập
 * bằng chính luồng email-OTP hiện có (ADR-0024 Quyết định 1, 2).
 *
 * ## Vì sao cần suite này
 *
 * Ba thứ không thể chứng minh bằng unit test hay bằng đọc code:
 *
 * 1. **Tính nguyên tử** của `users` + `email_addresses` + audit trong một
 *    transaction dưới advisory xact lock — kể cả khi audit insert hỏng.
 * 2. **Hội tụ** (`converged`) chỉ xảy ra khi có bootstrap audit event cùng
 *    transaction; một hàng `verified` trùng địa chỉ do đường khác tạo ra phải
 *    fail-closed, không được "đoán chủ" (ADR-0024 Quyết định 4).
 * 3. **Không phát session**: bootstrap là thao tác ghi database, và lần đăng nhập
 *    đầu tiên vẫn đi qua `POST /api/auth/challenge` → `POST /api/auth/verify`
 *    với OTP thật (ADR-0024 Quyết định 2).
 *
 * ## Ranh giới credential (migration `0011` + `0013`)
 *
 * Migration `0011_bootstrap_write_guards.sql` thu hồi `INSERT` trên
 * `account.users` từ `ecoma_account_runtime`, và thêm trigger chặn runtime chèn
 * sự kiện `bootstrap_account_provisioned`. `0013` sau đó **trả lại** INSERT cho
 * runtime nhưng ràng buộc bằng dữ liệu (trigger birth-guard chỉ nhả khi đang
 * trong transaction chấp nhận lời mời — ADR-0030 Quyết định 5); nhánh runtime
 * của trigger chỉ nhả cho `ecoma_account_migrator`/owner. Do đó A1/A2 vẫn chạy
 * bằng credential **migrator thật** (`connectAsMigrator()`), không qua `SET
 * ROLE` từ superuser — đó là chính credential CLI dùng trên CI runner, và là
 * credential duy nhất vượt được birth-guard ngoài serving path. Superuser chỉ
 * còn dùng để seed dữ liệu đối lập trong test.
 *
 * ## Harness
 *
 * Dùng đúng `harness.ts` của `apps/account` (Testcontainers, credential migrator
 * thật, `applyAllMigrations`) — không có migration runner thứ hai. Docker là phụ
 * thuộc cứng: `probeDocker` ném từ `globalSetup` khi vắng Docker, nên suite này
 * không có nhánh skip nào.
 */

import { createHash } from 'node:crypto';

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import challengeRoute from '../../server/api/auth/challenge.post';
import verifyRoute from '../../server/api/auth/verify.post';
import {
  BOOTSTRAP_AUDIT_TYPE,
  BOOTSTRAP_EMAIL,
  BootstrapDenialError,
  assertConfiguredBootstrapEmail,
  provisionBootstrapAccount,
  verifyBootstrapAccount,
} from '../../db/bootstrap.mts';
import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { installRuntimeConfigStub, type AccountTestRuntimeConfig } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));

const OTP_SECRET = 'test-otp-hmac-secret-0123456789abcdef';

/** `sub` hợp lệ để seed dữ liệu không qua A1. */
const SUB_OTHER = 'sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SUB_THIRD = 'sub_cccccccccccccccccccccccccccccccc';

/** SHA-256 hex của địa chỉ canonical — cùng phép hash mà A1/A2 dùng. */
function canonicalHash(): string {
  return createHash('sha256').update(BOOTSTRAP_EMAIL).digest('hex');
}

function fullRuntimeConfig(connectionString: string): AccountTestRuntimeConfig {
  return {
    internalHmacSecret: 'test-internal-hmac-secret-0123456789abcdef',
    otpHmacSecret: OTP_SECRET,
    mailServiceUrl: 'https://mail.test',
    mailInternalAuthSecret: 'test-mail-internal-auth-secret-placeholder-0001',
    cloudflare: { env: { DB_ACCOUNT: { connectionString } } },
  };
}

/** Mail stub toàn cục: thu payload `POST /v1/messages`, trả 2xx hợp lệ. */
function installMailStub(): {
  sent: Array<{ body: Record<string, unknown> }>;
  restore: () => void;
} {
  const sent: Array<{ body: Record<string, unknown> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = init?.body;
    const text =
      typeof rawBody === 'string'
        ? rawBody
        : rawBody instanceof Uint8Array
          ? new TextDecoder().decode(rawBody)
          : '{}';
    sent.push({ body: JSON.parse(text) as Record<string, unknown> });
    return new Response(JSON.stringify({ id: 'msg-1', status: 'queued' }), { status: 200 });
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Chờ một promise và trả lỗi nó ném, thay vì để vitest báo lỗi không kiểm được. */
async function catchDenial(promise: Promise<unknown>): Promise<BootstrapDenialError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BootstrapDenialError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a BootstrapDenialError, but the call succeeded');
}

describe('bootstrap superadmin (A1/A2)', () => {
  let db: AccountDatabase;
  let connectionString: string;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;
  let handler: WebHandler;

  /** Đếm hàng của ba bảng mà A1 được phép chạm. */
  async function counts(): Promise<{ users: number; emails: number; events: number }> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ users: number; emails: number; events: number }>(
        `SELECT (SELECT count(*)::int FROM account.users) AS users,
                (SELECT count(*)::int FROM account.email_addresses) AS emails,
                (SELECT count(*)::int FROM account.security_events) AS events`,
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error('expected a counts row');
      }
      return row;
    } finally {
      await client.end();
    }
  }

  /** Seed một Account bất kỳ, không qua bootstrap. */
  async function seedUser(sub: string): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`INSERT INTO account.users (sub, status) VALUES ($1, 'active')`, [sub]);
    } finally {
      await client.end();
    }
  }

  /** Seed hàng email bất kỳ cho một `sub`. */
  async function seedEmail(params: {
    sub: string;
    address: string;
    status: 'pending' | 'verified' | 'revoked';
  }): Promise<void> {
    const normalized = params.address.trim().toLowerCase();
    const hash = createHash('sha256').update(normalized).digest('hex');
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO account.email_addresses
           (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          params.sub,
          normalized,
          hash,
          params.status,
          params.status === 'verified',
          params.status === 'verified' ? new Date() : null,
        ],
      );
    } finally {
      await client.end();
    }
  }

  /** Chạy A1 bằng credential **migrator thật** (đường CLI trên CI runner). */
  async function provision(
    input: { correlationId: string; operatorRef: string } = {
      correlationId: 'corr-test-1',
      operatorRef: 'operator-1',
    },
  ): ReturnType<typeof provisionBootstrapAccount> {
    const client = await db.connectAsMigrator();
    try {
      return await provisionBootstrapAccount(client, input);
    } finally {
      await client.end();
    }
  }

  /** Chạy A2 bằng credential **migrator thật**. */
  async function verify(): ReturnType<typeof verifyBootstrapAccount> {
    const client = await db.connectAsMigrator();
    try {
      return await verifyBootstrapAccount(client);
    } finally {
      await client.end();
    }
  }

  /** POST JSON vào app h3 của test. */
  async function post(path: string, body: unknown): Promise<Response> {
    return handler(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Challenge cho địa chỉ canonical, trả mã OTP thật từ mail stub. */
  async function challenge(): Promise<{ status: number; sent: number; code?: string }> {
    const mail = installMailStub();
    try {
      const response = await post('/api/auth/challenge', { email: BOOTSTRAP_EMAIL });
      const variables = mail.sent[0]?.body['variables'] as { code?: string } | undefined;
      return { status: response.status, sent: mail.sent.length, code: variables?.code };
    } finally {
      mail.restore();
    }
  }

  beforeAll(async () => {
    db = await startAccountDatabase();
    connectionString = `postgres://ecoma_account_runtime:${db.rolePassword}@${db.host}:${db.port}/${ACCOUNT_DATABASE}`;
    setRuntimeConfig = installRuntimeConfigStub(fullRuntimeConfig(connectionString));

    const app = createApp();
    const router = createRouter();
    router.post('/api/auth/challenge', challengeRoute);
    router.post('/api/auth/verify', verifyRoute);
    app.use(router.handler);
    handler = toWebHandler(app);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    setRuntimeConfig(fullRuntimeConfig(connectionString));
    await db.truncateData();
  });

  it('provisions via real migrator credential: one active account, canonical verified address, audit row', async () => {
    const result = await provision();
    expect(result.stage).toBe('account.provision');
    expect(result.status).toBe('created');
    expect(result.sub).toMatch(/^sub_[a-z2-7]{32}$/u);
    expect(result.sub).not.toContain('@');

    const client = await db.connect();
    try {
      const users = await client.query<{ sub: string; status: string }>(
        `SELECT sub, status FROM account.users`,
      );
      expect(users.rows).toHaveLength(1);
      expect(users.rows[0]?.sub).toBe(result.sub);
      expect(users.rows[0]?.status).toBe('active');

      const emails = await client.query<{
        user_sub: string;
        address_normalized: string;
        address_hash: string;
        status: string;
        is_sign_in: boolean;
        verified_at: Date | null;
      }>(
        `SELECT user_sub, address_normalized, address_hash, status, is_sign_in, verified_at
           FROM account.email_addresses`,
      );
      expect(emails.rows).toHaveLength(1);
      const email = emails.rows[0];
      expect(email?.user_sub).toBe(result.sub);
      expect(email?.address_normalized).toBe(BOOTSTRAP_EMAIL);
      expect(email?.address_hash).toBe(canonicalHash());
      expect(email?.status).toBe('verified');
      expect(email?.is_sign_in).toBe(true);
      expect(email?.verified_at).not.toBeNull();

      const events = await client.query<{ type: string; outcome: string; metadata: unknown }>(
        `SELECT type, outcome, metadata FROM account.security_events`,
      );
      expect(events.rows).toHaveLength(1);
      const event = events.rows[0];
      expect(event?.type).toBe(BOOTSTRAP_AUDIT_TYPE);
      expect(event?.outcome).toBe('success');
      const metadata = event?.metadata as Record<string, unknown>;
      expect(metadata['address_hash']).toBe(canonicalHash());
      expect(metadata['correlation_id']).toBe('corr-test-1');
      expect(metadata['mode']).toBe('bootstrap');
      expect(metadata['verification_source']).toBe('trusted_bootstrap');
      expect(metadata['operator_ref']).toBe('operator-1');
      expect(metadata['status']).toBe('created');
      // Không địa chỉ trần ở bất kỳ đâu trong metadata.
      expect(JSON.stringify(metadata)).not.toContain(BOOTSTRAP_EMAIL);
    } finally {
      await client.end();
    }
  });

  it('converges a re-run to the same sub without adding rows', async () => {
    const first = await provision({
      correlationId: 'corr-first',
      operatorRef: 'operator-1',
    });
    const second = await provision({
      correlationId: 'corr-second',
      operatorRef: 'operator-1',
    });
    // Lần thứ ba chứng minh vế "đúng một bootstrap audit event chứng minh nguồn
    // gốc": row `converged` không được làm phép đếm trôi lên hai.
    const third = await provision({
      correlationId: 'corr-third',
      operatorRef: 'operator-1',
    });

    expect(first.status).toBe('created');
    expect(second.status).toBe('converged');
    expect(second.sub).toBe(first.sub);
    expect(third.status).toBe('converged');
    expect(third.sub).toBe(first.sub);

    const after = await counts();
    expect(after.users).toBe(1);
    expect(after.emails).toBe(1);
    // Hội tụ vẫn ghi audit của chính nó: một row created + hai row converged.
    expect(after.events).toBe(3);

    const verified = await verify();
    expect(verified).toEqual({ status: 'converged', sub: first.sub });
  });

  it('refuses an empty operator_ref before opening a write transaction', async () => {
    // ADR-0021 Quyết định 6 đòi audit mang tham chiếu người thực thi. A1 commit
    // trước S1/S2, nên nhận `operator_ref` rỗng ở đây sẽ để lại một Account
    // không attribution mà không bước nào sau đó sửa được.
    for (const operatorRef of ['', '   ']) {
      await expect(provision({ correlationId: 'corr-empty-op', operatorRef })).rejects.toThrow(
        /operatorRef must be a non-empty string/u,
      );
    }

    const client = await db.connect();
    try {
      const afterEmptyRun = await client.query<{ users: number; events: number }>(
        `SELECT (SELECT count(*)::int FROM account.users) AS users,
                (SELECT count(*)::int FROM account.security_events) AS events`,
      );
      expect(afterEmptyRun.rows[0]).toEqual({ users: 0, events: 0 });
    } finally {
      await client.end();
    }
  });

  it('refuses an operator_ref that is only whitespace on a convergence re-run too', async () => {
    // Nhánh hội tụ cũng ghi audit; nó không được là đường vòng qua cùng ràng buộc.
    const first = await provision();
    await expect(
      provision({ correlationId: 'corr-converge-op', operatorRef: '  ' }),
    ).rejects.toThrow(/non-empty/u);

    const client = await db.connect();
    try {
      const events = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account.security_events`,
      );
      expect(events.rows[0]?.count).toBe(1);
      const users = await client.query<{ sub: string }>(`SELECT sub FROM account.users`);
      expect(users.rows.map((row) => row.sub)).toEqual([first.sub]);
    } finally {
      await client.end();
    }
  });

  it('library provisionBootstrapAccount rejects a non-empty malformed operator_ref and writes nothing', async () => {
    const client = await db.connectAsMigrator();
    try {
      await expect(
        provisionBootstrapAccount(client, {
          correlationId: 'corr-malformed-op',
          operatorRef: 'CHG/1',
        }),
      ).rejects.toThrow(/ASCII identifier/u);

      const rowCounts = await client.query<{ users: number; events: number }>(
        `SELECT (SELECT count(*)::int FROM account.users) AS users,
                (SELECT count(*)::int FROM account.security_events) AS events`,
      );
      expect(rowCounts.rows[0]).toEqual({ users: 0, events: 0 });
    } finally {
      await client.end();
    }
  });

  it('denies account_database_not_empty when an unrelated account already exists', async () => {
    await seedUser(SUB_OTHER);

    const denial = await catchDenial(provision());
    expect(denial.reason).toBe('account_database_not_empty');

    const after = await counts();
    expect(after.users).toBe(1);
    expect(after.emails).toBe(0);
    expect(after.events).toBe(0);
  });

  it('denies address_not_bootstrap_proven when the proof audit row belongs to another sub', async () => {
    // Audit event của `subject_sub` khác không chứng minh nguồn gốc của hàng email
    // này: A1 không bao giờ nhận một Account từ một audit row không neo đúng
    // `(sub, address_hash)` của hàng đang xét.
    await seedUser(SUB_OTHER);
    await seedEmail({ sub: SUB_OTHER, address: BOOTSTRAP_EMAIL, status: 'verified' });
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO account.security_events (subject_sub, type, outcome, metadata)
         VALUES ($1, $2, 'success', $3::jsonb)`,
        [
          SUB_THIRD,
          BOOTSTRAP_AUDIT_TYPE,
          JSON.stringify({
            address_hash: canonicalHash(),
            correlation_id: 'corr-foreign',
            mode: 'bootstrap',
            verification_source: 'trusted_bootstrap',
            operator_ref: 'operator-foreign',
            status: 'created',
          }),
        ],
      );
    } finally {
      await client.end();
    }

    const denial = await catchDenial(provision());
    expect(denial.reason).toBe('address_not_bootstrap_proven');
    expect((await counts()).users).toBe(1);
  });

  it('denies address_not_bootstrap_proven when the proof row is only a converged event', async () => {
    // Chỉ row `status = 'created'` chứng minh Account do bootstrap tạo; một row
    // `converged` là dấu vết của lần xác nhận lại, không phải nguồn gốc.
    await seedUser(SUB_OTHER);
    await seedEmail({ sub: SUB_OTHER, address: BOOTSTRAP_EMAIL, status: 'verified' });
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO account.security_events (subject_sub, type, outcome, metadata)
         VALUES ($1, $2, 'success', $3::jsonb)`,
        [
          SUB_OTHER,
          BOOTSTRAP_AUDIT_TYPE,
          JSON.stringify({
            address_hash: canonicalHash(),
            correlation_id: 'corr-converged-only',
            mode: 'bootstrap',
            verification_source: 'trusted_bootstrap',
            operator_ref: 'operator-other',
            status: 'converged',
          }),
        ],
      );
    } finally {
      await client.end();
    }

    const denial = await catchDenial(provision());
    expect(denial.reason).toBe('address_not_bootstrap_proven');
    expect((await counts()).users).toBe(1);
  });
  it('denies address_not_bootstrap_proven for a verified row without a bootstrap audit event', async () => {
    await seedUser(SUB_OTHER);
    await seedEmail({ sub: SUB_OTHER, address: BOOTSTRAP_EMAIL, status: 'verified' });

    const denial = await catchDenial(provision());
    expect(denial.reason).toBe('address_not_bootstrap_proven');

    const after = await counts();
    expect(after.users).toBe(1);
    expect(after.emails).toBe(1);
    expect(after.events).toBe(0);
  });

  it('denies address_ambiguous when two subs hold the canonical address', async () => {
    await seedUser(SUB_OTHER);
    await seedUser(SUB_THIRD);
    await seedEmail({ sub: SUB_OTHER, address: BOOTSTRAP_EMAIL, status: 'pending' });
    await seedEmail({ sub: SUB_THIRD, address: BOOTSTRAP_EMAIL, status: 'verified' });

    const denial = await catchDenial(provision());
    expect(denial.reason).toBe('address_ambiguous');
    expect((await counts()).users).toBe(2);
  });

  it('denies address_revoked when a revoked row exists for the canonical address', async () => {
    await seedUser(SUB_OTHER);
    await seedEmail({ sub: SUB_OTHER, address: BOOTSTRAP_EMAIL, status: 'revoked' });

    const denial = await catchDenial(provision());
    expect(denial.reason).toBe('address_revoked');
    expect((await counts()).emails).toBe(1);
  });

  it('denies address_pending_conflict for a pending claim on the canonical address', async () => {
    await seedUser(SUB_OTHER);
    await seedEmail({ sub: SUB_OTHER, address: BOOTSTRAP_EMAIL, status: 'pending' });

    const denial = await catchDenial(provision());
    expect(denial.reason).toBe('address_pending_conflict');
    expect((await counts()).emails).toBe(1);
  });

  it('denies account_not_active when the bootstrap-owned account is suspended', async () => {
    const created = await provision();
    const client = await db.connect();
    try {
      await client.query(`UPDATE account.users SET status = 'suspended' WHERE sub = $1`, [
        created.sub,
      ]);
    } finally {
      await client.end();
    }

    const denial = await catchDenial(provision());
    expect(denial.reason).toBe('account_not_active');
  });

  it('denies account_has_other_verified_address when the owner has a second verified address', async () => {
    const created = await provision();
    await seedEmail({ sub: created.sub, address: 'other@example.com', status: 'verified' });

    const denial = await catchDenial(provision());
    expect(denial.reason).toBe('account_has_other_verified_address');
  });

  it('denies address_multiple_live_rows when one sub has two live rows for the address', async () => {
    const created = await provision();
    // Partial UNIQUE `(address_hash) WHERE status = 'verified'` chặn hàng `verified`
    // thứ hai, nhưng KHÔNG chặn một hàng `pending` thứ hai cho cùng `sub`/địa chỉ.
    // Đó là trạng thái bất thường mà A1 phải fail-closed, không được chọn một hàng.
    await seedEmail({ sub: created.sub, address: BOOTSTRAP_EMAIL, status: 'pending' });

    const denial = await catchDenial(provision());
    expect(denial.reason).toBe('address_multiple_live_rows');
  });

  it('serialises two concurrent A1 calls into one created and one converged', async () => {
    const firstClient = await db.connectAsMigrator();
    const secondClient = await db.connectAsMigrator();
    try {
      const [first, second] = await Promise.all([
        provisionBootstrapAccount(firstClient, {
          correlationId: 'corr-race-1',
          operatorRef: 'operator-1',
        }),
        provisionBootstrapAccount(secondClient, {
          correlationId: 'corr-race-2',
          operatorRef: 'operator-1',
        }),
      ]);
      expect([first.status, second.status].toSorted()).toEqual(['converged', 'created']);
      expect(first.sub).toBe(second.sub);
    } finally {
      await firstClient.end();
      await secondClient.end();
    }

    const after = await counts();
    expect(after.users).toBe(1);
    expect(after.emails).toBe(1);
    // Một audit `created` + một audit `converged`, cùng `subject_sub`.
    expect(after.events).toBe(2);
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ subject_sub: string }>(
        `SELECT DISTINCT subject_sub FROM account.security_events`,
      );
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it('rolls the whole transaction back when the audit insert fails', async () => {
    const setup = await db.connect();
    try {
      // Trigger test-only: làm mọi INSERT `bootstrap_account_provisioned` ném.
      await setup.query(
        `CREATE OR REPLACE FUNCTION account.test_fail_bootstrap_audit() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'test-only failure';
         END;
         $$`,
      );
      await setup.query(
        `CREATE TRIGGER test_fail_bootstrap_audit
           BEFORE INSERT ON account.security_events
           FOR EACH ROW WHEN (NEW.type = '${BOOTSTRAP_AUDIT_TYPE}')
           EXECUTE FUNCTION account.test_fail_bootstrap_audit()`,
      );
    } finally {
      await setup.end();
    }

    try {
      await expect(provision()).rejects.toThrow(/test-only failure/u);

      const after = await counts();
      expect(after.users).toBe(0);
      expect(after.emails).toBe(0);
      expect(after.events).toBe(0);
    } finally {
      // Trigger/function tồn tại ở tầng schema và `truncateData` không dọn chúng —
      // bỏ ngay sau test để các case khác không thừa hưởng.
      const cleanup = await db.connect();
      try {
        await cleanup.query(
          `DROP TRIGGER IF EXISTS test_fail_bootstrap_audit ON account.security_events`,
        );
        await cleanup.query(`DROP FUNCTION IF EXISTS account.test_fail_bootstrap_audit()`);
      } finally {
        await cleanup.end();
      }
    }
  });

  it('runtime role cannot INSERT into account.users outside an invitation acceptance (0013 guard)', async () => {
    // `0013` trả lại INSERT cho runtime nhưng ràng buộc bằng dữ liệu: trigger
    // birth-guard chỉ nhả trong transaction chấp nhận lời mời (ADR-0030 Quyết
    // định 5). INSERT trần của runtime — hình cũ `0011` chặn bằng permission —
    // giờ bị chặn bằng chính trigger, với thông điệp riêng.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(`INSERT INTO account.users (sub, status) VALUES ($1, 'active')`, [
          'sub_runtime_insert',
        ]),
      ).rejects.toThrow(/invitation-acceptance transaction/iu);
    } finally {
      await runtime.end();
    }
    // Không hàng nào bị thêm: revoke có hiệu lực, không chỉ là catalog.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account.users WHERE sub = $1`,
        ['sub_runtime_insert'],
      );
      expect(rows[0]?.count).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('runtime role cannot insert bootstrap_account_provisioned security event (0011 trigger)', async () => {
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO account.security_events (subject_sub, type, outcome, metadata)
           VALUES ($1, $2, 'success', $3::jsonb)`,
          [
            'sub_runtime_event',
            BOOTSTRAP_AUDIT_TYPE,
            JSON.stringify({ address_hash: 'x', status: 'created' }),
          ],
        ),
      ).rejects.toThrow(/not allowed to insert bootstrap/iu);
    } finally {
      await runtime.end();
    }

    // Sự kiện giả mạo không được lưu: số row bootstrap_account_provisioned vẫn là 0.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account.security_events WHERE type = $1`,
        [BOOTSTRAP_AUDIT_TYPE],
      );
      expect(rows[0]?.count).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('runtime role can still insert an ordinary serving-path security event', async () => {
    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO account.security_events (subject_sub, type, outcome, metadata)
         VALUES ($1, $2, 'success', $3::jsonb)`,
        ['sub_runtime_event', 'data_email_added', JSON.stringify({ field_count: 1 })],
      );
    } finally {
      await runtime.end();
    }

    const client = await db.connect();
    try {
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account.security_events WHERE type = $1`,
        ['data_email_added'],
      );
      expect(rows[0]?.count).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('A1 is blocked by a concurrent uncommitted INSERT on users, then denies account_database_not_empty', async () => {
    // conn1: chèn một user nhưng chưa commit — giữ ROW EXCLUSIVE lock trên users.
    const conn1 = await db.connectAsMigrator();
    let conn1Ended = false;
    try {
      await conn1.query('BEGIN');
      await conn1.query(`INSERT INTO account.users (sub, status) VALUES ($1, 'active')`, [
        'sub_blocker_a',
      ]);
      const { rows: r1 } = await conn1.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const conn1PidRow = r1[0];
      if (!conn1PidRow) {
        throw new Error('pg_backend_pid did not return a row');
      }
      const conn1Pid = conn1PidRow.pid;

      // conn2: chạy A1 (migrator thật) — bị chặn tại LOCK TABLE vì conn1 giữ lock.
      // Không await: để provision chạy nền và bị chặn, sau đó mới polling detects block.
      const conn2 = await db.connectAsMigrator();
      let conn2Ended = false;
      try {
        const { rows: r2 } = await conn2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const conn2PidRow = r2[0];
        if (!conn2PidRow) {
          throw new Error('pg_backend_pid did not return a row');
        }
        const conn2Pid = conn2PidRow.pid;
        let provisionError: unknown = undefined;
        const provisionPromise = provisionBootstrapAccount(conn2, {
          correlationId: 'corr-blocked-a',
          operatorRef: 'operator-1',
        }).catch((error) => {
          provisionError = error;
        });

        // Đợi cho đến khi conn2 bị chặn bởi conn1 (polling có giới hạn, không sleep cố định).
        const poller = await db.connect();
        let blockerPids: number[] = [];
        try {
          for (let attempt = 0; attempt < 400; attempt++) {
            const { rows } = await poller.query<{ blocked: number[] }>(
              'SELECT pg_blocking_pids($1::int) AS blocked',
              [conn2Pid],
            );
            blockerPids = rows[0]?.blocked ?? [];
            if (blockerPids.includes(conn1Pid)) break;
            await new Promise((r) => {
              setTimeout(r, 25);
            });
          }
        } finally {
          await poller.end();
        }
        expect(blockerPids).toContain(conn1Pid);

        // conn1 commit → nhả khoá bảng → conn2 tiếp tục, thấy database không trống, từ chối.
        await conn1.query('COMMIT');
        conn1Ended = true;
        await conn1.end();

        await provisionPromise;
        conn2Ended = true;
        await conn2.end();

        expect(provisionError).toBeDefined();
        expect(provisionError).toBeInstanceOf(BootstrapDenialError);
        expect((provisionError as BootstrapDenialError).reason).toBe('account_database_not_empty');

        // Rất chính xác một hàng user (của conn1), A1 không thêm được gì.
        const client = await db.connect();
        try {
          const { rows } = await client.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM account.users',
          );
          expect(rows[0]?.count).toBe(1);
        } finally {
          await client.end();
        }
      } finally {
        if (!conn2Ended) {
          await conn2.end().catch(() => undefined);
        }
      }
    } finally {
      if (!conn1Ended) {
        await conn1.end().catch(() => undefined);
      }
    }
  }, 30000);

  it('LOCK TABLE SHARE ROW EXCLUSIVE mutually excludes a concurrent INSERT on users', async () => {
    // conn1: khoá bảng users ở SHARE ROW EXCLUSIVE (chưa commit).
    const conn1 = await db.connectAsMigrator();
    let conn1Ended = false;
    try {
      await conn1.query('BEGIN');
      await conn1.query('LOCK TABLE account.users IN SHARE ROW EXCLUSIVE MODE');
      const { rows: r1 } = await conn1.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const conn1PidRow = r1[0];
      if (!conn1PidRow) {
        throw new Error('pg_backend_pid did not return a row');
      }
      const conn1Pid = conn1PidRow.pid;

      // conn2: INSERT vào users — bị chặn bởi lock của conn1.
      const conn2 = await db.connectAsMigrator();
      let conn2Ended = false;
      try {
        const { rows: r2 } = await conn2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const conn2PidRow = r2[0];
        if (!conn2PidRow) {
          throw new Error('pg_backend_pid did not return a row');
        }
        const conn2Pid = conn2PidRow.pid;
        let insertError: unknown = undefined;
        const insertPromise = (async () => {
          try {
            await conn2.query(`INSERT INTO account.users (sub, status) VALUES ($1, 'active')`, [
              'sub_blocker_b',
            ]);
          } catch (error) {
            insertError = error;
          }
        })();

        // Đợi conn2 bị chặn bởi conn1.
        const poller = await db.connect();
        let blockerPids: number[] = [];
        try {
          for (let attempt = 0; attempt < 400; attempt++) {
            const { rows } = await poller.query<{ blocked: number[] }>(
              'SELECT pg_blocking_pids($1::int) AS blocked',
              [conn2Pid],
            );
            blockerPids = rows[0]?.blocked ?? [];
            if (blockerPids.includes(conn1Pid)) break;
            await new Promise((r) => {
              setTimeout(r, 25);
            });
          }
        } finally {
          await poller.end();
        }
        expect(blockerPids).toContain(conn1Pid);

        // conn1 rollback → nhả khoá → conn2 INSERT thành công.
        await conn1.query('ROLLBACK');
        conn1Ended = true;
        await conn1.end();
        await insertPromise;
        expect(insertError).toBeUndefined();

        // Dọn hàng user conn2 chèn.
        const cleanup = await db.connect();
        try {
          await cleanup.query(`DELETE FROM account.users WHERE sub = $1`, ['sub_blocker_b']);
        } finally {
          await cleanup.end();
        }
        conn2Ended = true;
        await conn2.end();
      } finally {
        if (!conn2Ended) {
          await conn2.end().catch(() => undefined);
        }
      }
    } finally {
      if (!conn1Ended) {
        await conn1.end().catch(() => undefined);
      }
    }
  }, 30000);

  it('A2 is read-only: a fresh database yields no_bootstrap_account and no rows appear', async () => {
    const denial = await catchDenial(verify());
    expect(denial.reason).toBe('no_bootstrap_account');

    const after = await counts();
    expect(after.users).toBe(0);
    expect(after.emails).toBe(0);
    expect(after.events).toBe(0);
  });

  it('A2 denies account_database_not_empty when users exist but the canonical row does not', async () => {
    await seedUser(SUB_OTHER);

    const denial = await catchDenial(verify());
    expect(denial.reason).toBe('account_database_not_empty');
  });

  it('A2 denies for an ordinary pending address and writes nothing', async () => {
    await seedUser(SUB_OTHER);
    await seedEmail({ sub: SUB_OTHER, address: BOOTSTRAP_EMAIL, status: 'pending' });

    const denial = await catchDenial(verify());
    expect(denial.reason).toBe('address_pending_conflict');
    expect(await counts()).toEqual({ users: 1, emails: 1, events: 0 });
  });

  it('accepts a configured bootstrap email only when it normalises to the canonical value', () => {
    expect(() => assertConfiguredBootstrapEmail(undefined)).not.toThrow();
    expect(() => assertConfiguredBootstrapEmail('')).not.toThrow();
    expect(() => assertConfiguredBootstrapEmail('  SuperAdmin@ECOMA.io ')).not.toThrow();
    expect(() => assertConfiguredBootstrapEmail('admin@example.com')).toThrow(
      /does not match the canonical bootstrap address/u,
    );
  });

  it('keeps the login gate untouched: bootstrap never issues a session, OTP does', async () => {
    const created = await provision();

    // Bootstrap không phát session, token hay cookie nào.
    const before = await db.connect();
    try {
      const sessions = await before.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account.account_sessions`,
      );
      expect(sessions.rows[0]?.count).toBe(0);
    } finally {
      await before.end();
    }

    // Đăng nhập đầu tiên: challenge thật gửi OTP thật cho địa chỉ bootstrap.
    const first = await challenge();
    expect(first.status).toBe(204);
    expect(first.sent).toBe(1);
    expect(typeof first.code).toBe('string');
    const code = first.code as string;

    // Mã sai không tạo session.
    const wrong = code === '00000000' ? '00000001' : '00000000';
    const wrongResponse = await post('/api/auth/verify', { email: BOOTSTRAP_EMAIL, code: wrong });
    expect(wrongResponse.status).toBe(400);

    // Mã đúng tạo session cho chính `sub` mà A1 tạo.
    const okResponse = await post('/api/auth/verify', { email: BOOTSTRAP_EMAIL, code });
    expect(okResponse.status).toBe(200);
    expect(await okResponse.json()).toEqual({ ok: true });

    const after = await db.connect();
    try {
      const sessions = await after.query<{ user_sub: string; revoked_at: Date | null }>(
        `SELECT user_sub, revoked_at FROM account.account_sessions`,
      );
      expect(sessions.rows).toHaveLength(1);
      expect(sessions.rows[0]?.user_sub).toBe(created.sub);
      expect(sessions.rows[0]?.revoked_at).toBeNull();
    } finally {
      await after.end();
    }
  });

  it('an ordinary pending address receives no login OTP and no session', async () => {
    await seedUser(SUB_OTHER);
    await seedEmail({ sub: SUB_OTHER, address: 'pending@example.com', status: 'pending' });

    const challenged = await challenge();
    // Challenge cho địa chỉ bootstrap trên database chưa bootstrap: 204 nhưng không mail.
    expect(challenged.status).toBe(204);
    expect(challenged.sent).toBe(0);

    const mail = installMailStub();
    try {
      const pendingChallenge = await post('/api/auth/challenge', {
        email: 'pending@example.com',
      });
      expect(pendingChallenge.status).toBe(204);
      // Hàng `pending` không bao giờ nhận OTP đăng nhập.
      expect(mail.sent).toHaveLength(0);
    } finally {
      mail.restore();
    }

    const verifyResponse = await post('/api/auth/verify', {
      email: 'pending@example.com',
      code: '12345678',
    });
    expect(verifyResponse.status).toBe(400);

    const client = await db.connect();
    try {
      const sessions = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account.account_sessions`,
      );
      expect(sessions.rows[0]?.count).toBe(0);
    } finally {
      await client.end();
    }
  });
});
