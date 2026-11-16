import { X509Certificate, createHash } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

import { localServiceHostname } from '@ecoma-io/deployment';

import {
  localCertPemOrEmpty,
  rootHostRaw,
  splitHostPort,
  traefikNamespaceOrNull,
} from './e2e/support/stack-env';

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

/** PEM của cert local — rỗng khi host/cert chưa có; spkiHash degrade theo. */
let localCaPemCache: string | undefined;
function localCaPemOrEmpty(): string {
  localCaPemCache ??= localCertPemOrEmpty();
  return localCaPemCache;
}

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

/** SPKI hash — lazy: hash cert một lần khi Chromium cần cờ SPKI pin. */
let spkiHashCache: string | undefined;
function spkiHashOrEmpty(): string {
  if (spkiHashCache !== undefined) {
    return spkiHashCache;
  }
  const pem = localCaPemOrEmpty();
  if (pem.length === 0) {
    // Cert chưa có (worktree chưa deploy): hash rỗng — config load vẫn OK theo
    // hợp đồng; test thật sẽ đỏ qua global-setup gate hoặc TLS failure.
    spkiHashCache = '';
    return spkiHashCache;
  }
  try {
    spkiHashCache = computeSpkiHash(pem);
  } catch {
    spkiHashCache = '';
  }
  return spkiHashCache;
}

/**
 * Origin portal từ hostname gốc (`ROOT_HOST`, dạng `hostname:port`):
 * hostname per-worktree (#316) `remote-cache-app-<ns>.<root>` từ
 * `localServiceHostname` — cùng tên mà router Traefik của deploy đăng ký
 * (`deploys/remote-cache-app-deploy/index.ts`); port giữ nguyên vì Traefik
 * local nghe port ĐỘNG map ra loopback.
 *
 * ⚠️ KHÔNG throw khi thiếu: Docker vắng mặt ⇒ placeholder
 * `remote-cache-app.placeholder.invalid:port` (RFC 2606) không resolve được —
 * nếu gate global-setup bị bỏ qua thì mọi test đỏ với DNS failure thay vì xanh giả.
 */
function resolveStackOrigin(): string {
  const raw = rootHostRaw();
  if (raw === undefined) {
    return 'remote-cache-app.placeholder.invalid:443';
  }
  const { hostname, port } = splitHostPort(raw);
  // Docker vắng mặt → namespace `undefined` → giữ placeholder gốc, không throw
  // (hợp đồng graph-eval ở đầu file; gate fail-closed thuộc global-setup).
  const { namespace } = traefikNamespaceOrNull(port);
  if (namespace === undefined) {
    return `remote-cache-app.placeholder.invalid:${port}`;
  }
  return `${localServiceHostname('remote-cache-app', hostname, namespace)}:${port}`;
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
    // Portal phục vụ ở hostname per-worktree `remote-cache-app-<ns>.<root>`
    // (#316) — mọi browser navigation mặc định trỏ đây (rule router Traefik là
    // `Host(\`remote-cache-app-<ns>.<root>\`)`).
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
          // Playwright đọc `launchOptions.args` một lần khi CONFIG LOAD — không
          // có hook "chỉ khi launch". Muốn config không throw trên worktree
          // chưa deploy, giá trị SPKI phải tự degrade: thiếu cert ⇒ hash rỗng
          // (browser fail TLS thật khi test chạy — chưa deploy thì test không
          // thể xanh giả; global-setup vẫn là gate chính).
          args: [`--ignore-certificate-errors-spki-list=${spkiHashOrEmpty()}`],
        },
      },
    },
  ],
});
