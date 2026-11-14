/**
 * Full-stack harness cho suite app-owned của `pact-broker-app`: PostgreSQL
 * thật (container qua docker CLI), migrations + bootstrap tenant + machine
 * token qua **CLI vận hành thật** của `pact-broker-api` (tsx subprocess), rồi
 * workerd thật cho cả hai deploy unit (wrangler `createTestHarness`), dữ liệu
 * seed qua **public surface** của API.
 *
 * ⚠️ **Deliberate duplication** của
 * `apps/pact-broker-api/tests/integrations/harness.ts` — đây là hai deploy
 * unit, import chéo bị cấm bởi module-boundary rules (06-testing.md §6,
 * 05-code-architecture.md §7), nên hai harness cùng mục đích là có chủ đích,
 * không phải nợ kỹ thuật. Khác biệt có chủ đích so với bản của API:
 *
 *  1. Container PostgreSQL dựng bằng **docker CLI** (`spawnSync`) thay vì
 *     `@testcontainers/postgresql` — project này không khai dep đó và thêm
 *     một dep dùng một lần cho suite là nợ; docker CLI cho cùng một dependency
 *     thật (cùng image, cùng daemon). Probe Docker (§6) cũng dùng chính container
 *     PostgreSQL này — một runner không có Docker daemon sẽ ĐỎ ngay tại
 *     `globalSetup`, không có đường skip.
 *  2. Migrations/bootstrap/token chạy qua **subprocess** của các CLI vận hành
 *     được tài liệu hoá (`db/apply.mts`, `db/bootstrap-tenant.mts`,
 *     `db/provision-machine-token.mts`) — đường dẫn FILE, không import code
 *     app→app; `pg` được resolve từ node_modules của API bên trong subprocess
 *     (cùng pattern path-read mà harness của `auth-nonce-prune-job` dùng cho
 *     thư mục migration). Credential chỉ đi qua **env** của subprocess, không
 *     bao giờ qua argv (cùng kỷ luật với superadmin-resolver của lane).
 *
 * Consumer-side contract test (§7) và browser regression dùng harness này:
 * BFF gọi API server-side qua `NITRO_PACT_BROKER_API_*` (test-only `vars`
 * override của `createTestHarness`, tách kênh như production — base URL qua
 * vars, cấu hình OIDC qua `PACT_BROKER_AUTH_*`), và xác thực BFF bằng **phiên
 * user thật** qua fake OIDC local (ADR-0031 §1–§4) — KHÔNG có machine token
 * nào của BFF (retire, ADR-0031 §5); token machine duy nhất trong stack là
 * seed của Pact CLI/CI dùng để seed dữ liệu qua public surface của API.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/** Root repo — mọi đường dẫn tới project khác resolve từ đây (không import). */
const APP_DIR = resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
const API_DIR = resolve(REPO_ROOT, 'apps/pact-broker-api');

/** Tsx của repo — chạy CLI .mts của API mà không cần dep nào ở project này. */
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

/**
 * `require('wrangler')` thay vì `await import`: CLI bundle lớn, giữ ngoài
 * pipeline transform của vitest (tiền lệ của `worker-runtime.spec.ts`).
 */
const wranglerCli = createRequire(import.meta.url)('wrangler') as typeof import('wrangler');

type TestHarness = Awaited<ReturnType<typeof wranglerCli.createTestHarness>>;

/**
 * Biến môi trường của Hyperdrive local emulation — phải được đặt TRƯỚC khi
 * `createTestHarness` của API được dựng (giá trị được đọc lúc binding dựng),
 * cùng luật với `apps/pact-broker-api/tests/integrations/worker-runtime.spec.ts`.
 */
const HD_LOCAL_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE';

/**
 * Thông số PostgreSQL test — bản sao chữ-số-chữ của harness API (deliberate
 * duplication): image 17-alpine, database đúng tên production, superuser test.
 *
 * Mật khẩu test KHÔNG là hằng số trong source: sinh ngẫu nhiên mỗi run (hex)
 * hoặc đọc từ env để debug một stack đã chạy — credential chỉ sống trong
 * container `--rm` bị ném đi sau mỗi run, và mọi đường đưa ra ngoài (error)
 * đều qua `redact`.
 */
const POSTGRES_IMAGE = 'postgres:17-alpine';
const PACT_BROKER_DATABASE = 'db-pact-broker';
const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD_ENV = 'PACT_BROKER_IT_SUPERUSER_PASSWORD';
const ROLE_PASSWORD_ENV = 'PACT_BROKER_IT_ROLE_PASSWORD';
const SUPERUSER_PASSWORD = process.env[SUPERUSER_PASSWORD_ENV] ?? randomBytes(16).toString('hex');
const ROLE_PASSWORD = process.env[ROLE_PASSWORD_ENV] ?? randomBytes(16).toString('hex');
const MIGRATOR_ROLE = 'ecoma_pact_broker_migrator';
const RUNTIME_ROLE = 'ecoma_pact_broker_runtime';

/**
 * Database riêng của app (ADR-0031 §2, #206) + hai role của nó — stack này
 * provision CẢ HAI database trong cùng container, đúng hình hai deploy unit
 * sở hữu database riêng trên lane.
 */
const APP_DATABASE = 'db-pact-broker-app';
const APP_MIGRATOR_ROLE = 'ecoma_pact_broker_app_migrator';
const APP_RUNTIME_ROLE = 'ecoma_pact_broker_app_runtime';

/**
 * Machine token **seed** — đại diện machine path của Pact CLI/CI (đường hợp
 * lệ vẫn tồn tại, ADR-0031 §5), KHÔNG phải credential của BFF: token của BFF
 * đã retire, và suite BFF auth assert không token máy nào xuất hiện trong
 * traffic/cookie của app.
 */
const SEED_TOKEN_NAME = 'seed-publisher-cli';
const SEED_TOKEN_SCOPES = 'admin';
const TENANT_OWNER_SUB = 'pact-broker-app-it-owner';

/**
 * Hằng fake OIDC (ADR-0031 §1/§2): `kid` của ES256 test key, audience mà API
 * ghim, `client_id` của client public test. Issuer là origin động của server
 * HTTP local (`http://127.0.0.1:<port>`) — cả API (verify JWKS qua
 * `/.well-known/jwks.json`) lẫn BFF (verify qua `/jwks.json`, exchange qua
 * `/token`) fetch được trực tiếp từ workerd.
 */
const FAKE_KEY_ID = 'pact-broker-app-it-key';
const FAKE_AUDIENCE = 'https://api.test.ecoma.io/pact-broker';
const FAKE_CLIENT_ID = 'ecoma-pact-broker-app-it';
const FAKE_SUB = TENANT_OWNER_SUB;

/**
 * Biến môi trường mang kết quả probe Docker từ `globalSetup` sang từng worker
 * — `globalSetup` chạy một lần trong main process, worker fork kế thừa
 * `process.env` (cùng cơ chế với harness của API).
 */
const DOCKER_PROBE_ENV = 'PACT_BROKER_APP_DOCKER_PROBE';

/** Docker có dùng được không — probe MỘT lần mỗi lần chạy vitest (§6). */
export function probeDocker(): Promise<void> {
  const flag = process.env[DOCKER_PROBE_ENV];
  if (flag === 'available') {
    return Promise.resolve();
  }
  if (flag === 'unavailable') {
    throw new Error(
      'Docker is unavailable: pact-broker-app integration suites require a running Docker daemon; refusing to skip.',
    );
  }
  const cache = globalThis as DockerProbeCache;
  cache.ecomaPactBrokerAppDockerProbe ??= runDockerProbe();
  return cache.ecomaPactBrokerAppDockerProbe;
}

interface DockerProbeCache {
  ecomaPactBrokerAppDockerProbe?: Promise<void>;
}

/**
 * Probe bằng **chính** container PostgreSQL mà suite sắp dùng (không phải
 * `docker info` rẻ tiền — runner thiếu socket vẫn có thể exit 0). Probe thất
 * bại là NÉM: suite bắt buộc Docker phải đỏ, skip với exit 0 không phải kết
 * quả chấp nhận được (06-testing.md §6).
 */
async function runDockerProbe(): Promise<void> {
  let container: PostgresContainer | undefined;
  let failure: unknown;
  try {
    container = await startPostgresContainer();
  } catch (error) {
    failure = error;
  } finally {
    // stop() là cleanup, có thể tự ném — nuốt để không che lỗi thật của probe.
    container?.stop();
  }
  process.env[DOCKER_PROBE_ENV] = failure === undefined ? 'available' : 'unavailable';
  if (failure !== undefined) {
    // Nguyên nhân gốc phải hiện ra — "Docker unavailable" mà giấu lỗi docker
    // là chẩn đoán mù (đã từng mất 1 lần chạy chỉ vì giấu lỗi này).
    throw new Error(
      `Docker is unavailable: pact-broker-app integration suites require a running Docker daemon; refusing to skip.\nCause: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
}

/** Poll một điều kiện tới khi đúng hoặc hết ngân sách — lỗi probe là retry, hết giờ là ném. */
async function waitFor(
  probe: () => Promise<boolean>,
  options: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    // Khai báo không khởi tạo: try/catch luôn gán trước khi đọc — khởi tạo
    // `false` ở đây là assignment vô dụng (no-useless-assignment).
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

/** Xoá mọi occurrence của các giá trị nhạy cảm khỏi text trước khi đưa vào lỗi. */
function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

/** Container PostgreSQL đang chạy trên host — port đã map qua docker CLI. */
interface PostgresContainer {
  readonly name: string;
  readonly port: number;
  /** `docker rm --force` — container chạy với `--rm` nên stop là xoá sạch. */
  stop(): void;
}

/** Dựng container PostgreSQL thật và chờ `pg_isready` sẵn sàng nhận kết nối. */
async function startPostgresContainer(): Promise<PostgresContainer> {
  const name = `pact-broker-app-it-${String(process.pid)}-${String(Date.now())}`;
  const run = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--detach',
      '--name',
      name,
      '-e',
      `POSTGRES_DB=${PACT_BROKER_DATABASE}`,
      '-e',
      `POSTGRES_USER=${SUPERUSER}`,
      '-e',
      `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
      '--publish-all',
      POSTGRES_IMAGE,
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0 || run.stdout.trim() === '') {
    throw new Error(
      `docker run for the PostgreSQL container failed (exit ${String(run.status)}):\n${run.stderr.slice(-1000)}`,
    );
  }
  const stop = (): void => {
    spawnSync('docker', ['rm', '--force', name], { encoding: 'utf8' });
  };
  try {
    const portOutput = spawnSync('docker', ['port', name, '5432'], { encoding: 'utf8' });
    if (portOutput.status !== 0) {
      throw new Error(`docker port failed for ${name}:\n${portOutput.stderr.slice(-500)}`);
    }
    // Dòng cuối mang port host (`0.0.0.0:NNNN` hoặc `[::]:NNNN`).
    const lastLine = portOutput.stdout.trim().split('\n').at(-1) ?? '';
    const match = /:(\d+)\s*$/u.exec(lastLine);
    if (match === null) {
      throw new Error(`Cannot parse the mapped host port for ${name}: ${lastLine}`);
    }
    const port = Number(match[1]);

    // Đợi readiness THẬT: cửa sổ server TẠM của init (initdb → server tạm →
    // shutdown → server thật) cũng trả pg_isready 0 — provision psql rơi vào
    // đúng lúc shutdown là FATAL "the database system is shutting down". Hai
    // probe cách quãng 1.5s phải cùng sẵn sàng mới coi là readiness thật
    // (spawnSync inline, không hàm lồng — unicorn/consistent-function-scoping).
    const pgIsReady = (): boolean =>
      spawnSync(
        'docker',
        ['exec', name, 'pg_isready', '-U', SUPERUSER, '-d', PACT_BROKER_DATABASE],
        { encoding: 'utf8' },
      ).status === 0;
    await waitFor(
      async () => {
        if (!pgIsReady()) {
          return false;
        }
        await new Promise<void>((done) => {
          setTimeout(done, 1_500);
        });
        return pgIsReady();
      },
      { timeoutMs: 120_000, label: 'PostgreSQL readiness (pg_isready x2 across init shutdown)' },
    );
    return { name, port, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

/** Chạy một câu SQL bằng psql trong container với superuser (không qua shell). */
function psqlSync(containerName: string, sql: string): void {
  const result = spawnSync(
    'docker',
    [
      'exec',
      containerName,
      'psql',
      '-U',
      SUPERUSER,
      '-d',
      PACT_BROKER_DATABASE,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    // psql in lại SQL lỗi (context LINE n) — với DO $$ CREATE ROLE thì SQL đó
    // chứa mật khẩu role, phải redact trước khi đưa vào error (cùng luật với
    // `runApiCliScript`).
    throw new Error(
      `psql failed (exit ${String(result.status)}):\n` +
        redact(result.stderr.slice(-1000), [SUPERUSER_PASSWORD, ROLE_PASSWORD]),
    );
  }
}

/**
 * Allowlist role được phép nội suy vào SQL — PostgreSQL không bind được
 * placeholder cho identifier (`CREATE ROLE <name>`) nên interpolation là bắt
 * buộc; property an toàn đến từ việc chỉ hai hằng số module-level này được
 * chấp nhận, không bao giờ từ input động.
 */
const PROVISIONABLE_ROLE_NAMES: ReadonlySet<string> = new Set([
  MIGRATOR_ROLE,
  RUNTIME_ROLE,
  APP_MIGRATOR_ROLE,
  APP_RUNTIME_ROLE,
]);

/**
 * Provision role LOGIN cho migrator/runtime bằng superuser — đúng khối
 * `provision()` của harness API (migration `0001` chỉ tạo guard NOLOGIN, role
 * kết nối thật phải do admin tạo + grant trước khi migration chạy).
 */
function provisionRoles(containerName: string): void {
  // Password nội suy vào SQL literal — escape `'` thành `''` trước (giá trị
  // mặc định là hex nên không chứa quote, nhưng giá trị override từ env thì có
  // thể; `psql -c` không bind được placeholder cho literal).
  const sqlPassword = ROLE_PASSWORD.split("'").join("''");
  for (const role of [MIGRATOR_ROLE, RUNTIME_ROLE]) {
    // Ghim allowlist trước khi nội suy (xem `PROVISIONABLE_ROLE_NAMES`).
    if (!PROVISIONABLE_ROLE_NAMES.has(role)) {
      throw new Error(`Refusing to interpolate a non-allowlisted role name into SQL: ${role}`);
    }
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
  psqlSync(
    containerName,
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${PACT_BROKER_DATABASE}" TO ${MIGRATOR_ROLE}`,
  );
  psqlSync(containerName, `GRANT CONNECT ON DATABASE "${PACT_BROKER_DATABASE}" TO ${RUNTIME_ROLE}`);
}

/**
 * Provision database riêng của app (ADR-0031 §2, #206) trong cùng container:
 * hai role `ecoma_pact_broker_app_{migrator,runtime}` + database
 * `db-pact-broker-app` + grant per-role — cùng khối lệnh với provision script
 * của `deploys/pact-broker-app-deploy` (`scripts.ts`). Superuser chạy mọi lệnh
 * (không bước ALTER password vì role tạo sẵn đúng password của run).
 */
function provisionAppDatabase(containerName: string): void {
  const sqlPassword = ROLE_PASSWORD.split("'").join("''");
  for (const role of [APP_MIGRATOR_ROLE, APP_RUNTIME_ROLE]) {
    if (!PROVISIONABLE_ROLE_NAMES.has(role)) {
      throw new Error(`Refusing to interpolate a non-allowlisted role name into SQL: ${role}`);
    }
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
  // `CREATE DATABASE` KHÔNG chạy được trong DO block (PostgreSQL: không
  // được thực thi trong transaction/function) — nên kiểm tra tồn tại bằng một
  // lệnh SELECT riêng, rồi mới CREATE ở lệnh sau.
  const existing = spawnSync(
    'docker',
    [
      'exec',
      containerName,
      'psql',
      '-U',
      SUPERUSER,
      '-d',
      PACT_BROKER_DATABASE,
      '-t',
      '-A',
      '-c',
      `SELECT 1 FROM pg_catalog.pg_database WHERE datname = '${APP_DATABASE}'`,
    ],
    { encoding: 'utf8' },
  );
  if (existing.status !== 0) {
    throw new Error(
      `psql failed (exit ${String(existing.status)}):\n` +
        redact(existing.stderr.slice(-1000), [SUPERUSER_PASSWORD, ROLE_PASSWORD]),
    );
  }
  if (existing.stdout.trim() !== '1') {
    psqlSync(containerName, `CREATE DATABASE "${APP_DATABASE}"`);
  }
  psqlSync(
    containerName,
    `REVOKE CONNECT ON DATABASE "${APP_DATABASE}" FROM PUBLIC;
     GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${APP_DATABASE}" TO ${APP_MIGRATOR_ROLE};
     GRANT CONNECT ON DATABASE "${APP_DATABASE}" TO ${APP_RUNTIME_ROLE};
     REVOKE ALL ON SCHEMA public FROM PUBLIC;`.replaceAll('\n', ' '),
  );
}

/**
 * Fake OIDC `auth` cho đường BFF (ADR-0031 §2) và đường API (§1): ES256 keypair
 * test, JWKS phục vụ ở CẢ HAI path mà hai phía fetch (`/jwks.json` của BFF và
 * `/.well-known/jwks.json` của API), `/token` cấp access token ký sẵn + refresh
 * token opaque cho MỌI authorization code (code-CAS thuộc `auth` thật; fake này
 * chỉ cần cấp token hợp lệ để callback đi hết đường verify thật).
 */
export interface FakeOidcAuth {
  readonly issuer: string;
  /** Ký access token đúng contract verify của hai phía (`at+jwt`, ES256, iss/aud/sub/exp). */
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
      // `auth` thật trả 302 về `redirect_uri` kèm code single-use. Fake cấp code
      // cố định cho MỌI request: nó cho phép trình duyệt đi trọn luồng login →
      // callback thật (state + PKCE vẫn được BFF kiểm), mà không dựng code store.
      const target = new URL(req.url ?? '/', 'http://127.0.0.1');
      const redirectUri = target.searchParams.get('redirect_uri');
      const state = target.searchParams.get('state');
      if (redirectUri === null || state === null) {
        res.writeHead(400);
        res.end();
        return;
      }
      const next = new URL(redirectUri);
      // workerd harness phục vụ plain HTTP và KHÔNG gửi `x-forwarded-proto`,
      // nên BFF dựng `redirect_uri` theo mặc định `https`. `auth` thật không
      // được sửa redirect_uri (exact-match), nhưng trình duyệt của suite này
      // điều hướng trên `http://127.0.0.1` — fake hạ scheme cho host loopback
      // để luồng login chạy được; mọi thứ còn lại (state, code) giữ nguyên.
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
      // RFC 7009 endpoint của `auth` — logout gọi best-effort trước khi hủy
      // phiên. Fake luôn 200: hành vi logout không phụ thuộc kết quả này, và
      // test cần log sạch để không bị đọc nhầm là lỗi.
      req.resume();
      req.on('end', () => {
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (path === '/token' && req.method === 'POST') {
      // Body không được đọc nội dung — chỉ drain để request kết thúc.
      req.resume();
      req.on('end', () => {
        // Fire-and-forget có đuôi (review #254): lỗi của `signAccessToken` hay
        // của `res.*` (client ngắt kết nối giữa chừng) bị nuốt — harness test
        // không được biến lỗi dọn dẹp thành unhandled rejection làm đỏ vitest.
        // `res.headersSent` chặn double-response khi lỗi đến sau khi đã gửi.
        void (async (): Promise<void> => {
          // Mã code/verifier KHÔNG được kiểm ở đây: mã code là single-use CAS
          // ở `auth` thật — fake không có code store; callback BFF vẫn chạy
          // đúng đường verify offline (ES256 + iss/aud/exp) trước khi lập
          // phiên, nên token "miễn phí" vẫn không vượt qua phép verify.
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
  // Port chụp vào hằng: closure `signAccessToken` dùng sau khi hàm đã trả, mà
  // `address` là biến `const` mà TS không narrow được trong closure.
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

/**
 * Chạy một CLI vận hành (của API hay của app) bằng tsx subprocess — credential
 * chỉ qua env của process, không bao giờ argv. Import của script (`pg`, libs)
 * được resolve từ node_modules của project chứa script bên trong subprocess.
 * App migration ghim đúng lệnh mà Nx target `db:migrate` chạy (cwd app +
 * `tsconfig.db.json`) — cùng runner với lane.
 */
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
  });
  if (result.error !== undefined || result.status !== 0) {
    // spawn có thể thất bại trước khi process nào chạy (ENOENT của tsx) — khi
    // đó status/stderr là null/undefined; lỗi spawn phải nổi ra, không được
    // biến thành TypeError che mất nguyên nhân thật.
    const detail =
      result.error?.message ?? `${result.stderr ?? ''}\n${result.stdout ?? ''}`.slice(-2000);
    throw new Error(
      `CLI script ${scriptRelativePath} failed (exit ${String(result.status ?? 'spawn-error')}):\n` +
        redact(detail, Object.values(env)),
    );
  }
}

interface BrokerApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Gọi public surface của API bằng machine token — chỉ test dùng, không log. */
async function brokerApi(
  apiUrl: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<BrokerApiResponse> {
  // `new URL(path, base)`: path tương đối (listing) lẫn href tuyệt đối của HAL
  // (link `pb:publish-verification-results`) đều resolve đúng — ghép chuỗi
  // `${apiUrl}${path}` với href tuyệt đối là URL đôi, đã từng mất 1 lần chạy.
  const response = await fetch(new URL(path, `${apiUrl}/`), {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
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

/**
 * Nội dung pact tối thiểu mà structural check của API chấp nhận. Description
 * mang version → SHA khác nhau giữa các version của cùng cặp consumer/provider
 * (UNIQUE (tenant, provider, consumer, content_sha) — content trùng giữa hai
 * version là đường publish "republish" 200, không phải hai pact 201).
 */
function pactContent(consumer: string, provider: string, version: string): unknown {
  return {
    consumer: { name: consumer },
    provider: { name: provider },
    interactions: [
      {
        description: `a GET to the root (${version})`,
        request: { method: 'GET', path: '/' },
        response: { status: 200 },
      },
    ],
    metadata: { pactSpecification: { version: '2.0.0' } },
  };
}

/**
 * Seed dữ liệu qua ĐÚNG public surface của API (không đụng DB trực tiếp —
 * consumer-side contract test phải đi qua contract thật): một environment,
 * ba pact trên hai cặp consumer/provider, một verification thành công cho
 * pact 1.0.0. Còn lại để null-verification cho trạng thái "chưa verify".
 */
async function seedBrokerData(apiUrl: string, token: string): Promise<void> {
  const environment = await brokerApi(apiUrl, token, '/environments', {
    method: 'POST',
    body: { name: 'test', displayName: 'Test', production: false },
  });
  if (environment.status !== 201) {
    throw new Error(`Seeding the environment failed with status ${String(environment.status)}`);
  }

  // Tuần tự, KHÔNG Promise.all: publish concurrently vào cùng bảng là đường
  // race SELECT-miss/INSERT trên UNIQUE (tenant, provider, consumer,
  // content_sha) — đúng nhóm lỗi concurrency mà pool-per-request sửa (issue
  // #118/#289). Seed không cần đọ tốc; determinism quan trọng hơn.
  const publishTargets: readonly (readonly [string, string, string, string])[] = [
    [
      '/pacts/provider/svc-provider/consumer/svc-consumer/version/1.0.0',
      'svc-consumer',
      'svc-provider',
      '1.0.0',
    ],
    [
      '/pacts/provider/svc-provider/consumer/svc-consumer/version/2.0.0',
      'svc-consumer',
      'svc-provider',
      '2.0.0',
    ],
    [
      '/pacts/provider/svc-provider/consumer/svc-other/version/0.3.0',
      'svc-other',
      'svc-provider',
      '0.3.0',
    ],
  ];
  let firstPublishBody: unknown;
  for (const [path, consumer, provider, version] of publishTargets) {
    const publish = await brokerApi(apiUrl, token, path, {
      method: 'PUT',
      body: pactContent(consumer, provider, version),
    });
    if (publish.status !== 201) {
      throw new Error(
        `Publishing a pact failed with status ${String(publish.status)}: ${JSON.stringify(publish.body)}`,
      );
    }
    firstPublishBody ??= publish.body;
  }

  // Verification cho pact 1.0.0 — đi qua link `pb:publish-verification-results`
  // mà HAL của publish trả, đúng cách một verifier thật làm. Bracket-string
  // cho khoá HAL — dot notation `_links` là no-underscore-dangle.
  const links = (firstPublishBody as Record<string, unknown> | null)?.['_links'] as
    | Record<string, { href?: unknown }>
    | undefined;
  const verificationHref = links?.['pb:publish-verification-results']?.href;
  if (typeof verificationHref !== 'string' || verificationHref === '') {
    throw new Error('Publish response did not carry pb:publish-verification-results');
  }
  const verification = await brokerApi(apiUrl, token, verificationHref, {
    method: 'POST',
    body: { success: true, providerApplicationVersion: '9.9.9' },
  });
  if (verification.status !== 201) {
    throw new Error(
      `Publishing the verification failed with status ${String(verification.status)}`,
    );
  }
}

interface StartedWorker {
  readonly harness: TestHarness;
  readonly origin: string;
}

/**
 * Boot workerd cho API với Hyperdrive local emulation trỏ vào container và
 * issuer/audience của fake auth (ADR-0031 §1: API verify access token user
 * offline qua JWKS của issuer — đường verify user thật, không bypass).
 */
async function startApiWorker(
  runtimeConnectionString: string,
  authIssuer: string,
): Promise<StartedWorker & { restoreHdEnv(): void }> {
  const saved = { had: HD_LOCAL_ENV in process.env, value: process.env[HD_LOCAL_ENV] };
  const restoreHdEnv = (): void => {
    if (saved.had) {
      process.env[HD_LOCAL_ENV] = saved.value;
    } else {
      Reflect.deleteProperty(process.env, HD_LOCAL_ENV);
    }
  };
  let harness: TestHarness | undefined;
  try {
    // Ghi env BÊN TRONG try: nếu `createTestHarness` ném ngay từ đầu, restore
    // vẫn chạy — không ô nhiễm process.env của các suite khác cùng worker
    // vitest. `harness` undefined-an toàn trong catch (spawn lỗi trước khi có
    // harness thì chỉ restore, không TypeError che lỗi gốc).
    process.env[HD_LOCAL_ENV] = runtimeConnectionString;
    harness = wranglerCli.createTestHarness({
      root: API_DIR,
      workers: [
        {
          configPath: resolve(API_DIR, 'wrangler.jsonc'),
          vars: {
            PACT_BROKER_AUTH_ISSUER: authIssuer,
            PACT_BROKER_AUTH_AUDIENCE: FAKE_AUDIENCE,
          },
        },
      ],
    });
    const { url } = await harness.listen();
    await waitFor(async () => (await fetch(`${url.origin}/health`)).status === 200, {
      timeoutMs: 120_000,
      label: 'pact-broker-api /health',
    });
    return { harness, origin: url.origin, restoreHdEnv };
  } catch (error) {
    await harness?.close().catch(() => undefined);
    restoreHdEnv();
    throw error;
  }
}

/**
 * Boot workerd cho app với config BFF test-only, tách đúng kênh như production:
 * base URL API + cấu hình OIDC qua `vars` (`PACT_BROKER_AUTH_*` là đường Worker
 * env mà `server/auth/config.ts` đọc trước runtimeConfig), database phiên qua
 * binding Hyperdrive `DB_PACT_BROKER_APP` mô phỏng local
 * (`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*` — PHẢI set TRƯỚC
 * `createTestHarness`, cùng cơ chế lane local dùng cho WIC auth; giá trị cũ
 * được chụp và khôi phục ở `close()`). KHÔNG có biến token nào: machine token
 * của BFF đã retire (ADR-0031 §5) — đường xác thực duy nhất của BFF là phiên
 * user.
 */
async function startAppWorker(
  apiOrigin: string,
  authIssuer: string,
  appDbConnectionString: string,
): Promise<StartedWorker & { restoreHdEnv(): void }> {
  const appHdEnv = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_PACT_BROKER_APP';
  const savedAppHd = { had: appHdEnv in process.env, value: process.env[appHdEnv] };
  const restoreAppHdEnv = (): void => {
    if (savedAppHd.had) {
      process.env[appHdEnv] = savedAppHd.value;
    } else {
      Reflect.deleteProperty(process.env, appHdEnv);
    }
  };
  let harness: TestHarness | undefined;
  try {
    process.env[appHdEnv] = appDbConnectionString;
    harness = wranglerCli.createTestHarness({
      root: APP_DIR,
      workers: [
        {
          // Inline config thay vì `configPath`: harness chỉ cho override
          // binding Hyperdrive qua config inline (cùng đường `apps/backoffice`
          // dùng cho binding `DB_BACKOFFICE`). Nội dung mirror đúng
          // `wrangler.jsonc` top-level — `main`, asset layer và
          // `run_worker_first` là shape mà suite browser dựa vào (shell SPA do
          // Nitro trả, `/_nuxt/**` do asset layer).
          config: {
            name: 'ecoma-pact-broker-app-it',
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
              NITRO_PACT_BROKER_API_BASE_URL: apiOrigin,
              PACT_BROKER_AUTH_ISSUER: authIssuer,
              PACT_BROKER_AUTH_AUDIENCE: FAKE_AUDIENCE,
              PACT_BROKER_AUTH_CLIENT_ID: FAKE_CLIENT_ID,
            },
            hyperdrive: [
              {
                binding: 'DB_PACT_BROKER_APP',
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
      label: 'pact-broker-app /health',
    });
    return { harness, origin: url.origin, restoreHdEnv: restoreAppHdEnv };
  } catch (error) {
    await harness?.close().catch(() => undefined);
    restoreAppHdEnv();
    throw error;
  }
}

/** Full stack đang chạy cho một suite — caller PHẢI gọi `close()` trong `afterAll`. */
export interface BrokerStack {
  /** Origin của app workerd (SPA + BFF) — trỏ Chromium và fetch BFF vào đây. */
  readonly appUrl: string;
  /** Origin của API workerd — seed/assert hợp đồng trực tiếp khi cần. */
  readonly apiUrl: string;
  /**
   * Machine token seed của Pact CLI/CI (đường machine hợp lệ vẫn tồn tại,
   * ADR-0031 §5) — gọi public surface của API trực tiếp khi cần. KHÔNG phải
   * credential của BFF: suite assert nó KHÔNG xuất hiện trong traffic/cookie.
   */
  readonly machineToken: string;
  /**
   * Connection string role runtime của DB phiên (`db-pact-broker-app`) — CHỈ
   * để test dựng trạng thái không tạo được qua HTTP (phiên hết hạn, phiên
   * revoked). Không dùng để đọc dữ liệu mà BFF phải trả về.
   */
  readonly appDatabaseUrl: string;
  /** Fake OIDC của stack — `signAccessToken` cho token hết hạn/ký sai. */
  readonly fakeAuth: FakeOidcAuth;
  /**
   * Đăng nhập một phiên user thật qua đường OIDC của BFF (login → fake authorize
   * code → callback → cookie `__Host-`); mỗi lần gọi tạo phiên riêng trong DB.
   */
  loginSession(): Promise<BrokerSession>;
  close(): Promise<void>;
}

/**
 * Một phiên BFF đã đăng nhập — cookie header hoàn chỉnh cho fetch `/api/**`
 * và cặp double-submit CSRF của phiên.
 */
export interface BrokerSession {
  /** Giá trị `Cookie` hoàn chỉnh (session + csrf) — gắn thẳng vào fetch. */
  readonly cookieHeader: string;
  /** Giá trị cookie CSRF — echo trong header `x-ecoma-csrf` cho mutation. */
  readonly csrfToken: string;
  /** Tên header CSRF mà middleware yêu cầu (ghim hợp đồng ở đây). */
  readonly csrfHeaderName: string;
  /** Toàn bộ `Set-Cookie` của callback — assert `__Host-` flags + không token. */
  readonly setCookies: readonly string[];
}

/** Cờ bắt buộc của cookie phiên `__Host-` (ADR-0031 §2) — assert lúc login. */
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

export async function loginSession(appUrl: string): Promise<BrokerSession> {
  // Bước 1 — login route dựng authorize URL + lưu login flow server-side, gắn
  // cookie flow dùng một lần. `redirect: 'manual'` để thấy 302 và Location.
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
    .find((cookie) => cookie.startsWith('__Host-pact-broker-login='));
  if (flowCookie === undefined) {
    throw new Error('login route did not set the one-time flow cookie');
  }

  // Bước 2 — callback với code "tự chế" (fake `/token` cấp token cho mọi code)
  // + cookie flow: callback vẫn chạy ĐỦ đường verify thật (state match → token
  // exchange → ES256 JWKS verify → insert session) trước khi cấp cookie phiên.
  const callback = await fetch(
    `${appUrl}/api/auth/callback?code=${encodeURIComponent('it-auth-code')}&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', headers: { cookie: flowCookie.split(';')[0] ?? '' } },
  );
  if (callback.status !== 302) {
    throw new Error(`callback expected 302, got ${String(callback.status)}`);
  }
  const setCookies = callback.headers.getSetCookie();
  const sessionCookie = setCookies.find((cookie) =>
    cookie.startsWith('__Host-pact-broker-session='),
  );
  const csrfCookie = setCookies.find((cookie) => cookie.startsWith('__Host-pact-broker-csrf='));
  if (sessionCookie === undefined || csrfCookie === undefined) {
    throw new Error('callback did not set both the session and the csrf cookies');
  }
  assertHostCookieFlags(sessionCookie, 'session cookie');
  assertHostCookieFlags(csrfCookie, 'csrf cookie');
  if (!sessionCookie.includes('HttpOnly')) {
    throw new Error('session cookie is missing HttpOnly');
  }
  if (csrfCookie.includes('HttpOnly')) {
    throw new Error('csrf cookie must stay readable to same-origin JS (double-submit)');
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
 * Dựng full stack: container PostgreSQL → provision role + CẢ HAI database →
 * migrations của từng unit → bootstrap tenant → machine token seed (CLI/CI) →
 * fake OIDC → workerd API → workerd app → seed dữ liệu qua public surface →
 * probe composition bằng một phiên user thật.
 *
 * ⚠️ Mỗi suite tự dựng stack của mình và tự dọn (`close()` trong `afterAll`)
 * — container chứa trạng thái, tái sử dụng giữa các suite làm dữ liệu assert
 * lẫn nhau. Cleanup ngược thứ tự boot; lỗi giữa chừng phải dọn phần đã dựng.
 */
export async function startBrokerStack(): Promise<BrokerStack> {
  await probeDocker();
  const postgres = await startPostgresContainer();
  let api: (StartedWorker & { restoreHdEnv(): void }) | undefined;
  let app: (StartedWorker & { restoreHdEnv(): void }) | undefined;
  let fakeAuth: FakeOidcAuth | undefined;
  try {
    provisionRoles(postgres.name);
    provisionAppDatabase(postgres.name);

    const migratorUrl =
      `postgres://${MIGRATOR_ROLE}:${ROLE_PASSWORD}@127.0.0.1:${String(postgres.port)}/` +
      PACT_BROKER_DATABASE;
    const runtimeUrl =
      `postgres://${RUNTIME_ROLE}:${ROLE_PASSWORD}@127.0.0.1:${String(postgres.port)}/` +
      PACT_BROKER_DATABASE;
    const appMigratorUrl =
      `postgres://${APP_MIGRATOR_ROLE}:${ROLE_PASSWORD}@127.0.0.1:${String(postgres.port)}/` +
      APP_DATABASE;
    const appRuntimeUrl =
      `postgres://${APP_RUNTIME_ROLE}:${ROLE_PASSWORD}@127.0.0.1:${String(postgres.port)}/` +
      APP_DATABASE;

    runCliScript('apps/pact-broker-api/db/apply.mts', { DATABASE_URL: migratorUrl });
    runCliScript(
      'apps/pact-broker-app/db/apply.mts',
      { DATABASE_URL: appMigratorUrl },
      {
        cwd: APP_DIR,
        tsconfig: 'tsconfig.db.json',
      },
    );
    runCliScript('apps/pact-broker-api/db/bootstrap-tenant.mts', {
      DATABASE_URL: runtimeUrl,
      CANONICAL_TENANT_OWNER_SUB: TENANT_OWNER_SUB,
    });
    const machineToken = randomBytes(24).toString('hex');
    runCliScript('apps/pact-broker-api/db/provision-machine-token.mts', {
      DATABASE_URL: runtimeUrl,
      PACT_MACHINE_TOKEN_NAME: SEED_TOKEN_NAME,
      PACT_MACHINE_TOKEN_SCOPES: SEED_TOKEN_SCOPES,
      PACT_MACHINE_TOKEN_PLAINTEXT: machineToken,
    });

    fakeAuth = await startFakeOidcAuth();
    api = await startApiWorker(runtimeUrl, fakeAuth.issuer);
    app = await startAppWorker(api.origin, fakeAuth.issuer, appRuntimeUrl);

    try {
      await seedBrokerData(api.origin, machineToken);
    } catch (error) {
      // Worker console KHÔNG tới stdout của vitest — log runtime của workerd
      // chỉ đọc được qua `getLogs()`; đính kèm để lỗi seed tự giải thích.
      const logs = api.harness.getLogs();
      const detail = logs.map((log) => `${log.level}: ${log.message}`).join('\n');
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nAPI worker logs:\n${detail}`,
        {
          cause: error,
        },
      );
    }

    const startedApi = api;
    const startedApp = app;
    const startedFakeAuth = fakeAuth;
    return {
      appUrl: startedApp.origin,
      apiUrl: startedApi.origin,
      machineToken,
      appDatabaseUrl: appRuntimeUrl,
      fakeAuth: startedFakeAuth,
      loginSession: (): Promise<BrokerSession> => loginSession(startedApp.origin),
      close: async (): Promise<void> => {
        // Dọn ngược thứ tự boot — workerd trước (đóng socket runtime), rồi fake
        // auth, rồi DB; env emulation khôi phục sau khi harness đóng.
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
