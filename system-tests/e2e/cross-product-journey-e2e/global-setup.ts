import https from 'node:https';
import tls from 'node:tls';

import { localServiceHostname } from '@ecoma-io/deployment';

import {
  localCertPem,
  rootHostRaw,
  splitHostPort,
  traefikNamespaceOrNull,
} from './e2e/support/stack-env';

/**
 * Stack gate fail-closed của suite `cross-product-journey-e2e` — probe TRƯỚC
 * KHI suite chạy, không phải trong từng test.
 *
 * Hợp đồng: stack không có là KẾT QUẢ ĐỎ, không bao giờ là skip.
 *
 * ## Probe kiểm ĐÚNG hợp đồng của suite này
 *
 * Chuỗi đi qua BỐN BFF — gate probe HAI cổng quan trọng nhất với hợp đồng
 * unauthenticated 401, cùng lớp middleware authn mà các suite hiện có đã
 * verify:
 *
 * - Backoffice: `GET /api/staff` KHÔNG cookie phải 401 (middleware
 *   `apps/backoffice/server/middleware/authn.ts` chặn mọi `/api/**`).
 * - Portal Remote Cache: `GET /api/portal/tenants/ecoma/projects` KHÔNG cookie
 *   phải 401 (middleware `apps/remote-cache-app/server/middleware/authn.ts`).
 *
 * **401** ⇒ middleware authn chạy — stack sẵn sàng cho chuỗi; **200** là SAI
 * HỢP ĐỒNG (unauthenticated bị nhận vào) — fail tức thời.
 *
 * ## Retry chỉ dành cho chữ ký "chưa sẵn sàng"
 *
 * ECONNREFUSED / ECONNRESET / ETIMEDOUT, timeout từng request, và
 * 404/502/503/504 (404 hẹp: cửa sổ đăng ký router Traefik). Lỗi TLS và 4xx
 * khác là lỗi thật — fail tức thời. Budget 90s: cùng giá trị mà
 * `remote-cache-portal-e2e` đo được trên merge queue (Traefik đăng ký router
 * chậm hơn 30s khi các deploy local-up chạy cạnh nhau).
 */

const BUDGET_MS = 90_000;
/** Timeout mỗi request — request treo coi là "chưa sẵn sàng" và được thử lại. */
const REQUEST_TIMEOUT_MS = 5_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 5_000;

const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
const RETRYABLE_STATUSES = new Set([404, 502, 503, 504]);
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

/** Lỗi cài đặt stack — gate fail với remedy thay vì đoán namespace. */
function traefikNamespace(hostname: string, port: string): string {
  const { namespace, failureDetail } = traefikNamespaceOrNull(port);
  if (namespace !== undefined) {
    return namespace;
  }
  throw new Error(
    `no ecoma Traefik container publishes loopback port ${port} of ${hostname} — ${failureDetail}; ` +
      'the stack behind ROOT_HOST is not running or was not deployed by the Nx local lane.',
  );
}

function resolveRootOrigin(): { hostname: string; port: string; ca: string } {
  const raw = rootHostRaw();
  if (raw === undefined) {
    throw new Error(
      'cross-product-journey-e2e global setup failed: ROOT_HOST is not set and no .env file defines it. ' +
        'Deploy the local stack first (Nx provisions the `local-up` prerequisites) — deploying writes the dynamic Traefik host:port into the repo-root .env.',
    );
  }
  return { ...splitHostPort(raw), ca: localCertPem() };
}

/**
 * Request Node thuần với `ca` scoped — TƯỜNG MINH về TLS verify: sau response,
 * khẳng định `socket.authorized === true` thay vì tin rằng "request thành công
 * nghĩa là TLS đã verify".
 */
function probeOnce(hostname: string, port: string, path: string, ca: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        host: hostname,
        port,
        path,
        ca,
        servername: hostname,
        headers: {
          // `Host` tường minh hostname KHÔNG port — Traefik match hostname,
          // routing port nằm ở option `port` của request.
          Host: hostname,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      (response) => {
        const tlsSocket = response.socket instanceof tls.TLSSocket ? response.socket : undefined;
        if (tlsSocket?.authorized !== true) {
          reject(
            new VerificationFailure(
              `TLS not verified — ${tlsSocket?.authorizationError ?? 'socket has no verify status'}`,
            ),
          );
          response.resume();
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
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
  if (error.name === 'TimeoutError' || error.name === 'AbortError' || code === 'ABORT_ERR') {
    return new RetryableError(`timeout after ${REQUEST_TIMEOUT_MS}ms — server did not respond`);
  }
  if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) {
    return new RetryableError(`${code} — server not listening/not ready yet`);
  }
  return new VerificationFailure(error.message);
}

function fail(message: string): never {
  console.error(
    `stack gate FAILED: ${message}. The local stack is not reachable or not ready. ` +
      'Start it with `pnpm nx affected -t system-test -c local` (Nx provisions the local-up prerequisites first), then rerun the suite. ' +
      'This suite must FAIL when the stack is down; skipping is never an acceptable result.',
  );
  process.exit(1);
}

/**
 * Probe MỘT cổng: retry trên chữ ký "chưa sẵn sàng" cho tới khi thấy 401
 * (hợp đồng unauthenticated của middleware authn) hoặc hết budget.
 */
async function probeUntilUnauthorized(
  label: string,
  hostname: string,
  port: string,
  path: string,
  ca: string,
): Promise<void> {
  const origin = `https://${hostname}:${port}`;
  const startedAt = Date.now();
  let backoffMs = BACKOFF_INITIAL_MS;
  let lastFailure = new Error('probe never ran');
  for (;;) {
    let result: ProbeResult | undefined;
    try {
      result = await probeOnce(hostname, port, path, ca);
    } catch (error) {
      if (!(error instanceof RetryableError)) {
        fail(
          `${label} ${origin}${path} — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      lastFailure = error as Error;
    }
    if (result) {
      if (result.status === 401) {
        console.log(
          `stack gate OK: ${label} ${origin}${path} -> 401 unauthenticated (authn middleware active) after ${Date.now() - startedAt}ms`,
        );
        return;
      }
      if (!RETRYABLE_STATUSES.has(result.status)) {
        fail(
          `${label} expected 401 for an unauthenticated GET ${path}, got ${result.status} ` +
            `with body ${JSON.stringify(result.body.slice(0, 200))}`,
        );
      }
      lastFailure = new Error(
        `status ${result.status} — upstream not ready yet (retryable window, e.g. Traefik router registration)`,
      );
    }
    const remainingMs = BUDGET_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      fail(
        `${label} ${origin}${path} not serving the unauthenticated contract — ${lastFailure.message}`,
      );
    }
    const sleepMs = Math.min(backoffMs, remainingMs);
    console.error(
      `stack gate RETRY ${label} after ${Date.now() - startedAt}ms: ${lastFailure.message}`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, sleepMs);
    });
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  }
}

async function main(): Promise<void> {
  let root: { hostname: string; port: string; ca: string };
  try {
    root = resolveRootOrigin();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const { hostname, port, ca } = root;
  let namespace: string;
  try {
    namespace = traefikNamespace(hostname, port);
  } catch (error) {
    fail(
      `while discovering the per-worktree namespace: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Hai cổng của chuỗi — lần lượt, mỗi cổng một probe với retry riêng.
  const backofficeHostname = localServiceHostname('office', hostname, namespace);
  await probeUntilUnauthorized('backoffice', backofficeHostname, port, '/api/staff', ca);
  const remoteCacheHostname = localServiceHostname('remote-cache-app', hostname, namespace);
  await probeUntilUnauthorized(
    'remote-cache-app',
    remoteCacheHostname,
    port,
    '/api/portal/tenants/ecoma/projects',
    ca,
  );
}

export default main;
