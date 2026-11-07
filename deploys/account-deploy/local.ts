/**
 * Entry lifecycle local của `account-deploy` — `up`/`down` trên stack Pulumi
 * của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (account phụ thuộc duy nhất platform — chạy song song với các
 * unit độc lập khác; auth và mail đọc secret của account nên phụ thuộc nó).
 *
 * Chạy qua target Nx: `nx run account-deploy:local-up -c local` → `npx tsx
 * local.ts up`. Entry KHÔNG lấy khóa lane: lifecycle không còn khóa toàn cục (xem quyết định kiến trúc PR #424).
 *
 * Account là PERSISTOR của hai secret dùng chung — sinh MỘT giá trị khi up và
 * persist vào stack config của chính nó; unit chạy sau đọc lại:
 *
 * - `internalHmacSecret` (auth đọc lại làm `internalSecret`): envelope HMAC
 *   hai chiều auth <-> account. Sinh hai giá trị độc lập là mọi envelope
 *   internal chết `bad_signature` lúc runtime.
 * - `mailInternalAuthSecret` (transactional-mail-deploy đọc lại): path HMAC
 *   Account↔Mail (OTP). PHẢI khác `internalHmacSecret` — validation của
 *   account từ chối hai secret trùng nhau, và registry của receiver mail coi
 *   mỗi entry là một credential riêng.
 *
 * Các secret còn lại là của riêng account: mật khẩu 4 role PostgreSQL
 * (owner/runtime/migrator/pruner — account SỞ HỮU role owner `ecoma_owner`
 * chung cluster) và `otpHmacSecret`. Mật khẩu sinh bằng API mật mã an toàn và
 * xoay mỗi lần up (role được guard-create/ALTER trong cùng lần up).
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import {
  ensureStackForEntry,
  generateInternalHmacSecret,
  generatePostgresPassword,
  pulumiDestroyForEntry,
  pulumiUpForEntry,
  resolveEntryFoundation,
  setStackConfig,
  type EntryFoundation,
} from '@ecoma-io/deployment';

async function prepare(foundation: EntryFoundation): Promise<void> {
  // Stack phải tồn tại trước khi `config set` — lần up đầu trên worktree mới,
  // state dir chưa có và mọi lệnh config exit 1 (xem `ensureStackForEntry`).
  ensureStackForEntry('account-deploy', foundation);
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ['namespace:ownerPassword', generatePostgresPassword()],
    ['namespace:runtimePassword', generatePostgresPassword()],
    ['namespace:migratorPassword', generatePostgresPassword()],
    ['namespace:prunerPassword', generatePostgresPassword()],
    ['namespace:internalHmacSecret', generateInternalHmacSecret()],
    ['namespace:mailInternalAuthSecret', generateInternalHmacSecret()],
    ['namespace:otpHmacSecret', generatePostgresPassword()],
  ];
  for (const [configKey, configValue] of secrets) {
    setStackConfig('account-deploy', configKey, configValue, foundation);
  }
}

async function main(command: string): Promise<number> {
  if (command === 'up') {
    const foundation = resolveEntryFoundation(true);
    if (foundation === undefined) {
      return 1;
    }
    try {
      await prepare(foundation);
      pulumiUpForEntry('account-deploy', foundation);
    } catch (error) {
      console.error(
        `[account-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
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
        '[account-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('account-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[account-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[account-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
