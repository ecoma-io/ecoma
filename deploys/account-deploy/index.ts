/**
 * Chương trình Pulumi của `account-deploy` — deploy unit của `apps/account`
 * (bounded context `account`) ở LAN LOCAL deployment.
 *
 * Đủ vòng đời theo `02-account-auth.md` §Dependency graph: provision `db-account`
 * + bộ 4 role chuẩn (owner/migrator/runtime/pruner) → migration đường canonical
 * (`apps/account/db/apply.mts`) → image `node-server` → container trên platform
 * network với Traefik router `Host(account.<rootHostname>)` → readiness qua
 * `GET /ready` (chạm DB thật, không phải `/health`).
 *
 * Mirror `deploys/backoffice-deploy/index.ts` (cùng ownership labels, namespace,
 * stack reference, fail-closed, `command.local.Command` + `docker exec` psql qua
 * trust auth trong container — platform không publish host port nên host không
 * kết nối được container bằng TCP).
 *
 * SQL provisioning theo `docs/applications/account/03-operations.md` §3.1/§3.2 và
 * `apps/account/db/README.md` §"Chặn chéo": mỗi DB 4 role, `REVOKE CONNECT`
 * chéo **kể cả PUBLIC** (chỉ revoke per-role là no-op — PostgreSQL cấp CONNECT
 * cho PUBLIC theo mặc định), và revoke trên database đích phải được điều kiện
 * hoá bằng `pg_database` (xóa REVOKE trên database không tồn tại là lỗi, không
 * phải no-op).
 *
 * Binding local (issue #182): container Node không có Hyperdrive thật. Adapter
 * là biến `NUXT_CLOUDFLARE_ENV` chứa JSON `{"DB_ACCOUNT":{"connectionString":
 * ...}}` — Nitro envmap (`applyEnv` + `destr`) merge nó vào
 * `runtimeConfig.cloudflare.env` được khai tường minh trong `nuxt.config.ts`, đúng
 * hình dạng mà `accountHyperdrive()` kiểm. Không đặt biến ⇒ object rỗng ⇒ binding
 * `null` ⇒ `/ready` 503 — fail-closed như production.
 *
 * Binding `AUTH_SERVICE` (issue #183): JSON envmap không chứa được function
 * `fetch`, nên adapter HTTP của chiều account → auth được mount lúc runtime
 * bởi `server/plugins/auth-service-shim.ts`, đọc origin từ biến
 * `NUXT_AUTH_SERVICE_URL` — fetch thẳng worker auth trong WIC qua alias
 * `ecoma-<ns>-auth:4203` (`02-account-auth.md` §Service bindings, chiều account →
 * auth). Bảo mật lớp application là envelope HMAC `ecoma-internal-v1` của
 * `auth-client` — shim không ký thêm gì. Thiếu biến ⇒ không mount ⇒ mọi gọi
 * auth fail-closed `binding_missing` (production Workers dùng binding thật,
 * không đọc biến này).
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
  OWNER_PASSWORD_ENV_VAR,
  PRUNER_PASSWORD_ENV_VAR,
  RUNTIME_PASSWORD_ENV_VAR,
  buildMigrateScript,
  buildProvisionScript,
} from './scripts.js';

/**
 * Image Node pin (theo DIGEST) để chạy migration runner trong container gắn
 * platform network — cùng digest mà `deploys/home-deploy/Dockerfile` ghim.
 *
 * Vì sao container mà không chạy runner trên host: platform PostgreSQL KHÔNG
 * publish host port (invariant platform) và host không route được tới IP
 * container (môi trường rootless, platform facts PF5), nên `pg` của runner chỉ
 * kết nối được từ bên trong platform network. Container ephemeral `--network
 * <platform>` với repo mount read-only + chạy **tsx binary của repo** vẫn là
 * đúng một đường code canonical (`applyAllMigrations`) — deploy không tự viết
 * lại vòng migration (quyết định #181).
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/** Alias DNS của PostgreSQL platform trong network nội bộ. */
const POSTGRES_HOST = 'ecoma-postgres';

/** Cổng HTTP nội bộ của container account — Nitro `node-server` mặc định 3000. */
const ACCOUNT_INTERNAL_PORT = 3000;

/**
 * Cổng HTTP nội bộ của control plane `ecoma-transactional-mail` trong WIC của
 * transactional-mail-deploy — GIÁ TRỊ GHIM ở stack đó (`MAIL_INTERNAL_PORT`),
 * copy tại đây vì hai stack là hai Pulumi program độc lập; lệch giá trị là
 * connection refused ở lần gửi OTP đầu tiên. Alias `ecoma-mail` + port này
 * được BÁO trong PR của transactional-mail-deploy.
 */
const MAIL_INTERNAL_PORT_OF_MAIL_WIC = 4206;

/**
 * Cổng HTTP nội bộ của worker `ecoma-auth` trong WIC của auth-deploy — GIÁ TRỊ
 * GHIM ở stack đó (`AUTH_INTERNAL_PORT`, nguồn số duy nhất là `dev.port` của
 * `apps/auth/wrangler.jsonc`), copy tại đây vì hai stack là hai Pulumi program
 * độc lập; lệch giá trị là connection refused ở lần gọi auth đầu tiên.
 */
const AUTH_INTERNAL_PORT_OF_AUTH_WIC = 4203;

/** Prefix router/service Traefik của app này — namespace vào tên để multi-tenant. */
const traefikPrefix = (ns: string): string => `account-${ns}`;

const conf = new pulumi.Config('namespace');

const worktreeRoot = conf.require('worktreeRoot');
const ns = worktreeNamespace(worktreeRoot);

// Labels ownership: gắn lên MỌI Docker resource (image + container) để
// `pnpm dx local-cleanup` phân loại được.
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
const rootHostname = requirePlatformOutput('rootHostname');
const traefikHostPort = requirePlatformOutput('traefikHostPort');

// Mật khẩu bốn role — do orchestration sinh và truyền qua --config (stdin, không argv).
const ownerPassword = conf.require('ownerPassword');
const runtimePassword = conf.require('runtimePassword');
const migratorPassword = conf.require('migratorPassword');
const prunerPassword = conf.require('prunerPassword');

// Secret HMAC của app — cùng kênh `--config` (stdin) như mật khẩu role; entry up
// của chính stack này sinh và set, stack đọc lại. Thiếu key là fail ngay lúc `pulumi up`
// (`conf.require`) chứ không Container với secret rỗng.
const internalHmacSecret = conf.require('internalHmacSecret');
const otpHmacSecret = conf.require('otpHmacSecret');

/**
 * Secret HMAC path Account↔Mail (đường OTP login) — orchestration sinh MỘT
 * giá trị, persist vào stack config của CHÍNH stack này; transactional-mail-
 * deploy đọc lại cùng giá trị và giữ nó làm registry entry
 * `MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT`. Hai stack một giá trị — cùng cơ
 * chế bất biến `internalHmacSecret` phía trên. PHẢI khác
 * `internalHmacSecret` (validation của account từ chối trùng; receiver mail
 * coi mỗi registry entry là một credential riêng).
 */
const mailInternalAuthSecret = conf.require('mailInternalAuthSecret');

const verifiedNamespace = pulumi.output(platformNamespace).apply((upstreamNs) => {
  if (upstreamNs !== ns) {
    throw new Error(
      `platformStackRef points to a stack of a different namespace: platform exports "${upstreamNs}" while this worktree is "${ns}".`,
    );
  }
  return ns;
});

// Connection string runtime (role `ecoma_account_runtime`) qua network nội bộ —
// cùng pattern backoffice. `pulumi.secret` đánh dấu redact trong diff/log;
// `pulumi.interpolate` với config plaintext KHÔNG tự redact, nên phải bọc
// secret TRƯỚC rồi interpolate.
const accountDatabaseUrl = pulumi.interpolate`postgresql://ecoma_account_runtime:${pulumi.secret(runtimePassword)}@${POSTGRES_HOST}:5432/db-account`;

/**
 * Giá trị biến `NUXT_CLOUDFLARE_ENV` — JSON object đúng hình dạng mà
 * `applyEnv` của Nitro merge vào `runtimeConfig.cloudflare.env`.
 *
 * Chỉ có key parent (`cloudflare.env`) xuất hiện trong runtimeConfig khai
 * tường minh thì envmap mới chạm được tới cấp binding (đã đo thật: biến cấp
 * sâu `NUXT_CLOUDFLARE_ENV_DB_ACCOUNT` không bao giờ được đọc vì recursion
 * chỉ đi các key CÓ SẴN trong object inline). JSON được `destr` parse thành
 * object rồi merge — sau đó `accountHyperdrive()` thấy
 * `DB_ACCOUNT.connectionString` là chuỗi. Không đặt biến ⇒ object rỗng ⇒
 * fail-closed như Workers thiếu binding.
 *
 * Toàn bộ giá trị là một pulumi.secret interpolate: connection string chứa
 * mật khẩu runtime, không được đi vào diff/log/argv — biến chỉ đi qua `envs`
 * của container (kênh container env, cùng kênh backoffice dùng) và Pulumi
 * redact khi in.
 *
 * Dấu ngoặc kép quanh `${...}` là BẮT BUỘC: thiếu quote thì giá trị nội suy
 * là URL trần (`"connectionString":postgresql://...`) — không phải JSON hợp
 * lệ, `destr` parse fail ⇒ binding `null` ⇒ `/ready` 503 `binding_missing`
 * (issue #229).
 */
const cloudflareEnvJson = pulumi.interpolate`{"DB_ACCOUNT":{"connectionString":"${pulumi.secret(accountDatabaseUrl)}"}}`;

const imageTag = `ecoma-account-${ns}:local`;

// Image `node-server` — mirror `backoffice-image`: build từ context repo root,
// Dockerfile ghim digest Node, load vào Docker local, không push.
const image = new dockerBuild.Image(dockerResourceName(ns, 'account-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/account-deploy/Dockerfile` },
  tags: [imageTag],
  builder: { name: 'default' },
  load: true,
  push: false,
  labels,
});

/**
 * Provision `db-account` + 4 role + cross-DB revokes, chạy trên host qua
 * `docker exec` vào container PostgreSQL của platform (trust auth trong
 * container, `psql -U ecoma_local` — không publish host port).
 *
 * Idempotent: role/database guard bằng shell `if`, password ALTER mỗi lần chạy
 * (nguồn sự thật là stack config, không phải trạng thái database). Thứ tự
 * revoke/grant theo README account §"Chặn chéo": PUBLIC trước, per-role sau.
 *
 * Kênh mật khẩu: script text là ĐẦU RA của hàm thuần `buildProvisionScript`
 * (`scripts.ts`) và KHÔNG chứa giá trị secret nào. Mật khẩu bốn role đi vào
 * tiến trình shell qua map `environment` của `command.local.Command` (dưới —
 * giá trị bọc `pulumi.secret`), script chỉ đọc TÊN biến môi trường, dựng SQL
 * `ALTER ROLE ... PASSWORD` trong shell và nạp psql qua **STDIN** của
 * `docker exec -i` (không `-c`): giá trị không nằm trong argv của `sh -c`, của
 * `docker exec`, của `psql`, cũng như trong `create`/`update` (plain input)
 * mà Pulumi lưu trong state. Kênh `environment` chỉ cô lập argv — KHÔNG claim
 * bảo vệ trước việc xem process environment ở tầng host. Đổi hàm build hay
 * đổi kênh truyền phải qua test argv-hygiene (`tests/integrations/`) — nó chạy
 * đúng script text này.
 *
 * Chạy cả `create` và `update` để redeploy cũng áp cấu hình mới.
 */
const postgresContainerName = dockerResourceName(ns, 'postgres');
const provisionScript = buildProvisionScript({ postgresContainerName });

/**
 * Map `environment` của provision — kênh truyền mật khẩu DUY NHẤT: provider
 * đặt từng giá trị vào environ của tiến trình chạy script (không argv). Mỗi
 * giá trị bọc `pulumi.secret` nên state Pulumi mã hoá chứ không lưu plaintext;
 * trigger đổi giá trị nằm ở `triggers` dưới (cùng bọc secret).
 */
const provisionEnvironment: Record<string, pulumi.Output<string>> = {
  [OWNER_PASSWORD_ENV_VAR]: pulumi.secret(ownerPassword),
  [MIGRATOR_PASSWORD_ENV_VAR]: pulumi.secret(migratorPassword),
  [RUNTIME_PASSWORD_ENV_VAR]: pulumi.secret(runtimePassword),
  [PRUNER_PASSWORD_ENV_VAR]: pulumi.secret(prunerPassword),
};

const provision = new command.local.Command(dockerResourceName(ns, 'account') + '-provision', {
  create: provisionScript,
  update: provisionScript,
  // Trigger gồm CẢ BỐN mật khẩu (bọc pulumi.secret — trigger nằm trong state
  // Pulumi, không plaintext): đổi bất kỳ mật khẩu nào là provision chạy lại
  // và áp lại toàn bộ.
  triggers: [
    pulumi.secret(ownerPassword),
    pulumi.secret(runtimePassword),
    pulumi.secret(migratorPassword),
    pulumi.secret(prunerPassword),
    worktreeRoot,
  ],
  environment: provisionEnvironment,
});

/**
 * Migration qua **đường canonical**: container ephemeral trên platform network
 * chạy đúng `tsx db/apply.mts` của repo (`apps/account/db/apply.mts` — advisory
 * lock `hashtext('db-account')`, GUC, danh sách file theo thứ tự tên). Repo
 * mount READ-ONLY; node_modules của repo mount riêng (rw) vì `tsx` cần binary
 * đã cài — mount read-only cả repo thì `tsx` vẫn chạy được vì chỉ ĐỌC binary,
 * nhưng pnpm đặt binary là symlink xuyên node_modules → mount cả hai điểm, vẫn
 * không ghi gì xuống đĩa trong lúc migrate.
 *
 * Kênh `DATABASE_URL`: script text là ĐẦU RA của hàm thuần `buildMigrateScript`
 * (`scripts.ts`) và chỉ mang `-e DATABASE_URL` — CHỈ TÊN biến, không
 * `=giá trị` — nên URL (chứa password) không nằm trong argv của `sh -c`, của
 * `docker run`, của tsx bên trong container, hay trong script text nào. Giá trị
 * đi vào environ của tiến trình shell qua map `environment` của provider (dưới
 * — bọc `pulumi.secret`), rồi docker CLI đọc từ environ của chính nó và chuyển
 * vào container env. Trigger gồm password migrator + worktreeRoot (cùng bọc
 * secret): đổi mật khẩu là chạy lại migration với credential mới. Migration
 * file đổi nội dung thì image bundle/container tự recreate qua cơ chế riêng;
 * migrate chạy lại khi password hoặc stack đổi.
 */
const migratorDatabaseUrl = pulumi.interpolate`postgresql://ecoma_account_migrator:${pulumi.secret(migratorPassword)}@${POSTGRES_HOST}:5432/db-account`;

const migrateScript = networkName.apply((net) =>
  buildMigrateScript({
    networkName: net,
    worktreeRoot,
    nodeImage: NODE_IMAGE,
  }),
);

const migrate = new command.local.Command(
  dockerResourceName(ns, 'account') + '-migrate',
  {
    create: migrateScript,
    update: migrateScript,
    triggers: [pulumi.secret(migratorPassword), worktreeRoot],
    // Giá trị bọc secret: provider đặt vào environ của tiến trình script.
    environment: { DATABASE_URL: migratorDatabaseUrl },
  },
  { dependsOn: [provision] },
);

/**
 * Container account — image `node-server`, plain HTTP trên platform network,
 * TLS do Traefik chấm dứt phía trước (cùng model home/backoffice).
 *
 * Thứ tự phụ thuộc: provision (database + role) → migrate (schema) → image →
 * container. Migration chạy trên image Node ghim riêng (ephemeral container),
 * độc lập với image app — container chỉ lên sau khi schema đã sẵn sàng, để
 * `/ready` của healthcheck không đỏ giả trong cửa sổ chưa-migrate.
 *
 * Env: `NUXT_CLOUDFLARE_ENV` là adapter binding (JSON, secret); hai secret HMAC
 * phủ từ envmap `NUXT_*` vào runtimeConfig private; `NUXT_MAIL_SERVICE_URL` trỏ
 * alias `ecoma-mail` của WIC transactional-mail (port nội bộ 4206 — nguồn hằng
 * `MAIL_INTERNAL_PORT` của transactional-mail-deploy) và
 * `NUXT_MAIL_INTERNAL_AUTH_SECRET` là credential path đó — bật đường OTP login
 * local (validation của account bật cặp này cùng nhau; URL rỗng = đường mail
 * tắt); `NUXT_AUTH_SERVICE_URL` trỏ alias `ecoma-auth` của WIC auth (port nội
 * bộ 4203 — nguồn hằng `AUTH_INTERNAL_PORT` của auth-deploy) — bật đường
 * account → auth qua shim `server/plugins/auth-service-shim.ts`; URL rỗng =
 * mọi gọi auth `binding_missing` fail-closed; `NUXT_AUTH_ISSUER` là origin HTTPS
 * browser-facing của auth qua Traefik — BFF verify dùng nó dựng `confirmUrl`
 * cho hop `/authorize/confirm` sau OTP verify (rỗng ⇒ không cấp — fail-closed).
 */
const account = new docker.Container(
  dockerResourceName(ns, 'account'),
  {
    name: dockerResourceName(ns, 'account'),
    image: pulumi.interpolate`${imageTag}@${image.digest}`,
    restart: 'unless-stopped',
    // Readiness resource-owned (`wait: true` — cùng ngữ nghĩa với platform):
    // auth + transactional-mail đọc secret cross-stack qua StackReference, và
    // StackReference resolve sau khi stack up thành công — `wait` bắt `up`
    // thành công CHỈ khi healthcheck `/ready` (DB probe thật) đã `healthy`.
    // Trần chờ = startPeriod 30s + 12 retries × 10s = 150s; waitTimeout 180s dư.
    wait: true,
    waitTimeout: 180,
    networksAdvanced: [{ name: networkName, aliases: ['ecoma-account'] }],
    envs: [
      `PORT=${ACCOUNT_INTERNAL_PORT}`,
      'NODE_ENV=production',
      pulumi.interpolate`NUXT_CLOUDFLARE_ENV=${cloudflareEnvJson}`,
      pulumi.interpolate`NUXT_INTERNAL_HMAC_SECRET=${pulumi.secret(internalHmacSecret)}`,
      pulumi.interpolate`NUXT_OTP_HMAC_SECRET=${pulumi.secret(otpHmacSecret)}`,
      // Alias `ecoma-mail` của WIC transactional-mail (không namespace — một
      // alias duy nhất trên platform network, account container cùng network).
      pulumi.interpolate`NUXT_MAIL_SERVICE_URL=http://ecoma-mail:${MAIL_INTERNAL_PORT_OF_MAIL_WIC}`,
      pulumi.interpolate`NUXT_MAIL_INTERNAL_AUTH_SECRET=${pulumi.secret(mailInternalAuthSecret)}`,
      // Alias `ecoma-<ns>-auth` của WIC auth-deploy — nguồn hằng
      // `AUTH_INTERNAL_PORT` của auth-deploy (`dev.port` của
      // apps/auth/wrangler.jsonc). Shim Nitro trong account biến URL này thành
      // binding AUTH_SERVICE lúc runtime.
      pulumi.interpolate`NUXT_AUTH_SERVICE_URL=http://ecoma-${ns}-auth:${AUTH_INTERNAL_PORT_OF_AUTH_WIC}`,
      // Origin HTTPS browser-facing của auth qua Traefik — BFF verify dựng
      // `confirmUrl` tuyệt đối từ biến này cho bước hop browser
      // `/authorize/confirm` sau OTP verify (01-architecture.md §5.1.2 row 7,
      // contract PR #405). Thiếu biến ⇒ `authIssuer` rỗng ⇒ không cấp
      // `confirmUrl` ⇒ flow OIDC fail-closed.
      //
      // Cùng luật port động với issuer backoffice (`NUXT_BACKOFFICE_AUTH_ISSUER`):
      // browser tự theo URL nên origin PHẢI mang port Traefik publish (443 không
      // listen). Ghim chuỗi (`iss` pin) KHÔNG cần ở đây vì account không verify
      // `iss` — nó chỉ dựng redirect target; nhưng giá trị vẫn PHẢI khớp cấu trúc
      // với issuer auth mint (`AUTH_ISSUER` của auth-deploy: cùng
      // `rootHostname` + `traefikHostPort`) — lệch một chữ là hop confirm gõ sai
      // origin. Precedent đối xứng: `AUTH_ACCOUNT_BASE_URL` bên auth-deploy trỏ
      // ngược origin account, cùng công thức output.
      pulumi.interpolate`NUXT_AUTH_ISSUER=https://auth.${rootHostname}:${traefikHostPort}`,
    ],
    labels: [
      ...Object.entries(labels).map(([label, value]) => ({ label, value })),
      { label: 'traefik.enable', value: 'true' },
      // Bắt buộc với provider docker multi-tenant (memory: cùng network flag
      // KHÔNG lọc — container trên nhiều network bị Traefik thấy qua network
      // nào là do label này quyết).
      { label: 'traefik.docker.network', value: networkName },
      {
        label: `traefik.http.routers.${traefikPrefix(ns)}.rule`,
        value: pulumi.interpolate`Host(\`account.${rootHostname}\`)`,
      },
      {
        label: `traefik.http.routers.${traefikPrefix(ns)}.entrypoints`,
        value: 'websecure',
      },
      { label: `traefik.http.routers.${traefikPrefix(ns)}.tls`, value: 'true' },
      {
        label: `traefik.http.services.${traefikPrefix(ns)}.loadbalancer.server.port`,
        value: String(ACCOUNT_INTERNAL_PORT),
      },
    ],
    healthcheck: {
      // `/ready` chứ không phải `/health`: readiness phải chứng minh DB probe
      // thật (`selectAccountStatus`) thành công — `/health` không chạm DB nên
      // không đủ làm bằng chứng container phục vụ được request thật
      // (`02-account-auth.md` §Runtime contracts).
      tests: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${ACCOUNT_INTERNAL_PORT}/ready')` +
          `.then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))`,
      ],
      interval: '10s',
      timeout: '5s',
      retries: 12,
      startPeriod: '30s',
    },
  },
  { dependsOn: [migrate] },
);

export const provisionCommandName = provision.id;
export const migrateCommandName = migrate.id;
export const imageDigest = image.digest;
export const containerName = account.name;
export const containerId = account.id;
export const namespaceVerified = verifiedNamespace;
