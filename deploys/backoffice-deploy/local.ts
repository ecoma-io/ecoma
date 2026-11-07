/**
 * Entry lifecycle local của `backoffice-deploy` — `up`/`down` trên stack
 * Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (backoffice phụ thuộc duy nhất platform — chạy song song với
 * các unit độc lập khác).
 *
 * Chạy qua target Nx: `nx run backoffice-deploy:local-up -c local` → `npx tsx
 * local.ts up`. Entry KHÔNG lấy khóa lane: lifecycle không còn khóa toàn cục (xem quyết định kiến trúc PR #424).
 *
 * Secret bảng của backoffice: mật khẩu 2 role PostgreSQL (runtime/migrator)
 * — sinh ngẫu nhiên bằng API mật mã an toàn, xoay mỗi lần up là vô hại vì role
 * được guard-create/ALTER trong cùng lần up đó. Giá trị đi qua STDIN (không
 * argv — tránh rò mật khẩu ra process listing / output lỗi của pulumi, CodeQL
 * clear-text logging).
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import {
  ensureStackForEntry,
  deployProjectDir,
  exec,
  fullStackRef,
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
  ensureStackForEntry('backoffice-deploy', foundation);

  // Đọc `internalHmacSecret` từ stack config của staff-access-deploy (cùng
  // pattern auth-deploy đọc `internalHmacSecret` từ account-deploy stack).
  // staff-access-deploy up phải chạy trước backoffice-deploy (c declared
  // dependsOn ở package.json) nên stack config của staff-access-deploy đã có
  // giá trị này.
  const readInternalSecret = exec(
    'pulumi',
    [
      'config',
      'get',
      'namespace:internalHmacSecret',
      '--stack',
      fullStackRef('staff-access-deploy', foundation.ctx),
    ],
    deployProjectDir('staff-access-deploy'),
    foundation.env,
  );
  if (readInternalSecret.status !== 0 || readInternalSecret.stdout.trim().length === 0) {
    console.error(
      '[backoffice-deploy] up: reading namespace:internalHmacSecret from the staff-access-deploy stack ' +
        `failed (exit ${String(readInternalSecret.status)}) — staff-access up must run BEFORE backoffice ` +
        '(dependsOn at package.json). `nx run staff-access-deploy:local-up -c local` trước, rồi chạy lại.`',
    );
    process.exit(1);
  }
  const internalHmacSecret = readInternalSecret.stdout.trim();

  const secrets: ReadonlyArray<readonly [string, string]> = [
    ['namespace:runtimePassword', generatePostgresPassword()],
    ['namespace:migratorPassword', generatePostgresPassword()],
    // Giá trị đọc lại từ staff-access-deploy — hai stack dùng CHÍNH MỘT secret
    // envelope HMAC để ký envelope gọi staff-access management API.
    ['namespace:internalHmacSecret', internalHmacSecret],
  ];
  for (const [configKey, configValue] of secrets) {
    setStackConfig('backoffice-deploy', configKey, configValue, foundation);
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
      pulumiUpForEntry('backoffice-deploy', foundation);
    } catch (error) {
      console.error(
        `[backoffice-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
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
        '[backoffice-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('backoffice-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[backoffice-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[backoffice-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
