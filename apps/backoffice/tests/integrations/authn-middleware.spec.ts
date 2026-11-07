/**
 * Integration test cho middleware authn (`server/middleware/authn.ts`) —
 * hợp đồng ADR-0012 §1.5 + phân loại ADR-0011 §1, chạy trên **h3 app thật**
 * với middleware thật, JWKS server thật (HTTP), PostgreSQL thật.
 *
 * ## Vì sao middleware cần test riêng trong khi read-routes đã có
 *
 * `read-routes.spec.ts` dựng app **không có middleware** — nó gắn principal
 * giả vào context để test route. Suite này test chính đường middleware gắn
 * principal: ranh giới chặn (chỉ `/api/**`), so khớp path có query string,
 * matrix 401/503/200 và hành vi principal mà route nhìn thấy.
 *
 * ## Hai lỗi thật mà matrix này ghim (mutation control)
 *
 * 1. **So khớp nguyên `event.path`** — h3 1.15 gồm query string trong
 *    `event.path`, nên `/api/auth/callback?code=…&state=…` không bao giờ trùng
 *    allowlist ⇒ luồng đăng nhập chết. Test "callback with query bypasses" là
 *    mutation control: đổi lại so khớp nguyên chuỗi là test đỏ.
 * 2. **Chặn cả bề mặt ngoài `/api/`** — một middleware chặn mọi path làm trang
 *    prototype trả 503 với khách chưa đăng nhập (đo được: Playwright webServer
 *    timeout 180s trên CI vì readiness URL `/` không bao giờ 2xx). Test
 *    "page paths bypass" ghim ranh giới theo chiều còn lại: **không** có path
 *    nào ngoài `/api/` bị middleware đụng tới.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import authnMiddleware from '../../server/middleware/authn';
import {
  SESSION_COOKIE_NAME,
  SESSION_IDLE_SECONDS,
  createSessionIdentifier,
  hashSessionIdentifier,
  insertSession,
  resetJwksCacheForTests,
  sessionDeadlines,
} from '@ecoma-io/backoffice-infrastructure';
import { BACKOFFICE_DATABASE, type BackofficeDatabase, startBackofficeDatabase } from './harness';

const AUDIENCE = 'https://api.test.ecoma.io/backoffice';
const CLIENT_ID = 'backoffice-test';
const ACCOUNT_ID = `sub_${'a'.repeat(32)}`;

/** JWKS hiện hành mà fake auth công bố; test đổi giữa các case. */
let currentJwks: { keys: Record<string, unknown>[] };

/** Số lần fake server được fetch `/jwks.json` — reset trong beforeEach. */
let jwksFetchCount = 0;

let jwksServer: Server;
let issuerUrl = '';

/** Key ES256 dùng ký token test. */
let signingKey: CryptoKeyPair;
const KEY_ID = 'authn-test-key';

beforeAll(async () => {
  signingKey = (await generateKeyPair('ES256', { extractable: true })) as CryptoKeyPair;
  const jwk = {
    kid: KEY_ID,
    alg: 'ES256',
    use: 'sig',
    ...(await exportJWK(signingKey.publicKey)),
  };
  currentJwks = { keys: [jwk] };

  jwksServer = createServer((req, res) => {
    if (req.url === '/jwks.json') {
      jwksFetchCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(currentJwks));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => {
    jwksServer.listen(0, '127.0.0.1', done);
  });
  const address = jwksServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake auth server did not bind a port');
  }
  issuerUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => {
    jwksServer.close(() => done());
  });
});

beforeEach(() => {
  resetJwksCacheForTests();
  jwksFetchCount = 0;
});

/** Ký access token đúng cấu trúc `at+jwt` của `auth`. */
async function signAccessToken(expSeconds?: number): Promise<string> {
  return new SignJWT({
    scope: 'openid offline_access',
    client_id: CLIENT_ID,
    jti: 'authn-test-jti',
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: KEY_ID })
    .setIssuer(issuerUrl)
    .setAudience(AUDIENCE)
    .setSubject(ACCOUNT_ID)
    .setIssuedAt()
    .setExpirationTime(expSeconds ?? Math.floor(Date.now() / 1000) + 300)
    .sign(signingKey.privateKey as CryptoKey);
}

/** Cấu hình OIDC test — cùng hình dạng `backofficeAuthConfig` trả. */
function authEnv(): Record<string, string> {
  return {
    BACKOFFICE_AUTH_ISSUER: issuerUrl,
    BACKOFFICE_AUTH_AUDIENCE: AUDIENCE,
    BACKOFFICE_AUTH_CLIENT_ID: CLIENT_ID,
  };
}

/**
 * Dựng h3 app: middleware authn thật + router canary trả `pathname` mà route
 * nhìn thấy (không phụ thuộc dữ liệu nào). `env` của Worker được trải vào
 * `event.context.cloudflare.env` — đúng đường middleware đọc binding/cấu hình.
 */
function buildApp(env: Record<string, unknown>): (request: Request) => Promise<Response> {
  const app = createApp();
  app.use(
    defineEventHandler((event) => {
      event.context.cloudflare = { env };
    }),
  );
  app.use(authnMiddleware);

  const router = createRouter();
  router.get(
    '/api/canary',
    defineEventHandler((event) => ({ path: event.path })),
  );
  app.use(router.handler);

  return toWebHandler(app);
}

interface Probe {
  readonly status: number;
  readonly body: unknown;
}

async function probe(
  app: (request: Request) => Promise<Response>,
  path: string,
  cookie?: string,
): Promise<Probe> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const response = await app(new Request(`https://backoffice.test${path}`, { headers }));
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

describe('authn middleware boundary and classification', () => {
  let db: BackofficeDatabase;

  function runtimeConnectionString(): string {
    return `postgres://ecoma_backoffice_runtime:${db.rolePassword}@${db.host}:${db.port}/${BACKOFFICE_DATABASE}`;
  }

  function envWithDb(): Record<string, unknown> {
    return {
      ...authEnv(),
      DB_BACKOFFICE: { connectionString: runtimeConnectionString() },
    };
  }

  beforeAll(async () => {
    db = await startBackofficeDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  describe('boundary — only /api/** is gated', () => {
    it('passes page, asset and probe paths through untouched (no config, no cookie)', async () => {
      const app = buildApp({});

      for (const path of ['/', '/staff', '/roles', '/_nuxt/entry.js', '/health', '/ready']) {
        const { status } = await probe(app, path);
        // Trang không có trong router canary ⇒ 404 từ router — **không** phải
        // 401/503 từ middleware; middleware vắng mặt là đúng nghĩa "đi qua".
        // `/health`/`/ready` không được route ở app canary nên cũng 404.
        expect(status, `path ${path}`).toBe(404);
      }
    });

    it('passes the callback path with its query string through', async () => {
      const app = buildApp({});
      // Callback thật luôn mang `?code=…&state=…`; app canary không route nó
      // nên kết quả là 404 của router — bằng chứng middleware không chặn.
      const { status } = await probe(app, '/api/auth/callback?code=some-code&state=some-state');
      expect(status).toBe(404);
    });

    it('passes login and logout paths through', async () => {
      const app = buildApp({});
      expect((await probe(app, '/api/auth/login')).status).toBe(404);
      expect((await probe(app, '/api/auth/logout')).status).toBe(404);
    });

    it('gates an /api route outside the auth flow', async () => {
      const app = buildApp({});
      // Không cấu hình OIDC ⇒ 503 fail-closed — đúng phân loại, và khác hẳn
      // 404 của các path ngoài ranh giới ở test trên.
      const { status } = await probe(app, '/api/canary');
      expect(status).toBe(503);
    });

    it('serves the canary route with a session and real token verification', async () => {
      const token = await signAccessToken();
      const sessionValue = createSessionIdentifier();
      const client = await db.connect();
      try {
        const deadlines = sessionDeadlines(Date.now());
        await insertSession(client as never, {
          idHash: await hashSessionIdentifier(sessionValue),
          accountSub: ACCOUNT_ID,
          accessToken: token,
          refreshToken: null,
          authTime: null,
          acr: null,
          expiresAt: new Date(deadlines.idleExpiresAtMs),
        });
      } finally {
        await client.end();
      }

      const app = buildApp(envWithDb());
      const { status, body } = await probe(
        app,
        '/api/canary',
        `${SESSION_COOKIE_NAME}=${sessionValue}`,
      );

      expect(status).toBe(200);
      // `event.path` canary gồm query — assert nguyên chuỗi để ghim đúng giá
      // trị mà route nhìn thấy.
      expect(body).toEqual({ path: '/api/canary' });
      // Một lần verify thành công = đúng một lần fetch JWKS (cache warm).
      expect(jwksFetchCount).toBe(1);
    });

    it('slides the idle expiry of a live session (touch ran)', async () => {
      const token = await signAccessToken();
      const sessionValue = createSessionIdentifier();
      const client = await db.connect();
      try {
        // Phiên sống nhưng **sắp** hết hạn idle: `created_at` 2s trong quá khứ,
        // `expires_at` chỉ 500ms nữa. Một request hợp lệ phải verify token rồi
        // trượt `expires_at` lên `now() + 12h` — sau request, cột này là bằng
        // chứng touch đã chạy (CHECK `expires_at > created_at` vẫn thỏa).
        const created = new Date(Date.now() - 2_000);
        await client.query(
          `INSERT INTO backoffice.bff_sessions
             (id_hash, account_sub, access_token, refresh_token, auth_time, acr, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            await hashSessionIdentifier(sessionValue),
            ACCOUNT_ID,
            token,
            null,
            null,
            null,
            created,
            new Date(Date.now() + 500),
          ],
        );
      } finally {
        await client.end();
      }

      const app = buildApp(envWithDb());
      const { status } = await probe(app, '/api/canary', `${SESSION_COOKIE_NAME}=${sessionValue}`);
      expect(status).toBe(200);

      const verify = await db.connect();
      try {
        const result = await verify.query(
          `SELECT expires_at > now() AS slid FROM backoffice.bff_sessions WHERE account_sub = $1`,
          [ACCOUNT_ID],
        );
        expect(result.rows[0]?.slid).toBe(true);
      } finally {
        await verify.end();
      }
    });
  });

  describe('classification — 401 vs 503 on /api/**', () => {
    it('answers 503 when OIDC config is missing entirely (fail-closed)', async () => {
      const app = buildApp({});
      const { status } = await probe(app, '/api/canary');
      expect(status).toBe(503);
    });

    it('answers 401 when the session cookie is absent (config present)', async () => {
      const app = buildApp(envWithDb());
      const { status } = await probe(app, '/api/canary');
      expect(status).toBe(401);
    });

    it('answers 401 for an unknown session cookie value', async () => {
      const app = buildApp(envWithDb());
      const { status } = await probe(
        app,
        '/api/canary',
        `${SESSION_COOKIE_NAME}=${createSessionIdentifier()}`,
      );
      expect(status).toBe(401);
    });

    it('answers 401 when the stored token no longer verifies', async () => {
      const sessionValue = createSessionIdentifier();
      const client = await db.connect();
      try {
        // Token ký bằng **key khác** JWKS công bố — chữ ký sai ⇒ invalid.
        const foreign = (await generateKeyPair('ES256', { extractable: true })) as CryptoKeyPair;
        const staleToken = await new SignJWT({ jti: 'stale' })
          .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: KEY_ID })
          .setIssuer(issuerUrl)
          .setAudience(AUDIENCE)
          .setSubject(ACCOUNT_ID)
          .setIssuedAt()
          .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
          .sign(foreign.privateKey as CryptoKey);
        const deadlines = sessionDeadlines(Date.now());
        await insertSession(client as never, {
          idHash: await hashSessionIdentifier(sessionValue),
          accountSub: ACCOUNT_ID,
          accessToken: staleToken,
          refreshToken: null,
          authTime: null,
          acr: null,
          expiresAt: new Date(deadlines.idleExpiresAtMs),
        });
      } finally {
        await client.end();
      }

      const app = buildApp(envWithDb());
      const { status } = await probe(app, '/api/canary', `${SESSION_COOKIE_NAME}=${sessionValue}`);
      expect(status).toBe(401);
    });

    it('answers 503 when the database binding is missing (config present)', async () => {
      const app = buildApp(authEnv());
      const { status } = await probe(
        app,
        '/api/canary',
        `${SESSION_COOKIE_NAME}=${createSessionIdentifier()}`,
      );
      expect(status).toBe(503);
    });

    it('answers 503 when JWKS is unreachable', async () => {
      // Cấu hình trỏ issuer tới một cổng không có server nào — token không bao
      // giờ được nhìn ⇒ `unavailable` (503), không phải `invalid` (401).
      const unreachableEnv = {
        ...authEnv(),
        BACKOFFICE_AUTH_ISSUER: 'http://127.0.0.1:1',
        DB_BACKOFFICE: { connectionString: runtimeConnectionString() },
      };
      const token = await signAccessToken();
      const sessionValue = createSessionIdentifier();
      const client = await db.connect();
      try {
        const deadlines = sessionDeadlines(Date.now());
        await insertSession(client as never, {
          idHash: await hashSessionIdentifier(sessionValue),
          accountSub: ACCOUNT_ID,
          accessToken: token,
          refreshToken: null,
          authTime: null,
          acr: null,
          expiresAt: new Date(deadlines.idleExpiresAtMs),
        });
      } finally {
        await client.end();
      }

      const app = buildApp(unreachableEnv);
      const { status } = await probe(app, '/api/canary', `${SESSION_COOKIE_NAME}=${sessionValue}`);
      expect(status).toBe(503);
    });

    it('answers 401 for an expired session (idle)', async () => {
      const token = await signAccessToken();
      const sessionValue = createSessionIdentifier();
      const client = await db.connect();
      try {
        const deadlines = sessionDeadlines(Date.now());
        await client.query(
          `INSERT INTO backoffice.bff_sessions
             (id_hash, account_sub, access_token, refresh_token, auth_time, acr, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            await hashSessionIdentifier(sessionValue),
            ACCOUNT_ID,
            token,
            null,
            null,
            null,
            // `created_at` hai cửa sổ idle trong quá khứ — absolute (7 ngày)
            // vẫn còn xa nên chỉ idle giết phiên này.
            new Date(deadlines.idleExpiresAtMs - 2 * SESSION_IDLE_SECONDS * 1000),
            new Date(Date.now() - 1_000),
          ],
        );
      } finally {
        await client.end();
      }

      const app = buildApp(envWithDb());
      const { status } = await probe(app, '/api/canary', `${SESSION_COOKIE_NAME}=${sessionValue}`);
      expect(status).toBe(401);
    });
  });
});
