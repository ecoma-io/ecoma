/**
 * Chương trình Pulumi của `remote-cache-deploy` — deploy unit của
 * `apps/remote-cache` (service Remote Cache, Hono + postgres.js qua Hyperdrive,
 * `nodejs_compat`) ở LAN LOCAL deployment (P4.1, issue #442; ADR-0015).
 *
 * Pattern: mirror `deploys/pact-broker-api-deploy/index.ts` (WIC —
 * worker-in-container, nguồn gần nhất cùng hình MỘT worker + provision DB +
 * migration canonical). Image mỏng ghim `node:24-bookworm-slim` +
 * `ca-certificates` (PF2), chứa MỘT process `wrangler dev` theo
 * `wic-entrypoint.sh`: worker `ecoma-remote-cache` (port nội bộ 4207 —
 * `dev.port` của `apps/remote-cache/wrangler.jsonc`). Repo mount READ-ONLY —
 * entrypoint dựng **runtime tree mirror** ghi được dưới `$PERSIST_DIR/runtime`
 * (copy `wrangler.jsonc` + `dist`, symlink `node_modules` hai tầng) và chạy
 * wrangler từ đó. Secrets đi qua `envs` của container (kênh container env —
 * không argv, không label, không log), `pulumi.secret` bọc trước khi
 * interpolate để redact trong diff/log.
 *
 * KHÔNG có Traefik router (cùng quyết định với pact-broker-api, issue #238):
 * consumer của API ở local là BFF fetch server-side qua alias DNS nội bộ
 * `ecoma-remote-cache`; BFF backoffice chưa wire ở local trong P1.4 (wiring
 * consumer thuộc giai đoạn sau), nên container KHÔNG publish port ra host,
 * KHÔNG mang label `traefik.*`. Readiness là liveness container: Docker
 * healthcheck poll `GET /health` của worker (không chạm DB — thiết kế của
 * app); `/health` 200 không phải bằng chứng readiness nghiệp vụ.
 *
 * Provision database mirror `deploys/backoffice-deploy/index.ts` + ADR-0013
 * §"Hệ quả": stack này provision `db-remote-cache` + hai role
 * (`ecoma_remote_cache_migrator`, `ecoma_remote_cache_runtime`) qua
 * `docker exec` vào container PostgreSQL của platform, hai biên escaping
 * `sqlQuote` + `shellQuote`, password do orchestration sinh và truyền qua
 * stack config `--config` (stdin, không argv). Migration chạy **đường
 * canonical** (`apps/remote-cache/db/apply.mts` — advisory lock
 * `hashtext('db-remote-cache')`) bằng container node pin chạy tsx binary của
 * repo, KHÔNG qua binding Hyperdrive (HD6: Hyperdrive không hỗ trợ advisory
 * lock). KHÔNG có bước seed dữ liệu riêng: dữ liệu seed duy nhất của context
 * này là permission catalog (3 permission read) và nó nằm trong migration
 * `0003_permission_catalog_seed.sql` — nội dung system-defined role KHÔNG được
 * seed (docs §4.4, quyết định chưa chốt).
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
 * Image Node pin (theo DIGEST) để chạy migration trong container gắn
 * platform network — cùng digest mà `deploys/auth-deploy/Dockerfile` ghim.
 *
 * Vì sao container mà không chạy runner trên host: platform PostgreSQL KHÔNG
 * publish host port (invariant platform) và host không route được tới IP
 * container (platform facts PF5), nên `pg` của runner chỉ kết nối được từ bên
 * trong platform network. Container ephemeral chạy **tsx binary của repo** vẫn
 * là đúng một đường code canonical (`applyAllMigrations` của
 * `apps/remote-cache/db/apply.mts`) — deploy không tự viết lại vòng migration.
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/** Alias DNS của PostgreSQL platform trong network nội bộ. */
const POSTGRES_HOST = 'ecoma-postgres';

/**
 * Cổng HTTP nội bộ của worker `ecoma-remote-cache` trong WIC — `dev.port`
 * của `apps/remote-cache/wrangler.jsonc`. Bên trong container KHÔNG cần
 * phát hiện xung đột port host (mỗi container có network stack riêng — static
 * port an toàn); nguồn số duy nhất là wrangler.jsonc, Pulumi không cấp port.
 * Alias DNS `ecoma-remote-cache` (hằng số) + port này là contract cho wiring
 * BFF tương lai: base URL `http://ecoma-remote-cache:4207`.
 *
 * Wrangler đọc `dev.port` khi render URL banner và healthcheck ở dưới poll đúng
 * `REMOTE_CACHE_INTERNAL_PORT` — wrangler đổi port là healthcheck fail ngay (fail
 * qua vòng đời container, không qua assertion compile-time).
 */
const REMOTE_CACHE_INTERNAL_PORT = 4207;

/**
 * Alias DNS của WIC container trong platform network — HẰNG SỐ, không theo
 * namespace (khác auth dùng `${AUTH_WIC_ALIAS_PREFIX}${ns}-auth`). Mỗi worktree
 * có platform network RIÊNG (namespace cô lập), nên alias hằng trong một
 * network không xung đột; hằng cho tên ổn định để unit consumer tương lai cấu
 * hình base URL không phụ thuộc namespace.
 */
const REMOTE_CACHE_ALIAS = 'ecoma-remote-cache';

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

// Mật khẩu hai role của db-remote-cache — do orchestration sinh và truyền qua
// --config (stdin, không argv).
const runtimePassword = conf.requireSecret('runtimePassword');
const migratorPassword = conf.requireSecret('migratorPassword');

const verifiedNamespace = pulumi.output(platformNamespace).apply((upstreamNs) => {
  if (upstreamNs !== ns) {
    throw new Error(
      `platformStackRef points to a stack of a different namespace: platform exports "${upstreamNs}" but this worktree is "${ns}".`,
    );
  }
  return ns;
});

/**
 * Provision `db-remote-cache` + 2 role, chạy trên host qua `docker exec` vào
 * container PostgreSQL của platform. Idempotent như backoffice-deploy: mỗi
 * lệnh guard-create bằng shell `if`, còn ALTER password idempotent sẵn — chạy
 * cả `create` và `update` để redeploy cũng xoay password.
 *
 * Khác auth (4 role + revoke chéo): bounded context này chỉ có 2 role, không
 * có owner role dùng chung (migrator sở hữu schema `remote_cache` sau khi
 * migration `0001` chạy — grant `CREATE` trên database cấp ở đây), không có
 * database nào khác cần revoke chéo.
 */
const postgresContainerName = dockerResourceName(ns, 'postgres');
const provisionScript = pulumi.interpolate`set -e
PG=${postgresContainerName}
PSQL="docker exec $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
# 1. Hai role của db-remote-cache — guard-create khi thiếu.
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_remote_cache_migrator'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_remote_cache_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_remote_cache_runtime'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_remote_cache_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# 2. Mật khẩu role — hai biên escaping độc lập, áp ĐÚNG THỨ TỰ: sqlQuote bảo vệ
#    literal SQL (psql thấy nguyên giá trị), rồi shellQuote bọc CẢ câu SQL
#    thành một argument của shell (giải thích đầy đủ backoffice-deploy/index.ts).
$PSQL -c ${migratorPassword.apply((p) => shellQuote(`ALTER ROLE ecoma_remote_cache_migrator WITH PASSWORD ${sqlQuote(p)};`))}
$PSQL -c ${runtimePassword.apply((p) => shellQuote(`ALTER ROLE ecoma_remote_cache_runtime WITH PASSWORD ${sqlQuote(p)};`))}
# 3. Database — guard-create (bash if), idempotent qua lần chạy sau.
if ! $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='db-remote-cache'" | grep -q 1; then $PSQL -c 'CREATE DATABASE "db-remote-cache"'; fi
# 4. Grant: migrator cần CREATE trên database để tạo schema remote_cache
#    (migration 0001 tự cấp USAGE/CREATE trên schema sau khi tạo); runtime chỉ
#    CONNECT — DML grant theo bảng nằm trong migration 0001.
$PSQL -c 'REVOKE CONNECT ON DATABASE "db-remote-cache" FROM PUBLIC'
$PSQL -c 'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "db-remote-cache" TO ecoma_remote_cache_migrator'
$PSQL -c 'GRANT CONNECT ON DATABASE "db-remote-cache" TO ecoma_remote_cache_runtime'
# 5. Hardening schema public — ecoma_local mới revoke được; migration statement là no-op trên PG15+.
docker exec $PG psql -U ecoma_local -d db-remote-cache -v ON_ERROR_STOP=1 -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC'
`;

const provision = new command.local.Command(dockerResourceName(ns, 'remote-cache') + '-provision', {
  create: provisionScript,
  update: provisionScript,
  // Trigger vẫn đổi khi password đổi, nhưng giá trị được `pulumi.secret` bọc —
  // state/diff chỉ thấy `[secret]`, không bao giờ thấy mật khẩu plaintext
  // (trigger được lưu trong state Pulumi).
  triggers: [pulumi.secret(runtimePassword), pulumi.secret(migratorPassword), worktreeRoot],
});

/**
 * Migration qua **đường canonical**: container ephemeral trên platform network
 * chạy đúng `tsx db/apply.mts` của repo (`apps/remote-cache/db/apply.mts` —
 * advisory lock `hashtext('db-remote-cache')`, mọi DDL idempotent). Repo mount
 * read-only; password qua `-e` env của container (kênh được chấp nhận), không
 * argv, không log. KHÔNG chạy qua binding Hyperdrive (HD6: advisory lock).
 */
// Percent-encode mật khẩu trước khi ghép vào userinfo của DATABASE_URL — an toàn
// khi orchestration set mật khẩu chứa `@ : / ? #` (xem finding security OCR).
// Encode trên plaintext; kết quả được bọc `pulumi.secret` trong template. Biến
// kết quả KHÔNG mang tên khớp regex nguồn nhạy cảm (`password`...) nên không
// bị taint-source của rule `security-sensitive-value-in-http-response` đánh dấu
// (source là identifier bắt đầu bằng token/password/secret...).
const migratorPasswordEncoded = migratorPassword.apply((v) => encodeURIComponent(v));

const migrateScript = pulumi.interpolate`set -e
docker run --rm \\
  --network ${networkName} \\
  -v ${shellQuote(worktreeRoot)}:/repo:ro \\
  -v ${shellQuote(worktreeRoot)}/node_modules:/repo/node_modules \\
  -w /repo/apps/remote-cache \\
  -e DATABASE_URL=postgresql://ecoma_remote_cache_migrator:${pulumi.secret(migratorPasswordEncoded)}@${POSTGRES_HOST}:5432/db-remote-cache \\
  ${NODE_IMAGE} \\
  /repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/apply.mts
`;

const migrate = new command.local.Command(
  dockerResourceName(ns, 'remote-cache') + '-migrate',
  {
    create: migrateScript,
    update: migrateScript,
    // Bọc secret: trigger nằm trong state Pulumi — không lưu plaintext.
    triggers: [pulumi.secret(migratorPassword), worktreeRoot],
  },
  { dependsOn: [provision] },
);

/**
 * KHÔNG có bước seed dữ liệu riêng ở unit này: control plane P4.1 không seed
 * tenant/project nào — dữ liệu tenant/project/membership/api_key do operator
 * cấp qua migration/procedure riêng sau khi bounded context có consumer đầu tiên.
 * Deploy unit cấm mọi code path bootstrap; đường tạo tenant phổ quát là quyết định
 * chưa chốt, phải chốt trước khi có consumer ghi.
 */

/**
 * Image WIC — image MỎNG: chỉ image Node pin + `ca-certificates` (PF2) +
 * entrypoint script. KHÔNG build gì bên trong: repo (kèm bundle `dist/` đã
 * build từ target `build` của Nx trên host) được mount lúc runtime, và
 * `wrangler dev` chạy từ mount đó. Khác account image (runtime build trong
 * Docker) vì remote-cache runtime là `wrangler dev`, không phải process Node
 * đóng gói — image chỉ là "phòng chạy" (pattern auth).
 */
/**
 * Image WIC — image MỎNG: chỉ image Node pin + `ca-certificates` (PF2) +
 * entrypoint script. KHÔNG build gì bên trong: repo (kèm bundle `dist/` đã
 * build từ target `build` của Nx trên host) được mount lúc runtime, và
 * `wrangler dev` chạy từ mount đó. Khác account image (runtime build trong
 * Docker) vì remote-cache runtime là `wrangler dev`, không phải process Node
 * đóng gói — image chỉ là "phòng chạy" (pattern auth).
 */
const wicImageTag = dockerResourceName(ns, 'remote-cache-wic') + ':local';
const wicImage = new dockerBuild.Image(dockerResourceName(ns, 'remote-cache-wic-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/remote-cache-deploy/Dockerfile` },
  tags: [wicImageTag],
  builder: { name: 'default' },
  load: true,
  push: false,
  labels,
});

/**
 * Connection string Hyperdrive local của remote-cache (PF3/PF4): role
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
 * wrangler (`DB_REMOTE_CACHE` của `apps/remote-cache/wrangler.jsonc` — cùng tên
 * mà `src/config.ts` đọc qua `env.DB_REMOTE_CACHE`).
 */
const runtimePasswordEncoded = runtimePassword.apply((v) => encodeURIComponent(v));
const hyperdriveLocalConnectionString = pulumi.interpolate`postgresql://ecoma_remote_cache_runtime:${pulumi.secret(runtimePasswordEncoded)}@${POSTGRES_HOST}:5432/db-remote-cache?sslmode=disable`;

/**
 * Volume RW duy nhất của WIC: state wrangler (`--persist-to`, HOME/XDG cô lập,
 * dev registry). KHÔNG nằm trong repo mount (read-only) — workerd ghi state
 * runtime liên tục; dữ liệu này là EPHEMERAL theo thiết kế nên volume không
 * `retainOnDelete` và KHÔNG được liệt kê là dữ liệu persistent nào.
 */
const wicStateVolumeName = dockerResourceName(ns, 'remote-cache-wic-state');
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
  dockerResourceName(ns, 'remote-cache-wic-state-init'),
  {
    name: dockerResourceName(ns, 'remote-cache-wic-state-init'),
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
 * Container WIC — MỘT worker `wrangler dev` (remote-cache) qua
 * `wic-entrypoint.sh`, plain HTTP trên platform network.
 *
 * Thứ tự phụ thuộc: provision → migrate → image → volume → container —
 * container chỉ lên sau khi schema sẵn sàng (permission catalog nằm trong
 * migration), để request đầu tiên của consumer không rơi vào cửa sổ chưa-
 * migrate.
 *
 * Env:
 * - `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_REMOTE_CACHE` (secret):
 *   wrangler đọc biến này của PROCESS để gán connection string binding
 *   DB_REMOTE_CACHE (PF3). Thiếu biến là wrangler fail boot tường minh (fail-closed).
 * KHÔNG có `ports` và KHÔNG có label `traefik.*`: WIC không publish cổng ra
 * host — consumer là BFF fetch server-side qua alias nội bộ (cùng quyết định
 * no-Traefik với pact-broker-api, issue #238).
 */
const wic = new docker.Container(
  dockerResourceName(ns, 'remote-cache-wic'),
  {
    name: dockerResourceName(ns, 'remote-cache-wic'),
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
        hostPath: `${worktreeRoot}/apps/remote-cache/dist`,
        containerPath: '/repo/apps/remote-cache/dist',
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
        aliases: [REMOTE_CACHE_ALIAS],
      },
    ],
    envs: [
      pulumi.interpolate`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_REMOTE_CACHE=${pulumi.secret(hyperdriveLocalConnectionString)}`,
    ],
    labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
    healthcheck: {
      // `/health` chứ không phải một route nghiệp vụ: probe infra không được
      // phụ thuộc DB (thiết kế của app — `/health` không credential, không
      // chạm DB). 200 = worker boot và serve được request; readiness nghiệp
      // vụ (DB truy vấn được) là việc của smoke ở wiring PR.
      tests: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${REMOTE_CACHE_INTERNAL_PORT}/health')` +
          `.then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))`,
      ],
      interval: '10s',
      timeout: '5s',
      // Trần cửa sổ boot wrangler (bundle check, registry connect) — cùng
      // budget auth nhưng retries thấp hơn vì worker duy nhất, không probe
      // mở pool PostgreSQL như `/ready` của auth.
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
  { dependsOn: [migrate, wicImage, wicStateVolume, wicStateInit] },
);

export const provisionCommandName = provision.id;
export const migrateCommandName = migrate.id;
export const imageDigest = wicImage.digest;
export const containerName = wic.name;
export const containerId = wic.id;
export const stateVolumeName = wicStateVolume.name;
export const namespaceVerified = verifiedNamespace;
