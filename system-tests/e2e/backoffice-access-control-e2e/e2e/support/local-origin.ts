import { readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Scoped TLS + origin + POST cho các API assertion của suite.
 *
 * Đây là "phòng hỗ trợ" của CHÍNH suite này (`docs/architecture/06-testing.md` §2:
 * mỗi system-test suite tự sở hữu setup/support của nó) — hai bản cố ý với
 * `home-public-e2e`, không phải nợ kỹ thuật. Suite này thêm hai năng lực mà
 * suite public home không cần: POST (form-urlencoded cho token endpoint giả
 * lập không cần — mọi POST của suite đi tới BFF APIs với JSON body) và
 * **cookie jar** tối thiểu (session + CSRF) cho các assertion level API đi
 * sau login.
 *
 * Trust là TƯỜNG MINH và scoped: `ca` của riêng agent HTTPS trỏ vào cert đã
 * commit — không đụng trust store toàn cục, không biến môi trường
 * NODE_TLS_REJECT_UNAUTHORIZED nào bị đặt. Sau response, INVARIANT là khẳng
 * định `socket.authorized === true`: "request thành công" chưa đủ, TLS phải
 * được verify thật sự.
 *
 * ⚠️ Node `https` thay vì global `fetch`: `fetch` của Node (undici) không nhận
 * `node:https.Agent` làm `dispatcher` (đã thử thật — request fail im lặng),
 * còn `undici.Agent` thì không phải dependency của workspace.
 */

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

// File này nằm ở `e2e/support/` — NĂM mức `../` về repo root (support → e2e →
// suite → category → system-tests → root). Sai một mức là ENOENT ngay lúc
// module load — mức này được ghi ra vì skeleton `home-public-e2e` đã gặp thật
// với cả bốn lẫn năm mức.
const LOCAL_CERT_PATH = join(
  SUITE_DIR,
  '../../../../../deploys/platform-deploy/local-certs/fbi.com.crt',
);

export const LOCAL_CA_PEM = readFileSync(LOCAL_CERT_PATH, 'utf8');

/**
 * Origin backoffice của stack local — `https://office.<root>:<port>`.
 *
 * `ROOT_DOMAIN`/`ROOT_HOST` là HOSTNAME GỐC của stack (dạng `hostname:port`) —
 * hợp đồng chung của mọi system suite (#392): `home-public-e2e` dùng nguyên
 * hostname gốc, còn `identity-login-e2e`/`identity-oidc-e2e` tự ghép subdomain
 * (`account.`, `auth.`); suite này ghép `office.` vì router Traefik của
 * backoffice match `Host(office.<root>)`. Giá trị raw KHÔNG bao giờ được dùng
 * làm origin — đó là hostname gốc, không router nào serve nó cho backoffice.
 * (`login-kickoff.spec.ts` ghép tiếp `auth.` từ hostname `office.` đã có —
 * cùng hình dạng suy diễn của `identity-oidc-e2e`.)
 *
 * Khi chạy qua Nx, `.env` repo root đã nằm trong env của task; chạy
 * `npx playwright test` trực tiếp thì fallback parse `.env`.
 */
export function resolveStackOrigin(): string {
  const fromEnv = process.env.ROOT_DOMAIN ?? process.env.ROOT_HOST;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return officeOrigin(fromEnv.trim());
  }
  try {
    const text = readFileSync(join(SUITE_DIR, '../../../../../.env'), 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const match = /^ROOT_(?:DOMAIN|HOST)=(.*)$/u.exec(line.trim());
      if (match && match[1].trim().length > 0) {
        return officeOrigin(match[1].trim());
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

/** Ghép hostname gốc (dạng `hostname:port`) thành origin `office.` của backoffice. */
function officeOrigin(raw: string): string {
  const hostname = raw.split(':')[0];
  const port = raw.includes(':') ? raw.split(':')[1] : '443';
  return `https://office.${hostname}:${port}`;
}

/** Headers + body thô của một response — đủ cho mọi assertion của suite. */
export interface StackResponse {
  readonly status: number;
  readonly headers: Record<string, string | undefined>;
  readonly body: string;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Record<string, string>;
  /** Body đã encode — caller tự chọn form hay JSON và tự set content-type. */
  readonly body?: string;
}

/**
 * Request một path trên stack với `ca` scoped và `redirect` KHÔNG được theo —
 * suite assert trên từng redirect (login kickoff 302 → auth, callback 302 → `/`),
 * theo tự động là giấu đúng phần protocol mà suite sinh ra để kiểm.
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
        ca: LOCAL_CA_PEM,
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

/** GET một path trên stack — shape cũ của skeleton, giữ cho test đọc. */
export function stackGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<StackResponse> {
  return stackRequest(url, { method: 'GET', headers });
}

/**
 * Cookie jar tối thiểu — đủ cho luồng BFF của suite: đọc `Set-Cookie` từ
 * response login/callback, gửi lại trên request kế tiếp. KHÔNG phải một
 * cookie engine: không expiry, không path matching (suite chỉ nói chuyện với
 * một origin), không tách `__Host-` semantics — các bất biến đó được assert
 * tường minh trong test, không được engine nuốt.
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

  /** Xoá một cookie theo tên — đường test "cookie cũ sau logout". */
  delete(name: string): void {
    this.cookieMap.delete(name);
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
