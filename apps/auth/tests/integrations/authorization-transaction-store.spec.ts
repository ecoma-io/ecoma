import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postgres from 'postgres';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bytesToBase64Url } from '@ecoma-io/auth-domain';

import {
  advanceTransactionWithHandle,
  consumeHandleY,
  insertAuthorizationCode,
  insertTransaction,
  findTransactionByHandleX,
  transitionTransaction,
} from '@ecoma-io/auth-infrastructure';
import { MIGRATIONS_DIR, startAuthDatabase, type AuthDatabase } from './harness';

/**
 * Hợp đồng persistence của `authorization_transactions` trên PostgreSQL THẬT.
 *
 * Suite này thuộc `apps/auth` (app sở hữu `db-auth`) thay vì colocated trong
 * `libs/auth-infrastructure` — 06-testing.md §9 cấm "spec colocated boot
 * database thật"; đã chuyển theo đúng ý #298 PR-C. Docker là phụ thuộc cứng
 * (fail-loud qua docker-probe của config integration — không skip với exit 0).
 *
 * ⚠️ Vì sao phải có PostgreSQL thật: toàn bộ điểm C1 là câu SQL của adapter
 * khớp schema thật — đúng tên cột, đúng kiểu (`transaction_id` là `text` sau
 * `0011`, hash là `bytea`, scope là `text[]`), đúng ràng buộc. Bảng do test tự
 * chế là schema thứ hai; test xanh trên schema thứ hai không nói gì về
 * production (đúng bài học của `authorization-code-cas.spec.ts`). Suite này áp
 * chính các file `apps/auth/migrations/*.sql`.
 *
 * ⚠️ Hai role như CAS spec: `ecoma_auth_migrator` dựng schema, runtime chỉ
 * chạy DML. Nếu adapter chạy được bằng superuser thì test không chứng minh gì
 * về quyền production.
 */
let db: AuthDatabase;

function base() {
  if (db === undefined) {
    throw new Error('database container is not running');
  }
  return {
    host: db.host,
    port: db.port,
    database: db.database,
    prepare: false,
  } as const;
}

function connectRuntime(max = 10): postgres.Sql {
  return postgres({
    ...base(),
    user: db.runtimeUser,
    password: db.runtimePassword,
    max,
  });
}

function connectMigrator(): postgres.Sql {
  return postgres({
    ...base(),
    user: db.migratorUser,
    password: db.migratorPassword,
    max: 1,
  });
}

/** Dựng container + schema rồi trả về cặp client runtime/migrator đã sẵn sàng. */
async function setup(): Promise<{ runtime: postgres.Sql; migrator: postgres.Sql }> {
  return { runtime: connectRuntime(), migrator: connectMigrator() };
}

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

const BASE_TX_ID = 'a'.repeat(43); // 43 ký tự base64url — như `createOpaqueId`
const SCOPE_TX_ID = 'b'.repeat(43);
const HASH_X = 'XXkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw';
const HASH_X_ALT = 'YYkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw';
const BINDING_HASH = 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4';

function newTxRecord(overrides: Partial<Parameters<typeof insertTransaction>[1]> = {}) {
  return {
    transaction_id: BASE_TX_ID,
    handle_hash_x: HASH_X,
    client_id: 'client-tx-store-test',
    redirect_uri: 'https://app.example.com/cb',
    requested_scopes: ['openid'] as const,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    browser_binding_hash: BINDING_HASH,
    key_version: 1,
    expires_at: new Date(Date.now() + 600_000),
    client_state: null,
    nonce: null,
    ...overrides,
  };
}

/** Client đăng ký — FK của `oauth_clients` đòi hàng trước. */
async function seedClient(migrator: postgres.Sql, clientId: string): Promise<void> {
  await migrator`
    INSERT INTO auth.oauth_clients (client_id, client_name, client_type)
    VALUES (${clientId}, 'tx store test client', 'public')
    ON CONFLICT (client_id) DO NOTHING
  `;
}

/**
 * Xoá mọi hàng test tạo ra. Thứ tự: code trước, transaction sau — FK
 * `ON DELETE RESTRICT` của `authorization_codes` sang transaction.
 */
async function cleanup(migrator: postgres.Sql, transactionIds: string[]): Promise<void> {
  if (transactionIds.length === 0) {
    return;
  }
  await migrator`
    DELETE FROM auth.authorization_codes
     WHERE authorization_transaction_id IN ${migrator(transactionIds)}
  `;
  await migrator`
    DELETE FROM auth.authorization_transactions
     WHERE transaction_id IN ${migrator(transactionIds)}
  `;
}

describe('authorization-transaction-store — on real PostgreSQL', () => {
  // Container riêng của file này, dựng một lần cho cả suite; các test tự mở
  // cặp client qua `setup()` và tự đóng trong `finally`.
  beforeAll(async () => {
    db = await startAuthDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  describe('migration 0011 — asserted against the FILE, runs without PostgreSQL', () => {
    // ⚠️ Probe đã đo được lỗi này trên PostgreSQL thật: psql không bọc transaction
    // COMMIT từng statement, nên khi guard BƯỚC 0 vang trên database có hàng legacy,
    // các bước 1-2 (đổi kiểu) đã kịp COMMIT — guard vang nhưng schema lệch nửa đường
    // (transaction_id thành `text` trong khi CHECK/FK còn cũ). BEGIN/COMMIT bọc toàn
    // file biến mọi điểm hỏng thành rollback toàn phần; assert trên file là assert
    // trên thứ sẽ được deploy (cùng lý do với nhóm test 0010 của internal-nonces.spec).
    it('wraps the whole conversion in ONE transaction (BEGIN ... COMMIT)', () => {
      const source = readFileSync(
        join(MIGRATIONS_DIR, '0011_authorization_transaction_contract.sql'),
        'utf8',
      );
      const beginPos = source.indexOf('BEGIN;');
      const commitPos = source.indexOf('COMMIT;');
      expect(beginPos).toBeGreaterThan(-1);
      expect(commitPos).toBeGreaterThan(beginPos);
      // Bắt buộc COMMIT đứng SAU mọi DDL: statement nào nằm ngoài cặp BEGIN/COMMIT
      // là statement tự COMMIT — đúng thứ probe đã chứng kiến rò rỉ.
      const lastDdl = source.lastIndexOf('COMMENT ON COLUMN');
      expect(lastDdl).toBeGreaterThan(-1);
      expect(lastDdl).toBeLessThan(commitPos);
    });

    it('fails loudly on legacy states and never guesses a mapping', () => {
      const source = readFileSync(
        join(MIGRATIONS_DIR, '0011_authorization_transaction_contract.sql'),
        'utf8',
      );
      // Guard BƯỚC 0 phải RAISE EXCEPTION (dừng), không phải UPDATE/DROP âm thầm.
      expect(source).toMatch(/RAISE EXCEPTION[\S\s]*?state legacy/u);
      expect(source).not.toMatch(/DELETE FROM auth\.authorization_transactions/u);
      expect(source).not.toMatch(/TRUNCATE/u);
      // Không đổi file có trong lịch sử migration.
      expect(source).not.toMatch(/ALTER TABLE auth\.authorization_codes\s+ALTER COLUMN code_hash/u);
    });
  });

  describe('schema catalog after migration 0011', () => {
    it('transaction_id is TEXT, no longer UUID — the column type is read from the database', async () => {
      const { migrator } = await setup();
      try {
        const rows = await migrator<{ data_type: string }[]>`
          SELECT data_type FROM information_schema.columns
           WHERE table_schema = 'auth'
             AND table_name = 'authorization_transactions'
             AND column_name = 'transaction_id'
        `;
        expect(rows[0]?.data_type).toBe('text');
      } finally {
        await migrator.end({ timeout: 1 });
      }
    });

    it('the three related FK columns are TEXT too — detach/re-attach misses no column', async () => {
      // 0011 đổi cả bốn cột; bỏ sót một cột nghĩa là so khớp text với uuid
      // nổ ngay khi chạy query — nhưng chỉ nổ ở ĐƯỜNG DÙNG CÓ SO KHỚP. Test
      // catalog này bắt nó ở tầng schema, không phải chờ đúng đường dùng.
      const { migrator } = await setup();
      try {
        const rows = await migrator<{ column_name: string; data_type: string }[]>`
          SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'auth'
             AND (
               (table_name = 'authorization_codes'
                  AND column_name = 'authorization_transaction_id')
               OR (table_name = 'oauth_consent_decisions'
                     AND column_name = 'authorization_transaction_id')
               OR (table_name = 'authorization_audit_events'
                     AND column_name = 'authorization_transaction_id')
             )
           ORDER BY column_name
        `;
        expect(rows).toHaveLength(3);
        for (const row of rows) {
          expect(row.data_type).toBe('text');
        }
      } finally {
        await migrator.end({ timeout: 1 });
      }
    });

    it('the state CHECK is exactly the 6 canonical states — no legacy state slips through', async () => {
      // ⚠️ Đây là test của chính lỗi 4.2: schema cũ cho `awaiting_login`/
      // `consent_denied`/`already_processed`. CHECK này là ranh giới hợp đồng
      // state machine; lệch một tên là một state "ma" có thể được ghi.
      const { migrator } = await setup();
      try {
        const rows = await migrator<{ check_clause: string }[]>`
          SELECT pg_get_constraintdef(c.oid) AS check_clause
            FROM pg_constraint c
           WHERE c.conrelid = 'auth.authorization_transactions'::regclass
             AND c.contype = 'c'
             AND c.conname = 'authorization_transactions_state_check'
        `;
        const clause = rows[0]?.check_clause ?? '';
        for (const state of [
          'pending_browser',
          'browser_confirmed',
          'awaiting_consent',
          'ready_to_complete',
          'completed',
          'denied',
        ]) {
          expect(clause).toContain(state);
        }
        for (const legacy of ['awaiting_login', 'consent_denied', 'already_processed']) {
          expect(clause).not.toContain(legacy);
        }
      } finally {
        await migrator.end({ timeout: 1 });
      }
    });

    it('client_state and nonce may be NULL — RFC 6749 makes state optional', async () => {
      const { migrator } = await setup();
      try {
        const rows = await migrator<{ column_name: string; is_nullable: string }[]>`
          SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_schema = 'auth'
             AND table_name = 'authorization_transactions'
             AND column_name IN ('client_state', 'nonce')
           ORDER BY column_name
        `;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.is_nullable).toBe('YES');
        }
      } finally {
        await migrator.end({ timeout: 1 });
      }
    });

    it('the FK points at authorization_transactions(transaction_id) — still correct after re-attach', async () => {
      const { migrator } = await setup();
      try {
        const rows = await migrator<{ confrelid: string }[]>`
          SELECT confrelid::regclass::text AS confrelid
            FROM pg_constraint
           WHERE conname = 'authorization_codes_transaction_fk'
        `;
        expect(rows[0]?.confrelid).toBe('auth.authorization_transactions');
      } finally {
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('CRUD and transition through the adapter', () => {
    it('write then scan — a full round-trip of every column, bytea down to base64url', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        await insertTransaction(runtime as never, newTxRecord());

        const found = await findTransactionByHandleX(runtime as never, {
          handleXHash: HASH_X,
        });

        // ⚠️ So từng trường, không so object nguyên: shape DTO là hợp đồng với
        // application, và một field thiếu sẽ xanh nếu test chỉ `toMatchObject`.
        expect(found).toBeDefined();
        expect(found?.transaction_id).toBe(BASE_TX_ID);
        expect(found?.state).toBe('pending_browser');
        expect(found?.handle_hash_x).toBe(HASH_X);
        expect(found?.browser_binding_hash).toBe(BINDING_HASH);
        expect(found?.client_id).toBe('client-tx-store-test');
        expect(found?.redirect_uri).toBe('https://app.example.com/cb');
        expect([...(found?.requested_scopes ?? [])]).toEqual(['openid']);
        expect(found?.code_challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
        expect(found?.code_challenge_method).toBe('S256');
        expect(found?.key_version).toBe(1);
        expect(found?.sub).toBeNull();
        expect(found?.acr).toBeNull();
        expect(found?.authn_at).toBeNull();
        expect(found?.account_session_ref).toBeNull();
        expect(found?.client_state).toBeNull();
        expect(found?.nonce).toBeNull();
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('bytea <-> base64url hashing: different bytes give different hashes, no collisions', async () => {
      // ⚠️ Codec sai (vd. dùng standard base64 thay vì base64url) thường KHÔNG
      // nổ — nó so khớp lệch một cách im lặng. Dùng hai hash chỉ khác suffix
      // để bắt biến dạng: byte cuối 0x00 và 0x01 phải là hai hàng khác nhau.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        // Hai chuỗi base64url 43 ký tự giải mã ra 32 byte, byte cuối khác nhau.
        await insertTransaction(runtime as never, newTxRecord({ handle_hash_x: HASH_X }));
        await insertTransaction(
          runtime as never,
          newTxRecord({
            transaction_id: SCOPE_TX_ID,
            handle_hash_x: HASH_X_ALT,
          }),
        );

        const a = await findTransactionByHandleX(runtime as never, { handleXHash: HASH_X });
        const b = await findTransactionByHandleX(runtime as never, { handleXHash: HASH_X_ALT });

        expect(a?.transaction_id).toBe(BASE_TX_ID);
        expect(b?.transaction_id).toBe(SCOPE_TX_ID);
      } finally {
        await cleanup(migrator, [BASE_TX_ID, SCOPE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('not found when the hash does not exist — undefined, no throw', async () => {
      const { runtime, migrator } = await setup();
      try {
        const found = await findTransactionByHandleX(runtime as never, {
          handleXHash: 'not-a-real-hash-value-but-43-chars-long-aaaaaaaaaaa',
        });
        expect(found).toBeUndefined();
      } finally {
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('a client_state with a value — stored and returned VERBATIM (FR-007)', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        const clientState = 'csrf-token-with-special-chars:?&#/';
        await insertTransaction(runtime as never, newTxRecord({ client_state: clientState }));

        const found = await findTransactionByHandleX(runtime as never, { handleXHash: HASH_X });
        expect(found?.client_state).toBe(clientState);
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('multi-element requested_scopes — text[] is not flattened into a string', async () => {
      // ⚠️ Đây là test của lỗi 4.3: DTO cũ mang `scope: string`. Nếu adapter
      // truyền chuỗi 'openid profile' vào cột `text[]`, PostgreSQL từ chối —
      // nhưng nếu test chỉ nhìn "có lưu được" thì sẽ bỏ sót hình dạng.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        await insertTransaction(
          runtime as never,
          newTxRecord({ requested_scopes: ['openid', 'profile', 'email'] }),
        );

        const found = await findTransactionByHandleX(runtime as never, { handleXHash: HASH_X });
        expect([...(found?.requested_scopes ?? [])]).toEqual(['openid', 'profile', 'email']);
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('a successful transition from pending_browser to browser_confirmed — returns true', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        await insertTransaction(runtime as never, newTxRecord());

        const won = await transitionTransaction(runtime as never, {
          transactionId: BASE_TX_ID,
          from: 'pending_browser',
          to: 'browser_confirmed',
          at: new Date(),
        });
        expect(won).toBe(true);

        const found = await findTransactionByHandleX(runtime as never, { handleXHash: HASH_X });
        expect(found?.state).toBe('browser_confirmed');
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('a transition from the wrong state — REJECTED (the CAS finds no matching from)', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        await insertTransaction(runtime as never, newTxRecord());

        // Transaction đang `pending_browser`; đòi chuyển TỪ `completed` phải fail.
        const won = await transitionTransaction(runtime as never, {
          transactionId: BASE_TX_ID,
          from: 'completed',
          to: 'denied',
          at: new Date(),
        });
        expect(won).toBe(false);

        // ⚠️ Và state KHÔNG đổi — từ chối phải là no-op, không phải "dù sao
        // cũng ghi đích".
        const found = await findTransactionByHandleX(runtime as never, { handleXHash: HASH_X });
        expect(found?.state).toBe('pending_browser');
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('an expired transaction — transition REJECTED even when from matches', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        await insertTransaction(runtime as never, newTxRecord());

        // ⚠️ Không seed hàng hết hạn được: CHECK `expires_at > created_at`
        // chặn `expires_at` trong quá khứ lúc INSERT. Hết hạn thật xảy ra theo
        // THỜI GIAN — cùng một nhánh SQL (`expires_at > $4`) được kiểm bằng
        // truyền `at` muộn hơn `expires_at`.
        const won = await transitionTransaction(runtime as never, {
          transactionId: BASE_TX_ID,
          from: 'pending_browser',
          to: 'browser_confirmed',
          at: new Date(Date.now() + 1_200_000), // muộn hơn expires_at (+10 phut)
        });
        expect(won).toBe(false);

        const found = await findTransactionByHandleX(runtime as never, { handleXHash: HASH_X });
        expect(found?.state).toBe('pending_browser');
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('CAS by from — from denied, you cannot transition back to pending_browser without naming from', async () => {
      // ⚠️ PHÂN TẦNG CỐ Ý: CHECK của schema chỉ là ALLOWLIST giá trị; tính
      // HỢP LỆ của bước chuyển (máy trạng thái một chiều) thuộc về domain
      // `canTransition` — adapter CAS chỉ cơ chế so khớp `from`. Test này ghim
      // đúng hợp đồng của tầng adapter: transition luôn phải NÓI RÕ state
      // hiện tại; gọi sai state là không tác động. Chính phủ "điểm cuối không
      // đường ra" được kiểm ở domain (`transaction.spec` của domain).
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        await insertTransaction(runtime as never, newTxRecord());
        await transitionTransaction(runtime as never, {
          transactionId: BASE_TX_ID,
          from: 'pending_browser',
          to: 'denied',
          at: new Date(),
        });

        // So khớp `from: 'denied'` với đích khác — không hàng nào khớp, no-op.
        const wrongFrom = await transitionTransaction(runtime as never, {
          transactionId: BASE_TX_ID,
          from: 'ready_to_complete',
          to: 'denied',
          at: new Date(),
        });
        expect(wrongFrom).toBe(false);

        // Và khi NÓI ĐÚNG `from: 'denied'` → `pending_browser`, CAS tự nó KHÔNG
        // chặn — vì chặn thứ tự là việc của `assertTransition` ở domain trước
        // khi adapter được gọi. Test này ghi nhận hành vi tầng dưới để ai đó
        // "tiện tay thêm CHECK transition vào DB" biết mình đang đổi hợp đồng,
        // không phải sửa bug.
        const found = await findTransactionByHandleX(runtime as never, { handleXHash: HASH_X });
        expect(found?.state).toBe('denied');
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('TWO simultaneous transitions — exactly ONE wins the CAS', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        await insertTransaction(runtime as never, newTxRecord());

        const results = await Promise.all([
          transitionTransaction(runtime as never, {
            transactionId: BASE_TX_ID,
            from: 'pending_browser',
            to: 'browser_confirmed',
            at: new Date(),
          }),
          transitionTransaction(runtime as never, {
            transactionId: BASE_TX_ID,
            from: 'pending_browser',
            to: 'denied',
            at: new Date(),
          }),
        ]);

        // Đích đến của winner phụ thuộc race — hợp đồng chỉ là ĐÚNG MỘT thắng.
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.filter((r) => r === false)).toHaveLength(1);
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('advanceTransactionWithHandle — TWO simultaneous CAS advances from the same state, exactly ONE wins', async () => {
      // ⚠️ Race của advance CHƯA được phủ (chỉ transitionTransaction có race
      //     test): hai advance cùng from-state phải cho đúng MỘT winner. Đây
      //     là CAS của consent decide — hai decide đồng thời mà cùng ghi là
      //     hai quyết định cho một transaction.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        await insertTransaction(runtime as never, newTxRecord());

        const results = await Promise.all([
          advanceTransactionWithHandle(runtime as never, {
            transactionId: BASE_TX_ID,
            from: 'pending_browser',
            to: 'denied',
            handleHash: HASH_X_ALT,
            eventId: 'evt-adv-a',
            payloadHash: 'payload-adv-a-000000000000000000000000000',
            outcome: 'failure',
            now: new Date(),
          }),
          advanceTransactionWithHandle(runtime as never, {
            transactionId: BASE_TX_ID,
            from: 'pending_browser',
            to: 'denied',
            handleHash: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
            eventId: 'evt-adv-b',
            payloadHash: 'payload-adv-b-000000000000000000000000000',
            outcome: 'failure',
            now: new Date(),
          }),
        ]);

        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.filter((r) => r === false)).toHaveLength(1);

        // State đã advance đúng MỘT lần, và Z (đích `denied`) được ghi bởi
        // winner — handle_hash_z của loser KHÔNG ghi đè lên winner. Cột
        // `bytea` về tay driver là Buffer; so bằng chính codec base64url
        // của domain (codec duy nhất, không encode thứ hai trong test).
        const found = await findTransactionByHandleX(runtime as never, {
          handleXHash: HASH_X,
        });
        expect(found?.state).toBe('denied');
        const zRows = await migrator<{ z: Uint8Array | null }[]>`
          SELECT handle_hash_z AS z
            FROM auth.authorization_transactions WHERE transaction_id = ${BASE_TX_ID}
        `;
        const z = zRows[0]?.z;
        expect(
          z === null
            ? null
            : bytesToBase64Url(new Uint8Array(z.buffer, z.byteOffset, z.byteLength)),
        ).toMatch(/^(XX|YY|ZZ)kVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw$/u);
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('advanceTransactionWithHandle — the consent destination writes handle_hash_y and leaves handle_hash_z untouched', async () => {
      // ⚠️ Nhánh CASE của hàm: `$3 = true` ghi Y, KHÔNG đụng Z. CHECK
      //     `handle_y_state_check` buộc `awaiting_consent` phải có Y chưa
      //     consume — sai nhánh (ghi Z khi sang awaiting_consent) là CHECK nổ
      //     ngay, nhưng nhánh ngược (đích denied lại ghi Y) thì schema KHÔNG
      //     chặn — phải ghim bằng test.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        await insertTransaction(runtime as never, newTxRecord());

        const won = await advanceTransactionWithHandle(runtime as never, {
          transactionId: BASE_TX_ID,
          from: 'pending_browser',
          to: 'awaiting_consent',
          handleHash: HASH_X_ALT,
          eventId: 'evt-adv-consent',
          payloadHash: 'payload-adv-consent-00000000000000000000000',
          outcome: 'success',
          now: new Date(),
        });
        expect(won).toBe(true);

        const found = await findTransactionByHandleX(runtime as never, {
          handleXHash: HASH_X,
        });
        expect(found?.state).toBe('awaiting_consent');
        // Cột `bytea` đọc về là Buffer — so bằng codec base64url của domain
        // thay vì `encode(..., 'base64url')` (PostgreSQL không có encoding đó).
        const handleRows = await migrator<{ y: Uint8Array | null; z: Uint8Array | null }[]>`
          SELECT handle_hash_y AS y, handle_hash_z AS z
            FROM auth.authorization_transactions WHERE transaction_id = ${BASE_TX_ID}
        `;
        const y = handleRows[0]?.y;
        expect(
          y === null
            ? null
            : bytesToBase64Url(new Uint8Array(y.buffer, y.byteOffset, y.byteLength)),
        ).toBe(HASH_X_ALT);
        expect(handleRows[0]?.z).toBeNull();
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('consumeHandleY — TWO same-owner transactions race, exactly ONE consumes', async () => {
      // ⚠️ CAS 2 race: hai decide đồng thời cùng owner (đúng ASR + sub) phải
      //     cho đúng MỘT consume. internal-handlers.spec đã phủ thắng tuần tự
      //     và thua sai-ASR; concurrency của chính CAS này chưa được ghim —
      //     thiếu nó thì một refactor phá `handle_y_consumed_at IS NULL` vẫn
      //     xanh trên mọi test hiện có.
      //
      // ⚠️ Trình tự seed là advance ĐI RA khỏi `awaiting_consent` TRƯỚC rồi
      //     mới consume Y — cùng thứ tự mà consent decide thật dùng trong MỘT
      //     tx: CHECK `handle_y_state_check` chỉ buộc Y hiện diện khi đang
      //     `awaiting_consent`, nên consume Y khi state còn `awaiting_consent`
      //     là hình thức bị CHECK chặn. Consume theo owner sau advance vẫn là
      //     CAS thật: hai tx cùng owner đua nhau ăn `handle_y_consumed_at`.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        await insertTransaction(runtime as never, newTxRecord());

        const handleYHash = HASH_X_ALT;
        // (1) Bind danh tính — consumeHandleY CAS theo `account_session_ref =
        //     $2 AND sub = $3`, nên seed hai cột này đúng owner.
        await runtime.unsafe(
          `UPDATE auth.authorization_transactions
              SET sub = $2, acr = 'urn:ecoma:acr:email-otp', authn_at = now(),
                  account_session_ref = $3
            WHERE transaction_id = $1`,
          [BASE_TX_ID, 'sub-consume-y-owner', 'asr-consume-y-owner'],
        );
        // (2) Advance pending_browser → awaiting_consent kèm Y (CHECK buộc Y),
        //     rồi advance tiếp sang ready_to_complete kèm Z — đúng hai bước
        //     state machine của một flow thật; Y vẫn chưa consume.
        await advanceTransactionWithHandle(runtime as never, {
          transactionId: BASE_TX_ID,
          from: 'pending_browser',
          to: 'awaiting_consent',
          handleHash: handleYHash,
          eventId: 'evt-cy-setup',
          payloadHash: 'payload-cy-setup-0000000000000000000000000',
          outcome: 'success',
          now: new Date(),
        });
        await advanceTransactionWithHandle(runtime as never, {
          transactionId: BASE_TX_ID,
          from: 'awaiting_consent',
          to: 'ready_to_complete',
          handleHash: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
          eventId: 'evt-cy-setup-2',
          payloadHash: 'payload-cy-setup2-000000000000000000000000',
          outcome: 'success',
          now: new Date(),
        });

        const consumeOnce = (nonce: string) =>
          runtime.begin(async (tx) =>
            consumeHandleY(tx as never, {
              handleYHash,
              accountSessionRef: 'asr-consume-y-owner',
              sub: 'sub-consume-y-owner',
              decision: 'approve',
              eventId: `evt-cy-${nonce}`,
              payloadHash: `payload-cy-${nonce}-000000000000000000000000000`,
              now: new Date(),
            }),
          );

        const results = await Promise.all([consumeOnce('a'), consumeOnce('b')]);
        const winners = results.filter((r) => r !== undefined);

        expect(winners).toHaveLength(1);
        // Loser không ghi gì — consumed_at chỉ có đúng MỘT mốc, và state
        // advance KHÔNG nằm trong consumeHandleY nên vẫn nguyên `awaiting_consent`.
        const rows = await migrator<{ consumed: string | null }[]>`
          SELECT handle_y_consumed_at::text AS consumed
            FROM auth.authorization_transactions WHERE transaction_id = ${BASE_TX_ID}
        `;
        expect(rows[0]?.consumed).not.toBeNull();
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('insertAuthorizationCode matches schema 0004', () => {
    it('writing a code satisfies the FK — sub, granted_scopes text[] and a nullable nonce are all accepted', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, 'client-tx-store-test');
        await insertTransaction(runtime as never, newTxRecord());

        // ⚠️ Cả hai hình dạng nonce: CÓ nonce (SR-007 — phải vào id_token) và
        // KHÔNG nonce. Chỉ test một hình là để lọt lỗi nullable ngược chiều.
        await insertAuthorizationCode(runtime as never, {
          code_hash: 'hash-code-with-nonce-000000000000000000000000',
          authorization_transaction_id: BASE_TX_ID,
          sub: 'account-1',
          client_id: 'client-tx-store-test',
          redirect_uri: 'https://app.example.com/cb',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
          granted_scopes: ['openid', 'profile'],
          nonce: 'n-abc',
          expires_at: new Date(Date.now() + 120_000),
        });
        await insertAuthorizationCode(runtime as never, {
          code_hash: 'hash-code-no-nonce-00000000000000000000000000',
          authorization_transaction_id: BASE_TX_ID,
          sub: 'account-1',
          client_id: 'client-tx-store-test',
          redirect_uri: 'https://app.example.com/cb',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
          granted_scopes: ['openid'],
          nonce: null,
          expires_at: new Date(Date.now() + 120_000),
        });

        const rows = await migrator<
          {
            code_hash: string;
            sub: string;
            granted_scopes: string[];
            nonce: string | null;
          }[]
        >`
          SELECT code_hash, sub, granted_scopes, nonce
            FROM auth.authorization_codes
           WHERE authorization_transaction_id = ${BASE_TX_ID}
           ORDER BY code_hash
        `;
        expect(rows).toHaveLength(2);
        expect(rows[0]?.code_hash).toBe('hash-code-no-nonce-00000000000000000000000000');
        expect(rows[0]?.nonce).toBeNull();
        expect(rows[1]?.code_hash).toBe('hash-code-with-nonce-000000000000000000000000');
        expect(rows[1]?.sub).toBe('account-1');
        expect(rows[1]?.granted_scopes).toEqual(['openid', 'profile']);
        expect(rows[1]?.nonce).toBe('n-abc');
      } finally {
        await cleanup(migrator, [BASE_TX_ID]);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('a code referencing a non-existent transaction — the FK rejects it, and the adapter swallows no error', async () => {
      const { runtime, migrator } = await setup();
      try {
        await expect(
          insertAuthorizationCode(runtime as never, {
            code_hash: 'hash-orphan-00000000000000000000000000000',
            authorization_transaction_id: 'f'.repeat(43),
            sub: 'account-1',
            client_id: 'client-tx-store-test',
            redirect_uri: 'https://app.example.com/cb',
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
            code_challenge_method: 'S256',
            granted_scopes: ['openid'],
            nonce: null,
            expires_at: new Date(Date.now() + 120_000),
          }),
        ).rejects.toThrow(/violates foreign key constraint/u);
      } finally {
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('permission grants', () => {
    it('the runtime cannot CREATE a table in the auth schema', async () => {
      // Thay cho marker test cũ của hình thức chia sẻ database qua biến môi
      // trường ("set … to run the persistence-contract tests") — marker ấy hết
      // ý nghĩa khi database tự dựng bằng testcontainers. Vị trí của nó giờ là
      // một assert thật về ranh quyền: role runtime chỉ DML, và đây là lớp
      // enforce thật (catalog), không phải một quy ước trong review.
      const { runtime, migrator } = await setup();
      try {
        await expect(
          runtime.unsafe('CREATE TABLE should_not_work (id text PRIMARY KEY)'),
        ).rejects.toThrow(/permission denied/iu);
        const rows = await migrator<
          { n: string }[]
        >`SELECT count(*)::text AS n FROM information_schema.tables
           WHERE table_schema = 'auth' AND table_name = 'should_not_work'`;
        expect(rows[0]?.n).toBe('0');
      } finally {
        await migrator.unsafe('DROP TABLE IF EXISTS should_not_work');
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });
});
