import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Cấu hình Playwright cho suite system E2E `identity-oidc-e2e` — suite kiểm
 * bề mặt giao thức OIDC của service `auth` qua stack local thật. Copy mô hình
 * kiến trúc của `home-public-e2e` (suite skeleton đầu tiên); các quyết định
 * được lặp lại ở đây vì mỗi suite system E2E tự sở hữu config của mình
 * (`docs/architecture/06-testing.md` §2), không có lib dùng chung.
 *
 * ═══ Quyết định TLS-in-browser (giữ nguyên từ skeleton) ═══
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
 * 1. **Node https (API assertion — phần lớn test của suite này):** mỗi request
 *    qua `node:https` với `ca` của riêng cert này (xem `e2e/support/local-origin.ts`).
 * 2. **Browser (test luồng authorize + login + consent):** Chromium launch arg
 *    `--ignore-certificate-errors-spki-list=<hash>` với hash là base64 SHA-256
 *    của DER SubjectPublicKeyInfo, tính TẠI CONFIG LOAD từ chính cert file đã
 *    commit. Đây KHÔNG phải "tắt verification": Chromium vẫn verify mọi
 *    certificate và vẫn từ chối certificate tự ký KHÁC — chỉ đúng public key
 *    nằm trong danh sách được chấp nhận.
 *
 * Lưu ý riêng của suite này so với skeleton: URL test mang NHIỀU hostname
 * (`auth.`, `account.`, `office.` cùng root hostname) nhưng TẤT CẢ cùng phục vụ
 * qua MỘT cặp (cert, port Traefik) — một SPKI pin duy nhất phủ mọi origin.
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
 * trực tiếp.
 *
 * ⚠️ Hệ quả phải biết khi debug graph Nx: `@nx/playwright/plugin` EVAL config
 * này lúc DỰNG PROJECT GRAPH (để suy target `e2e`). Config throw-loud khi thiếu
 * `ROOT_DOMAIN`/`ROOT_HOST` làm MỌI job CI đỏ với cùng một graph error, kể cả
 * lệnh `nx affected` không đụng gì đến suite — runner CI không có `.env` vì
 * stack local không tồn tại ở đó. Vì thế config KHÔNG BAO GIỜ throw: thiếu
 * origin là trả placeholder `.invalid` vô hại, và fail-closed thật nằm ở
 * `global-setup.ts`. Target `e2e` bị ĐÈ bằng stub `echo` khai tường minh trong
 * `package.json` của suite; suite thực thi qua target `system-test`.
 */

/**
 * Thư mục suite. ⚠️ `__dirname` không tồn tại ở ESM — Nx load config này qua
 * Node native TypeScript stripping (config chạy như ESM), nên path tự resolve
 * từ `import.meta.url`.
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
 * Origin gốc của stack local — giữ nguyên `host:port`. `pnpm nx affected -t system-test -c local` — nó provision các prerequisite `local-up` trước
 * ghi `ROOT_HOST=<host>:<port>`; `ROOT_DOMAIN` mang cùng giá trị cho system
 * test. Đọc `ROOT_DOMAIN` trước, fallback `ROOT_HOST`.
 *
 * ⚠️ Port PHẢI giữ trong baseURL: Traefik local nghe trên port ĐỘNG map ra
 * loopback, không phải 443.
 *
 * ⚠️ KHÔNG throw khi cả hai nguồn rỗng: plugin `@nx/playwright` eval config này
 * LÚC DỰNG PROJECT GRAPH, mà runner CI không có `.env` — throw ở đây làm MỌI
 * job CI đỏ với cùng một graph error. Fail-closed nằm ở ĐÚNG lớp của nó:
 * `global-setup.ts` probe origin trước test đầu tiên và exit 1 với message nêu
 * remedy. Placeholder `.invalid` (RFC 2606) không resolve — nếu gate bị bỏ qua
 * thì mọi test đỏ với DNS failure thay vì xanh giả.
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
  return 'placeholder.invalid:443';
}

const ROOT_ORIGIN = resolveStackOrigin();

export default defineConfig({
  // Gate fail-closed chạy trước test đầu tiên — module mặc định export chính
  // hàm `main` (KHÔNG phải `main()`: export Promise là crash `globalSetup`).
  globalSetup: './global-setup.ts',
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // `retries: 0` kể cả trên CI: retry biến một flake thật thành một lần xanh và
  // không ai đọc lại log; với system E2E thì flake còn đáng ngờ hơn nữa, vì nó
  // có thể là dấu hiệu routing / restart loop thật của stack.
  retries: 0,
  // Ghim worker: stack local là một dev machine chạy đủ ~11 container; số
  // worker lớn hơn làm các upstream đói và test timeout — triệu chứng giống
  // lỗi app. Luồng browser của suite này NHIỀU bước tuần tự (authorize →
  // login → OTP → consent → callback), nên 2 worker là trần hợp lý.
  workers: 2,
  // Reporter `github` ghi annotation ngay trên PR; `html` sinh `playwright-report/`
  // để job CI upload kèm trace/screenshot khi đỏ.
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  // 60s là đủ cho test protocol thuần; test browser có OTP delivery qua cron
  // mail tự nâng timeout riêng (xem `e2e/oidc-browser-flow.spec.ts`).
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    // Suite chủ yếu nói chuyện với origin `auth.` — mọi browser navigation
    // mặc định trỏ đây; các origin khác (account/office) được navigate tường
    // minh bằng URL tuyệt đối.
    baseURL: `https://auth.${ROOT_ORIGIN}`,
    // ⚠️ KHÔNG BAO GIỜ `ignoreHTTPSErrors: true` — xem khối quyết định TLS ở
    // đầu file.
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
