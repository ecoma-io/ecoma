/**
 * Entry lifecycle local của `remote-cache-app-deploy` — `up`/`down` trên stack
 * Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (platform + auth + remote-cache-api chạy trước: auth vì đọc
 * client id cross-stack, remote-cache-api vì BFF gọi API qua alias nội bộ VÀ
 * đọc `internalHmacSecret` cross-stack từ stack đó).
 *
 * Chạy qua target Nx: `nx run remote-cache-app-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Secret bảng của app (stack config lưu plaintext, ranh giới bảo mật là file
 * state được mã hóa bởi passphrase worktree):
 * - Mật khẩu 2 role PostgreSQL của `db-remote-cache-app` — sinh ngẫu nhiên bằng
 *   API mật mã an toàn, xoay mỗi lần up là vô hại vì role được guard-create/
 *   ALTER trong cùng lần up đó (#180, ADR-0035: unit sở hữu database riêng).
 *
 * Cross-stack KHÔNG-secret: `namespace:remoteCacheAppClientId` đọc từ stack
 * `auth-deploy` (auth seed client public `remote-cache-app` và persist client id
 * khi up của nó) rồi persist vào stack config của stack này cho chương trình
 * Pulumi đọc (`conf.require`). `client_id` là định danh công khai OAuth.
 *
 * Cross-stack SECRET: `namespace:internalHmacSecret` đọc từ stack
 * `remote-cache-api-deploy` (producer sinh mỗi lần up của nó; up của unit này
 * chạy SAU theo dependsOn nên giá trị đã tồn tại) rồi persist — BFF và control
 * plane nhận ĐÚNG MỘT giá trị. Log-safety như `backoffice-deploy`: raw stdout
 * của `config get` thành công CHÍNH LÀ secret — không bao giờ ghép vào error.
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import {
  deployProjectDir,
  ensureStackForEntry,
  exec,
  fullStackRef,
  generatePostgresPassword,
  isConfigKeyMissing,
  pulumiDestroyForEntry,
  pulumiUpForEntry,
  resolveEntryFoundation,
  setStackConfig,
  type EntryFoundation,
} from '@ecoma-io/deployment';

/** Stack auth-deploy — nguồn của client id `remote-cache-app` (#180). */
const AUTH_DEPLOY_PROJECT = 'auth-deploy';

/** Stack remote-cache-api-deploy — nguồn của secret HMAC nội bộ (ADR-0034). */
const REMOTE_CACHE_API_DEPLOY_PROJECT = 'remote-cache-api-deploy';

/** Tên config chứa client id ở cả hai stack (auth persist, app đọc lại). */
const REMOTE_CACHE_APP_CLIENT_ID_CONFIG_KEY = 'namespace:remoteCacheAppClientId';

/** Tên config chứa secret HMAC nội bộ ở cả hai stack (api persist, app đọc lại). */
const INTERNAL_HMAC_SECRET_CONFIG_KEY = 'namespace:internalHmacSecret';

/**
 * Đọc một giá trị stack config cross-stack — trả `undefined` khi key chưa có,
 * throw khi đọc lỗi vì lý do khác (sai passphrase, state lock...).
 *
 * Luật không-leak áp cả với giá trị không-secret: raw stdout của `config get`
 * thành công không bao giờ được ghép vào error string — quy ước duy nhất cho
 * mọi đường `config get` của lane.
 */
function readStackConfig(
  foundation: EntryFoundation,
  project: string,
  configKey: string,
): string | undefined {
  const read = exec(
    'pulumi',
    ['config', 'get', configKey, '--stack', fullStackRef(project, foundation.ctx)],
    deployProjectDir(project),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) return read.stdout.trim();
  if (read.status === 0 || isConfigKeyMissing(read)) return undefined;
  throw new Error(
    `reading ${configKey} from stack ${project} failed (exit ${String(read.status)}) — ` +
      `run \`pulumi config get ${configKey} --stack ${fullStackRef(project, foundation.ctx)}\` in ${deployProjectDir(project)} to see the original stderr`,
  );
}

/**
 * Client id `remote-cache-app` từ stack auth-deploy — fail-closed khi thiếu:
 * auth up chạy trước theo dependsOn và luôn persist key, nên không có key là
 * lỗi thứ tự lane chứ không phải trạng thái hợp lệ.
 */
function resolveRemoteCacheAppClientId(foundation: EntryFoundation): string {
  const clientId = readStackConfig(
    foundation,
    AUTH_DEPLOY_PROJECT,
    REMOTE_CACHE_APP_CLIENT_ID_CONFIG_KEY,
  );
  if (clientId === undefined) {
    throw new Error(
      `stack ${AUTH_DEPLOY_PROJECT} has no ${REMOTE_CACHE_APP_CLIENT_ID_CONFIG_KEY} — its local-up must run BEFORE remote-cache-app-deploy (Nx dependsOn); refusing to guess an OAuth client id`,
    );
  }
  return clientId;
}

/**
 * Secret HMAC nội bộ từ stack remote-cache-api-deploy — fail-closed khi thiếu
 * (lỗi thứ tự lane). Log-safety: raw output của `config get` có thể là chính
 * secret — không bao giờ ghép vào error string.
 */
function resolveInternalHmacSecret(foundation: EntryFoundation): string {
  const secret = readStackConfig(
    foundation,
    REMOTE_CACHE_API_DEPLOY_PROJECT,
    INTERNAL_HMAC_SECRET_CONFIG_KEY,
  );
  if (secret === undefined) {
    throw new Error(
      `stack ${REMOTE_CACHE_API_DEPLOY_PROJECT} has no ${INTERNAL_HMAC_SECRET_CONFIG_KEY} — its local-up must run BEFORE remote-cache-app-deploy (Nx dependsOn); refusing to guess the internal HMAC secret`,
    );
  }
  return secret;
}

async function prepare(foundation: EntryFoundation): Promise<void> {
  // Stack phải tồn tại trước khi `config set` — lần up đầu trên worktree mới,
  // state dir chưa có và mọi lệnh config exit 1 (xem `ensureStackForEntry`).
  // Đọc cross-stack của auth/api stack KHÔNG cần bước này: up của chúng chạy
  // trước theo dependsOn nên stack đã có.
  ensureStackForEntry('remote-cache-app-deploy', foundation);
  // Mật khẩu 2 role của db-remote-cache-app: xoay mỗi lần up — role được
  // provision script của chương trình ALTER lại trong cùng lần up đó.
  setStackConfig(
    'remote-cache-app-deploy',
    'namespace:runtimePassword',
    generatePostgresPassword(),
    foundation,
  );
  setStackConfig(
    'remote-cache-app-deploy',
    'namespace:migratorPassword',
    generatePostgresPassword(),
    foundation,
  );
  // Client id OAuth (định danh công khai, không secret): đọc cross-stack từ
  // auth rồi persist cho `conf.require` của chương trình.
  const clientId = resolveRemoteCacheAppClientId(foundation);
  setStackConfig(
    'remote-cache-app-deploy',
    REMOTE_CACHE_APP_CLIENT_ID_CONFIG_KEY,
    clientId,
    foundation,
  );
  // Secret HMAC nội bộ (secret: đọc cross-stack từ remote-cache-api rồi persist
  // qua STDIN của helper — không argv, không log).
  const internalSecret = resolveInternalHmacSecret(foundation);
  setStackConfig(
    'remote-cache-app-deploy',
    INTERNAL_HMAC_SECRET_CONFIG_KEY,
    internalSecret,
    foundation,
  );
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
