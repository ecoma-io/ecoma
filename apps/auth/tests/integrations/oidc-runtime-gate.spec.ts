import postgres from 'postgres';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { PostgresClientLike } from '@ecoma-io/auth-infrastructure';

import { PostgresAdapter } from '../../src/oidc/adapter';
import { createProvider } from '../../src/oidc/provider';
import { createIssuanceGate } from '../../src/oidc/runtime';
import { loadAuthConfig, type AuthEnv } from '../../src/config';
import { exportPKCS8, generateKeyPair } from 'jose';
import { startAuthDatabase, type AuthDatabase } from './harness';

/**
 * Anchor test cho đường gate cấp phát PRODUCTION: composition `oidc/runtime.ts`
 * nối phần phụ thuộc thật của isolate vào factory thuần
 * `createIssuanceGateFromDeps` (`issuance-gate.ts`) rồi truyền thành option
 * `issuanceGate` của `createProvider`. Test này đi đúng đường đó (cùng factory
 * `createProvider`, cùng điểm nối `createIssuanceGate(env, config, client)`) và
 * ghim ba điều mà đường production không được trôi:
 *
 *   1. Gate là factory DÙNG CHUNG từ `issuance-gate.ts`, không còn bản inline:
 *      hành vi đã bị test ở `mid-flow-state-change.spec` và `issuance-gate`
 *      unit bây giờ áp lên chính đường composition — sót một bản inline nữa
 *      (dual path drift) là test này không còn nói cùng một hàm với adapter.
 *   2. Nguồn `checkStatus` của factory là `AccountClient.checkStatus` THẬT
 *      (`GET /internal/account/status`, envelope HMAC thật) — binding service
 *      là chỗ test thay thế duy nhất; không stub nào trả trạng thái cho factory.
 *   3. Gate mà factory adapter nhận là gate của composition: một upsert với
 *      account suspended phải NÉM TRƯỚC KHI ghi — không hàng `oidc_state` nào
 *      xuất hiện sau khi throw (fail-closed đúng nghĩa, đo được trên bảng thật).
 *
 * ⚠️ PostgreSQL thật (testcontainers): khẳng định "không hàng nào xuống
 * `oidc_state`" chỉ có ý nghĩa trên bảng và CHECK thật. Docker là phụ thuộc
 * cứng (fail-loud qua docker-probe của config integration — không skip).
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

const CLIENT_ID = 'client-runtime-gate-spec';
const CLIENT_REDIRECT = 'https://rp.example.com/cb';

/** Env căn bản (chưa mang `ACCOUNT_SERVICE`) — mỗi bài tự gắn status mong muốn. */
const BASE_ENV: Omit<AuthEnv, 'ACCOUNT_SERVICE'> = {
  HYPERDRIVE: { connectionString: 'filled-in-beforeAll' },
  AUTH_SIGNING_KEY: 'filled-in-beforeAll',
  AUTH_SIGNING_KEY_ID: 'kid-runtime-gate-spec',
  AUTH_HANDLE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  AUTH_HANDLE_KEY_VERSION: '1',
  AUTH_INTERNAL_SECRET: 'runtime-gate-spec-internal-secret',
  AUTH_ISSUER: 'https://runtime-gate-spec.invalid',
  AUTH_AUDIENCE: 'https://api.ecoma.io/runtime-gate-spec',
  AUTH_COOKIE_KEYS: 'runtime-gate-cookie-key-1,runtime-gate-cookie-key-2',
  AUTH_ACCOUNT_BASE_URL: 'https://account.ecoma.io',
};

/**
 * Service binding giả: status do test quyết định; `AccountClient` bên dưới là
 * THẬT — nó ký HMAC từng request và validate response bằng hợp đồng
 * `@ecoma-io/account-contracts` (`isAccountStatusResponseValue`). Binding là
 * chỗ thay thế duy nhất: cổng thật của isolate vào Account service.
 */
function envWithStatus(status: string): AuthEnv {
  return {
    ...BASE_ENV,
    ACCOUNT_SERVICE: {
      fetch: async () => new Response(JSON.stringify({ status }), { status: 200 }),
    } as unknown as AuthEnv['ACCOUNT_SERVICE'],
  };
}

const PAYLOAD = {
  accountId: 'sub-runtime-gate-00000000000000000000000000000',
  clientId: CLIENT_ID,
  // `null` — adapter truyền nguyên và gate bỏ nhánh `findActiveGrant` khi
  // grantId null; chuỗi giả thì cast `::uuid` chết trước khi tới gate.
  grantId: null,
};

describe('runtime composition — the production gate path via createIssuanceGateFromDeps', () => {
  let runtime: postgres.Sql;
  let migrator: postgres.Sql;
  let pem: string;

  beforeAll(async () => {
    // Schema đã sẵn sàng bên trong `startAuthDatabase` (migration chạy một
    // lần lúc container lên, bằng credential migrator thật).
    db = await startAuthDatabase();
    runtime = connectRuntime();
    migrator = connectMigrator();
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    pem = await exportPKCS8(privateKey);
    // Gán connection string thật sau khi container lên — pool PostgresClient
    // của `loadAuthConfig` dùng nó như production dùng Hyperdrive.
    BASE_ENV.HYPERDRIVE = {
      connectionString: `postgres://${db.runtimeUser}:${db.runtimePassword}@${db.host}:${db.port}/${db.database}`,
    };
    BASE_ENV.AUTH_SIGNING_KEY = pem;
    // Client public cho provider thật — createProvider ném sớm khi không có
    // client nào trong `auth.oauth_clients`.
    await migrator`
        INSERT INTO auth.oauth_clients (client_id, client_name, client_type, allowed_scopes)
        VALUES (${CLIENT_ID}, 'runtime gate spec client', 'public', ARRAY['openid']::text[])
        ON CONFLICT (client_id) DO NOTHING
      `;
    await migrator`
        INSERT INTO auth.client_redirect_uris (client_id, redirect_uri)
        VALUES (${CLIENT_ID}, ${CLIENT_REDIRECT})
        ON CONFLICT DO NOTHING
      `;
  }, 180_000);

  afterAll(async () => {
    await runtime?.end({ timeout: 1 });
    await migrator?.end({ timeout: 1 });
    await db?.stop();
  });

  afterEach(async () => {
    await cleanup(migrator);
  });

  it('the composition gate mounts on the real provider and blocks issuance for a suspended account before any oidc_state write', async () => {
    // Config + gate dựng từ composition — chính lời gọi mà `buildRuntime` thực.
    const config = await loadAuthConfig(envWithStatus('suspended'));
    const postgresClientConfig = { hyperdrive: config.hyperdrive };
    const gate = createIssuanceGate(envWithStatus('suspended'), config, postgresClientConfig);

    // Provider thật với gate của composition — instance này khẳng định
    // option `issuanceGate` đi đúng vào adapter factory (`createAdapterFactory`).
    const provider = await createProvider({
      config,
      postgresClientConfig,
      staticClientsLoader: runtime as unknown as PostgresClientLike,
      signingPem: pem,
      issuanceGate: gate,
    });
    expect(provider).toBeDefined();

    // `PostgresAdapter(kind, config, gate)` với CÙNG gate composition là
    // cách adapter factory dựng adapter của provider — gọi hạt nhân "gate
    // chặn trước khi ghi" trực tiếp, không cần đi toàn bộ protocol
    // (protocol-level phủ bởi `oidc-fullflow.spec` qua chính pipeline này).
    const adapter = new PostgresAdapter('AuthorizationCode', postgresClientConfig, gate);

    // Gate NÉM ngay trên checkStatus: AccountClient thật nhận 'suspended' từ
    // binding, `allowsIssuance` từ chối, factory deny-audit rồi throw.
    await expect(adapter.upsert(trackId('rgt-ac-deny-suspended'), PAYLOAD, 600)).rejects.toThrow(
      'account status',
    );

    // ⚠️ Throw xảy ra TRƯỚC khi ghi: không một hàng `oidc_state` nào mang id
    // này — fail-closed đo được trên bảng thật, không phải trên một stub.
    const rows = await runtime<{ id: string }[]>`
        SELECT id FROM auth.oidc_state WHERE id = ${'rgt-ac-deny-suspended'}
      `;
    expect(rows).toHaveLength(0);

    // ⚠️ Audit hàng chặn VẪN được ghi qua swap (fire-and-forget riêng của
    // `denyAudit` trong factory): `token_issue_denied` với
    // `reason: 'account_status'` — chi tiết jsonb đi qua driver dạng
    // double-encoded string, unwrap một lần trước khi đọc.
    const denyRows = await runtime<{ details: unknown; outcome: string | null }[]>`
        SELECT details AS details, outcome
          FROM auth.authorization_audit_events
         WHERE subject_ref = ${PAYLOAD.accountId}
           AND event_type = 'token_issue_denied'
         ORDER BY occurred_at DESC
         LIMIT 1
      `;
    const denialPayload = JSON.parse(denyRows[0]?.details as unknown as string) as {
      reason: string;
    };
    expect(denialPayload.reason).toBe('account_status');
    expect(denyRows[0]?.outcome).toBe('denied');
  });

  it('the composition gate lets an active-account issuance through and writes the oidc_state row on the real path', async () => {
    // Suspend chỉ là 1 nhánh; nhánh còn lại ghim "cấp vẫn sống" khi account
    // active — chính sức sống mà composition phải giữ nguyên sau swap.
    const config = await loadAuthConfig(envWithStatus('active'));
    const postgresClientConfig = { hyperdrive: config.hyperdrive };
    const gate = createIssuanceGate(envWithStatus('active'), config, postgresClientConfig);
    const provider = await createProvider({
      config,
      postgresClientConfig,
      staticClientsLoader: runtime as unknown as PostgresClientLike,
      signingPem: pem,
      issuanceGate: gate,
    });
    expect(provider).toBeDefined();

    const adapter = new PostgresAdapter('AuthorizationCode', postgresClientConfig, gate);

    // Gate CHẤP NHẬN (không throw) — và vì nó đi qua `findActiveGrant` +
    // `checkRevocationAtIssuance` rồi mới tới ghi, đường này cũng tự xác nhận
    // các SELECT của factory chạy được bằng credential runtime.
    const id = trackId('rgt-ac-issue-ok');
    await expect(adapter.upsert(id, PAYLOAD, 600)).resolves.toBeUndefined();

    const rows = await runtime<{ id: string }[]>`
        SELECT id FROM auth.oidc_state WHERE id = ${id}
      `;
    expect(rows).toHaveLength(1);

    // Bằng chứng cấp: audit `token_issued` nằm lại ở bảng append-only —
    // fire-and-forget trong factory, đọc lại cho khớp đường production.
    const issuedRows = await runtime<{ count: string }[]>`
        SELECT count(*)::text AS count FROM auth.authorization_audit_events
         WHERE subject_ref = ${PAYLOAD.accountId}
           AND event_type = 'token_issued'
      `;
    expect(issuedRows[0]?.count).toBe('1');
  });
});
