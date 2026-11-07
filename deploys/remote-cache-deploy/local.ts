/**
 * Entry lifecycle local của `remote-cache-deploy` — `up`/`down` trên stack
 * Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (unit phụ thuộc platform:local-up + build bundle app).
 *
 * Chạy qua target Nx: `nx run remote-cache-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Secret bảng của unit (P4.1 #442): mật khẩu 2 role PostgreSQL của
 * `db-remote-cache` (runtime/migrator) — sinh ngẫu nhiên bằng API mật mã an
 * toàn, xoay mỗi lần up là vô hại vì role được guard-create/ALTER trong cùng
 * lần up đó. KHÔNG có secret chia sẻ cross-stack nào: consumer đầu tiên của
 * Remote Cache chưa tồn tại ở local (control plane skeleton, P4.1).
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import {
  ensureStackForEntry,
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
  ensureStackForEntry('remote-cache-deploy', foundation);
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ['namespace:runtimePassword', generatePostgresPassword()],
    ['namespace:migratorPassword', generatePostgresPassword()],
  ];
  for (const [configKey, configValue] of secrets) {
    setStackConfig('remote-cache-deploy', configKey, configValue, foundation);
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
      pulumiUpForEntry('remote-cache-deploy', foundation);
    } catch (error) {
      console.error(
        `[remote-cache-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
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
        '[remote-cache-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('remote-cache-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[remote-cache-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[remote-cache-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
