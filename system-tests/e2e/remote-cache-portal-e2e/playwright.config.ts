import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Cấu hình Playwright cho suite system E2E `remote-cache-portal-e2e` —
 * journey developer onboarding của portal `remote-cache-app` trên stack local
 * thật: OIDC login, tạo project + show-once key, revoke, negative cross-tenant,
 * và journey Nx CLI thật với self-hosted remote cache.
 *
 * Suite này copy skeleton của `backoffice-access-control-e2e` và giữ nguyên mọi
 * quyết định kiến trúc đã kiểm chứng thực nghiệm ở đó:
 *
 * - **Config KHÔNG BAO GIỜ throw**: `@nx/playwright`-style graph evaluation và
 *   lệnh `--list` không có `.env` — thiếu `ROOT_HOST` trả placeholder
 *   `remote-cache-app.placeholder.invalid:443` vô hại; fail-closed thật nằm ở
 *   `global-setup.ts`.
 * - **TLS verify thật, không `ignoreHTTPSErrors`**: Node request qua
 *   `node:https` với `ca` scoped (`e2e/support/local-origin.ts`); browser dùng
 *   Chromium SPKI pin — hash base64 SHA-256 của DER SubjectPublicKeyInfo tính
 *   TẠI CONFIG LOAD từ cert đã commit.
 * - **Không `webServer`**: stack là external state quản bởi lane Nx `local-up`;
 *   property `globalSetup` + gate fail-closed là CẶP phải luôn đi cùng nhau.
 * - **`retries: 0` kể cả CI** và `workers: 2` ghim — cùng triết lý với suite
 *   backoffice: retry che flake thật, worker lớn làm upstream đói.
 */

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

/** Path cert local — thiếu là config load fail (ENOENT), đúng ý. */
const LOCAL_CERT_PATH = join(SUITE_DIR, '../../../deploys/platform-deploy/local-certs/fbi.com.crt');

/** PEM của cert local — dùng cho mọi Node request của suite. */
export const LOCAL_CA_PEM = readFileSync(LOCAL_CERT_PATH, 'utf8');

/**
 * SPKI hash (base64 SHA-256 của DER SubjectPublicKeyInfo) — pin public key của
 * cert local cho cờ `--ignore-certificate-errors-spki-list` của Chromium.
 * Cert đổi theo repo là hash đổi theo, không có giá trị hardcode nào phải cập nhật.
 */
function computeSpkiHash(pem: string): string {
  const cert = new X509Certificate(pem);
  const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spkiDer).digest('base64');
}

const SPKI_HASH = computeSpkiHash(LOCAL_CA_PEM);

/**
 * Origin portal từ hostname gốc (`ROOT_HOST`, dạng `hostname:port`): GHÉP PREFIX
 * `remote-cache-app.` — router Traefik của portal match
 * `Host(remote-cache-app.<root>)`, port giữ nguyên vì Traefik local nghe port
 * ĐỘNG map ra loopback. Giá trị raw của `ROOT_HOST` là hostname gốc, không
 * router nào serve portal trên đó.
 *
 * ⚠️ KHÔNG throw khi thiếu: trả placeholder `.invalid` (RFC 2606) không resolve
 * được — nếu gate global-setup bị bỏ qua thì mọi test đỏ với DNS failure thay
 * vì xanh giả.
 */
function resolveStackOrigin(): string {
  const raw = process.env.ROOT_HOST;
  if (raw !== undefined && raw.trim().length > 0) {
    return withPortalOrigin(raw.trim());
  }
  // Fallback cho lệnh gọi ngoài Nx: parse `.env` repo root (Nx load `.env` vào
  // env của task qua `nx run`, còn CLI trực tiếp thì không).
  const envPath = join(SUITE_DIR, '../../../.env');
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const match = /^ROOT_(?:DOMAIN|HOST)=(.*)$/u.exec(line.trim());
      if (match && match[1].trim().length > 0) {
        return withPortalOrigin(match[1].trim());
      }
    }
  } catch {
    // `.env` vắng mặt — placeholder bên dưới thay thế; gate là đường fail-closed thật.
  }
  return 'remote-cache-app.placeholder.invalid:443';
}

/** Ghép hostname gốc (dạng `hostname:port`) thành `remote-cache-app.<hostname>:<port>`. */
function withPortalOrigin(raw: string): string {
  const rootHostname = raw.split(':')[0];
  const port = raw.includes(':') ? raw.split(':')[1] : '443';
  return `remote-cache-app.${rootHostname}:${port}`;
}

const ROOT_ORIGIN = resolveStackOrigin();

export default defineConfig({
  // Gate fail-closed chạy trước test đầu tiên — module mặc định export chính
  // hàm `main` (KHÔNG phải `main()`: export Promise là crash `globalSetup`).
  globalSetup: './global-setup.ts',
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // `retries: 0` kể cả trên CI — retry biến một flake thật thành một lần xanh
  // và không ai đọc lại log; với system E2E thì flake còn có thể là dấu hiệu
  // routing/restart loop thật của stack.
  retries: 0,
  // Ghim worker: stack local là một dev machine chạy đủ container; số worker
  // lớn hơn làm các upstream đói và test timeout — triệu chứng giống lỗi app.
  workers: 2,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    // Portal phục vụ ở subdomain `remote-cache-app` — mọi browser navigation
    // mặc định trỏ đây (rule router Traefik là `Host(remote-cache-app.<root>)`).
    baseURL: `https://${ROOT_ORIGIN}`,
    // ⚠️ KHÔNG BAO GIỜ `ignoreHTTPSErrors: true` — browser test nào cần cert
    // local phải qua project-level `launchOptions` bên dưới.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // SPKI pin scoped cho cert local — "tin ĐÚNG public key này", không
        // phải "tin mọi certificate".
        launchOptions: {
          args: [`--ignore-certificate-errors-spki-list=${SPKI_HASH}`],
        },
      },
    },
  ],
});
