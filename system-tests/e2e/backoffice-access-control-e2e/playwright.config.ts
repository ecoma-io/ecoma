import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Cấu hình Playwright cho suite system E2E `backoffice-access-control-e2e` —
 * suite kiểm soát truy cập của BFF backoffice qua stack local thật
 * (denial chưa đăng nhập, access đã đăng nhập, denial thiếu permission).
 *
 * Suite này copy skeleton của `home-public-e2e` và giữ nguyên mọi quyết định
 * kiến trúc đã được kiểm chứng thực nghiệm ở đó. Ba quyết định được lặp lại
 * tường minh vì suite kế tiếp lại copy từ đây:
 *
 * ═══ Config KHÔNG BAO GIỜ throw ═══
 *
 * `@nx/playwright` plugin EVAL config này LÚC DỰNG PROJECT GRAPH (để suy target
 * `e2e`), mà runner CI không có `.env` (stack local không tồn tại ở đó) —
 * throw khi thiếu `ROOT_DOMAIN`/`ROOT_HOST` làm MỌI job CI đỏ với cùng một
 * graph error, kể cả lệnh `nx affected` không đụng gì đến suite (bài học đã trả
 * giá thật của `home-public-e2e`). Config trả placeholder
 * `office.placeholder.invalid:443` vô hại; fail-closed thật nằm ở
 * `global-setup.ts` (probe trước test đầu tiên, exit 1
 * với remedy `pnpm nx affected -t system-test -c local` (Nx tự provision các prerequisite `local-up`)).
 *
 * ═══ TLS verify thật, không `ignoreHTTPSErrors` ═══
 *
 * Node fetch/API assertion: `node:https` với `ca` của riêng cert local (xem
 * `e2e/support/local-origin.ts`). Browser: Chromium launch arg
 * `--ignore-certificate-errors-spki-list=<hash>` với hash là base64 SHA-256 của
 * DER SubjectPublicKeyInfo, tính TẠI CONFIG LOAD từ cert file đã commit —
 * Chromium vẫn verify mọi certificate, chỉ đúng public key trong danh sách được
 * chấp nhận. Hai cơ chế đều scoped, trust store toàn cục không bị đụng.
 *
 * ═══ Không `webServer`; gate thuộc global-setup ═══
 *
 * Stack là external state quản bởi lane Nx `local-up` (deploy qua `pnpm nx affected -t system-test -c local`). Property
 * `globalSetup` + gate fail-closed trong `global-setup.ts` là CẶP phải luôn đi
 * cùng nhau: globalSetup chạy trước test đầu tiên ở CẢ đường target
 * `system-test` lẫn `npx playwright test` trực tiếp; quên wire property là mọi
 * test đỏ lẻo với DNS failure thay vì MỘT message gate rõ ràng.
 *
 * Target `e2e` bị ĐÈ bằng stub `echo` trong `package.json` (project config thắng
 * target plugin suy ra) — CI job `e2e` chạy `nx affected -t e2e` trên runner
 * không có stack, chạy thật là đỏ toàn bộ suite cho một hệ thống không tồn tại
 * ở đó. Suite thực thi qua target `system-test` (docs/architecture/06-testing.md).
 * Copy CẢ HAI lớp: config no-throw + stub `e2e`.
 */

/**
 * Thư mục suite. ⚠️ `__dirname` không tồn tại ở ESM — Nx load config qua Node
 * native TypeScript stripping (config chạy như ESM), path tự resolve từ
 * `import.meta.url`; dùng `__dirname` là graph Nx fail ngay lúc load.
 */
const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

/** Path cert local — thiếu là config load fail (ENOENT), đúng ý. */
const LOCAL_CERT_PATH = join(SUITE_DIR, '../../../deploys/platform-deploy/local-certs/fbi.com.crt');

/** PEM của cert local — dùng cho mọi Node request của suite. */
export const LOCAL_CA_PEM = readFileSync(LOCAL_CERT_PATH, 'utf8');

/**
 * SPKI hash (base64 SHA-256 của DER SubjectPublicKeyInfo) — pin public key của
 * cert local cho cờ `--ignore-certificate-errors-spki-list` của Chromium. Cert
 * đổi theo repo là hash đổi theo, không có giá trị hardcode nào phải cập nhật.
 * ⚠️ Hash sai định dạng base64 khiến Chromium log `Invalid SPKI` rồi hành xử
 * như không có flag (mọi cert bị từ chối) — fail-closed, an toàn.
 *
 * ⚠️ Đối tượng hash là **SPKI DER** (public key), KHÔNG phải DER của cả
 * certificate (#374): `spki-list` so hash với public key của cert được serve.
 * Trên máy dev mà cert đã cài vào OS trust store thì hai cách đều "xanh"
 * (browser trust qua HĐH, không nhờ pin) — sai im lặng đúng kiểu khó bắt nhất.
 * `X509Certificate` export đúng DER SPKI, khớp pipeline OpenSSL tham chiếu:
 * `openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER |
 * openssl dgst -sha256 -binary | base64`.
 */
function computeSpkiHash(pem: string): string {
  const cert = new X509Certificate(pem);
  const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spkiDer).digest('base64');
}

const SPKI_HASH = computeSpkiHash(LOCAL_CA_PEM);

/**
 * Origin backoffice từ hostname gốc (`ROOT_DOMAIN`/`ROOT_HOST`, dạng
 * `hostname:port`): GHÉP PREFIX `office.` — router Traefik của backoffice match
 * `Host(office.<root>)`, và port giữ nguyên vì Traefik local nghe port ĐỘNG map
 * ra loopback (#392 — cùng hợp đồng mà `e2e/support/local-origin.ts` của suite
 * đã suy). Giá trị raw của `ROOT_DOMAIN` là hostname gốc, không router nào
 * serve backoffice trên đó.
 *
 * ⚠️ KHÔNG throw khi thiếu (xem khối đầu file): trả placeholder `.invalid`
 * (RFC 2606) không resolve được — nếu gate global-setup bị bỏ qua thì mọi test
 * đỏ với DNS failure thay vì xanh giả.
 */
function resolveStackOrigin(): string {
  const raw = process.env.ROOT_DOMAIN ?? process.env.ROOT_HOST;
  if (raw !== undefined && raw.trim().length > 0) {
    return withOfficeOrigin(raw.trim());
  }
  // Fallback cho lệnh gọi ngoài Nx: parse `.env` repo root (Nx load `.env` vào
  // env của task qua `nx run`, còn CLI trực tiếp thì không).
  const envPath = join(SUITE_DIR, '../../../.env');
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const match = /^ROOT_(?:DOMAIN|HOST)=(.*)$/u.exec(line.trim());
      if (match && match[1].trim().length > 0) {
        return withOfficeOrigin(match[1].trim());
      }
    }
  } catch {
    // `.env` vắng mặt — placeholder bên dưới thay thế; gate là đường fail-closed thật.
  }
  return 'office.placeholder.invalid:443';
}

/** Ghép hostname gốc (dạng `hostname:port`) thành `office.<hostname>:<port>`. */
function withOfficeOrigin(raw: string): string {
  const rootHostname = raw.split(':')[0];
  const port = raw.includes(':') ? raw.split(':')[1] : '443';
  return `office.${rootHostname}:${port}`;
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
  // routing/restart loop thật của stack. Chỗ đỏ là bug cần sửa, không phải bug
  // cần che (cùng triết lý `apps/backoffice/playwright.config.ts`).
  retries: 0,
  // Ghim worker: stack local là một dev machine chạy đủ 11 container; số worker
  // lớn hơn làm các upstream đói và test timeout — triệu chứng giống lỗi app.
  // Ghim cùng số ở local và CI để thứ được kiểm ở đây đúng là thứ chạy trên CI.
  workers: 2,
  // Reporter `github` ghi annotation ngay trên PR; `html` sinh report cho job
  // CI upload khi đỏ. `open: 'never'` vì runner không có trình duyệt để mở.
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    // Backoffice phục vụ ở subdomain `office` — mọi browser navigation mặc định
    // trỏ đây (rule router Traefik là `Host(office.<rootHostname>)`).
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
