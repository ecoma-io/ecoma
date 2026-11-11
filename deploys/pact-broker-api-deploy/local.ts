/**
 * Entry lifecycle local của `pact-broker-api-deploy` — `up`/`down` trên stack
 * Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (api phụ thuộc platform + build bundle app + account-deploy +
 * staff-access-deploy vì bước giải quyết superadmin cần hai DB đó đã up).
 *
 * Chạy qua target Nx: `nx run pact-broker-api-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Secret bảng của api (stack config lưu plaintext, ranh giới bảo mật là file
 * state được mã hóa bởi passphrase worktree):
 * - Mật khẩu 2 role PostgreSQL (runtime/migrator) — sinh ngẫu nhiên bằng API
 *   mật mã an toàn, xoay mỗi lần up là vô hại vì role được guard-create/ALTER
 *   trong cùng lần up đó.
 * - `machineToken`: plaintext token máy của consumer local `pact-broker-app`,
 *   SET-IF-ABSENT nên ổn định qua mọi lần up của cùng environment (một plaintext
 *   một environment; rotation là hành động của người vận hành). Stack api chỉ
 *   cấp token vào DB qua script service-owned; plaintext nằm ở stack config
 *   cho unit pact-app đọc qua cross-stack `config get` (cùng hình auth đọc
 *   `internalHmacSecret` từ account stack).
 * - `tenantOwnerSub`: `sub` của superadmin tenant `ecoma`, giải quyết trước
 *   khi `pulumi up` qua dx runner (`bootstrap-superadmin --resolve-if-bootstrapped`)
 *   chạy trong container ephemeral trên platform network — chỉ đọc nếu môi
 *   trường đã bootstrapped, fail-closed nếu không. `sub` là ĐỊNH DANH, không
 *   phải credential → giữ non-secret trong stack config.
 *
 * Hướng dữ liệu của `owner_sub`: platform postgres (migrator credential của
 * account-stacks, đọc qua `pulumi config get` cross-stack) → env của container
 * dx runner → `account.verify` + `staff-verify` (chỉ đọc) → `sub` → stack config
 * `namespace:tenantOwnerSub` của stack api → `conf.require` trong index.ts →
 * env `CANONICAL_TENANT_OWNER_SUB` của container provision tenant.
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

/** Stack account + staff-access — credential migrator được đọc cross-stack. */
const ACCOUNT_DEPLOY_PROJECT = 'account-deploy';
const STAFF_ACCESS_DEPLOY_PROJECT = 'staff-access-deploy';

/** Tên config chứa migrator password (mỗi stack sinh và set ở lần up của chính nó). */
const MIGRATOR_PASSWORD_CONFIG_KEY = 'namespace:migratorPassword';

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
      `stack ${project} has no ${MIGRATOR_PASSWORD_CONFIG_KEY} — its local-up must run BEFORE pact-broker-api-deploy (Nx dependsOn); refusing to guess a credential`,
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
    ['stack', 'output', 'networkName', '--stack', fullStackRef('platform-deploy', foundation.ctx)],
    deployProjectDir('platform-deploy'),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) return read.stdout.trim();
  throw new Error(
    `reading platform output networkName failed (exit ${String(read.status)}): ${read.stderr}`,
  );
}

/**
 * `machineToken` SET-IF-ABSENT — plaintext ổn định theo environment.
 *
 * Có giá trị (exit 0 + non-empty) → giữ nguyên: mọi container consumer đang
 * cầm plaintext đó vẫn hợp lệ sau lần up này. Key chưa có (`config get` báo
 * đúng lỗi missing) hoặc giá trị rỗng (exit 0 + empty — unusable, và token
 * không phải credential database nên regen không khoá ai khỏi dữ liệu) →
 * sinh mới bằng API mật mã an toàn. Lỗi đọc khác → throw qua
 * `readStackConfig`, KHÔNG kèm raw output.
 */
function ensureStableMachineToken(foundation: EntryFoundation): void {
  const existing = readStackConfig(foundation, 'pact-broker-api-deploy', 'namespace:machineToken');
  if (existing !== undefined) return;
  setStackConfig(
    'pact-broker-api-deploy',
    'namespace:machineToken',
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
 * Giải quyết superadmin tenant `ecoma` TRƯỚC `pulumi up` — dx runner chạy
 * trong container ephemeral trên platform network (PostgreSQL không publish
 * host port nên chỉ kết nối được từ bên trong network — invariant platform).
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
 * không có `sub` thì không có `tenantOwnerSub` và `pulumi up` không được chạy.
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
    `[pact-broker-api-deploy] superadmin ${outcome === 'resolved' ? 'resolved (read-only)' : 'bootstrapped'}: tenant ecoma owner sub resolved`,
  );
  return sub;
}

async function prepare(foundation: EntryFoundation): Promise<void> {
  // Stack phải tồn tại trước khi `config set` — lần up đầu trên worktree mới,
  // state dir chưa có và mọi lệnh config exit 1 (xem `ensureStackForEntry`).
  ensureStackForEntry('pact-broker-api-deploy', foundation);
  // Mật khẩu 2 role: xoay mỗi lần up — hành vi giữ nguyên từ bản trước.
  setStackConfig(
    'pact-broker-api-deploy',
    'namespace:runtimePassword',
    generatePostgresPassword(),
    foundation,
  );
  setStackConfig(
    'pact-broker-api-deploy',
    'namespace:migratorPassword',
    generatePostgresPassword(),
    foundation,
  );
  // Token máy: set-if-absent — plaintext ổn định theo environment.
  ensureStableMachineToken(foundation);
  // Owner sub của tenant ecoma: giải quyết qua dx runner (chỉ đọc trên môi
  // trường đã bootstrapped) rồi ghi vào stack config — sub là định danh, không
  // phải credential.
  const ownerSub = resolveSuperadminOwnerSub(foundation);
  setStackConfig('pact-broker-api-deploy', 'namespace:tenantOwnerSub', ownerSub, foundation);
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
