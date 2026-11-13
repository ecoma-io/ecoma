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
 * BFF gọi API server-side qua `NITRO_PACT_BROKER_API_*` (test-only `vars` +
 * `secrets` override của `createTestHarness`, tách kênh như production — base
 * URL qua vars, token qua secrets), token machine scope `admin` đúng như lane
 * provision (`deploys/pact-broker-api-deploy`).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

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
 * duplication): image 17-alpine, database đúng tên production, superuser test
 * và mật khẩu chung giả cho các role (database ném đi sau mỗi run).
 */
const POSTGRES_IMAGE = 'postgres:17-alpine';
const PACT_BROKER_DATABASE = 'db-pact-broker';
const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';
const ROLE_PASSWORD = 'ecoma_test_role_pw';
const MIGRATOR_ROLE = 'ecoma_pact_broker_migrator';
const RUNTIME_ROLE = 'ecoma_pact_broker_runtime';

/** Machine token BFF — cùng tên + scope mà lane provision cho deploy unit. */
const MACHINE_TOKEN_NAME = 'pact-broker-app-bff';
const MACHINE_TOKEN_SCOPES = 'admin';
const TENANT_OWNER_SUB = 'pact-broker-app-it-owner';

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
const PROVISIONABLE_ROLE_NAMES: ReadonlySet<string> = new Set([MIGRATOR_ROLE, RUNTIME_ROLE]);

/**
 * Provision role LOGIN cho migrator/runtime bằng superuser — đúng khối
 * `provision()` của harness API (migration `0001` chỉ tạo guard NOLOGIN, role
 * kết nối thật phải do admin tạo + grant trước khi migration chạy).
 */
function provisionRoles(containerName: string): void {
  for (const role of [MIGRATOR_ROLE, RUNTIME_ROLE]) {
    // Ghim allowlist trước khi nội suy (xem `PROVISIONABLE_ROLE_NAMES`).
    if (!PROVISIONABLE_ROLE_NAMES.has(role)) {
      throw new Error(`Refusing to interpolate a non-allowlisted role name into SQL: ${role}`);
    }
    psqlSync(
      containerName,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN
           CREATE ROLE ${role} LOGIN PASSWORD '${ROLE_PASSWORD}'
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
 * Chạy một CLI vận hành của API bằng tsx subprocess — credential chỉ qua env
 * của process, không bao giờ argv. Import của script (`pg`, libs API) được
 * resolve từ node_modules của API bên trong subprocess.
 */
function runApiCliScript(scriptRelativePath: string, env: Record<string, string>): void {
  const result = spawnSync(TSX_BIN, [resolve(REPO_ROOT, scriptRelativePath)], {
    cwd: REPO_ROOT,
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

/** Boot workerd cho API với Hyperdrive local emulation trỏ vào container. */
async function startApiWorker(
  runtimeConnectionString: string,
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
      workers: [{ configPath: resolve(API_DIR, 'wrangler.jsonc') }],
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
 * base URL qua `vars`, token qua `secrets` (trên thật là Worker Secrets — xem
 * `wrangler.jsonc`). Cả hai đều chạm cùng đường nối env của workerd, nên probe
 * composition phủ đúng path config mà runtime đọc.
 */
async function startAppWorker(apiOrigin: string, token: string): Promise<StartedWorker> {
  const harness = wranglerCli.createTestHarness({
    root: APP_DIR,
    workers: [
      {
        configPath: resolve(APP_DIR, 'wrangler.jsonc'),
        vars: { NITRO_PACT_BROKER_API_BASE_URL: apiOrigin },
        secrets: { NITRO_PACT_BROKER_API_TOKEN: token },
      },
    ],
  });
  try {
    const { url } = await harness.listen();
    await waitFor(async () => (await fetch(`${url.origin}/health`)).status === 200, {
      timeoutMs: 120_000,
      label: 'pact-broker-app /health',
    });
    // Probe composition: app (workerd) gọi được API (workerd) qua network
    // thật — hỏng wiring ở đây là chết ngay lúc setup, không phải giữa test.
    await waitFor(
      async () =>
        (
          await fetch(`${url.origin}/api/broker/pacticipants`, {
            headers: { accept: 'application/json' },
          })
        ).status === 200,
      { timeoutMs: 120_000, label: 'BFF to API composition probe' },
    );
    return { harness, origin: url.origin };
  } catch (error) {
    await harness.close().catch(() => undefined);
    throw error;
  }
}

/** Full stack đang chạy cho một suite — caller PHẢI gọi `close()` trong `afterAll`. */
export interface BrokerStack {
  /** Origin của app workerd (SPA + BFF) — trỏ Chromium và fetch BFF vào đây. */
  readonly appUrl: string;
  /** Origin của API workerd — seed/assert hợp đồng trực tiếp khi cần. */
  readonly apiUrl: string;
  /** Plaintext machine token của BFF — chỉ dùng để assert "không rò vào UI". */
  readonly machineToken: string;
  close(): Promise<void>;
}

/**
 * Dựng full stack: container PostgreSQL → provision role → migrations →
 * bootstrap tenant → provision machine token → workerd API → workerd app →
 * seed dữ liệu qua public surface.
 *
 * ⚠️ Mỗi suite tự dựng stack của mình và tự dọn (`close()` trong `afterAll`)
 * — container chứa trạng thái, tái sử dụng giữa các suite làm dữ liệu assert
 * lẫn nhau. Cleanup ngược thứ tự boot; lỗi giữa chừng phải dọn phần đã dựng.
 */
export async function startBrokerStack(): Promise<BrokerStack> {
  await probeDocker();
  const postgres = await startPostgresContainer();
  let api: (StartedWorker & { restoreHdEnv(): void }) | undefined;
  let app: StartedWorker | undefined;
  try {
    provisionRoles(postgres.name);

    const migratorUrl =
      `postgres://${MIGRATOR_ROLE}:${ROLE_PASSWORD}@127.0.0.1:${String(postgres.port)}/` +
      PACT_BROKER_DATABASE;
    const runtimeUrl =
      `postgres://${RUNTIME_ROLE}:${ROLE_PASSWORD}@127.0.0.1:${String(postgres.port)}/` +
      PACT_BROKER_DATABASE;

    runApiCliScript('apps/pact-broker-api/db/apply.mts', { DATABASE_URL: migratorUrl });
    runApiCliScript('apps/pact-broker-api/db/bootstrap-tenant.mts', {
      DATABASE_URL: runtimeUrl,
      CANONICAL_TENANT_OWNER_SUB: TENANT_OWNER_SUB,
    });
    const machineToken = randomBytes(24).toString('hex');
    runApiCliScript('apps/pact-broker-api/db/provision-machine-token.mts', {
      DATABASE_URL: runtimeUrl,
      PACT_MACHINE_TOKEN_NAME: MACHINE_TOKEN_NAME,
      PACT_MACHINE_TOKEN_SCOPES: MACHINE_TOKEN_SCOPES,
      PACT_MACHINE_TOKEN_PLAINTEXT: machineToken,
    });

    api = await startApiWorker(runtimeUrl);
    app = await startAppWorker(api.origin, machineToken);

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
    return {
      appUrl: startedApp.origin,
      apiUrl: startedApi.origin,
      machineToken,
      close: async (): Promise<void> => {
        // Dọn ngược thứ tự boot — workerd trước (đóng socket runtime), rồi DB.
        await startedApp.harness.close().catch(() => undefined);
        await startedApi.harness.close().catch(() => undefined);
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
    postgres.stop();
    throw error;
  }
}
