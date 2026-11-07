/**
 * ACCEPTANCE — bổ sung coverage cho các cửa sổ chưa có bằng chứng độc lập của #126:
 *
 *   1. Thu hồi ở mức subject (`token_revocations`) TRƯỚC thời điểm cấp code ⇒ gate
 *      ném, browser KHÔNG nhận code (provider-level, không chỉ gate-level).
 *   2. Dependency unavailable (Account service ném) tại thời điểm cấp ⇒ fail
 *      closed: không code, không token, không audit policy (lỗi hạ tầng, không
 *      phải policy denial).
 *   3. Refresh token: envelope rác ⇒ `invalid_grant`, không cấp token.
 *
 * ⚠️ Khác với `oidc-midflow-suspension.spec.ts` (chỉ account status) và
 * `oidc-fullflow.spec.ts` (không wire gate), suite này wire gate THẬT và đi qua
 * Account service binding có thể ném — đúng đường production.
 *
 * ⚠️ Giới hạn đã tài liệu hoá (KHÔNG test "thu hồi tức thì" cho JWT verify
 * offline): access token là JWT ES256 TTL 300s, verify offline bằng JWKS;
 * `token_revocations` chỉ chặn CẤP MỚI tại `auth`, không vô hiệu token đã cấp ở
 * resource server verify offline. Suite này chỉ assert "không cấp mới", không bao
 * giờ assert token cũ bị vô hiệu (docs/applications/auth/03-operations.md §11.1).
 *
 * Thiếu Docker ⇒ SKIP.
 */

import type { Server } from 'node:http';

import postgres from 'postgres';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNonce, signRequest } from '@ecoma-io/auth-contracts';
import { allowsIssuance } from '@ecoma-io/auth-domain';
import {
  checkRevocationAtIssuance,
  createPostgresClient,
  insertAuditEvent,
  withPostgresClient,
  type PostgresClientLike,
} from '@ecoma-io/auth-infrastructure';

import { PROVIDER_ROUTES } from '../../src/oidc/provider';
import type { IssuanceGate } from '../../src/oidc/adapter';
import { AccountClient } from '../../src/account-client';
import { loadAuthConfig, type AuthEnv } from '../../src/config';
import { startAuthDatabase, type AuthDatabase } from './harness';
let db: AuthDatabase;

function base() {
  if (db === undefined) throw new Error('database container is not running');
  return { host: db.host, port: db.port, database: db.database, prepare: false } as const;
}

function connectRuntime(max = 10): postgres.Sql {
  return postgres({ ...base(), user: db.runtimeUser, password: db.runtimePassword, max });
}

const HANDLE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CLIENT_ID = 'client-isscov-pg-test';
const CLIENT_REDIRECT = 'https://rp.example.com/cb';
const SUB_REV = 'sub-isscov-rev-00000000000000000000000000';
const SUB_UNAVAIL = 'sub-isscov-unavail-00000000000000000000000';
const INTERNAL_SECRET = 'isscov-internal-secret';
const TEST_AUDIENCE = 'https://api.ecoma.io/isscov';
const ACCOUNT_BASE_URL = 'https://account.ecoma.io';
let ISSUER = 'http://127.0.0.1:0';

let runtimeSql: postgres.Sql;
let nodeServer: Server;
let nodePort = 0;

let statusStub: 'active' | 'suspended' = 'active';
let bindingThrows = false;

const bindingStub = {
  fetch: async (_request: Request): Promise<Response> => {
    if (bindingThrows) throw new Error('ECONNREFUSED simulated account unavailable');
    return new Response(JSON.stringify({ status: statusStub }), { status: 200 });
  },
};

async function localFetch(path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`http://127.0.0.1:${nodePort}${path}`, { ...init, redirect: 'manual' });
}

async function internalPost(
  app: {
    request: (path: string, init?: RequestInit, env?: AuthEnv) => Promise<Response> | Response;
  },
  path: string,
  payload: unknown,
  env: AuthEnv,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const headers = await signRequest({
    method: 'POST',
    path,
    body,
    secret: INTERNAL_SECRET,
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: createNonce(),
  });
  const response = await app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body as unknown as BodyInit,
    },
    env,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function makeIssuanceGate(
  config: { internalSecret: string },
  postgresClient: PostgresClientLike,
): IssuanceGate {
  const account = new AccountClient({ binding: bindingStub, secret: config.internalSecret });
  return {
    assertIssuable: async ({ accountId, clientId, grantId }) => {
      const status = await account.checkStatus({ accountId, nowMs: Date.now() });
      if (!allowsIssuance(status)) {
        await insertAuditEvent(postgresClient, {
          eventType: 'token_issue_denied',
          subjectRef: accountId,
          clientId,
          grantId: grantId ?? undefined,
          outcome: 'denied',
          errorCode: 'access_denied',
          details: { reason: 'account_status' },
        });
        throw new Error(`issuance gate: account status "${status}" khong cho phep cap token`);
      }
      const revocation = await checkRevocationAtIssuance(postgresClient, {
        sub: accountId,
        clientId,
        grantId: grantId ?? undefined,
      });
      if (revocation !== 'not_revoked') {
        await insertAuditEvent(postgresClient, {
          eventType: 'token_issue_denied',
          subjectRef: accountId,
          clientId,
          grantId: grantId ?? undefined,
          outcome: 'denied',
          errorCode: 'access_denied',
          details: { reason: 'revocation' },
        });
        throw new Error('issuance gate: token da bi revoke (subject/client/grant)');
      }
    },
  };
}

async function bootProvider(pem: string): Promise<void> {
  const { createServer } = await import('node:http');
  const probeServer = createServer((_req: unknown, res: { end: (chunk?: string) => void }) => {
    res.end('probe-only');
  });
  await new Promise<void>((resolve) => {
    probeServer.listen(0, '127.0.0.1', () => resolve());
  });
  const probeAddress = probeServer.address();
  const allocatedPort =
    typeof probeAddress === 'object' && probeAddress !== null ? probeAddress.port : 0;
  expect(allocatedPort).toBeGreaterThan(0);
  await new Promise<void>((resolve, reject) => {
    probeServer.close((err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
  nodePort = allocatedPort;
  ISSUER = `https://127.0.0.1:${nodePort}`;

  const env = makeEnv(pem);
  const config = await loadAuthConfig(env);
  const { createProvider } = await import('../../src/oidc/provider');
  const postgresClientConfig = { hyperdrive: config.hyperdrive };
  // Client pool dài hạn cho gate (lane `postgresClient` của `createIssuanceGateFromDeps`)
  // + client dùng-một-lần để load static clients — đúng hai lane của issue #289.
  const poolClient = createPostgresClient(config.hyperdrive);
  const provider = await withPostgresClient(
    postgresClientConfig,
    async (staticClientsLoader) =>
      await createProvider({
        config,
        postgresClientConfig,
        staticClientsLoader,
        signingPem: pem,
        issuanceGate: makeIssuanceGate(config, poolClient),
      }),
  );
  nodeServer = createServer(((req: unknown, res: unknown) => {
    const incoming = req as { headers: Record<string, string | string[] | undefined> };
    incoming.headers['x-forwarded-proto'] = 'https';
    (provider.callback() as (r: unknown, w: unknown) => void)(req, res);
  }) as never);
  await new Promise<void>((resolve, reject) => {
    nodeServer.once('error', reject);
    nodeServer.listen(nodePort, '127.0.0.1', () => resolve());
  });
  void provider;
}

function makeEnv(pem: string): AuthEnv {
  return {
    HYPERDRIVE: {
      connectionString: `postgres://${db.runtimeUser}:${db.runtimePassword}@${db.host}:${db.port}/${db.database}`,
    },
    ACCOUNT_SERVICE: bindingStub as unknown as AuthEnv['ACCOUNT_SERVICE'],
    AUTH_SIGNING_KEY: pem,
    AUTH_SIGNING_KEY_ID: 'kid-isscov',
    AUTH_HANDLE_KEY: HANDLE_KEY,
    AUTH_HANDLE_KEY_VERSION: '1',
    AUTH_INTERNAL_SECRET: INTERNAL_SECRET,
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: TEST_AUDIENCE,
    AUTH_COOKIE_KEYS: 'isscov-cookie-key-1,isscov-cookie-key-2',
    AUTH_ACCOUNT_BASE_URL: ACCOUNT_BASE_URL,
  };
}

interface WalkUp {
  resumeUrl: URL;
  cookieHeader: string;
  verifier: string;
}

async function walkUpToApproved(params: {
  scopes: string;
  state: string;
  nonce: string;
  eventId: string;
  keypairPem: string;
  subject: string;
}): Promise<WalkUp> {
  const env = makeEnv(params.keypairPem);
  const { default: app } = await import('../../src/main');
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = Buffer.from(verifierBytes).toString('base64url');
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url');

  const authorizeUrl = `/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}&response_type=code&scope=${params.scopes}&state=${params.state}&nonce=${params.nonce}&code_challenge=${challenge}&code_challenge_method=S256`;
  const authorizeResponse = await app.request(authorizeUrl, { redirect: 'manual' }, env);
  expect(authorizeResponse.status).toBe(302);
  const providerAuthUrl = new URL(authorizeResponse.headers.get('location') as string);
  const handleX = providerAuthUrl.searchParams.get('ecoma_x');
  const setCookie = authorizeResponse.headers.get('set-cookie') ?? '';
  const browserBinding = setCookie.split(';')[0]?.split('=')[1];

  const providerAuthResponse = await localFetch(
    `${providerAuthUrl.pathname}${providerAuthUrl.search}`,
    { headers: { cookie: `__Host-auth-browser=${browserBinding}` } },
  );
  expect(providerAuthResponse.status).toBe(303);
  const authCookies = providerAuthResponse.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c) => c.startsWith('_interaction'));
  const cookieHeader = authCookies.join('; ');
  expect(cookieHeader).not.toBe('');

  await app.request(
    `/authorize/confirm?handle=${handleX}`,
    { redirect: 'manual', headers: { cookie: `__Host-auth-browser=${browserBinding}` } },
    env,
  );

  const verified = await internalPost(
    app,
    '/internal/session/verified',
    {
      handle: handleX,
      sub: params.subject,
      acr: 'urn:ecoma:acr:email-otp',
      authn_at: Date.now(),
      account_session_ref: 'asr-isscov-1',
      event_id: params.eventId,
    },
    env,
  );
  expect(verified.status).toBe(200);
  expect(verified.body['outcome']).toBe('consent_required');
  const handleY = new URL(verified.body['continue_url'] as string).searchParams.get('handle');

  const decide = await internalPost(
    app,
    '/internal/consent/decide',
    { handle: handleY, decision: 'approve', account_session_ref: 'asr-isscov-1' },
    env,
  );
  expect(decide.status).toBe(200);
  expect(decide.body['outcome']).toBe('approved');
  const resumeUrl = new URL(decide.body['continue_url'] as string);
  return { resumeUrl, cookieHeader, verifier };
}

beforeAll(async () => {
  db = await startAuthDatabase();
  runtimeSql = connectRuntime();
  await runtimeSql`
    INSERT INTO auth.oauth_clients (client_id, client_name, client_type, allowed_scopes)
    VALUES (${CLIENT_ID}, 'isscov pg test client', 'public', ARRAY['openid', 'offline_access']::text[])
    ON CONFLICT (client_id) DO UPDATE SET allowed_scopes = EXCLUDED.allowed_scopes
  `;
  await runtimeSql`
    INSERT INTO auth.client_redirect_uris (client_id, redirect_uri) VALUES (${CLIENT_ID}, ${CLIENT_REDIRECT}) ON CONFLICT DO NOTHING
  `;
}, 180_000);

afterAll(async () => {
  nodeServer?.close();
  try {
    await runtimeSql.unsafe(
      `DELETE FROM auth.client_grant_scopes WHERE grant_id IN (SELECT id FROM auth.oauth_grants WHERE sub LIKE 'sub-isscov-%')`,
    );
    await runtimeSql.unsafe(`DELETE FROM auth.oauth_grants WHERE sub LIKE 'sub-isscov-%'`);
    await runtimeSql.unsafe(
      `DELETE FROM auth.oauth_consent_decisions WHERE authorization_transaction_id IN (SELECT transaction_id FROM auth.authorization_transactions WHERE event_id LIKE 'evt-isscov-%')`,
    );
    await runtimeSql.unsafe(
      `DELETE FROM auth.authorization_codes WHERE authorization_transaction_id IN (SELECT transaction_id FROM auth.authorization_transactions WHERE event_id LIKE 'evt-isscov-%')`,
    );
    await runtimeSql.unsafe(
      `DELETE FROM auth.oidc_state WHERE payload->>'clientId' = ${CLIENT_ID} OR payload->>'accountId' LIKE 'sub-isscov-%'`,
    );
    await runtimeSql.unsafe(
      `DELETE FROM auth.authorization_transactions WHERE event_id LIKE 'evt-isscov-%'`,
    );
    await runtimeSql.unsafe(
      `DELETE FROM auth.token_revocations WHERE subject_ref LIKE 'sub-isscov-%'`,
    );
  } catch {
    /* cleanup best-effort */
  }
  await runtimeSql?.end({ timeout: 1 });
  await db?.stop();
});

describe('issuance gates coverage — uncovered windows (#126)', () => {
  it('subject-level revocation before resume ⇒ gate throws, no code issued', async () => {
    const keypair = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(keypair.privateKey);
    statusStub = 'active';
    bindingThrows = false;
    await bootProvider(pem);

    const pre = await walkUpToApproved({
      scopes: 'openid offline_access',
      state: 'st-isscov-rev',
      nonce: 'n-isscov-rev',
      eventId: 'evt-isscov-rev',
      keypairPem: pem,
      subject: SUB_REV,
    });

    // Revocation committed BETWEEN consent/decide and resume — gate at resume time must block.
    await runtimeSql`
      INSERT INTO auth.token_revocations (level, subject_ref, reason)
      VALUES ('subject', ${SUB_REV}, 'isscov-subject-revocation')
    `;

    const resumeResponse = await localFetch(pre.resumeUrl.pathname + pre.resumeUrl.search, {
      headers: { cookie: pre.cookieHeader },
      redirect: 'manual',
    });
    expect(resumeResponse.status).toBe(500);
    expect(resumeResponse.headers.get('location')).toBeNull();

    const codeRows = await runtimeSql<{ count: string }[]>`
      SELECT count(*) AS count FROM auth.oidc_state WHERE kind = 'AuthorizationCode' AND payload->>'accountId' = ${SUB_REV}
    `;
    expect(Number(codeRows[0]?.count)).toBe(0);
  });

  it('account dependency unavailable ⇒ fail closed (no code, no policy audit)', async () => {
    const keypair = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(keypair.privateKey);
    statusStub = 'active';
    bindingThrows = false;
    await bootProvider(pem);

    const pre = await walkUpToApproved({
      scopes: 'openid offline_access',
      state: 'st-isscov-unavail',
      nonce: 'n-isscov-unavail',
      eventId: 'evt-isscov-unavail',
      keypairPem: pem,
      subject: SUB_UNAVAIL,
    });

    // Flip dependency to unavailable BETWEEN decide and resume.
    bindingThrows = true;

    const resumeResponse = await localFetch(pre.resumeUrl.pathname + pre.resumeUrl.search, {
      headers: { cookie: pre.cookieHeader },
      redirect: 'manual',
    });
    expect(resumeResponse.status).toBe(500);
    expect(resumeResponse.headers.get('location')).toBeNull();

    const codeRows = await runtimeSql<{ count: string }[]>`
      SELECT count(*) AS count FROM auth.oidc_state WHERE kind = 'AuthorizationCode' AND payload->>'accountId' = ${SUB_UNAVAIL}
    `;
    expect(Number(codeRows[0]?.count)).toBe(0);

    const denyRows = await runtimeSql<{ count: string }[]>`
      SELECT count(*) AS count FROM auth.authorization_audit_events
       WHERE event_type = 'token_issue_denied' AND subject_ref = ${SUB_UNAVAIL}
    `;
    expect(Number(denyRows[0]?.count)).toBe(0);
  });

  it('no offline_access scope ⇒ token response has no refresh_token', async () => {
    const keypair = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(keypair.privateKey);
    statusStub = 'active';
    bindingThrows = false;
    await bootProvider(pem);

    const pre = await walkUpToApproved({
      scopes: 'openid',
      state: 'st-isscov-nort',
      nonce: 'n-isscov-nort',
      eventId: 'evt-isscov-nort',
      keypairPem: pem,
      subject: 'sub-isscov-nort-000000000000000000000000',
    });

    const resumeResponse = await localFetch(pre.resumeUrl.pathname + pre.resumeUrl.search, {
      headers: { cookie: pre.cookieHeader },
      redirect: 'manual',
    });
    expect(resumeResponse.status).toBe(303);
    const clientCallback = new URL(resumeResponse.headers.get('location') as string);
    const code = clientCallback.searchParams.get('code');
    expect(typeof code).toBe('string');

    const tokenResponse = await localFetch(PROVIDER_ROUTES.tokenRoute, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: CLIENT_REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: pre.verifier,
        resource: TEST_AUDIENCE,
      }).toString(),
      redirect: 'manual',
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    expect(typeof tokens.access_token).toBe('string');
    // No offline_access ⇒ provider must NOT issue a refresh token.
    expect(tokens.refresh_token).toBeUndefined();
  });

  it('garbage refresh token ⇒ invalid_grant (no token issued)', async () => {
    statusStub = 'active';
    bindingThrows = false;
    const tokenResponse = await localFetch(PROVIDER_ROUTES.tokenRoute, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'not-a-valid-token',
        client_id: CLIENT_ID,
        resource: TEST_AUDIENCE,
      }).toString(),
      redirect: 'manual',
    });
    expect(tokenResponse.status).toBe(400);
    const body = (await tokenResponse.json()) as { error?: string };
    expect(body.error).toBe('invalid_grant');
  });
});
