/**
 * Unit + PostgreSQL test cho hai handler connected-applications (FR-009):
 * parse thuần chạy mọi nơi; `run*` chạy trên PostgreSQL thật vì toàn bộ giá
 * trị của revoke nằm ở thứ tự CAS → control plane → audit trong MỘT tx và ở
 * CHECK của schema — stub DB là schema thứ hai, sai thứ tự vẫn xanh trên stub
 * mà vỡ trên schema thật (cùng bài học `internal-handlers.spec.ts`).
 *
 * ⚠️ Thiếu Docker thì suite ĐỎ ngay (fail-loud, `06-testing.md` §6) — không skip im lặng.
 */

import postgres from 'postgres';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresClient,
  insertClientRevocation,
  listConnectedApplications,
  revokeGrantActive,
  type PostgresClientLike,
} from '@ecoma-io/auth-infrastructure';
import {
  parseConnectedApplicationRevoke,
  parseConnectedApplicationsList,
  runConnectedApplicationRevoke,
  runConnectedApplicationsList,
} from '../../src/connected-applications-handler';
import { startAuthDatabase, type AuthDatabase } from './harness';

const SUB = 'sub-conn-apps-test-0000000000000000000000000';
const SUB2 = 'sub-conn-apps-other-00000000000000000000000';

let db: AuthDatabase | undefined;

function runtimeSql(): postgres.Sql {
  if (db === undefined) {
    throw new Error('database container is not running');
  }
  return postgres({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.runtimeUser,
    password: db.runtimePassword,
    max: 5,
  });
}

function migratorSql(): postgres.Sql {
  if (db === undefined) {
    throw new Error('database container is not running');
  }
  return postgres({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.migratorUser,
    password: db.migratorPassword,
    max: 1,
  });
}

/** Client đúng brand của `PostgresClientLike` — dựng từ connection string. */
function clientLike(): PostgresClientLike {
  if (db === undefined) {
    throw new Error('database container is not running');
  }
  return createPostgresClient({
    connectionString: `postgres://${encodeURIComponent(db.runtimeUser)}:${encodeURIComponent(db.runtimePassword)}@${db.host}:${db.port}/${db.database}`,
  });
}

const CLIENT_ID = 'client-conn-apps-spec';

async function seedClient(migrator: postgres.Sql): Promise<void> {
  await migrator`
    INSERT INTO auth.oauth_clients (client_id, client_name, client_type)
    VALUES (${CLIENT_ID}, 'connected apps spec client', 'public')
    ON CONFLICT (client_id) DO NOTHING
  `;
}

async function seedGrant(
  migrator: postgres.Sql,
  params: { sub: string; scopes?: string[] },
): Promise<string> {
  const rows = await migrator<{ id: string }[]>`
    INSERT INTO auth.oauth_grants (sub, client_id, status, granted_at)
    VALUES (${params.sub}, ${CLIENT_ID}, 'active', now())
    ON CONFLICT (sub, client_id) WHERE status = 'active'
    DO UPDATE SET granted_at = now()
    RETURNING id
  `;
  const grantId = rows[0]?.id;
  if (grantId === undefined) {
    throw new Error('seedGrant returned no id');
  }
  await migrator`
    INSERT INTO auth.client_grant_scopes (grant_id, scope)
    SELECT ${grantId}, scope FROM unnest(${params.scopes ?? ['profile:read']}::text[]) AS scope
    ON CONFLICT DO NOTHING
  `;
  return grantId;
}

/** Dọn mọi hàng của hai sub test — con trước cha (FK). */
async function cleanup(migrator: postgres.Sql): Promise<void> {
  await migrator`
    DELETE FROM auth.token_revocations
     WHERE subject_ref LIKE 'sub-conn-apps-%'
  `;
  await migrator`
    DELETE FROM auth.client_grant_scopes
     WHERE grant_id IN (SELECT id FROM auth.oauth_grants WHERE sub LIKE 'sub-conn-apps-%')
  `;
  await migrator`
    DELETE FROM auth.authorization_audit_events
     WHERE subject_ref LIKE 'sub-conn-apps-%'
        OR client_id = ${CLIENT_ID}
  `;
  await migrator`
    DELETE FROM auth.oauth_grants
     WHERE sub LIKE 'sub-conn-apps-%'
  `;
}

describe('connected applications parse (pure)', () => {
  it('accepts a well-shaped list payload', () => {
    expect(parseConnectedApplicationsList({ sub: 'subject-1' })).toEqual({ sub: 'subject-1' });
  });

  it('rejects a missing, wrong-typed, empty, or oversized sub', () => {
    expect(parseConnectedApplicationsList(undefined)).toBeUndefined();
    expect(parseConnectedApplicationsList({})).toBeUndefined();
    expect(parseConnectedApplicationsList({ sub: 42 })).toBeUndefined();
    expect(parseConnectedApplicationsList({ sub: '' })).toBeUndefined();
    expect(parseConnectedApplicationsList({ sub: 'x'.repeat(201) })).toBeUndefined();
  });

  it('accepts a well-shaped revoke payload with a lowercase uuid grant_id', () => {
    expect(
      parseConnectedApplicationRevoke({
        sub: 'subject-1',
        grant_id: '11111111-2222-4333-8444-555555555555',
      }),
    ).toEqual({ sub: 'subject-1', grantId: '11111111-2222-4333-8444-555555555555' });
  });

  it('rejects a revoke payload whose grant_id is not a uuid', () => {
    expect(parseConnectedApplicationRevoke({ sub: 's', grant_id: 'not-a-uuid' })).toBeUndefined();
    expect(parseConnectedApplicationRevoke({ sub: 's' })).toBeUndefined();
    expect(
      parseConnectedApplicationRevoke({
        sub: 's',
        grant_id: '11111111-2222-4333-8444-555555555555.extra',
      }),
    ).toBeUndefined();
  });
});

describe('connected applications handlers — against a real PostgreSQL', () => {
  beforeAll(async () => {
    db = await startAuthDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('list returns every active grant with client name and scopes', async () => {
    const migrator = migratorSql();
    const runtime = runtimeSql();
    try {
      await seedClient(migrator);
      const grantId = await seedGrant(migrator, { sub: SUB, scopes: ['profile:read', 'email'] });

      const result = await runConnectedApplicationsList({
        postgresClient: clientLike(),
        payload: { sub: SUB },
      });

      expect(result.status).toBe(200);
      // Scopes được SQL ORDER BY s.scope — alphabet, không phải thứ tự seed.
      expect(result.body).toEqual({
        applications: [
          {
            id: grantId,
            client_id: CLIENT_ID,
            client_name: 'connected apps spec client',
            granted_at: expect.any(Number),
            scopes: ['email', 'profile:read'],
          },
        ],
      });
    } finally {
      await cleanup(migrator);
      await migrator.end();
      await runtime.end();
    }
  });

  it('list of an unknown subject returns an empty application list', async () => {
    const migrator = migratorSql();
    const runtime = runtimeSql();
    try {
      const result = await runConnectedApplicationsList({
        postgresClient: clientLike(),
        payload: { sub: 'sub-conn-apps-nobody-000000000000000000000000' },
      });
      expect(result).toEqual({ status: 200, body: { applications: [] } });
    } finally {
      await cleanup(migrator);
      await migrator.end();
      await runtime.end();
    }
  });

  it('list with a malformed payload is 400 without touching the database', async () => {
    const migrator = migratorSql();
    const runtime = runtimeSql();
    try {
      const result = await runConnectedApplicationsList({
        postgresClient: clientLike(),
        payload: { sub: '' },
      });
      expect(result).toEqual({ status: 400, body: { error: 'invalid_payload' } });
    } finally {
      await migrator.end();
      await runtime.end();
    }
  });

  it('revoke is one event: CAS grant, client revocation, and audit commit together', async () => {
    const migrator = migratorSql();
    const runtime = runtimeSql();
    try {
      await seedClient(migrator);
      const grantId = await seedGrant(migrator, { sub: SUB });

      const result = await runConnectedApplicationRevoke({
        postgresClient: clientLike(),
        payload: { sub: SUB, grant_id: grantId },
        now: new Date(),
      });
      expect(result).toEqual({ status: 200, body: { outcome: 'revoked' } });

      // (1) Grant đã revoked.
      const grants = await runtime`
        SELECT status FROM auth.oauth_grants WHERE id = ${grantId}
      `;
      expect(grants[0]?.status).toBe('revoked');

      // (2) Control plane có đúng một hàng level client.
      const revocations = await runtime`
        SELECT level, source, client_id, grant_id
          FROM auth.token_revocations
         WHERE subject_ref = ${SUB}
      `;
      expect(revocations).toHaveLength(1);
      expect(revocations[0]?.level).toBe('client');
      expect(revocations[0]?.source).toBe('auth');
      expect(revocations[0]?.client_id).toBe(CLIENT_ID);
      expect(revocations[0]?.grant_id).toBe(grantId);

      // (3) Audit cùng sự kiện.
      const audits = await runtime`
        SELECT event_type, outcome FROM auth.authorization_audit_events
         WHERE subject_ref = ${SUB} AND event_type = 'grant_revoked'
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]?.outcome).toBe('success');
    } finally {
      await cleanup(migrator);
      await migrator.end();
      await runtime.end();
    }
  });

  it('revoke of a non-active grant is 404 and leaves no revocation nor audit', async () => {
    const migrator = migratorSql();
    const runtime = runtimeSql();
    try {
      await seedClient(migrator);
      // Không seed grant nào active cho SUB — grant_id bừa đúng shape uuid.
      const missingId = '99999999-9999-4999-8999-999999999999';

      const result = await runConnectedApplicationRevoke({
        postgresClient: clientLike(),
        payload: { sub: SUB, grant_id: missingId },
        now: new Date(),
      });
      expect(result).toEqual({ status: 404, body: { error: 'invalid_grant' } });

      const revocations = await runtime`
        SELECT 1 FROM auth.token_revocations WHERE subject_ref = ${SUB}
      `;
      expect(revocations).toHaveLength(0);
      const audits = await runtime`
        SELECT 1 FROM auth.authorization_audit_events WHERE subject_ref = ${SUB}
      `;
      expect(audits).toHaveLength(0);
    } finally {
      await cleanup(migrator);
      await migrator.end();
      await runtime.end();
    }
  });

  it('revoke with a malformed payload is 400 before any transaction starts', async () => {
    const migrator = migratorSql();
    const runtime = runtimeSql();
    try {
      const result = await runConnectedApplicationRevoke({
        postgresClient: clientLike(),
        payload: { sub: SUB, grant_id: 'not-a-uuid' },
        now: new Date(),
      });
      expect(result).toEqual({ status: 400, body: { error: 'invalid_payload' } });
    } finally {
      await cleanup(migrator);
      await migrator.end();
      await runtime.end();
    }
  });

  it('authorization-store CAS helpers lose when the grant belongs to another subject', async () => {
    const migrator = migratorSql();
    const runtime = runtimeSql();
    try {
      await seedClient(migrator);
      const grantId = await seedGrant(migrator, { sub: SUB });

      // CAS của sub khác — không được đụng hàng của SUB.
      const stolen = await runtime.begin(async (tx) =>
        revokeGrantActive(tx as never, {
          sub: SUB2,
          grantId,
          now: new Date(),
        }),
      );
      expect(stolen).toBeUndefined();

      const stillActive = await runtime`
        SELECT status FROM auth.oauth_grants WHERE id = ${grantId}
      `;
      expect(stillActive[0]?.status).toBe('active');
    } finally {
      await cleanup(migrator);
      await migrator.end();
      await runtime.end();
    }
  });

  it('insertClientRevocation records a client-level revocation row', async () => {
    const migrator = migratorSql();
    const runtime = runtimeSql();
    try {
      await runtime.begin(async (tx) => {
        await insertClientRevocation(tx as never, {
          subjectRef: SUB,
          clientId: CLIENT_ID,
          grantId: '88888888-8888-4888-9888-888888888888',
          now: new Date(),
        });
      });
      const rows = await runtime`
        SELECT level, source, reason, client_id, grant_id
          FROM auth.token_revocations
         WHERE subject_ref = ${SUB}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.level).toBe('client');
      expect(rows[0]?.source).toBe('auth');
      expect(rows[0]?.client_id).toBe(CLIENT_ID);
    } finally {
      await cleanup(migrator);
      await migrator.end();
      await runtime.end();
    }
  });

  it('listConnectedApplications returns an empty list with no grants', async () => {
    const migrator = migratorSql();
    const runtime = runtimeSql();
    try {
      const rows = await listConnectedApplications(runtime as never, { sub: SUB });
      expect(rows).toEqual([]);
    } finally {
      await cleanup(migrator);
      await migrator.end();
      await runtime.end();
    }
  });
});
