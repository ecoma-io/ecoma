/**
 * Chương trình Pulumi của `llm-api-deploy` — deploy unit của `apps/llm-api`
 * (data plane LLM, Rust workers-rs/WASM qua Hyperdrive) ở LAN LOCAL deployment
 * (issue #22).
 *
 * Pattern: mirror `deploys/remote-cache-api-deploy/index.ts` (WIC — MỘT worker
 * `wrangler dev` qua `wic-entrypoint.sh`, provision DB + migration canonical)
 * và `deploys/auth-deploy/index.ts` (role `ecoma_owner` dùng chung guard-create
 * không ALTER password; revoke chéo điều kiện hoá theo database đích tồn tại).
 *
 * Provision ba database `db-llm-gateway`/`db-llm-tenant`/`db-llm-marketplace` +
 * sáu role `ecoma_llm_{t}_{migrator,runtime}` qua `docker exec` psql vào
 * container PostgreSQL của platform, hai biên escaping `sqlQuote` + `shellQuote`,
 * password do orchestration sinh và truyền qua stack config stdin (không argv).
 * Migration chạy **đường canonical** (`apps/llm-api/db/apply.mts <target>` —
 * advisory lock `hashtext('db-llm-<target>')`, mọi DDL idempotent) bằng container
 * node pin chạy tsx của repo trên platform network, KHÔNG qua binding Hyperdrive
 * (HD6: Hyperdrive không hỗ trợ advisory lock).
 *
 * WIC: MỘT worker `wrangler dev` (alias DNS `ecoma-llm-api`, cổng nội bộ 4211 —
 * `dev.port` của `apps/llm-api/wrangler.jsonc`) trên platform network, ba biến
 * `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*` đi vào bằng container envs
 * (pulumi.secret bọc trước interpolate — kênh duy nhất: không argv, không label,
 * không log). KHÔNG Traefik route (worker nội bộ — chưa có hostname công khai
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
  shellQuote,
  sqlQuote,
  worktreeNamespace,
} from '@ecoma-io/deployment';

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

/** Ba database sở hữu của llm-api (một service sở hữu toàn bộ — A2). */
const DATABASES = ['gateway', 'tenant', 'marketplace'] as const;
type Database = (typeof DATABASES)[number];

/** Tên database của một target — `db-llm-<target>`. */
function dbName(target: Database): string {
  return `db-llm-${target}`;
}

/** Tên role migrator của một target — `ecoma_llm_<target>_migrator`. */
function migratorRole(target: Database): string {
  return `ecoma_llm_${target}_migrator`;
}

/** Tên role runtime của một target — `ecoma_llm_<target>_runtime`. */
function runtimeRole(target: Database): string {
  return `ecoma_llm_${target}_runtime`;
}

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

/** Dòng shell `ALTER ROLE ... PASSWORD` cho một role — hai biên escaping độc lập. */
function alterRolePasswordLine(
  role: string,
  password: pulumi.Output<string>,
): pulumi.Output<string> {
  return password.apply((p) => shellQuote(`ALTER ROLE ${role} WITH PASSWORD ${sqlQuote(p)};`));
}

/**
 * Khối guard-create role + database của MỘT target — phần tĩnh (không secret):
 * mỗi lệnh guard bằng shell `if`, chạy lại là no-op khi đã tồn tại.
 */
function provisionRoleDbBlock(target: Database): string {
  const mr = migratorRole(target);
  const rr = runtimeRole(target);
  const db = dbName(target);
  return `# Role của ${db} — guard-create khi thiếu.
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='${mr}'" | grep -q 1; then $PSQL -c "CREATE ROLE ${mr} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='${rr}'" | grep -q 1; then $PSQL -c "CREATE ROLE ${rr} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# Database + owner. CREATE là lệnh guard (bash if), ALTER idempotent sẵn.
if ! $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1; then $PSQL -c 'CREATE DATABASE "${db}"'; fi
$PSQL -c 'ALTER DATABASE "${db}" OWNER TO ecoma_owner'
`;
}

/**
 * Khối revoke chéo của MỘT target — runtime role của DB này bị chặn CONNECT
 * trên HAI database kia. Điều kiện hoá theo database đích tồn tại: REVOKE trên
 * database không tồn tại là lỗi, không phải no-op (cùng cơ chế auth-deploy với
 * db-account). Chặn PUBLIC lẫn runtime role — PUBLIC trước per-role sau.
 */
function provisionCrossRevokeBlock(target: Database): string {
  const rr = runtimeRole(target);
  const lines = DATABASES.filter((other) => other !== target).map((other) => {
    const otherDb = dbName(other);
    return `# Chặn chéo: ${rr} không được CONNECT vào ${otherDb} (điều kiện: DB đích tồn tại).
if $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='${otherDb}'" | grep -q 1; then $PSQL -c 'REVOKE CONNECT ON DATABASE "${otherDb}" FROM PUBLIC'; fi
if $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='${otherDb}'" | grep -q 1; then $PSQL -c 'REVOKE CONNECT ON DATABASE "${otherDb}" FROM ${rr}'; fi`;
  });
  return lines.join('\n') + '\n';
}

/** Khối grant CONNECT per-role của MỘT target: PUBLIC revoked, migrator CREATE+TEMP, runtime CONNECT. */
function provisionGrantBlock(target: Database): string {
  const mr = migratorRole(target);
  const rr = runtimeRole(target);
  const db = dbName(target);
  return `$PSQL -c 'REVOKE CONNECT ON DATABASE "${db}" FROM PUBLIC'
$PSQL -c 'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${db}" TO ${mr}'
$PSQL -c 'GRANT CONNECT ON DATABASE "${db}" TO ${rr}'
`;
}

/** Khối hardening schema public của MỘT target — no-op trên PG15+ khi chạy bằng migrator, cần quyền owner/superuser. */
function provisionHardeningBlock(target: Database): string {
  const db = dbName(target);
  return `docker exec $PG psql -U ecoma_local -d ${db} -v ON_ERROR_STOP=1 -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC'
`;
}

const postgresContainerName = dockerResourceName(ns, 'postgres');

/**
 * Provision `ecoma_owner` (guard-create, KHÔNG ALTER password — account stack
 * sở hữu password của role dùng chung này; ALTER ở hai nơi là race xoá nhau) +
 * 3 database + 6 role + revoke chéo, chạy trên host qua `docker exec` vào
 * container PostgreSQL của platform. Idempotent như auth-deploy: guard-create
 * bằng shell `if`, ALTER password idempotent sẵn — chạy cả `create` và `update`
 * để redeploy cũng áp cấu hình mới (giá trị stack config không đổi giữa các
 * lần up thì ALTER áp lại cùng giá trị, KHÔNG rotate).
 */
const provisionScript = pulumi.interpolate`set -e
PG=${postgresContainerName}
PSQL="docker exec $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
# 1. Owner role dùng chung — CHỈ tạo khi thiếu; KHÔNG ALTER password (account
#    stack sở hữu password của ecoma_owner; ALTER ở hai nơi là race xoá nhau).
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_owner'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# 2. Ba database + sáu role — guard-create.
${DATABASES.map(provisionRoleDbBlock).join('')}
# 3. Mật khẩu sáu role — hai biên escaping độc lập, áp ĐÚNG THỨ TỰ: sqlQuote
#    bảo vệ literal SQL (psql thấy nguyên giá trị), rồi shellQuote bọc CẢ câu
#    SQL thành một argument của shell (giải thích đầy đủ auth-deploy/index.ts).
$PSQL -c ${alterRolePasswordLine(migratorRole('gateway'), rolePasswords.gateway.migrator)}
$PSQL -c ${alterRolePasswordLine(runtimeRole('gateway'), rolePasswords.gateway.runtime)}
$PSQL -c ${alterRolePasswordLine(migratorRole('tenant'), rolePasswords.tenant.migrator)}
$PSQL -c ${alterRolePasswordLine(runtimeRole('tenant'), rolePasswords.tenant.runtime)}
$PSQL -c ${alterRolePasswordLine(migratorRole('marketplace'), rolePasswords.marketplace.migrator)}
$PSQL -c ${alterRolePasswordLine(runtimeRole('marketplace'), rolePasswords.marketplace.runtime)}
# 4. Revoke chéo giữa các database của unit — runtime role của một DB bị chặn
#    CONNECT vào hai DB kia (bất biến không cross-database query), điều kiện
#    theo DB đích tồn tại.
${DATABASES.map(provisionCrossRevokeBlock).join('')}
# 5. Thu CONNECT của PUBLIC trước, rồi grant per-role (chỉ revoke role là no-op
#    vì PUBLIC giữ CONNECT theo mặc định). Migrator cần CREATE+TEMP để tạo
#    schema (migration 0001 tự cấp USAGE trên schema sau khi tạo); runtime chỉ
#    CONNECT — DML grant theo bảng nằm trong migration 0001 (ALTER DEFAULT
#    PRIVILEGES FOR ROLE migrator).
${DATABASES.map(provisionGrantBlock).join('')}
# 6. Hardening schema public — ecoma_local (owner/superuser) mới revoke được.
${DATABASES.map(provisionHardeningBlock).join('')}
`;

const provision = new command.local.Command(dockerResourceName(ns, 'llm-api') + '-provision', {
  create: provisionScript,
  update: provisionScript,
  // Bọc secret: trigger nằm trong state Pulumi — không lưu plaintext.
  triggers: [
    ...DATABASES.flatMap((t) => [
      pulumi.secret(rolePasswords[t].migrator),
      pulumi.secret(rolePasswords[t].runtime),
    ]),
    worktreeRoot,
  ],
});

/**
 * Migration qua **đường canonical**, MỘT command cho MỖI database: container
 * ephemeral trên platform network chạy đúng `npx tsx --tsconfig tsconfig.db.json
 * db/apply.mts <target>` của repo (advisory lock `hashtext('db-llm-<target>')`,
 * verify `current_database()` khớp DB đích — chống chạy nhầm credential). Repo
 * mount read-only; password qua `-e` env của container (kênh được chấp nhận),
 * không argv, không log. KHÔNG chạy qua binding Hyperdrive (HD6: advisory lock).
 *
 * Password percent-encode trước khi ghép vào userinfo của DATABASE_URL — an toàn
 * khi mật khẩu chứa `@ : / ? #` (encode trên plaintext, kết quả được bọc
 * `pulumi.secret` trong template).
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

for (const target of DATABASES) {
  const migratorPasswordEncoded = rolePasswords[target].migrator.apply((v) =>
    encodeURIComponent(v),
  );
  const migrateScript = pulumi.interpolate`set -e
docker run --rm \\
  --network ${networkName} \\
  -v ${shellQuote(worktreeRoot)}:/repo:ro \\
  -v ${shellQuote(worktreeRoot)}/node_modules:/repo/node_modules \\
  -w /repo/apps/llm-api \\
  -e DATABASE_URL=postgresql://${migratorRole(target)}:${pulumi.secret(migratorPasswordEncoded)}@${POSTGRES_HOST}:5432/${dbName(target)} \\
  ${NODE_IMAGE} \\
  npx tsx --tsconfig tsconfig.db.json db/apply.mts ${target}
`;
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
    },
    { dependsOn: [provision] },
  );
}

/**
 * Image WIC — image MỎNG: chỉ image Node pin + `ca-certificates` (PF2) +
 * entrypoint script. KHÔNG build gì bên trong: repo (kèm bundle `build/` đã
 * build từ target `build` của Nx trên host — worker-build sinh `build/index.js`
 * + `build/index.wasm`) được mount lúc runtime, và `wrangler dev` chạy từ mount
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
    // `rm` sau khi thoát — container init một-shot không nằm lại `docker ps -a`.
    rm: true,
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
  { dependsOn: [wicStateVolume], retainOnDelete: true },
);

/**
 * Container WIC — MỘT worker `wrangler dev` (llm-api) qua `wic-entrypoint.sh`,
 * plain HTTP trên platform network.
 *
 * Thứ tự phụ thuộc: provision → migrate (cả ba DB) → image → volume → container
 * — container chỉ lên sau khi schema cả ba database sẵn sàng, để request đầu
 * tiên của consumer không rơi vào cửa sổ chưa-migrate.
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
      // Bundle `build/` của app (worker-build: `index.js` + `index.wasm`): repo
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
export const imageDigest = wicImage.digest;
export const containerName = wic.name;
export const containerId = wic.id;
export const stateVolumeName = wicStateVolume.name;
export const namespaceVerified = verifiedNamespace;
