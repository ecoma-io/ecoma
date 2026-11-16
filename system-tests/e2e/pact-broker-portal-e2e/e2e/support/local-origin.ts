import { readFileSync } from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Tên cert TLS của stack — SUY từ `ROOT_HOST` (host trước `:`), KHÔNG hardcode.
 *
 * Deploy đặt tên cert theo `LOCAL_ROOT_HOSTNAME` (hằng số platform, hiện
 * `fbi.com`) và ghi host:port động vào `.env`; hai giá trị này nhất quán với
 * nhau khi deploy thành công, nên host từ `ROOT_HOST` là nguồn đúng cho tên
 * file cert (`<root>.crt` trong `deploys/platform-deploy/local-certs/`).
 */

// File này nằm ở `e2e/support/` — NĂM mức `../` về repo root (support → e2e →
// suite → category → system-tests → root). Sai một mức là ENOENT ngay lúc
// module load.
const CERT_DIR = join(SUITE_DIR, '../../../../../deploys/platform-deploy/local-certs');

/**
 * Cert + path cert — LAZY: đọc lúc bị cần, KHÔNG lúc module load. Thiếu
 * `ROOT_HOST`/cert thì module vẫn nạp (placeholder `.invalid` của
 * `resolvePortalOrigin()`/`resolveApiOrigin()` vẫn trả được), để
 * `--list`/graph evaluation không crash trên worktree chưa deploy; test thật
 * đi qua global-setup gate fail-closed.
 */

/** Hostname gốc từ env hoặc `.env` — raw throw khi thiếu cả hai (cert path cần host thật). */
function rootHostRaw(): string {
  const fromEnv = process.env.ROOT_HOST;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  try {
    const text = readFileSync(join(SUITE_DIR, '../../../../../.env'), 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const match = /^ROOT_(?:DOMAIN|HOST)=(.*)$/u.exec(line.trim());
      if (match && match[1].trim().length > 0) {
        return match[1].trim();
      }
    }
  } catch {
    // `.env` vắng mặt — throw bên dưới với message nêu đúng remedy.
  }
  throw new Error(
    'ROOT_HOST is not set and no .env file defines it. ' +
      'Deploy the local stack first (Nx provisions the `local-up` prerequisites) — deploying writes the dynamic Traefik host:port into the repo-root .env.',
  );
}

let localCaPemCache: string | undefined;
function localCaPem(): string {
  if (localCaPemCache === undefined) {
    const certFile = join(CERT_DIR, `${rootHostRaw().split(':')[0]}.crt`);
    localCaPemCache = readFileSync(certFile, 'utf8');
  }
  return localCaPemCache;
}

/** Đường dẫn cert đã suy — tái dùng bởi spec (SSL_CERT_FILE của Pact CLI). */
export function localCertPath(): string {
  return join(CERT_DIR, `${rootHostRaw().split(':')[0]}.crt`);
}

/**
 * Origin portal của stack local — `https://pact.<root>:<port>`.
 *
 * `ROOT_HOST` là HOSTNAME GỐC của stack (dạng `hostname:port`) — hợp đồng chung
 * của mọi system suite: suite này ghép `pact.` vì router Traefik của portal
 * match `Host(pact.<root>)`. Giá trị raw KHÔNG bao giờ được dùng làm origin.
 *
 * Khi chạy qua Nx, `.env` repo root đã nằm trong env của task; chạy
 * `npx playwright test` trực tiếp thì fallback parse `.env`. KHÔNG có env nào
 * ⇒ placeholder `.invalid` (RFC 2606) — mọi request đỏ với DNS failure, không
 * bao giờ xanh giả; module-load vẫn thành công cho `--list`/graph evaluation.
 */
export function resolvePortalOrigin(): string {
  return originWithPrefix('pact.');
}

/** Origin API broker — `https://api.<root>:<port>`, broker-base-url của Pact CLI. */
export function resolveApiOrigin(): string {
  return originWithPrefix('api.');
}

function originWithPrefix(prefix: string): string {
  const fromEnv = process.env.ROOT_HOST;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return withOrigin(prefix, fromEnv.trim());
  }
  try {
    const text = readFileSync(join(SUITE_DIR, '../../../../../.env'), 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const match = /^ROOT_(?:DOMAIN|HOST)=(.*)$/u.exec(line.trim());
      if (match && match[1].trim().length > 0) {
        return withOrigin(prefix, match[1].trim());
      }
    }
  } catch {
    // `.env` vắng mặt — placeholder bên dưới; gate global-setup là đường fail-closed.
  }
  return `https://${prefix}placeholder.invalid:443`;
}

/** Ghép hostname gốc (dạng `hostname:port`) thành origin `<prefix><hostname>:<port>`. */
function withOrigin(prefix: string, raw: string): string {
  const hostname = raw.split(':')[0];
  const port = raw.includes(':') ? raw.split(':')[1] : '443';
  return `https://${prefix}${hostname}:${port}`;
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
          // `Host` tường minh `hostname:port` — đúng dạng mà rule `Host(...)`
          // của Traefik nhìn (Traefik match hostname không port).
          Host: target.host,
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
