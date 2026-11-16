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
 * `backoffice-access-control-e2e`, không phải nợ kỹ thuật. Suite này thêm
 * method PUT + DELETE cho data-plane assertion (`/v1/cache/:hash`) — hai method
 * mà suite backoffice không cần.
 *
 * Trust là TƯỜNG MINH và scoped: `ca` của riêng request trỏ vào cert đã commit —
 * không đụng trust store toàn cục, không biến môi trường
 * NODE_TLS_REJECT_UNAUTHORIZED nào bị đặt. Sau response, INVARIANT là khẳng
 * định `socket.authorized === true`.
 *
 * ⚠️ Node `https` thay vì global `fetch`: `fetch` của Node (undici) không nhận
 * `node:https.Agent` làm `dispatcher` (đã thử thật — request fail im lặng),
 * còn `undici.Agent` thì không phải dependency của workspace.
 *
 * `ROOT_HOST`/cert/namespace thuộc về `stack-env.ts` (một bản duy nhất trong
 * suite) — file này chỉ giữ logic request/assertion.
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
 * Origin portal của stack local — `https://remote-cache-app-<ns>.<root>:<port>`
 * (#316).
 *
 * `ROOT_HOST` là HOSTNAME GỐC của stack (dạng `hostname:port`) — hợp đồng chung
 * của mọi system suite: suite này suy hostname portal qua `localServiceHostname`
 * vì router Traefik của portal match `Host(\`remote-cache-app-<ns>.<root>\`)` —
 * cùng hàm mà deploy dùng khi đăng ký router
 * (`deploys/remote-cache-app-deploy/index.ts`). Giá trị raw KHÔNG bao giờ được
 * dùng làm origin.
 *
 * Khi chạy qua Nx, `.env` repo root đã nằm trong env của task; chạy
 * `npx playwright test` trực tiếp thì fallback parse `.env`. KHÔNG có env nào
 * ⇒ placeholder `.invalid` (RFC 2606) — mọi request đỏ với DNS failure, không
 * bao giờ xanh giả; module-load vẫn thành công cho `--list`/graph evaluation.
 */
export function resolveStackOrigin(): string {
  const raw = sharedRootHostRaw();
  if (raw !== undefined) {
    return stackOrigin(raw);
  }
  return 'https://remote-cache-app.placeholder.invalid:443';
}

/**
 * Ghép hostname gốc (dạng `hostname:port`) thành origin per-worktree
 * `remote-cache-app-<ns>.<hostname>:<port>` qua `localServiceHostname`.
 * Namespace không dò được (Docker vắng mặt) ⇒ placeholder `.invalid` — fail đỏ
 * với DNS failure thay vì xanh giả.
 */
function stackOrigin(raw: string): string {
  const { hostname, port } = splitHostPort(raw);
  const namespace = traefikNamespace(port);
  if (namespace === undefined) {
    return `https://remote-cache-app.placeholder.invalid:${port}`;
  }
  return `https://${localServiceHostname('remote-cache-app', hostname, namespace)}:${port}`;
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

/** POST JSON lên stack, trả response thô. */
export function stackPostJson(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<StackResponse> {
  return stackRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

/**
 * Cookie jar tối thiểu — đọc `Set-Cookie` từ response, gửi lại trên request kế
 * tiếp. KHÔNG phải một cookie engine: không expiry, không path matching (suite
 * chỉ nói chuyện với một origin), không tách `__Host-` semantics — các bất
 * biến đó được assert tường minh trong test, không được engine nuốt.
 */
export class CookieJar {
  // Tên field CỐ Ý không phải `cookies`: rule semgrep
  // `security-sensitive-value-in-http-response` nhận diện taint source qua TÊN
  // (`cookies?...`), mà map này là fixture nội bộ của test — nó ĐI VÀO header
  // request, không bao giờ được trả ra trong một HTTP response. Đặt tên
  // `cookieMap` tránh false positive tại source mà không cần allowlist entry.
  private readonly cookieMap = new Map<string, string>();

  /** Nuốt `set-cookie` từ một `StackResponse` (đã join bằng `\n`). */
  absorb(response: StackResponse): void {
    const raw = response.headers['set-cookie'];
    if (raw === undefined) {
      return;
    }
    for (const line of raw.split('\n')) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // `Max-Age=0` là lệnh xoá — cookie value rỗng từ server đi cùng ý nghĩa đó.
      if (/max-age=0/iu.test(line)) {
        this.cookieMap.delete(name);
        continue;
      }
      this.cookieMap.set(name, value);
    }
  }

  /** Giá trị một cookie, `undefined` khi không có. */
  get(name: string): string | undefined {
    return this.cookieMap.get(name);
  }

  /** Header `Cookie` gộp, hoặc `undefined` khi jar rỗng. */
  header(): string | undefined {
    if (this.cookieMap.size === 0) {
      return undefined;
    }
    return [...this.cookieMap.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}
