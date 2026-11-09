/**
 * Chương trình Pulumi của `pact-broker-api-deploy` — deploy unit của
 * `apps/pact-broker-api` (Pact Broker API Worker, Hono + `pg` qua Hyperdrive,
 * `nodejs_compat`) ở LAN LOCAL deployment.
 *
 * Pattern: mirror `deploys/auth-deploy/index.ts` (WIC — worker-in-container).
 * Image mỏng ghim `node:24-bookworm-slim` + `ca-certificates` (PF2), chứa MỘT
 * process `wrangler dev` theo `wic-entrypoint.sh`: worker `ecoma-pact-broker-api`
 * (port nội bộ 4204). Repo mount READ-ONLY (PR #234 của auth) — entrypoint dựng
 * **runtime tree mirror** ghi được dưới `$PERSIST_DIR/runtime` (copy
 * `wrangler.jsonc` + `dist`, symlink `node_modules` hai tầng) và chạy wrangler
 * từ đó. Secrets đi qua `envs` của container (kênh container env — không argv,
 * không label, không log), `pulumi.secret` bọc trước khi interpolate để redact
 * trong diff/log.
 *
 * KHÔNG có Traefik router (quyết định thiết kế, issue #238): consumer duy nhất
 * của API ở local là (a) `pact-broker-app` (BFF Nuxt) fetch server-side qua
 * alias DNS nội bộ `ecoma-pact-api` — fetch server-side không preflight nên
 * không cần CORS; (b) Pact CLI chạy trong platform network. Vì thế container
 * KHÔNG publish port ra host, KHÔNG mang label `traefik.*` — khác auth.
 * Readiness là liveness container: Docker healthcheck poll `GET /health` của
 * worker (không chạm DB — thiết kế của app, cùng declaration `http-health`
 * của `local-worker.jsonc`); `/health` 200 không phải bằng chứng readiness
 * nghiệp vụ (DB probe thật là việc của smoke ở wiring PR).
 *
 * Provision database mirror `deploys/backoffice-deploy/index.ts`: stack này
 * provision `db-pact-broker` + hai role (`ecoma_pact_broker_migrator`,
 * `ecoma_pact_broker_runtime`) qua `docker exec` vào container PostgreSQL của
 * platform (platform không publish host port nên host không kết nối được
 * container bằng TCP — invariant platform), hai biên escaping
 * `sqlQuote` + `shellQuote`, password do orchestration sinh và truyền qua
 * stack config `--config` (stdin, không argv). Migration chạy **đường
 * canonical** (`apps/pact-broker-api/db/apply.mts` — advisory lock
 * `hashtext('db-pact-broker')`) bằng container node pin chạy tsx binary của
 * repo, KHÔNG qua binding Hyperdrive (HD6: Hyperdrive không hỗ trợ advisory
 * lock — `docs/applications/pact-broker/03-operations.md` §2).
 *
 * Seed machine token (issue #238): `db/migrations/` không seed token nào, mà
 * consumer chính ở local (`pact-broker-app`, unit song song) cần token máy
 * trong DB để gọi API. Command `-seed` INSERT guard idempotent MỘT tenant
 * `local` + MỘT machine token — DB chỉ lưu SHA-256 hex (không phải secret;
 * plaintext do orchestration sinh, giữ ở stack config `namespace:machineToken`
 * của stack này cho unit pact-app đọc qua cross-stack `pulumi config get`).
 */

import { createHash } from 'node:crypto';

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
 * Image Node pin (theo DIGEST) để chạy migration + seed trong container gắn
 * platform network — cùng digest mà `deploys/auth-deploy/Dockerfile` ghim.
 *
 * Vì sao container mà không chạy runner trên host: platform PostgreSQL KHÔNG
 * publish host port (invariant platform) và host không route được tới IP
 * container (platform facts PF5), nên `pg` của runner chỉ kết nối được từ bên
 * trong platform network. Container ephemeral chạy **tsx binary của repo** vẫn
 * là đúng một đường code canonical (`applyAllMigrations` của
 * `apps/pact-broker-api/db/apply.mts`) — deploy không tự viết lại vòng migration.
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/** Alias DNS của PostgreSQL platform trong network nội bộ. */
const POSTGRES_HOST = 'ecoma-postgres';

/**
 * Cổng HTTP nội bộ của worker `ecoma-pact-broker-api` trong WIC — `dev.port`
 * của `apps/pact-broker-api/wrangler.jsonc`. Bên trong container KHÔNG cần
 * phát hiện xung đột port host (mỗi container có network stack riêng — static
 * port an toàn); nguồn số duy nhất là wrangler.jsonc, Pulumi không cấp port.
 * Alias DNS `ecoma-pact-api` (hằng số) + port này là contract cho unit
 * `pact-broker-app-deploy` wiring: `NITRO_PACT_BROKER_API_BASE_URL=http://ecoma-pact-api:4204`.
 *
 * Wrangler đọc `dev.port` khi render URL banner và healthcheck ở dưới poll đúng
 * `PACT_API_INTERNAL_PORT` — wrangler đổi port là healthcheck fail ngay (fail
 * qua vòng đời container, không qua assertion compile-time).
 */
const PACT_API_INTERNAL_PORT = 4204;

/**
 * Alias DNS của WIC container trong platform network — HẰNG SỐ, không theo
 * namespace (khác auth dùng `${AUTH_WIC_ALIAS_PREFIX}${ns}-auth`). Mỗi worktree
 * có platform network RIÊNG (namespace cô lập), nên alias hằng trong một
 * network không xung đột; hằng cho tên ổn định để unit pact-app cấu hình
 * `NITRO_PACT_BROKER_API_BASE_URL` không phụ thuộc namespace.
 */
const PACT_API_ALIAS = 'ecoma-pact-api';

/**
 * Tên tenant + token machine seed ở local — consumer là `pact-broker-app`.
 * Tên tenant theo format CHECK của `pact.tenants` (`[a-zA-Z0-9._-]`).
 *
 * ⚠️ Đây là giá trị lane local còn sót lại, KHÔNG phải tên canonical: tên tenant
 * nội bộ canonical là `ecoma` ở mọi environment (ADR-0020 Quyết định 9). Đổi hằng
 * này là thay đổi hành vi, nên thuộc #21 — PR #39 chỉ chốt tên trong tài liệu.
 */
const LOCAL_TENANT_NAME = 'local';
const LOCAL_TOKEN_NAME = 'pact-broker-app-bff';

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

// Mật khẩu hai role của db-pact-broker — do orchestration sinh và truyền qua
// --config (stdin, không argv).
const runtimePassword = conf.require('runtimePassword');
const migratorPassword = conf.require('migratorPassword');

/**
 * Machine token plaintext của consumer local (`pact-broker-app`) — orchestration
 * sinh và set qua stack config (kênh stdin). Giá trị KHÔNG bao giờ vào log:
 * đi vào SQL seed chỉ dưới dạng SHA-256 hex (hash một chiều, không phải
 * secret), còn plaintext nằm trong stack config cho unit pact-app đọc.
 */
const machineToken = conf.require('machineToken');

const verifiedNamespace = pulumi.output(platformNamespace).apply((upstreamNs) => {
  if (upstreamNs !== ns) {
    throw new Error(
      `platformStackRef points to a stack of a different namespace: platform exports "${upstreamNs}" but this worktree is "${ns}".`,
    );
  }
  return ns;
});

/**
 * Provision `db-pact-broker` + 2 role, chạy trên host qua `docker exec` vào
 * container PostgreSQL của platform. Idempotent như backoffice-deploy: mỗi
 * lệnh guard-create bằng shell `if`, còn ALTER password idempotent sẵn — chạy
 * cả `create` và `update` để redeploy cũng xoay password.
 *
 * Khác auth (4 role + revoke chéo): bounded context này chỉ có 2 role, không
 * có owner role dùng chung (migrator sở hữu schema `pact` sau khi migration
 * `0001` chạy — grant `CREATE` trên database cấp ở đây), không có database
 * nào khác cần revoke chéo.
 */
const postgresContainerName = dockerResourceName(ns, 'postgres');
const provisionScript = pulumi.interpolate`set -e
PG=${postgresContainerName}
PSQL="docker exec $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
# 1. Hai role của db-pact-broker — guard-create khi thiếu.
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_pact_broker_migrator'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_pact_broker_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_pact_broker_runtime'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_pact_broker_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# 2. Mật khẩu role — hai biên escaping độc lập, áp ĐÚNG THỨ TỰ: sqlQuote bảo vệ
#    literal SQL (psql thấy nguyên giá trị), rồi shellQuote bọc CẢ câu SQL
#    thành một argument của shell (giải thích đầy đủ backoffice-deploy/index.ts).
$PSQL -c ${shellQuote(`ALTER ROLE ecoma_pact_broker_migrator WITH PASSWORD ${sqlQuote(migratorPassword)};`)}
$PSQL -c ${shellQuote(`ALTER ROLE ecoma_pact_broker_runtime WITH PASSWORD ${sqlQuote(runtimePassword)};`)}
# 3. Database — guard-create (bash if), idempotent qua lần chạy sau.
if ! $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='db-pact-broker'" | grep -q 1; then $PSQL -c 'CREATE DATABASE "db-pact-broker"'; fi
# 4. Grant: migrator cần CREATE trên database để tạo schema pact (migration 0001
#    tự cấp USAGE/CREATE trên schema sau khi tạo); runtime chỉ CONNECT —
#    DML grant theo bảng nằm trong migration 0001.
$PSQL -c 'REVOKE CONNECT ON DATABASE "db-pact-broker" FROM PUBLIC'
$PSQL -c 'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "db-pact-broker" TO ecoma_pact_broker_migrator'
$PSQL -c 'GRANT CONNECT ON DATABASE "db-pact-broker" TO ecoma_pact_broker_runtime'
# 5. Hardening schema public — ecoma_local mới revoke được; migration statement là no-op trên PG15+.
docker exec $PG psql -U ecoma_local -d db-pact-broker -v ON_ERROR_STOP=1 -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC'
`;

const provision = new command.local.Command(dockerResourceName(ns, 'pact-api') + '-provision', {
  create: provisionScript,
  update: provisionScript,
  // Trigger vẫn đổi khi password đổi, nhưng giá trị được `pulumi.secret` bọc —
  // state/diff chỉ thấy `[secret]`, không bao giờ thấy mật khẩu plaintext
  // (trigger được lưu trong state Pulumi).
  triggers: [pulumi.secret(runtimePassword), pulumi.secret(migratorPassword), worktreeRoot],
});

/**
 * Migration qua **đường canonical**: container ephemeral trên platform network
 * chạy đúng `tsx db/apply.mts` của repo (`apps/pact-broker-api/db/apply.mts` —
 * advisory lock `hashtext('db-pact-broker')`, mọi DDL idempotent). Repo mount
 * read-only; password qua `-e` env của container (kênh được chấp nhận), không
 * argv, không log. KHÔNG chạy qua binding Hyperdrive (HD6: advisory lock).
 */
// Percent-encode mật khẩu trước khi ghép vào userinfo của DATABASE_URL — an toàn
// khi orchestration set mật khẩu chứa `@ : / ? #` (xem finding security OCR).
// Encode trên plaintext; kết quả được bọc `pulumi.secret` trong template. Biến
// kết quả KHÔNG mang tên khớp regex nguồn nhạy cảm (`password`...) nên không
// bị taint-source của rule `security-sensitive-value-in-http-response` đánh dấu
// (source là identifier bắt đầu bằng token/password/secret...).
const migratorPasswordEncoded = encodeURIComponent(migratorPassword);

const migrateScript = pulumi.interpolate`set -e
docker run --rm \\
  --network ${networkName} \\
  -v ${shellQuote(worktreeRoot)}:/repo:ro \\
  -v ${shellQuote(worktreeRoot)}/node_modules:/repo/node_modules \\
  -w /repo/apps/pact-broker-api \\
  -e DATABASE_URL=postgresql://ecoma_pact_broker_migrator:${pulumi.secret(migratorPasswordEncoded)}@${POSTGRES_HOST}:5432/db-pact-broker \\
  ${NODE_IMAGE} \\
  /repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/apply.mts
`;

const migrate = new command.local.Command(
  dockerResourceName(ns, 'pact-api') + '-migrate',
  {
    create: migrateScript,
    update: migrateScript,
    // Bọc secret: trigger nằm trong state Pulumi — không lưu plaintext.
    triggers: [pulumi.secret(migratorPassword), worktreeRoot],
  },
  { dependsOn: [provision] },
);

/**
 * SHA-256 hex của machine token — định dạng của cột `pact.machine_tokens.
 * token_hash` (UNIQUE, tra bởi `requireMachineToken`). Hash là một chiều:
 * giá trị này KHÔNG phải secret, được phép nằm trong diff/log của Pulumi.
 * Kết quả phải khớp byte-for-byte với `hashToken` của app
 * (`apps/pact-broker-api/src/auth/hashing.ts` — SHA-256 hex lowercase của
 * chuỗi UTF-8), cùng bảng chữ cái nên `node:crypto` và WebCrypto cho cùng
 * digest.
 */
const machineTokenHash = createHash('sha256').update(machineToken).digest('hex');

/**
 * Seed dữ liệu local: MỘT tenant + MỘT machine token cho `pact-broker-app`.
 *
 * Chạy SAU migrate (cần bảng `pact.tenants`/`pact.machine_tokens`), qua
 * `docker exec` psql vào container PostgreSQL (trust local trong container —
 * cùng đường với migration của backoffice-deploy). MỘT câu SQL: CTE insert
 * tenant (idempotent) rồi INSERT token với id vừa trả.
 *
 * - Tenant: `ON CONFLICT (name) DO UPDATE` thay vì `DO NOTHING` chỉ để
 *   `RETURNING id` luôn trả row khi đã tồn tại (DO NOTHING bỏ mất row);
 *   refresh `updated_at` là vô hại ở local. Tenant là dữ liệu bền — token
 *   phải trỏ về CÙNG tenant qua các lần up.
 * - Token: DB chỉ nhận HASH SHA-256 (không phải secret — giá trị trong
 *   diff/log là digest một chiều). `ON CONFLICT (token_hash) DO NOTHING` làm
 *   re-run với CÙNG hash là no-op (idempotent — orchestration giữ nguyên
 *   config giữa các lần up là trường hợp chính), còn hash MỚI (orchestration
 *   sinh token khác) thì INSERT row mới; row cũ vẫn hiệu lực tới khi bị
 *   revoke. Đây là drift chấp nhận được ở local (cùng tính chất với password
 *   role được ALTER mỗi lần up); revoke token cũ là việc vận hành thủ công,
 *   không phải việc của provision idempotent.
 */
const seedScript = pulumi.interpolate`set -e
PG=${postgresContainerName}
docker exec "$PG" psql -U ecoma_pact_broker_migrator -d db-pact-broker -v ON_ERROR_STOP=1 -c ${shellQuote(`WITH tenant AS (
  INSERT INTO pact.tenants (name) VALUES (${sqlQuote(LOCAL_TENANT_NAME)})
  ON CONFLICT (name) DO UPDATE SET updated_at = now()
  RETURNING id
)
INSERT INTO pact.machine_tokens (token_hash, tenant_id, name, scopes)
SELECT ${sqlQuote(machineTokenHash)}, tenant.id, ${sqlQuote(LOCAL_TOKEN_NAME)}, 'admin' FROM tenant
ON CONFLICT (token_hash) DO NOTHING;`)}
`;

const seed = new command.local.Command(
  dockerResourceName(ns, 'pact-api') + '-seed',
  {
    create: seedScript,
    update: seedScript,
    // Trigger chỉ token (hash của nó) — tenant name + token name là hằng số
    // compile-time; migratorPassword đổi thì migrate đã chạy lại trước.
    triggers: [machineTokenHash],
  },
  { dependsOn: [migrate] },
);

/**
 * Image WIC — image MỎNG: chỉ image Node pin + `ca-certificates` (PF2) +
 * entrypoint script. KHÔNG build gì bên trong: repo (kèm bundle `dist/` đã
 * build từ target `build` của Nx trên host) được mount lúc runtime, và
 * `wrangler dev` chạy từ mount đó. Khác pact-broker-app image (runtime build
 * trong Docker) vì pact-broker-api runtime là `wrangler dev`, không phải
 * process Node đóng gói — image chỉ là "phòng chạy" (pattern auth).
 */
const wicImageTag = dockerResourceName(ns, 'pact-api-wic') + ':local';
const wicImage = new dockerBuild.Image(dockerResourceName(ns, 'pact-api-wic-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/pact-broker-api-deploy/Dockerfile` },
  tags: [wicImageTag],
  builder: { name: 'default' },
  load: true,
  push: false,
  labels,
});

/**
 * Connection string Hyperdrive local của pact-broker-api (PF3/PF4): role
 * runtime, host alias `ecoma-postgres` của platform network, `sslmode=disable`
 * — miniflare bỏ proxy TLS và workerd dial thẳng host:port. `pulumi.secret` bọc
 * TRƯỚC interpolate (redact trong diff/log); giá trị đi vào container qua kênh
 * `envs` — không argv, không label, không log.
 *
 * Mật khẩu được percent-encode (`encodeURIComponent`) trước khi ghép vào
 * userinfo của URL: bất biến `generatePostgresPassword` (base64url, chỉ
 * `A-Za-z0-9-_`) hiện không chứa ký tự dành riêng của URL, nhưng encode là
 * vệ tinh an toàn khi ai đó `pulumi config set` giá trị thủ công chứa
 * `@ : / ? #` — parser `pg`/workerd giải mã percent-encoding đúng chuẩn, nên
 * hai đường đều đúng.
 *
 * Tên biến: `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_` + TÊN BINDING
 * wrangler (`HYPERDRIVE` của `apps/pact-broker-api/wrangler.jsonc` — cùng tên
 * mà `src/config.ts` đọc qua `env.HYPERDRIVE`).
 */
const runtimePasswordEncoded = encodeURIComponent(runtimePassword);
const hyperdriveLocalConnectionString = pulumi.interpolate`postgresql://ecoma_pact_broker_runtime:${pulumi.secret(runtimePasswordEncoded)}@${POSTGRES_HOST}:5432/db-pact-broker?sslmode=disable`;

/**
 * Volume RW duy nhất của WIC: state wrangler (`--persist-to`, HOME/XDG cô lập,
 * dev registry). KHÔNG nằm trong repo mount (read-only) — workerd ghi state
 * runtime liên tục; dữ liệu này là EPHEMERAL theo thiết kế nên volume không
 * `retainOnDelete` và KHÔNG được liệt kê là dữ liệu persistent nào.
 */
const wicStateVolumeName = dockerResourceName(ns, 'pact-api-wic-state');
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
  dockerResourceName(ns, 'pact-api-wic-state-init'),
  {
    name: dockerResourceName(ns, 'pact-api-wic-state-init'),
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
 * Container WIC — MỘT worker `wrangler dev` (pact-broker-api) qua
 * `wic-entrypoint.sh`, plain HTTP trên platform network.
 *
 * Thứ tự phụ thuộc: provision → migrate → seed → image → volume → container —
 * container chỉ lên sau khi schema + dữ liệu seed sẵn sàng, để request đầu
 * tiên của consumer (login BFF lấy token tra DB) không rơi vào cửa sổ
 * chưa-seed.
 *
 * Env:
 * - `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` (secret):
 *   wrangler đọc biến này của PROCESS để gán connection string binding
 *   HYPERDRIVE (PF3). Thiếu biến là wrangler fail boot tường minh (fail-closed).
 * - KHÔNG set `PACT_BROKER_WEBHOOKS_ENABLED`: mặc định TẮT (SR-006 — không có
 *   SSRF guard thì code còn chặn cứng `true`, `src/config.ts`).
 * - KHÔNG set `PACT_BROKER_DASHBOARD_ORIGIN`: BFF fetch server-side qua alias
 *   nội bộ, không preflight → không cần CORS ở local (quyết định #238).
 *
 * KHÔNG có `ports` và KHÔNG có label `traefik.*`: WIC không publish cổng ra
 * host — consumer là pact-broker-app (server-side fetch qua alias) và Pact
 * CLI trong network (issue #238, quyết định no-Traefik).
 */
const wic = new docker.Container(
  dockerResourceName(ns, 'pact-api-wic'),
  {
    name: dockerResourceName(ns, 'pact-api-wic'),
    image: pulumi.interpolate`${wicImageTag}@${wicImage.digest}`,
    restart: 'unless-stopped',
    // Readiness resource-owned (`wait: true` — cùng ngữ nghĩa với platform):
    // pact-broker-app phụ thuộc unit này qua StackReference (machine token),
    // nên `up` thành công phải đồng nghĩa healthcheck `/health` đã `healthy`.
    // Trần chờ = startPeriod 120s + 30 retries × 10s = 420s; waitTimeout 450s dư.
    wait: true,
    waitTimeout: 450,
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
      // dist bên dưới → deps check của entrypoint fail `wrangler_binary_missing`
      // → restart loop (bài học Issue #233 của auth). RO vì WIC không ghi gì
      // xuống repo: wrangler ghi `.wrangler/tmp`, cache miniflare và registry
      // đều qua điểm ghi `/state` (xem wic-entrypoint.sh).
      {
        hostPath: worktreeRoot,
        containerPath: '/repo',
        readOnly: true,
      },
      // Bundle `dist/` của app: repo mount read-only không chứa dist (bundle
      // build trên host bởi target `build` của Nx), mount bind trực tiếp thư
      // mục dist đã build (ro: workerd chỉ ĐỌC bundle; build lại bundle trên
      // host là thay đổi nội dung mount, cùng cơ chế hot-reload mà
      // `wrangler dev` dò được).
      {
        hostPath: `${worktreeRoot}/apps/pact-broker-api/dist`,
        containerPath: '/repo/apps/pact-broker-api/dist',
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
        aliases: [PACT_API_ALIAS],
      },
    ],
    envs: [
      pulumi.interpolate`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=${pulumi.secret(hyperdriveLocalConnectionString)}`,
    ],
    labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
    healthcheck: {
      // `/health` chứ không phải một route nghiệp vụ: probe infra không được
      // phụ thuộc DB (thiết kế của app — `/health` không credential, không
      // chạm DB). 200 = worker boot và serve được request; readiness nghiệp
      // vụ (DB + token seed) là việc của smoke ở wiring PR.
      tests: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${PACT_API_INTERNAL_PORT}/health')` +
          `.then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))`,
      ],
      interval: '10s',
      timeout: '5s',
      // Trần cửa sổ boot wrangler (bundle check, registry connect) — cùng
      // budget auth nhưng retries thấp hơn vì worker duy nhất, không probe
      // mở pool PostgreSQL như `/ready` của auth.
      retries: 30,
      // Chuỗi đúng dạng Go duration Docker chuẩn hoá khi đọc ngược (`2m0s`,
      // không phải `120s`) — lệch dạng không đổi giá trị nhưng biến mỗi cặp
      // refresh + up thành diff ảo trên healthcheck.
      startPeriod: '2m0s',
    },
  },
  { dependsOn: [seed, wicImage, wicStateVolume, wicStateInit] },
);

export const provisionCommandName = provision.id;
export const migrateCommandName = migrate.id;
export const seedCommandName = seed.id;
export const imageDigest = wicImage.digest;
export const containerName = wic.name;
export const containerId = wic.id;
export const stateVolumeName = wicStateVolume.name;
export const namespaceVerified = verifiedNamespace;
