/**
 * Entry lifecycle local của `pact-broker-api-deploy` — `up`/`down` trên stack
 * Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (api phụ thuộc platform + build bundle app).
 *
 * Chạy qua target Nx: `nx run pact-broker-api-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Secret bảng của api:
 * - Mật khẩu 2 role PostgreSQL (runtime/migrator) — sinh ngẫu nhiên bằng API
 *   mật mã an toàn, xoay mỗi lần up là vô hại vì role được guard-create/ALTER
 *   trong cùng lần up đó.
 * - `machineToken`: PERSISTOR của token machine plaintext mà consumer local
 *   (`pact-broker-app-deploy`) đọc lại qua cross-stack `config get` — api chỉ
 *   seed HASH SHA-256 vào DB (`machine_token_hash`), plaintext sống duy nhất
 *   ở stack config (cùng hình auth đọc `internalHmacSecret` từ account stack).
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
  ensureStackForEntry('pact-broker-api-deploy', foundation);
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ['namespace:runtimePassword', generatePostgresPassword()],
    ['namespace:migratorPassword', generatePostgresPassword()],
    // Machine token plaintext của consumer local (`pact-broker-app`): stack
    // này seed HASH SHA-256 vào DB; plaintext nằm ở stack config để unit
    // pact-app đọc qua cross-stack `pulumi config get`.
    ['namespace:machineToken', generatePostgresPassword()],
  ];
  for (const [configKey, configValue] of secrets) {
    setStackConfig('pact-broker-api-deploy', configKey, configValue, foundation);
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
      pulumiUpForEntry('pact-broker-api-deploy', foundation);
    } catch (error) {
      console.error(
        `[pact-broker-api-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
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
        '[pact-broker-api-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('pact-broker-api-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[pact-broker-api-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[pact-broker-api-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
