/**
 * Entry lifecycle local của `remote-cache-api-deploy` — `up`/`down` trên stack
 * Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (unit phụ thuộc platform:local-up + build bundle app).
 *
 * Chạy qua target Nx: `nx run remote-cache-api-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Secret bảng của unit (P4.1 #442): mật khẩu 2 role PostgreSQL của
 * `db-remote-cache` (runtime/migrator) — sinh ngẫu nhiên bằng API mật mã an
 * toàn, xoay mỗi lần up là vô hại vì role được guard-create/ALTER trong cùng
 * lần up đó. MỘT secret chia sẻ cross-stack (#19): secret key object storage —
 * ĐỌC LẠI từ stack config của platform (`objectStorage:remoteCacheSecretKey`,
 * platform sinh và persist khi up SeaweedFS) rồi COPY vào stack config của
 * chính unit này (`namespace:objectStorageSecretKey`) qua stdin
 * (`pulumi config set` không argv), cùng đường secret HMAC auth ← account.
 * Giá trị sau đó đi vào container qua kênh `envs` — không argv, không label,
 * không log.
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import {
  deployProjectDir,
  ensureStackForEntry,
  exec,
  fullStackRef,
  generatePostgresPassword,
  pulumiDestroyForEntry,
  pulumiUpForEntry,
  resolveEntryFoundation,
  setStackConfig,
  type EntryFoundation,
} from '@ecoma-io/deployment';

/**
 * Secret key object storage của remote-cache — ĐỌC LẠI từ stack config của
 * platform (cross-stack), cùng pattern secret HMAC internal của auth ← account:
 * platform (chạy trước theo `dependsOn`) SINH và PERSIST giá trị vào stack
 * config của chính nó khi up SeaweedFS; unit này đọc lại để bucket nhận đúng
 * MỘT giá trị. KHÔNG bao giờ sinh giá trị mới ở đây: giá trị khác với key thật
 * của object store là mọi request S3 chết 403 lúc runtime.
 *
 * KHÔNG nhúng raw stdout/stderr vào log: stdout của `pulumi config get` khi
 * exit 0 CHÍNH LÀ secret — nếu CLI đổi hành vi exit-code, raw output trong
 * error string là đường leak thật. Thông điệp cố định + hướng dẫn tự chạy lệnh.
 */
function resolvePlatformObjectStorageSecret(foundation: EntryFoundation): string {
  const read = exec(
    'pulumi',
    [
      'config',
      'get',
      'objectStorage:remoteCacheSecretKey',
      '--stack',
      fullStackRef('platform-deploy', foundation.ctx),
    ],
    deployProjectDir('platform-deploy'),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) {
    return read.stdout.trim();
  }
  console.error(
    '[remote-cache-api-deploy] up: reading objectStorage:remoteCacheSecretKey from the ' +
      'platform-deploy stack failed (exit ' +
      String(read.status) +
      ') — platform up must run BEFORE remote-cache-api-deploy (dependsOn) and must have ' +
      'provisioned the object store (#19). Run `pulumi config get ' +
      'objectStorage:remoteCacheSecretKey --stack <platform-stack-ref>` in ' +
      'deploys/platform-deploy to see the original stderr — the output of that command is ' +
      'never logged because it may contain the secret.',
  );
  process.exit(1);
}

async function prepare(foundation: EntryFoundation): Promise<void> {
  // Stack phải tồn tại trước khi `config set` — lần up đầu trên worktree mới,
  // state dir chưa có và mọi lệnh config exit 1 (xem `ensureStackForEntry`).
  ensureStackForEntry('remote-cache-api-deploy', foundation);
  const objectStorageSecretKey = resolvePlatformObjectStorageSecret(foundation);
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ['namespace:runtimePassword', generatePostgresPassword()],
    ['namespace:migratorPassword', generatePostgresPassword()],
    // Cross-stack copy: giá trị đọc từ stack config của platform (platform up
    // chạy trước theo dependsOn nên đã tồn tại) — set qua STDIN của helper
    // dùng chung, không bao giờ qua argv hay log.
    ['namespace:objectStorageSecretKey', objectStorageSecretKey],
  ];
  for (const [configKey, configValue] of secrets) {
    setStackConfig('remote-cache-api-deploy', configKey, configValue, foundation);
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
      pulumiUpForEntry('remote-cache-api-deploy', foundation);
    } catch (error) {
      console.error(
        `[remote-cache-api-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
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
        '[remote-cache-api-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('remote-cache-api-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[remote-cache-api-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[remote-cache-api-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
