import { readFileSync } from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localServiceOrigin } from '@ecoma-io/deployment';

import { resolveStackNamespace } from './local-stack';
import { readRootHostPort } from './root-host';

/**
 * Scoped TLS + origin cho các API assertion của suite.
 *
 * Copy cấu trúc từ skeleton `home-public-e2e/e2e/support/local-origin.ts` —
 * "phòng hỗ trợ" của CHÍNH suite này (`docs/architecture/06-testing.md` §2: mỗi
 * system-test suite tự sở hữu setup/support của nó; không có thư viện dùng
 * chung ở root và không cần — hai bản cố ý, không phải nợ kỹ thuật).
 *
 * Trust là TƯỜNG MINH và scoped: `ca` của riêng request trỏ vào cert đã
 * commit — không đụng trust store toàn cục, không biến môi trường
 * NODE_TLS_REJECT_UNAUTHORIZED nào bị đặt. Sau response, INVARIANT là khẳng
 * định `socket.authorized === true` (`local-smoke.mjs`): "request thành công"
 * chưa đủ, TLS phải được verify thật sự — nếu sau này ai thêm
 * `rejectUnauthorized: false` để "cho suite chạy được" thì assertion ở đây
 * làm test ĐỎ ngay.
 *
 * ⚠️ Node `https` thay vì global `fetch`: `fetch` của Node (undici) không nhận
 * `node:https.Agent` làm `dispatcher` (đã thử thật — request fail im lặng),
 * còn `undici.Agent` thì không phải dependency của workspace.
 *
 * So với skeleton, helper này MỞ RỘNG đúng những gì luồng login cần:
 * - `stackRequest` chung cho MỌI method (GET/POST) với JSON body — skeleton
 *   chỉ có GET, còn login là chuỗi POST (`challenge`, `verify`, `logout`);
 * - trả `rawSetCookie` (mảng `Set-Cookie` THÔ từ `rawHeaders`) — `verify`
 *   phát hành HAI cookie cùng tên-prefix (`__Host-account-session`,
 *   `__Host-account-csrf`) và assertion flag cookie cần đọc từng header
 *   nguyên văn; gộp qua `response.headers['set-cookie']` cũng được Node giữ
 *   nguyên dạng mảng, nhưng lấy từ `rawHeaders` là đường chắc chắn nhất;
 * - `redirect: 'manual'` semantics giữ nguyên của skeleton: `node:https`
 *   KHÔNG tự follow redirect, và các route của luồng này không redirect.
 */

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

// File này nằm ở `e2e/support/` — NĂM mức `../` về repo root (support → e2e →
// suite → category → system-tests → root). Sai một mức là ENOENT ngay lúc
// module load — đã gặp thật với cả bốn lẫn năm mức, nên mức này được ghi ra.
const LOCAL_CERT_PATH = join(
  SUITE_DIR,
  '../../../../../deploys/platform-deploy/local-certs/fbi.com.crt',
);

export const LOCAL_CA_PEM = readFileSync(LOCAL_CERT_PATH, 'utf8');

/**
 * Giá trị `host:port` của stack local — chuyển sang `root-host.ts` (module lá)
 * để cắt vòng import `local-origin` ↔ `local-stack`: local-stack cần hàm này,
 * local-origin cần `resolveStackNamespace` của local-stack. Re-export giữ mặt
 * API cho caller cũ.
 */
export { readRootHostPort } from './root-host';

/**
 * Origin ACCOUNT của stack local, dạng `https://account-<ns>.<host>:<port>` —
 * hostname per-worktree qua contract `localServiceOrigin` của
 * `@ecoma-io/deployment` (#316); `readRootHostPort` (alias `ROOT_DOMAIN` từng
 * tồn tại đã bị xoá khỏi contract, #210) cho hostname gốc + port, namespace từ
 * `resolveStackNamespace()` dò container Traefik theo port.
 */
export function resolveAccountOrigin(): string {
  const hostPort = readRootHostPort();
  const hostname = hostPort.split(':')[0];
  const portStr = hostPort.includes(':') ? (hostPort.split(':')[1] ?? '443') : '443';
  const port = Number(portStr);
  // Ranh giới ROOT_HOST: port không phải số hợp lệ là lỗi cấu hình — throw với
  // message rõ thay vì sinh origin `:NaN` hỏng lặng lẽ.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port in ROOT_HOST: "${portStr}" — expected <hostname>:<1-65535>.`);
  }
  return localServiceOrigin('account', hostname, resolveStackNamespace(), port);
}

/** Kết quả một request — đủ cho mọi assertion status/header/cookie/body của suite. */
export interface StackResponse {
  readonly status: number;
  /** Mảng `Set-Cookie` THÔ — mỗi phần tử MỘT header nguyên văn (có thể rỗng). */
  readonly rawSetCookie: readonly string[];
  /** Header đơn lẻ hay dùng; `undefined` khi không có. */
  readonly location: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

/** Đọc toàn bộ header `Set-Cookie` thô từ `rawHeaders` (giữ từng giá trị riêng). */
function rawSetCookies(rawHeaders: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === 'set-cookie') {
      const value = rawHeaders[i + 1];
      if (typeof value === 'string') {
        out.push(value);
      }
    }
  }
  return out;
}

/**
 * Request thuần một path trên ACCOUNT origin với `ca` scoped.
 *
 * - `method`: mặc định `GET`; `bodyText` kèm `content-type: application/json`
 *   khi truyền (mọi POST của luồng login đều JSON).
 * - `extraHeaders`: cookie (`cookie: …`), CSRF header (`x-ecoma-csrf: …`)…
 * - `redirect: 'manual'` semantics: `node:https` không follow redirect —
 *   caller tự thấy 3xx nguyên văn.
 */
export function stackRequest(
  url: string,
  options: {
    readonly method?: 'GET' | 'POST';
    readonly bodyText?: string;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  } = {},
): Promise<StackResponse> {
  const target = new URL(url);
  const method = options.method ?? 'GET';
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      // `Host` tường minh `hostname:port` — đúng header mà client thật gửi và
      // đúng dạng mà rule `Host(...)` của Traefik nhìn.
      Host: target.host,
      ...options.extraHeaders,
    };
    if (options.bodyText !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(options.bodyText, 'utf8'));
    }
    const request = https.request(
      {
        host: target.hostname,
        port: target.port || '443',
        path: `${target.pathname}${target.search}`,
        method,
        ca: LOCAL_CA_PEM,
        servername: target.hostname,
        headers,
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        const tlsSocket = response.socket instanceof tls.TLSSocket ? response.socket : undefined;
        if (tlsSocket?.authorized !== true) {
          reject(
            new Error(
              `TLS not verified for ${url} — ${
                tlsSocket?.authorizationError?.message ?? 'socket has no verify status'
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
            rawSetCookie: rawSetCookies(response.rawHeaders),
            location: response.headers.location,
            contentType: response.headers['content-type'],
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', (error: Error) => reject(error));
    if (options.bodyText !== undefined) {
      request.write(options.bodyText);
    }
    request.end();
  });
}
