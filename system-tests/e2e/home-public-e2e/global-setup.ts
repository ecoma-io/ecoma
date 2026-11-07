import { readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Stack gate fail-closed — probe TRƯỚC KHI suite chạy, không phải trong từng test.
 *
 * Hợp đồng: suite system E2E verify **cả hệ thống đang chạy thật**, nên stack
 * không có là KẾT QUẢ ĐỎ, không bao giờ là skip (cùng triết lý fail-closed với
 * `ECOMA_REQUIRE_DOCKER` của `docs/architecture/06-testing.md` §6). Một suite xanh
 * mà thật ra không chạy — vì mỗi test lặng lẽ bỏ qua — là kết quả nói dối đúng
 * lúc người đọc cần tin nhất; gate fail ở đây thì mọi test dừng với MỘT lý do
 * rõ ràng thay vì hàng chục timeout mơ hồ.
 *
 * Probe kiểm đúng hợp đồng của home qua chuỗi DNS/TLS/Traefik/upstream: `GET /`
 * với `Accept: text/html` phải 302 → `/en` (xác nhận trong `local-smoke.mjs` —
 * không gửi header đó thì middleware prerendered content trả 404 cho `/`).
 * TLS verify thật với `ca` scoped của cert local — không tắt verification
 * toàn cục, cùng cách chia sẻ trust với phần còn lại của suite.
 *
 * Retry CHỈ dành cho chữ ký "chưa sẵn sàng" — ngay sau `pulumi up`, container
 * home (`startPeriod`) và router Traefik cần thời gian lên: ECONNREFUSED /
 * ECONNRESET / ETIMEDOUT, timeout từng request, và 404/502/503/504 (404 hẹp:
 * cửa sổ giữa lúc router cũ gỡ và router mới đăng ký với Traefik, tự hết trong
 * ít giây — điều kiện retry giống hệt `local-smoke.mjs`). Lỗi TLS, 4xx/5xx
 * khác, sai status/sai location là lỗi thật — fail tức thời, retry chỉ che bug.
 *
 * ⚠️ Node `https` thay vì global `fetch`: `fetch` của Node (undici) không nhận
 * `node:https.Agent` làm `dispatcher` (thử thật: request fail im lặng), còn
 * `undici.Agent` thì không phải dependency của workspace. `https.get` với `ca`
 * là đường của `local-smoke.mjs` — đã chạy thật, verify được qua
 * `socket.authorized`, và không thêm dependency nào cho suite.
 */

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

/** Path cert local — cùng nguồn với `playwright.config.ts`, resolve từ suite dir. */
const LOCAL_CERT_PATH = join(SUITE_DIR, '../../../deploys/platform-deploy/local-certs/fbi.com.crt');

/** Tổng budget retry: đủ cho cold start của stack, không đủ để treo CI. */
const BUDGET_MS = 30_000;
/** Timeout mỗi request — request treo coi là "chưa sẵn sàng" và được thử lại. */
const REQUEST_TIMEOUT_MS = 5_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 5_000;

const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const EXPECTED_REDIRECT_PATH = '/en';

const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
// 404 hẹp chỉ đúng khi `Accept: text/html` luôn được gửi (probe này luôn gửi) —
// điều kiện giống hệt `local-smoke.mjs`, đọc comment nguồn ở đó cho chi tiết.
const RETRYABLE_STATUSES = new Set([404, 502, 503, 504]);
// Lỗi TLS/certificate: verification bị vi phạm — không bao giờ retry, không nuốt.
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_INVALID_CERTIFICATE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Lỗi retry-được: có khả năng tự hết khi cold start kết thúc. */
class RetryableError extends Error {}
/** Lỗi chốt: routing/app/TLS thực sự sai — retry chỉ che lỗi. */
class VerificationFailure extends Error {}

interface ProbeResult {
  readonly status: number;
  readonly location: string | undefined;
}

/** Tách `hostname`/`port` từ giá trị `ROOT_DOMAIN`/`ROOT_HOST`, mặc định port 443. */
function readHostPort(raw: string): { hostname: string; port: string } {
  const hostname = raw.split(':')[0];
  const port = raw.includes(':') ? raw.split(':')[1] : '443';
  return { hostname, port };
}

function resolveRootOrigin(): { hostname: string; port: string; ca: string } {
  const ca = readFileSync(LOCAL_CERT_PATH, 'utf8');
  const raw = process.env.ROOT_DOMAIN ?? process.env.ROOT_HOST;
  if (raw !== undefined && raw.trim().length > 0) {
    return { ...readHostPort(raw.trim()), ca };
  }
  // Fallback cho lệnh gọi ngoài Nx: parse `.env` repo root (cùng rationale với
  // `playwright.config.ts` — Nx load `.env` vào env của task, CLI trực tiếp thì không).
  try {
    const text = readFileSync(join(SUITE_DIR, '../../../.env'), 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const match = /^ROOT_(?:DOMAIN|HOST)=(.*)$/u.exec(line.trim());
      if (match && match[1].trim().length > 0) {
        return { ...readHostPort(match[1].trim()), ca };
      }
    }
  } catch {
    // `.env` vắng mặt — rơi xuống throw bên dưới với message chỉ đúng remedy.
  }
  throw new Error(
    'home-public-e2e global setup failed: ROOT_DOMAIN (or ROOT_HOST) is not set and no .env file defines it. ' +
      'Deploy the local stack first (Nx provisions the `local-up` prerequisites) — deploying writes the dynamic Traefik host:port into the repo-root .env.',
  );
}

/**
 * Request Node thuần với `ca` scoped — TƯỜNG MINH về TLS verify: sau response,
 * khẳng định `socket.authorized === true` thay vì tin rằng "request thành công
 * nghĩa là TLS đã verify". Nếu sau này ai thêm `rejectUnauthorized: false`,
 * probe phải ĐỎ ở đây ngay (pattern của `local-smoke.mjs`).
 */
function probeOnce(hostname: string, port: string, ca: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        host: hostname,
        port,
        path: '/',
        ca,
        servername: hostname,
        headers: {
          // `Host` tường minh cùng dạng `hostname:port` — khớp đúng rule
          // `Host(\`fbi.com\`)` của Traefik (xem `local-smoke.mjs`).
          Host: `${hostname}:${port}`,
          Accept: ACCEPT_HTML,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      (response) => {
        // INVARIANT TLS: khẳng định trực tiếp trạng thái verify của socket.
        if (response.socket?.authorized !== true) {
          reject(
            new VerificationFailure(
              `TLS not verified — ${response.socket?.authorizationError?.message ?? 'socket has no verify status'}`,
            ),
          );
          return;
        }
        response.resume();
        response.on('error', (error: NodeJS.ErrnoException) => reject(classify(error)));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, location: response.headers.location });
        });
      },
    );
    request.on('error', (error: NodeJS.ErrnoException) => reject(classify(error)));
  });
}

function classify(error: NodeJS.ErrnoException): Error {
  const code = error?.code;
  if (
    typeof code === 'string' &&
    (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || TLS_ERROR_CODES.has(code))
  ) {
    return new VerificationFailure(`invalid TLS/certificate — ${error.message}`);
  }
  // AbortSignal.timeout hủy request: Node báo AbortError/ABORT_ERR với cause
  // TimeoutError — đây là request timeout của ta, không phải lỗi server.
  if (error.name === 'TimeoutError' || error.name === 'AbortError' || code === 'ABORT_ERR') {
    return new RetryableError(`timeout after ${REQUEST_TIMEOUT_MS}ms — server did not respond`);
  }
  if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) {
    return new RetryableError(`${code} — server not listening/not ready yet`);
  }
  // Mọi lỗi ngoài danh sách retry là fail-closed — không đoán thêm chữ ký nào.
  return new VerificationFailure(error.message);
}

/** In lỗi + remedy rồi exit 1. Console/exit là output chương trình → English. */
function fail(origin: string, elapsedMs: number, error: Error): never {
  console.error(
    `stack gate FAILED after ${elapsedMs}ms: ${origin}/ is not serving the expected home contract — ${error.message}. ` +
      'The local stack is not reachable or not ready. Start it with `pnpm nx affected -t system-test -c local` (Nx provisions the local-up prerequisites first), then rerun the suite. ' +
      'This suite must FAIL when the stack is down; skipping is never an acceptable result.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const { hostname, port, ca } = resolveRootOrigin();
  const origin = `https://${hostname}:${port}`;
  const startedAt = Date.now();
  let backoffMs = BACKOFF_INITIAL_MS;
  let lastFailure = new Error('probe never ran');
  // Luôn chạy ít nhất một lần; các lần sau chỉ khi lỗi retry-được và còn budget.
  for (;;) {
    let result: ProbeResult | undefined;
    try {
      result = await probeOnce(hostname, port, ca);
    } catch (error) {
      if (!(error instanceof RetryableError)) {
        fail(origin, Date.now() - startedAt, error as Error);
      }
      lastFailure = error as Error;
    }
    if (result) {
      // Hợp đồng routing của home: `/` 302 → `/en` đúng literal (local-smoke.mjs).
      if (result.status === 302 && result.location === EXPECTED_REDIRECT_PATH) {
        console.log(
          `stack gate OK: ${origin}/ -> 302 ${EXPECTED_REDIRECT_PATH} after ${Date.now() - startedAt}ms`,
        );
        return;
      }
      if (!RETRYABLE_STATUSES.has(result.status)) {
        fail(
          origin,
          Date.now() - startedAt,
          new Error(
            `expected 302 with location '${EXPECTED_REDIRECT_PATH}', got ${result.status} ` +
              `with location ${JSON.stringify(result.location)}`,
          ),
        );
      }
      lastFailure = new Error(
        `status ${result.status} — upstream not ready yet (retryable window, e.g. Traefik router registration)`,
      );
    }
    const remainingMs = BUDGET_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      fail(origin, Date.now() - startedAt, lastFailure);
    }
    const sleepMs = Math.min(backoffMs, remainingMs);
    console.error(`stack gate RETRY after ${Date.now() - startedAt}ms: ${lastFailure.message}`);
    await new Promise((resolve) => {
      setTimeout(resolve, sleepMs);
    });
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  }
}

export default main;
