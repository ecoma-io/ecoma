/**
 * `node db/bootstrap-oauth-clients.mts` — bootstrap OAuth client public của
 * backoffice trong `db-auth` — bước 7 của bảng §3.2 (`02-delivery.md`), bề mặt
 * (b) của hợp đồng bootstrap/seed: CLI offline của chính service sở hữu dữ liệu
 * ([ADR-0020](../../../docs/domains/staff-access/adr/0020-bootstrap-seed-contract.md)
 * Quyết định 3; đặc tả dữ liệu ở `docs/applications/auth/03-operations.md` §3.2b).
 *
 * ## Bề mặt offline, không phải serving path
 *
 * Script chạy bằng credential **migrator** của `db-auth` trên CI runner hoặc
 * ops box, không bao giờ chạy từ Worker — không route, không flag, không code
 * path nào trong bundle của Worker import file này. Chỉ DML trên natural key,
 * không advisory lock: PK `client_id` và PK `(client_id, redirect_uri)` bảo vệ
 * mọi mục tiêu ghi, nên hai lần chạy đồng thời hội tụ bằng `ON CONFLICT` (cùng
 * học thuyết với `bootstrap-tenant.mts` của `remote-cache`).
 *
 * ## Inventory — một bản ghi bootstrap duy nhất, danh tính qua env
 *
 * `auth` có đúng **một** bản ghi thuộc lớp bootstrap: client public của
 * backoffice (§3.2b). `client_id`, tên hiển thị, tập scope ceiling và tập
 * redirect URI là **input seed của environment** (ADR-0020 Quyết định 9:
 * redirect URI/credential/tên client đổi theo environment, danh tính canonical
 * thì không) — đọc từ env, fail-closed khi thiếu; không giá trị mặc định ngầm,
 * không client nào được bịa trong code. Client là `public` (PKCE S256 do
 * `toProviderClientMetadata` ghim cho mọi client load từ db): **không có
 * secret nào** đi qua script này.
 *
 * ## Idempotency và verify (§3.2b, đúng hai câu INSERT riêng biệt)
 *
 * 1. `INSERT INTO auth.oauth_clients … ON CONFLICT (client_id) DO UPDATE SET
 *    allowed_scopes = EXCLUDED.allowed_scopes` — cập nhật lại scope ceiling
 *    khi nó đổi giữa các lần deploy; **các cột khác của hàng đã có giữ nguyên**
 *    (tên hiển thị, `status`, `created_at` không bị ghi đè).
 * 2. `INSERT INTO auth.client_redirect_uris … ON CONFLICT DO NOTHING` — thêm
 *    URI mới; URI đã gỡ **không** bị xoá bởi bước này. Vì vậy verify đọc lại
 *    **đúng tập** URI kỳ vọng so khớp exact string (FR-002): URI stored nào
 *    không còn trong cấu hình là fail-closed — gỡ URI cũ là hành động
 *    forward-fix của operator, bootstrap không tự xoá gì.
 *
 * Trạng thái lệch (`status = 'disabled'`, `client_type = 'confidential'`, hàng
 * public mang secret hash) là quyết định của operator: lần chạy fail-closed
 * trước khi ghi bất kỳ gì, không bao giờ hồi sinh (Quyết định 6 của ADR-0020).
 *
 * ## Secrets
 *
 * Không có credential nào ngoài `DATABASE_URL` (migrator; password nằm trong
 * connection string, không bao giờ qua argv). Client public không secret; mọi
 * thông báo lỗi chỉ nói tên biến env thiếu, không bao giờ nội suy giá trị.
 * Script tự assert `current_database()` đúng là `db-auth` — trỏ nhầm database
 * là chết ngay trước khi một query bootstrap nào chạm đích.
 */

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/** Tên database mà service này sở hữu — hợp đồng sở hữu dữ liệu của auth. */
export const AUTH_DATABASE = 'db-auth';

/** Biến môi trường chứa `client_id` của client backoffice. Bắt buộc. */
export const BOOTSTRAP_CLIENT_ID_ENV = 'AUTH_BOOTSTRAP_CLIENT_ID';

/** Biến môi trường chứa tên hiển thị của client. Bắt buộc. */
export const BOOTSTRAP_CLIENT_NAME_ENV = 'AUTH_BOOTSTRAP_CLIENT_NAME';

/**
 * Biến môi trường chứa scope ceiling — danh sách cách nhau bởi khoảng trắng.
 * Bắt buộc: seed không có mặc định ngầm (`openid offline_access` của lane
 * local là giá trị cấu hình của lane đó, không phải mặc định của script).
 */
export const BOOTSTRAP_ALLOWED_SCOPES_ENV = 'AUTH_BOOTSTRAP_ALLOWED_SCOPES';

/**
 * Biến môi trường chứa tập redirect URI kỳ vọng — exact string, cách nhau bởi
 * khoảng trắng. Bắt buộc: URI là output của environment (`-cand` host của
 * staging, port động của local), script không tự dựng từ hostname nào.
 */
export const BOOTSTRAP_REDIRECT_URIS_ENV = 'AUTH_BOOTSTRAP_REDIRECT_URIS';

/** Đầu vào của một lần bootstrap, được CLI (hoặc test) giải từ env. */
export interface BootstrapOAuthClientInput {
  /** Natural key `client_id` của client backoffice trong environment này. */
  readonly clientId: string;
  /** Tên hiển thị — chỉ ghi lúc tạo hàng mới, hàng đã có giữ nguyên tên. */
  readonly clientName: string;
  /** Scope ceiling — được refresh lại trên hàng đã có (§3.2b mệnh đề 1). */
  readonly allowedScopes: readonly string[];
  /** Tập redirect URI kỳ vọng — so khớp exact string lúc verify. */
  readonly redirectUris: readonly string[];
}

/** Kết quả một lần bootstrap — CLI in ra, test assert. */
export interface BootstrapOAuthClientResult {
  /** Client đã tồn tại trước khi chạy (`true` = nhánh no-op về hàng client). */
  readonly alreadyExisted: boolean;
  /** `client_id` — hằng của lần chạy, trả về để test assert. */
  readonly clientId: string;
  /** Scope ceiling của hàng đã có đã được refresh (`false` khi tạo mới). */
  readonly scopesUpdated: boolean;
  /** Các URI mới được thêm lần này (rỗng khi re-run cùng cấu hình). */
  readonly addedRedirectUris: readonly string[];
  /** Tập URI đã verify (đã sort) — bằng đúng tập cấu hình. */
  readonly verifiedRedirectUris: readonly string[];
}

/** RFC 6749 scope-token: `!#$%&'()+,-.:;<=>?@[\]^_\`{|}~` cộng chữ và số. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;

/** Tách danh sách scope từ một giá trị env — fail-closed, không dedupe âm thầm. */
export function parseAllowedScopes(raw: string): string[] {
  const scopes = raw.split(/\s+/u).filter((scope) => scope !== '');
  if (scopes.length === 0) {
    throw new Error(
      `${BOOTSTRAP_ALLOWED_SCOPES_ENV} is empty. Set it to a space-separated scope list (e.g. "openid offline_access"); a client without scopes cannot authorize anything.`,
    );
  }
  const invalid = scopes.find((scope) => SCOPE_TOKEN.test(scope) === false);
  if (invalid !== undefined) {
    throw new Error(
      `${BOOTSTRAP_ALLOWED_SCOPES_ENV} contains an invalid scope token ${JSON.stringify(invalid)}; scopes must be single-line RFC 6749 scope-token strings separated by whitespace.`,
    );
  }
  const duplicate = scopes.find((scope, index) => scopes.indexOf(scope) !== index);
  if (duplicate !== undefined) {
    throw new Error(
      `${BOOTSTRAP_ALLOWED_SCOPES_ENV} lists scope ${JSON.stringify(duplicate)} more than once; remove the duplicate instead of relying on the script to dedupe.`,
    );
  }
  return scopes;
}

/** Tập URI kỳ vọng từ một giá trị env — exact string, absolute http(s), không fragment. */
export function parseRedirectUris(raw: string): string[] {
  const uris = raw.split(/\s+/u).filter((uri) => uri !== '');
  if (uris.length === 0) {
    throw new Error(
      `${BOOTSTRAP_REDIRECT_URIS_ENV} is empty. Set it to the space-separated exact redirect URI list this environment expects; auth matches redirect URIs by exact string only.`,
    );
  }
  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error(
        `${BOOTSTRAP_REDIRECT_URIS_ENV} contains a value that is not an absolute URI: ${JSON.stringify(uri)}; redirect URIs are stored and matched as exact strings, so they must be complete https origins.`,
      );
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(
        `${BOOTSTRAP_REDIRECT_URIS_ENV} contains a non-HTTP(S) URI ${JSON.stringify(uri)}; only https (or http for local lanes) callbacks are accepted.`,
      );
    }
    if (parsed.hash !== '') {
      throw new Error(
        `${BOOTSTRAP_REDIRECT_URIS_ENV} contains a URI with a fragment ${JSON.stringify(uri)}; OAuth forbids fragments in redirect URIs.`,
      );
    }
  }
  const duplicate = uris.find((uri, index) => uris.indexOf(uri) !== index);
  if (duplicate !== undefined) {
    throw new Error(
      `${BOOTSTRAP_REDIRECT_URIS_ENV} lists ${JSON.stringify(duplicate)} more than once; the PK (client_id, redirect_uri) forbids duplicates, so fix the input instead of relying on the script to dedupe.`,
    );
  }
  return uris;
}

/**
 * Giải đầu vào CLI từ một bản ghi dạng env — fail-closed kèm chỉ dẫn cụ thể
 * khi thiếu thứ gì đó. Hàm thuần để test ghim các nhánh fail mà không cần
 * database; `main` áp nó lên `process.env`.
 */
export function parseBootstrapEnv(env: NodeJS.ProcessEnv): BootstrapOAuthClientInput {
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'DATABASE_URL is not set. Run this script from a CI runner or ops box with the db-auth migrator credentials; the password goes in the connection string (env/stdin), never in argv.',
    );
  }
  const clientId = env[BOOTSTRAP_CLIENT_ID_ENV];
  if (typeof clientId !== 'string' || clientId === '' || /\s/u.test(clientId)) {
    throw new Error(
      `${BOOTSTRAP_CLIENT_ID_ENV} is not set to a non-empty client_id without whitespace. The value is environment seed input (e.g. the local lane uses "ecoma-backoffice-local"); it is never invented by this script.`,
    );
  }
  const clientName = env[BOOTSTRAP_CLIENT_NAME_ENV];
  if (typeof clientName !== 'string' || clientName === '' || hasControlCharacter(clientName)) {
    throw new Error(
      `${BOOTSTRAP_CLIENT_NAME_ENV} is not set to a single-line display name. It is stored as client_name on the row this script creates.`,
    );
  }
  return {
    clientId,
    clientName,
    allowedScopes: parseAllowedScopes(env[BOOTSTRAP_ALLOWED_SCOPES_ENV] ?? ''),
    redirectUris: parseRedirectUris(env[BOOTSTRAP_REDIRECT_URIS_ENV] ?? ''),
  };
}

/**
 * Assert `current_database()` đúng là database của service này — server-side
 * xác nhận, mạnh hơn parse URL: URL có thể qua connection proxy/override,
 * database thật mà client đang nói chuyện mới là nguồn sự thật. Trỏ nhầm
 * database là chết ngay, trước khi một query bootstrap nào chạm đích.
 */
export async function assertBootstrapDatabase(client: Client): Promise<string> {
  const { rows } = await client.query<{ current_database: string }>(
    `SELECT current_database() AS current_database`,
  );
  const currentDatabase = rows[0]?.current_database;
  if (currentDatabase !== AUTH_DATABASE) {
    throw new Error(
      `DATABASE_URL points at database ${currentDatabase ?? '<unknown>'}; this script only bootstraps ${AUTH_DATABASE}.`,
    );
  }
  return currentDatabase;
}

/** So hai tập string bỏ qua thứ tự — scope ceiling và URI set đều so như tập. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sortedA = [...a].toSorted((x, y) => x.localeCompare(y, 'en'));
  const sortedB = [...b].toSorted((x, y) => x.localeCompare(y, 'en'));
  return (
    sortedA.length === sortedB.length && sortedA.every((value, index) => value === sortedB[index])
  );
}

/**
 * Kiểm control character (U+0000–U+001F, U+007F) bằng charCode thay vì RegExp:
 * rule `no-control-regex` của lint cấm regex chứa control character, còn mọi
 * giá trị trong khoảng này đều là một code unit đơn nên phép so charCode là
 * tương đương.
 */
function hasControlCharacter(value: string): boolean {
  return [...value].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

interface StoredClientRow {
  readonly client_name: string;
  readonly client_type: string;
  readonly client_secret_hash: string | null;
  readonly status: string;
  readonly allowed_scopes: string[];
}

/**
 * Bootstrap client public của backoffice — core logic dùng chung bởi CLI và
 * integration test (một đường code duy nhất, đúng pattern runner-canonical:
 * viết vòng provisioning riêng trong test là test bản sao, không test CLI).
 *
 * Client truyền vào phải là credential **migrator** (owner của schema sau khi
 * migration chạy): provisioning là đường ghi schema-owned, không phải serving.
 * Hàm KHÔNG tự mở/đóng connection hay transaction: caller quản lý vòng đời
 * (CLI bên dưới), và mọi câu DML của một lần chạy nằm trong transaction duy
 * nhất của caller để client row, redirect URI và kết quả verify cùng đứng hoặc
 * cùng rollback (valid prefix semantics — ADR-0020 Quyết định 6).
 *
 * Trình tự (§3.2b): đọc hàng hiện có → fail-closed khi trạng thái lệch →
 * upsert client (DO UPDATE chỉ chạm `allowed_scopes`) → insert URI thiếu
 * (`DO NOTHING`) → verify đọc lại: đúng một hàng public/active với đúng scope
 * ceiling, và tập URI stored **bằng đúng** tập cấu hình. Verify là phần của
 * lần chạy (§3.2 cột "Kiểm tra sau bước"): sai khớp đầu tiên là throw nên
 * caller rollback toàn bộ — lần chạy không bao giờ "xong" với trạng thái lệch.
 */
export async function bootstrapOAuthClient(
  client: Client,
  input: BootstrapOAuthClientInput,
): Promise<BootstrapOAuthClientResult> {
  if (typeof input.clientId !== 'string' || input.clientId === '' || /\s/u.test(input.clientId)) {
    throw new Error('client id is required and must be a non-empty string without whitespace');
  }
  if (
    typeof input.clientName !== 'string' ||
    input.clientName === '' ||
    hasControlCharacter(input.clientName)
  ) {
    throw new Error('client name is required and must be a single-line non-empty string');
  }
  if (!Array.isArray(input.allowedScopes) || input.allowedScopes.length === 0) {
    throw new Error('allowed scopes are required (a non-empty scope list)');
  }
  if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
    throw new Error('redirect URIs are required (a non-empty exact-string URI list)');
  }

  // Đọc hàng hiện có TRƯỚC khi ghi: các trạng thái fail-closed phải chặn lần
  // chạy trước bất kỳ câu INSERT nào, và `alreadyExisted`/`scopesUpdated` cần
  // trạng thái trước lần chạy này.
  const existing = await client.query<StoredClientRow>(
    `SELECT client_name, client_type, client_secret_hash, status, allowed_scopes
       FROM auth.oauth_clients WHERE client_id = $1`,
    [input.clientId],
  );
  const stored = existing.rows[0];
  if (stored !== undefined) {
    if (stored.status !== 'active') {
      throw new Error(
        `client ${input.clientId} exists with status ${stored.status}; refusing to resurrect — re-enabling a disabled client is an operator action`,
      );
    }
    if (stored.client_type !== 'public') {
      throw new Error(
        `client ${input.clientId} exists with client_type ${stored.client_type}; the bootstrap client is public and bootstrap never converts an existing registration`,
      );
    }
    if (stored.client_secret_hash !== null) {
      throw new Error(
        `client ${input.clientId} is registered as public but carries a client_secret_hash; this violates the secret parity invariant of migration 0001 — resolve it before bootstrapping`,
      );
    }
  }

  // Mệnh đề 1 của §3.2b: DO UPDATE chỉ refresh scope ceiling; các cột khác của
  // hàng đã có (tên hiển thị, status) giữ nguyên.
  await client.query(
    `INSERT INTO auth.oauth_clients (client_id, client_name, client_type, allowed_scopes)
     VALUES ($1, $2, 'public', $3)
     ON CONFLICT (client_id) DO UPDATE SET allowed_scopes = EXCLUDED.allowed_scopes`,
    [input.clientId, input.clientName, input.allowedScopes],
  );

  // Mệnh đề 2 của §3.2b: thêm URI thiếu; URI stored dư sẽ bị verify bắt ở dưới,
  // không bao giờ bị xoá bởi bootstrap.
  const addedRedirectUris: string[] = [];
  for (const redirectUri of input.redirectUris) {
    const inserted = await client.query(
      `INSERT INTO auth.client_redirect_uris (client_id, redirect_uri)
       VALUES ($1, $2)
       ON CONFLICT (client_id, redirect_uri) DO NOTHING`,
      [input.clientId, redirectUri],
    );
    if (inserted.rowCount === 1) {
      addedRedirectUris.push(redirectUri);
    }
  }

  // Verify đọc lại BÊN TRONG transaction — đúng "Kiểm tra sau bước" của §3.2,
  // không dựa log: đúng một hàng public/active với đúng scope ceiling, và tập
  // URI stored bằng đúng tập cấu hình (exact string, so như tập).
  const verified = await client.query<StoredClientRow>(
    `SELECT client_name, client_type, client_secret_hash, status, allowed_scopes
       FROM auth.oauth_clients WHERE client_id = $1`,
    [input.clientId],
  );
  const verifiedRow = verified.rows[0];
  if (verifiedRow === undefined || verified.rows.length !== 1) {
    throw new Error(
      `client ${input.clientId} missing after upsert (unexpected state); failing closed instead of reporting success`,
    );
  }
  if (
    verifiedRow.client_type !== 'public' ||
    verifiedRow.status !== 'active' ||
    verifiedRow.client_secret_hash !== null
  ) {
    throw new Error(
      `client ${input.clientId} does not read back as an active public client without a secret (client_type=${verifiedRow.client_type}, status=${verifiedRow.status}); failing closed`,
    );
  }
  if (sameSet(verifiedRow.allowed_scopes, input.allowedScopes) === false) {
    throw new Error(
      `client ${input.clientId} carries scopes [${verifiedRow.allowed_scopes.join(' ')}] but the configured ceiling is [${input.allowedScopes.join(' ')}]; the stored ceiling is never left diverged — failing closed`,
    );
  }

  const storedUris = await client.query<{ redirect_uri: string }>(
    `SELECT redirect_uri FROM auth.client_redirect_uris WHERE client_id = $1`,
    [input.clientId],
  );
  const storedUriSet = storedUris.rows.map((row) => row.redirect_uri);
  const stale = storedUriSet.filter((uri) => input.redirectUris.includes(uri) === false);
  if (stale.length > 0) {
    throw new Error(
      `client ${input.clientId} still carries redirect URI(s) no longer in the configured set: ${stale.map((uri) => JSON.stringify(uri)).join(', ')}; bootstrap never deletes rows — remove the stale URI(s) explicitly (forward-fix), then re-run`,
    );
  }
  if (sameSet(storedUriSet, input.redirectUris) === false) {
    throw new Error(
      `client ${input.clientId} redirect URIs read back as [${storedUriSet.join(' ')}] but the configured set is [${input.redirectUris.join(' ')}]; failing closed on unexpected state`,
    );
  }

  return {
    alreadyExisted: stored !== undefined,
    clientId: input.clientId,
    scopesUpdated:
      stored !== undefined && sameSet(stored.allowed_scopes, input.allowedScopes) === false,
    addedRedirectUris,
    verifiedRedirectUris: [...input.redirectUris].toSorted((a, b) => a.localeCompare(b, 'en')),
  };
}

/** Nhánh CLI — chỉ chạy khi file này là main module. */
async function main(): Promise<void> {
  let input: BootstrapOAuthClientInput;
  try {
    input = parseBootstrapEnv(process.env);
  } catch (error) {
    console.error('bootstrap-oauth-clients refuses to run:', (error as Error).message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env['DATABASE_URL'] as string,
    application_name: 'ecoma-auth-bootstrap-oauth-clients',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Failed to connect to database:', (error as Error).message);
    process.exit(1);
  }

  try {
    await assertBootstrapDatabase(client);
    await client.query('BEGIN');
    const result = await bootstrapOAuthClient(client, input);
    await client.query('COMMIT');
    console.log(
      `oauth client ${result.clientId} ${result.alreadyExisted ? 'already exists' : 'created'}${result.scopesUpdated ? ' (scope ceiling refreshed)' : ''}; ` +
        `redirect URIs ${result.verifiedRedirectUris.length} registered (${String(result.addedRedirectUris.length)} added); ` +
        'verified the exact configured redirect URI set',
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('bootstrap-oauth-clients failed:', (error as Error).message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
