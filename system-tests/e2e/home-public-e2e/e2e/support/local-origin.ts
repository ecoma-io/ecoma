import { readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Scoped TLS + origin cho các API assertion của suite.
 *
 * Đây là "phòng hỗ trợ" của CHÍNH suite này (`docs/architecture/06-testing.md` §2:
 * mỗi system-test suite tự sở hữu setup/support của nó) — không có thư viện
 * dùng chung ở root, và không cần: mọi suite hệ thống trỏ cùng một cert local
 * là **hai bản cố ý**, không phải nợ kỹ thuật.
 *
 * Trust là TƯỜNG MINH và scoped: `ca` của riêng agent HTTPS trỏ vào cert đã
 * commit — không đụng trust store toàn cục, không biến môi trường
 * NODE_TLS_REJECT_UNAUTHORIZED nào bị đặt. Sau response, INVARIANT là khẳng
 * định `socket.authorized === true` (`local-smoke.mjs`): "request thành công"
 * chưa đủ, TLS phải được verify thật sự — nếu sau này ai thêm
 * `rejectUnauthorized: false` để "cho suite chạy được" thì assertion ở đây
 * làm test ĐỎ ngay, thay vì im lặng bỏ qua đúng thứ nó sinh ra để kiểm.
 *
 * ⚠️ Node `https` thay vì global `fetch`: `fetch` của Node (undici) không nhận
 * `node:https.Agent` làm `dispatcher` (đã thử thật — request fail im lặng),
 * còn `undici.Agent` thì không phải dependency của workspace.
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
 * Origin gốc của stack local, dạng `https://<host>:<port>` — đọc `ROOT_DOMAIN`
 * trước rồi `ROOT_HOST` (#353 giới thiệu key; suite fallback `ROOT_HOST` cho
 * worktree chưa redeploy). Khi chạy qua Nx, `.env` repo root đã nằm trong env
 * của task; chạy `npx playwright test` trực tiếp thì fallback parse `.env`.
 */
export function resolveStackOrigin(): string {
  const fromEnv = process.env.ROOT_DOMAIN ?? process.env.ROOT_HOST;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return withPort(fromEnv.trim());
  }
  try {
    const text = readFileSync(join(SUITE_DIR, '../../../../../.env'), 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const match = /^ROOT_(?:DOMAIN|HOST)=(.*)$/u.exec(line.trim());
      if (match && match[1].trim().length > 0) {
        return withPort(match[1].trim());
      }
    }
  } catch {
    // `.env` vắng mặt — throw bên dưới với message nêu đúng remedy.
  }
  throw new Error(
    'ROOT_DOMAIN (or ROOT_HOST) is not set and no .env file defines it. ' +
      'Deploy the local stack first (Nx provisions the `local-up` prerequisites) — deploying writes the dynamic Traefik host:port into the repo-root .env.',
  );
}

function withPort(raw: string): string {
  const hostname = raw.split(':')[0];
  const port = raw.includes(':') ? raw.split(':')[1] : '443';
  return `https://${hostname}:${port}`;
}

/**
 * GET một path trên stack với `Accept` và `ca` scoped, `redirect: 'manual'`.
 * Trả về status, headers và toàn bộ body — đủ cho mọi assertion status/redirect
 * của suite mà không cần browser.
 */
export function stackGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | undefined>; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        host: target.hostname,
        port: target.port || '443',
        path: `${target.pathname}${target.search}`,
        ca: LOCAL_CA_PEM,
        servername: target.hostname,
        headers: {
          // `Host` tường minh `hostname:port` — đúng header mà client thật gửi
          // và đúng dạng `ROOT_HOST` mà rule `Host(...)` của Traefik nhìn.
          Host: target.host,
          ...headers,
        },
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        if (response.socket?.authorized !== true) {
          reject(
            new Error(
              `TLS not verified for ${url} — ${
                response.socket?.authorizationError?.message ?? 'socket has no verify status'
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
            },
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', (error: Error) => reject(error));
  });
}
