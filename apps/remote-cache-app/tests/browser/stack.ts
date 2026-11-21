/**
 * Full-stack harness cho browser regression của `remote-cache-app`: PostgreSQL
 * thật (container qua docker CLI), migrations + bootstrap tenant qua **CLI vận
 * hành thật** của `remote-cache-api` (tsx subprocess), rồi workerd thật cho cả
 * hai deploy unit (wrangler `createTestHarness`), fake OIDC local cho đường
 * login của BFF.
 *
 * ⚠️ **Deliberate duplication** của
 * `apps/pact-broker-app/tests/integrations/broker-stack.ts` — hai deploy unit,
 * import chéo bị cấm (06-testing.md §6, 05-code-architecture.md §7); hai
 * harness cùng mục đích là có chủ đích. Khác biệt so với bản pact:
 *
 *  1. Control plane `remote-cache-api` xác thực BFF bằng **envelope HMAC nội
 *     bộ** (`INTERNAL_AUTH_SECRET`, ADR-0034) — KHÔNG OIDC trên API worker.
 *     BFF xác thực user bằng phiên OIDC thật qua fake auth local.
 *  2. Seed dữ liệu qua CLI `db/bootstrap-tenant.mts` (tenant + membership +
 *     host project + trusted CI key) — đường provisioning duy nhất cho
 *     membership; project portal-cấp thì seed bằng **public surface** của
 *     control plane (HMAC envelope của member, đúng hợp đồng portal).
 *  3. Public runtimeConfig `remoteCacheTenantName`/`remoteCacheCacheEndpoint`
 *     được cấp qua `vars` của harness (`NUXT_PUBLIC_*`).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// Ký envelope HMAC qua chính lib contracts — test không tự cài lại phép ký,
// cùng một đường code với BFF (import tĩnh: lib này là dependency thật của app).
import { signRequest } from '@ecoma-io/internal-auth-contracts';

/** Root repo — mọi đường dẫn tới project khác resolve từ đây (không import). */
const APP_DIR = resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
const API_DIR = resolve(REPO_ROOT, 'apps/remote-cache-api');

/** Tsx của repo — chạy CLI .mts của API mà không cần dep nào ở project này. */
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

/** `require('wrangler')` — giữ CLI bundle lớn ngoài pipeline transform của vitest. */
const wranglerCli = createRequire(import.meta.url)('wrangler') as typeof import('wrangler');

type TestHarness = Awaited<ReturnType<typeof wranglerCli.createTestHarness>>;

const HD_LOCAL_ENV_PREFIX = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_';

/** Thông số PostgreSQL test — bản sao chữ-số-chữ của harness pact. */
const POSTGRES_IMAGE = 'postgres:17-alpine';
const API_DATABASE = 'db-remote-cache';
const APP_DATABASE = 'db-remote-cache-app';
const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD_ENV = 'REMOTE_CACHE_IT_SUPERUSER_PASSWORD';
const ROLE_PASSWORD_ENV = 'REMOTE_CACHE_IT_ROLE_PASSWORD';
const SUPERUSER_PASSWORD = process.env[SUPERUSER_PASSWORD_ENV] ?? randomBytes(16).toString('hex');
const ROLE_PASSWORD = process.env[ROLE_PASSWORD_ENV] ?? randomBytes(16).toString('hex');
const API_MIGRATOR_ROLE = 'ecoma_remote_cache_migrator';
const API_RUNTIME_ROLE = 'ecoma_remote_cache_runtime';
const APP_MIGRATOR_ROLE = 'ecoma_remote_cache_app_migrator';
const APP_RUNTIME_ROLE = 'ecoma_remote_cache_app_runtime';

/** Secret HMAC dùng chung BFF ↔ control plane (ADR-0034) — sinh mỗi run. */
const INTERNAL_AUTH_SECRET = randomBytes(32).toString('hex');

/** Bootstrap tenant canonical `ecoma` (ADR-0020 Q9) — sub owner + host project. */
const TENANT_NAME = 'ecoma';
const TENANT_OWNER_SUB = 'remote-cache-app-it-owner';
const BOOTSTRAP_PROJECT_NAME = 'host-cache';
const BOOTSTRAP_KEY_PLAINTEXT = `rci_it_${randomBytes(24).toString('hex')}`;

/** Hằng fake OIDC — cùng cấu trúc với harness pact (ADR-0031 §1/§2). */
const FAKE_KEY_ID = 'remote-cache-app-it-key';
const FAKE_AUDIENCE = 'https://api.test.ecoma.io/remote-cache';
const FAKE_CLIENT_ID = 'ecoma-remote-cache-app-it';
const FAKE_SUB = TENANT_OWNER_SUB;

/** Env mang kết quả probe Docker từ `globalSetup` sang từng worker. */
const DOCKER_PROBE_ENV = 'REMOTE_CACHE_APP_DOCKER_PROBE';

/** Probe Docker MỘT lần mỗi lần chạy — cùng luật fail-loud với harness pact. */
export function probeDocker(): Promise<void> {
  const flag = process.env[DOCKER_PROBE_ENV];
  if (flag === 'available') {
    return Promise.resolve();
  }
  if (flag === 'unavailable') {
    throw new Error(
      'Docker is unavailable: remote-cache-app browser suite requires a running Docker daemon; refusing to skip.',
    );
  }
  const cache = globalThis as DockerProbeCache;
  cache.ecomaRemoteCacheAppDockerProbe ??= runDockerProbe();
  return cache.ecomaRemoteCacheAppDockerProbe;
}

interface DockerProbeCache {
  ecomaRemoteCacheAppDockerProbe?: Promise<void>;
}

async function runDockerProbe(): Promise<void> {
  let container: PostgresContainer | undefined;
  let failure: unknown;
  try {
    container = await startPostgresContainer();
  } catch (error) {
    failure = error;
  } finally {
    container?.stop();
  }
  process.env[DOCKER_PROBE_ENV] = failure === undefined ? 'available' : 'unavailable';
  if (failure !== undefined) {
    throw new Error(
      `Docker is unavailable: remote-cache-app browser suite requires a running Docker daemon; refusing to skip.\nCause: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
}

async function waitFor(
  probe: () => Promise<boolean>,
  options: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    let ok: boolean;
    try {
      ok = await probe();
    } catch {
      ok = false;
    }
    if (ok) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${options.label}`);
    }
    await new Promise<void>((done) => {
      setTimeout(done, options.intervalMs ?? 500);
    });
  }
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

interface PostgresContainer {
  readonly name: string;
  readonly port: number;
  stop(): void;
}

/**
 * Số lần thử `docker run` và khoảng nghỉ tăng dần giữa hai lần.
 *
 * Thất bại start **thường là tạm thời**, không phải Docker hỏng: dưới rootless
 * Docker, nhiều container start song song thi nhau chiếm port host qua
 * RootlessKit, và người thua nhận
 * `RootlessKit PortManager.AddPort(): bind: address already in use` — lỗi biến
 * mất ở lần thử sau. Đã đo được ở các harness testcontainers: run song song ba
 * project đỏ 3/5 lần vì lỗi này, trong khi từng project riêng lẻ xanh 100%
 * (pattern `CONTAINER_START_ATTEMPTS` — import chéo deploy unit bị cấm nên
 * copy nguyên tắc, không copy code).
 */
const DOCKER_RUN_ATTEMPTS = 3;
const DOCKER_RUN_BACKOFF_MS = 1_000;

async function startPostgresContainer(): Promise<PostgresContainer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOCKER_RUN_ATTEMPTS; attempt++) {
    try {
      return await startPostgresContainerOnce();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // Chỉ retry lỗi tạm thời của daemon (RootlessKit port-bind); lỗi cấu hình
      // hay lỗi parse port không tự khỏi ở lần sau.
      if (!message.includes('address already in use')) {
        throw error;
      }
    }
    await new Promise<void>((done) => {
      setTimeout(done, DOCKER_RUN_BACKOFF_MS * attempt);
    });
  }
  throw lastError;
}

async function startPostgresContainerOnce(): Promise<PostgresContainer> {
  const name = `remote-cache-app-it-${String(process.pid)}-${String(Date.now())}`;
  const run = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--detach',
      '--name',
      name,
      '-e',
      `POSTGRES_DB=${API_DATABASE}`,
      '-e',
      `POSTGRES_USER=${SUPERUSER}`,
      '-e',
      `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
      '--publish-all',
      POSTGRES_IMAGE,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  // Timeout spawn (kill signal) dat `error` va de `status` null — nem loi
  // RootlessKit-retryable de vong retry o `startPostgresContainer` thu lai.
  if (run.error !== undefined || run.status !== 0 || run.stdout.trim() === '') {
    const reason = run.error !== undefined ? run.error.message : `exit ${String(run.status)}`;
    throw new Error(
      `docker run for the PostgreSQL container failed (${reason}):\n${run.stderr.slice(-1000)}`,
    );
  }
  const stop = (): void => {
    spawnSync('docker', ['rm', '--force', name], { encoding: 'utf8', timeout: 60_000 });
  };
  try {
    const portOutput = spawnSync('docker', ['port', name, '5432'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (portOutput.error !== undefined) {
      throw new Error(`docker port failed for ${name}: ${portOutput.error.message.slice(-500)}`);
    }
    if (portOutput.status !== 0) {
      throw new Error(`docker port failed for ${name}:\n${portOutput.stderr.slice(-500)}`);
    }
    const lastLine = portOutput.stdout.trim().split('\n').at(-1) ?? '';
    const match = /:(\d+)\s*$/u.exec(lastLine);
    if (match === null) {
      throw new Error(`Cannot parse the mapped host port for ${name}: ${lastLine}`);
    }
    const port = Number(match[1]);

    // Đợi readiness THẬT bằng tín hiệu deterministic của chính PostgreSQL: log
    // "database system is ready to accept connections" xuất hiện LẦN THỨ HAI —
    // lần thứ nhất là temp server của initdb tắt đi. Double-probe pg_isready
    // cách quãng 1.5s (bản cũ) là heuristic: dưới tải, cửa sổ temp server có
    // thể dài hơn 1.5s và cả hai probe đều pass vào server tạm → provision
    // chết "the database system is shutting down". PostgreSQL ghi log ra
    // STDERR — `docker logs` tách stream, đọc cả hai.
    const readLogs = (): string => {
      // --tail 200: chỉ cần dòng ready gần cuối; đọc toàn bộ log mỗi vòng poll
      // là overhead tăng tuyến tính với tuổi container. Timeout kích hoạt
      // `error` (status null) — coi như chưa sẵn sàng để vòng poll thử lại.
      const logs = spawnSync('docker', ['logs', '--tail', '200', name], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (logs.error !== undefined) {
        return '';
      }
      // PostgreSQL ghi log ra STDERR — `docker logs` tách stream, đọc cả hai.
      return `${logs.stdout ?? ''}${logs.stderr ?? ''}`;
    };
    await waitFor(
      () => {
        const readyLines =
          readLogs().split('database system is ready to accept connections').length - 1;
        return Promise.resolve(readyLines >= 2);
      },
      { timeoutMs: 120_000, label: 'PostgreSQL readiness (second ready line in docker logs)' },
    );
    return { name, port, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

function psqlSync(containerName: string, sql: string, targetDatabase: string = API_DATABASE): void {
  const result = spawnSync(
    'docker',
    [
      'exec',
      containerName,
      'psql',
      '-U',
      SUPERUSER,
      '-d',
      targetDatabase,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  // Timeout spawn (kill signal) dat `error` va de `status` null — bao ly do that.
  if (result.error !== undefined) {
    throw new Error(`psql in ${containerName} failed to run: ${result.error.message.slice(-500)}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `psql failed (exit ${String(result.status)}):\n` +
        redact(result.stderr.slice(-1000), [SUPERUSER_PASSWORD, ROLE_PASSWORD]),
    );
  }
}

const PROVISIONABLE_ROLE_NAMES: ReadonlySet<string> = new Set([
  API_MIGRATOR_ROLE,
  API_RUNTIME_ROLE,
  APP_MIGRATOR_ROLE,
  APP_RUNTIME_ROLE,
]);

/** Provision CẢ HAI database (mỗi deploy unit một database — invariant 1). */
function provisionDatabases(containerName: string): void {
  const sqlPassword = ROLE_PASSWORD.split("'").join("''");
  for (const role of PROVISIONABLE_ROLE_NAMES) {
    psqlSync(
      containerName,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN
           CREATE ROLE ${role} LOGIN PASSWORD '${sqlPassword}'
             NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
         END IF;
       END $$;`,
    );
  }
  // `CREATE DATABASE` không chạy được trong DO block — kiểm rồi tạo riêng.
  for (const database of [API_DATABASE, APP_DATABASE]) {
    const existing = spawnSync(
      'docker',
      [
        'exec',
        containerName,
        'psql',
        '-U',
        SUPERUSER,
        '-d',
        API_DATABASE,
        '-t',
        '-A',
        '-c',
        `SELECT 1 FROM pg_catalog.pg_database WHERE datname = '${database}'`,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (existing.error !== undefined) {
      throw new Error(
        `psql in ${containerName} failed to run: ${existing.error.message.slice(-500)}`,
      );
    }
    if (existing.status !== 0) {
      throw new Error(
        `psql failed (exit ${String(existing.status)}):\n` +
          redact(existing.stderr.slice(-1000), [SUPERUSER_PASSWORD, ROLE_PASSWORD]),
      );
    }
    if (existing.stdout.trim() !== '1') {
      psqlSync(containerName, `CREATE DATABASE "${database}"`);
    }
  }
  for (const [database, migratorRole, runtimeRole] of [
    [API_DATABASE, API_MIGRATOR_ROLE, API_RUNTIME_ROLE],
    [APP_DATABASE, APP_MIGRATOR_ROLE, APP_RUNTIME_ROLE],
  ] as const) {
    // REVOKE ALL ON SCHEMA public phải chạy đúng database của vòng lặp, không
    // mặc định API db — nếu không APP_DATABASE giữ nguyên default PUBLIC.
    psqlSync(
      containerName,
      `REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC;
       GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${database}" TO ${migratorRole};
       GRANT CONNECT ON DATABASE "${database}" TO ${runtimeRole};
       REVOKE ALL ON SCHEMA public FROM PUBLIC;`.replaceAll('\n', ' '),
      database,
    );
  }
}

/** Fake OIDC `auth` cho đường login của BFF — cùng contract với harness pact. */
export interface FakeOidcAuth {
  readonly issuer: string;
  signAccessToken(sub: string, expiresInSecondsFromNow?: number): Promise<string>;
  stop(): Promise<void>;
}

export async function startFakeOidcAuth(): Promise<FakeOidcAuth> {
  const keyPair = await generateKeyPair('ES256', { extractable: true });
  const jwk = {
    kid: FAKE_KEY_ID,
    alg: 'ES256',
    use: 'sig',
    ...(await exportJWK(keyPair.publicKey)),
  };
  const server: Server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    if (path === '/jwks.json' || path === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (path === '/authorize') {
      const target = new URL(req.url ?? '/', 'http://127.0.0.1');
      const redirectUri = target.searchParams.get('redirect_uri');
      const state = target.searchParams.get('state');
      if (redirectUri === null || state === null) {
        res.writeHead(400);
        res.end();
        return;
      }
      const next = new URL(redirectUri);
      if (next.hostname === '127.0.0.1' && next.protocol === 'https:') {
        next.protocol = 'http:';
      }
      next.searchParams.set('code', 'it-auth-code');
      next.searchParams.set('state', state);
      res.writeHead(302, { location: next.toString() });
      res.end();
      return;
    }
    if (path === '/revocation' && req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (path === '/token' && req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        void (async (): Promise<void> => {
          const accessToken = await signAccessToken(FAKE_SUB);
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(
            JSON.stringify({
              access_token: accessToken,
              token_type: 'Bearer',
              expires_in: 300,
              refresh_token: randomBytes(32).toString('base64url'),
              scope: 'openid offline_access',
            }),
          );
        })().catch(() => {
          if (!res.headersSent) {
            res.writeHead(500);
          }
          res.end();
        });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('fake auth server did not bind a port');
  }
  const issuer = `http://127.0.0.1:${String(address.port)}`;

  async function signAccessToken(sub: string, expiresInSecondsFromNow = 300): Promise<string> {
    return new SignJWT({
      scope: 'openid offline_access',
      client_id: FAKE_CLIENT_ID,
      jti: randomBytes(8).toString('hex'),
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: FAKE_KEY_ID })
      .setIssuer(issuer)
      .setAudience(FAKE_AUDIENCE)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSecondsFromNow)
      .sign(keyPair.privateKey);
  }

  return {
    issuer,
    signAccessToken,
    stop: async (): Promise<void> => {
      await new Promise<void>((done) => {
        server.close(() => done());
      });
    },
  };
}

function runCliScript(
  scriptRelativePath: string,
  env: Record<string, string>,
  opts: { cwd?: string; tsconfig?: string } = {},
): void {
  const args = opts.tsconfig === undefined ? [] : ['--tsconfig', opts.tsconfig];
  args.push(resolve(REPO_ROOT, scriptRelativePath));
  const result = spawnSync(TSX_BIN, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail =
      result.error?.message ?? `${result.stderr ?? ''}\n${result.stdout ?? ''}`.slice(-2000);
    throw new Error(
      `CLI script ${scriptRelativePath} failed (exit ${String(result.status ?? 'spawn-error')}):\n` +
        redact(detail, Object.values(env)),
    );
  }
}

/**
 * Gọi public surface portal của control plane bằng envelope HMAC mang actor
 * sub của member — đúng đường BFF thật đi, chỉ thiếu phiên.
 */
export async function portalApi(
  apiUrl: string,
  actorSub: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const method = init.method ?? 'GET';
  const bodyBytes =
    init.body === undefined ? null : new TextEncoder().encode(JSON.stringify(init.body));
  const headers: Record<string, string> = {
    ...(await signRequest({
      method,
      path,
      ...(bodyBytes === null ? {} : { body: bodyBytes }),
      secret: INTERNAL_AUTH_SECRET,
      actorSub,
      timestamp: String(Math.floor(Date.now() / 1000)),
    })),
  };
  if (bodyBytes !== null) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers,
    ...(bodyBytes === null ? {} : { body: bodyBytes as BodyInit }),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

interface StartedWorker {
  readonly harness: TestHarness;
  readonly origin: string;
}

function hdEnvName(binding: string): string {
  return `${HD_LOCAL_ENV_PREFIX}${binding}`;
}

/** Boot workerd cho control plane — Hyperdrive local + HMAC secret. */
async function startApiWorker(
  runtimeConnectionString: string,
): Promise<StartedWorker & { restoreHdEnv(): void }> {
  const hdEnv = hdEnvName('DB_REMOTE_CACHE');
  const saved = { had: hdEnv in process.env, value: process.env[hdEnv] };
  const restoreHdEnv = (): void => {
    if (saved.had) {
      process.env[hdEnv] = saved.value;
    } else {
      Reflect.deleteProperty(process.env, hdEnv);
    }
  };
  let harness: TestHarness | undefined;
  try {
    process.env[hdEnv] = runtimeConnectionString;
    harness = wranglerCli.createTestHarness({
      root: API_DIR,
      workers: [
        {
          configPath: resolve(API_DIR, 'wrangler.jsonc'),
          vars: {
            INTERNAL_AUTH_SECRET,
            REMOTE_CACHE_AUTH_ISSUER: 'unused',
            REMOTE_CACHE_AUTH_AUDIENCE: FAKE_AUDIENCE,
          },
        },
      ],
    });
    const { url } = await harness.listen();
    await waitFor(async () => (await fetch(`${url.origin}/health`)).status === 200, {
      timeoutMs: 120_000,
      label: 'remote-cache-api /health',
    });
    return { harness, origin: url.origin, restoreHdEnv };
  } catch (error) {
    await harness?.close().catch(() => undefined);
    restoreHdEnv();
    throw error;
  }
}

/**
 * Boot workerd cho app BFF — config inline mirror `wrangler.jsonc`, OIDC fake +
 * HMAC secret + base URL control plane qua `vars`, public runtimeConfig tenant
 * qua `NUXT_PUBLIC_*`.
 */
async function startAppWorker(
  apiOrigin: string,
  authIssuer: string,
  appDbConnectionString: string,
): Promise<StartedWorker & { restoreHdEnv(): void }> {
  const hdEnv = hdEnvName('DB_REMOTE_CACHE_APP');
  const saved = { had: hdEnv in process.env, value: process.env[hdEnv] };
  const restoreHdEnv = (): void => {
    if (saved.had) {
      process.env[hdEnv] = saved.value;
    } else {
      Reflect.deleteProperty(process.env, hdEnv);
    }
  };
  let harness: TestHarness | undefined;
  try {
    process.env[hdEnv] = appDbConnectionString;
    harness = wranglerCli.createTestHarness({
      root: APP_DIR,
      workers: [
        {
          config: {
            name: 'ecoma-remote-cache-app-it',
            main: resolve(APP_DIR, '.output/server/index.mjs'),
            compatibility_date: '2026-10-05',
            compatibility_flags: ['nodejs_compat'],
            assets: {
              directory: resolve(APP_DIR, '.output/public'),
              binding: 'ASSETS',
              not_found_handling: 'none',
              run_worker_first: ['/api/*', '/health', '/ready'],
            },
            vars: {
              NITRO_REMOTE_CACHE_API_BASE_URL: apiOrigin,
              REMOTE_CACHE_API_BASE_URL: apiOrigin,
              REMOTE_CACHE_AUTH_ISSUER: authIssuer,
              REMOTE_CACHE_AUTH_AUDIENCE: FAKE_AUDIENCE,
              REMOTE_CACHE_AUTH_CLIENT_ID: FAKE_CLIENT_ID,
              INTERNAL_AUTH_SECRET,
              NUXT_PUBLIC_REMOTE_CACHE_TENANT_NAME: TENANT_NAME,
              NUXT_PUBLIC_REMOTE_CACHE_CACHE_ENDPOINT: `https://cache.test.ecoma.io`,
            },
            hyperdrive: [
              {
                binding: 'DB_REMOTE_CACHE_APP',
                id: '00000000000000000000000000000000',
              },
            ],
          },
        },
      ],
    });
    const { url } = await harness.listen();
    await waitFor(async () => (await fetch(`${url.origin}/health`)).status === 200, {
      timeoutMs: 120_000,
      label: 'remote-cache-app /health',
    });
    return { harness, origin: url.origin, restoreHdEnv };
  } catch (error) {
    await harness?.close().catch(() => undefined);
    restoreHdEnv();
    throw error;
  }
}

/** Full stack đang chạy cho một suite — caller PHẢI gọi `close()` trong `afterAll`. */
export interface RemoteCacheStack {
  readonly appUrl: string;
  readonly apiUrl: string;
  /** Secret HMAC của run — chỉ để assert KHÔNG xuất hiện trên wire browser. */
  readonly internalAuthSecret: string;
  /** Plaintext key trusted CI của bootstrap — assert không bao giờ render. */
  readonly bootstrapKeyPlaintext: string;
  /** Gọi portal control plane bằng envelope HMAC của một actor sub. */
  portalApi(
    actorSub: string,
    path: string,
    init?: { method?: 'GET' | 'POST'; body?: unknown },
  ): Promise<{ status: number; body: unknown }>;
  /** Đăng nhập một phiên user thật qua đường OIDC của BFF. */
  loginSession(): Promise<RemoteCacheSession>;
  close(): Promise<void>;
}

/** Một phiên BFF đã đăng nhập — cookie + CSRF pair cho fetch `/api/**`. */
export interface RemoteCacheSession {
  readonly cookieHeader: string;
  readonly csrfToken: string;
  readonly csrfHeaderName: string;
  readonly setCookies: readonly string[];
}

function assertHostCookieFlags(cookie: string, label: string): void {
  if (!cookie.startsWith('__Host-')) {
    throw new Error(`${label} is not a __Host- cookie: ${cookie.split(';')[0]?.split('=')[0]}`);
  }
  for (const flag of ['Path=/', 'Secure', 'SameSite=Lax'] as const) {
    if (!cookie.includes(flag)) {
      throw new Error(`${label} is missing the ${flag} flag`);
    }
  }
}

export async function loginSession(appUrl: string): Promise<RemoteCacheSession> {
  const login = await fetch(`${appUrl}/api/auth/login`, { redirect: 'manual' });
  if (login.status !== 302) {
    throw new Error(`login route expected 302, got ${String(login.status)}`);
  }
  const location = login.headers.get('location');
  if (location === null) {
    throw new Error('login redirect is missing the Location header');
  }
  const state = new URL(location).searchParams.get('state');
  if (state === null || state === '') {
    throw new Error('authorize URL is missing the state parameter');
  }
  const flowCookie = login.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('__Host-remote-cache-app-login='));
  if (flowCookie === undefined) {
    throw new Error('login route did not set the one-time flow cookie');
  }

  const callback = await fetch(
    `${appUrl}/api/auth/callback?code=${encodeURIComponent('it-auth-code')}&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', headers: { cookie: flowCookie.split(';')[0] ?? '' } },
  );
  if (callback.status !== 302) {
    throw new Error(`callback expected 302, got ${String(callback.status)}`);
  }
  const setCookies = callback.headers.getSetCookie();
  const sessionCookie = setCookies.find((cookie) =>
    cookie.startsWith('__Host-remote-cache-app-session='),
  );
  const csrfCookie = setCookies.find((cookie) =>
    cookie.startsWith('__Host-remote-cache-app-csrf='),
  );
  if (sessionCookie === undefined || csrfCookie === undefined) {
    throw new Error('callback did not set both the session and the csrf cookies');
  }
  assertHostCookieFlags(sessionCookie, 'session cookie');
  assertHostCookieFlags(csrfCookie, 'csrf cookie');
  if (!sessionCookie.includes('HttpOnly')) {
    throw new Error('session cookie is missing HttpOnly');
  }

  const pair = [sessionCookie, csrfCookie].map((cookie) => cookie.split(';')[0] ?? '');
  return {
    cookieHeader: pair.join('; '),
    csrfToken: (csrfCookie.split(';')[0] ?? '').split('=').slice(1).join('='),
    csrfHeaderName: 'x-ecoma-csrf',
    setCookies,
  };
}

/**
 * Dựng full stack: container PostgreSQL → provision hai database → migrations
 * cả hai unit → bootstrap tenant → fake OIDC → workerd API → workerd app →
 * seed một project portal-cấp qua public surface → probe composition bằng một
 * phiên user thật.
 */
export async function startRemoteCacheStack(): Promise<RemoteCacheStack> {
  await probeDocker();
  const postgres = await startPostgresContainer();
  let api: (StartedWorker & { restoreHdEnv(): void }) | undefined;
  let app: (StartedWorker & { restoreHdEnv(): void }) | undefined;
  let fakeAuth: FakeOidcAuth | undefined;
  try {
    provisionDatabases(postgres.name);

    const apiMigratorUrl =
      `postgres://${API_MIGRATOR_ROLE}:${ROLE_PASSWORD}@127.0.0.1:${String(postgres.port)}/` +
      API_DATABASE;
    const apiRuntimeUrl =
      `postgres://${API_RUNTIME_ROLE}:${ROLE_PASSWORD}@127.0.0.1:${String(postgres.port)}/` +
      API_DATABASE;
    const appMigratorUrl =
      `postgres://${APP_MIGRATOR_ROLE}:${ROLE_PASSWORD}@127.0.0.1:${String(postgres.port)}/` +
      APP_DATABASE;
    const appRuntimeUrl =
      `postgres://${APP_RUNTIME_ROLE}:${ROLE_PASSWORD}@127.0.0.1:${String(postgres.port)}/` +
      APP_DATABASE;

    // Cutover #377: apply qua runner của migration authority (advisory lock +
    // guard current_database()); app không còn runner bản sao.
    runCliScript(
      'deploys/remote-cache-db/runner.mts',
      { DATABASE_URL: apiMigratorUrl },
      { cwd: resolve(REPO_ROOT, 'deploys/remote-cache-db'), tsconfig: 'tsconfig.db.json' },
    );
    runCliScript(
      'deploys/remote-cache-app-db/runner.mts',
      { DATABASE_URL: appMigratorUrl },
      { cwd: resolve(REPO_ROOT, 'deploys/remote-cache-app-db'), tsconfig: 'tsconfig.db.json' },
    );
    runCliScript('apps/remote-cache-api/db/bootstrap-tenant.mts', {
      DATABASE_URL: apiMigratorUrl,
      CANONICAL_TENANT_OWNER_SUB: TENANT_OWNER_SUB,
      REMOTE_CACHE_BOOTSTRAP_PROJECT_NAME: BOOTSTRAP_PROJECT_NAME,
      REMOTE_CACHE_BOOTSTRAP_KEY_SCOPES: 'read write',
      REMOTE_CACHE_BOOTSTRAP_KEY_PLAINTEXT: BOOTSTRAP_KEY_PLAINTEXT,
    });

    fakeAuth = await startFakeOidcAuth();
    api = await startApiWorker(apiRuntimeUrl);
    app = await startAppWorker(api.origin, fakeAuth.issuer, appRuntimeUrl);

    // Seed một project portal-cấp bằng envelope HMAC của owner — đúng đường
    // BFF thật đi; chứng minh ngay lúc setup rằng wire portal hoạt động.
    const seeded = await portalApi(
      api.origin,
      TENANT_OWNER_SUB,
      `/tenants/${TENANT_NAME}/projects`,
      { method: 'POST', body: { name: 'seeded-cache' } },
    );
    if (seeded.status !== 201) {
      const logs = api.harness
        .getLogs()
        .map((log) => `${log.level}: ${log.message}`)
        .join('\n');
      throw new Error(
        `Seeding the portal project failed with status ${String(seeded.status)}: ${JSON.stringify(seeded.body)}\nAPI worker logs:\n${logs}`,
      );
    }

    // Probe composition: một phiên user thật phải đọc được project qua BFF.
    const session = await loginSession(app.origin);
    const bffProbe = await fetch(`${app.origin}/api/portal/tenants/${TENANT_NAME}/projects`, {
      headers: { cookie: session.cookieHeader },
    });
    const bffBody = await bffProbe.text();
    if (bffProbe.status !== 200) {
      const logs = app.harness
        .getLogs()
        .map((log) => `${log.level}: ${log.message}`)
        .join('\n');
      throw new Error(
        `BFF probe expected 200, got ${String(bffProbe.status)}\nBody: ${bffBody}\nApp worker logs:\n${logs}`,
      );
    }

    const startedApi = api;
    const startedApp = app;
    const startedFakeAuth = fakeAuth;
    return {
      appUrl: startedApp.origin,
      apiUrl: startedApi.origin,
      internalAuthSecret: INTERNAL_AUTH_SECRET,
      bootstrapKeyPlaintext: BOOTSTRAP_KEY_PLAINTEXT,
      portalApi: (actorSub, path, init) => portalApi(startedApi.origin, actorSub, path, init),
      loginSession: (): Promise<RemoteCacheSession> => loginSession(startedApp.origin),
      close: async (): Promise<void> => {
        await startedApp.harness.close().catch(() => undefined);
        await startedApi.harness.close().catch(() => undefined);
        await startedFakeAuth.stop().catch(() => undefined);
        startedApp.restoreHdEnv();
        startedApi.restoreHdEnv();
        postgres.stop();
      },
    };
  } catch (error) {
    await app?.harness.close().catch(() => undefined);
    if (api !== undefined) {
      await api.harness.close().catch(() => undefined);
      api.restoreHdEnv();
    }
    if (app !== undefined) {
      app.restoreHdEnv();
    }
    await fakeAuth?.stop().catch(() => undefined);
    postgres.stop();
    throw error;
  }
}
