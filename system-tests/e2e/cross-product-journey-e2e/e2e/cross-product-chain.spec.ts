import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';

import {
  SECOND_TENANT_NAME,
  expect,
  seedSecondTenantIdentity,
  test,
  type Identity,
} from './support/fixtures';
import {
  mailWicContainerOf,
  readOtpFromMailSink,
  resolvePostgresContainer,
} from './support/stack-fixtures';
import { performBrowserLogin } from './support/oidc-flow';
import {
  localCertPath,
  resolveBackofficeOrigin,
  resolvePactApiOrigin,
  resolvePactPortalOrigin,
  resolveRemoteCachePortalOrigin,
  stackGet,
  stackRequest,
} from './support/local-origin';
import { resolvePlatformNetwork } from './support/network';

/**
 * Chuỗi cross-product chained journey — lõi Outcome của #27.
 *
 * Một luồng duy nhất đi qua BỐN sản phẩm trên stack local thật; mỗi bước lấy
 * credential của sản phẩm kế bằng phiên/credential của bước trước (không
 * launcher trung gian — mỗi portal xác thực riêng bằng cơ chế của chính nó):
 *
 * 1. Backoffice: superadmin bootstrap thật (`superadmin@ecoma.io`) đăng nhập
 *    qua OIDC/OTP UI thật; session `__Host-backoffice-session` sống và
 *    `/api/me` trả 200 với principal — bằng chứng chuỗi token→session→principal.
 * 2. Remote Cache: token lấy qua control plane đã xác thực (portal UI,
 *    show-once), rồi Nx CLI thật (trong platform network — `remote-cache-api`
 *    không có router Traefik, #238) PUT artifact → HIT từ container sạch thứ
 *    hai; token portal đọc được data-plane của tenant mình.
 * 3. Pact Broker: developer credential tạo qua portal UI (show-once) publish
 *    bằng Pact CLI thật; CI credential riêng chạy verifier thật rồi
 *    `can-i-deploy` YES.
 * 4. llm-api: inference thật qua worker trong network với consumer key
 *    bootstrap (env lane `LLM_E2E_*`), settle ĐÚNG MỘT lần — replay cùng
 *    `x-request-id` 409 và không double charge.
 *
 * ## Test-observer là kênh assertion accounting đã được phê duyệt cho #27
 *
 * Settlement assertion đọc DB read-only qua `docker exec psql` (`db-llm-gateway`)
 * — cùng mô hình `llm-inference-e2e`; không có API accounting public và suite
 * không thêm một cái nào. Suite CHỈ đọc: mọi SELECT, không INSERT/UPDATE.
 *
 * ## Negative
 *
 * Hai test negative cuối file: credential thiếu/sai bị từ chối trên mọi bề mặt
 * (RC data-plane, Pact machine API, Backoffice `/api/**`, llm worker) và
 * isolation hai chiều Remote Cache + Pact với tenant thứ hai.
 */

const execFileAsync = promisify(execFile);

/** Alias nội bộ + port của data-plane Remote Cache trên network platform (#238). */
const DATA_PLANE_ALIAS = 'ecoma-remote-cache-api';
const DATA_PLANE_PORT = 4207;
/** Base URL worker llm-api trên platform network (lane contract). */
const WORKER_BASE_URL = 'http://ecoma-llm-api:4211';
/** Database vật lý gateway LLM — observer psql đọc. */
const GATEWAY_DATABASE = 'db-llm-gateway';
/** Model normalized của offer Dronie (bootstrap lane). */
const DRONIE_MODEL_ID = 'dronie-flash';
/** Email superadmin do bootstrap provision — suite chỉ đăng nhập, không seed. */
const SUPERADMIN_EMAIL = 'superadmin@ecoma.io';

/** Phiên bản Nx ghim — cùng version với workspace chính của repo. */
const NX_VERSION = (
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../..', 'package.json'),
      'utf8',
    ),
  ) as { devDependencies?: Record<string, string> }
).devDependencies?.nx;
if (NX_VERSION === undefined) {
  throw new Error('nx version not found in repo-root package.json devDependencies');
}
/** Image Node cho container journey — cùng bản mà lane và các suite cùng nhóm dùng. */
const NODE_IMAGE = 'node:24-bookworm-slim';

const BACKOFFICE_ORIGIN = resolveBackofficeOrigin();
const REMOTE_CACHE_ORIGIN = resolveRemoteCachePortalOrigin();
const PACT_PORTAL_ORIGIN = resolvePactPortalOrigin();
const PACT_API_ORIGIN = resolvePactApiOrigin();

/** Token chạy-riêng cho resource names — tránh đụng dữ liệu của run trước. */
function runToken(): string {
  return Date.now().toString(36);
}

// -------------------------------------------------------------------------------------------
// Support — client in-network (spawnSync + stdin; execFile KHÔNG hỗ trợ `input`)
// -------------------------------------------------------------------------------------------

/**
 * Script client một-file: request JSON trên stdin, MỘT dòng JSON `{status,body}`
 * trên stdout. Authorization sống trong stdin của pipeline — không argv (`ps`
 * lộ), không log.
 */
const IN_NETWORK_CLIENT_SCRIPT =
  "let raw='';process.stdin.on('data',(c)=>raw+=c);process.stdin.on('end',async()=>{try{const r=JSON.parse(raw);const res=await fetch(r.url,{method:r.method??'POST',headers:r.headers??{},body:r.body});const body=await res.text();process.stdout.write(JSON.stringify({status:res.status,body})+'\\n');}catch(e){process.stdout.write(JSON.stringify({status:0,body:String(e)})+'\\n');}});";

interface InNetworkRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT';
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/**
 * MỘT HTTP request qua container ephemeral trên platform network — hình dạng
 * contract giống `requestInNetwork` của `llm-inference-e2e` (JSON cuối stdout).
 */
function requestInNetwork(
  network: string,
  request: InNetworkRequest,
): { status: number; body: string } {
  const result = spawnSync(
    'docker',
    ['run', '--rm', '--network', network, '-i', NODE_IMAGE, 'node', '-e', IN_NETWORK_CLIENT_SCRIPT],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, input: JSON.stringify(request) },
  );
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`starting the in-network client failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`in-network client exited with ${String(result.status)}: ${result.stderr}`);
  }
  const lines = result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const last = lines[lines.length - 1];
  if (last === undefined || !last.startsWith('{')) {
    throw new Error('in-network client printed no JSON result line; the client contract is broken');
  }
  return JSON.parse(last) as { status: number; body: string };
}

/** curl một GET trong network, trả status (`-o /dev/null` — không body). */
async function curlStatusInNetwork(network: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'docker',
    [
      'run',
      '--rm',
      `--network=${network}`,
      'curlimages/curl',
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-m',
      '10',
      ...args,
    ],
    { timeout: 30_000 },
  );
  return stdout.trim();
}

// -------------------------------------------------------------------------------------------
// Support — observer psql + đọc bootstrap key từ Pulumi state + env lane
// -------------------------------------------------------------------------------------------

/** Nháy-trích một giá trị nội suy vào SQL literal — mẫu `shellQuoteForTest`
 * của argv-hygiene specs: một giá trị chứa `'` không thể đổi ngữ nghĩa câu
 * SELECT read-only. Áp dụng TỪNG GIÁ TRỊ nội suy, không áp cho cả câu query
 * (query đã chứa nháy của literal — escape cả câu làm vỡ nó, lỗi này đã xảy
 * ra ở run CI 44066572405). */
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Chạy psql SELECT read-only trong container Postgres của namespace lane. */
function psqlQuery(namespace: string, database: string, sql: string): string {
  const result = execFileSync(
    'docker',
    [
      'exec',
      `ecoma-${namespace}-postgres`,
      'psql',
      '-U',
      'ecoma_local',
      '-d',
      database,
      '-tAc',
      sql,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return result.trimEnd();
}

/**
 * Đọc plaintext của bootstrap trusted-CI key từ Pulumi local state — đường
 * `nx-cli-journey.spec` của `remote-cache-portal-e2e` đã dùng. Giá trị KHÔNG
 * BAO GIỜ log hay commit.
 */
function readCiKeyPlaintext(): string {
  const specDir = dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = join(specDir, '../../../..');
  const deployDir = join(workspaceRoot, 'deploys/remote-cache-api-deploy');
  const stacksDir = join(
    workspaceRoot,
    '.pulumi-local-state/.pulumi/stacks/remote-cache-api-deploy',
  );
  const stackFile = readdirSync(stacksDir).find(
    (name) => name.endsWith('.json') && !name.endsWith('.bak.json'),
  );
  if (stackFile === undefined) {
    throw new Error(
      'no remote-cache-api-deploy stack json in .pulumi-local-state — run local-up first',
    );
  }
  const stackName = stackFile.replace(/\.json$/u, '');
  const stdout = execFileSync(
    'pulumi',
    ['config', 'get', 'namespace:ciKeyPlaintext', '--stack', stackName],
    {
      cwd: deployDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PULUMI_BACKEND_URL: `file://${join(deployDir, '../../.pulumi-local-state')}`,
        PULUMI_CONFIG_PASSPHRASE_FILE: join(deployDir, '../../.pulumi-local-passphrase'),
      },
    },
  );
  const value = stdout.trim();
  if (value.length === 0) {
    throw new Error('bootstrap CI key is empty — check the Pulumi local state of this worktree');
  }
  return value;
}

/** Env lane do runner (`bin/run-system-test.mjs`) nạp — thiếu là fail-closed. */
function laneEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `environment variable ${name} is missing — run the suite via the system-test target (bin/run-system-test.mjs), never a bare playwright`,
    );
  }
  return value;
}

// -------------------------------------------------------------------------------------------
// Support — Pact CLI + UI credential helpers (mô hình broker-portal-journey)
// -------------------------------------------------------------------------------------------

const PACT_BIN = join(dirname(fileURLToPath(import.meta.url)), '../node_modules/.bin');

interface CliResult {
  readonly stdout: string;
  readonly status: number;
}

/**
 * Chạy một lệnh Pact CLI thật với env: cert local + token. Token ĐI VÀO env
 * process của CLI — không bao giờ ghép vào argv (`ps` lộ), không nằm trong
 * message lỗi của test.
 */
async function runPactCli(
  binary: 'pact-broker' | 'pact-verifier',
  args: string[],
  token: string,
): Promise<CliResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.SSL_CERT_FILE = localCertPath();
  env.PACT_BROKER_BASE_URL = PACT_API_ORIGIN;
  env.PACT_BROKER_TOKEN = token;
  env.PACT_DO_NOT_TRACK = 'true';
  try {
    const { stdout } = await execFileAsync(join(PACT_BIN, binary), args, {
      env,
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof err.code !== 'number') {
      throw error;
    }
    return { stdout: `${err.stdout ?? ''}\n${err.stderr ?? ''}`, status: err.code };
  }
}

/** Scrub token trước khi stdout chạm message assert/log của Playwright. */
function scrubForAssertion(output: string, ...tokens: string[]): string {
  let scrubbed = output;
  for (const token of tokens) {
    if (token.length > 0) {
      scrubbed = scrubbed.split(token).join('[REDACTED]');
    }
  }
  return scrubbed.slice(0, 600);
}

/** Token không được xuất hiện trong output CLI — rào chắn phòng CLI in log. */
function assertNoTokenInOutput(output: string, token: string): void {
  if (token.length > 0 && output.includes(token)) {
    throw new Error('pact CLI output unexpectedly contains the token plaintext');
  }
}

/** Ghi một pact JSON với interaction description duy nhất — trả đường dẫn. */
function writePactFile(
  dir: string,
  consumer: string,
  provider: string,
  interaction: string,
): string {
  const path = join(
    dir,
    `pact-${createHash('sha1').update(interaction).digest('hex').slice(0, 8)}.json`,
  );
  writeFileSync(
    path,
    JSON.stringify({
      consumer: { name: consumer },
      provider: { name: provider },
      interactions: [
        {
          description: interaction,
          request: { method: 'GET', path: '/' },
          response: { status: 200 },
        },
      ],
      metadata: { pactSpecification: { version: '2.0.0' } },
    }),
  );
  return path;
}

/** Provider app thật cho verifier — HTTP server 200 JSON, mọi timeout tắt. */
function startProviderApp(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    // Keep-alive mặc định của node http server đóng idle connection sau 5s —
    // verifier (tokio) bị đứt kết nối giữa chừng verify dài. Tắt mọi timeout.
    server.keepAliveTimeout = 0;
    server.headersTimeout = 0;
    server.requestTimeout = 0;
    server.timeout = 0;
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('provider app did not bind a TCP port');
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((resolveClosed) => {
            server.close(() => resolveClosed());
          }),
      });
    });
  });
}

/**
 * Tạo machine credential qua UI portal Pact (`/tokens`), trả secret show-once.
 * Secret chỉ đọc từ khối revealed trong DOM — không có đường đọc lại nào khác.
 */
async function createPactCredentialViaUi(
  page: Page,
  params: { origin: string; name: string; purpose: 'developer' | 'ci'; scopes: string[] },
): Promise<string> {
  await page.goto(`${params.origin}/tokens`);
  await expect(page.getByTestId('pact-broker-token-create')).toBeVisible();
  await page.getByTestId('pact-broker-token-name').fill(params.name);
  await page.locator(`input[type="radio"][value="${params.purpose}"]`).check();
  for (const scope of params.scopes) {
    // Scope checkboxes không có testid riêng — nhắm label text là hợp đồng UI.
    await page
      .locator('fieldset', { hasText: 'Scope' })
      .or(page.locator('form'))
      .getByText(scope, { exact: true })
      .locator('visible=true')
      .first()
      .check();
  }
  await page.getByTestId('pact-broker-token-submit').click();
  const revealed = page.getByTestId('pact-broker-token-revealed');
  await expect(revealed).toBeVisible();
  const secret = (await page.getByTestId('pact-broker-token-secret').textContent()) ?? '';
  if (secret.trim().length === 0) {
    throw new Error('credential created but the revealed secret block is empty');
  }
  return secret.trim();
}

// -------------------------------------------------------------------------------------------
// Chuỗi serial
// -------------------------------------------------------------------------------------------

test.describe.serial('cross-product chained MVP journey', () => {
  let chainRunToken = '';
  let network = '';
  /** RC: project của tenant `ecoma` tạo qua control plane (bước 2). */
  let rcProjectName = '';
  /** Pact: consumer/provider + secrets show-once (bước 3). */
  let pactConsumer = '';
  let pactProvider = '';
  let developerSecret = '';
  let ciSecret = '';
  /** LLM: request id duy nhất theo run — scope mọi assertion settlement. */
  let llmRequestId = '';
  let llmChargeId = '';

  const workspaceDir = mkdtempSync(join(tmpdir(), 'cross-journey-e2e-'));

  test.afterAll(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test('step 1: superadmin signs into the Backoffice through the real OIDC/OTP flow', async ({
    page,
  }) => {
    chainRunToken = runToken();
    network = await resolvePlatformNetwork(REMOTE_CACHE_ORIGIN);

    // OTP của superadmin về địa chỉ bootstrap — poll mail sink cho ĐÚNG recipient
    // đó (không phải recipient của identity fixture).
    const postgres = await resolvePostgresContainer(BACKOFFICE_ORIGIN);
    const mailWic = mailWicContainerOf(postgres);
    const sinceMs = Date.now();

    await performBrowserLogin(page, {
      entryUrl: `${BACKOFFICE_ORIGIN}/api/auth/login`,
      email: SUPERADMIN_EMAIL,
      readOtp: () => readOtpFromMailSink(mailWic, { recipient: SUPERADMIN_EMAIL, sinceMs }),
    });

    // Session sống: `/api/me` 200 với principal — không đọc DB, không launcher.
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === '__Host-backoffice-session');
    if (session === undefined) {
      throw new Error('backoffice session cookie missing after login — auth flow did not complete');
    }
    const me = await page.evaluate(async () => {
      const response = await fetch('/api/me');
      return {
        status: response.status,
        body: (await response.json()) as { sub?: string; displayName?: string | null },
      };
    });
    expect(me.status).toBe(200);
    expect(me.body.sub).not.toBeUndefined();
    expect(me.body.sub?.startsWith('sub_')).toBe(true);

    // LLM chain state: request id duy nhất theo run (replay guard chặn MỌI id
    // đã thấy kể cả FAILED — id tĩnh làm run kế dính 409 từ hàng run cũ).
    llmRequestId = `cross-journey-${chainRunToken}`;
    llmChargeId = `charge:${llmRequestId}:attempt:${llmRequestId}:1`;
  });

  test('step 2: remote-cache token from the authenticated control plane PUTs and HITs through the real Nx CLI', async ({
    page,
    identity,
  }) => {
    test.setTimeout(300_000);
    // Chuỗi: identity đã xác thực ở bước 1 đăng nhập portal RC bằng cơ chế OIDC
    // riêng của portal (không launcher phát token — phiên Backoffice không
    // truyền được sang RC; #27 sau khi gỡ launcher).
    await page.goto(REMOTE_CACHE_ORIGIN);
    await performBrowserLogin(page, {
      email: identity.email,
      readOtp: () => identity.readOtp(Date.now() - 60_000),
      entryUrl: `${REMOTE_CACHE_ORIGIN}/api/auth/login`,
    });

    // Control plane đã xác thực: tạo project + key bootstrap qua BFF portal.
    rcProjectName = `cross-journey-${chainRunToken}`;
    await page.getByTestId('remote-cache-app-create-project-link').click();
    await page.getByTestId('remote-cache-app-create-project-name').fill(rcProjectName);
    await page.getByTestId('remote-cache-app-create-project-submit').click();
    await expect(page.getByTestId('remote-cache-app-show-once')).toBeVisible();
    const devToken = (
      await page.getByTestId('remote-cache-app-show-once-token').innerText()
    ).trim();
    expect(devToken.length).toBeGreaterThan(8);
    await page.getByTestId('remote-cache-app-show-once-confirm').click();

    // Data-plane PUT bằng Nx CLI thật: trusted-CI key của bootstrap (đường
    // `nx-cli-journey` đã verify — portal key read-only, PUT 403 theo thiết kế).
    const ciKey = readCiKeyPlaintext();
    const ws = mkdtempSync(join(tmpdir(), 'cross-journey-nx-'));
    try {
      writeFileSync(
        join(ws, 'package.json'),
        JSON.stringify(
          {
            name: 'cross-journey-probe',
            version: '0.0.0',
            workspaces: ['packages/*'],
            private: true,
          },
          null,
          2,
        ),
      );
      writeFileSync(join(ws, 'nx.json'), JSON.stringify({}, null, 2));
      const projectDir = join(ws, 'packages', 'probe');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, 'package.json'),
        JSON.stringify(
          {
            name: 'probe',
            version: '0.0.0',
            type: 'module',
            nx: {
              targets: {
                echo: {
                  executor: 'nx:run-commands',
                  options: { cwd: 'packages/probe', command: 'node echo.js' },
                  cache: true,
                },
              },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(join(projectDir, 'echo.js'), "console.log('cross-journey-ok');\n");

      const runNx = async (): Promise<string> => {
        const { stdout } = await execFileAsync(
          'docker',
          [
            'run',
            '--rm',
            `--network=${network}`,
            '-v',
            `${ws}:/ws`,
            '-w',
            '/ws',
            '-e',
            `NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://${DATA_PLANE_ALIAS}:${DATA_PLANE_PORT}`,
            '-e',
            `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=${ciKey}`,
            NODE_IMAGE,
            'sh',
            '-c',
            `npm i -s nx@${NX_VERSION} --no-save >/dev/null 2>&1 && npx nx reset >/dev/null 2>&1 && npx nx run probe:echo 2>&1`,
          ],
          { timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
        );
        // Scrub trước khi trả: stdout có thể in lại env khi lỗi — trusted-CI key
        // không chạm message assert/artifact dưới bất kỳ hình dạng nào.
        return stdout
          .replace(new RegExp('NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=\\S+', 'gu'), '[REDACTED]')
          .replace(
            new RegExp('"NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN"\\s*:\\s*"[^"]*"', 'gu'),
            '"NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN":"[REDACTED]"',
          );
      };

      // Run 1 trong container sạch: MISS (store mới) hoặc HIT (entry còn) — cả
      // hai chứng minh giao thức Nx ⇄ lane; ràng buộc cứng nằm ở run 2.
      const firstRun = await runNx();
      expect(firstRun).toContain('Successfully ran target echo for project probe');
      expect(firstRun).toContain('cross-journey-ok');
      expect(firstRun).toMatch(/Cache:\s*[01]\/1 hit/u);

      // Run 2 trong container SẠCH THỨ HAI: local store trống ⇒ 1/1 hit chỉ có
      // thể là RETRIEVE từ lane — bằng chứng PUT + HIT hai chiều.
      const secondRun = await runNx();
      expect(secondRun).toMatch(/Cache:\s*1\/1 hit/u);

      // Token show-once của portal (read scope) chạm được data-plane của tenant
      // mình — chuỗi "control plane → data plane" với credential của bước trước.
      const read = await curlStatusInNetwork(network, [
        '-H',
        `Authorization: Bearer ${devToken}`,
        `http://${DATA_PLANE_ALIAS}:${DATA_PLANE_PORT}/v1/cache/${'a2'.padEnd(64, '0')}`,
      ]);
      // 404 (miss, auth đạt) — key developer đọc được namespace của mình.
      expect(read).toBe('404');
    } finally {
      // Daemon rootful (CI) khiến npm/nx ghi file thuộc root vào mount — xoá
      // nội dung bằng container root trước khi `rmSync` (lỗi CI thật #314).
      await execFileAsync('docker', [
        'run',
        '--rm',
        '-v',
        `${ws}:/ws`,
        NODE_IMAGE,
        'sh',
        '-c',
        'rm -rf /ws/* /ws/.[!.]* /ws/..?* 2>/dev/null || true',
      ]).catch((error: unknown) => {
        console.warn(
          `cleanup container failed, host rmSync may fail: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('step 3: portal-obtained Pact credentials publish, verify and can-i-deploy through the real CLI', async ({
    page,
    identity,
  }) => {
    test.setTimeout(180_000);
    // Chuỗi: login portal Pact bằng định danh đã xác thực ở bước 2.
    await page.goto(PACT_PORTAL_ORIGIN);
    await performBrowserLogin(page, {
      email: identity.email,
      readOtp: () => identity.readOtp(Date.now() - 60_000),
      entryUrl: `${PACT_PORTAL_ORIGIN}/api/auth/login`,
    });

    pactConsumer = `cross-journey-consumer-${chainRunToken}`;
    pactProvider = `cross-journey-provider-${chainRunToken}`;

    // Developer credential qua UI (show-once) → publish bằng Pact CLI thật.
    developerSecret = await createPactCredentialViaUi(page, {
      origin: PACT_PORTAL_ORIGIN,
      name: `cross-journey-developer-${chainRunToken}`,
      purpose: 'developer',
      scopes: ['read', 'write'],
    });
    const pactFile = writePactFile(
      workspaceDir,
      pactConsumer,
      pactProvider,
      `cross-journey interaction ${chainRunToken}`,
    );
    const publish = await runPactCli(
      'pact-broker',
      ['publish', pactFile, '--consumer-app-version', '1.0.0', '--branch', 'main'],
      developerSecret,
    );
    expect(publish.status, scrubForAssertion(publish.stdout, developerSecret)).toBe(0);
    assertNoTokenInOutput(publish.stdout, developerSecret);
    expect(publish.stdout).toContain('Pact published successfully');

    // CI credential riêng → verifier thật publish verification result.
    ciSecret = await createPactCredentialViaUi(page, {
      origin: PACT_PORTAL_ORIGIN,
      name: `cross-journey-ci-${chainRunToken}`,
      purpose: 'ci',
      scopes: ['read', 'write'],
    });
    const environmentName = `cross-journey-env-${chainRunToken}`;
    const createEnv = await runPactCli(
      'pact-broker',
      ['create-environment', '--name', environmentName, '--production'],
      ciSecret,
    );
    expect(createEnv.status, scrubForAssertion(createEnv.stdout, ciSecret)).toBe(0);
    assertNoTokenInOutput(createEnv.stdout, ciSecret);

    const providerApp = await startProviderApp();
    try {
      const verify = await runPactCli(
        'pact-verifier',
        [
          '--provider-name',
          pactProvider,
          '--provider-version',
          '2.0.0',
          '--broker-url',
          PACT_API_ORIGIN,
          '--consumer-version-selectors',
          '{"main":true}',
          '--publish',
          '--hostname',
          new URL(providerApp.url).hostname,
          '--port',
          new URL(providerApp.url).port,
        ],
        ciSecret,
      );
      expect(verify.status, scrubForAssertion(verify.stdout, ciSecret)).toBe(0);
      assertNoTokenInOutput(verify.stdout, ciSecret);
      expect(verify.stdout).toContain('Verifying a pact');

      // record-deployment của provider version, rồi can-i-deploy YES.
      const record = await runPactCli(
        'pact-broker',
        [
          'record-deployment',
          '--pacticipant',
          pactProvider,
          '--version',
          '2.0.0',
          '--environment',
          environmentName,
        ],
        ciSecret,
      );
      expect(record.status, scrubForAssertion(record.stdout, ciSecret)).toBe(0);
      assertNoTokenInOutput(record.stdout, ciSecret);

      const deploy = await runPactCli(
        'pact-broker',
        [
          'can-i-deploy',
          '--pacticipant',
          pactConsumer,
          '--version',
          '1.0.0',
          '--to-environment',
          environmentName,
        ],
        ciSecret,
      );
      expect(deploy.status, scrubForAssertion(deploy.stdout, ciSecret)).toBe(0);
      assertNoTokenInOutput(deploy.stdout, ciSecret);
      expect(deploy.stdout).toContain('Computer says yes');
    } finally {
      await providerApp.close();
    }
  });

  test('step 4: the chain serves a real inference through /llm and settles usage exactly once', async () => {
    test.setTimeout(120_000);
    const apiKey = laneEnv('LLM_E2E_CONSUMER_API_KEY');
    const namespace = laneEnv('LLM_E2E_NAMESPACE');
    const laneNetwork = laneEnv('LLM_E2E_NETWORK');

    // Serving thật: MỘT chat completion qua worker trong network với consumer
    // key bootstrap — chuỗi kết thúc bằng model của Dronie.
    const completionRequestBody = JSON.stringify({
      model: DRONIE_MODEL_ID,
      messages: [{ role: 'user', content: `cross-journey prompt ${chainRunToken}` }],
      max_tokens: 16,
    });
    const response = requestInNetwork(laneNetwork, {
      url: `${WORKER_BASE_URL}/v1/chat/completions`,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-request-id': llmRequestId,
      },
      body: completionRequestBody,
    });
    expect(response.status).toBe(200);
    const completion = JSON.parse(response.body) as {
      object: string;
      model: string;
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
    };
    expect(completion.object).toBe('chat.completion');
    expect(completion.model).toBe(DRONIE_MODEL_ID);
    expect(completion.usage).not.toBeNull();

    // Test-observer (đã phê duyệt cho #27 — psql read-only): settle ĐÚNG MỘT
    // lần. GROUP BY gộp về đúng MỘT nhóm khi request id (duy nhất theo run)
    // settled đúng một lần.
    const row = psqlQuery(
      namespace,
      GATEWAY_DATABASE,
      `SELECT count(*), status, usage_status, charge_minor IS NOT NULL AND charge_minor > 0 ` +
        `FROM llm_gateway.logical_requests WHERE request_id = ${sqlLiteral(llmRequestId)} ` +
        `GROUP BY status, usage_status, charge_minor`,
    );
    const fields = row.split('|');
    expect(fields).toHaveLength(4);
    expect(fields[0]).toBe('1');
    expect(fields[1]).toBe('completed');
    expect(fields[2]).toBe('known');
    expect(fields[3]).toBe('t');

    // ĐÚNG MỘT charge của request này (charge_id tất định từ request id).
    const charge = psqlQuery(
      namespace,
      GATEWAY_DATABASE,
      `SELECT state, count(*) FROM llm_financial.customer_charges WHERE charge_id = ${sqlLiteral(llmChargeId)} GROUP BY state`,
    );
    expect(charge).toBe('posted|1');

    // Replay cùng x-request-id: 409 request_id_replay, KHÔNG double charge.
    const requestsBefore = psqlQuery(
      namespace,
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_gateway.logical_requests WHERE request_id = ${sqlLiteral(llmRequestId)}`,
    );
    const chargesBefore = psqlQuery(
      namespace,
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_financial.customer_charges WHERE charge_id = ${sqlLiteral(llmChargeId)}`,
    );
    const replayResponse = requestInNetwork(laneNetwork, {
      url: `${WORKER_BASE_URL}/v1/chat/completions`,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-request-id': llmRequestId,
      },
      body: completionRequestBody,
    });
    expect(replayResponse.status).toBe(409);
    const envelope = JSON.parse(replayResponse.body) as { error: { code: string | null } };
    expect(envelope.error.code).toBe('request_id_replay');

    // Không dòng logical_request mới, không charge mới — settle đúng MỘT lần.
    expect(
      psqlQuery(
        namespace,
        GATEWAY_DATABASE,
        `SELECT count(*) FROM llm_gateway.logical_requests WHERE request_id = ${sqlLiteral(llmRequestId)}`,
      ),
    ).toBe(requestsBefore);
    expect(
      psqlQuery(
        namespace,
        GATEWAY_DATABASE,
        `SELECT count(*) FROM llm_financial.customer_charges WHERE charge_id = ${sqlLiteral(llmChargeId)}`,
      ),
    ).toBe(chargesBefore);

    // Leak fence: log worker không chứa prompt của record, không chứa key.
    const workerLogs = execFileSync('docker', ['logs', `ecoma-${namespace}-llm-api-wic`], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(workerLogs).not.toContain(`cross-journey prompt ${chainRunToken}`);
    expect(workerLogs).not.toContain(apiKey);
  });

  test('negative: missing and invalid credentials are denied by every product surface', async () => {
    // Remote Cache data-plane: thiếu token ⇒ 401, token sai ⇒ 401.
    const hash = 'neg'.padEnd(64, '0');
    const noToken = await curlStatusInNetwork(network, [
      `http://${DATA_PLANE_ALIAS}:${DATA_PLANE_PORT}/v1/cache/${hash}`,
    ]);
    expect(noToken).toBe('401');
    const badToken = await curlStatusInNetwork(network, [
      '-H',
      'Authorization: Bearer cross-journey-not-a-real-key',
      `http://${DATA_PLANE_ALIAS}:${DATA_PLANE_PORT}/v1/cache/${hash}`,
    ]);
    expect(badToken).toBe('401');

    // Pact broker machine API: thiếu token ⇒ 401, token sai ⇒ 401.
    const pactNoToken = await stackGet(`${PACT_API_ORIGIN}/`);
    expect(pactNoToken.status).toBe(401);
    const pactBadToken = await stackGet(`${PACT_API_ORIGIN}/`, {
      authorization: 'Bearer cross-journey-not-a-real-key',
    });
    expect(pactBadToken.status).toBe(401);

    // Backoffice: `/api/**` không session ⇒ 401 (deny-by-default).
    const backofficeNoSession = await stackGet(`${BACKOFFICE_ORIGIN}/api/staff`);
    expect(backofficeNoSession.status).toBe(401);

    // LLM: thiếu header ⇒ 401 invalid_api_key, key không tồn tại ⇒ cùng lớp lỗi
    // ổn định — admission chặn trước mọi ghi.
    const laneNetwork = laneEnv('LLM_E2E_NETWORK');
    const probeBody = JSON.stringify({
      model: DRONIE_MODEL_ID,
      messages: [{ role: 'user', content: 'negative probe' }],
      max_tokens: 8,
    });
    const missing = requestInNetwork(laneNetwork, {
      url: `${WORKER_BASE_URL}/v1/chat/completions`,
      headers: {
        'content-type': 'application/json',
        'x-request-id': `neg-missing-${chainRunToken}`,
      },
      body: probeBody,
    });
    expect(missing.status).toBe(401);
    expect((JSON.parse(missing.body) as { error?: { code?: string | null } }).error?.code).toBe(
      'invalid_api_key',
    );
    const unknown = requestInNetwork(laneNetwork, {
      url: `${WORKER_BASE_URL}/v1/chat/completions`,
      headers: {
        authorization: 'Bearer cross-journey-not-a-real-key',
        'content-type': 'application/json',
        'x-request-id': `neg-unknown-${chainRunToken}`,
      },
      body: probeBody,
    });
    expect(unknown.status).toBe(401);
    expect((JSON.parse(unknown.body) as { error?: { code?: string | null } }).error?.code).toBe(
      'invalid_api_key',
    );
  });

  test('negative: tenant isolation is two-way at Remote Cache and Pact', async ({ page }) => {
    test.setTimeout(180_000);
    // Tenant B: identity riêng của tenant fixture thứ hai, KHÔNG member của
    // `ecoma` ở bất kỳ sản phẩm nào (MỘT tenant B phục vụ cả hai sản phẩm).
    const identityB: Identity = await seedSecondTenantIdentity(`cross-isolation-${chainRunToken}`);

    // --- Remote Cache hai chiều ---
    await page.goto(REMOTE_CACHE_ORIGIN);
    await performBrowserLogin(page, {
      email: identityB.email,
      readOtp: () => identityB.readOtp(Date.now() - 60_000),
      entryUrl: `${REMOTE_CACHE_ORIGIN}/api/auth/login`,
    });
    const cookiesB = await page.context().cookies();
    const sessionB = cookiesB.find((c) => c.name === '__Host-remote-cache-app-session');
    const csrfB = cookiesB.find((c) => c.name === '__Host-remote-cache-app-csrf');
    if (sessionB === undefined || csrfB === undefined) {
      throw new Error('tenant B session cookies missing after login — auth flow did not complete');
    }
    const cookieHeader = `__Host-remote-cache-app-session=${sessionB.value}; __Host-remote-cache-app-csrf=${csrfB.value}`;

    // B gọi portal của `ecoma` ⇒ 403 (không phải member).
    const ecomaList = await stackGet(`${REMOTE_CACHE_ORIGIN}/api/portal/tenants/ecoma/projects`, {
      cookie: cookieHeader,
    });
    expect(ecomaList.status).toBe(403);
    expect(ecomaList.body).not.toContain(rcProjectName);

    // Tenant của chính B được resolve riêng — KHÔNG thấy data `ecoma`.
    const ownList = await stackGet(
      `${REMOTE_CACHE_ORIGIN}/api/portal/tenants/${SECOND_TENANT_NAME}/projects`,
      { cookie: cookieHeader },
    );
    expect(ownList.status).toBe(200);
    expect(ownList.body).not.toContain(rcProjectName);

    // Data-plane: B tạo project + key riêng qua BFF API (`POST /tenants/:t/projects`
    // — UI ghim tenant runtime-config nên test đi đúng đường HTTP mà UI gọi,
    // trên tenant CỦA B; response 201 show-once token). GET cùng hash A đã PUT
    // qua Nx CLI (bước 2) ⇒ 404 — namespace `${tenantId}/…` tách bạch, không
    // leak.
    const createB = await stackRequest(
      `${REMOTE_CACHE_ORIGIN}/api/portal/tenants/${SECOND_TENANT_NAME}/projects`,
      {
        method: 'POST',
        headers: {
          cookie: cookieHeader,
          'x-ecoma-csrf': csrfB.value,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: `cross-journey-b-${chainRunToken}` }),
      },
    );
    expect(createB.status).toBe(201);
    const tokenB = (JSON.parse(createB.body) as { api_key: { token: string } }).api_key.token;
    expect(tokenB.length).toBeGreaterThan(8);

    const readByB = await curlStatusInNetwork(network, [
      '-H',
      `Authorization: Bearer ${tokenB}`,
      `http://${DATA_PLANE_ALIAS}:${DATA_PLANE_PORT}/v1/cache/${'a2'.padEnd(64, '0')}`,
    ]);
    expect(readByB).toBe('404');

    // --- Pact hai chiều (PB-9) ---
    await page.goto(PACT_PORTAL_ORIGIN);
    await performBrowserLogin(page, {
      email: identityB.email,
      readOtp: () => identityB.readOtp(Date.now() - 60_000),
      entryUrl: `${PACT_PORTAL_ORIGIN}/api/auth/login`,
    });
    const secretB = await createPactCredentialViaUi(page, {
      origin: PACT_PORTAL_ORIGIN,
      name: `cross-journey-b-${chainRunToken}`,
      purpose: 'developer',
      scopes: ['read', 'write'],
    });

    // Cùng TÊN pacticipant hai tenant là hợp pháp (UNIQUE `(tenant_id, name)`)
    // — assertion đúng là "nội dung nhìn thấy là của tenant mình".
    mkdirSync(join(workspaceDir, 'tenant-a'), { recursive: true });
    mkdirSync(join(workspaceDir, 'tenant-b'), { recursive: true });
    const pactA = writePactFile(
      join(workspaceDir, 'tenant-a'),
      pactConsumer,
      pactProvider,
      `tenant A interaction ${chainRunToken}`,
    );
    const pactB = writePactFile(
      join(workspaceDir, 'tenant-b'),
      pactConsumer,
      pactProvider,
      `tenant B interaction ${chainRunToken}`,
    );
    const publishA = await runPactCli(
      'pact-broker',
      ['publish', pactA, '--consumer-app-version', '1.0.0'],
      developerSecret,
    );
    expect(publishA.status, scrubForAssertion(publishA.stdout, developerSecret)).toBe(0);
    assertNoTokenInOutput(publishA.stdout, developerSecret);
    const publishB = await runPactCli(
      'pact-broker',
      ['publish', pactB, '--consumer-app-version', '1.0.0'],
      secretB,
    );
    expect(publishB.status, scrubForAssertion(publishB.stdout, secretB)).toBe(0);
    assertNoTokenInOutput(publishB.stdout, secretB);

    // B nhìn thấy NỘI DUNG của B, không của A — tại cùng (tên, version).
    const pactPath = `/pacts/provider/${encodeURIComponent(pactProvider)}/consumer/${encodeURIComponent(pactConsumer)}/version/1.0.0`;
    const fetchedByB = await stackGet(`${PACT_API_ORIGIN}${pactPath}`, {
      authorization: `Bearer ${secretB}`,
    });
    expect(fetchedByB.status).toBe(200);
    expect(fetchedByB.body).toContain(`tenant B interaction ${chainRunToken}`);
    expect(fetchedByB.body).not.toContain(`tenant A interaction ${chainRunToken}`);

    // A nhìn thấy NỘI DUNG của A — hai chiều.
    const fetchedByA = await stackGet(`${PACT_API_ORIGIN}${pactPath}`, {
      authorization: `Bearer ${ciSecret}`,
    });
    expect(fetchedByA.status).toBe(200);
    expect(fetchedByA.body).toContain(`tenant A interaction ${chainRunToken}`);
    expect(fetchedByA.body).not.toContain(`tenant B interaction ${chainRunToken}`);
  });
});
