/**
 * Entry lifecycle local của `staff-access-deploy` — `up`/`down` trên stack
 * Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (unit phụ thuộc platform:local-up + build bundle app).
 *
 * Chạy qua target Nx: `nx run staff-access-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Secret bảng của unit (P1.4 #428): mật khẩu 2 role PostgreSQL của
 * `db-staff-access` (runtime/migrator) — sinh ngẫu nhiên bằng API mật mã an
 * toàn, xoay mỗi lần up là vô hại vì role được guard-create/ALTER trong cùng
 * lần up đó. KHÔNG có secret chia sẻ cross-stack nào: chưa có consumer nội bộ
 * của Staff Access ở local (wiring BFF thuộc giai đoạn sau).
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
  ensureStackForEntry('staff-access-deploy', foundation);
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ['namespace:runtimePassword', generatePostgresPassword()],
    ['namespace:migratorPassword', generatePostgresPassword()],
    ['namespace:internalHmacSecret', generateInternalHmacSecret()],
  ];
  for (const [configKey, configValue] of secrets) {
    setStackConfig('staff-access-deploy', configKey, configValue, foundation);
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
      pulumiUpForEntry('staff-access-deploy', foundation);
    } catch (error) {
      console.error(
        `[staff-access-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
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
        '[staff-access-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('staff-access-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[staff-access-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[staff-access-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
