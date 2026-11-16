import https from 'node:https';
import tls from 'node:tls';

import { localServiceHostname } from '@ecoma-io/deployment';

import {
  localCertPem,
  localCertPath as sharedLocalCertPath,
  rootHostRaw as sharedRootHostRaw,
  splitHostPort,
  traefikNamespaceOrNull,
} from './stack-env';

/**
 * Scoped TLS + origin cho các API assertion của suite.
 *
 * Đây là "phòng hỗ trợ" của CHÍNH suite này (`docs/architecture/06-testing.md`
 * §2: mỗi system-test suite tự sở hữu setup/support của nó) — bản cố ý với
 * `backoffice-access-control-e2e`/`remote-cache-portal-e2e`, không phải nợ kỹ
 * thuật. Suite này không thêm method nào: GET/POST/PUT/DELETE đủ cho mọi
 * assertion (machine-tokens POST/DELETE, HAL GET).
 *
 * Trust là TƯỜNG MINH và scoped: `ca` của riêng request trỏ vào cert đã commit —
 * không đụng trust store toàn cục, không biến môi trường
 * NODE_TLS_REJECT_UNAUTHORIZED nào bị đặt. Sau response, INVARIANT là khẳng
 * định `socket.authorized === true`.
 *
 * ⚠️ Node `https` thay vì global `fetch`: `fetch` của Node (undici) không nhận
 * `node:https.Agent` làm `dispatcher` (đã thử thật — request fail im lặng),
 * còn `undici.Agent` thì không phải dependency của workspace.
 */

let localCaPemCache: string | undefined;
function localCaPem(): string {
  localCaPemCache ??= localCertPem();
  return localCaPemCache;
}

/** Đường dẫn cert đã suy — tái dùng bởi spec (SSL_CERT_FILE của Pact CLI). */
export function localCertPath(): string {
  return sharedLocalCertPath();
}

/**
 * Namespace worktree của stack publish `port` — dò bằng `docker ps` qua
 * `traefikNamespaceOrNull` của `stack-env` (một bản duy nhất trong suite).
 * Helper runtime: bị gọi khi test đã chạy thật nên Docker phải có.
 */
function traefikNamespace(port: string): string | undefined {
  return traefikNamespaceOrNull(port).namespace;
}

/**
 * Origin portal của stack local — `https://pact-<ns>.<root>:<port>` (#316).
 *
 * `ROOT_HOST` là HOSTNAME GỐC của stack (dạng `hostname:port`) — hợp đồng chung
 * của mọi system suite: suite này suy hostname portal qua `localServiceHostname`
 * vì router Traefik của portal match `Host(\`pact-<ns>.<root>\`)` — cùng hàm mà
 * deploy dùng khi đăng ký router (`deploys/pact-broker-app-deploy/index.ts`).
 * Giá trị raw KHÔNG bao giờ được dùng làm origin.
 *
 * Khi chạy qua Nx, `.env` repo root đã nằm trong env của task; chạy
 * `npx playwright test` trực tiếp thì fallback parse `.env`. KHÔNG có env nào
 * ⇒ placeholder `.invalid` (RFC 2606) — mọi request đỏ với DNS failure, không
 * bao giờ xanh giả; module-load vẫn thành công cho `--list`/graph evaluation.
 */
export function resolvePortalOrigin(): string {
  return namespacedOrigin('pact');
}

/** Origin API broker — `https://api-<ns>.<root>:<port>`, broker-base-url của Pact CLI. */
export function resolveApiOrigin(): string {
  return namespacedOrigin('api');
}

function namespacedOrigin(sub: string): string {
  const raw = sharedRootHostRaw();
  if (raw !== undefined) {
    return originFor(sub, raw);
  }
  return `https://${sub}.placeholder.invalid:443`;
}

/**
 * Ghép hostname gốc (dạng `hostname:port`) thành origin per-worktree
 * `<sub>-<ns>.<hostname>:<port>` qua `localServiceHostname`. Namespace không dò
 * được (Docker vắng mặt) ⇒ placeholder `.invalid` — fail đỏ với DNS failure
 * thay vì xanh giả (cùng triết lý placeholder ở đầu file).
 */
function originFor(sub: string, raw: string): string {
  const { hostname, port } = splitHostPort(raw);
  const namespace = traefikNamespace(port);
  if (namespace === undefined) {
    return `https://${sub}.placeholder.invalid:${port}`;
  }
  return `https://${localServiceHostname(sub, hostname, namespace)}:${port}`;
}

/** Headers + body thô của một response — đủ cho mọi assertion của suite. */
export interface StackResponse {
  readonly status: number;
  readonly headers: Record<string, string | undefined>;
  readonly body: string;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly headers?: Record<string, string>;
  /** Body đã encode — caller tự chọn form hay JSON và tự set content-type. */
  readonly body?: string;
}

/**
 * Request một path trên stack với `ca` scoped và `redirect` KHÔNG được theo —
 * suite assert trên từng redirect.
 */
export function stackRequest(url: string, options: RequestOptions = {}): Promise<StackResponse> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: target.hostname,
        port: target.port || '443',
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'GET',
        ca: localCaPem(),
        servername: target.hostname,
        headers: {
          // `Host` tường minh hostname KHÔNG port — Traefik match hostname;
          // routing port đã nằm ở option `port` của request.
          Host: target.hostname,
          ...options.headers,
        },
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        const tlsSocket = response.socket instanceof tls.TLSSocket ? response.socket : undefined;
        if (tlsSocket?.authorized !== true) {
          reject(
            new Error(
              `TLS not verified for ${url} — ${
                tlsSocket?.authorizationError ?? 'socket has no verify status'
              }`,
            ),
          );
          // Response stream bị bỏ lại không tiêu thụ thì socket reset sau đó
          // ném uncaught 'error' — drain trước khi bỏ.
          response.resume();
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        // Response stream không có listener 'error' thì Node ném uncaught
        // exception giữa chừng (socket reset sau khi response bắt đầu).
        response.on('error', (error: Error) => reject(error));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              location: response.headers.location,
              'content-type': response.headers['content-type'],
              // `set-cookie` có thể lặp — giữ nguyên dạng raw array.
              'set-cookie': response.headers['set-cookie']?.join('\n'),
            },
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', (error: Error) => reject(error));
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

/** GET một path trên stack. */
export function stackGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<StackResponse> {
  return stackRequest(url, { method: 'GET', headers });
}
