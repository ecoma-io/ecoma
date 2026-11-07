/**
 * Entry lifecycle local của `auth-deploy` — `up`/`down` trên stack Pulumi của
 * CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của package.json
 * (auth phụ thuộc account vì đọc secret cross-stack `internalHmacSecret` —
 * runtime còn có WIC phụ thuộc container account).
 *
 * Chạy qua target Nx: `nx run auth-deploy:local-up -c local` → `npx tsx
 * local.ts up`. Entry KHÔNG lấy khóa lane: lifecycle không còn khóa toàn cục (xem quyết định kiến trúc PR #424).
 *
 * Secret bảng của auth (sinh khi up, giữ trong stack config qua stdin):
 * - Mật khẩu 3 role PostgreSQL (runtime/migrator/pruner) — sinh ngẫu nhiên
 *   bằng API mật mã an toàn, xoay mỗi lần up là vô hại vì role được
 *   guard-create/ALTER trong cùng lần up đó.
 * - `signingKeyPem`: PKCS#8 ES256 sinh lúc deploy, giữ ổn định qua các lần
 *   deploy trong đời namespace qua persistence stack config (JWKS đổi giữa
 *   chừng là mọi token đã cấp không còn verify được) — đọc lại config trước,
 *   chỉ sinh khi thiếu.
 * - `signingKeyId` = `local-identity-1` (literal ổn định — local không xoay
 *   key, thiếu `AUTH_INTERNAL_KID`/`AUTH_INTERNAL_PREVIOUS_*` là trạng thái
 *   hợp lệ mà config.ts chấp nhận tường minh).
 * - `handleKey` + `cookieKeys`: secret ỨNG DỤNG 32 byte (`generateAppSecret`)
 *   — domain lib bắt ĐÚNG 32 byte, keygrip cần key ký ứng dụng (#284).
 * - `internalSecret`: giá trị HMAC dùng chung auth <-> account — ĐỌC LẠI từ
 *   stack config của account (account đã persist khi up trước đó theo
 *   dependsOn). Hai giá trị khác nhau là mọi envelope internal chết
 *   `bad_signature` lúc runtime.
 * - `issuer`/`audience`: suy từ `ROOT_HOST` trong `.env` (artifact mà up của
 *   platform ghi sau khi xanh).
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

// Helper lifecycle dùng chung qua workspace package `@ecoma-io/deployment`
// (`libs/deployment`) — một nguồn sự thật cho mọi deploy unit; copy hàm vào
// deploy unit sẽ tạo hai nơi định nghĩa cùng một thứ và để chúng lệch nhau.
// Ranh giới là một chiều: deploy → lib; lib KHÔNG được import ngược deploy hay
// `tools/dx` (contract test của lib chặn).
import {
  deployProjectDir,
  ensureStackForEntry,
  exec,
  fullStackRef,
  generateAppSecret,
  generatePostgresPassword,
  isConfigKeyMissing,
  pulumiDestroyForEntry,
  pulumiUpForEntry,
  readRootHostFromEnv,
  resolveEntryFoundation,
  setStackConfig,
  type EntryFoundation,
} from '@ecoma-io/deployment';

import { generateEs256SigningKeyPem } from './local-generators.js';

/**
 * Đọc lại giá trị từ stack config.
 *
 * - `undefined` CHỈ khi key thực sự chưa có (CLI báo "no value for the key" /
 *   "configuration key ... not found"). Khi đó caller được phép sinh giá trị mới.
 * - Lỗi thật (sai passphrase, state lock, backend hỏng) → throw: regen secret
 *   trên các lỗi đó sẽ ĐÈ giá trị đang sống trong state → JWKS đổi làm mọi
 *   token đã cấp không còn verify được. Cùng pattern `lookupPostgresPassword`
 *   của `platform-env.ts` (nguồn `isConfigKeyMissing` ở lib dùng chung).
 */
function readStackConfig(
  project: string,
  configKey: string,
  foundation: EntryFoundation,
): string | undefined {
  const read = exec(
    'pulumi',
    ['config', 'get', configKey, '--stack', fullStackRef(project, foundation.ctx)],
    deployProjectDir(project),
    foundation.env,
  );
  if (read.status === 0) {
    const value = read.stdout.trim();
    if (value.length > 0) return value;
    // Giá trị rỗng trong config — coi như "chưa có" (rỗng không phải giá trị
    // hợp lệ cho secret).
    return undefined;
  }
  if (isConfigKeyMissing(read)) return undefined;
  // KHÔNG nhúng raw stdout/stderr: stdout của `config get` khi exit 0 CHÍNH LÀ
  // secret — nếu CLI đổi hành vi exit-code, raw output trong error string là
  // đường leak thật. Thông điệp cố định + hướng dẫn tự chạy lệnh.
  throw new Error(
    `pulumi config get ${configKey} failed (exit ${String(read.status)}) — refusing to ` +
      `regenerate the secret on a read error (would rotate the signing key and break ` +
      `already-issued tokens). Run \`pulumi config get ${configKey} --stack ` +
      `${fullStackRef(project, foundation.ctx)}\` in deploys/${project} to see the ` +
      `original stderr — the output of that command is never logged because it may ` +
      `contain the secret.`,
  );
}

/**
 * Giá trị HMAC internal dùng chung auth <-> account — ĐỌC LẠI từ stack config
 * của account.
 *
 * Account (chạy trước theo dependsOn) SINH giá trị mới và PERSIST vào stack
 * config của chính nó (`namespace:internalHmacSecret`); auth đọc lại để hai
 * stack nhận đúng MỘT giá trị dù là hai process Nx khác nhau. Bất biến
 * "cùng secret" là dữ liệu durability của Pulumi, không phải biến process.
 */
function resolveIdentityInternalSecret(foundation: EntryFoundation): string {
  const read = exec(
    'pulumi',
    [
      'config',
      'get',
      'namespace:internalHmacSecret',
      '--stack',
      fullStackRef('account-deploy', foundation.ctx),
    ],
    deployProjectDir('account-deploy'),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) {
    return read.stdout.trim();
  }
  // KHÔNG nhúng raw stderr/stdout vào log: stdout của `config get
  // namespace:internalHmacSecret` khi exit 0 CHÍNH LÀ HMAC secret — nếu CLI
  // đổi hành vi exit-code, raw output trong error string là đường leak thật.
  console.error(
    '[auth-deploy] up: reading namespace:internalHmacSecret from the account-deploy stack ' +
      `failed (exit ${String(read.status)}) — account up must run BEFORE auth (dependsOn). ` +
      'Run `pulumi config get namespace:internalHmacSecret --stack <account-stack-ref>` ' +
      'in deploys/account-deploy to see the original stderr — the output of that command ' +
      'is never logged because it may contain the secret.',
  );
  process.exit(1);
}

async function prepare(foundation: EntryFoundation): Promise<void> {
  // Stack phải tồn tại trước khi đọc/ghi stack config — lần up đầu trên
  // worktree mới, state dir chưa có và mọi lệnh config exit 1 (xem
  // `ensureStackForEntry`). Đọc cross-stack của account stack KHÔNG cần bước
  // này: account up chạy trước theo dependsOn nên stack của nó đã có.
  ensureStackForEntry('auth-deploy', foundation);
  const rootHost = readRootHostFromEnv(foundation.ctx.worktreeRoot);
  if (rootHost === undefined) {
    console.error(
      '[auth-deploy] up: missing ROOT_HOST in .env — platform up has not written it or ' +
        '.env was deleted. Run the local-up lane from platform-deploy first.',
    );
    process.exit(1);
  }
  const identityInternalSecret = resolveIdentityInternalSecret(foundation);
  // `signingKeyPem` ổn định trong đời namespace: đọc lại config trước, chỉ sinh
  // PEM mới khi thiếu (lần up đầu trên stack mới) — JWKS đổi là mọi token đã
  // cấp không còn verify được.
  const signingKeyPem =
    readStackConfig('auth-deploy', 'namespace:signingKeyPem', foundation) ??
    (await generateEs256SigningKeyPem());

  const secrets: ReadonlyArray<readonly [string, string]> = [
    ['namespace:runtimePassword', generatePostgresPassword()],
    ['namespace:migratorPassword', generatePostgresPassword()],
    ['namespace:prunerPassword', generatePostgresPassword()],
    ['namespace:signingKeyPem', signingKeyPem],
    ['namespace:signingKeyId', 'local-identity-1'],
    // `handleKey` là khoá HMAC-SHA-256 của domain lib (importKey bắt ĐÚNG 32
    // byte) và `cookieKeys` là keygrip key của oidc-provider — cả hai là
    // secret ứng dụng, dùng `generateAppSecret` (32 byte) thay vì mật khẩu
    // 24 byte của database (#284): sai hình là mọi request /authorize chết
    // `K_auth phai dai 32 byte` ngay lúc mint đầu tiên.
    ['namespace:handleKey', generateAppSecret()],
    ['namespace:internalSecret', identityInternalSecret],
    ['namespace:issuer', `https://auth.${rootHost}`],
    ['namespace:audience', `https://api.${rootHost}`],
    ['namespace:cookieKeys', generateAppSecret()],
  ];
  for (const [configKey, configValue] of secrets) {
    setStackConfig('auth-deploy', configKey, configValue, foundation);
  }
}

async function main(command: string): Promise<number> {
  if (command === 'up') {
    const foundation = resolveEntryFoundation(true);
    if (foundation === undefined) {
      // Không bao giờ xảy ra với up (`create: true` không trả undefined) —
      // guard type thuần để narrowed.
      return 1;
    }
    try {
      await prepare(foundation);
    } catch (error) {
      console.error(
        `[auth-deploy] up prepare failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    try {
      pulumiUpForEntry('auth-deploy', foundation);
    } catch (error) {
      console.error(
        `[auth-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    // Readiness đã thuộc container resource (`wait: true` trong index.ts):
    // `pulumi up` xanh đồng nghĩa healthcheck Docker của unit đã `healthy` —
    // DX không biết Docker health tồn tại.
    return 0;
  }
  if (command === 'down') {
    const foundation = resolveEntryFoundation(false);
    if (foundation === undefined) {
      console.log(
        '[auth-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('auth-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[auth-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[auth-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
main(command).then((code) => {
  process.exit(code);
});
