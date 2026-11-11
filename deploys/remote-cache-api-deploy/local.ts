/**
 * Entry lifecycle local của `remote-cache-api-deploy` — `up`/`down` trên stack
 * Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (unit phụ thuộc platform:local-up + build bundle app +
 * account-deploy:local-up + staff-access-deploy:local-up vì bước giải quyết
 * superadmin cần hai DB đó đã up).
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
 *
 * Hai mục bổ sung cho bootstrap tenant canonical (#20, ADR-0020 + ADR-0026):
 * - `ciKeyPlaintext`: plaintext của first trusted CI key — SET-IF-ABSENT nên
 *   ổn định qua mọi lần up của cùng environment (một plaintext một
 *   environment; rotation là hành động của người vận hành đổi giá trị trong
 *   stack config). Bootstrap chỉ lưu SHA-256 hash; plaintext nằm ở stack
 *   config cho smoke đọc lại khi chạy E2E.
 * - `tenantOwnerSub`: `sub` của administrator nền tảng (owner tenant
 *   `ecoma`), giải quyết trước khi `pulumi up` qua dx runner
 *   (`bootstrap-superadmin --resolve-if-bootstrapped`) chạy trong container
 *   ephemeral trên platform network — chỉ đọc nếu môi trường đã bootstrapped,
 *   fail-closed nếu không. `sub` là ĐỊNH DANH, không phải credential → giữ
 *   non-secret trong stack config.
 *
 * Hướng dữ liệu của `owner_sub`: platform postgres (migrator credential của
 * account-stacks, đọc qua `pulumi config get` cross-stack) → env của container
 * dx runner → `account.verify` + `staff-verify` (chỉ đọc) → `sub` → stack config
 * `namespace:tenantOwnerSub` của stack này → `conf.require` trong index.ts →
 * env `CANONICAL_TENANT_OWNER_SUB` của container bootstrap tenant.
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import {
  deployProjectDir,
  describeSpawnFailure,
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

// Module thuần túy dựng lời gọi Docker — hằng + argv/env của bước superadmin
// sống ở đó để spec colocated chấm được contract "credential KHÔNG nằm trong
// argv" mà không import entry này (entry tự chạy `main()` lúc load).
import {
  ACCOUNT_DATABASE,
  ACCOUNT_MIGRATOR_ROLE,
  buildMigratorDatabaseUrl,
  buildSuperadminResolverInvocation,
  STAFF_ACCESS_DATABASE,
  STAFF_ACCESS_MIGRATOR_ROLE,
} from './superadmin-resolver.js';

/** Stack platform — output `networkName` + secret key object storage. */
const PLATFORM_PROJECT = 'platform-deploy';
/** Stack account + staff-access — credential migrator được đọc cross-stack. */
const ACCOUNT_DEPLOY_PROJECT = 'account-deploy';
const STAFF_ACCESS_DEPLOY_PROJECT = 'staff-access-deploy';

/** Tên config chứa migrator password (mỗi stack sinh và set ở lần up của chính nó). */
const MIGRATOR_PASSWORD_CONFIG_KEY = 'namespace:migratorPassword';

/** Key stack config của platform chứa secret key object storage của remote-cache. */
const PLATFORM_OBJECT_STORAGE_SECRET_KEY = 'objectStorage:remoteCacheSecretKey';

/** Key stack config của CHÍNH unit chứa plaintext của first trusted CI key. */
const CI_KEY_PLAINTEXT_CONFIG_KEY = 'namespace:ciKeyPlaintext';

/**
 * Đọc một giá trị stack config cross-stack — trả `undefined` khi key chưa có,
 * throw khi đọc lỗi vì lý do khác (sai passphrase, state lock...).
 *
 * Tách hai trường hợp là bắt buộc: regen giá trị trên lỗi không phải "chưa có
 * key" sẽ ĐÈ credential đang tồn tại trong state và khoá container khỏi dữ
 * liệu đã init bằng giá trị cũ (xem `isConfigKeyMissing`).
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
  // Luật không-leak: raw output của `config get` có thể là chính secret — không
  // bao giờ ghép vào error string; người chạy tự chạy lại lệnh để xem stderr gốc.
  throw new Error(
    `reading ${configKey} from stack ${project} failed (exit ${String(read.status)}) — ` +
      `run \`pulumi config get ${configKey} --stack ${fullStackRef(project, foundation.ctx)}\` in ${deployProjectDir(project)} to see the original stderr`,
  );
}

/**
 * Mật khẩu migrator của một service-stack — đọc cross-stack.
 *
 * Stack đó chạy TRƯỚC stack này theo dependsOn, và nó xoay `migratorPassword`
 * ở đầu mỗi lần up của chính nó, nên giá trị đọc được ở đây luôn là giá trị
 * hiện hành mà database đó đang chấp nhận.
 */
function readMigratorPassword(foundation: EntryFoundation, project: string): string {
  const password = readStackConfig(foundation, project, MIGRATOR_PASSWORD_CONFIG_KEY);
  if (password === undefined) {
    throw new Error(
      `stack ${project} has no ${MIGRATOR_PASSWORD_CONFIG_KEY} — its local-up must run BEFORE remote-cache-api-deploy (Nx dependsOn); refusing to guess a credential`,
    );
  }
  return password;
}

/**
 * Tên platform network từ output `networkName` của stack platform.
 *
 * Output KHÔNG phải secret (tên network Docker), nên lỗi đọc được nêu stderr
 * gốc: platform chưa up hoặc chưa export output — cả hai đều là lỗi thứ tự
 * mà người chạy lane cần thấy ngay.
 */
function readPlatformNetwork(foundation: EntryFoundation): string {
  const read = exec(
    'pulumi',
    ['stack', 'output', 'networkName', '--stack', fullStackRef(PLATFORM_PROJECT, foundation.ctx)],
    deployProjectDir(PLATFORM_PROJECT),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) return read.stdout.trim();
  throw new Error(
    `reading platform output networkName failed (exit ${String(read.status)}): ${read.stderr}`,
  );
}

/**
 * Secret key object storage của remote-cache — ĐỌC LẠI từ stack config của
 * platform (cross-stack), cùng pattern secret HMAC internal của auth ← account:
 * platform (chạy trước theo `dependsOn`) SINH và PERSIST giá trị vào stack
 * config của chính nó khi up SeaweedFS; unit này đọc lại để bucket nhận đúng
 * MỘT giá trị. KHÔNG bao giờ sinh giá trị mới ở đây: giá trị khác với key thật
 * của object store là mọi request S3 chết 403 lúc runtime.
 */
function resolvePlatformObjectStorageSecret(foundation: EntryFoundation): string {
  const secret = readStackConfig(foundation, PLATFORM_PROJECT, PLATFORM_OBJECT_STORAGE_SECRET_KEY);
  if (secret !== undefined) {
    return secret;
  }
  console.error(
    '[remote-cache-api-deploy] up: reading ' +
      PLATFORM_OBJECT_STORAGE_SECRET_KEY +
      ' from the platform-deploy stack failed (key missing) — platform up must run BEFORE ' +
      'remote-cache-api-deploy (dependsOn) and must have provisioned the object store (#19). ' +
      'Run `pulumi config get ' +
      PLATFORM_OBJECT_STORAGE_SECRET_KEY +
      ' --stack <platform-stack-ref>` in deploys/platform-deploy to see the original stderr — the output of that command is ' +
      'never logged because it may contain the secret.',
  );
  process.exit(1);
}

/**
 * `ciKeyPlaintext` SET-IF-ABSENT — plaintext của first trusted CI key ổn định
 * theo environment.
 *
 * Có giá trị (exit 0 + non-empty) → giữ nguyên: hash đã lưu trong
 * `db-remote-cache` tiếp tục khớp, lần up sau là no-op verify. Key chưa có
 * (`config get` báo đúng lỗi missing) hoặc giá trị rỗng (exit 0 + empty —
 * unusable, và plaintext không phải credential database nên regen không khoá
 * ai khỏi dữ liệu; key cũ sẽ bị bootstrap revoke theo đúng contract rotation)
 * → sinh mới bằng API mật mã an toàn. Lỗi đọc khác → throw qua
 * `readStackConfig`, KHÔNG kèm raw output.
 */
function ensureStableCiKeyPlaintext(foundation: EntryFoundation): void {
  const existing = readStackConfig(
    foundation,
    'remote-cache-api-deploy',
    CI_KEY_PLAINTEXT_CONFIG_KEY,
  );
  if (existing !== undefined) return;
  setStackConfig(
    'remote-cache-api-deploy',
    CI_KEY_PLAINTEXT_CONFIG_KEY,
    generatePostgresPassword(),
    foundation,
  );
}

/**
 * Dòng JSON cuối cùng (không rỗng) của stdout — envelope kết quả của dx runner
 * ở chế độ `--json`. Không quét ngược tìm dòng parse được: dòng cuối bị cắt
 * cụt thì phải fail, không đọc nhầm một dòng cũ thành kết quả của lần chạy này.
 */
function parseResultEnvelope(stdout: string): Record<string, string> | undefined {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines[lines.length - 1];
  if (last === undefined || !last.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(last);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') record[key] = value;
      }
      return record;
    }
  } catch {
    // Dòng cuối không phải JSON — coi như không có envelope.
  }
  return undefined;
}

/**
 * Giải quyết administrator nền tảng TRƯỚC `pulumi up` — dx runner chạy trong
 * container ephemeral trên platform network (PostgreSQL không publish host port
 * nên chỉ kết nối được từ bên trong network — invariant platform).
 *
 * Container mounts: repo READ-ONLY (`/repo`) + `node_modules` gốc của repo
 * (`/repo/node_modules`) — đúng pattern migrate của index.ts, tsx binary và
 * `pg` resolve từ node_modules của repo. Hai credential (DATABASE_URL đã
 * percent-encoded) sống CHỈ trong env của process docker — argv Docker mang
 * TÊN biến dạng `-e TÊN` (pass-through env của Docker), KHÔNG mang giá trị:
 * argv đọc được qua `/proc/<pid>/cmdline` và `ps`; env của process hẹp hơn nhiều
 * (chỉ đọc được qua `/proc/<pid>/environ` của process đang sống, cùng user —
 * không tương đương kênh stdin của `pulumi config set`, nhưng là cơ chế
 * pass-through `-e TÊN` chuẩn của Docker). KHÔNG log giá trị.
 *
 * `--resolve-if-bootstrapped`: môi trường đã có administrator → chỉ đọc
 * (outcome `resolved`, không ghi gì); môi trường mới → procedure bootstrap
 * đầy đủ có guard đo được; bất kỳ thất bại nào → exit khác 0. Lane fail-closed:
 * không có `sub` thì không có `tenantOwnerSub` và `pulumi up` không được chạy —
 * tenant canonical không bao giờ được gán owner tùy ý.
 */
function resolveSuperadminOwnerSub(foundation: EntryFoundation): string {
  const accountUrl = buildMigratorDatabaseUrl(
    ACCOUNT_MIGRATOR_ROLE,
    readMigratorPassword(foundation, ACCOUNT_DEPLOY_PROJECT),
    ACCOUNT_DATABASE,
  );
  const staffUrl = buildMigratorDatabaseUrl(
    STAFF_ACCESS_MIGRATOR_ROLE,
    readMigratorPassword(foundation, STAFF_ACCESS_DEPLOY_PROJECT),
    STAFF_ACCESS_DATABASE,
  );

  const invocation = buildSuperadminResolverInvocation(
    foundation,
    readPlatformNetwork(foundation),
    accountUrl,
    staffUrl,
  );
  const result = exec('docker', invocation.args, invocation.cwd, invocation.env);

  if (result.error !== undefined) {
    throw new Error(
      `starting the superadmin resolver container failed: ${describeSpawnFailure(result)}`,
    );
  }

  const envelope = parseResultEnvelope(result.stdout);
  if (envelope === undefined) {
    // Không có envelope: không có bằng chứng chạy nào — fail với stderr của
    // docker/pulumi (progress text, không secret) để người chạy lane debug được.
    throw new Error(
      `superadmin resolver printed no JSON result envelope (exit ${String(result.status)}): ${result.stderr}`,
    );
  }
  const outcome = envelope['outcome'];
  if (outcome !== 'bootstrapped' && outcome !== 'resolved') {
    // outcome/failedStage/reason là mã máy đọc — an toàn để nêu trong lỗi.
    throw new Error(
      `superadmin resolution failed: outcome=${outcome ?? '<missing>'} failedStage=${envelope['failedStage'] ?? '<none>'} reason=${envelope['reason'] ?? '<none>'} — lane up is fail-closed`,
    );
  }
  const sub = envelope['sub'];
  if (sub === undefined || sub === '') {
    throw new Error(`superadmin resolution succeeded without a subject (outcome=${outcome})`);
  }
  console.error(
    `[remote-cache-api-deploy] superadmin ${outcome === 'resolved' ? 'resolved (read-only)' : 'bootstrapped'}: tenant ecoma owner sub resolved`,
  );
  return sub;
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
  // Plaintext key CI: set-if-absent — ổn định theo environment (một plaintext
  // một environment; rotation là hành động của người vận hành).
  ensureStableCiKeyPlaintext(foundation);
  // Owner sub của tenant ecoma: giải quyết qua dx runner (chỉ đọc trên môi
  // trường đã bootstrapped) rồi ghi vào stack config — sub là định danh, không
  // phải credential.
  const ownerSub = resolveSuperadminOwnerSub(foundation);
  setStackConfig('remote-cache-api-deploy', 'namespace:tenantOwnerSub', ownerSub, foundation);
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
