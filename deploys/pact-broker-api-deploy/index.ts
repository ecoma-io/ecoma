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
 * container bằng TCP — invariant platform). Password do orchestration sinh và
 * truyền qua stack config `--config` (stdin, không argv), rồi đi vào script qua
 * kênh `environment` của `command.local.Command` — `ALTER ROLE ... PASSWORD`
 * được dựng trong shell và nạp psql qua STDIN (`docker exec -i`), nên không
 * process nào giữ giá trị trong argv (chi tiết kênh ở `scripts.ts`). Migration
 * chạy **đường
 * canonical** (`apps/pact-broker-api/db/apply.mts` — advisory lock
 * `hashtext('db-pact-broker')`) bằng container node pin chạy tsx binary của
 * repo, KHÔNG qua binding Hyperdrive (HD6: Hyperdrive không hỗ trợ advisory
 * lock — `docs/applications/pact-broker/03-operations.md` §2).
 *
 * Cấp phép máy (issue #21 → **retired bởi #206**, ADR-0031 §5): machine token
 * `pact-broker-app-bff` của consumer local `pact-broker-app` KHÔNG còn được
 * provision ở đây nữa — BFF chạy bằng access token OIDC của chủ phiên (đường
 * user, ADR-0031 §1), giữ thêm token máy cho nó là standing secret chết trong
 * config. Machine path của Pact CLI/CI không đổi; cấp token cho CLI là hành
 * động của operator qua `db/provision-machine-token.mts`, không phải đầu ra
 * idempotent của stack này. DoD của #206 assert "không provision machine token
 * nào cho pact-broker-app trên lane" được thỏa bằng cấu trúc: step provisioning
 * không tồn tại trong program.
 *
 * Bootstrap tenant `ecoma` vẫn là bước provisioning riêng
 * (`db/bootstrap-tenant.mts`, idempotent theo ADR-0020) — membership user của
 * lane được nạp qua entitlement event (consumer queue), không phải ở đây.
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
  MIGRATOR_PASSWORD_ENV_VAR,
  POSTGRES_HOST,
  RUNTIME_PASSWORD_ENV_VAR,
  buildBootstrapTenantScript,
  buildMigrateScript,
  buildMigratorConnectionUrl,
  buildProvisionScript,
  buildRuntimeConnectionUrl,
} from './scripts.js';

/**
 * Image Node pin (theo DIGEST) để chạy migration + hai bước provisioning trong
 * container gắn platform network — cùng digest mà `deploys/auth-deploy/Dockerfile` ghim.
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
 * Port HTTP nội bộ của worker `auth` trong WIC container — cùng port mà
 * `pact-broker-app-deploy` dùng cho `NITRO_PACT_BROKER_AUTH_INTERNAL_ORIGIN`
 * (`AUTH_INTERNAL_PORT` 4203 ở `apps/auth/wrangler.jsonc`).
 *
 * ⚠️ Issuer là URL public (`https://auth.<host>:<port>`) — trong container KHÔNG
 * resolve được (Traefik chỉ publish host port trên loopback của host), nên
 * worker này phải fetch JWKS qua origin NỘI BỘ `http://ecoma-<ns>-auth:4203`.
 * Cùng cơ chế với BFF, cùng path `/jwks.json`.
 */
const AUTH_INTERNAL_PORT = 4203;

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
// Issuer/audience của OIDC được ghim cục bộ từ hai output platform mà auth-deploy
// cũng dùng — cùng nguồn phát sinh nên issuer/audience hai stack khớp exact
// (điều kiện verify offline của API, ADR-0031 §1).
const rootHostname = requirePlatformOutput('rootHostname');
const traefikHostPort = requirePlatformOutput('traefikHostPort');

// Mật khẩu hai role của db-pact-broker — do orchestration sinh và truyền qua
// --config (stdin, không argv). `requireSecret` như remote-cache/staff-access:
// đánh dấu output là secret bất kể stack config lưu plaintext (quy ước local-dev
// của `setStackConfig`), nên state Pulumi mã hoá giá trị ở mọi lần dùng.
const runtimePassword = conf.requireSecret('runtimePassword');
const migratorPassword = conf.requireSecret('migratorPassword');

/**
 * `sub` chủ thể sở hữu tenant `ecoma` — do `local.ts` giải quyết qua dx runner
 * trước khi `pulumi up` (read-only trên môi trường đã bootstrapped, fail-closed
 * nếu không). `sub` là ĐỊNH DANH (id của Account service), không phải
 * credential → giữ non-secret trong stack config; trigger của bước provision
 * tenant vẫn bọc `pulumi.secret` để diff/state redact sạch.
 */
const tenantOwnerSub = conf.require('tenantOwnerSub');

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
 * hoá.
 */
const provisionEnvironment: Record<string, pulumi.Output<string>> = {
  [MIGRATOR_PASSWORD_ENV_VAR]: migratorPassword,
  [RUNTIME_PASSWORD_ENV_VAR]: runtimePassword,
};

const provision = new command.local.Command(dockerResourceName(ns, 'pact-api') + '-provision', {
  create: provisionScript,
  update: provisionScript,
  // Trigger vẫn đổi khi password đổi, nhưng giá trị được `pulumi.secret` bọc —
  // state/diff chỉ thấy `[secret]`, không bao giờ thấy mật khẩu plaintext
  // (trigger được lưu trong state Pulumi).
  triggers: [pulumi.secret(runtimePassword), pulumi.secret(migratorPassword), worktreeRoot],
  environment: provisionEnvironment,
});

/**
 * Migration qua **đường canonical**: container ephemeral trên platform network
 * chạy đúng `tsx db/apply.mts` của repo (`apps/pact-broker-api/db/apply.mts` —
 * advisory lock `hashtext('db-pact-broker')`, mọi DDL idempotent). Repo mount
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
// Encode là việc của hàm dựng URL (`buildMigratorConnectionUrl`, một nguồn sự
// thật với spec unit) — wiring chỉ truyền mật khẩu thô qua `.apply`; URL hoàn
// chỉnh được bọc `pulumi.secret` ngay dưới. Biến kết quả KHÔNG mang tên khớp
// regex nguồn nhạy cảm (`password`...) nên không bị taint-source của rule
// `security-sensitive-value-in-http-response` đánh dấu (source là identifier
// bắt đầu bằng token/password/secret...).
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
  dockerResourceName(ns, 'pact-api') + '-migrate',
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
 * URL runtime hoàn chỉnh — bọc `pulumi.secret` trước khi vào map `environment`:
 * state Pulumi mã hoá chứ không lưu plaintext. Percent-encode là việc của hàm
 * dựng URL (`buildRuntimeConnectionUrl`, một nguồn sự thật với spec unit).
 * Dùng chung bởi provision tenant qua map `environment` của command (token máy
 * của BFF đã retire — ADR-0031 §5).
 */
const runtimeConnectionUrl = pulumi.secret(
  runtimePassword.apply((raw) => buildRuntimeConnectionUrl({ password: raw })),
);

/**
 * Provision tenant canonical `ecoma` qua **script service-owned**
 * (`db/bootstrap-tenant.mts`) — container ephemeral trên platform network chạy
 * đúng entry của repo (target Nx `db:bootstrap`), KHÔNG tự viết vòng
 * provisioning. Idempotent theo ADR-0020: tenant đã hội tụ là no-op verify
 * (không đè owner, không đè classification/plan), trạng thái lệch thì
 * fail-closed. Repo mount read-only.
 *
 * Kênh `DATABASE_URL`: giá trị (password percent-encode, bọc `pulumi.secret`)
 * đi vào environ của tiến trình shell qua map `environment` của provider;
 * script chạy `docker run -e DATABASE_URL` với CHỈ TÊN biến — URL không nằm
 * trong argv của `sh -c` hay `docker run`, cũng không trong script text (nơi
 * failure output và log có thể echo). Đây là cùng mô hình mà
 * `superadmin-resolver.ts` áp cho lệnh superadmin và remote-cache áp cho
 * bootstrap tenant của nó.
 *
 * `CANONICAL_TENANT_OWNER_SUB` qua env: sub do `local.ts` resolve từ dx runner
 * trước khi up. Trigger gồm sub + mật khẩu runtime (cả hai bọc `pulumi.secret`
 * — state/diff chỉ thấy `[secret]`): sub đổi là bước chạy lại (membership
 * verify theo sub); mật khẩu đổi là chạy lại với URL mới (trước đây việc
 * re-run dựa trên URL inline đổi trong command text, giờ do trigger + input
 * `environment` bảo đảm).
 */
const bootstrapTenantScript = networkName.apply((net) =>
  buildBootstrapTenantScript({
    networkName: net,
    worktreeRoot,
    nodeImage: NODE_IMAGE,
    tenantOwnerSub,
  }),
);

const bootstrapTenant = new command.local.Command(
  dockerResourceName(ns, 'pact-api') + '-bootstrap-tenant',
  {
    create: bootstrapTenantScript,
    update: bootstrapTenantScript,
    triggers: [pulumi.secret(tenantOwnerSub), pulumi.secret(runtimePassword), worktreeRoot],
    // Giá trị bọc secret: provider đặt vào environ của tiến trình script.
    environment: { DATABASE_URL: runtimeConnectionUrl },
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
 * userinfo của URL — bất biến `generatePostgresPassword` (base64url, chỉ
 * `A-Za-z0-9-_`) hiện không chứa ký tự dành riêng của URL, nhưng encode là vệ
 * tinh an toàn khi ai đó `pulumi config set` giá trị thủ công chứa `@ : / ? #`
 * (cùng lý do encode ở URL runtime phía trên; đúng chuẩn cho parser
 * `pg`/workerd). Biến encode KHÔNG bắt đầu bằng token nhạy cảm, không thành
 * taint-source của rule `security-sensitive-value-in-http-response`.
 *
 * Tên biến: `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_` + TÊN BINDING
 * wrangler (`HYPERDRIVE` của `apps/pact-broker-api/wrangler.jsonc` — cùng tên
 * mà `src/config.ts` đọc qua `env.HYPERDRIVE`).
 */
const runtimePasswordEncoded = runtimePassword.apply((v) => encodeURIComponent(v));
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
 * Container WIC — MỘT worker `wrangler dev` (pact-broker-api) qua
 * `wic-entrypoint.sh`, plain HTTP trên platform network.
 *
 * Thứ tự phụ thuộc: provision → migrate → bootstrap-tenant → image → volume →
 * container — container chỉ lên sau khi schema + tenant canonical sẵn sàng.
 * Token máy của consumer local KHÔNG còn là bước nào (retired — ADR-0031 §5).
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
      // Cấu hình đường user (ADR-0031 §1.2): issuer + audience mà access token
      // OIDC forward bởi BFF phải khớp. GHIM CÙNG CHUỖI với auth-deploy (cả hai
      // stack dựng từ cùng hai output platform `rootHostname` + `traefikHostPort`),
      // nên phép so `iss`/`aud` exact khớp theo cấu trúc. Thiếu MỘT biến là đường
      // user 503 fail-closed từng request (src/config.ts) — machine path không bị
      // ảnh hưởng. KHÔNG có secret nào ở đây: JWKS được fetch công khai.
      pulumi.interpolate`PACT_BROKER_AUTH_ISSUER=https://auth.${rootHostname}:${traefikHostPort}`,
      pulumi.interpolate`PACT_BROKER_AUTH_AUDIENCE=https://api.${rootHostname}:${traefikHostPort}`,
      // Origin NỘI BỘ để fetch JWKS — issuer ở trên là URL public, không
      // resolve được từ trong container (Traefik chỉ publish host port trên
      // loopback host). Origin này chỉ đổi NƠI lấy JWKS; claim `iss` vẫn so
      // với `PACT_BROKER_AUTH_ISSUER`. Cùng cơ chế `internalOrigin` của BFF.
      pulumi.interpolate`PACT_BROKER_AUTH_INTERNAL_ORIGIN=http://ecoma-${ns}-auth:${AUTH_INTERNAL_PORT}`,
    ],
    labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
    healthcheck: {
      // `/health` chứ không phải một route nghiệp vụ: probe infra không được
      // phụ thuộc DB (thiết kế của app — `/health` không credential, không
      // chạm DB). 200 = worker boot và serve được request; readiness nghiệp
      // vụ (DB + token máy đã cấp) là việc của smoke ở wiring PR.
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
  { dependsOn: [bootstrapTenant, wicImage, wicStateVolume, wicStateInit] },
);

export const provisionCommandName = provision.id;
export const migrateCommandName = migrate.id;
export const bootstrapTenantCommandName = bootstrapTenant.id;
export const imageDigest = wicImage.digest;
export const containerName = wic.name;
export const containerId = wic.id;
export const stateVolumeName = wicStateVolume.name;
export const namespaceVerified = verifiedNamespace;
