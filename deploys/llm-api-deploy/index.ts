/**
 * Chương trình Pulumi của `llm-api-deploy` — deploy unit của `apps/llm-api`
 * (data plane LLM, TypeScript qua Hyperdrive) ở LAN LOCAL deployment
 * (issue #22).
 *
 * Pattern: mirror `deploys/remote-cache-api-deploy/index.ts` (WIC — MỘT worker
 * `wrangler dev` qua `wic-entrypoint.sh`, provision DB + migration canonical)
 * và `deploys/auth-deploy/index.ts` (role `ecoma_owner` dùng chung guard-create
 * không ALTER password; revoke chéo điều kiện hoá theo database đích tồn tại).
 *
 * Provision ba database `db-llm-gateway`/`db-llm-tenant`/`db-llm-marketplace` +
 * sáu role `ecoma_llm_{t}_{migrator,runtime}` qua `docker exec` psql vào
 * container PostgreSQL của platform. Mật khẩu KHÔNG nằm trong script text hay
 * argv của process nào: chúng đi qua kênh `environment` của
 * `command.local.Command` (giá trị bọc `pulumi.secret` — state Pulumi mã hoá),
 * script chỉ chứa TÊN biến môi trường, và SQL `ALTER ROLE ... PASSWORD` được
 * dựng trong shell rồi nạp vào psql qua **STDIN** (`docker exec -i`, không
 * `-c`) — chi tiết kênh ở `scripts.ts`. Migration chạy **đường canonical**
 * (`apps/llm-api/db/apply.mts <target>` — advisory lock
 * `hashtext('db-llm-<target>')`, mọi DDL idempotent) bằng container node pin
 * chạy tsx của repo trên platform network, KHÔNG qua binding Hyperdrive
 * (HD6: Hyperdrive không hỗ trợ advisory lock); `DATABASE_URL` của migrator
 * cũng đi bằng kênh `environment` — `docker run -e DATABASE_URL` chỉ mang
 * TÊN biến trong argv, giá trị được docker CLI đọc từ environ của chính nó.
 *
 * WIC: MỘT worker `wrangler dev` (alias DNS `ecoma-llm-api`, cổng nội bộ 4211 —
 * `dev.port` của `apps/llm-api/wrangler.jsonc`) trên platform network, ba biến
 * `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*` đi vào bằng container envs
 * (pulumi.secret bọc trước interpolate — kênh duy nhất: không argv, không label,
 * không log); serving path (Issue #24 slice P4) đọc thêm bộ upstream khỏi cùng
 * kênh envs: `LLM_UPSTREAM_PROVIDER`, `LLM_UPSTREAM_BASE_URL` (output thường —
 * cấu hình không phải secret) và `LLM_UPSTREAM_CREDENTIAL_PLAINTEXT` (output
 * bọc pulumi.secret — plaintext credential của serving chỉ sống trong environ
 * container, worker verify hash rồi chỉ dùng cho header Authorization upstream).
 * KHÔNG Traefik route (worker nội bộ — chưa có hostname công khai
 * được chốt), KHÔNG publish cổng ra host. Readiness là liveness container:
 * healthcheck poll `GET /health` (không chạm DB — thiết kế của app).
 */

import * as command from '@pulumi/command';
import * as docker from '@pulumi/docker';
import * as dockerBuild from '@pulumi/docker-build';
import * as pulumi from '@pulumi/pulumi';

import {
  type PlatformOutputs,
  dockerResourceName,
  normalizeWorktreeRoot,
  ownershipLabels,
  worktreeNamespace,
} from '@ecoma-io/deployment';

import {
  DATABASES,
  type Database,
  BOOTSTRAP_CONSUMER_TENANT_ENV_VARS,
  BOOTSTRAP_FINANCIAL_ENV_VARS,
  BOOTSTRAP_GOVERNANCE_ENV_VARS,
  BOOTSTRAP_MARKETPLACE_ENV_VARS,
  buildBootstrapScript,
  buildMigrateScript,
  buildProvisionScript,
  dbName,
  extractConsumerTenantId,
  extractEligibilityVerdict,
  migratorRole,
  passwordEnvVar,
  runtimeRole,
} from './scripts.js';

/**
 * Image Node pin (theo DIGEST) để chạy migration trong container gắn platform
 * network — cùng digest mà `deploys/auth-deploy/Dockerfile` ghim.
 *
 * Vì sao container mà không chạy runner trên host: platform PostgreSQL KHÔNG
 * publish host port (invariant platform) và host không route được tới IP
 * container (platform facts PF5), nên `pg` của runner chỉ kết nối được từ bên
 * trong platform network. Container ephemeral chạy **tsx binary của repo** vẫn
 * là đúng một đường code canonical (`apps/llm-api/db/apply.mts`) — deploy không
 * tự viết lại vòng migration.
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/** Alias DNS của PostgreSQL platform trong network nội bộ. */
const POSTGRES_HOST = 'ecoma-postgres';

/**
 * Cổng HTTP nội bộ của worker `ecoma-llm-api` trong WIC — `dev.port` của
 * `apps/llm-api/wrangler.jsonc`. Bên trong container KHÔNG cần phát hiện xung
 * đột port host (mỗi container có network stack riêng — static port an toàn);
 * nguồn số duy nhất là wrangler.jsonc, Pulumi không cấp port. Alias DNS
 * `ecoma-llm-api` (hằng số) + port này là contract cho wiring consumer tương
 * lai: base URL `http://ecoma-llm-api:4211`. Wrangler đổi port là healthcheck
 * fail ngay (fail qua vòng đời container, không qua assertion compile-time).
 */
const LLM_API_INTERNAL_PORT = 4211;

/**
 * Alias DNS của WIC container trong platform network — HẰNG SỐ, không theo
 * namespace (khác auth dùng `ecoma-<ns>-auth`). Mỗi worktree có platform
 * network RIÊNG (namespace cô lập), nên alias hằng trong một network không xung
 * đột; hằng cho tên ổn định để unit consumer tương lai cấu hình base URL không
 * phụ thuộc namespace (cùng quyết định với remote-cache-api).
 */
const LLM_API_ALIAS = 'ecoma-llm-api';

const conf = new pulumi.Config('namespace');

const worktreeRoot = conf.require('worktreeRoot');
const ns = worktreeNamespace(worktreeRoot);

// Labels ownership: gắn lên MỌI Docker resource (image + container + volume)
// để `pnpm dx local-cleanup` phân loại được.
const labels = ownershipLabels(normalizeWorktreeRoot(worktreeRoot), ns);

const platform = new pulumi.StackReference(conf.require('platformStackRef'));

function requirePlatformOutput<K extends keyof PlatformOutputs>(
  key: K,
): pulumi.Output<PlatformOutputs[K]> {
  return pulumi.output(platform.getOutput(key)).apply((raw) => {
    if (raw === undefined || raw === null) {
      throw new Error(
        `platformStackRef does not export "${key}". Run \`pnpm nx run platform-deploy:local-up -c local\` (apply platform) first.`,
      );
    }
    return raw as PlatformOutputs[K];
  });
}

const networkName = requirePlatformOutput('networkName');
const platformNamespace = requirePlatformOutput('namespace');

const verifiedNamespace = pulumi.output(platformNamespace).apply((upstreamNs) => {
  if (upstreamNs !== ns) {
    throw new Error(
      `platformStackRef points to a stack of a different namespace: platform exports "${upstreamNs}" but this worktree is "${ns}".`,
    );
  }
  return ns;
});

// Mật khẩu sáu role — do orchestration sinh và truyền qua --config (stdin,
// không argv). Trigger provision gồm CẢ SÁU: đổi bất kỳ mật khẩu nào là provision
// chạy lại và áp lại toàn bộ.
const rolePasswords: Record<
  Database,
  { migrator: pulumi.Output<string>; runtime: pulumi.Output<string> }
> = {
  gateway: {
    migrator: conf.requireSecret('gatewayMigratorPassword'),
    runtime: conf.requireSecret('gatewayRuntimePassword'),
  },
  tenant: {
    migrator: conf.requireSecret('tenantMigratorPassword'),
    runtime: conf.requireSecret('tenantRuntimePassword'),
  },
  marketplace: {
    migrator: conf.requireSecret('marketplaceMigratorPassword'),
    runtime: conf.requireSecret('marketplaceRuntimePassword'),
  },
};

const postgresContainerName = dockerResourceName(ns, 'postgres');

/**
 * Provision `ecoma_owner` (guard-create, KHÔNG ALTER password — account stack
 * sở hữu password của role dùng chung này; ALTER ở hai nơi là race xoá nhau) +
 * 3 database + 6 role + revoke chéo, chạy trên host qua `docker exec` vào
 * container PostgreSQL của platform. Idempotent như auth-deploy: guard-create
 * bằng shell `if`, ALTER password idempotent sẵn — chạy cả `create` và `update`
 * để redeploy cũng áp cấu hình mới (giá trị stack config không đổi giữa các
 * lần up thì ALTER áp lại cùng giá trị, KHÔNG rotate).
 *
 * Script text là ĐẦU RA của hàm thuần `buildProvisionScript` (`scripts.ts`) và
 * KHÔNG chứa giá trị secret nào: mật khẩu sáu role đi vào tiến trình shell qua
 * map `environment` của `command.local.Command` (dưới), script chỉ đọc TÊN
 * biến, dựng SQL `ALTER ROLE ... PASSWORD` trong shell và nạp psql qua STDIN
 * (`docker exec -i`) — giá trị không nằm trong argv của `sh -c`, của
 * `docker exec`, của `psql`, cũng như trong `create`/`update` (plain input)
 * mà Pulumi lưu trong state. Đổi hàm build hay đổi kênh truyền phải qua test
 * argv-hygiene (`tests/integrations/`) — nó chạy đúng script text này.
 */
const provisionScript = buildProvisionScript({ postgresContainerName });

/**
 * Map `environment` của provision — kênh truyền mật khẩu DUY NHẤT: provider
 * đặt từng giá trị vào environ của tiến trình chạy script (không argv). Giá
 * trị là output đã bọc `pulumi.secret` (từ `requireSecret`), nên state Pulumi
 * mã hoá; trigger đổi giá trị nằm ở `secretTriggers` dưới.
 */
const provisionEnvironment: Record<string, pulumi.Output<string>> = {};
for (const target of DATABASES) {
  provisionEnvironment[passwordEnvVar(target, 'migrator')] = rolePasswords[target].migrator;
  provisionEnvironment[passwordEnvVar(target, 'runtime')] = rolePasswords[target].runtime;
}

// Trigger provision gồm CẢ SÁU mật khẩu (bọc pulumi.secret — trigger nằm
// trong state Pulumi, không plaintext): đổi bất kỳ mật khẩu nào là provision
// chạy lại và áp lại toàn bộ.
const secretTriggers: pulumi.Output<string>[] = DATABASES.flatMap((target) => [
  pulumi.secret(rolePasswords[target].migrator),
  pulumi.secret(rolePasswords[target].runtime),
]);

const provision = new command.local.Command(dockerResourceName(ns, 'llm-api') + '-provision', {
  create: provisionScript,
  update: provisionScript,
  triggers: [...secretTriggers, worktreeRoot],
  environment: provisionEnvironment,
});

/**
 * Migration qua **đường canonical**, MỘT command cho MỖI database: container
 * ephemeral trên platform network chạy đúng `npx tsx --tsconfig tsconfig.db.json
 * db/apply.mts <target>` của repo (advisory lock `hashtext('db-llm-<target>')`,
 * verify `current_database()` khớp DB đích — chống chạy nhầm credential; cả hai
 * giữ nguyên trong `apps/llm-api/db/apply.mts`). KHÔNG chạy qua binding
 * Hyperdrive (HD6: advisory lock).
 *
 * Kênh `DATABASE_URL`: giá trị (đã percent-encode password trước khi ghép vào
 * userinfo — an toàn khi mật khẩu chứa `@ : / ? #`; kết quả bọc `pulumi.secret`)
 * đi vào environ của tiến trình shell qua map `environment` của provider; script
 * chạy `docker run -e DATABASE_URL` với CHỈ TÊN biến, docker CLI đọc giá trị từ
 * environ của chính nó và chuyển vào container env. Không có `-e VAR=giá trị`
 * nào trong argv của `docker run`, nên URL không lộ qua argv của `sh -c` hay
 * `docker run` — kênh `-e VAR=value` inline của baseline cũ (auth-deploy) KHÔNG
 * được nhân rộng; script text là đầu ra của hàm thuần `buildMigrateScript`
 * (`scripts.ts`), không chứa giá trị secret nào.
 *
 * Trigger gồm password migrator + worktreeRoot: đổi mật khẩu là chạy lại migration
 * với credential mới. Migration file đổi nội dung thì image bundle/container WIC
 * tự recreate qua label bundle-hash; migrate chạy lại khi password hoặc stack đổi.
 */
const migrateCommands: Record<Database, command.local.Command> = {
  gateway: undefined as never,
  tenant: undefined as never,
  marketplace: undefined as never,
};

/** URL migrator của từng database — bootstrap tái dùng đúng credential này. */
const migratorUrls: Record<Database, pulumi.Output<string>> = {
  gateway: undefined as never,
  tenant: undefined as never,
  marketplace: undefined as never,
};

for (const target of DATABASES) {
  const migratorPasswordEncoded = rolePasswords[target].migrator.apply((v) =>
    encodeURIComponent(v),
  );
  // URL migrator hoàn chỉnh — được bọc secret (interpolate của một output bọc
  // secret là output secret), state Pulumi mã hoá chứ không lưu plaintext.
  const migratorConnectionUrl = pulumi.interpolate`postgresql://${migratorRole(target)}:${migratorPasswordEncoded}@${POSTGRES_HOST}:5432/${dbName(target)}`;
  migratorUrls[target] = migratorConnectionUrl;
  const migrateScript = networkName.apply((net) =>
    buildMigrateScript({
      networkName: net,
      worktreeRoot,
      target,
      nodeImage: NODE_IMAGE,
    }),
  );
  migrateCommands[target] = new command.local.Command(
    // MỘT kind `llm-api` chung cho mọi lệnh ephemeral (provision/migrate) của
    // unit — hậu đối số `-migrate-<target>` tách tên per DB, đúng cơ chế của
    // auth-deploy (`'auth'` + `-provision`/`-migrate`/`-seed`) để union
    // `DeployResourceKind` không phình theo số database.
    dockerResourceName(ns, 'llm-api') + `-migrate-${target}`,
    {
      create: migrateScript,
      update: migrateScript,
      // Bọc secret: trigger nằm trong state Pulumi — không lưu plaintext.
      triggers: [pulumi.secret(rolePasswords[target].migrator), worktreeRoot],
      // Giá trị bọc secret: provider đặt vào environ của tiến trình script.
      environment: { DATABASE_URL: migratorConnectionUrl },
    },
    { dependsOn: [provision] },
  );
}

/**
 * Bootstrap chuỗi seed (ADR-0020 Quyết định 13) — các sub-bước chạy ĐÚNG runner
 * của repo (`apps/llm-api/db/bootstrap-*.mts`) bằng cùng container ephemeral
 * pattern với migrate. Thứ tự: migrate gateway → **8a seller-governance**
 * (seed tenant `dronie` + principal + approvals thật + association; in verdict
 * eligibility ra stdout) → migrate marketplace → **8b marketplace** (tiêu thụ
 * verdict từ stdout 8a; seed offer/pool/credential; smoke probe upstream;
 * activate khi probe sống) → migrate tenant đã chạy trước đó trong vòng migrate
 * → **bước 9 consumer-tenant** (seed tenant `ecoma` + owner membership trên
 * db-llm-tenant và API key đầu tiên trên db-llm-gateway — hai database, hai
 * transaction trong MỘT runner). WIC chỉ lên sau TOÀN BỘ bootstrap để request
 * đầu tiên không rơi vào cửa sổ chưa-seed.
 *
 * Kênh giá trị: mọi env của runner đi bằng `environment` của provider → argv
 * `docker run` chỉ mang `-e TÊN` (dựng bằng hằng `BOOTSTRAP_*_ENV_VARS` trong
 * `scripts.ts` — hai phía không thể lệch tên). Secret
 * (`LLM_UPSTREAM_CREDENTIAL_PLAINTEXT`, `DATABASE_URL` và hai URL bước 9) bọc
 * `pulumi.secret`; verdict là máy đọc, không secret nhưng vẫn đi env. Plaintext
 * API key bước 9 chỉ tồn tại trên stdout của runner đúng một lần (show-once),
 * nên `stdout`/`stderr` của command đó được đánh dấu secret output — state
 * Pulumi mã hoá, không lưu plaintext trần.
 *
 * Cấu hình nguồn (stack config, đặt bởi `local.ts`): `tenantOwnerSub` (sub
 * superadmin canonical — giải quyết qua dx runner trước khi up), các fact
 * pháp lý/thuế của principal first_party, con trỏ evidence authoritative, bộ
 * `llmUpstream*` cho upstream thật, và bộ funding của sponsor (bước 10 —
 * `sponsorId` chỉ assert định danh nằm trong code, hai trần tiền +
 * `sponsorAuthorizationEvidenceRef` + `sponsorGrantAmount` là cấu hình bắt
 * buộc không default). Runner fail-closed khi thiếu bất kỳ
 * env bắt buộc nào (ADR-0020 Quyết định 12).
 */
const bootstrapActor = conf.require('bootstrapActor');
const tenantOwnerSub = conf.require('tenantOwnerSub');

const governanceEnvironment: Record<string, pulumi.Output<string> | string> = {
  DATABASE_URL: migratorUrls.gateway,
  ECOMA_GOVERNANCE_ACTOR: bootstrapActor,
  ECOMA_SELLER_TENANT_OWNER_SUB: tenantOwnerSub,
  ECOMA_FIRST_PARTY_LEGAL_NAME: conf.require('firstPartyLegalName'),
  ECOMA_FIRST_PARTY_LEGAL_TYPE: conf.require('firstPartyLegalType'),
  ECOMA_FIRST_PARTY_JURISDICTION: conf.require('firstPartyJurisdiction'),
  ECOMA_FIRST_PARTY_REGISTRATION_REFERENCE: conf.require('firstPartyRegistrationReference'),
  ECOMA_FIRST_PARTY_TAX_RESIDENCY: conf.require('firstPartyTaxResidency'),
  ECOMA_FIRST_PARTY_TAX_IDENTIFIER: conf.require('firstPartyTaxIdentifier'),
  ECOMA_FIRST_PARTY_DECLARATION_REFERENCE: conf.require('firstPartyDeclarationReference'),
  ECOMA_LEGAL_EVIDENCE_STORAGE_REF: conf.require('legalEvidenceStorageRef'),
  ECOMA_LEGAL_EVIDENCE_CONTENT_HASH: conf.require('legalEvidenceContentHash'),
  ECOMA_TAX_EVIDENCE_STORAGE_REF: conf.require('taxEvidenceStorageRef'),
  ECOMA_TAX_EVIDENCE_CONTENT_HASH: conf.require('taxEvidenceContentHash'),
};

const bootstrapGovernanceScript = networkName.apply((net) =>
  buildBootstrapScript({
    networkName: net,
    worktreeRoot,
    step: 'seller-governance',
    nodeImage: NODE_IMAGE,
    envVarNames: BOOTSTRAP_GOVERNANCE_ENV_VARS,
  }),
);

const bootstrapGovernance = new command.local.Command(
  dockerResourceName(ns, 'llm-api') + '-bootstrap-seller-governance',
  {
    create: bootstrapGovernanceScript,
    update: bootstrapGovernanceScript,
    triggers: [worktreeRoot, ...Object.entries(governanceEnvironment).map(([k, v]) => `${k}=${v}`)],
    environment: governanceEnvironment,
  },
  { dependsOn: [migrateCommands.gateway] },
);

const upstreamCredentialPlaintext = pulumi.secret(conf.require('llmUpstreamCredentialPlaintext'));

const bootstrapMarketplaceEnvironment: Record<string, pulumi.Output<string> | string> = {
  DATABASE_URL: migratorUrls.marketplace,
  ECOMA_GOVERNANCE_ACTOR: bootstrapActor,
  LLM_UPSTREAM_PROVIDER: conf.require('llmUpstreamProvider'),
  LLM_UPSTREAM_MODEL: conf.require('llmUpstreamModel'),
  LLM_UPSTREAM_BASE_URL: conf.require('llmUpstreamBaseUrl'),
  LLM_UPSTREAM_PROTOCOL: conf.require('llmUpstreamProtocol'),
  LLM_UPSTREAM_CREDENTIAL_PLAINTEXT: upstreamCredentialPlaintext,
  // Verdict eligibility từ stdout của 8a — hợp đồng stdout CHỈ dòng máy đọc,
  // extraction là hàm thuần có spec (`extractEligibilityVerdict`).
  SELLER_ELIGIBILITY_VERDICT: bootstrapGovernance.stdout.apply(extractEligibilityVerdict),
};

const bootstrapMarketplaceScript = networkName.apply((net) =>
  buildBootstrapScript({
    networkName: net,
    worktreeRoot,
    step: 'marketplace',
    nodeImage: NODE_IMAGE,
    envVarNames: BOOTSTRAP_MARKETPLACE_ENV_VARS,
  }),
);

const bootstrapMarketplace = new command.local.Command(
  dockerResourceName(ns, 'llm-api') + '-bootstrap-marketplace',
  {
    create: bootstrapMarketplaceScript,
    update: bootstrapMarketplaceScript,
    // Secret bọc trước khi làm trigger — state Pulumi mã hoá, không plaintext.
    triggers: [
      worktreeRoot,
      upstreamCredentialPlaintext,
      ...Object.entries(bootstrapMarketplaceEnvironment)
        .filter(([k]) => k !== 'LLM_UPSTREAM_CREDENTIAL_PLAINTEXT')
        .map(([k, v]) => `${k}=${v}`),
    ],
    environment: bootstrapMarketplaceEnvironment,
  },
  { dependsOn: [migrateCommands.marketplace, bootstrapGovernance] },
);

/**
 * Bước 9 (Issue #24) — seed Consumer tenant `ecoma`: tenant `first_party` +
 * owner membership (db-llm-tenant, migration `tenant/0002`) và API key đầu
 * tiên hash-only (db-llm-gateway, migration `gateway/0003`). Một runner ghi
 * hai database nên không có `DATABASE_URL` chung: wiring truyền hai URL
 * migrator qua hai biến riêng, đúng hằng `BOOTSTRAP_CONSUMER_TENANT_ENV_VARS` +
 * `databaseUrlEnvNames` trong `scripts.ts`. Chạy sau 8b (đúng thứ tự bước của
 * `02-delivery.md` §3.2) và sau migrate tenant; owner sub từ `tenantOwnerSub`
 * đã lưu ở stack config. Plaintext key in đúng một lần trên stdout run tạo —
 * rerun (triggers không đổi) là no-op và không in lại plaintext.
 */
const bootstrapConsumerTenantEnvironment: Record<string, pulumi.Output<string> | string> = {
  ECOMA_TENANT_DATABASE_URL: migratorUrls.tenant,
  ECOMA_GATEWAY_DATABASE_URL: migratorUrls.gateway,
  ECOMA_GOVERNANCE_ACTOR: bootstrapActor,
  ECOMA_CONSUMER_TENANT_OWNER_SUB: tenantOwnerSub,
};

const bootstrapConsumerTenantScript = networkName.apply((net) =>
  buildBootstrapScript({
    networkName: net,
    worktreeRoot,
    step: 'consumer-tenant',
    nodeImage: NODE_IMAGE,
    envVarNames: BOOTSTRAP_CONSUMER_TENANT_ENV_VARS,
    databaseUrlEnvNames: ['ECOMA_TENANT_DATABASE_URL', 'ECOMA_GATEWAY_DATABASE_URL'],
  }),
);

const bootstrapConsumerTenant = new command.local.Command(
  dockerResourceName(ns, 'llm-api') + '-bootstrap-consumer-tenant',
  {
    create: bootstrapConsumerTenantScript,
    update: bootstrapConsumerTenantScript,
    // Trigger trên worktreeRoot + mọi entry environment (k=v): hai URL là
    // output bọc secret (interpolate của password secret) nên state mã hoá
    // entry đó — cùng cơ chế với 8a/8b.
    triggers: [
      worktreeRoot,
      ...Object.entries(bootstrapConsumerTenantEnvironment).map(([k, v]) => `${k}=${v}`),
    ],
    environment: bootstrapConsumerTenantEnvironment,
  },
  {
    dependsOn: [migrateCommands.tenant, bootstrapMarketplace],
    // stdout run tạo key mang plaintext ĐÚNG MỘT LẦN (show-once): đánh dấu
    // secret output (resource option) để state Pulumi mã hoá thay vì lưu trần.
    additionalSecretOutputs: ['stdout', 'stderr'],
  },
);

/**
 * Bước 10 (Issue #24) — seed funding ADR-0028 trên db-llm-gateway: sponsor
 * `sponsor_ecoma_internal` (env chỉ ASSERT định danh — nó nằm trong code,
 * cấu hình lệch là runner từ chối), billing account của tenant consumer,
 * funding authorization (trần per-account nullable — chuỗi `null` là explicit
 * vô trần) và grant khởi tạo kết thúc `credited` qua đúng phép kiểm trần duy
 * nhất `creditGrant`. Chạy sau migrate gateway + bước 9: tenant id đi qua
 * stdout máy đọc của bước 9 (`extractConsumerTenantId` — cùng hợp đồng
 * stdout/stderr với verdict 8a→8b), wiring không hard-code; các URL database
 * không dùng `DATABASE_URL` chung (runner đọc `ECOMA_GATEWAY_DATABASE_URL`).
 * Trần tiền + evidence_ref + amount là cấu hình bắt buộc không default; trần
 * cấu hình thấp hơn grant là exit khác 0 với grant giữ `pending` bền — rerun
 * sau khi sửa cấu hình hội tụ (ADR-0028 §6). State Pulumi không chứa giá trị
 * credential nào của bước này; stdout/stderr vẫn đánh dấu secret output cùng
 * cơ chế với bước 9.
 */
const bootstrapFinancialEnvironment: Record<string, pulumi.Output<string> | string> = {
  ECOMA_GATEWAY_DATABASE_URL: migratorUrls.gateway,
  ECOMA_GOVERNANCE_ACTOR: bootstrapActor,
  // Tenant id từ stdout bước 9 — chuỗi kết nối hai bước đi qua hợp đồng máy
  // đọc, runner bước 10 tự assert với hằng của nó.
  ECOMA_CONSUMER_TENANT_ID: bootstrapConsumerTenant.stdout.apply(extractConsumerTenantId),
  ECOMA_CONSUMER_TENANT_OWNER_SUB: tenantOwnerSub,
  ECOMA_SPONSOR_ID: conf.require('sponsorId'),
  ECOMA_SPONSOR_CEILING: conf.require('sponsorCeiling'),
  ECOMA_SPONSOR_AUTHORIZATION_CEILING: conf.require('sponsorAuthorizationCeiling'),
  ECOMA_SPONSOR_AUTHORIZATION_EVIDENCE_REF: conf.require('sponsorAuthorizationEvidenceRef'),
  ECOMA_SPONSOR_GRANT_AMOUNT: conf.require('sponsorGrantAmount'),
};

const bootstrapFinancialScript = networkName.apply((net) =>
  buildBootstrapScript({
    networkName: net,
    worktreeRoot,
    step: 'financial',
    nodeImage: NODE_IMAGE,
    envVarNames: BOOTSTRAP_FINANCIAL_ENV_VARS,
    databaseUrlEnvNames: ['ECOMA_GATEWAY_DATABASE_URL'],
  }),
);

const bootstrapFinancial = new command.local.Command(
  dockerResourceName(ns, 'llm-api') + '-bootstrap-financial',
  {
    create: bootstrapFinancialScript,
    update: bootstrapFinancialScript,
    // Trigger trên worktreeRoot + mọi entry environment (k=v): URL gateway là
    // output bọc secret nên state mã hoá entry đó — cùng cơ chế 8a/8b/bước 9.
    triggers: [
      worktreeRoot,
      ...Object.entries(bootstrapFinancialEnvironment).map(([k, v]) => `${k}=${v}`),
    ],
    environment: bootstrapFinancialEnvironment,
  },
  {
    dependsOn: [migrateCommands.gateway, bootstrapConsumerTenant],
    // Result line của runner là dữ liệu cấu hình, không credential — nhưng
    // vẫn đánh dấu secret output cùng cơ chế với bước 9 (state mã hoá).
    additionalSecretOutputs: ['stdout', 'stderr'],
  },
);

/**
 * Image WIC — image MỎNG: chỉ image Node pin + `ca-certificates` (PF2) +
 * entrypoint script. KHÔNG build gì bên trong: repo (kèm bundle `build/` đã
 * build từ target `build` của Nx trên host — esbuild sinh `build/index.js`)
 * được mount lúc runtime, và `wrangler dev` chạy từ mount
 * đó. Image chỉ là "phòng chạy" (pattern auth/remote-cache).
 */
const wicImageTag = dockerResourceName(ns, 'llm-api-wic') + ':local';
const wicImage = new dockerBuild.Image(dockerResourceName(ns, 'llm-api-wic-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/llm-api-deploy/Dockerfile` },
  tags: [wicImageTag],
  builder: { name: 'default' },
  load: true,
  push: false,
  labels,
});

/**
 * Connection string Hyperdrive local của từng database (PF3/PF4): role runtime,
 * host alias `ecoma-postgres` của platform network, `sslmode=disable` —
 * miniflare bỏ proxy TLS và workerd dial thẳng host:port. `pulumi.secret` bọc
 * TRƯỚC interpolate (redact trong diff/log); giá trị đi vào container qua kênh
 * `envs` — không argv, không label, không log. Password percent-encode trước khi
 * ghép vào userinfo (cùng lý do phía migrate).
 *
 * Tên biến: `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_` + TÊN BINDING
 * wrangler (`DB_LLM_GATEWAY`/`DB_LLM_TENANT`/`DB_LLM_MARKETPLACE` của
 * `apps/llm-api/wrangler.jsonc`). Thiếu biến là wrangler fail boot tường minh
 * (fail-closed).
 */
const runtimePasswordEncoded: Record<Database, pulumi.Output<string>> = {
  gateway: rolePasswords.gateway.runtime.apply((v) => encodeURIComponent(v)),
  tenant: rolePasswords.tenant.runtime.apply((v) => encodeURIComponent(v)),
  marketplace: rolePasswords.marketplace.runtime.apply((v) => encodeURIComponent(v)),
};

const hyperdriveConnectionStrings: Record<Database, pulumi.Output<string>> = {
  gateway: pulumi.interpolate`postgresql://${runtimeRole('gateway')}:${pulumi.secret(runtimePasswordEncoded.gateway)}@${POSTGRES_HOST}:5432/${dbName('gateway')}?sslmode=disable`,
  tenant: pulumi.interpolate`postgresql://${runtimeRole('tenant')}:${pulumi.secret(runtimePasswordEncoded.tenant)}@${POSTGRES_HOST}:5432/${dbName('tenant')}?sslmode=disable`,
  marketplace: pulumi.interpolate`postgresql://${runtimeRole('marketplace')}:${pulumi.secret(runtimePasswordEncoded.marketplace)}@${POSTGRES_HOST}:5432/${dbName('marketplace')}?sslmode=disable`,
};

/**
 * Volume RW duy nhất của WIC: state wrangler (`--persist-to`, HOME/XDG cô lập,
 * dev registry). KHÔNG nằm trong repo mount (read-only) — workerd ghi state
 * runtime liên tục; dữ liệu này là EPHEMERAL theo thiết kế nên volume không
 * `retainOnDelete` và KHÔNG được liệt kê là dữ liệu persistent nào.
 */
const wicStateVolumeName = dockerResourceName(ns, 'llm-api-wic-state');
const wicStateVolume = new docker.Volume(wicStateVolumeName, {
  name: wicStateVolumeName,
  // Ownership labels — `local-cleanup` chỉ xoá resource chứng minh được sở hữu;
  // thiếu label là orphan bị skip fail-closed.
  labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
});

/**
 * Một-shot CHOWN volume state cho uid 1000 (`node`) — Docker tạo volume mới
 * với thư mục gốc `root:root 0755`, mà container WIC chạy non-root
 * (`USER node`, cùng model auth): node không ghi được vào volume root-owned
 * là wrangler chết ngay lúc boot (`mkdir /state/... EACCES`). Lần chạy sau là
 * no-op (chown idempotent). Volume KHÔNG mang dữ liệu cần bảo vệ trước
 * container (state wrangler ephemeral) nên root của init container không phải
 * cảnh bảo mật.
 */
const wicStateInit = new docker.Container(
  dockerResourceName(ns, 'llm-api-wic-state-init'),
  {
    name: dockerResourceName(ns, 'llm-api-wic-state-init'),
    image: NODE_IMAGE,
    // KHÔNG dùng `rm: true`: chown thoát trong vài mili-giây và AutoRemove xoá
    // container trước khi provider kịp inspect sau create — "No such container"
    // làm fail toàn bộ create (race flaky, đã gặp trên máy thật). `mustRun:
    // false` đủ để chấp nhận container đã exit; container exited nằm lại
    // `docker ps -a` tới khi destroy xoá nó đúng nghĩa. KHÔNG dùng
    // `retainOnDelete`: container one-shot không có dữ liệu gì để giữ — giữ
    // retain sẽ khiến destroy chỉ xoá state mà không xoá container thật, và
    // lần up sau bị Docker từ chối vì trùng tên container.
    mustRun: false,
    mounts: [
      {
        source: wicStateVolume.name,
        target: '/state',
        type: 'volume',
      },
    ],
    command: ['chown', '1000:1000', '/state'],
    // Ownership labels — cùng lý do volume phía trên.
    labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
  },
  { dependsOn: [wicStateVolume] },
);

/**
 * Container WIC — MỘT worker `wrangler dev` (llm-api) qua `wic-entrypoint.sh`,
 * plain HTTP trên platform network.
 *
 * Thứ tự phụ thuộc: provision → migrate (cả ba DB) → bootstrap 8a → bootstrap
 * 8b → image → volume → container — container chỉ lên sau khi schema và seed
 * sẵn sàng, để request đầu tiên của consumer không rơi vào cửa sổ chưa-migrate
 * hay catalogue rỗng.
 *
 * Env:
 * - `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_{DB_LLM_GATEWAY,DB_LLM_TENANT,
 *   DB_LLM_MARKETPLACE}` (secret): wrangler đọc các biến này của PROCESS để gán
 *   connection string cho ba binding Hyperdrive (PF3). Thiếu biến là wrangler
 *   fail boot tường minh (fail-closed).
 *
 * KHÔNG có `ports` và KHÔNG có label `traefik.*`: WIC không publish cổng ra
 * host — worker nội bộ, chưa có hostname công khai được chốt ở issue #22
 * (cùng quyết định no-Traefik với remote-cache-api/pact-broker-api).
 */
const wic = new docker.Container(
  dockerResourceName(ns, 'llm-api-wic'),
  {
    name: dockerResourceName(ns, 'llm-api-wic'),
    image: pulumi.interpolate`${wicImageTag}@${wicImage.digest}`,
    restart: 'unless-stopped',
    // `stop_timeout` 30s khớp bounded-wait 20s của entrypoint: SIGTERM →
    // workerd được thời gian thoát sạch (flush state + registry + pool
    // PostgreSQL) trước khi Docker SIGKILL.
    stopTimeout: 30,
    volumes: [
      {
        volumeName: wicStateVolumeName,
        containerPath: '/state',
      },
      // Repo root mount read-only — nguồn `node_modules` (binary wrangler của
      // entrypoint + resolve module hai tầng của cây runtime mirror) và
      // `wrangler.jsonc` của app. Thiếu mount này là `/repo` rỗng trừ subtree
      // build bên dưới → deps check của entrypoint fail `wrangler_binary_missing`
      // → restart loop (bài học Issue #233 của auth). RO vì WIC không ghi gì
      // xuống repo: wrangler ghi `.wrangler/tmp`, cache miniflare và registry
      // đều qua điểm ghi `/state` (xem wic-entrypoint.sh).
      {
        hostPath: worktreeRoot,
        containerPath: '/repo',
        readOnly: true,
      },
      // Bundle `build/` của app (`index.js` do target `build` của Nx sinh): repo
      // mount read-only không chứa bundle (build trên host bởi target `build`
      // của Nx), mount bind trực tiếp thư mục build đã build (ro: workerd chỉ
      // ĐỌC bundle; build lại bundle trên host là thay đổi nội dung mount).
      {
        hostPath: `${worktreeRoot}/apps/llm-api/build`,
        containerPath: '/repo/apps/llm-api/build',
        readOnly: true,
      },
      // KHÔNG mount gì vào `<app>/.wrangler`: Docker không tạo được mountpoint
      // trên repo mount read-only (runc mkdirat fail trước khi container chạy)
      // — entrypoint symlink thư mục này vào volume /state trước khi wrangler
      // boot (xem wic-entrypoint.sh).
    ],
    networksAdvanced: [
      {
        name: networkName,
        aliases: [LLM_API_ALIAS],
      },
    ],
    envs: [
      pulumi.interpolate`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_LLM_GATEWAY=${pulumi.secret(hyperdriveConnectionStrings.gateway)}`,
      pulumi.interpolate`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_LLM_TENANT=${pulumi.secret(hyperdriveConnectionStrings.tenant)}`,
      pulumi.interpolate`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_LLM_MARKETPLACE=${pulumi.secret(hyperdriveConnectionStrings.marketplace)}`,
      // Serving upstream (slice P4, Issue #24): provider + base URL là cấu hình
      // thường; credential plaintext BỌC pulumi.secret — cùng kênh envs, state
      // Pulumi mã hoá, không argv/label/log. Worker chỉ verify sha256 plaintext
      // với credential_hash active rồi đặt vào header Authorization upstream;
      // không bao giờ log/persist/response (invariant 8).
      pulumi.interpolate`LLM_UPSTREAM_PROVIDER=${conf.require('llmUpstreamProvider')}`,
      pulumi.interpolate`LLM_UPSTREAM_BASE_URL=${conf.require('llmUpstreamBaseUrl')}`,
      pulumi.interpolate`LLM_UPSTREAM_CREDENTIAL_PLAINTEXT=${upstreamCredentialPlaintext}`,
    ],
    labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
    healthcheck: {
      // `/health` chứ không phải một route nghiệp vụ: probe infra không được
      // phụ thuộc DB (thiết kế của app — `/health` không credential, không
      // chạm DB). 200 = worker boot và serve được request; readiness nghiệp
      // vụ (ba DB truy vấn được) là việc của `/ready` ở consumer/smoke sau.
      tests: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${LLM_API_INTERNAL_PORT}/health')` +
          `.then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))`,
      ],
      interval: '10s',
      timeout: '5s',
      // Trần cửa sổ boot wrangler (bundle check, registry connect) — cùng
      // budget remote-cache vì worker duy nhất, không probe mở pool PostgreSQL.
      retries: 30,
      startPeriod: '120s',
    },
    // Readiness resource-owned (`wait: true` — cùng ngữ nghĩa với platform):
    // Pulumi chờ healthcheck `healthy` trước khi resource báo thành công, nên
    // `pulumi up` xanh là bằng chứng serving — DX không poll Docker health.
    // Trần chờ = startPeriod 120s + 30 retries × 10s = 420s; waitTimeout 450s dư.
    wait: true,
    waitTimeout: 450,
  },
  {
    dependsOn: [
      migrateCommands.gateway,
      migrateCommands.tenant,
      migrateCommands.marketplace,
      bootstrapGovernance,
      bootstrapMarketplace,
      bootstrapConsumerTenant,
      bootstrapFinancial,
      wicImage,
      wicStateVolume,
      wicStateInit,
    ],
  },
);

export const provisionCommandName = provision.id;
export const migrateCommandNames = [
  migrateCommands.gateway.id,
  migrateCommands.tenant.id,
  migrateCommands.marketplace.id,
];
export const bootstrapCommandNames = [
  bootstrapGovernance.id,
  bootstrapMarketplace.id,
  bootstrapConsumerTenant.id,
  bootstrapFinancial.id,
];
export const imageDigest = wicImage.digest;
export const containerName = wic.name;
export const containerId = wic.id;
export const stateVolumeName = wicStateVolume.name;
export const namespaceVerified = verifiedNamespace;
