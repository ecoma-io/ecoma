import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postgres from 'postgres';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { PostgresClientConfig } from '@ecoma-io/auth-infrastructure';

import { PostgresAdapter } from '../../src/oidc/adapter';
import { startAuthDatabase, type AuthDatabase } from './harness';

/**
 * Spec cho PostgresAdapter (`src/oidc/adapter.ts`) — phần test không được phủ bởi
 * internal-handlers/fullflow: (1) cổng phát hành (issuance gate) điều phối ĐÚNG trên
 * PostgresAdapter — không chạy gate khi không cần, chạy khi cần, NÉM chặn ghi và
 * fail-closed khi payload thiếu định danh; (2) parity GRANTABLE_KINDS ↔ CHECK allowlist
 * của 0013 — hai bản khai rời nhau phải ghép bằng test, không thể ghép bằng mắt;
 * (3) consume() ghi CẢ cột `consumed_at` lẫn `payload->>'consumed'` (hai bản chép của
 * cùng sự kiện — chỉ test một trong hai là bỏ sót nửa còn lại).
 *
 * ⚠️ Vì sao PostgreSQL thật thay vì stub Queryable: phần lõi của adapter là SQL và
 * CHECK của schema — một stub trả mảng là schema thứ hai, xanh trên sai. Docker là
 * phụ thuộc cứng (fail-loud qua docker-probe của config integration — không skip).
 */

/** Container riêng của file này, dựng một lần trong `beforeAll`. */
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

function connectRuntime(): postgres.Sql {
  return postgres({
    ...base(),
    user: db.runtimeUser,
    password: db.runtimePassword,
    max: 5,
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

const IDS: string[] = [];

function trackId(id: string): string {
  IDS.push(id);
  return id;
}

async function cleanup(migrator: postgres.Sql): Promise<void> {
  if (IDS.length === 0) {
    return;
  }
  await migrator.unsafe('DELETE FROM auth.oidc_state WHERE id = ANY($1)', [IDS]);
  IDS.length = 0;
}

/**
 * Gate stub: ghi nhận MỖI lời gọi (kind không biết trước khi gọi — chỉ nhận tham số),
 * NÉM khi cấu hình `deny` — đúng hợp đồng "ném = chặn" của IssuanceGate.
 */
function stubGate(
  overrides: {
    readonly deny?: boolean;
  } = {},
) {
  const calls: {
    readonly accountId: string;
    readonly clientId: string;
    readonly grantId: string | null;
  }[] = [];
  return {
    calls,
    assertIssuable: async (params: {
      readonly accountId: string;
      readonly clientId: string;
      readonly grantId: string | null;
    }): Promise<void> => {
      calls.push(params);
      if (overrides.deny === true) {
        throw new Error('issuance gate stub: denied');
      }
    },
  };
}

describe('PostgresAdapter', () => {
  /**
   * Config adapter dùng — issue #289: adapter nhận CONFIG (giá trị thuần) và tự mở
   * client cho MỖI thao tác qua `withPostgresClient`. Connection string dựng lại từ
   * options đã parse của client pool testcontainers (host đầu + port + credential +
   * database) — đủ cho client một-lần của adapter, cùng credential runtime thật.
   */
  function adapterClientConfig(): PostgresClientConfig {
    const o = runtime.options;
    const auth =
      o.pass === null || o.pass === undefined
        ? String(o.user)
        : `${String(o.user)}:${String(o.pass)}`;
    const connectionString = `postgres://${auth}@${String(o.host[0])}:${String(o.port[0])}/${o.database}`;
    return { hyperdrive: { connectionString } };
  }

  const PAYLOAD = {
    accountId: 'sub-adapter-spec-00000000000000000000000000',
    clientId: 'client-adapter-spec',
    grantId: 'grant-adapter-spec-0000000000000000000000',
  };

  let runtime: postgres.Sql;
  let migrator: postgres.Sql;

  beforeAll(async () => {
    // Schema đã sẵn sàng bên trong `startAuthDatabase` (migration chạy một lần
    // lúc container lên, bằng credential migrator thật).
    db = await startAuthDatabase();
    runtime = connectRuntime();
    migrator = connectMigrator();
  }, 180_000);

  afterAll(async () => {
    await runtime?.end({ timeout: 1 });
    await migrator?.end({ timeout: 1 });
  });

  afterEach(async () => {
    await cleanup(migrator);
  });

  describe('issuance gate dispatch', () => {
    it('runs the gate before writing for every grantable kind (AuthorizationCode, AccessToken, RefreshToken)', async () => {
      for (const kind of ['AuthorizationCode', 'AccessToken', 'RefreshToken']) {
        const gate = stubGate();
        const adapter = new PostgresAdapter(kind, adapterClientConfig(), gate);
        await adapter.upsert(trackId(`adp-${kind}-ok`), PAYLOAD, 600);
        expect(gate.calls).toHaveLength(1);
        expect(gate.calls[0]).toEqual({
          accountId: PAYLOAD.accountId,
          clientId: PAYLOAD.clientId,
          grantId: PAYLOAD.grantId,
        });
        const rows = await runtime<{ id: string }[]>`
          SELECT id FROM auth.oidc_state WHERE kind = ${kind} AND id = ${`adp-${kind}-ok`}
        `;
        expect(rows).toHaveLength(1);
      }
    });

    it('does not run the gate for non-grantable kinds (Session, Interaction, Grant, ReplayDetection)', async () => {
      for (const kind of ['Session', 'Interaction', 'Grant', 'ReplayDetection']) {
        const gate = stubGate();
        const adapter = new PostgresAdapter(kind, adapterClientConfig(), gate);
        const payload = kind === 'Session' ? { ...PAYLOAD, uid: `uid-${kind}` } : { ...PAYLOAD };
        await adapter.upsert(trackId(`adp-ng-${kind}`), payload, 600);
        expect(gate.calls).toHaveLength(0);
      }
    });

    it('a gate throw blocks the write — no row lands in oidc_state (fail-closed)', async () => {
      const gate = stubGate({ deny: true });
      const adapter = new PostgresAdapter('RefreshToken', adapterClientConfig(), gate);
      await expect(adapter.upsert(trackId('adp-rt-deny'), PAYLOAD, 600)).rejects.toThrow('denied');
      const rows = await runtime<{ id: string }[]>`
        SELECT id FROM auth.oidc_state WHERE id = ${'adp-rt-deny'}
      `;
      expect(rows).toHaveLength(0);
    });

    it('missing accountId or clientId in a grantable payload throws BEFORE any write (fail-closed on unknown subject)', async () => {
      for (const payload of [
        { clientId: PAYLOAD.clientId, grantId: PAYLOAD.grantId },
        { accountId: PAYLOAD.accountId, grantId: PAYLOAD.grantId },
      ]) {
        const gate = stubGate();
        const adapter = new PostgresAdapter('AuthorizationCode', adapterClientConfig(), gate);
        await expect(adapter.upsert(trackId('adp-ac-noid'), payload, 600)).rejects.toThrow(
          'thieu accountId/clientId',
        );
        expect(gate.calls).toHaveLength(0);
        const rows = await runtime<{ id: string }[]>`
          SELECT id FROM auth.oidc_state WHERE id = ${'adp-ac-noid'}
        `;
        expect(rows).toHaveLength(0);
      }
    });

    it('skips the gate entirely when no gate is wired (composition-root absent) — rows still land', async () => {
      const adapter = new PostgresAdapter('RefreshToken', adapterClientConfig());
      await adapter.upsert(trackId('adp-rt-nogate'), PAYLOAD, 600);
      const rows = await runtime<{ id: string }[]>`
        SELECT id FROM auth.oidc_state WHERE id = ${'adp-rt-nogate'}
      `;
      expect(rows).toHaveLength(1);
    });
  });

  describe('consume() dual-write', () => {
    it('consume() writes BOTH the consumed_at column and payload.consumed — provider-visible consume-once', async () => {
      const adapter = new PostgresAdapter('RefreshToken', adapterClientConfig());
      const id = trackId('adp-rt-consume');
      await adapter.upsert(id, PAYLOAD, 600);
      await adapter.consume(id);
      const rows = await runtime<{ consumed_at: Date | null; consumed_payload: string | null }[]>`
        SELECT consumed_at, payload->>'consumed' AS consumed_payload
          FROM auth.oidc_state WHERE kind = 'RefreshToken' AND id = ${id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.consumed_at).not.toBeNull();
      expect(rows[0]?.consumed_payload).not.toBeNull();
      // Provider đọc this.consumed từ payload (refresh_token.js:52-54) — assert cả
      // hai nửa vì chỉ ghi cột mà thiếu payload thì token vẫn dùng được trong im lặng.
      expect(Number(rows[0]?.consumed_payload)).toBeGreaterThan(0);
    });

    it('consume() on a non-consumable kind throws without writing', async () => {
      const adapter = new PostgresAdapter('Session', adapterClientConfig());
      await expect(adapter.consume('adp-session-x')).rejects.toThrow('khong ap dung');
      const rows = await runtime<{ id: string }[]>`
        SELECT id FROM auth.oidc_state WHERE id = ${'adp-session-x'}
      `;
      expect(rows).toHaveLength(0);
    });
  });

  describe('schema parity — two declarations must not drift', () => {
    it('GRANTABLE_KINDS matches the 0013 grant_id CHECK allowlist', async () => {
      // Đọc CHECK constraint TỪ schema thật thay vì chép text của file migration:
      // một migration sau này sửa CHECK mà spec vẫn đọc file 0013 cũ thì parity
      // test sẽ xanh trên schema lệch. `pg_constraint` là bản khai đang chạy.
      const rows = await runtime<{ pg_get_constraintdef: string }[]>`
        SELECT pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conname = 'oidc_state_grant_kind_check'
      `;
      expect(rows).toHaveLength(1);
      const def = rows[0]?.pg_get_constraintdef ?? '';
      // Trích tập kind — pg_get_constraintdef chuẩn hoá `IN (...)` thành
      // `= ANY (ARRAY[...])`, parser nhận CẢ HAI hình dạng (một migration sau này
      // có thể viết lại CHECK theo chữ IN và parity test vẫn đọc đúng).
      const matchAny = /kind = ANY \(ARRAY\[([^\]]*)\]\)/u.exec(def);
      const matchIn = /kind IN \(([^)]*)\)/u.exec(def);
      const match = matchAny ?? matchIn;
      expect(match).not.toBeNull();
      const schemaKinds = (match?.[1] ?? '')
        .split(',')
        .map((s) =>
          s
            .trim()
            .replaceAll("'", '')
            .replace(/::text$/u, ''),
        )
        .toSorted();
      // GRANTABLE_KINDS là private — kiểm qua HÀNH VI (gate dispatch test ở trên
      // đã phủ từng kind), còn ở đây ghép text file nguồn với tập schema.
      const source = readFileSync(join(import.meta.dirname, '../../src/oidc/adapter.ts'), 'utf8');
      const block = /const GRANTABLE_KINDS[^=]*= new Set\(\[([^\]]*)\]\)/u.exec(source);
      expect(block).not.toBeNull();
      const sourceKinds = (block?.[1] ?? '')
        .split(',')
        .map((s) => s.trim().replaceAll("'", ''))
        .filter((s) => s.length > 0)
        .toSorted();
      expect(sourceKinds).toEqual(['AccessToken', 'AuthorizationCode', 'RefreshToken']);
      // ⚠️ Schema cho phép cả DeviceCode (CHECK không biết feature đã tắt); tập của
      // adapter phải là TẬP CON đúng của schema, sai lệch ở đây là bug điều phối.
      for (const kind of sourceKinds) {
        expect(schemaKinds).toContain(kind);
      }
    });
  });
});
