/**
 * Bootstrap OAuth client của backoffice trên PostgreSQL thật (bước 7 của bảng
 * §3.2 — `02-delivery.md`; đặc tả dữ liệu `docs/applications/auth/03-operations.md`
 * §3.2b; #352).
 *
 * Gọi đúng core {@link bootstrapOAuthClient} mà CLI chạy (runner-canonical,
 * không viết vòng provisioning riêng) và kiểm tra trạng thái database sau mỗi
 * lần chạy. Bootstrap chạy bằng credential **migrator** (surface (b) của
 * ADR-0020 Quyết định 3 — CLI offline của service sở hữu); các trạng thái lệch
 * (disabled, confidential) được dựng trước bằng cùng credential — migration
 * `0001` giữ mọi ràng buộc hình dạng qua CHECK, nên trạng thái dựng được luôn
 * là trạng thái schema hợp lệ mà bootstrap phải từ chối.
 *
 * ⚠️ Suite cần Docker: probe hỏng làm `globalSetup` throw và cả run đỏ
 * (fail-loud, 06-testing.md §6) — skip với exit 0 không phải kết quả được
 * chấp nhận.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from 'pg';

import {
  assertBootstrapDatabase,
  AUTH_DATABASE,
  BOOTSTRAP_ALLOWED_SCOPES_ENV,
  BOOTSTRAP_CLIENT_ID_ENV,
  BOOTSTRAP_CLIENT_NAME_ENV,
  BOOTSTRAP_REDIRECT_URIS_ENV,
  bootstrapOAuthClient,
  parseBootstrapEnv,
  type BootstrapOAuthClientInput,
} from '../../db/bootstrap-oauth-clients.mts';
import { startAuthDatabase, type AuthDatabase } from '../integrations/harness.ts';

const CLIENT_ID = 'ecoma-backoffice-staging';
const CLIENT_NAME = 'Backoffice (staging)';
const SCOPES = ['openid', 'offline_access'];
const URI_A = 'https://office-cand.ecoma.io.vn/api/auth/callback';
const URI_B = 'https://office-alt-cand.ecoma.io.vn/api/auth/callback';

/** Đầu vào bootstrap chuẩn của suite — tham số thay được từng test. */
function bootstrapInput(overrides: Partial<BootstrapOAuthClientInput> = {}) {
  return {
    clientId: CLIENT_ID,
    clientName: CLIENT_NAME,
    allowedScopes: SCOPES,
    redirectUris: [URI_A],
    ...overrides,
  } satisfies BootstrapOAuthClientInput;
}

interface ClientRow {
  client_id: string;
  client_name: string;
  client_type: string;
  client_secret_hash: string | null;
  status: string;
  allowed_scopes: string[];
  created_at: Date;
}

async function queryClientRows(db: AuthDatabase): Promise<ClientRow[]> {
  const client = await migratorClient(db);
  try {
    const { rows } = await client.query<ClientRow>(
      `SELECT client_id, client_name, client_type, client_secret_hash, status, allowed_scopes, created_at
         FROM auth.oauth_clients ORDER BY client_id`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

async function queryRedirectUris(db: AuthDatabase): Promise<string[]> {
  const client = await migratorClient(db);
  try {
    const { rows } = await client.query<{ redirect_uri: string }>(
      `SELECT redirect_uri FROM auth.client_redirect_uris ORDER BY redirect_uri`,
    );
    return rows.map((row) => row.redirect_uri);
  } finally {
    await client.end();
  }
}

/** Connection migrator mới mỗi lần — credential mà CLI sản phẩm dùng. */
async function migratorClient(db: AuthDatabase): Promise<Client> {
  const client = new Client({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.migratorUser,
    password: db.migratorPassword,
    application_name: 'ecoma-auth-bootstrap-oauth-clients-itest',
  });
  await client.connect();
  return client;
}

/**
 * Một lần bootstrap bọc trong đúng transaction mà CLI thực hiện
 * (BEGIN → bootstrap → COMMIT, ROLLBACK khi lỗi), trên credential migrator thật.
 */
async function runBootstrapped(
  db: AuthDatabase,
  input: BootstrapOAuthClientInput,
): Promise<Awaited<ReturnType<typeof bootstrapOAuthClient>>> {
  const client = await migratorClient(db);
  try {
    await client.query('BEGIN');
    try {
      const result = await bootstrapOAuthClient(client, input);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
  }
}

/** Dọn cả hai bảng giữa các test — test này phải tự đứng vững khi chạy đơn lẻ. */
async function resetTables(db: AuthDatabase): Promise<void> {
  const client = await migratorClient(db);
  try {
    // DELETE thay TRUNCATE: các bảng của migration sau (grants, codes, ...)
    // tham chiếu oauth_clients qua FK, và TRUNCATE bị chặn bởi FK kể cả khi
    // bảng tham chiếu rỗng; DELETE theo thứ tự con → cha là đủ cho container
    // riêng của spec này.
    await client.query('DELETE FROM auth.client_redirect_uris');
    await client.query('DELETE FROM auth.oauth_clients');
  } finally {
    await client.end();
  }
}

describe(`bootstrap of the backoffice OAuth client on ${AUTH_DATABASE}`, () => {
  let db: AuthDatabase;

  beforeAll(async () => {
    db = await startAuthDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('creates the active public client with its redirect URIs on the first run', async () => {
    await resetTables(db);

    const result = await runBootstrapped(db, bootstrapInput());
    expect(result.alreadyExisted).toBe(false);
    expect(result.clientId).toBe(CLIENT_ID);
    expect(result.scopesUpdated).toBe(false);
    expect(result.addedRedirectUris).toEqual([URI_A]);

    // Đúng một hàng client: public, active, không secret, đúng scope ceiling.
    const rows = await queryClientRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.client_id).toBe(CLIENT_ID);
    expect(rows[0]?.client_name).toBe(CLIENT_NAME);
    expect(rows[0]?.client_type).toBe('public');
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.client_secret_hash).toBeNull();
    expect(rows[0]?.allowed_scopes).toEqual(SCOPES);

    // Đúng tập URI kỳ vọng, exact string.
    expect(await queryRedirectUris(db)).toEqual([URI_A]);
  });

  it('is a safe no-op on a re-run with the same configuration', async () => {
    await resetTables(db);
    const first = await runBootstrapped(db, bootstrapInput());
    expect(first.alreadyExisted).toBe(false);

    const before = await queryClientRows(db);
    expect(before).toHaveLength(1);
    const beforeCreatedAt = before[0]?.created_at;

    const second = await runBootstrapped(db, bootstrapInput());
    expect(second.alreadyExisted).toBe(true);
    expect(second.scopesUpdated).toBe(false);
    expect(second.addedRedirectUris).toEqual([]);

    // Không hàng thứ hai, không URI trùng, created_at không đổi (no-op không
    // cập nhật hàng đã có — §3.2b: các cột khác của hàng đã có giữ nguyên).
    const after = await queryClientRows(db);
    expect(after).toHaveLength(1);
    expect(after[0]?.created_at.getTime()).toBe(beforeCreatedAt?.getTime());
    expect(after[0]?.client_name).toBe(CLIENT_NAME);
    expect(await queryRedirectUris(db)).toEqual([URI_A]);
  });

  it('refreshes only the scope ceiling on a re-run with a changed scope set', async () => {
    await resetTables(db);
    await runBootstrapped(db, bootstrapInput());

    const result = await runBootstrapped(
      db,
      bootstrapInput({ allowedScopes: ['openid', 'profile', 'offline_access'] }),
    );
    expect(result.alreadyExisted).toBe(true);
    expect(result.scopesUpdated).toBe(true);

    // Ceiling được refresh; tên hiển thị và URI giữ nguyên (DO UPDATE chỉ chạm
    // allowed_scopes — §3.2b mệnh đề 1).
    const rows = await queryClientRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.allowed_scopes).toEqual(['openid', 'profile', 'offline_access']);
    expect(rows[0]?.client_name).toBe(CLIENT_NAME);
    expect(await queryRedirectUris(db)).toEqual([URI_A]);
  });

  it('fails closed and rolls back when the stored URI set carries a URI no longer configured', async () => {
    await resetTables(db);
    await runBootstrapped(db, bootstrapInput());

    // Operator đổi callback sang URI mới; URI cũ vẫn nằm trong bảng vì
    // bootstrap không xoá hàng — lần chạy sau phải TỪ CHỐI thay vì âm thầm
    // giữ URI chết ("URI cũ đã gỡ không còn" — verify của dòng 7 §3.2).
    await expect(runBootstrapped(db, bootstrapInput({ redirectUris: [URI_B] }))).rejects.toThrow(
      /still carries redirect URI|remove the stale URI/u,
    );

    // Rollback toàn bộ: URI mới không được thêm, URI cũ vẫn còn nguyên, hàng
    // client không đổi.
    expect(await queryRedirectUris(db)).toEqual([URI_A]);
    const rows = await queryClientRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.allowed_scopes).toEqual(SCOPES);
  });

  it('converges to the exact configured URI set after the operator removes the stale URI', async () => {
    await resetTables(db);
    await runBootstrapped(db, bootstrapInput());

    // Gỡ URI cũ là hành động forward-fix của operator (bootstrap không tự xoá).
    const operator = await migratorClient(db);
    try {
      await operator.query(`DELETE FROM auth.client_redirect_uris WHERE redirect_uri = $1`, [
        URI_A,
      ]);
    } finally {
      await operator.end();
    }

    const result = await runBootstrapped(db, bootstrapInput({ redirectUris: [URI_B] }));
    expect(result.alreadyExisted).toBe(true);
    expect(result.addedRedirectUris).toEqual([URI_B]);
    expect(result.verifiedRedirectUris).toEqual([URI_B]);
    expect(await queryRedirectUris(db)).toEqual([URI_B]);
  });

  it('refuses to resurrect a disabled client', async () => {
    await resetTables(db);
    await runBootstrapped(db, bootstrapInput());

    // disabled là quyết định của operator (FR-003 chặn cả authorize lẫn token):
    // bootstrap không bao giờ bật lại.
    const operator = await migratorClient(db);
    try {
      await operator.query(`UPDATE auth.oauth_clients SET status = 'disabled'`);
    } finally {
      await operator.end();
    }

    await expect(runBootstrapped(db, bootstrapInput())).rejects.toThrow(/refusing to resurrect/u);
    const rows = await queryClientRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('disabled');
  });

  it('fails closed when the client_id is registered as a confidential client', async () => {
    await resetTables(db);

    // Dựng trạng thái lệch có chủ đích: cùng client_id nhưng confidential và
    // mang secret hash — hợp lệ theo CHECK secret parity của 0001, nhưng không
    // phải hình dạng client bootstrap được phép chạm.
    const operator = await migratorClient(db);
    try {
      await operator.query(
        `INSERT INTO auth.oauth_clients (client_id, client_name, client_type, client_secret_hash)
         VALUES ($1, $2, 'confidential', $3)`,
        [CLIENT_ID, CLIENT_NAME, 'deadbeef'],
      );
    } finally {
      await operator.end();
    }

    await expect(runBootstrapped(db, bootstrapInput())).rejects.toThrow(
      /client_type confidential|never converts/u,
    );

    // Hàng confidential không bị đổi type, không URI nào được thêm.
    const rows = await queryClientRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.client_type).toBe('confidential');
    expect(await queryRedirectUris(db)).toEqual([]);
  });

  it('fails closed when a public client row carries a client_secret_hash', async () => {
    await resetTables(db);

    // CHECK `oauth_clients_secret_parity_check` cấm trạng thái này qua SQL hợp
    // lệ, nên guard của bootstrap là phòng thủ sâu cho schema đã trôi (ví dụ
    // một migration sau nới lỏng parity): bỏ CHECK, dựng hàng lệch, thêm lại
    // NOT VALID — các ghi tiếp theo vẫn bị ràng buộc như thường.
    const diverger = await migratorClient(db);
    try {
      await diverger.query(
        'ALTER TABLE auth.oauth_clients DROP CONSTRAINT oauth_clients_secret_parity_check',
      );
      await diverger.query(
        `INSERT INTO auth.oauth_clients (client_id, client_name, client_type, client_secret_hash)
         VALUES ($1, $2, 'public', $3)`,
        [CLIENT_ID, CLIENT_NAME, 'deadbeef'],
      );
      await diverger.query(
        `ALTER TABLE auth.oauth_clients ADD CONSTRAINT oauth_clients_secret_parity_check
         CHECK ((client_type = 'public' AND client_secret_hash IS NULL)
                OR (client_type = 'confidential' AND client_secret_hash IS NOT NULL))
         NOT VALID`,
      );
    } finally {
      await diverger.end();
    }

    // Guard phải chặn trước khi một câu ghi nào chạy: không URI được thêm.
    await expect(runBootstrapped(db, bootstrapInput())).rejects.toThrow(
      /carries a client_secret_hash/u,
    );
    expect(await queryRedirectUris(db)).toEqual([]);
    const rows = await queryClientRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.client_type).toBe('public');
    expect(rows[0]?.client_secret_hash).toBe('deadbeef');
  });

  it('rejects an invalid input shape without touching the database', async () => {
    const fakeClient = { query: async () => ({ rows: [] }) } as unknown as Client;
    await expect(
      bootstrapOAuthClient(fakeClient, bootstrapInput({ clientId: '' })),
    ).rejects.toThrow(/client id is required/u);
    await expect(
      bootstrapOAuthClient(fakeClient, bootstrapInput({ clientId: 'has space' })),
    ).rejects.toThrow(/client id is required/u);
    await expect(
      bootstrapOAuthClient(fakeClient, bootstrapInput({ clientName: 'two\nlines' })),
    ).rejects.toThrow(/client name is required/u);
    await expect(
      bootstrapOAuthClient(fakeClient, bootstrapInput({ allowedScopes: [] })),
    ).rejects.toThrow(/allowed scopes are required/u);
    await expect(
      bootstrapOAuthClient(fakeClient, bootstrapInput({ redirectUris: [] })),
    ).rejects.toThrow(/redirect URIs are required/u);
  });

  it('rejects a connection string pointing at a different database (current_database guard)', async () => {
    // Guard server-side: dùng một database vứt tạo bằng superuser thay vì mặc
    // định `postgres` của image — assertion luôn chạm current_database(), không
    // phụ thuộc image có sẵn database mặc định nào.
    const probeDatabase = 'bootstrap_probe_not_auth';
    const admin = new Client({
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.superuserUser,
      password: db.superuserPassword,
      application_name: 'ecoma-auth-bootstrap-oauth-clients-itest-admin',
    });
    const wrongDb = new Client({
      host: db.host,
      port: db.port,
      user: db.migratorUser,
      password: db.migratorPassword,
      database: probeDatabase,
      application_name: 'ecoma-auth-bootstrap-oauth-clients-itest-wrongdb',
    });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${probeDatabase}"`);
      await wrongDb.connect();
      await expect(assertBootstrapDatabase(wrongDb)).rejects.toThrow(/only bootstraps db-auth/u);
    } finally {
      // Ngắt kết nối probe trước khi DROP DATABASE (không cho phép kết nối
      // còn sống); DROP nuốt lỗi để lỗi thật của assert không bị che.
      await wrongDb.end();
      await admin.query(`DROP DATABASE "${probeDatabase}"`).catch(() => undefined);
      await admin.end();
    }

    // Đối chiếu dương: đúng database thì guard qua và trả về tên.
    const right = await migratorClient(db);
    try {
      await expect(assertBootstrapDatabase(right)).resolves.toBe(AUTH_DATABASE);
    } finally {
      await right.end();
    }
  });

  it('parses the bootstrap environment fail-closed, naming the missing variable', () => {
    const valid = {
      DATABASE_URL: `postgresql://ecoma_auth_migrator:pw@host:5432/${AUTH_DATABASE}`,
      [BOOTSTRAP_CLIENT_ID_ENV]: CLIENT_ID,
      [BOOTSTRAP_CLIENT_NAME_ENV]: CLIENT_NAME,
      [BOOTSTRAP_ALLOWED_SCOPES_ENV]: 'openid offline_access',
      [BOOTSTRAP_REDIRECT_URIS_ENV]: `${URI_A} ${URI_B}`,
    };
    expect(parseBootstrapEnv(valid)).toEqual({
      clientId: CLIENT_ID,
      clientName: CLIENT_NAME,
      allowedScopes: SCOPES,
      redirectUris: [URI_A, URI_B],
    });

    expect(() => parseBootstrapEnv({})).toThrow(/DATABASE_URL is not set/u);
    const { DATABASE_URL: _url, ...withoutUrl } = valid;
    expect(() => parseBootstrapEnv(withoutUrl)).toThrow(/DATABASE_URL is not set/u);
    const { [BOOTSTRAP_CLIENT_ID_ENV]: _id, ...withoutId } = valid;
    expect(() => parseBootstrapEnv(withoutId)).toThrow(
      new RegExp(`${BOOTSTRAP_CLIENT_ID_ENV} is not set`, 'u'),
    );
    const { [BOOTSTRAP_CLIENT_NAME_ENV]: _name, ...withoutName } = valid;
    expect(() => parseBootstrapEnv(withoutName)).toThrow(
      new RegExp(`${BOOTSTRAP_CLIENT_NAME_ENV} is not set`, 'u'),
    );
    const { [BOOTSTRAP_ALLOWED_SCOPES_ENV]: _scopes, ...withoutScopes } = valid;
    expect(() => parseBootstrapEnv(withoutScopes)).toThrow(
      new RegExp(`${BOOTSTRAP_ALLOWED_SCOPES_ENV} is empty`, 'u'),
    );
    const { [BOOTSTRAP_REDIRECT_URIS_ENV]: _uris, ...withoutUris } = valid;
    expect(() => parseBootstrapEnv(withoutUris)).toThrow(
      new RegExp(`${BOOTSTRAP_REDIRECT_URIS_ENV} is empty`, 'u'),
    );

    // Hình dạng đầu vào sai cũng fail-closed, đúng biến env bị lỗi.
    expect(() => parseBootstrapEnv({ ...valid, [BOOTSTRAP_CLIENT_ID_ENV]: 'two words' })).toThrow(
      new RegExp(`${BOOTSTRAP_CLIENT_ID_ENV} is not set`, 'u'),
    );
    expect(() =>
      parseBootstrapEnv({ ...valid, [BOOTSTRAP_ALLOWED_SCOPES_ENV]: 'openid "quoted"' }),
    ).toThrow(/invalid scope token/u);
    expect(() =>
      parseBootstrapEnv({ ...valid, [BOOTSTRAP_ALLOWED_SCOPES_ENV]: 'openid openid' }),
    ).toThrow(/more than once/u);
    expect(() =>
      parseBootstrapEnv({ ...valid, [BOOTSTRAP_REDIRECT_URIS_ENV]: '/api/auth/callback' }),
    ).toThrow(/not an absolute URI/u);
    expect(() =>
      parseBootstrapEnv({ ...valid, [BOOTSTRAP_REDIRECT_URIS_ENV]: 'ftp://office.example/cb' }),
    ).toThrow(/non-HTTP/u);
    expect(() =>
      parseBootstrapEnv({ ...valid, [BOOTSTRAP_REDIRECT_URIS_ENV]: `${URI_A}#frag` }),
    ).toThrow(/forbids fragments/u);
    expect(() =>
      parseBootstrapEnv({ ...valid, [BOOTSTRAP_REDIRECT_URIS_ENV]: `${URI_A} ${URI_A}` }),
    ).toThrow(/more than once/u);
  });
});
