/**
 * Entry lifecycle local của `llm-api-deploy` — `up`/`down` trên stack Pulumi
 * của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (unit phụ thuộc platform:local-up + build bundle WASM của app).
 *
 * Chạy qua target Nx: `nx run llm-api-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Secret bảng của unit (issue #22 + #23): mật khẩu 6 role PostgreSQL của ba
 * database `db-llm-gateway`/`db-llm-tenant`/`db-llm-marketplace` (migrator/
 * runtime mỗi DB) — sinh ngẫu nhiên bằng API mật mã an toàn, xoay mỗi lần up
 * là vô hại vì role được guard-create/ALTER trong cùng lần up đó. KHÔNG có
 * secret chia sẻ cross-stack nào: `ecoma_owner` là role dùng chung nhưng
 * password của nó thuộc account-deploy — stack này guard-create, không giữ
 * password. `llmUpstreamCredentialPlaintext` (credential upstream cho runner
 * bootstrap 8b) là plaintext ổn định theo environment (set-if-absent) — xoay
 * nó là xoay credential row trong `provider_credentials` (revoke cũ, thêm
 * mới) nên nó phải giữ nguyên giữa các lần up trừ khi người chạy đổi chủ đích.
 *
 * Bootstrap config (issue #23, ADR-0020 Quyết định 13):
 * - `tenantOwnerSub`: `sub` của superadmin tenant `ecoma` — giải quyết TRƯỚC
 *   `pulumi up` qua dx runner (`bootstrap-superadmin --resolve-if-bootstrapped`),
 *   đúng pattern của pact-broker-api-deploy. Runner bootstrap 8a cần nó làm
 *   owner của Seller tenant canonical `dronie`.
 * - Fact pháp lý/thuế + con trỏ evidence của principal first_party: giá trị
 *   provisioning của lane local (set-if-absent, ghi đè được bằng
 *   `pulumi config set`); tài liệu authoritative thật nằm ngoài repo.
 * - `llmUpstream*`: upstream thật cho smoke probe của 8b. Default baseUrl trỏ
 *   `http://llm-upstream.invalid` (TLD reserved) — probe thất bại là offer ở
 *   `draft` (fail-closed serving, exit 0); đặt upstream thật + key thật rồi up
 *   lại là rotation/activation chạy đúng đường đã test.
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
 * Đọc một giá trị stack config — trả `undefined` khi key chưa có, throw khi
 * đọc lỗi vì lý do khác (sai passphrase, state lock...).
 *
 * Tách hai trường hợp là bắt buộc: regen giá trị trên lỗi không phải "chưa có
 * key" sẽ ĐÈ credential đang tồn tại trong state (xem `isConfigKeyMissing`).
 */
function readStackConfig(foundation: EntryFoundation, configKey: string): string | undefined {
  const read = exec(
    'pulumi',
    ['config', 'get', configKey, '--stack', fullStackRef('llm-api-deploy', foundation.ctx)],
    deployProjectDir('llm-api-deploy'),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) return read.stdout.trim();
  if (read.status === 0 || isConfigKeyMissing(read)) return undefined;
  // Luật không-leak: raw output của `config get` có thể là chính secret — không
  // bao giờ ghép vào error string; người chạy tự chạy lại lệnh để xem stderr gốc.
  throw new Error(
    `reading ${configKey} failed (exit ${String(read.status)}) — ` +
      `run \`pulumi config get ${configKey} --stack ${fullStackRef('llm-api-deploy', foundation.ctx)}\` in ${deployProjectDir('llm-api-deploy')} to see the original stderr`,
  );
}

/** Cross-stack variant — đọc config của stack unit khác (account/staff-access). */
function readCrossStackConfig(
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
 * Mật khẩu migrator của một service-stack — đọc cross-stack.
 *
 * Stack đó chạy TRƯỚC stack này theo dependsOn, và nó xoay `migratorPassword`
 * ở đầu mỗi lần up của chính nó, nên giá trị đọc được ở đây luôn là giá trị
 * hiện hành mà database đó đang chấp nhận.
 */
function readMigratorPassword(foundation: EntryFoundation, project: string): string {
  const password = readCrossStackConfig(foundation, project, MIGRATOR_PASSWORD_CONFIG_KEY);
  if (password === undefined) {
    throw new Error(
      `stack ${project} has no ${MIGRATOR_PASSWORD_CONFIG_KEY} — its local-up must run BEFORE llm-api-deploy (Nx dependsOn); refusing to guess a credential`,
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
 * Config SET-IF-ABSENT — giá trị ổn định theo environment. Có giá trị → giữ
 * nguyên (bootstrap runner sẽ verify immutables và no-op); key chưa có → set
 * giá trị mặc định của lane. Lỗi đọc khác → throw qua `readStackConfig`.
 */
function ensureStableConfig(foundation: EntryFoundation, configKey: string, value: string): void {
  if (readStackConfig(foundation, configKey) !== undefined) return;
  setStackConfig('llm-api-deploy', configKey, value, foundation);
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
 * Container mounts: repo READ-ONLY (`/repo`) + `node_modules` gốc của repo —
 * đúng pattern migrate của index.ts. Hai credential (DATABASE_URL đã
 * percent-encoded) sống CHỈ trong env của process docker — argv Docker mang
 * TÊN biến dạng `-e TÊN`, KHÔNG mang giá trị (chi tiết ở superadmin-resolver.ts).
 *
 * `--resolve-if-bootstrapped`: môi trường đã có administrator → chỉ đọc
 * (outcome `resolved`); môi trường mới → procedure bootstrap đầy đủ. Bất kỳ
 * thất bại nào → exit khác 0, lane fail-closed: không có `sub` thì không có
 * `tenantOwnerSub` và `pulumi up` không được chạy.
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
    `[llm-api-deploy] superadmin ${outcome === 'resolved' ? 'resolved (read-only)' : 'bootstrapped'}: tenant ecoma owner sub resolved`,
  );
  return sub;
}

/**
 * Fact provisioning của principal first_party trên lane local — set-if-absent,
 * ghi đè được bằng `pulumi config set` trước khi up. Giá trị mặc định khớp
 * định danh Ecoma-io (ADR-0027 §3); hash evidence là placeholder của lane —
 * tài liệu authoritative thật nằm ngoài repo.
 */
const BOOTSTRAP_CONFIG_DEFAULTS: Readonly<Record<string, string>> = {
  'namespace:bootstrapActor': 'ecoma-bootstrap',
  'namespace:firstPartyLegalName': 'Ecoma-io Company Limited',
  'namespace:firstPartyLegalType': 'company',
  'namespace:firstPartyJurisdiction': 'VN',
  'namespace:firstPartyRegistrationReference': '0312345678',
  'namespace:firstPartyTaxResidency': 'VN',
  'namespace:firstPartyTaxIdentifier': 'PQN0312345678',
  'namespace:firstPartyDeclarationReference': 'tax-declaration-2026-01',
  'namespace:legalEvidenceStorageRef': 'vault://ecoma-authoritative/legal-profile-2026.pdf',
  'namespace:legalEvidenceContentHash':
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  'namespace:taxEvidenceStorageRef': 'vault://ecoma-authoritative/tax-declaration-2026.pdf',
  'namespace:taxEvidenceContentHash':
    'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  // Upstream thật cho smoke probe của 8b: mặc định .invalid (TLD reserved) —
  // probe thất bại → offer ở draft, deploy vẫn xanh (fail-closed serving).
  'namespace:llmUpstreamProvider': 'dronie-upstream',
  'namespace:llmUpstreamModel': 'Dronie-Flash',
  'namespace:llmUpstreamProtocol': 'openai_chat',
  'namespace:llmUpstreamBaseUrl': 'http://llm-upstream.invalid',
  // Credential plaintext: random set-if-absent — đổi thật bằng
  // `pulumi config set namespace:llmUpstreamCredentialPlaintext <key>` rồi up
  // lại; runner 8b sẽ rotation (revoke cũ, thêm mới), không bao giờ xoá.
  'namespace:llmUpstreamCredentialPlaintext': generatePostgresPassword(),
};

async function prepare(foundation: EntryFoundation): Promise<void> {
  // Stack phải tồn tại trước khi `config set` — lần up đầu trên worktree mới,
  // state dir chưa có và mọi lệnh config exit 1 (xem `ensureStackForEntry`).
  ensureStackForEntry('llm-api-deploy', foundation);
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ['namespace:gatewayMigratorPassword', generatePostgresPassword()],
    ['namespace:gatewayRuntimePassword', generatePostgresPassword()],
    ['namespace:tenantMigratorPassword', generatePostgresPassword()],
    ['namespace:tenantRuntimePassword', generatePostgresPassword()],
    ['namespace:marketplaceMigratorPassword', generatePostgresPassword()],
    ['namespace:marketplaceRuntimePassword', generatePostgresPassword()],
  ];
  for (const [configKey, configValue] of secrets) {
    setStackConfig('llm-api-deploy', configKey, configValue, foundation);
  }
  // Owner sub của tenant ecoma: giải quyết qua dx runner (chỉ đọc trên môi
  // trường đã bootstrapped) rồi ghi vào stack config — sub là định danh, không
  // phải credential. Bootstrap 8a dùng nó làm owner của Seller tenant `dronie`.
  const ownerSub = resolveSuperadminOwnerSub(foundation);
  setStackConfig('llm-api-deploy', 'namespace:tenantOwnerSub', ownerSub, foundation);
  // Bootstrap config còn lại: set-if-absent — ổn định giữa các lần up.
  for (const [configKey, value] of Object.entries(BOOTSTRAP_CONFIG_DEFAULTS)) {
    ensureStableConfig(foundation, configKey, value);
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
      pulumiUpForEntry('llm-api-deploy', foundation);
    } catch (error) {
      console.error(
        `[llm-api-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
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
        '[llm-api-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('llm-api-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[llm-api-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[llm-api-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
