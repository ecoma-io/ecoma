import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Seed DB thật + đọc OTP từ mail sink của stack local — phần fixtures của suite.
 *
 * ## Vì sao suite seed DB trực tiếp
 *
 * Suite kiểm journey portal của developer trong tenant `ecoma` — tenant này do
 * bootstrap thật của deploy dựng (`remote_cache.tenants` + hàng membership của
 * owner). Danh tính fixture KHÔNG có sẵn: seed `account.users` +
 * `email_addresses` (điều kiện OTP login) và `remote_cache.tenant_members`
 * (điều kiện control-plane coi actor là member của `ecoma`). Cả hai là dữ liệu
 * THẬT trong Postgres của stack, không phải fixture UI.
 *
 * ## Truy cập DB qua `docker exec psql`
 *
 * Postgres không publish host port; đường duy nhất từ host là `docker exec`
 * với `-U ecoma_local` (superuser của container). Mọi INSERT dùng
 * `ON CONFLICT DO NOTHING`: rerun và chạy song song của các fixture suite khác
 * là idempotent.
 *
 * ## OTP từ mail sink
 *
 * `account` render OTP và gửi qua transactional-mail; worker mail sink ghi bản
 * đã render vào D1 sqlite trong container `mail-wic` (volume `/state`). File DB
 * được tìm theo ứng dụng chứa bảng `mail_messages`, đọc bằng `node:sqlite`
 * readOnly NGAY TRONG container (bản copy ra host fail read-only vì WAL).
 */

const execFileAsync = promisify(execFile);

/** Chạy một lệnh trong container, trả stdout. Lỗi docker được ném nguyên văn. */
async function dockerExec(container: string, command: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', ['exec', container, ...command]);
  return stdout;
}

// -------------------------------------------------------------------------------------------
// Namespace resolution — map origin sang namespace docker của stack
// -------------------------------------------------------------------------------------------

/**
 * Tên đầy đủ container Postgres của stack mà `origin` đang chạy.
 *
 * Nhiều stack local có thể sống song song (mỗi worktree một namespace), nên
 * phép map là: tìm container traefik CÓ publish port khớp port của origin.
 * Không khớp hoặc khớp nhiều ⇒ fail với danh sách candidate — đoán là đường
 * seed nhầm DB của stack khác.
 */
export async function resolvePostgresContainer(origin: string): Promise<string> {
  const port = new URL(origin).port;
  const { stdout } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], {
    timeout: 10_000,
  });
  const candidates: string[] = [];
  for (const line of stdout.split('\n')) {
    const [name, ports] = line.split('\t');
    if (name === undefined || ports === undefined || !name.includes('traefik')) {
      continue;
    }
    // Cột Ports dạng `80/tcp, 127.0.0.1:32768->443/tcp` — publish có thể bind
    // 127.0.0.1, 0.0.0.0 hoặc `[::]`; match port trước mốc `->443/tcp` (chuỗi
    // tĩnh, không RegExp động từ input không tin cậy).
    if (ports.includes(`:${port}->443`) || ports.includes(`[::]:${port}->443`)) {
      candidates.push(name);
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `no traefik container publishes host port ${port} — the stack behind ${origin} is not running. ` +
        'Start it with `pnpm nx affected -t system-test -c local` first.',
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `host port ${port} is published by ${candidates.length} traefik containers (${candidates.join(', ')}) — ` +
        'cannot determine which namespace to seed. Stop the stale stack and redeploy.',
    );
  }
  const namespace = (candidates[0] ?? '').replace(/^ecoma-(.+)-traefik$/u, '$1');
  return `ecoma-${namespace}-postgres`;
}

/** Tên container `mail-wic` của cùng namespace với container Postgres đã biết. */
export function mailWicContainerOf(postgresContainer: string): string {
  const namespace = postgresContainer.replace(/^ecoma-(.+)-postgres$/u, '$1');
  return `ecoma-${namespace}-mail-wic`;
}

// -------------------------------------------------------------------------------------------
// Account side (db-account): user + email verified — điều kiện để OTP login chạy
// -------------------------------------------------------------------------------------------

/**
 * SHA-256 hex của email đã normalize — cùng phép tính với
 * `emailAddressHash` của `apps/account/server/lib/otp.ts`
 * (`trim().toLowerCase()` rồi SHA-256; KHÔNG phải HMAC).
 */
export function emailAddressHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Seed `account.users` + `account.email_addresses` status `verified`.
 *
 * Đây là trạng thái mà `lookupVerifiedAddress` (`otp.ts`) coi là "địa chỉ có
 * thể đăng nhập" (FR-002). Cột `verified_at` NOT NULL theo CHECK
 * `email_addresses_verified_pair_check` — thiếu là INSERT fail.
 */
export async function seedAccountIdentity(
  postgresContainer: string,
  params: { readonly sub: string; readonly email: string },
): Promise<void> {
  // Xoá challenge OTP của ĐÚNG định danh này trước khi challenge: rate limit
  // của account (3 challenge/15 phút per address) là budget DÍNH LẠI GIỮA CÁC
  // LẦN CHẠY — identity cố định của suite hết budget sau vài lần rerun dày và
  // challenge ngừng cấp mã. Chỉ xoá hàng của hash địa chỉ fixture.
  const resetChallenge = `DELETE FROM account.otp_challenges WHERE address_hash = ${sqlQuote(
    emailAddressHash(params.email),
  )};`;
  const sql = [
    resetChallenge,
    `INSERT INTO account.users (sub) VALUES (${sqlQuote(params.sub)}) ON CONFLICT DO NOTHING;`,
    `INSERT INTO account.email_addresses
       (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
     VALUES (${sqlQuote(params.sub)}, ${sqlQuote(params.email.trim().toLowerCase())}, ${sqlQuote(
       emailAddressHash(params.email),
     )}, 'verified', true, now())
     ON CONFLICT DO NOTHING;`,
  ].join('\n');
  await dockerExec(postgresContainer, [
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    'db-account',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]);
}

// -------------------------------------------------------------------------------------------
// Remote-cache side (db-remote-cache): membership của actor fixture trong tenant `ecoma`
// -------------------------------------------------------------------------------------------

/** Tên tenant first-party mà bootstrap dựng — mọi portal workflow của suite chạy trong tenant này. */
export const TENANT_NAME = 'ecoma';

/**
 * Seed membership `member` cho actor fixture trong `remote_cache.tenant_members`
 * của tenant `ecoma` (tìm theo tên — tenant do bootstrap dựng, id không cố định).
 *
 * ⚠️ CHECK `tenant_members_role_check` chỉ cho phép `member` ở schema này —
 * portal không phân vai, mọi member đều tạo project/key được (R19/R20).
 * `source` không seed (NULL) — cột nullable, không có CHECK nào đòi giá trị.
 */
export async function seedRemoteCacheMembership(
  postgresContainer: string,
  params: { readonly sub: string },
): Promise<void> {
  const sql = [
    `INSERT INTO remote_cache.tenant_members (tenant_id, member_sub, role)
     SELECT t.id, ${sqlQuote(params.sub)}, 'member'
       FROM remote_cache.tenants t
      WHERE t.name = ${sqlQuote(TENANT_NAME)}
     ON CONFLICT (tenant_id, member_sub) DO NOTHING;`,
  ].join('\n');
  await dockerExec(postgresContainer, [
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    'db-remote-cache',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]);
}

/**
 * Seed membership cho actor fixture trong một tenant RIÊNG BIỆT (negative
 * cross-tenant): tenant mới với `owner_sub` khác chủ first-party, classification
 * `customer` + plan `paid` (CHECK đòi customer phải có plan), rồi membership
 * member cho actor. Idempotent theo tên tenant.
 *
 * Actor này KHÔNG phải member của `ecoma` — mọi request portal lên
 * `/tenants/ecoma/...` bằng phiên của nó phải bị từ chối (403), còn tenant của
 * chính nó được resolve riêng. Đây là định nghĩa "người ngoài tenant" mà A32
 * đòi hỏi.
 */
export async function seedSecondTenantMembership(
  postgresContainer: string,
  params: {
    readonly sub: string;
    readonly tenantName: string;
    readonly ownerSub: string;
  },
): Promise<void> {
  const sql = [
    `INSERT INTO remote_cache.tenants (name, owner_sub, classification, plan)
     VALUES (${sqlQuote(params.tenantName)}, ${sqlQuote(params.ownerSub)}, 'customer', 'paid')
     ON CONFLICT (name) DO NOTHING;`,
    `INSERT INTO remote_cache.tenant_members (tenant_id, member_sub, role)
     SELECT t.id, ${sqlQuote(params.sub)}, 'member'
       FROM remote_cache.tenants t
      WHERE t.name = ${sqlQuote(params.tenantName)}
     ON CONFLICT (tenant_id, member_sub) DO NOTHING;`,
  ].join('\n');
  await dockerExec(postgresContainer, [
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    'db-remote-cache',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]);
}

// -------------------------------------------------------------------------------------------
// OTP từ mail sink
// -------------------------------------------------------------------------------------------

/** Khoảng chờ giữa hai lần poll mail sink. */
const OTP_POLL_INTERVAL_MS = 500;
/** Budget poll — TTL OTP là 10 phút, poll suite chỉ cần cửa sổ nhỏ hơn nhiều. */
const OTP_POLL_BUDGET_MS = 30_000;

interface MailRow {
  readonly recipient: string;
  readonly subject_rendered: string;
  readonly body_rendered: string;
}

/**
 * Tìm file sqlite D1 chứa bảng `mail_messages` trong container mail-wic.
 *
 * Volume có NHIỀU file sqlite (mỗi D1 object một file); dùng đúng file của
 * mail DB là bắt buộc — file của job DB không có bảng này.
 */
async function findMailDbPath(mailWicContainer: string): Promise<string> {
  const script = [
    "const fs = require('node:fs');",
    "const { DatabaseSync } = require('node:sqlite');",
    'const found = [];',
    'function walk(dir) {',
    '  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {',
    "    const p = dir + '/' + entry.name;",
    '    if (entry.isDirectory()) { walk(p); continue; }',
    "    if (!entry.name.endsWith('.sqlite')) { continue; }",
    '    try {',
    '      const db = new DatabaseSync(p, { readOnly: true });',
    "      const hit = db.prepare(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_messages'\").get();",
    '      if (hit) { found.push(p); }',
    '      db.close();',
    '    } catch {}',
    '  }',
    '}',
    "walk('/state');",
    'if (found.length !== 1) { throw new Error("expected exactly one mail_messages D1 file, got: " + found.join(", ")); }',
    'console.log(found[0]);',
  ].join('\n');
  const path = (await dockerExec(mailWicContainer, ['node', '-e', script])).trim();
  if (path.length === 0) {
    throw new Error('mail D1 database not found inside the mail-wic container');
  }
  return path;
}

/**
 * Đọc mã OTP 8 chữ số từ mail sink, poll tới khi hàng của `recipient` xuất hiện.
 *
 * Mã nằm trong `body_rendered`/`subject_rendered` (template seed
 * `account.login-otp` là `Your login code {{ code }}`) — regex `\b\d{8}\b`
 * trích từ HTML. Chỉ đọc rows mới hơn `sinceMs` để rerun không nhặt OTP cũ
 * của lần chạy trước (mail sink KHÔNG bị xoá giữa các lần chạy).
 */
export async function readOtpFromMailSink(
  mailWicContainer: string,
  params: { readonly recipient: string; readonly sinceMs: number },
): Promise<string> {
  const dbPath = await findMailDbPath(mailWicContainer);
  const startedAt = Date.now();
  for (;;) {
    const script = [
      "const { DatabaseSync } = require('node:sqlite');",
      `const db = new DatabaseSync(${JSON.stringify(dbPath)}, { readOnly: true });`,
      'const rows = db.prepare(',
      '  "SELECT recipient, subject_rendered, body_rendered FROM mail_messages WHERE template_name=\'account.login-otp\' AND recipient = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1"',
      ').all(' + JSON.stringify(params.recipient) + ', ' + String(params.sinceMs) + ');',
      'for (const row of rows) { console.log(JSON.stringify(row)); }',
      'db.close();',
    ].join('\n');
    const stdout = await dockerExec(mailWicContainer, ['node', '-e', script]);
    const line = stdout
      .trim()
      .split('\n')
      .find((l) => l.length > 0);
    if (line !== undefined) {
      const row = JSON.parse(line) as MailRow;
      const code = /\b(\d{8})\b/u.exec(`${row.subject_rendered} ${row.body_rendered}`)?.[1];
      if (code !== undefined) {
        return code;
      }
      throw new Error(
        `mail sink row found for ${params.recipient} but no 8-digit code extractable from rendered content`,
      );
    }
    if (Date.now() - startedAt > OTP_POLL_BUDGET_MS) {
      throw new Error(
        `no account.login-otp mail for ${params.recipient} within ${OTP_POLL_BUDGET_MS}ms — ` +
          'the account challenge step did not reach the mail sink',
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, OTP_POLL_INTERVAL_MS);
    });
  }
}
