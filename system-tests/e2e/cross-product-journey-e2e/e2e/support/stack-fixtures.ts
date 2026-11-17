import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { traefikNamespaceOrNull } from './stack-env';

/**
 * Seed DB thật + đọc OTP từ mail sink của stack local — phần fixtures của suite.
 *
 * Suite chỉ seed DỮ LIỆU FIXTURE của chính nó (định danh test, membership,
 * tenant isolation thứ hai) — LỚP FIRST-PARTY (tenant `ecoma`, superadmin
 * Backoffice, trusted-CI key Remote Cache, consumer key llm-api) đến từ
 * bootstrap thật của `local-up`; suite đọc, không tái tạo.
 *
 * ## Truy cập DB qua `docker exec psql`
 *
 * Postgres không publish host port; đường duy nhất từ host là `docker exec`
 * với `-U ecoma_local` (superuser của container). Mọi INSERT dùng
 * `ON CONFLICT DO NOTHING`: rerun và chạy song song của các fixture suite khác
 * là idempotent. Credential machine (nếu seed) CHỈ hash — plaintext không bao
 * giờ nằm DB.
 *
 * ## OTP từ mail sink
 *
 * `account` render OTP và gửi qua transactional-mail; worker mail sink ghi bản
 * đã render vào D1 sqlite trong container `mail-wic`. Đọc bằng `node:sqlite`
 * readOnly NGAY TRONG container (bản copy ra host fail read-only vì WAL).
 */

const execFileAsync = promisify(execFile);

/** Chạy một lệnh trong container, trả stdout. Lỗi docker được ném nguyên văn. */
async function dockerExec(container: string, command: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', ['exec', container, ...command], {
    // Daemon treo / container chết không được giữ worker Playwright vô hạn.
    timeout: 30_000,
  });
  return stdout;
}

// -------------------------------------------------------------------------------------------
// Namespace resolution — map origin sang namespace docker của stack
// -------------------------------------------------------------------------------------------

/**
 * Tên đầy đủ container Postgres của stack mà `origin` đang chạy.
 *
 * Phép map: tìm container traefik CÓ publish port khớp port của origin —
 * qua `traefikNamespaceOrNull` của `stack-env` (một bản duy nhất trong suite).
 * Không khớp ⇒ fail với detail — đoán là đường seed nhầm DB của stack khác.
 */
export async function resolvePostgresContainer(origin: string): Promise<string> {
  const port = new URL(origin).port;
  const { namespace, failureDetail } = traefikNamespaceOrNull(port);
  if (namespace === undefined) {
    throw new Error(
      `no traefik container publishes host port ${port} (${failureDetail}) — ` +
        `the stack behind ${origin} is not running. ` +
        'Start it with `pnpm nx affected -t system-test -c local` first.',
    );
  }
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
 * `emailAddressHash` của `apps/account/server/lib/otp.ts`.
 */
export function emailAddressHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Seed `account.users` + `account.email_addresses` status `verified` — trạng
 * thái mà `lookupVerifiedAddress` coi là "địa chỉ có thể đăng nhập".
 * Xoá challenge OTP của ĐÚNG định danh này trước khi challenge: rate limit
 * (3 challenge/15 phút per address) là budget DÍNH LẠI GIỮA CÁC LẦN CHẠY.
 */
export async function seedAccountIdentity(
  postgresContainer: string,
  params: { readonly sub: string; readonly email: string },
): Promise<void> {
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
// Remote-cache side (db-remote-cache): membership của actor fixture
// -------------------------------------------------------------------------------------------

/** Tên tenant first-party mà bootstrap dựng — journey chạy trong tenant này. */
export const TENANT_NAME = 'ecoma';

/**
 * Seed membership `member` cho actor fixture trong `remote_cache.tenant_members`
 * của tenant `ecoma` (tìm theo tên — tenant do bootstrap dựng, id không cố định).
 * CHECK `tenant_members_role_check` chỉ cho phép `member` ở schema này.
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

// -------------------------------------------------------------------------------------------
// Pact side (db-pact-broker): membership admin của actor fixture
// -------------------------------------------------------------------------------------------

/**
 * Seed membership `admin` cho actor fixture trong `pact.tenant_members` của
 * tenant `ecoma`. Role `admin` là BẮT BUỘC: purpose `ci` của machine credential
 * chỉ admin tạo được (ma trận ADR-0032, `checkCreate` của admin.ts).
 */
export async function seedPactAdminMembership(
  postgresContainer: string,
  params: { readonly sub: string },
): Promise<void> {
  const sql = [
    `INSERT INTO pact.tenant_members (tenant_id, sub, role, source)
     SELECT t.id, ${sqlQuote(params.sub)}, 'admin', 'admin'
       FROM pact.tenants t
      WHERE t.name = ${sqlQuote(TENANT_NAME)}
     ON CONFLICT (tenant_id, sub) DO NOTHING;`,
  ].join('\n');
  await dockerExec(postgresContainer, [
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    'db-pact-broker',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]);
}

// -------------------------------------------------------------------------------------------
// Tenant isolation thứ hai — MỘT tenant B phục vụ CẢ Remote Cache lẫn Pact
// -------------------------------------------------------------------------------------------

/** Tên tenant thứ hai dùng cho negative isolation — phải KHÁC `ecoma` (UNIQUE tên). */
export const SECOND_TENANT_NAME = 'cross-journey-outsider';
/**
 * Owner giả của tenant thứ hai — KHÔNG trùng sub của bất kỳ identity nào của
 * suite và KHÁCH chủ first-party (partial unique slot Free theo `owner_sub`).
 */
export const SECOND_TENANT_OWNER_SUB = 'sub_cross_journey_outsider_owner_0000000000000000';

/**
 * Seed MỘT tenant `customer`/`paid` với `owner_sub` riêng + membership admin
 * cho actor, TRÊN CẢ HAI schema `remote_cache` và `pact` (idempotent theo tên
 * tenant ở mỗi DB). Actor này KHÔNG phải member của `ecoma` — credential của
 * nó không đọc/ghi được tài nguyên của `ecoma` và ngược lại (isolation hai
 * chiều A32/PB-9).
 */
export async function seedSecondTenantMemberships(
  postgresContainer: string,
  params: { readonly sub: string },
): Promise<void> {
  const remoteCacheSql = [
    `INSERT INTO remote_cache.tenants (name, owner_sub, classification, plan)
     VALUES (${sqlQuote(SECOND_TENANT_NAME)}, ${sqlQuote(SECOND_TENANT_OWNER_SUB)}, 'customer', 'paid')
     ON CONFLICT (name) DO NOTHING;`,
    `INSERT INTO remote_cache.tenant_members (tenant_id, member_sub, role)
     SELECT t.id, ${sqlQuote(params.sub)}, 'member'
       FROM remote_cache.tenants t
      WHERE t.name = ${sqlQuote(SECOND_TENANT_NAME)}
     ON CONFLICT (tenant_id, member_sub) DO NOTHING;`,
  ].join('\n');
  const pactSql = [
    `INSERT INTO pact.tenants (name, owner_sub, classification, plan)
     VALUES (${sqlQuote(SECOND_TENANT_NAME)}, ${sqlQuote(SECOND_TENANT_OWNER_SUB)}, 'customer', 'paid')
     ON CONFLICT (name) DO NOTHING;`,
    `INSERT INTO pact.tenant_members (tenant_id, sub, role, source)
     SELECT t.id, ${sqlQuote(params.sub)}, 'admin', 'admin'
       FROM pact.tenants t
      WHERE t.name = ${sqlQuote(SECOND_TENANT_NAME)}
     ON CONFLICT (tenant_id, sub) DO NOTHING;`,
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
    remoteCacheSql,
  ]);
  await dockerExec(postgresContainer, [
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    'db-pact-broker',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    pactSql,
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
 * Chỉ đọc rows mới hơn `sinceMs` để rerun không nhặt OTP cũ.
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
