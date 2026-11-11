/**
 * `node db/provision-machine-token.mts` — cấp machine credential cho consumer
 * BFF (`pact-broker-app`) trên canonical tenant `ecoma` trong `db-pact-broker`.
 *
 * Bước 6 của hợp đồng bootstrap/seed (ADR-0020,
 * `docs/architecture/02-delivery.md` §3.2): đúng MỘT token active cho natural
 * key (tenant `ecoma`, token name), đạt được một cách idempotent. Token name
 * và scopes đến từ cấu hình environment; danh tính canonical tenant thì không
 * (Quyết định 9 của ADR-0020 — tên tenant là hằng `ecoma` trong mọi
 * environment, import tại đây từ `db/bootstrap-tenant.mts`).
 *
 * Script độc lập với deploy pipeline: chạy trực tiếp từ CI runner / máy vận
 * hành với một PostgreSQL client giữ credential hợp lệ (runtime role —
 * provisioning chỉ làm DML), không bao giờ từ Worker — cùng ranh giới
 * runner/Worker với `db/apply.mts` (HD6) và `db/bootstrap-tenant.mts`.
 * `pnpm nx run @ecoma-io/pact-broker-api:db:provision-machine-token` là bề mặt
 * thực thi được ghi nhận cho môi trường ngoài local.
 *
 * Hành vi, tất cả bên trong MỘT transaction do caller quản lý:
 *  - Resolve tenant theo tên `ecoma`. Thiếu hoặc khác `active` thì fail-closed:
 *    provisioning KHÔNG bao giờ tạo tenant (việc đó thuộc về
 *    `db/bootstrap-tenant.mts`) và không bao giờ hồi sinh tenant (Quyết định 6
 *    của ADR-0020).
 *  - Tính SHA-256 hex của plaintext NGAY TRONG SCRIPT (hash, không phải
 *    plaintext, là chất liệu token duy nhất chạm tới SQL).
 *  - Revoke mọi token ACTIVE (`revoked_at IS NULL`) cùng (tenant_id, name)
 *    nhưng hash khác — đổi plaintext là một rotation: row active cũ bị revoke
 *    trước, không bao giờ còn hợp lệ cạnh token mới.
 *  - Insert row mới `ON CONFLICT (token_hash) DO NOTHING` — chạy lại với
 *    plaintext GIỐNG nhau là no-op, hội tụ thay vì chồng chất row (tính UNIQUE
 *    của `token_hash` là chỗ neo của natural key).
 *  - Verify CUỐI bên trong transaction: đúng một token active cho (tenant
 *    `ecoma`, token name), mang đúng hash và scopes đã cấu hình. Bất kỳ điều
 *    gì khác thì throw (fail-closed trước sự mơ hồ). Đáng chú ý, verify này
 *    cũng từ chối hồi sinh một token đã bị revoke thủ công (chạy lại với
 *    plaintext đã revoke sẽ thấy không row active nào), từ chối plaintext
 *    trùng với một token name khác (token_hash UNIQUE trên toàn bảng — một
 *    plaintext chỉ sở hữu đúng một row), và từ chối row lưu trữ có scopes
 *    khác cấu hình — tất cả đều là quyết định của người vận hành (rotate
 *    plaintext / chọn plaintext riêng / sửa cấu hình), không bao giờ tự sửa
 *    âm thầm.
 *
 * An toàn khi chạy đồng thời, không cần advisory lock: mọi mục tiêu ghi được
 * neo bởi natural key — `machine_tokens.token_hash` (UNIQUE) và vị từ
 * (tenant_id, name, revoked_at). Với READ COMMITTED, hai lần chạy đồng thời
 * cùng plaintext sẽ hội tụ: INSERT của bên thua đợi insert đang diễn ra của
 * bên thắng, rồi skip qua ON CONFLICT, và cả hai lần verify đều thấy đúng một
 * row active. Hai lần chạy đồng thời KHÁC plaintext: mỗi lần kết thúc với đúng
 * một row active (bên ghi sau thắng); lần chạy mà token của nó bị bên thắng
 * sau đó revoke vẫn báo thành công của chính transaction của nó — bất biến
 * single-active giữ vững tại mọi biên commit, và đó là đảm bảo consumer cần.
 * Không có state nào ngoài database và không có read-modify-write thiếu chỗ
 * neo xung đột (Quyết định 5 của ADR-0020).
 *
 * Audit: đúng MỘT row `pact.audit_events` cho mỗi lần chạy thành công (action
 * `machine_token.provision`, outcome `success`, detail `{name, result}`), áp
 * dụng cho cả ba nhánh created, rotated và no-op. Actor là script vận hành,
 * nên `actor_sub`/`actor_token_id` là NULL. Một lần chạy fail-closed không
 * viết row audit nào, vì mọi đường fail đều throw trước khi insert.
 *
 * Biến môi trường:
 *
 * | Biến                           | Bắt buộc | Ý nghĩa                                      |
 * | ------------------------------ | -------- | -------------------------------------------- |
 * | `DATABASE_URL`                 | có       | Chuỗi kết nối PostgreSQL (runtime role)      |
 * | `PACT_MACHINE_TOKEN_NAME`      | có       | Token name (natural key cùng với tenant)     |
 * | `PACT_MACHINE_TOKEN_SCOPES`    | có       | Danh sách scope cách nhau bởi khoảng trắng   |
 * | `PACT_MACHINE_TOKEN_PLAINTEXT` | có       | Plaintext token; chỉ SHA-256 hash được lưu   |
 *
 * Plaintext chỉ sống trong env của tiến trình gọi (không bao giờ qua argv —
 * argv lộ trong `ps` và shell history, trái với bất biến Secrets) và không
 * bao giờ được log. Thiếu cấu hình thì thoát khác 0 kèm hướng dẫn. Script
 * cũng assert database trong URL là `db-pact-broker` — trỏ vào database khác
 * thì chết ngay lập tức thay vì viết vào nhà người khác.
 */

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import {
  CANONICAL_TENANT_NAME,
  parseDatabaseUrl,
  PACT_BROKER_DATABASE,
  type BootstrapDatabaseTarget,
} from './bootstrap-tenant.mts';

/** Tên database service này sở hữu; export lại cho assert của CLI và test. */
export { PACT_BROKER_DATABASE };

/** Biến môi trường chứa token name. Bắt buộc. */
export const MACHINE_TOKEN_NAME_ENV = 'PACT_MACHINE_TOKEN_NAME';

/** Biến môi trường chứa danh sách scope cách nhau bởi khoảng trắng. Bắt buộc. */
export const MACHINE_TOKEN_SCOPES_ENV = 'PACT_MACHINE_TOKEN_SCOPES';

/** Biến môi trường chứa plaintext token (chỉ hash được lưu). Bắt buộc. */
export const MACHINE_TOKEN_PLAINTEXT_ENV = 'PACT_MACHINE_TOKEN_PLAINTEXT';

/** Audit action của một lần provision — theo quy ước `object.verb` của broker. */
export const MACHINE_TOKEN_PROVISION_AUDIT_ACTION = 'machine_token.provision';

/** Đầu vào của một lần provision, được CLI (hoặc test) giải từ env. */
export interface MachineTokenInput {
  /** Token name — natural key là (tenant `ecoma`, tên này). */
  readonly tokenName: string;
  /** Danh sách scope cách nhau bởi khoảng trắng, do constraint `machine_tokens_scopes_check` kiểm. */
  readonly scopes: string;
  /** Plaintext token; chỉ SHA-256 hex của nó chạm tới database hay SQL. */
  readonly plaintext: string;
}

/** Kết quả của một lần provision — CLI in ra, test assert trên nó. */
export interface MachineTokenProvisionResult {
  /** `created` = row đầu tiên; `no-op` = plaintext đó đã active; `rotated` = plaintext cũ bị revoke. */
  readonly result: 'created' | 'no-op' | 'rotated';
  /** Id (uuid) của row token active DUY NHẤT sau lần chạy này. */
  readonly tokenId: string;
  /** Tenant id (uuid) của `ecoma` — mọi token đều thuộc phạm vi tenant. */
  readonly tenantId: string;
  /** Tên tenant — hằng `CANONICAL_TENANT_NAME`, trả về để test assert. */
  readonly tenantName: string;
  /** Token name của lần chạy này, trả về để test assert. */
  readonly tokenName: string;
  /** Số row active trước đó cùng (tenant, name) mà lần chạy này đã revoke. */
  readonly revokedCount: number;
}

/**
 * SHA-256 hex (chữ thường) của plaintext UTF-8 — đúng dạng lưu trữ của
 * `pact.machine_tokens.token_hash` và đúng giá trị đường auth của app băm
 * (`sha256Hex` trong `@ecoma-io/pact-broker-api-application`). SHA-256 là hàm
 * chuẩn, nên `node:crypto` và WebCrypto của app sinh cùng digest cho cùng
 * input; test integration ghim sự bằng nhau này.
 */
export function hashMachineToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Giải đầu vào CLI từ một bản ghi dạng env — fail-closed kèm chỉ dẫn cụ thể
 * khi thiếu thứ gì đó. Hàm thuần để test ghim các nhánh fail mà không cần
 * database; `main` áp nó lên `process.env`.
 */
export function parseMachineTokenEnv(env: NodeJS.ProcessEnv): MachineTokenInput {
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'DATABASE_URL is not set. Run this script from a CI runner or ops box with the runtime role credentials; the password goes in the connection string (env/stdin), never in argv.',
    );
  }
  const tokenName = env[MACHINE_TOKEN_NAME_ENV];
  if (tokenName === undefined || tokenName === '') {
    throw new Error(`${MACHINE_TOKEN_NAME_ENV} is not set. Set it to the consumer's token name.`);
  }
  const scopes = env[MACHINE_TOKEN_SCOPES_ENV];
  if (scopes === undefined || scopes === '') {
    throw new Error(
      `${MACHINE_TOKEN_SCOPES_ENV} is not set. Set it to a space-separated scope list (read|write|admin); a token without scopes is useless.`,
    );
  }
  const plaintext = env[MACHINE_TOKEN_PLAINTEXT_ENV];
  if (plaintext === undefined || plaintext === '') {
    throw new Error(
      `${MACHINE_TOKEN_PLAINTEXT_ENV} is not set. Treat silence as "the token is already provisioned" is how a one-time credential disappears; pass the plaintext via env, never argv.`,
    );
  }
  return { tokenName, scopes, plaintext };
}

/**
 * Cấp machine token — logic lõi dùng chung bởi CLI và test integration (một
 * đường code duy nhất, pattern runner-canonical của `db/apply.mts` và
 * `db/bootstrap-tenant.mts`: viết lại vòng apply bên trong test là kiểm một
 * bản sao, không phải runner).
 *
 * Client truyền vào phải có đặc quyền INSERT/SELECT/UPDATE trên
 * `pact.machine_tokens` và INSERT/SELECT trên `pact.audit_events` (runtime
 * role). Hàm KHÔNG tự mở/đóng kết nối: caller quản lý vòng đời kết nối (CLI
 * dưới đây) và transaction (test). Mọi câu lệnh của một lần chạy thực thi bên
 * trong đúng một transaction của caller, để revoke, insert, verify và row
 * audit cùng tồn tại hoặc cùng không.
 *
 * Plaintext phải khác rỗng; token name và scopes phải khác rỗng (CHECK
 * constraint của database là lớp phòng thứ hai). Fail-closed — toàn bộ lần
 * chạy bị caller rollback — khi tenant thiếu hoặc không active, khi trạng
 * thái cuối mơ hồ, hoặc khi row lưu trữ lệch với scopes đã cấu hình.
 * Plaintext không bao giờ được log và không bao giờ được nội suy vào SQL.
 */
export async function provisionMachineToken(
  client: Client,
  input: MachineTokenInput,
): Promise<MachineTokenProvisionResult> {
  if (input.tokenName === '') {
    throw new Error('token name is required');
  }
  if (input.scopes === '') {
    throw new Error('token scopes are required: a token without scopes is useless');
  }
  if (input.plaintext === '') {
    throw new Error('token plaintext is required');
  }

  // Provisioning không bao giờ tạo tenant và không bao giờ cấp token cho một
  // tenant suspended/deleted (Quyết định 6 của ADR-0020): resolve và chặn
  // trước tiên.
  const tenants = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM pact.tenants WHERE name = $1`,
    [CANONICAL_TENANT_NAME],
  );
  const tenant = tenants.rows[0];
  if (tenant === undefined) {
    throw new Error(
      `tenant ${CANONICAL_TENANT_NAME} does not exist; run db/bootstrap-tenant.mts first — provisioning never creates a tenant`,
    );
  }
  if (tenant.status !== 'active') {
    throw new Error(
      `tenant ${CANONICAL_TENANT_NAME} exists with status ${tenant.status}; refusing to provision a token for a non-active tenant`,
    );
  }

  const tokenHash = hashMachineToken(input.plaintext);

  // Rotation: revoke mọi token active KHÁC cùng (tenant, name) trước, để một
  // lần đổi plaintext không bao giờ để lại hai credential hợp lệ cạnh nhau —
  // kể cả giữa chừng transaction.
  const revoked = await client.query<{ id: string }>(
    `UPDATE pact.machine_tokens SET revoked_at = now()
      WHERE tenant_id = $1 AND name = $2 AND revoked_at IS NULL AND token_hash <> $3
      RETURNING id`,
    [tenant.id, input.tokenName, tokenHash],
  );
  const revokedCount = revoked.rows.length;

  // Insert với chỗ neo natural key: chạy lại cùng plaintext là no-op (row đã
  // tồn tại), plaintext mới insert đích của rotation. `token_hash` UNIQUE là
  // điểm hội tụ khi chạy đồng thời.
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO pact.machine_tokens (token_hash, tenant_id, name, scopes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token_hash) DO NOTHING
     RETURNING id`,
    [tokenHash, tenant.id, input.tokenName, input.scopes],
  );

  // Verify cuối BÊN TRONG transaction — fail-closed trước sự mơ hồ. Đây là
  // hợp đồng: đúng một token active cho (tenant ecoma, token name), mang đúng
  // hash và scopes đã cấu hình. Verify cũng bắt các trường hợp không thể tự
  // sửa: hồi sinh token đã bị revoke thủ công (chạy lại một plaintext đã bị
  // revoke thấy không row active nào), plaintext trùng với token name khác
  // (token_hash UNIQUE trên toàn bảng — một plaintext chỉ sở hữu đúng một row),
  // và scopes cũ (cùng plaintext đã được cấp trước đó với tập scope khác —
  // scopes đã lưu không bao giờ bị ghi đè âm thầm; rotate plaintext là cách
  // người vận hành áp tập scope mới cho row trùng hash).
  const active = await client.query<{ id: string; token_hash: string; scopes: string }>(
    `SELECT id, token_hash, scopes FROM pact.machine_tokens
      WHERE tenant_id = $1 AND name = $2 AND revoked_at IS NULL`,
    [tenant.id, input.tokenName],
  );
  if (active.rows.length !== 1) {
    if (active.rows.length === 0) {
      // Chẩn đoán hai dạng "không row active nào" để thông điệp fail nói đúng
      // việc người vận hành cần làm, thay vì một câu mơ hồ chung.
      const hashOwner = await client.query<{ name: string }>(
        `SELECT name FROM pact.machine_tokens WHERE token_hash = $1`,
        [tokenHash],
      );
      const owner = hashOwner.rows[0];
      if (owner !== undefined && owner.name !== input.tokenName) {
        throw new Error(
          `the plaintext already belongs to token name ${owner.name}; a plaintext owns exactly one row (token_hash is unique), use a distinct plaintext for ${input.tokenName}`,
        );
      }
    }
    throw new Error(
      `expected exactly one active machine token for (tenant ${CANONICAL_TENANT_NAME}, name ${input.tokenName}), found ${active.rows.length}; failing closed — a revoked token is never resurrected by provisioning (rotation is an operator action: change the plaintext)`,
    );
  }
  const activeRow = active.rows[0];
  if (activeRow === undefined) {
    throw new Error(`active token row missing after verification (unexpected state)`);
  }
  // Phòng thủ đa lớp: vị từ revoke ở trên chỉ để lại row trùng hash là active,
  // nên nhánh này không với tới được qua SQL hợp lệ — assert giữ cho verify
  // tự chứa, thay vì tin câu lệnh đứng trước.
  if (activeRow.token_hash !== tokenHash) {
    throw new Error(
      `active machine token carries a different hash than the configured plaintext; refusing to continue`,
    );
  }
  if (activeRow.scopes !== input.scopes) {
    throw new Error(
      `active machine token carries scopes "${activeRow.scopes}" but ${MACHINE_TOKEN_SCOPES_ENV} says "${input.scopes}"; the stored scopes are never silently rewritten — rotate the plaintext to apply the new scope set`,
    );
  }

  const result: MachineTokenProvisionResult['result'] =
    revokedCount > 0 ? 'rotated' : inserted.rows.length === 1 ? 'created' : 'no-op';

  await insertProvisionAuditEvent(client, tenant.id, input.tokenName, result);

  return {
    result,
    tokenId: activeRow.id,
    tenantId: tenant.id,
    tenantName: CANONICAL_TENANT_NAME,
    tokenName: input.tokenName,
    revokedCount,
  };
}

/**
 * Ghi audit entry của một lần provision vào `pact.audit_events` — bảng
 * append-only từ migration `0001`, hình dạng khớp `insertAuditEvent` của
 * infrastructure (không phát minh bảng mới). Actor là script vận hành, nên
 * `actor_sub`/`actor_token_id` là NULL; `detail` ghi kết quả để các lần chạy
 * created, rotated và no-op phân biệt được trong truy vấn audit. Đúng một
 * event cho mỗi lần chạy thành công; lần chạy fail-closed không viết event
 * nào, vì mọi đường fail đều throw trước khi insert.
 */
async function insertProvisionAuditEvent(
  client: Client,
  tenantId: string,
  tokenName: string,
  result: MachineTokenProvisionResult['result'],
): Promise<void> {
  await client.query(
    `INSERT INTO pact.audit_events (tenant_id, actor_sub, actor_token_id, action, outcome, detail)
     VALUES ($1, NULL, NULL, $2, 'success', $3::jsonb)`,
    [tenantId, MACHINE_TOKEN_PROVISION_AUDIT_ACTION, JSON.stringify({ name: tokenName, result })],
  );
}

/** Nhánh CLI — chỉ chạy khi file này là module chính. */
async function main(): Promise<void> {
  let input: MachineTokenInput;
  try {
    input = parseMachineTokenEnv(process.env);
  } catch (error) {
    console.error('provision-machine-token refuses to run:', (error as Error).message);
    process.exit(1);
  }

  let target: BootstrapDatabaseTarget;
  try {
    target = parseDatabaseUrl(process.env['DATABASE_URL'] as string);
  } catch (error) {
    console.error('DATABASE_URL is invalid:', (error as Error).message);
    process.exit(1);
  }
  if (target.database !== PACT_BROKER_DATABASE) {
    console.error(
      `DATABASE_URL points at database ${target.database}; this script only provisions tokens in ${PACT_BROKER_DATABASE}.`,
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env['DATABASE_URL'] as string,
    application_name: 'ecoma-pact-broker-provision-machine-token',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Failed to connect to database:', (error as Error).message);
    process.exit(1);
  }

  try {
    await client.query('BEGIN');
    const result = await provisionMachineToken(client, input);
    await client.query('COMMIT');
    console.log(
      `machine token ${result.tokenName} of tenant ${result.tenantName}: ${result.result} (revoked ${result.revokedCount} other active token(s), active row ${result.tokenId})`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('provision-machine-token failed:', (error as Error).message);
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
