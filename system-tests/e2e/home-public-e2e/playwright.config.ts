import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Cấu hình Playwright cho suite system E2E `home-public-e2e` — suite system
 * E2E ĐẦU TIÊN của repo, và là skeleton mà ba suite kế tiếp
 * (`identity-login-e2e`, `identity-oidc-e2e`, `backoffice-access-control-e2e`)
 * sẽ copy. Quyết định kiến trúc được ghi tường minh ở đây để suite sau không
 * phải đoán lại.
 *
 * ═══ Quyết định TLS-in-browser (đã kiểm chứng thực nghiệm) ═══
 *
 * Stack local chạy sau Traefik với certificate self-signed `fbi.com` của repo
 * (`deploys/platform-deploy/local-certs/fbi.com.crt`, port Traefik ĐỘNG theo
 * mỗi lần container được tạo lại — giá trị thật nằm ở `ROOT_DOMAIN`/`ROOT_HOST`
 * trong `.env` mà bước `local-up` của lane Nx ghi). TLS phải được VERIFY THẬT SỰ —
 * `ignoreHTTPSErrors: true` hay `NODE_TLS_REJECT_UNAUTHORIZED=0` là đường cấm,
 * vì suite sinh ra để chứng minh chuỗi DNS/TLS/routing/upstream; tắt verification
 * là test nói dối về đúng thứ nó được sinh ra để kiểm.
 *
 * Hai bề mặt, hai cơ chế scoped trust:
 *
 * 1. **Node fetch / API assertion** (đa số test): mỗi request qua `node:https`
 *    với `ca` của riêng cert này — cùng pattern với
 *    `system-tests/local-smoke/src/local-smoke.mjs` (undici `dispatcher`
 *    của global fetch KHÔNG nhận `node:https.Agent`, đã thử thật — và undici
 *    không phải dependency của workspace). Trust store toàn cục của Node và của
 *    HĐH không bị đụng đến.
 * 2. **Browser** (chỉ test nào cần nội dung render thật): Chromium launch arg
 *    `--ignore-certificate-errors-spki-list=<hash>` với hash là base64 SHA-256
 *    của DER SubjectPublicKeyInfo, tính TẠI CONFIG LOAD từ chính cert file
 *    đã commit. Đây KHÔNG phải "tắt verification": Chromium vẫn verify mọi
 *    certificate và vẫn từ chối certificate tự ký KHÁC — chỉ đúng public key
 *    nằm trong danh sách được chấp nhận.
 *
 *    ĐÃ KIỂM CHỨNG (Chromium 156.0.8078.4 — build 1248 mà `@playwright/test`
 *    1.64.1 tải, Playwright `chromium.launch()`):
 *    - cert `fbi.com` + đúng SPKI hash → trang render 200;
 *    - certificate tự ký KHÁC (self-signed.badssl.com) với đúng hash đó trong
 *      danh sách → vẫn bị từ chối `ERR_CERT_AUTHORITY_INVALID` (scoping giữ
 *      đúng nghĩa "pin 1 public key", không phải tắt verification);
 *    - hash sai (valid base64) → vẫn bị từ chối.
 *    ⚠️ Lưu ý thực nghiệm: hash sai định dạng base64 khiến Chromium log
 *    `Invalid SPKI` rồi HÀNH XỬ NHƯ KHÔNG CÓ FLAG (mọi cert bị từ chối) —
 *    an toàn theo hướng fail-closed, nhưng lần đầu thêm cert mới hãy chạy một
 *    test browser để xác nhận hash được parse.
 *
 *    Playwright parse riêng `--ignore-certificate-errors` từ args (đổi thành
 *    `ignoreHTTPSErrors` context-wide — quá rộng), nhưng cờ `spki-list`
 *    đi thẳng vào Chromium và hoạt động đúng semantic pin-per-key.
 *
 * ═══ Không `webServer` ═══
 *
 * Stack là external state, quản bởi lane Nx `local-up` (deploy qua `pnpm nx affected -t system-test -c local`) — Playwright không
 * tự dựng server. Gate "stack phải đang sống" thuộc `global-setup.ts`, được
 * wire qua property `globalSetup` bên dưới (fail-closed: stack không có →
 * suite ĐỎ, không bao giờ skip).
 *
 * ⚠️ global-setup LÀ BẮT BUỘC trong mọi cách gọi suite: nó chạy trước test
 * đầu tiên ở CẢ chạy qua target `system-test` lẫn gọi `npx playwright test`
 * trực tiếp. Đã từng quên wire property này — CI chạy `playwright test` thật
 * (trước khi stub `e2e` ở package.json chặn) thì 16 test đỏ lẻo từng cái với
 * DNS failure thay vì MỘT message gate rõ ràng. Wire property + gate fail
 * trong global-setup là cặp phải luôn đi cùng nhau.
 *
 * ⚠️ Hệ quả phải biết khi debug graph Nx: `@nx/playwright/plugin` EVAL config
 * này lúc DỰNG PROJECT GRAPH (để suy target `e2e`). Bài học ĐÃ TRẢ GIÁ trên CI:
 * config throw-loud khi thiếu `ROOT_DOMAIN`/`ROOT_HOST` làm MỌI job CI đỏ
 * (`build`, `verify`, `integration-test`) với cùng một graph error, kể cả lệnh
 * `nx affected` không đụng gì đến suite — runner CI không có `.env` vì stack
 * local không tồn tại ở đó. Vì thế config KHÔNG BAO GIỜ throw: thiếu origin là
 * trả placeholder `.invalid` vô hại, và fail-closed thật nằm ở `global-setup.ts`
 * (probe trước test đầu tiên, exit 1 với message nêu remedy `pnpm nx affected
 * -t system-test -c local`). Ba suite kế tiếp copy đúng mô hình này: config load đỡ vửa,
 * gate chặn thật.
 */

/**
 * Thư mục suite. ⚠️ `__dirname` không tồn tại ở ESM — Nx load config này qua
 * Node native TypeScript stripping (config chạy như ESM), nên path tự resolve
 * từ `import.meta.url`; dùng `__dirname` là graph Nx fail ngay lúc load plugin
 * `@nx/playwright` (đã gặp thật).
 */
const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

/** Path cert local, resolve từ thư mục suite — thiếu là config load fail (ENOENT), đúng ý. */
const LOCAL_CERT_PATH = join(SUITE_DIR, '../../../deploys/platform-deploy/local-certs/fbi.com.crt');

/** PEM của cert local — dùng cho mọi Node request của suite (xem khối TLS ở đầu file). */
export const LOCAL_CA_PEM = readFileSync(LOCAL_CERT_PATH, 'utf8');

/**
 * SPKI hash (base64 SHA-256 của DER SubjectPublicKeyInfo) — pin public key của
 * cert local cho cờ `--ignore-certificate-errors-spki-list` của Chromium.
 * Tính tại config load: cert đổi → hash đổi → browser trust theo cert MỚI,
 * không có hash hardcode nào phải nhớ cập nhật.
 *
 * ⚠️ Đối tượng hash là **SPKI DER** (public key), KHÔNG phải DER của cả
 * certificate. Phiên bản đầu của hàm này hash cả cert (strip PEM wrapper rồi
 * SHA-256) — sai chuẩn của cờ: `spki-list` so hash với public key của cert
 * được serve, không phải với cert. Trên máy dev mà cert đã cài vào trust store
 * hệ điều hành thì cả hai cách đều "chạy được" (browser trust qua OS chứ
 * không nhờ pin) — chính là kiểu sai im lặng khó bắt nhất. `X509Certificate`
 * của `node:crypto` trích public key rồi export đúng DER SPKI, khớp trực tiếp
 * định dạng OpenSSL tham chiếu:
 * `openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER |
 * openssl dgst -sha256 -binary | base64`.
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
 * Origin gốc của stack local — giữ nguyên `host:port`. `pnpm nx affected -t system-test -c local` — nó provision các prerequisite `local-up` trước
 * ghi `ROOT_HOST=<host>:<port>` (key sở hữu từ trước); #353 thêm `ROOT_DOMAIN`
 * với cùng giá trị cho system test. Đọc `ROOT_DOMAIN` trước, fallback
 * `ROOT_HOST` cho worktree chưa redeploy kể từ khi #353 merge.
 *
 * ⚠️ Port PHẢI giữ trong baseURL: Traefik local nghe trên port ĐỘNG map ra
 * loopback, không phải 443. Đã cắt port thử (`raw.split(':')[0]`) thì mọi
 * navigation browser đi đúng DNS `fbi.com` nhưng đập vào `:443` trên máy dev
 * — `ERR_CONNECTION_REFUSED` cho cả suite browser trong khi API assertion
 * (nhớ port qua `local-origin.ts`) vẫn xanh: đúng bệnh "một nửa suite xanh
 * chỉ vì nửa kia nhắm sai origin".
 *
 * Nx load `.env` của repo root ngay khi CLI boot (`loadRootEnvFiles` trong
 * `nx.js` — trước khi mọi plugin chạy), nên qua `nx run`/`npx playwright test`
 * dưới target Nx thì biến có sẵn cả khi plugin `@nx/playwright` eval config
 * lúc dựng graph. Chạy `npx playwright test` TRỰC TIẾP (ngoài Nx) thì không —
 * fallback đọc file `.env` của repo root ở dưới phủ đúng trường hợp đó.
 *
 * ⚠️ KHÔNG throw khi cả hai nguồn rỗng (đã thử — CI đỏ cả repo): plugin
 * `@nx/playwright` eval config này LÚC DỰNG PROJECT GRAPH, mà runner CI không
 * có `.env` (stack local không tồn tại ở đó) — throw ở đây làm MỌI job CI
 * (`build`, `verify`/pr-check, `integration-test`) đỏ với cùng một graph error
 * của lệnh `nx affected` không liên quan gì đến suite. Fail-closed nằm ở ĐÚNG
 * lớp của nó: `global-setup.ts` probe origin trước test đầu tiên và exit 1 với
 * message tiếng Anh nêu remedy — config load chỉ cần trả một placeholder vô
 * hại (origin không thể route được) để graph dựng được và `--list` xem được
 * test; suite thật KHÔNG BAO GIỜ chạy với placeholder vì gate đã chặn trước.
 *
 * ⚠️ Lớp chặn thứ hai cho PR CI: plugin cũng SUY target `e2e` từ config này,
 * và job `e2e` của CI chạy `nx affected -t e2e` — nếu chỉ sửa config-no-throw
 * thì suite chạy thật trên runner không có stack và 16 test đỏ lẻo (run
 * 40740897352). Nên target `e2e` bị ĐÈ bằng stub `echo` khai tường minh trong
 * `package.json` của suite (project config thắng target plugin suy ra); suite
 * thực thi qua target `system-test`. Chi tiết đầy đủ nằm ở comment `e2e` của
 * `package.json`. Ba suite kế tiếp copy CẢ HAI lớp: config no-throw + stub
 * `e2e`, đừng bỏ một trong hai.
 */
function resolveStackOrigin(): string {
  const raw = process.env.ROOT_DOMAIN ?? process.env.ROOT_HOST;
  if (raw !== undefined && raw.trim().length > 0) {
    return withOrigin(raw.trim());
  }
  // Fallback cho lệnh gọi ngoài Nx: parse `.env` repo root (không đè env đã có).
  const envPath = join(SUITE_DIR, '../../../.env');
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const match = /^ROOT_(?:DOMAIN|HOST)=(.*)$/u.exec(line.trim());
      if (match && match[1].trim().length > 0) {
        return withOrigin(match[1].trim());
      }
    }
  } catch {
    // `.env` vắng mặt — placeholder bên dưới thay thế; gate trong global-setup
    // là đường fail-closed thật.
  }
  // Placeholder vô hại: TLD `.invalid` (RFC 2606) không resolve — nếu gate
  // global-setup bị bỏ qua thì mọi test đỏ với DNS failure thay vì xanh giả.
  return 'placeholder.invalid:443';
}

const ROOT_ORIGIN = resolveStackOrigin();

export default defineConfig({
  // Gate fail-closed chạy trước test đầu tiên — module mặc định export chính
  // hàm `main` (KHÔNG phải `main()`: export Promise là crash `globalSetup`
  // với "invoked a non-function"). Xem khối "Không `webServer`" ở đầu file.
  globalSetup: './global-setup.ts',
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // `retries: 0` kể cả trên CI — cùng triết lý `apps/backoffice/playwright.config.ts`:
  // retry biến một flake thật thành một lần xanh và không ai đọc lại log; với
  // system E2E thì flake còn đáng ngờ hơn nữa, vì nó có thể là dấu hiệu routing
  // /restart loop thật của stack. Chỗ đỏ là bug cần sửa, không phải bug cần che.
  retries: 0,
  // Ghim worker (không để mặc định `cpus/2`): stack local là một dev machine
  // chạy đủ 11 container; số worker lớn hơn làm SSR home đói và test timeout —
  // triệu chứng giống lỗi app. Ghim cùng số ở local và CI để thứ được kiểm ở
  // đây đúng là thứ chạy trên CI.
  workers: 2,
  // Reporter `github` ghi annotation ngay trên PR; `html` sinh `playwright-report/`
  // để job CI upload kèm trace/screenshot khi đỏ. `open: 'never'` vì runner không
  // có trình duyệt để mở.
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    // Home phục vụ ở apex host — mọi browser navigation mặc định trỏ đây.
    baseURL: `https://${ROOT_ORIGIN}`,
    // ⚠️ KHÔNG BAO GIỜ `ignoreHTTPSErrors: true` — xem khối quyết định TLS ở
    // đầu file. Browser test nào cần cert local phải qua project-level
    // `launchOptions` bên dưới, không phải qua nút tắt verification toàn cục.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // SPKI pin scoped cho cert local — semantic "tin ĐÚNG public key này",
        // không phải "tin mọi certificate". Hash tính từ cert file đã commit
        // nên cert rotate theo repo là browser tự theo.
        launchOptions: {
          args: [`--ignore-certificate-errors-spki-list=${SPKI_HASH}`],
        },
      },
    },
  ],
});
