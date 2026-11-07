import { readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Stack gate fail-closed của suite `backoffice-access-control-e2e` — probe
 * TRƯỚC KHI suite chạy, không phải trong từng test.
 *
 * Hợp đồng: stack không có là KẾT QUẢ ĐỎ, không bao giờ là skip (cùng triết lý
 * fail-closed `ECOMA_REQUIRE_DOCKER` của `docs/architecture/06-testing.md` §6).
 *
 * ## Probe kiểm ĐÚNG hợp đồng của suite này
 *
 * `GET /api/staff` KHÔNG cookie phải trả **401** — sau PR #358 (wire OIDC BFF),
 * middleware `apps/backoffice/server/middleware/authn.ts` chặn mọi `/api/**`
 * trước route: cookie `__Host-backoffice-session` vắng ⇒ 401 (ADR-0011 §1).
 * Đây là hợp đồng nhận diện "stack có đủ wiring BFF":
 *
 * - **503** `authorization unavailable` ⇒ stack ĐANG CHẠY nhưng image backoffice
 *   PREDATES #358 (`backofficeAuthConfig` trả `null` — nhánh fail-closed đầu
 *   tiên của middleware). Suite này kiểm login + permission enforcement, không
 *   chạy được trên stack đó: fail với message nêu remedy redeploy, KHÔNG retry
 *   (retry chỉ che bug cấu hình).
 * - **401** ⇒ middleware authn chạy và từ chối caller chưa đăng nhập — stack
 *   sẵn sàng cho phần còn lại của suite.
 *
 * ## Retry chỉ dành cho chữ ký "chưa sẵn sàng"
 *
 * Ngay sau `pulumi up`, container backoffice (`startPeriod` 30s + healthcheck)
 * và router Traefik cần thời gian lên: ECONNREFUSED / ECONNRESET / ETIMEDOUT,
 * timeout từng request, và 404/502/503/504 (404 hẹp: cửa sổ router Traefik cũ
 * gỡ — mới đăng ký, tự hết trong ít giây — điều kiện giống `local-smoke.mjs`).
 * ⚠️ 503 nằm trong tập retry-được của cửa sổ cold start CHUNG (router trả 503
 * khi upstream chưa có), nhưng probe này phân biệt 503 có body contract của
 * Nitro (`"statusCode": 503` từ chính app) — đó là fail-closed thật của app,
 * fail tức thời với message redeploy. 503 TRỐNG (router, không body JSON) là
 * upstream chưa sẵn sàng — retry.
 *
 * Lỗi TLS và 4xx khác là lỗi thật — fail tức thời.
 *
 * ⚠️ Node `https` thay vì global `fetch`: `fetch` của Node (undici) không nhận
 * `node:https.Agent` làm `dispatcher`, còn `undici.Agent` không phải dependency
 * của workspace — `https.get` với `ca` scoped là đường đã chạy thật ở
 * `local-smoke.mjs` và skeleton `home-public-e2e`.
 */

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

/** Path cert local — cùng nguồn với `playwright.config.ts`. */
const LOCAL_CERT_PATH = join(SUITE_DIR, '../../../deploys/platform-deploy/local-certs/fbi.com.crt');

/** Tổng budget retry: đủ cho cold start của stack, không đủ để treo CI. */
const BUDGET_MS = 30_000;
/** Timeout mỗi request — request treo coi là "chưa sẵn sàng" và được thử lại. */
const REQUEST_TIMEOUT_MS = 5_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 5_000;

const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
// 404 hẹp: cửa sổ router Traefik cũ gỡ — mới đăng ký (giống `local-smoke.mjs`).
// 502/503/504 là upstream chưa sẵn sàng — retry. 503 CỦA APP (body JSON
// "authorization unavailable" từ Nitro) đã bị bắt và fail tức thời ở nhánh
// `isAppAuthorizationUnavailable` trước khi chạm set này, nên thêm 503 vào đây
// không nuốt fail-closed của app — chỉ retry đúng 503 TRỐNG của router.
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

/** Stack predates PR #358 — BFF chưa được wire, suite này không chạy được. */
class StaleDeploymentError extends Error {}

interface ProbeResult {
  readonly status: number;
  readonly body: string;
}

/**
 * Origin backoffice mà gate probe — hostname gốc (giá trị `ROOT_DOMAIN`/
 * `ROOT_HOST`, dạng `hostname:port`) GHÉP PREFIX `office.`: router Traefik của
 * backoffice match `Host(office.<root>)`, probe hostname gốc là 404 chắc chắn
 * (#392 — cùng hợp đồng mà `e2e/support/local-origin.ts` của suite đã suy).
 */
function resolveBackofficeOrigin(): { hostname: string; port: string; ca: string } {
  const ca = readFileSync(LOCAL_CERT_PATH, 'utf8');
  const raw = process.env.ROOT_DOMAIN ?? process.env.ROOT_HOST;
  if (raw !== undefined && raw.trim().length > 0) {
    return { ...readOfficeHostPort(raw.trim()), ca };
  }
  // Fallback cho lệnh gọi ngoài Nx: parse `.env` repo root.
  try {
    const text = readFileSync(join(SUITE_DIR, '../../../.env'), 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const match = /^ROOT_(?:DOMAIN|HOST)=(.*)$/u.exec(line.trim());
      if (match && match[1].trim().length > 0) {
        return { ...readOfficeHostPort(match[1].trim()), ca };
      }
    }
  } catch {
    // `.env` vắng mặt — throw bên dưới với message chỉ đúng remedy.
  }
  throw new Error(
    'backoffice-access-control-e2e global setup failed: ROOT_DOMAIN (or ROOT_HOST) is not set and no .env file defines it. ' +
      'Deploy the local stack first (Nx provisions the `local-up` prerequisites) — deploying writes the dynamic Traefik host:port into the repo-root .env.',
  );
}

/** Tách `hostname`/`port` từ hostname gốc rồi ghép prefix `office.` của backoffice. */
function readOfficeHostPort(raw: string): { hostname: string; port: string } {
  const rootHostname = raw.split(':')[0];
  const port = raw.includes(':') ? raw.split(':')[1] : '443';
  return { hostname: `office.${rootHostname}`, port };
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
        path: '/api/staff',
        ca,
        servername: hostname,
        headers: {
          // `Host` tường minh `hostname:port` — khớp rule `Host(office.<rootHostname>)`
          // của router Traefik (Traefik match hostname không port).
          Host: `${hostname}:${port}`,
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

/**
 * 503 mang body JSON error của Nitro (`statusCode` + `statusMessage` "authorization
 * unavailable") là chữ ký fail-closed CỦA APP khi OIDC config thiếu — tức image
 * backoffice predates #358. Đây là lỗi cấu hình stack, không phải cold start:
 * fail tức thời với remedy redeploy.
 */
function isAppAuthorizationUnavailable(body: string): boolean {
  return body.includes('"statusCode":503') && body.includes('authorization unavailable');
}

/** In lỗi + remedy rồi exit 1. Console/exit là output chương trình → English. */
function fail(origin: string, elapsedMs: number, error: Error): never {
  console.error(
    `stack gate FAILED after ${elapsedMs}ms: ${origin}/api/staff is not serving the expected unauthenticated contract — ${error.message}. ` +
      'The local stack is not reachable or not ready. Start it with `pnpm nx affected -t system-test -c local` (Nx provisions the local-up prerequisites first), then rerun the suite. ' +
      'This suite must FAIL when the stack is down; skipping is never an acceptable result.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const { hostname, port, ca } = resolveBackofficeOrigin();
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
      if (error instanceof StaleDeploymentError) {
        console.error(
          `stack gate FAILED after ${Date.now() - startedAt}ms: ${origin}/api/staff returned 503 "authorization unavailable" ` +
            'with the pre-BFF contract — the running backoffice image predates the OIDC BFF wiring (PR #358). ' +
            'Redeploy the local stack with `pnpm nx affected -t system-test -c local`, then rerun the suite. This suite tests login ' +
            'and permission enforcement through the BFF and cannot run against a stack without it.',
        );
        process.exit(1);
      }
      if (!(error instanceof RetryableError)) {
        fail(origin, Date.now() - startedAt, error as Error);
      }
      lastFailure = error as Error;
    }
    if (result) {
      // Hợp đồng unauthenticated của BFF (authn middleware, PR #358).
      if (result.status === 401) {
        console.log(
          `stack gate OK: ${origin}/api/staff -> 401 unauthenticated (BFF authn middleware active) after ${Date.now() - startedAt}ms`,
        );
        return;
      }
      if (result.status === 503 && isAppAuthorizationUnavailable(result.body)) {
        // Fail-closed của app khi OIDC config thiếu — stack predates #358.
        throw new StaleDeploymentError('pre-BFF backoffice image detected');
      }
      if (!RETRYABLE_STATUSES.has(result.status)) {
        fail(
          origin,
          Date.now() - startedAt,
          new Error(
            `expected 401 for an unauthenticated GET /api/staff, got ${result.status} ` +
              `with body ${JSON.stringify(result.body.slice(0, 200))}`,
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
