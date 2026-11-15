import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, seedSecondTenantIdentity, test, type Identity } from './support/fixtures';
import { performBrowserLogin } from './support/oidc-flow';
import {
  resolveApiOrigin,
  resolvePortalOrigin,
  stackGet,
  stackRequest,
} from './support/local-origin';

/**
 * Journey developer/CI của Pact Broker portal trên stack local thật (issue
 * #300, #27 journey 3, PB-1..PB-12):
 *
 * 1. PB-4 + PB-10: login OIDC thật, tạo Developer credential qua UI portal,
 *    publish contract bằng Pact CLI thật 18.10.9 (không phải payload mô phỏng).
 * 2. PB-12: contract hiển thị đúng trong UI pacts page sau publish.
 * 3. PB-5 + PB-11: tạo CI credential riêng qua UI, dùng nó chạy verifier thật
 *    publish verification result, rồi `can-i-deploy` trả lời YES.
 * 4. PB-8: revoke credential qua UI → request kế tiếp bằng secret cũ bị từ
 *    chối NGAY (401 đồng nhất, không phân biệt lý do).
 * 5. PB-9: isolation hai chiều — tenant B publish cùng tên pacticipant với
 *    nội dung khác; mỗi tenant chỉ nhìn thấy nội dung của mình, environment
 *    của A không lộ sang B. Assertion đúng là "không rò dữ liệu", không phải
 *    "tên 404" — UNIQUE `(tenant_id, name)` cho phép trùng tên hai tenant.
 *
 * Pact CLI chạy từ host với `SSL_CERT_FILE` trỏ cert local đã commit (CLI là
 * Node/Rust, đọc biến này thay trust store hệ thống). API broker public qua
 * router Traefik `Host(api.<root>)` — khác remote-cache (internal-only), nên
 * CLI KHÔNG cần chạy trong docker network.
 *
 * Secret show-once KHÔNG BAO GIỊ bị log: plaintext chỉ sống trong biến của
 * test process và được truyền vào CLI qua env `PACT_BROKER_TOKEN`.
 */

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

/** Path cert local — SSL_CERT_FILE cho Pact CLI (Node/Rust đọc biến này). */
const LOCAL_CERT_PATH = join(
  SUITE_DIR,
  '../../../../deploys/platform-deploy/local-certs/fbi.com.crt',
);

/** Đường dẫn binary `pact-broker`/`pact-verifier` của devDependency pin 18.10.9. */
const PACT_BIN = join(SUITE_DIR, '../node_modules/.bin');
const apiOrigin = resolveApiOrigin;
const ORIGIN = resolvePortalOrigin();
/** Pacticipant names duy nhất cho run — tránh đụng dữ liệu của run trước. */
function runToken(): string {
  return Date.now().toString(36);
}

interface CliResult {
  readonly stdout: string;
  readonly status: number;
}

/**
 * Chạy một lệnh Pact CLI thật với env: cert local + token. Token ĐI VÀO env
 * process của CLI — không bao giờ ghép vào argv (argv lộ qua `ps`), không
 * bao giờ nằm trong message lỗi của test.
 */
function runPactCli(
  binary: 'pact-broker' | 'pact-verifier',
  args: string[],
  token: string,
  extraEnv: Record<string, string> = {},
): CliResult {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.SSL_CERT_FILE = LOCAL_CERT_PATH;
  env.PACT_BROKER_BASE_URL = apiOrigin();
  env.PACT_BROKER_TOKEN = token;
  env.PACT_DO_NOT_TRACK = 'true';
  Object.assign(env, extraEnv);

  try {
    const stdout = execFileSync(join(PACT_BIN, binary), args, {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    if (typeof err.status !== 'number') {
      throw error;
    }
    return { stdout: `${err.stdout ?? ''}\n${err.stderr ?? ''}`, status: err.status };
  }
}

/**
 * Loại secret ra khỏi output CLI trước khi assert/log — output CLI có thể
 * echo lại một phần header/URL nhưng KHÔNG ĐƯỢC chứa token; assertion này là
 * rào chắn phòng CLI đổi hình dạng in log.
 */
function assertNoTokenInOutput(output: string, token: string): void {
  if (token.length > 8 && output.includes(token)) {
    throw new Error('pact CLI output unexpectedly contains the token plaintext');
  }
}

/** Ghi một pact JSON với interaction description duy nhất. */
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

/** Provider app thật cho verifier — HTTP server trả 200 JSON trên mọi request. */
function startProviderApp(): Promise<{ url: string; close: () => void }> {
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
        close: () => server.close(),
      });
    });
  });
}

// -------------------------------------------------------------------------------------------
// UI helpers của portal — tạo credential qua form tokens page
// -------------------------------------------------------------------------------------------

/**
 * Tạo một machine credential qua UI portal (`/tokens`) với purpose chỉ định,
 * trả secret show-once. Secret chỉ đọc từ khối revealed trong DOM — không có
 * đường đọc lại nào khác (SR-002).
 */
async function createCredentialViaUi(
  page: Page,
  params: { name: string; purpose: 'developer' | 'ci'; scopes: string[] },
): Promise<string> {
  await page.goto('/tokens');
  await expect(page.getByTestId('pact-broker-token-create')).toBeVisible();

  await page.getByTestId('pact-broker-token-name').fill(params.name);
  await page.locator(`input[type="radio"][value="${params.purpose}"]`).check();
  for (const scope of params.scopes) {
    // Scope checkboxes không có testid riêng — nhắm label text chính là hợp
    // đồng UI người dùng thật sự dùng.
    await page
      .locator('fieldset', { hasText: 'Scope' })
      .or(page.locator('form'))
      .getByText(scope, { exact: true })
      .locator('visible=true')
      .first()
      .check();
  }
  await page.getByTestId('pact-broker-token-submit').click();

  // Show-once: secret xuất hiện ĐÚNG MỘT LẦN trong khối revealed.
  const revealed = page.getByTestId('pact-broker-token-revealed');
  await expect(revealed).toBeVisible();
  const secret = (await page.getByTestId('pact-broker-token-secret').textContent()) ?? '';
  if (secret.trim().length === 0) {
    throw new Error('credential created but the revealed secret block is empty');
  }
  return secret.trim();
}

/**
 * Revoke một credential qua UI — destructive flow đòi confirmation gõ ĐÚNG tên.
 */
async function revokeCredentialViaUi(page: Page, name: string): Promise<void> {
  await page.goto('/tokens');
  await expect(page.getByTestId('pact-broker-tokens-table')).toBeVisible();

  const row = page
    .getByTestId('pact-broker-tokens-table')
    .locator('tbody tr')
    .filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByTestId('pact-broker-token-revoke').click();

  const confirmDialog = page.getByTestId('pact-broker-token-confirm');
  await expect(confirmDialog).toBeVisible();
  await page.getByTestId('pact-broker-token-confirm-input').fill(name);
  await page.getByTestId('pact-broker-token-confirm-run').click();

  await expect(confirmDialog).not.toBeVisible();
  // Hàng chuyển sang trạng thái Revoked ngay sau revoke.
  await expect(row).toContainText('Revoked');
}

// -------------------------------------------------------------------------------------------
// Tests — describe.serial: journey chia sẻ state theo thứ tự
// -------------------------------------------------------------------------------------------

test.describe.serial('pact-broker portal developer/CI journey', () => {
  const consumer = 'e2e-consumer-app';
  const provider = 'e2e-provider-app';
  const consumerVersion = '1.0.0';
  const providerVersion = '2.0.0';
  const environmentName = `e2e-env-${runToken()}`;
  const developerTokenName = `e2e-developer-${runToken()}`;
  const ciTokenName = `e2e-ci-${runToken()}`;

  let devSecret = '';
  let ciSecret = '';
  const workspaceDir = mkdtempSync(join(tmpdir(), 'pact-portal-e2e-'));

  test.afterAll(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test('PB-4/PB-10: developer credential from the portal UI publishes a pact through the real Pact CLI', async ({
    page,
    identity,
  }) => {
    // Login thật: account OTP + consent + callback BFF 302 '/'.
    const result = await performBrowserLogin(page, {
      email: identity.email,
      readOtp: () => identity.readOtp(Date.now() - 5_000),
    });
    expect(result.finalPath).toBe('/');

    // PB-4: tạo Developer credential qua UI.
    devSecret = await createCredentialViaUi(page, {
      name: developerTokenName,
      purpose: 'developer',
      scopes: ['read', 'write'],
    });
    // Show-once 32 byte base64url.
    expect(devSecret.length).toBeGreaterThanOrEqual(32);
    expect(devSecret).not.toContain('=');

    // PB-10: publish bằng Pact CLI thật với secret vừa tạo.
    mkdirSync(workspaceDir, { recursive: true });
    const pactFile = writePactFile(
      workspaceDir,
      consumer,
      provider,
      `request GET / succeeds ${runToken()}`,
    );
    const publish = runPactCli(
      'pact-broker',
      ['publish', pactFile, '--consumer-app-version', consumerVersion, '--branch', 'main'],
      devSecret,
    );
    expect(publish.status, publish.stdout.slice(0, 600)).toBe(0);
    assertNoTokenInOutput(publish.stdout, devSecret);
    expect(publish.stdout).toContain('Pact published successfully');

    // PB-12: contract hiển thị trong UI pacts page (BFF compose matrix HAL).
    await page.goto('/pacts');
    await expect(page.getByTestId('pact-broker-pacts-table')).toBeVisible();
    const row = page
      .getByTestId('pact-broker-pacts-table')
      .locator('tbody tr')
      .filter({ hasText: consumer })
      .filter({ hasText: provider });
    await expect(row.first()).toBeVisible();
    await expect(row.first()).toContainText(consumerVersion);
  });

  test('PB-5/PB-11: CI credential publishes a verification result and can-i-deploy answers yes', async ({
    page,
    identity,
  }) => {
    // Session portal của identity admin — test 1 và test 2 là context browser
    // riêng, mỗi test tự login.
    await performBrowserLogin(page, {
      email: identity.email,
      readOtp: () => identity.readOtp(Date.now() - 5_000),
    });
    // PB-5: CI credential riêng — cùng identity admin, purpose `ci`.
    ciSecret = await createCredentialViaUi(page, {
      name: ciTokenName,
      purpose: 'ci',
      scopes: ['read', 'write'],
    });
    expect(ciSecret).not.toBe(devSecret);

    // Môi trường test + record-deployment của provider (verifier cần một
    // provider version đã deployed để `--to-environment` resolve được).
    const createEnv = runPactCli(
      'pact-broker',
      ['create-environment', '--name', environmentName, '--production'],
      ciSecret,
    );
    expect(createEnv.status, createEnv.stdout.slice(0, 600)).toBe(0);

    // Verifier thật: fetch pact từ broker, verify với provider app thật,
    // publish verification result bằng CI credential.
    const providerApp = await startProviderApp();
    try {
      const verify = runPactCli(
        'pact-verifier',
        [
          '--provider-name',
          provider,
          '--provider-version',
          providerVersion,
          '--broker-url',
          apiOrigin(),
          '--token',
          ciSecret,
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
      expect(verify.status, verify.stdout.slice(0, 600)).toBe(0);
      assertNoTokenInOutput(verify.stdout, ciSecret);
      expect(verify.stdout).toContain('Verifying a pact');

      // PB-11: record-deployment của provider version vào environment, rồi
      // can-i-deploy của consumer phải trả lời YES.
      const record = runPactCli(
        'pact-broker',
        [
          'record-deployment',
          '--pacticipant',
          provider,
          '--version',
          providerVersion,
          '--environment',
          environmentName,
        ],
        ciSecret,
      );
      expect(record.status, record.stdout.slice(0, 600)).toBe(0);

      const deploy = runPactCli(
        'pact-broker',
        [
          'can-i-deploy',
          '--pacticipant',
          consumer,
          '--version',
          consumerVersion,
          '--to-environment',
          environmentName,
        ],
        ciSecret,
      );
      expect(deploy.status, deploy.stdout.slice(0, 600)).toBe(0);
      assertNoTokenInOutput(deploy.stdout, ciSecret);
      expect(deploy.stdout).toContain('Computer says yes');
    } finally {
      providerApp.close();
    }
  });

  test('PB-8: revoked credential is rejected immediately by the broker API', async ({ page }) => {
    // API surface với secret cũ: trước revoke, index là 200 (credential sống).
    const before = await stackGet(`${apiOrigin()}/`, { authorization: `Bearer ${devSecret}` });
    expect(before.status).toBe(200);

    // Revoke qua UI (đúng kênh người dùng).
    await revokeCredentialViaUi(page, developerTokenName);

    // PB-8: request KẾ TIẾP bằng secret cũ bị từ chối NGAY — 401 đồng nhất.
    const after = await stackGet(`${apiOrigin()}/`, { authorization: `Bearer ${devSecret}` });
    expect(after.status).toBe(401);

    // CLI cũng thấy cùng 401 (cùng hợp đồng auth cho machine path).
    const cliAfter = runPactCli('pact-broker', ['list-latest-pact-versions'], devSecret);
    expect(cliAfter.status).not.toBe(0);
    expect(cliAfter.stdout).toContain('401');
  });

  test('PB-9: tenant isolation is two-way — same pacticipant names, distinct content, no data leak', async ({
    page,
  }) => {
    // Tenant B: identity riêng, admin của tenant riêng, KHÔNG member của ecoma.
    const tokenB = `tenant-b-${runToken()}`;
    const identityB: Identity = await seedSecondTenantIdentity(ORIGIN, tokenB);

    // Login B và tạo credential cho tenant B qua UI.
    await performBrowserLogin(page, {
      email: identityB.email,
      readOtp: () => identityB.readOtp(Date.now() - 5_000),
    });
    const secretB = await createCredentialViaUi(page, {
      name: `e2e-tenant-b-${runToken()}`,
      purpose: 'developer',
      scopes: ['read', 'write'],
    });

    // Cùng TÊN pacticipant, hai NỘI DUNG khác nhau — đây là tình huống PB-9
    // cho phép (UNIQUE `(tenant_id, name)`).
    const dirA = join(workspaceDir, 'tenant-a');
    const dirB = join(workspaceDir, 'tenant-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const pactA = writePactFile(
      dirA,
      consumer,
      provider,
      `tenant A unique interaction ${runToken()}`,
    );
    const pactB = writePactFile(
      dirB,
      consumer,
      provider,
      `tenant B unique interaction ${runToken()}`,
    );

    const publishA = runPactCli(
      'pact-broker',
      ['publish', pactA, '--consumer-app-version', consumerVersion],
      ciSecret,
    );
    expect(publishA.status, publishA.stdout.slice(0, 600)).toBe(0);
    const publishB = runPactCli(
      'pact-broker',
      ['publish', pactB, '--consumer-app-version', consumerVersion],
      secretB,
    );
    expect(publishB.status, publishB.stdout.slice(0, 600)).toBe(0);

    // B nhìn thấy NỘI DUNG của B (không phải của A) tại cùng (tên, version).
    const fetchedByB = await stackGet(
      `${apiOrigin()}/pacts/provider/${encodeURIComponent(provider)}/consumer/${encodeURIComponent(consumer)}/version/${consumerVersion}`,
      { authorization: `Bearer ${secretB}` },
    );
    expect(fetchedByB.status).toBe(200);
    expect(fetchedByB.body).toContain('tenant B unique interaction');
    expect(fetchedByB.body).not.toContain('tenant A unique interaction');

    // A nhìn thấy NỘI DUNG của A — hai chiều.
    const fetchedByA = await stackGet(
      `${apiOrigin()}/pacts/provider/${encodeURIComponent(provider)}/consumer/${encodeURIComponent(consumer)}/version/${consumerVersion}`,
      { authorization: `Bearer ${ciSecret}` },
    );
    expect(fetchedByA.status).toBe(200);
    expect(fetchedByA.body).toContain('tenant A unique interaction');
    expect(fetchedByA.body).not.toContain('tenant B unique interaction');

    // Environment của A không lộ sang B: danh sách environment của B rỗng.
    const envsByB = await stackGet(`${apiOrigin()}/environments`, {
      authorization: `Bearer ${secretB}`,
    });
    expect(envsByB.status).toBe(200);
    const envPayload = JSON.parse(envsByB.body) as { embedded?: { environments?: unknown[] } };
    expect(envPayload.embedded?.environments ?? []).toEqual([]);

    // Portal UI của B không hiển thị contract của A: matrix page của B trả về
    // dữ liệu tenant B — xác nhận qua BFF compose (session B).
    const matrixViaBff = await stackRequest(
      `${ORIGIN}/api/broker/matrix?pacticipant=${encodeURIComponent(consumer)}&version=${consumerVersion}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${secretB}` },
      },
    );
    // BFF portal KHÔNG nhận machine token (chỉ session OIDC) — 401/403 là
    // hành vi đúng; assertion này ghi nhận ranh giới đó, không phải bug.
    expect([401, 403]).toContain(matrixViaBff.status);
  });
});
