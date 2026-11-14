/**
 * Entry lifecycle local của `pact-broker-app-deploy` — `up`/`down` trên stack
 * Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (platform + auth + api chạy trước; auth vì đọc client id
 * cross-stack, api vì BFF gọi API qua alias nội bộ và thứ tự provision database
 * lane-wise).
 *
 * Chạy qua target Nx: `nx run pact-broker-app-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Secret bảng của app (stack config lưu plaintext, ranh giới bảo mật là file
 * state được mã hóa bởi passphrase worktree):
 * - Mật khẩu 2 role PostgreSQL của `db-pact-broker-app` — sinh ngẫu nhiên bằng
 *   API mật mã an toàn, xoay mỗi lần up là vô hại vì role được guard-create/
 *   ALTER trong cùng lần up đó (#206, ADR-0031 §2: unit sở hữu database riêng).
 *
 * ⚠️ `apiToken` KHÔNG còn tồn tại: machine token của BFF bị retire hoàn toàn
 * (ADR-0031 §5, #206) — BFF forward access token của chủ phiên. Không còn đọc
 * secret nào từ stack `pact-broker-api-deploy`.
 *
 * Cross-stack KHÔNG-secret: `namespace:pactBrokerAppClientId` đọc từ stack
 * `auth-deploy` (auth seed client public `pact-broker-app` và persist client id
 * khi up của nó) rồi persist vào stack config của stack này cho chương trình
 * Pulumi đọc (`conf.require`). `client_id` là định danh công khai OAuth.
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

/** Stack auth-deploy — nguồn của client id `pact-broker-app` (#206). */
const AUTH_DEPLOY_PROJECT = 'auth-deploy';

/** Tên config chứa client id ở cả hai stack (auth persist, app đọc lại). */
const PACT_BROKER_APP_CLIENT_ID_CONFIG_KEY = 'namespace:pactBrokerAppClientId';

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
 * Client id `pact-broker-app` từ stack auth-deploy — fail-closed khi thiếu:
 * auth up chạy trước theo dependsOn và luôn persist key, nên không có key là
 * lỗi thứ tự lane chứ không phải trạng thái hợp lệ.
 */
function resolvePactBrokerAppClientId(foundation: EntryFoundation): string {
  const clientId = readStackConfig(
    foundation,
    AUTH_DEPLOY_PROJECT,
    PACT_BROKER_APP_CLIENT_ID_CONFIG_KEY,
  );
  if (clientId === undefined) {
    throw new Error(
      `stack ${AUTH_DEPLOY_PROJECT} has no ${PACT_BROKER_APP_CLIENT_ID_CONFIG_KEY} — its local-up must run BEFORE pact-broker-app-deploy (Nx dependsOn); refusing to guess an OAuth client id`,
    );
  }
  return clientId;
}

async function prepare(foundation: EntryFoundation): Promise<void> {
  // Stack phải tồn tại trước khi `config set` — lần up đầu trên worktree mới,
  // state dir chưa có và mọi lệnh config exit 1 (xem `ensureStackForEntry`).
  // Đọc cross-stack của auth stack KHÔNG cần bước này: auth up chạy trước theo
  // dependsOn nên stack của nó đã có.
  ensureStackForEntry('pact-broker-app-deploy', foundation);
  // Mật khẩu 2 role của db-pact-broker-app: xoay mỗi lần up — role được
  // provision script của chương trình ALTER lại trong cùng lần up đó.
  setStackConfig(
    'pact-broker-app-deploy',
    'namespace:runtimePassword',
    generatePostgresPassword(),
    foundation,
  );
  setStackConfig(
    'pact-broker-app-deploy',
    'namespace:migratorPassword',
    generatePostgresPassword(),
    foundation,
  );
  // Client id OAuth (định danh công khai, không secret): đọc cross-stack từ
  // auth rồi persist cho `conf.require` của chương trình.
  const clientId = resolvePactBrokerAppClientId(foundation);
  setStackConfig(
    'pact-broker-app-deploy',
    PACT_BROKER_APP_CLIENT_ID_CONFIG_KEY,
    clientId,
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
      pulumiUpForEntry('pact-broker-app-deploy', foundation);
    } catch (error) {
      console.error(
        `[pact-broker-app-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
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
        '[pact-broker-app-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('pact-broker-app-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[pact-broker-app-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[pact-broker-app-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
