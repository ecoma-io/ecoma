import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Scoped TLS + origin + stack helpers cho các API assertion và seeding của suite.
 *
 * Đây là "phòng hỗ trợ" của CHÍNH suite này (`docs/architecture/06-testing.md` §2:
 * mỗi system-test suite tự sở hữu setup/support của nó) — không có thư viện
 * dùng chung ở root, và không cần: mọi suite hệ thống trỏ cùng một cert local
 * là **hai bản cố ý**, không phải nợ kỹ thuật.
 *
 * Trust là TƯỜNG MINH và scoped: `ca` của riêng request trỏ vào cert đã commit —
 * không đụng trust store toàn cục, không biến môi trường
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
 * Phần seeding/admin KHÔNG phải HTTP: nó chạy `docker exec` vào container của
 * namespace worktree (psql cho `db-account`, wrangler d1 cho mail sink). Đây là
 * cùng đường mà deploy orchestration dùng (`deploys/account-deploy/index.ts`
 * seed qua `docker exec psql`), vì PostgreSQL không publish host port và mail
 * sink là D1 sqlite bên trong volume container. Namespace được SUITE TỰ DÒ qua
 * `docker ps` (match port Traefik với port trong `ROOT_DOMAIN`) — suite không
 * phụ thuộc `@node-rs/xxhash` để tính lại namespace từ path.
 *
 * ⚠️ Hợp đồng bí mật: helper này đọc `NUXT_OTP_HMAC_SECRET` từ container
 * `account` CHỈ để tính `code_digest` cho assertion verify OTP — không bao giờ
 * log, không bao giờ đưa vào assertion message, không bao giờ ghi ra file. Mọi
 * giá trị handle/cookie/token đi qua đây cũng chỉ sống trong biến của test.
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

/** Pem cert local cho các request https của Node — dùng `ca: LOCAL_CA_PEM`. */

/**
 * Origin gốc của stack local, dạng `https://<host>:<port>` — đọc `ROOT_DOMAIN`
 * trước rồi `ROOT_HOST`. Khi chạy qua Nx, `.env` repo root đã nằm trong env
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

/** Hostname gốc (không scheme, không port) — gốc để ghép subdomain. */
export function resolveRootHostname(): string {
  return resolveStackOrigin()
    .replace(/^https:\/\//u, '')
    .split(':')[0];
}

/** Port Traefik public (chuỗi số) — từ origin đã resolve. */
export function resolveTraefikPort(): string {
  return (
    resolveStackOrigin()
      .replace(/^https:\/\//u, '')
      .split(':')[1] ?? '443'
  );
}

/** Origin của service `auth` — mọi URL protocol của suite quy về đây. */
export function authOrigin(): string {
  return `https://auth.${resolveRootHostname()}:${resolveTraefikPort()}`;
}

/** Origin của service `account` — UI login/consent. */
export function accountOrigin(): string {
  return `https://account.${resolveRootHostname()}:${resolveTraefikPort()}`;
}

/** Audience mặc định (primary resource indicator) — `https://api.<root>:<port>`. */
export function primaryAudience(): string {
  return `https://api.${resolveRootHostname()}:${resolveTraefikPort()}`;
}

/** Client OIDC local duy nhất được seed bởi deploy (backoffice). */
export const LOCAL_CLIENT_ID = 'ecoma-backoffice-local';

/**
 * Callback URI của client local — seed exact-string theo port Traefik hiện hành
 * (`deploys/auth-deploy/index.ts`). Một port đổi là URI seed khác; suite ghép
 * từ cùng nguồn chân lý (port trong ROOT_DOMAIN) thay vì hardcode.
 */
export function localRedirectUri(): string {
  return `https://office.${resolveRootHostname()}:${resolveTraefikPort()}/api/auth/callback`;
}

// ---------------------------------------------------------------------------
// HTTP qua node:https với TLS scoped
// ---------------------------------------------------------------------------

interface StackResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
  readonly setCookie: readonly string[];
}

/**
 * GET một URL tuyệt đối trên stack với `ca` scoped. `redirect: 'manual'` đúng
 * nghĩa: không theo redirect nào, trả nguyên response để test tự assert từng
 * nhảy (redirect chain CHÍNH là đối tượng kiểm của suite này).
 */
export function stackGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<StackResponse> {
  return stackRequest('GET', url, headers, undefined);
}

/**
 * POST form-urlencoded — hình dạng của `/token` và `/revocation`. Body được
 * encode từ object (giá trị không bao giờ chứa secret của hệ thống; giá trị do
 * test sinh ra như code/verifier/refresh token chỉ sống trong biến).
 */
export function stackPostForm(
  url: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<StackResponse> {
  const body = new URLSearchParams(params).toString();
  return stackRequest(
    'POST',
    url,
    {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body,
  );
}

function stackRequest(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<StackResponse> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: target.hostname,
        port: target.port || '443',
        path: `${target.pathname}${target.search}`,
        method,
        ca: LOCAL_CA_PEM,
        servername: target.hostname,
        headers: {
          // `Host` tường minh `hostname:port` — đúng header mà client thật gửi
          // và đúng dạng mà rule `Host(...)` của Traefik nhìn.
          Host: target.host,
          ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
          ...headers,
        },
        signal: AbortSignal.timeout(15_000),
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
          const rawSetCookie = response.headers['set-cookie'] ?? [];
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            contentType: response.headers['content-type'],
            body: Buffer.concat(chunks).toString('utf8'),
            setCookie: rawSetCookie,
          });
        });
      },
    );
    request.on('error', (error: Error) => reject(error));
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Test subject + PKCE helpers
// ---------------------------------------------------------------------------

/**
 * `sub` test đúng invariant domain (`libs/account-domain/src/subject.ts`):
 * `sub_` + 32 ký tự base32 viết thường (a-z, 2-7) — format mà
 * `GET /internal/account/status` xác thực trước khi trả trạng thái. Một `sub`
 * lệch format không bao giờ tới nổi "not_found": handler trả 400, và phía
 * `auth` fail-closed 503 cả luồng handoff (đã xảy ra thật với `sub-oidc-*`).
 * Entropy: timestamp base36 + random bytes nén về đúng 32 ký tự alphabet.
 */
export function makeTestSubject(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const raw = `${Date.now().toString(36)}${randomBytes(12).toString('hex')}`;
  let suffix = '';
  for (let index = 0; index < raw.length && suffix.length < 32; index += 1) {
    const digit = parseInt(raw[index] ?? '0', 36);
    if (!Number.isNaN(digit)) {
      suffix += alphabet[digit % alphabet.length];
    }
  }
  while (suffix.length < 32) {
    suffix += 'a';
  }
  return `sub_${suffix}`;
}

/** Verifier 43 base64url ký tự (32 random bytes) — đúng ràng buộc RFC 7636. */
export function makePkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** Challenge S256 từ verifier — base64url(SHA-256(verifier ASCII)). */
export function makePkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

// ---------------------------------------------------------------------------
// Namespace + docker exec helpers (seeding / mail sink)
// ---------------------------------------------------------------------------

/**
 * Namespace Docker của worktree hiện tại — dò bằng `docker ps`: container
 * `ecoma-<ns>-traefik` có published port BẰNG port trong ROOT_DOMAIN. Đây là
 * fingerprint đủ chắc: hai worktree không bao giờ trùng published port, và port
 * trong `.env` chính là port suite sẽ gọi. Trả về undefined khi không thấy —
 * test gọi helper seeding sẽ fail với message remedy thay vì đoán tên container.
 */
export function discoverNamespace(): string | undefined {
  const port = resolveTraefikPort();
  let stdout: string;
  try {
    stdout = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch {
    return undefined;
  }
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^ecoma-([a-z0-9_-]+)-traefik\t(.*)$/u.exec(line.trim());
    if (match === null) {
      continue;
    }
    // Docker in `127.0.0.1:33118->443/tcp` — match port public Traefik.
    if (new RegExp(`[::]:${port}->443`, 'u').test(match[2]) || match[2].includes(`:${port}->443`)) {
      return match[1];
    }
  }
  return undefined;
}

// `requireNamespace` sống trong từng spec file (mỗi file gọi trước khi seed);
// support chỉ cung cấp `discoverNamespace` để message lỗi của spec nêu remedy
// đúng tại chỗ nó thất bại.

/** `docker exec` với argv array — không shell interpolation trên input của test. */
function dockerExec(container: string, argv: readonly string[], timeoutMs = 30_000): string {
  return execFileSync('docker', ['exec', container, ...argv], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

/** Container PostgreSQL của namespace. */
function postgresContainer(namespace: string): string {
  return `ecoma-${namespace}-postgres`;
}

/** Container WIC mail (control plane + mailer-job, D1 sink trong /state). */
function mailContainer(namespace: string): string {
  return `ecoma-${namespace}-mail-wic`;
}

/**
 * Escape nháy đơn cho một giá trị trong SQL literal (`''`) — inputs đều do
 * test sinh ra với format chặt (sub `sub_<32 base32>`, hash hex 64), nhưng
 * escape vẫn là mặc định đúng: SQL không bao giờ nội suy giá trị bằng nháy
 * đơn trần.
 */
function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Đảm bảo user test tồn tại trong `db-account`: `INSERT ... ON CONFLICT DO
 * NOTHING` cho `account.users` + `account.email_addresses` với `status
 * 'verified'`. Hình dạng cột theo migration thật (`0001_identity_core.sql`,
 * `0005_email_addresses.sql`): `address_hash` là SHA-256 hex của
 * `address_normalized` (trim + lowercase) — parity với `emailAddressHash`
 * của `apps/account/server/lib/otp.ts` (KHÔNG phải HMAC).
 *
 * Idempotent theo `sub`/`address_hash`: chạy lại là no-op.
 */
export function seedUser(namespace: string, sub: string, email: string): void {
  const normalized = email.trim().toLowerCase();
  const addressHash = createHash('sha256').update(normalized, 'utf8').digest('hex');
  const container = postgresContainer(namespace);
  // Trust auth trong container postgres (`-U ecoma_local` superuser của platform)
  // — cùng đường seed của `deploys/account-deploy/index.ts`; role runtime không
  // kết nối được qua TCP từ host vì database không publish port.
  // Conflict target là PARTIAL unique index `(address_hash) WHERE status =
  // 'verified'` (`0005_email_addresses.sql:82`) — Postgres đòi mệnh đề WHERE
  // khớp exact khi dùng index làm arbiter; `(user_sub, address_hash)` không
  // khớp constraint nào và fail lần chạy thứ hai.
  dockerExec(container, [
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    'db-account',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `INSERT INTO account.users (sub) VALUES (${sqlQuote(sub)}) ON CONFLICT (sub) DO NOTHING`,
    '-c',
    `INSERT INTO account.email_addresses (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
     VALUES (${sqlQuote(sub)}, ${sqlQuote(normalized)}, ${sqlQuote(addressHash)}, 'verified', true, now())
     ON CONFLICT (address_hash) WHERE (status = 'verified') DO UPDATE SET status = 'verified', verified_at = now()`,
  ]);
}

// ---------------------------------------------------------------------------
// Mail sink (D1 của transactional-mail trong WIC container)
// ---------------------------------------------------------------------------

interface MailRow {
  readonly template_name: string;
  readonly subject_rendered: string;
  readonly body_rendered: string;
  readonly recipient: string;
  readonly created_at: number;
}

/**
 * Chạy một câu SQL đọc-only trên D1 `mail` bên trong WIC container.
 *
 * Wrangler dev của control plane chạy với `--persist-to /state` và runtime tree
 * mirror tại `/state/runtime/apps/transactional-mail` (`wic-entrypoint.sh`) —
 * gọi wrangler với ĐÚNG config + persist dir đó là trúng đúng D1 instance đang
 * sống của worker. Chỉ SELECT: suite không bao giờ mutate mail sink.
 */
function runMailD1Select(namespace: string, sql: string): readonly MailRow[] {
  const configPath = '/state/runtime/apps/transactional-mail/wrangler.jsonc';
  const stdout = dockerExec(
    mailContainer(namespace),
    [
      'sh',
      '-c',
      `cd /state/runtime/apps/transactional-mail && /repo/node_modules/.bin/wrangler d1 execute mail ` +
        `--local --persist-to /state --config ${configPath} --command ${shellSingleQuote(sql)} --json 2>/dev/null`,
    ],
    60_000,
  );
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('wrangler d1 execute returned a non-array payload');
  }
  const results = (parsed[0] as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(results)) {
    throw new Error('wrangler d1 execute returned no results array');
  }
  return results as readonly MailRow[];
}

/** Quote một chuỗi cho shell single-quoted (mọi `'` thành `'\''`). */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface OtpMail {
  readonly code: string;
  readonly createdAt: number;
}

/**
 * Poll mail sink cho mail OTP login của một địa chỉ, render sau `sinceEpochMs`.
 *
 * Mail đến theo đường: account `POST /v1/messages` (HMAC) → control plane
 * render NGAY LÚC ACCEPT và insert `mail_messages` với `body_rendered` — việc
 * đọc sink không phải chờ cron publish/consume (cron chỉ là đường
 * outbox→provider thật; sink đã chứa nội dung từ thời điểm accept). TTL poll
 * mặc định 30s là đủ cho HTTP path; lỗi tạm thời của wrangler (SQLite busy ở
 * cửa sổ boot) được nuốt và thử lại trong budget.
 *
 * Trích mã bằng regex `\b\d{8}\b` từ body đã render — template
 * `account.login-otp` render `{ code }` vào câu duy nhất chứa mã
 * (`apps/transactional-mail/migrations/0009_mail_templates_seed.sql`).
 */
export async function pollOtpMail(
  namespace: string,
  recipient: string,
  sinceEpochMs: number,
  options: { readonly budgetMs?: number } = {},
): Promise<OtpMail> {
  const budgetMs = options.budgetMs ?? 30_000;
  const normalized = recipient.trim().toLowerCase();
  const startedAt = Date.now();
  let lastError: Error | undefined;
  for (;;) {
    try {
      const rows = runMailD1Select(
        namespace,
        `SELECT template_name, subject_rendered, body_rendered, recipient, created_at ` +
          `FROM mail_messages WHERE template_name = 'account.login-otp' ` +
          `ORDER BY created_at DESC LIMIT 10`,
      );
      for (const row of rows) {
        if (row.recipient.toLowerCase() !== normalized) {
          continue;
        }
        if (row.created_at < sinceEpochMs) {
          continue;
        }
        const match = /\b(\d{8})\b/u.exec(row.body_rendered);
        if (match !== null) {
          return { code: match[1], createdAt: row.created_at };
        }
      }
      lastError = new Error(
        `no OTP mail for the recipient rendered after ${sinceEpochMs} yet (${rows.length} recent rows scanned)`,
      );
    } catch (error) {
      // Lỗi wrangler thoáng qua (boot window, SQLite lock) — thử lại trong budget.
      lastError = error as Error;
    }
    if (Date.now() - startedAt >= budgetMs) {
      throw new Error(
        `OTP mail did not appear within ${budgetMs}ms — last sink error: ${lastError?.message ?? 'unknown'}`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
}

/**
 * Trích giá trị cookie có tên cho trước từ danh sách Set-Cookie (chỉ phần
 * name=value — attributes như Path/Secure không cần cho replay header).
 */
export function cookieFrom(setCookie: readonly string[], name: string): string | undefined {
  for (const header of setCookie) {
    const first = header.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq > 0 && first.slice(0, eq).trim() === name) {
      return first.slice(eq + 1).trim();
    }
  }
  return undefined;
}
