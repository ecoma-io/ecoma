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
 * Stack gate fail-closed của suite `remote-cache-portal-e2e` — probe TRƯỚC KHI
 * suite chạy, không phải trong từng test.
 *
 * Hợp đồng: stack không có là KẾT QUẢ ĐỎ, không bao giờ là skip (cùng triết lý
 * fail-closed của `backoffice-access-control-e2e`).
 *
 * ## Probe kiểm ĐÚNG hợp đồng của suite này
 *
 * `GET /api/portal/tenants/ecoma/projects` KHÔNG cookie phải trả **401** —
 * middleware `apps/remote-cache-app/server/middleware/authn.ts` chặn mọi route
 * BFF trước khi tới proxy: cookie `__Host-remote-cache-app-session` vắng ⇒ 401.
 * Đây là hợp đồng nhận diện "stack có đủ wiring BFF + OIDC":
 *
 * - **401** ⇒ middleware authn chạy và từ chối caller chưa đăng nhập — stack
 *   sẵn sàng cho phần còn lại của suite.
 * - **200** là SAI HỢP ĐỒNG (unauthenticated bị nhận vào) — fail tức thời.
 *
 * ## Retry chỉ dành cho chữ ký "chưa sẵn sàng"
 *
 * Ngay sau `pulumi up`, container portal và router Traefik cần thời gian lên:
 * ECONNREFUSED / ECONNRESET / ETIMEDOUT, timeout từng request, và
 * 404/502/503/504 (404 hẹp: cửa sổ đăng ký router Traefik). Lỗi TLS và 4xx
 * khác là lỗi thật — fail tức thời.
 *
 * ⚠️ Node `https` thay vì global `fetch`: `fetch` của Node (undici) không nhận
 * `node:https.Agent` làm `dispatcher` — `https.get` với `ca` scoped là đường đã
 * chạy thật ở các suite cùng nhóm.
 */

/**
 * Tổng budget retry: đủ cho cold start của stack dưới tải CI, không đủ để treo CI.
 *
 * Đo được trên merge queue: Traefik đăng ký router chậm hơn 30s khi runner đang
 * chạy các deploy local-up cạnh nhau — 3 lần đỏ đều đốt đúng toàn bộ 30004ms
 * trên 404 (runs 43775477815, 43778400309, 43780675091). 90s = 3 lần cửa sổ cũ,
 * vẫn fail-closed: hết budget vẫn exit 1, chỉ là cửa sổ sẵn sàng rộng hơn.
 * Xác nhận xanh trên CI: run 43785998930 (system-test SUCCESS, cả hai suite).
 */
const BUDGET_MS = 90_000;
/** Timeout mỗi request — request treo coi là "chưa sẵn sàng" và được thử lại. */
const REQUEST_TIMEOUT_MS = 5_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 5_000;

const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
// 404 hẹp: cửa sổ router Traefik cũ gỡ — mới đăng ký. 502/503/504 là upstream
// chưa sẵn sàng — retry. 4xx khác (đặc biệt 401 là hợp đồng mong đợi) không retry.
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

/**
 * Namespace worktree của stack mà ROOT_HOST đang trỏ tới — dò bằng `docker ps`
 * qua `traefikNamespaceOrNull` của `e2e/support/stack-env` (một bản duy nhất
 * trong suite). Không tìm thấy là lỗi cài đặt stack — gate fail với remedy
 * (kèm danh sách container đã dò) thay vì đoán namespace.
 */
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
      'remote-cache-portal-e2e global setup failed: ROOT_HOST is not set and no .env file defines it. ' +
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
function probeOnce(hostname: string, port: string, ca: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        host: hostname,
        port,
        path: '/api/portal/tenants/ecoma/projects',
        ca,
        servername: hostname,
        headers: {
          // `Host` tường minh `hostname:port` — khớp rule
          // `Host(\`remote-cache-app-<ns>.<rootHostname>\`)` của router
          // Traefik (Traefik match hostname không port).
          Host: `${hostname}:${port}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      (response) => {
        const tlsSocket = response.socket instanceof tls.TLSSocket ? response.socket : undefined;
        if (tlsSocket?.authorized !== true) {
          reject(
            new VerificationFailure(
              // authorizationError là string (reason code), không phải Error.
              `TLS not verified — ${tlsSocket?.authorizationError ?? 'socket has no verify status'}`,
            ),
          );
          response.resume();
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
    `stack gate FAILED after ${elapsedMs}ms: ${origin}/api/portal/tenants/ecoma/projects is not serving the expected unauthenticated contract — ${error.message}. ` +
      'The local stack is not reachable or not ready. Start it with `pnpm nx affected -t system-test -c local` (Nx provisions the local-up prerequisites first), then rerun the suite. ' +
      'This suite must FAIL when the stack is down; skipping is never an acceptable result.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  // resolveRootOrigin() có thể ném khi thiếu ROOT_HOST/.env/cert — đây là lỗi
  // cài đặt stack, phải đi qua đường `fail()` của gate với remedy, không phải
  // unhandled rejection.
  let root: { hostname: string; port: string; ca: string };
  try {
    root = resolveRootOrigin();
  } catch (error) {
    fail(
      'https://<unresolved ROOT_HOST>',
      0,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  const { hostname, port, ca } = root;
  // Hostname per-worktree (#316): namespace dò từ container Traefik publish
  // đúng port trong ROOT_HOST — lỗi dò là lỗi cài đặt stack, đưa vào đường
  // `fail()` của gate thay vì unhandled rejection.
  let namespace: string;
  try {
    namespace = traefikNamespace(hostname, port);
  } catch (error) {
    console.error(
      `stack gate FAILED while discovering the per-worktree namespace: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  const probeHostname = localServiceHostname('remote-cache-app', hostname, namespace);
  const origin = `https://${probeHostname}:${port}`;
  const startedAt = Date.now();
  let backoffMs = BACKOFF_INITIAL_MS;
  let lastFailure = new Error('probe never ran');
  // Luôn chạy ít nhất một lần; các lần sau chỉ khi lỗi retry-được và còn budget.
  for (;;) {
    let result: ProbeResult | undefined;
    try {
      result = await probeOnce(probeHostname, port, ca);
    } catch (error) {
      if (!(error instanceof RetryableError)) {
        fail(origin, Date.now() - startedAt, error as Error);
      }
      lastFailure = error as Error;
    }
    if (result) {
      // Hợp đồng unauthenticated của BFF portal (middleware authn).
      if (result.status === 401) {
        console.log(
          `stack gate OK: ${origin}/api/portal/tenants/ecoma/projects -> 401 unauthenticated (portal authn middleware active) after ${Date.now() - startedAt}ms`,
        );
        return;
      }
      if (!RETRYABLE_STATUSES.has(result.status)) {
        fail(
          origin,
          Date.now() - startedAt,
          new Error(
            `expected 401 for an unauthenticated GET /api/portal/tenants/ecoma/projects, got ${result.status} ` +
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
