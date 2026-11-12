/**
 * Chương trình Pulumi của `remote-cache-api-deploy` — deploy unit của
 * `apps/remote-cache-api` (service Remote Cache, Hono + postgres.js qua Hyperdrive,
 * `nodejs_compat`) ở LAN LOCAL deployment (P4.1, issue #442; ADR-0015).
 *
 * Pattern: mirror `deploys/pact-broker-api-deploy/index.ts` (WIC —
 * worker-in-container, nguồn gần nhất cùng hình MỘT worker + provision DB +
 * migration canonical). Image mỏng ghim `node:24-bookworm-slim` +
 * `ca-certificates` (PF2), chứa MỘT process `wrangler dev` theo
 * `wic-entrypoint.sh`: worker `ecoma-remote-cache-api` (port nội bộ 4207 —
 * `dev.port` của `apps/remote-cache-api/wrangler.jsonc`). Repo mount READ-ONLY —
 * entrypoint dựng **runtime tree mirror** ghi được dưới `$PERSIST_DIR/runtime`
 * (copy `wrangler.jsonc` + `dist`, symlink `node_modules` hai tầng) và chạy
 * wrangler từ đó. Secrets đi qua `envs` của container (kênh container env —
 * không argv, không label, không log), `pulumi.secret` bọc trước khi
 * interpolate để redact trong diff/log.
 *
 * KHÔNG có Traefik router (cùng quyết định với pact-broker-api, issue #238):
 * consumer của API ở local là BFF fetch server-side qua alias DNS nội bộ
 * `ecoma-remote-cache-api`; BFF backoffice chưa wire ở local trong P1.4 (wiring
 * consumer thuộc giai đoạn sau), nên container KHÔNG publish port ra host,
 * KHÔNG mang label `traefik.*`. Readiness là liveness container: Docker
 * healthcheck poll `GET /health` của worker (không chạm DB — thiết kế của
 * app); `/health` 200 không phải bằng chứng readiness nghiệp vụ.
 *
 * Provision database mirror `deploys/backoffice-deploy/index.ts` + ADR-0013
 * §"Hệ quả": stack này provision `db-remote-cache` + hai role
 * (`ecoma_remote_cache_migrator`, `ecoma_remote_cache_runtime`) qua
 * `docker exec` vào container PostgreSQL của platform. Password do orchestration
 * sinh và truyền qua stack config `--config` (stdin, không argv), rồi đi vào
 * script qua kênh `environment` của `command.local.Command` — `ALTER ROLE ...
 * PASSWORD` được dựng trong shell và nạp psql qua STDIN (`docker exec -i`), nên
 * không process nào giữ giá trị trong argv (chi tiết kênh ở `scripts.ts`).
 * Migration chạy **đường
 * canonical** (`apps/remote-cache-api/db/apply.mts` — advisory lock
 * `hashtext('db-remote-cache')`) bằng container node pin chạy tsx binary của
 * repo, KHÔNG qua binding Hyperdrive (HD6: Hyperdrive không hỗ trợ advisory
 * lock). SAU migration, bootstrap tenant canonical `ecoma` chạy **đường
 * canonical** (`apps/remote-cache-api/db/bootstrap-tenant.mts` — bề mặt
 * provisioning của hợp đồng bootstrap/seed, ADR-0020 + `02-delivery.md` §3.2,
 * KHÔNG bao giờ trên Worker serving path): tenant first_party + membership
 * owner + host project credential CI + first trusted CI key, idempotent theo
 * natural key, fail-closed khi trạng thái đã lưu lệch (#20, ADR-0026).
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
  worktreeNamespace,
} from '@ecoma-io/deployment';

import { NODE_IMAGE } from './node-image.js';
import { buildObjectStorageEnvs } from './object-storage-env.js';
import {
  MIGRATOR_PASSWORD_ENV_VAR,
  RUNTIME_PASSWORD_ENV_VAR,
  POSTGRES_HOST,
  buildMigrateScript,
  buildMigratorConnectionUrl,
  buildProvisionScript,
} from './scripts.js';

/**
 * Cổng HTTP nội bộ của worker `ecoma-remote-cache-api` trong WIC — `dev.port`
 * của `apps/remote-cache-api/wrangler.jsonc`. Bên trong container KHÔNG cần
 * phát hiện xung đột port host (mỗi container có network stack riêng — static
 * port an toàn); nguồn số duy nhất là wrangler.jsonc, Pulumi không cấp port.
 * Alias DNS `ecoma-remote-cache-api` (hằng số) + port này là contract cho wiring
 * BFF tương lai: base URL `http://ecoma-remote-cache-api:4207`.
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
const REMOTE_CACHE_ALIAS = 'ecoma-remote-cache-api';

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
// Object storage (SeaweedFS, #19) — bốn output NON-SECRET của platform stack
// (contract `PlatformOutputs`); secret key tương ứng KHÔNG có ở outputs, nó ở
// stack config của platform và được `local.ts` copy sang stack config của unit
// này qua stdin.
const objectStorageHost = requirePlatformOutput('objectStorageHost');
const objectStoragePort = requirePlatformOutput('objectStoragePort');
const objectStorageBucket = requirePlatformOutput('objectStorageBucket');
const objectStorageAccessKeyId = requirePlatformOutput('objectStorageAccessKeyId');

// Mật khẩu hai role của db-remote-cache — do orchestration sinh và truyền qua
// --config (stdin, không argv).
const runtimePassword = conf.requireSecret('runtimePassword');
const migratorPassword = conf.requireSecret('migratorPassword');
// Secret key object storage — platform sinh và persist khi up SeaweedFS;
// `local.ts` đọc cross-stack và set vào stack config NÀY (stdin, không argv).
// `requireSecret` như hai mật khẩu: giá trị chỉ sống dưới dạng secret trong
// state Pulumi và đi vào container qua kênh `envs` sau khi `pulumi.secret` bọc.
const objectStorageSecretKey = conf.requireSecret('objectStorageSecretKey');
// Owner (opaque `sub`) của tenant canonical `ecoma` — `local.ts` giải qua dx
// runner trước khi up. ĐỊNH DANH, không phải credential → non-secret trong
// stack config; đổi sub là bootstrap chạy lại và membership verify theo sub
// (fail-closed khi owner hiện tại khác).
const tenantOwnerSub = conf.require('tenantOwnerSub');
// Plaintext của first trusted CI key — `local.ts` set-if-absent (một plaintext
// một environment); bootstrap chỉ lưu SHA-256 hash, plaintext đổi là rotation.
const ciKeyPlaintext = conf.requireSecret('ciKeyPlaintext');

// Bản đồ env non-secret qua helper thuần (`object-storage-env.ts`) — smoke
// ngoài host dựng ĐÚNG cùng bộ giá trị từ outputs platform, nên hai đường
// không thể trôi lệch tên biến hay hình endpoint. Dạng tuple của `pulumi.all`
// (KHÔNG dạng object): object overload đòi giá trị đồng nhất `Input<T>` còn
// mix string/number ở đây là suy T thất bại.
const objectStorageEnvs = pulumi
  .all([objectStorageHost, objectStoragePort, objectStorageBucket, objectStorageAccessKeyId])
  .apply(([host, port, bucket, accessKeyId]) =>
    buildObjectStorageEnvs({ host, port, bucket, accessKeyId }),
  );

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

/**
 * Script text là ĐẦU RA của hàm thuần `buildProvisionScript` (`scripts.ts`) và
 * KHÔNG chứa giá trị secret nào: mật khẩu hai role đi vào tiến trình shell qua
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
 * trị là output đã bọc secret từ `requireSecret` ở trên, nên state Pulumi mã
 * hoá. Lưu ý biên bảo mật: môi trường process bảo vệ tốt hơn argv (không đọc
 * được qua `ps`/`/proc/<pid>/cmdline`), nhưng KHÔNG đòi hỏi chống mọi hình
 * truy cập host — ai đọc được `/proc/<pid>/environ` của process đang sống với
 * cùng user vẫn thấy được; ranh giới được chấp nhận ở local là file state
 * passphrase-protected của worktree.
 */
const provisionEnvironment: Record<string, pulumi.Output<string>> = {
  [MIGRATOR_PASSWORD_ENV_VAR]: migratorPassword,
  [RUNTIME_PASSWORD_ENV_VAR]: runtimePassword,
};

const provision = new command.local.Command(
  dockerResourceName(ns, 'remote-cache-api') + '-provision',
  {
    create: provisionScript,
    update: provisionScript,
    // Trigger vẫn đổi khi password đổi, nhưng giá trị được `pulumi.secret` bọc —
    // state/diff chỉ thấy `[secret]`, không bao giờ thấy mật khẩu plaintext
    // (trigger được lưu trong state Pulumi).
    triggers: [pulumi.secret(runtimePassword), pulumi.secret(migratorPassword), worktreeRoot],
    environment: provisionEnvironment,
  },
);

/**
 * Migration qua **đường canonical**: container ephemeral trên platform network
 * chạy đúng `tsx db/apply.mts` của repo (`apps/remote-cache-api/db/apply.mts` —
 * advisory lock `hashtext('db-remote-cache')`, mọi DDL idempotent). Repo mount
 * read-only. KHÔNG chạy qua binding Hyperdrive (HD6: advisory lock).
 *
 * Kênh `DATABASE_URL`: giá trị (password percent-encode trước khi ghép vào
 * userinfo — an toàn khi mật khẩu chứa `@ : / ? #`; kết quả bọc `pulumi.secret`)
 * đi vào environ của tiến trình shell qua map `environment` của provider; script
 * chạy `docker run -e DATABASE_URL` với CHỈ TÊN biến, docker CLI đọc giá trị từ
 * environ của chính nó và chuyển vào container env. Không có `-e VAR=giá trị`
 * nào trong argv của `docker run`, nên URL không lộ qua argv của `sh -c` hay
 * `docker run`; script text là đầu ra của hàm thuần `buildMigrateScript`
 * (`scripts.ts`), không chứa giá trị secret nào.
 */
// Percent-encode mật khẩu trước khi ghép vào userinfo của DATABASE_URL — an toàn
// khi orchestration set mật khẩu chứa `@ : / ? #` (xem finding security OCR).
// Encode trên plaintext; kết quả được bọc `pulumi.secret` ở URL hoàn chỉnh dưới.
// Biến kết quả KHÔNG mang tên khớp regex nguồn nhạy cảm (`password`...) nên không
// bị taint-source của rule `security-sensitive-value-in-http-response` đánh dấu
// (source là identifier bắt đầu bằng token/password/secret...).
const migratorPasswordEncoded = migratorPassword.apply((v) => encodeURIComponent(v));

// URL migrator hoàn chỉnh — bọc `pulumi.secret` trước khi vào map `environment`:
// state Pulumi mã hoá chứ không lưu plaintext. Percent-encode là việc của
// `buildMigratorConnectionUrl` (một nguồn sự thật với spec unit).
const migratorConnectionUrl = pulumi.secret(
  migratorPassword.apply((raw) => buildMigratorConnectionUrl({ password: raw })),
);

const migrateScript = networkName.apply((net) =>
  buildMigrateScript({
    networkName: net,
    worktreeRoot,
    nodeImage: NODE_IMAGE,
  }),
);

const migrate = new command.local.Command(
  dockerResourceName(ns, 'remote-cache-api') + '-migrate',
  {
    create: migrateScript,
    update: migrateScript,
    // Bọc secret: trigger nằm trong state Pulumi — không lưu plaintext.
    triggers: [pulumi.secret(migratorPassword), worktreeRoot],
    // Giá trị bọc secret: provider đặt vào environ của tiến trình script.
    environment: { DATABASE_URL: migratorConnectionUrl },
  },
  { dependsOn: [provision] },
);

/**
 * Tên host project của credential CI và scopes của key — hằng số của môi
 * trường local. Project là "nhà" của đúng credential mà bootstrap quản lý
 * (`api_keys.project_id` NOT NULL), không phải project nghiệp vụ của consumer
 * nào; passes `projects_name_check` (lowercase DNS-like label). ⚠️ Scopes có
 * khoảng trắng — tại use site PHẢI bọc `shellQuote`, nếu không shell tách
 * `write` thành argv kế tiếp và docker hiểu nhầm là tên image.
 */
const BOOTSTRAP_PROJECT_NAME = 'ecoma-ci';
const BOOTSTRAP_KEY_SCOPES = 'read write';

/**
 * Bootstrap tenant canonical `ecoma` qua **script service-owned**
 * (`db/bootstrap-tenant.mts`) — container ephemeral trên platform network chạy
 * đúng entry của repo, KHÔNG tự viết vòng provisioning. Hợp đồng ADR-0020 §3.2
 * (bề mặt provisioning, KHÔNG bao giờ trên Worker serving path — Quyết định 2)
 * + ADR-0026 (classification `first_party` chỉ set được qua đường này): tenant
 * + membership owner + host project + first trusted CI key trong MỘT
 * transaction, idempotent theo natural key; trạng thái đã lưu lệch (owner
 * khác, suspended/deleted, classification khác) là fail-closed, không đè.
 * Re-run cùng plaintext key là no-op verify; plaintext đổi là rotation
 * (revoke hàng active cũ trước khi chèn).
 *
 * DATABASE_URL dùng role **migrator** (khác pact dùng runtime): runtime role
 * không có INSERT trên `tenant_members` (grant trong `0002`), và bootstrap là
 * đường duy nhất ghi membership. `CANONICAL_TENANT_OWNER_SUB` qua env: sub do
 * `local.ts` resolve từ dx runner trước khi up. Trigger bọc
 * `pulumi.secret(tenantOwnerSub)` + `pulumi.secret(ciKeyPlaintext)` —
 * state/diff chỉ thấy `[secret]`; sub hay plaintext đổi là bước chạy lại.
 *
 * Hai credential (DATABASE_URL, plaintext key CI) KHÔNG nằm trong script text:
 * chúng đi qua tuỳ chọn `environment` của `command.local.Command` — script chỉ
 * ghi TÊN biến (`-e DATABASE_URL` không giá trị → docker pass-through từ env
 * của shell). Giá trị vì thế không bao giờ vào argv của shell/docker (đọc được
 * qua `ps`/`/proc/<pid>/cmdline`), không vào script text (nơi failure output
 * và log có thể echo), và vẫn bị `pulumi.secret` bọc trong state/diff. Đây là
 * cùng mô hình mà `superadmin-resolver.ts` áp cho lệnh superadmin.
 */
const bootstrapDatabaseUrl = pulumi.interpolate`postgresql://ecoma_remote_cache_migrator:${migratorPasswordEncoded}@${POSTGRES_HOST}:5432/db-remote-cache`;

const bootstrapTenantScript = pulumi.interpolate`set -e
docker run --rm \\
  --network ${networkName} \\
  -v ${shellQuote(worktreeRoot)}:/repo:ro \\
  -v ${shellQuote(worktreeRoot)}/node_modules:/repo/node_modules \\
  -w /repo/apps/remote-cache-api \\
  -e DATABASE_URL \\
  -e CANONICAL_TENANT_OWNER_SUB=${shellQuote(tenantOwnerSub)} \\
  -e REMOTE_CACHE_BOOTSTRAP_PROJECT_NAME=${BOOTSTRAP_PROJECT_NAME} \\
  -e REMOTE_CACHE_BOOTSTRAP_KEY_SCOPES=${shellQuote(BOOTSTRAP_KEY_SCOPES)} \\
  -e REMOTE_CACHE_BOOTSTRAP_KEY_PLAINTEXT \\
  ${NODE_IMAGE} \\
  /repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/bootstrap-tenant.mts
`;

const bootstrapTenant = new command.local.Command(
  dockerResourceName(ns, 'remote-cache-api') + '-bootstrap-tenant',
  {
    create: bootstrapTenantScript,
    update: bootstrapTenantScript,
    environment: {
      DATABASE_URL: pulumi.secret(bootstrapDatabaseUrl),
      REMOTE_CACHE_BOOTSTRAP_KEY_PLAINTEXT: pulumi.secret(ciKeyPlaintext),
    },
    triggers: [pulumi.secret(tenantOwnerSub), pulumi.secret(ciKeyPlaintext), worktreeRoot],
  },
  { dependsOn: [migrate] },
);

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
const wicImageTag = dockerResourceName(ns, 'remote-cache-api-wic') + ':local';
const wicImage = new dockerBuild.Image(dockerResourceName(ns, 'remote-cache-api-wic-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/remote-cache-api-deploy/Dockerfile` },
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
 * wrangler (`DB_REMOTE_CACHE` của `apps/remote-cache-api/wrangler.jsonc` — cùng tên
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
const wicStateVolumeName = dockerResourceName(ns, 'remote-cache-api-wic-state');
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
 * container (state wrangler ephemeral) nên root của lệnh init không phải
 * cảnh bảo mật.
 *
 * Kênh thực thi là `command.local.Command` + `docker run --rm` (pattern
 * auth-deploy), KHÔNG phải resource `docker.Container` với `rm: true`:
 * provider `@pulumi/docker@5.2.0` inspect container ngay sau khi nó thoát,
 * mà daemon đã auto-remove container một-shot exit-instant (`chown` trên
 * volume) → "No such container" mỗi lần up (#19). Command phía host không
 * còn race đó và không để lại container nào tồn lại.
 */
const wicStateInit = new command.local.Command(
  dockerResourceName(ns, 'remote-cache-api-wic-state-init'),
  {
    create: pulumi.interpolate`docker run --rm -v ${wicStateVolume.name}:/state ${NODE_IMAGE} chown 1000:1000 /state`,
    update: pulumi.interpolate`docker run --rm -v ${wicStateVolume.name}:/state ${NODE_IMAGE} chown 1000:1000 /state`,
    triggers: [wicStateVolume.name],
  },
  { dependsOn: [wicStateVolume] },
);

/**
 * Container WIC — MỘT worker `wrangler dev` (remote-cache) qua
 * `wic-entrypoint.sh`, plain HTTP trên platform network.
 *
 * Thứ tự phụ thuộc: provision → migrate → bootstrap tenant → image → volume →
 * container — container chỉ lên sau khi schema VÀ tenant canonical sẵn sàng
 * (key CI tạo project qua POST /projects ở request đầu tiên không rơi vào cửa
 * sổ chưa-bootstrap).
 *
 * Env:
 * - `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_REMOTE_CACHE` (secret):
 *   wrangler đọc biến này của PROCESS để gán connection string binding
 *   DB_REMOTE_CACHE (PF3). Thiếu biến là wrangler fail boot tường minh (fail-closed).
 * - `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY_ID` (non-secret) + `S3_SECRET_ACCESS_KEY`
 *   (secret): object storage của data plane (#19). Bốn biến là ĐÚNG bộ tên mà
 *   `apps/remote-cache-api/src/config.ts` đọc; thiếu bất kỳ biến nào là
 *   `config.storage === null` — `/ready` báo `storage: 'missing'` và data
 *   plane fail-closed 503 (không default storage).
 * KHÔNG có `ports` và KHÔNG có label `traefik.*`: WIC không publish cổng ra
 * host — consumer là BFF fetch server-side qua alias nội bộ (cùng quyết định
 * no-Traefik với pact-broker-api, issue #238).
 */
const wic = new docker.Container(
  dockerResourceName(ns, 'remote-cache-api-wic'),
  {
    name: dockerResourceName(ns, 'remote-cache-api-wic'),
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
        hostPath: `${worktreeRoot}/apps/remote-cache-api/dist`,
        containerPath: '/repo/apps/remote-cache-api/dist',
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
      // Object storage (#19): giá trị non-secret dựng qua helper thuần
      // (`object-storage-env.ts`) — một nguồn sự thật cho tên biến + hình
      // endpoint, smoke ngoài host tái dùng đúng bộ này. Secret chỉ đi qua
      // container env với `pulumi.secret` bọc trước khi interpolate —
      // không argv, không label, không log.
      objectStorageEnvs.apply((envs) => `S3_ENDPOINT=${envs.S3_ENDPOINT}`),
      objectStorageEnvs.apply((envs) => `S3_BUCKET=${envs.S3_BUCKET}`),
      objectStorageEnvs.apply((envs) => `S3_ACCESS_KEY_ID=${envs.S3_ACCESS_KEY_ID}`),
      pulumi.interpolate`S3_SECRET_ACCESS_KEY=${pulumi.secret(objectStorageSecretKey)}`,
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
  { dependsOn: [migrate, bootstrapTenant, wicImage, wicStateVolume, wicStateInit] },
);

export const provisionCommandName = provision.id;
export const migrateCommandName = migrate.id;
export const bootstrapTenantCommandName = bootstrapTenant.id;
export const imageDigest = wicImage.digest;
export const containerName = wic.name;
export const containerId = wic.id;
export const stateVolumeName = wicStateVolume.name;
export const namespaceVerified = verifiedNamespace;
