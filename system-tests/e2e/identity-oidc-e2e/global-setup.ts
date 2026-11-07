import { readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Stack gate fail-closed — probe TRƯỚC KHI suite chạy, không phải trong từng test.
 *
 * Hợp đồng: suite system E2E verify **cả hệ thống đang chạy thật**, nên stack
 * không có là KẾT QUẢ ĐỎ, không bao giờ là skip (cùng triết lý fail-closed với
 * `ECOMA_REQUIRE_DOCKER` của `docs/architecture/06-testing.md` §6).
 *
 * Probe kiểm đúng hợp đồng của service `auth` qua chuỗi DNS/TLS/Traefik/upstream:
 * `GET /.well-known/openid-configuration` phải 200 JSON với `issuer` BẰNG ĐÚNG
 * origin `https://auth.<host>:<port>` của request (issuer là origin-based, port
 * động đổi là issuer đổi — so khớp nguyên văn là cách rẻ nhất phát hiện stack
 * đang chạy cấu hình của worktree khác, hoặc audience/issuer lệch nhau giữa
 * lần deploy). Chỉ status + `issuer` được kiểm ở đây; toàn bộ document là việc
 * của test discovery (`e2e/protocol-surface.spec.ts`).
 *
 * Retry CHỈ dành cho chữ ký "chưa sẵn sàng" — ngay sau `pulumi up`, WIC `auth`
 * (container + wrangler dev) và router Traefik cần thời gian lên: ECONNREFUSED /
 * ECONNRESET / ETIMEDOUT, timeout từng request, và 404/502/503/504. Lỗi TLS,
 * 4xx/5xx khác, sai issuer là lỗi thật — fail tức thời, retry chỉ che bug.
 *
 * ⚠️ Node `https` thay vì global `fetch`: `fetch` của Node (undici) không nhận
 * `node:https.Agent` làm `dispatcher`, còn `undici.Agent` thì không phải
 * dependency của workspace. `https.get` với `ca` là đường của `local-smoke.mjs`.
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

const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
// 404 nằm trong cửa sổ giữa lúc router cũ gỡ và router mới đăng ký với Traefik
// (tự hết trong ít giây) — điều kiện retry giống hệt `local-smoke.mjs`.
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
  readonly body: string;
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
    'identity-oidc-e2e global setup failed: ROOT_DOMAIN (or ROOT_HOST) is not set and no .env file defines it. ' +
      'Deploy the local stack first (Nx provisions the `local-up` prerequisites) — deploying writes the dynamic Traefik host:port into the repo-root .env.',
  );
}

/**
 * Request Node thuần với `ca` scoped — TƯỜNG MINH về TLS verify: sau response,
 * khẳng định `socket.authorized === true` thay vì tin rằng "request thành công
 * nghĩa là TLS đã verify" (pattern của `local-smoke.mjs`).
 */
function probeOnce(hostname: string, port: string, ca: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        host: hostname,
        port,
        path: '/.well-known/openid-configuration',
        ca,
        servername: hostname,
        headers: {
          // `Host` tường minh cùng dạng `hostname:port` — khớp đúng rule
          // `Host(\`auth.fbi.com\`)` của Traefik. Subdomain đi thẳng vào Host:
          // một cặp (cert, port) phục vụ mọi hostname của stack.
          Host: `auth.${hostname}:${port}`,
          Accept: 'application/json',
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
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        // Response stream không có listener 'error' thì Node ném uncaught
        // exception giữa chừng (socket reset sau khi response bắt đầu).
        response.on('error', (error: NodeJS.ErrnoException) => reject(classify(error)));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
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
    `stack gate FAILED after ${elapsedMs}ms: https://auth.${origin}/.well-known/openid-configuration is not serving the expected contract — ${error.message}. ` +
      'The local stack is not reachable or not ready. Start it with `pnpm nx affected -t system-test -c local` (Nx provisions the local-up prerequisites first), then rerun the suite. ' +
      'This suite must FAIL when the stack is down; skipping is never an acceptable result.',
  );
  process.exit(1);
}

/** Body là JSON discovery với `issuer` đúng origin — hoặc mô tả lệch. */
function describeMismatch(result: ProbeResult, expectedIssuer: string): string {
  if (result.status !== 200) {
    return `expected 200, got ${result.status}`;
  }
  let issuer: unknown;
  try {
    issuer = (JSON.parse(result.body) as { issuer?: unknown })['issuer'];
  } catch {
    return 'response body is not valid JSON';
  }
  return `expected issuer ${JSON.stringify(expectedIssuer)}, got ${JSON.stringify(issuer)}`;
}

async function main(): Promise<void> {
  const { hostname, port, ca } = resolveRootOrigin();
  const hostPort = `${hostname}:${port}`;
  const authOrigin = `https://auth.${hostPort}`;
  const expectedIssuer = authOrigin;
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
        fail(hostPort, Date.now() - startedAt, error as Error);
      }
      lastFailure = error as Error;
    }
    if (result) {
      const ok: boolean =
        result.status === 200 &&
        (() => {
          try {
            return (JSON.parse(result.body) as { issuer?: unknown })['issuer'] === expectedIssuer;
          } catch {
            return false;
          }
        })();
      if (ok) {
        console.log(
          `stack gate OK: ${authOrigin}/.well-known/openid-configuration -> 200 with matching issuer after ${
            Date.now() - startedAt
          }ms`,
        );
        return;
      }
      if (!RETRYABLE_STATUSES.has(result.status)) {
        fail(hostPort, Date.now() - startedAt, new Error(describeMismatch(result, expectedIssuer)));
      }
      lastFailure = new Error(
        `status ${result.status} — upstream not ready yet (retryable window, e.g. Traefik router registration)`,
      );
    }
    const remainingMs = BUDGET_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      fail(hostPort, Date.now() - startedAt, lastFailure);
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
