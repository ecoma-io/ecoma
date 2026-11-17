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
 * Scoped TLS + origin cho các API assertion của suite — bản của CHÍNH suite
 * này (`docs/architecture/06-testing.md` §2: mỗi suite tự sở hữu support).
 * Suite này ghép hostname cho BỐN origin per-worktree: `office` (Backoffice),
 * `pact` (portal Pact), `api` (broker machine API) và `remote-cache-app`
 * (portal Remote Cache).
 *
 * Trust là TƯỜNG MINH và scoped: `ca` của riêng request trỏ vào cert đã commit.
 * Sau response, INVARIANT là khẳng định `socket.authorized === true`.
 *
 * ⚠️ Node `https` thay vì global `fetch`: `fetch` của Node (undici) không nhận
 * `node:https.Agent` làm `dispatcher` — `https.request` với `ca` scoped là
 * đường đã chạy thật ở các suite cùng nhóm.
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

/** Namespace worktree của stack publish `port` — lỗi là lỗi cài đặt stack. */
function traefikNamespace(port: string): string | undefined {
  return traefikNamespaceOrNull(port).namespace;
}

/**
 * Ghép hostname gốc (dạng `hostname:port`) thành origin per-worktree
 * `<sub>-<ns>.<hostname>:<port>` qua `localServiceHostname`. Namespace không
 * dò được (Docker vắng mặt) ⇒ placeholder `.invalid` — fail đỏ với DNS
 * failure thay vì xanh giả; module-load vẫn thành công cho `--list`/graph eval.
 */
function originFor(sub: string, raw: string | undefined): string {
  if (raw === undefined) {
    return `https://${sub}.placeholder.invalid:443`;
  }
  const { hostname, port } = splitHostPort(raw);
  const namespace = traefikNamespace(port);
  if (namespace === undefined) {
    return `https://${sub}.placeholder.invalid:${port}`;
  }
  return `https://${localServiceHostname(sub, hostname, namespace)}:${port}`;
}

/** Origin Backoffice — `https://office-<ns>.<root>:<port>` (bước 1 chuỗi). */
export function resolveBackofficeOrigin(): string {
  return originFor('office', sharedRootHostRaw());
}

/** Origin portal Pact — `https://pact-<ns>.<root>:<port>`. */
export function resolvePactPortalOrigin(): string {
  return originFor('pact', sharedRootHostRaw());
}

/** Origin broker machine API — `https://api-<ns>.<root>:<port>`. */
export function resolvePactApiOrigin(): string {
  return originFor('api', sharedRootHostRaw());
}

/** Origin portal Remote Cache — `https://remote-cache-app-<ns>.<root>:<port>`. */
export function resolveRemoteCachePortalOrigin(): string {
  return originFor('remote-cache-app', sharedRootHostRaw());
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
          response.resume();
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', (error: Error) => reject(error));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              location: response.headers.location,
              'content-type': response.headers['content-type'],
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
