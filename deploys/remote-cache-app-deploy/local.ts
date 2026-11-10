/**
 * Entry lifecycle local của `remote-cache-app-deploy` — `up`/`down` trên stack
 * Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (unit này chỉ chờ `platform-deploy`).
 *
 * Chạy qua target Nx: `nx run remote-cache-app-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Đơn giản hơn `pact-broker-app-deploy`: app composition này không có secret,
 * nên `prepare` chỉ đảm bảo stack tồn tại — không `config set` gì cả. Toàn bộ
 * config mà chương trình Pulumi cần (`namespace:worktreeRoot`,
 * `namespace:platformStackRef`) do `pulumiUpForEntry` truyền qua `--config`.
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import {
  ensureStackForEntry,
  pulumiDestroyForEntry,
  pulumiUpForEntry,
  resolveEntryFoundation,
  type EntryFoundation,
} from '@ecoma-io/deployment';

async function prepare(foundation: EntryFoundation): Promise<void> {
  // Stack phải tồn tại trước lần up đầu trên worktree mới: state dir chưa có và
  // `pulumi` chưa có stack để select (xem `ensureStackForEntry`). Idempotent —
  // gọi mỗi lần up là an toàn, và `pulumiUpForEntry` với `prepareStack: true`
  // cũng tự gọi lại cùng helper.
  ensureStackForEntry('remote-cache-app-deploy', foundation);
}

async function main(command: string): Promise<number> {
  if (command === 'up') {
    const foundation = resolveEntryFoundation(true);
    if (foundation === undefined) {
      return 1;
    }
    try {
      await prepare(foundation);
      pulumiUpForEntry('remote-cache-app-deploy', foundation);
    } catch (error) {
      console.error(
        `[remote-cache-app-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
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
        '[remote-cache-app-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('remote-cache-app-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[remote-cache-app-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[remote-cache-app-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
