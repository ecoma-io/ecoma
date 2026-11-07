import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Cấu hình Playwright cho suite system E2E `identity-login-e2e` — suite kiểm
 * luồng đăng nhập email-OTP của `account` end-to-end qua stack local thật
 * (DNS → TLS → Traefik → account → Postgres → transactional-mail → D1 sink).
 *
 * Copy cấu trúc từ skeleton `system-tests/e2e/home-public-e2e/` (issue #355,
 * #359) — các quyết định kiến trúc đã được skeleton kiểm chứng thực nghiệm,
 * phần dưới chỉ ghi phần RIÊNG của suite này; giải thích đầy đủ của từng lớp
 * nằm ở config của skeleton:
 *
 * - Config KHÔNG BAO GIỜ throw khi thiếu `ROOT_DOMAIN`/`ROOT_HOST`: plugin
 *   `@nx/playwright` eval config này LÚC DỰNG PROJECT GRAPH, throw ở đây làm
 *   MỌI job CI đỏ kể cả `nx affected` không đụng gì tới suite (runner CI không
 *   có `.env`). Thiếu origin → trả placeholder `.invalid:443` vô hại; fail-
 *   closed thật nằm ở `global-setup.ts` (wire qua property `globalSetup`).
 * - Target `e2e` mà plugin suy ra bị ĐÈ bằng stub `echo` trong `package.json`
 *   — đây là LỚP CHẶN THỨ HAI của PR CI; suite thật chạy qua target
 *   `system-test`. Cả hai lớp phải đi cùng nhau, đừng bỏ một trong hai.
 * - TLS verify THẬT SỰ qua scoped trust: `ca` của cert local cho mọi Node
 *   request (`e2e/support/local-origin.ts`) và SPKI pin cho Chromium. Không
 *   `ignoreHTTPSErrors: true`, không `NODE_TLS_REJECT_UNAUTHORIZED=0`.
 * - `retries: 0` kể cả CI, `workers: 2`, timeout 60s, expect 15s, reporter
 *   `github`+`html` trên CI / `list` ở local, ESM dùng `import.meta.url`.
 *
 * Khác skeleton ở đúng ba điểm: (1) `baseURL` là origin ACCOUNT
 * (`account.<host>:<port>`) thay vì apex — mọi navigation browser của suite
 * này trỏ sub-domain account; port vẫn giữ trong URL vì Traefik local nghe
 * port ĐỘNG map ra loopback (cắt port là `ERR_CONNECTION_REFUSED` cho cả
 * suite — bài học đã trả giá của skeleton); (2) suite này chủ yếu là API
 * assertion thuần qua `e2e/support/local-origin.ts` (login flow là chuỗi
 * POST + Set-Cookie, không cần render) nên chỉ một project chromium duy nhất
 * giữ SPKI pin cho đúng contract "browser verification hoạt động" nếu sau
 * này thêm test browser; (3) không đọc `.env` ở fallback (xem bên dưới).
 */

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

/** Path cert local, resolve từ thư mục suite — thiếu là config load fail (ENOENT), đúng ý. */
const LOCAL_CERT_PATH = join(SUITE_DIR, '../../../deploys/platform-deploy/local-certs/fbi.com.crt');

/** PEM của cert local — dùng cho mọi Node request của suite (xem khối TLS ở đầu file). */
export const LOCAL_CA_PEM = readFileSync(LOCAL_CERT_PATH, 'utf8');

/**
 * SPKI hash (base64 SHA-256 của DER SubjectPublicKeyInfo) — pin public key của
 * cert local cho cờ `--ignore-certificate-errors-spki-list` của Chromium.
 * Tính tại config load: cert đổi → hash đổi → browser trust theo cert MỚI.
 */
function computeSpkiHash(pem: string): string {
  const cert = new X509Certificate(pem);
  const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spkiDer).digest('base64');
}

const SPKI_HASH = computeSpkiHash(LOCAL_CA_PEM);

/** Tách `host:port` từ giá trị `ROOT_DOMAIN`/`ROOT_HOST`, mặc định port 443. */
function withOrigin(raw: string): string {
  const hostname = raw.split(':')[0];
  const port = raw.includes(':') ? raw.split(':')[1] : '443';
  return `${hostname}:${port}`;
}

/**
 * Origin ACCOUNT của stack local — `account.<host>:<port>`, giữ nguyên port
 * (khối "KHÔNG cắt port" ở đầu file).
 *
 * Nguồn giá trị: `ROOT_DOMAIN`/`ROOT_HOST` env (Nx load `.env` repo root ngay
 * lúc CLI boot, nên qua `nx run`/`npx playwright test` dưới target Nx thì
 * biến có sẵn; plugin eval config lúc dựng graph cũng thấy env đó). Chạy
 * `npx playwright test` TRỰC TIẾP ngoài Nx và không có env: trả placeholder,
 * KHÔNG parse `.env` ở MỚI CONFIG (config eval lúc dựng project graph, đọc
 * `.env` ở lớp đó là IO bỏ khi `nx affected` không đụng suite). Lớp helper
 * runtime (`e2e/support/local-origin.ts`, `global-setup.ts`) CÓ fallback parse
 * `.env` TẠI THỜI ĐIỂM CHẠY: orchestrator Nx snapshot env của MỌI task đã
 * schedule trước khi `platform-deploy:local-up` kịp ghi `.env`, nên đường
 * một-invocation (`nx affected -t system-test -c local`) cần đọc FILE lúc
 * global-setup/test chạy để thấy giá trị platform vừa ghi. Placeholder
 * `.invalid` (RFC 2606) không resolve được: nếu ai đó bỏ qua gate thì mọi test
 * đỏ với DNS failure thay vì xanh giả.
 */
function resolveStackOrigin(): string {
  const raw = process.env.ROOT_DOMAIN ?? process.env.ROOT_HOST;
  if (raw !== undefined && raw.trim().length > 0) {
    return `account.${withOrigin(raw.trim())}`;
  }
  return 'account.placeholder.invalid:443';
}

const ACCOUNT_ORIGIN = resolveStackOrigin();

export default defineConfig({
  // Gate fail-closed chạy trước test đầu tiên — module mặc định export chính
  // hàm `main` (KHÔNG phải `main()`): export Promise là crash `globalSetup`.
  globalSetup: './global-setup.ts',
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // `retries: 0` kể cả trên CI — retry biến một flake thật thành một lần xanh
  // và không ai đọc lại log; với system E2E thì flake còn đáng ngờ hơn nữa.
  retries: 0,
  // Ghim worker (không để mặc định `cpus/2`): stack local là một dev machine
  // chạy đủ 11 container. Ghim cùng số ở local và CI để thứ được kiểm ở đây
  // đúng là thứ chạy trên CI.
  workers: 2,
  // Reporter `github` ghi annotation ngay trên PR; `html` sinh
  // `playwright-report/` để job CI upload kèm trace/screenshot khi đỏ.
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    // Luồng login phục vụ ở sub-domain account — mọi navigation mặc định trỏ đây.
    baseURL: `https://${ACCOUNT_ORIGIN}`,
    // ⚠️ KHÔNG BAO GIỜ `ignoreHTTPSErrors: true` — TLS phải được verify thật.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // SPKI pin scoped cho cert local — semantic "tin ĐÚNG public key này",
        // không phải "tin mọi certificate". Suite này không navigation browser
        // nào hiện tại (mọi assertion qua Node https), nhưng giữ project đúng
        // contract của skeleton để test browser sau này không phải cấu hình lại.
        launchOptions: {
          args: [`--ignore-certificate-errors-spki-list=${SPKI_HASH}`],
        },
      },
    },
  ],
});
