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
 * Cấu hình Playwright cho suite system E2E `cross-product-journey-e2e` —
 * chuỗi MVP xuyên bốn sản phẩm trên stack local thật (#27). Suite copy skeleton
 * của `remote-cache-portal-e2e` và giữ nguyên mọi quyết định kiến trúc đã kiểm
 * chứng thực nghiệm ở đó:
 *
 * - **Config KHÔNG BAO GIỜ throw**: thiếu `ROOT_HOST` trả placeholder
 *   `office.placeholder.invalid:443` vô hại; fail-closed thật nằm ở
 *   `global-setup.ts`.
 * - **TLS verify thật, không `ignoreHTTPSErrors`**: browser dùng Chromium SPKI
 *   pin — hash base64 SHA-256 của DER SubjectPublicKeyInfo tính TẠI CONFIG LOAD
 *   từ cert đã commit.
 * - **Không `webServer`**: stack là external state quản bởi lane Nx `local-up`;
 *   property `globalSetup` + gate fail-closed là CẶP phải luôn đi cùng nhau.
 * - **`retries: 0` kể cả CI** và `workers: 2` ghim — retry che flake thật,
 *   worker lớn làm upstream đói.
 *
 * `baseURL` là origin Backoffice — bước 1 của chuỗi; các origin portal khác
 * (pact, api, remote-cache-app) các spec resolve tường minh qua
 * `e2e/support/local-origin.ts`.
 */

/** PEM của cert local — rỗng khi host/cert chưa có; spkiHash degrade theo. */
let localCaPemCache: string | undefined;
function localCaPemOrEmpty(): string {
  localCaPemCache ??= localCertPemOrEmpty();
  return localCaPemCache;
}

function computeSpkiHash(pem: string): string {
  const cert = new X509Certificate(pem);
  const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spkiDer).digest('base64');
}

let spkiHashCache: string | undefined;
function spkiHashOrEmpty(): string {
  if (spkiHashCache !== undefined) {
    return spkiHashCache;
  }
  const pem = localCaPemOrEmpty();
  if (pem.length === 0) {
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
 * Origin Backoffice từ hostname gốc (`ROOT_HOST`, dạng `hostname:port`):
 * `office-<ns>.<root>` qua `localServiceHostname` — cùng tên mà router Traefik
 * của deploy đăng ký (`deploys/backoffice-deploy/index.ts`). KHÔNG throw khi
 * thiếu — placeholder `.invalid` vô hại theo hợp đồng graph-eval.
 */
function resolveBackofficeOrigin(): string {
  const raw = rootHostRaw();
  if (raw === undefined) {
    return 'office.placeholder.invalid:443';
  }
  const { hostname, port } = splitHostPort(raw);
  const { namespace } = traefikNamespaceOrNull(port);
  if (namespace === undefined) {
    return `office.placeholder.invalid:${port}`;
  }
  return `${localServiceHostname('office', hostname, namespace)}:${port}`;
}

const ROOT_ORIGIN = resolveBackofficeOrigin();

export default defineConfig({
  globalSetup: './global-setup.ts',
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
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
        launchOptions: {
          // SPKI pin scoped cho cert local — "tin ĐÚNG public key này".
          args: [`--ignore-certificate-errors-spki-list=${spkiHashOrEmpty()}`],
        },
      },
    },
  ],
});
