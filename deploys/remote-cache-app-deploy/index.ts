/**
 * Chương trình Pulumi của `remote-cache-app-deploy` — deploy unit của
 * `apps/remote-cache-app` (composition SPA admin + BFF của Remote Cache) ở
 * LAN LOCAL deployment.
 *
 * Mirror `deploys/pact-broker-app-deploy/index.ts` (cùng ownership labels,
 * namespace, stack reference fail-closed, image build qua `@pulumi/docker-build`
 * với builder `default` + `load: true`) và cùng sở hữu database phiên BFF:
 * #180 (ADR-0035) unit SỞ HỮU `db-remote-cache-app` — provision hai role +
 * database + migration của app qua `scripts.ts`, cùng mô hình kênh secret với
 * pact-broker-app-deploy. Router rule `Host(remote-cache-app.<rootHostname>)`.
 *
 * Wiring BFF (ADR-0034/0035, #180):
 * - OIDC issuer/audience ghim từ platform outputs (structural exact match với
 *   auth-deploy); `client_id` đọc cross-stack từ stack `auth-deploy` (auth seed
 *   client public, persist qua stack config).
 * - `INTERNAL_AUTH_SECRET` đọc cross-stack từ stack `remote-cache-api-deploy`
 *   (producer sinh mỗi lần up của nó) — BFF và control plane nhận ĐÚNG MỘT giá
 *   trị; envelope HMAC mang actor sub của phiên.
 * - `REMOTE_CACHE_API_BASE_URL` trỏ alias nội bộ `ecoma-remote-cache-api:4207`
 *   (hằng số đối xứng với `remote-cache-api-deploy`).
 * - Database qua Node connection string (preset `node-server`, không Hyperdrive
 *   trong container Node) — `NITRO_REMOTE_CACHE_APP_DATABASE_URL`.
 *
 * Phạm vi: chỉ phục vụ stack `local-<namespace>` (Docker runtime). Staging và
 * production của app đi đường Cloudflare Workers qua Wrangler
 * (`apps/remote-cache-app/wrangler.jsonc`, preset `cloudflare-module`) và **không**
 * đi qua chương trình này.
 *
 * Ranh giới ownership: unit này KHÔNG tạo network, Traefik hay PostgreSQL; nó
 * đọc platform outputs qua StackReference rồi join network.
 */

import * as command from '@pulumi/command';
import * as docker from '@pulumi/docker';
import * as dockerBuild from '@pulumi/docker-build';
import * as pulumi from '@pulumi/pulumi';

// Helper/contract dùng chung qua workspace package `@ecoma-io/deployment`
// (`libs/deployment`) — một nguồn sự thật cho mọi deploy unit; copy hàm vào
// deploy unit sẽ tạo hai nơi định nghĩa cùng một thứ và để chúng lệch nhau.
// Ranh giới là một chiều: deploy → lib; lib KHÔNG được import ngược deploy
// hay `tools/dx` (contract test của lib chặn).
import {
  type DeployResourceKind,
  type PlatformOutputs,
  dockerResourceName,
  normalizeWorktreeRoot,
  ownershipLabels,
  worktreeNamespace,
} from '@ecoma-io/deployment';

import {
  MIGRATOR_PASSWORD_ENV_VAR,
  RUNTIME_PASSWORD_ENV_VAR,
  buildMigrateScript,
  buildMigratorConnectionUrl,
  buildProvisionScript,
  buildRuntimeConnectionUrl,
} from './scripts.js';

/** Cổng nội bộ mà Nitro preset `node-server` nghe (khớp `EXPOSE`/`ENV PORT` của image). */
const APP_INTERNAL_PORT = 3000;

/**
 * Entrypoint HTTPS của Traefik — nơi client gõ `https://remote-cache-app.<rootHostname>`.
 * Tên router/service mang namespace vì Traefik đọc label toàn cục (multi-tenant
 * giữa các worktree) — xem `pact-broker-app-deploy`.
 */
const traefikPrefix = (ns: string): string => `remote-cache-app-${ns}`;

/**
 * Image Node pin (theo DIGEST) — cùng digest mà `pact-broker-app-deploy`
 * ghim (một nguồn sự thật cho "image chạy tsx của repo", copy có chủ ý).
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/**
 * Alias DNS của WIC container `remote-cache-api` trong platform network + cổng
 * nội bộ worker (`dev.port` của `apps/remote-cache-api/wrangler.jsonc`) — hằng
 * đối xứng với `remote-cache-api-deploy` (`REMOTE_CACHE_ALIAS` +
 * `REMOTE_CACHE_INTERNAL_PORT`). BFF fetch server-side qua alias này.
 */
const REMOTE_CACHE_API_ALIAS = 'ecoma-remote-cache-api';
const REMOTE_CACHE_API_INTERNAL_PORT = 4207;

// Config bag `namespace` — cùng tên bag với điều `platform-deploy` nhận, vì
// orchestration truyền một bộ `--config namespace:...` duy nhất cho cả hai
// project.
const conf = new pulumi.Config('namespace');

const worktreeRoot = conf.require('worktreeRoot');
const ns = worktreeNamespace(worktreeRoot);

/**
 * Labels ownership của resource này — `pnpm dx local-cleanup` đọc bộ labels
 * này thay vì đoán từ tên.
 */
const labels = ownershipLabels(normalizeWorktreeRoot(worktreeRoot), ns);

// Stack reference đầy đủ tới stack platform của chính worktree này, do
// orchestration ghép và truyền qua `--config` — xem `pact-broker-app-deploy`.
const platform = new pulumi.StackReference(conf.require('platformStackRef'));

/**
 * Đọc MỘT output từ stack reference với ràng buộc fail-closed theo contract —
 * biến lệch contract thành lỗi deploy tường minh thay vì deploy "xanh" nhưng
 * rỗng. Xem giải thích đầy đủ ở `pact-broker-app-deploy`.
 */
function requirePlatformOutput<K extends keyof PlatformOutputs>(
  key: K,
): pulumi.Output<PlatformOutputs[K]> {
  return pulumi.output(platform.getOutput(key)).apply((raw) => {
    if (raw === undefined || raw === null) {
      throw new Error(
        `platformStackRef does not export "${key}". Most common cause: the ` +
          `platform stack never completed \`up\` (empty outputs) or was ` +
          `destroyed — run \`pnpm nx run platform-deploy:local-up -c local\` (apply platform) first. ` +
          `Refusing to deploy remote-cache-app with an empty configuration.`,
      );
    }
    return raw as PlatformOutputs[K];
  });
}

const networkName = requirePlatformOutput('networkName');
const platformNamespace = requirePlatformOutput('namespace');
const rootHostname = requirePlatformOutput('rootHostname');
// Port động Traefik — issuer/redirect URI ghim từ cùng nguồn với auth-deploy
// nên exact match là cấu trúc (cùng hai outputs, cùng format), không phải hiệp
// bằng tay giữa hai stack.
const traefikHostPort = requirePlatformOutput('traefikHostPort');

// Mật khẩu hai role của db-remote-cache-app — orchestration sinh và truyền qua
// --config (stdin, không argv); `requireSecret` như api-deploy: đánh dấu output
// là secret bất kể stack config lưu plaintext, nên state Pulumi mã hoá giá trị
// ở mọi lần dùng.
const runtimePassword = conf.requireSecret('runtimePassword');
const migratorPassword = conf.requireSecret('migratorPassword');

/**
 * `client_id` của client public `remote-cache-app` tại `auth` (ADR-0031 §4,
 * #180) — `local.ts` đọc cross-stack từ stack auth-deploy (đơn vị seed client)
 * rồi persist vào stack config của stack này. ĐỊNH DANH công khai OAuth, không
 * phải secret → `conf.require` thường; thiếu là fail ngay lúc `pulumi up`
 * chứ không chạy BFF không client.
 */
const remoteCacheAppClientId = conf.require('remoteCacheAppClientId');

/**
 * Secret HMAC envelope nội bộ (ADR-0034, #180) — đọc cross-stack từ stack
 * `remote-cache-api-deploy` (producer sinh mỗi lần up của nó; up của unit này
 * chạy SAU theo dependsOn nên giá trị đã tồn tại). BFF và control plane nhận
 * ĐÚNG MỘT giá trị; thiếu là fail ngay lúc `pulumi up`.
 */
const internalHmacSecret = conf.requireSecret('internalHmacSecret');

// Fail-closed khi hai stack không thuộc cùng một worktree — export ở cuối file
// để throw trong `apply` làm `pulumi up` fail. Xem `pact-broker-app-deploy`.
const verifiedNamespace = pulumi.output(platformNamespace).apply((upstreamNs) => {
  if (upstreamNs !== ns) {
    throw new Error(
      `platformStackRef points to a stack of a different namespace: ` +
        `platform exports "${upstreamNs}" but this worktree is "${ns}". ` +
        `Both stacks must belong to the same worktree — otherwise remote-cache-app joins the wrong network.`,
    );
  }
  return ns;
});

/**
 * Kind resource của unit này — hai giá trị đã được khai trong `DeployResourceKind`
 * của `libs/deployment`, nên không cần assertion: thêm/đổi tên kind mà quên lib
 * là lỗi compile ngay tại đây.
 */
const remoteCacheAppKind: DeployResourceKind = 'remote-cache-app';
const remoteCacheAppImageKind: DeployResourceKind = 'remote-cache-app-image';

// ---------------------------------------------------------------------------
// Provision + migrate của db-remote-cache-app (ADR-0035, #180) — cùng mô hình
// kênh secret với `pact-broker-app-deploy`: mật khẩu qua map `environment` của
// provider (không argv), `docker run -e DATABASE_URL` chỉ mang TÊN biến, script
// text là đầu ra hàm thuần `scripts.ts` (không chứa giá trị secret nào).
// ---------------------------------------------------------------------------

const postgresContainerName = dockerResourceName(ns, 'postgres');

const provisionScript = buildProvisionScript({ postgresContainerName });

const provisionEnvironment: Record<string, pulumi.Output<string>> = {
  [MIGRATOR_PASSWORD_ENV_VAR]: migratorPassword,
  [RUNTIME_PASSWORD_ENV_VAR]: runtimePassword,
};

const provision = new command.local.Command(
  dockerResourceName(ns, 'remote-cache-app') + '-provision',
  {
    create: provisionScript,
    update: provisionScript,
    // Trigger bọc secret: state/diff chỉ thấy `[secret]`, không bao giờ thấy mật
    // khẩu plaintext (trigger được lưu trong state Pulumi).
    triggers: [pulumi.secret(runtimePassword), pulumi.secret(migratorPassword), worktreeRoot],
    environment: provisionEnvironment,
    // ⚠️ Không có `dependsOn` Pulumi nào ở đây — có chủ đích (review #254, cùng
    // mô hình với pact-broker-app-deploy): container PostgreSQL platform là tài
    // nguyên của stack `platform-deploy` khác, và unit này chỉ chạm nó qua
    // `docker exec` (tên container là chuỗi theo convention, không phải Output).
    // Thứ tự chạy ghim bằng Nx: `local-up` dependsOn `platform-deploy:local-up`.
  },
);

// Percent-encode mật khẩu trước khi ghép vào userinfo của DATABASE_URL — encode
// là việc của hàm dựng URL (`buildMigratorConnectionUrl`); URL hoàn chỉnh bọc
// `pulumi.secret` ngay dưới.
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
  dockerResourceName(ns, 'remote-cache-app') + '-migrate',
  {
    create: migrateScript,
    update: migrateScript,
    triggers: [pulumi.secret(migratorPassword), worktreeRoot],
    environment: { DATABASE_URL: migratorConnectionUrl },
  },
  { dependsOn: [provision] },
);

/**
 * Image local của `apps/remote-cache-app` — contract build giống
 * `pact-broker-app-deploy`: context repo root, builder `default` (bỏ bước boot
 * builder `docker-container` timeout trên Docker rootless), `load: true` +
 * `push: false` (local không có registry).
 */
/** Tag local của image — một nguồn duy nhất cho `tags` và input `image` của container. */
const imageTag = `ecoma-remote-cache-app-${ns}:local`;

const image = new dockerBuild.Image(dockerResourceName(ns, remoteCacheAppImageKind), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/remote-cache-app-deploy/Dockerfile` },
  tags: [imageTag],
  builder: { name: 'default' },
  load: true,
  push: false,
  labels,
});

/**
 * Container của `apps/remote-cache-app`.
 *
 * Ghim digest (`tag@sha256:...`) biến mỗi rebuild thành thay đổi input thấy
 * được — container bị thay đúng lúc. KHÔNG có `ports`: mọi request đi qua
 * Traefik của platform — bất biến của local platform.
 */
const remoteCacheApp = new docker.Container(
  dockerResourceName(ns, remoteCacheAppKind),
  {
    name: dockerResourceName(ns, remoteCacheAppKind),
    image: pulumi.interpolate`${imageTag}@${image.digest}`,
    // `restart: unless-stopped` để DOCKER tự start lại container sau
    // reboot/restart daemon — cùng lý do với traefik/postgres ở `platform-deploy`.
    restart: 'unless-stopped',
    // Readiness resource-owned (`wait: true` — cùng ngữ nghĩa với platform):
    // cold start của Node server (build `node-server`, SPA admin) có thể vượt 30s; trần chờ = startPeriod 30s +
    // 12 retries × 10s = 150s; waitTimeout 180s dư.
    wait: true,
    waitTimeout: 180,
    networksAdvanced: [{ name: networkName, aliases: ['ecoma-remote-cache-app'] }],
    // `envs` (không phải `environment`): cặp `KEY=VALUE` dạng mảng chuỗi — shape
    // của `docker run -e`.
    //
    // BFF config (ADR-0034/0035, #180): base URL trỏ alias nội bộ với port
    // contract (hằng đối xứng với `remote-cache-api-deploy`) — sai port chỉ làm
    // `/api/portal/**` trả 502, còn `/health` vẫn xanh vì healthcheck cố ý không
    // phụ thuộc control plane. Chuỗi kết nối DB + HMAC secret bọc `pulumi.secret`
    // nên interpolate giữ redact trong diff/log.
    envs: [
      `PORT=${APP_INTERNAL_PORT}`,
      'NODE_ENV=production',
      pulumi.interpolate`NITRO_REMOTE_CACHE_API_BASE_URL=http://${REMOTE_CACHE_API_ALIAS}:${REMOTE_CACHE_API_INTERNAL_PORT}`,
      pulumi.interpolate`NITRO_INTERNAL_AUTH_SECRET=${pulumi.secret(internalHmacSecret)}`,
      // Database phiên BFF (ADR-0035) — role runtime, percent-encode trong builder;
      // preset `node-server` đọc qua runtimeConfig private (không Hyperdrive).
      pulumi.interpolate`NITRO_REMOTE_CACHE_APP_DATABASE_URL=${pulumi.secret(
        runtimePassword.apply((raw) => buildRuntimeConnectionUrl({ password: raw })),
      )}`,
      // Issuer/audience ghim từ platform outputs — cùng nguồn với auth-deploy
      // (structural exact match); client_id từ stack config; origin fetch nội bộ
      // trỏ thẳng container auth trong network (local-only, production vắng mặt).
      pulumi.interpolate`NITRO_REMOTE_CACHE_AUTH_ISSUER=https://auth.${rootHostname}:${traefikHostPort}`,
      pulumi.interpolate`NITRO_REMOTE_CACHE_AUTH_AUDIENCE=https://api.${rootHostname}:${traefikHostPort}`,
      pulumi.interpolate`NITRO_REMOTE_CACHE_AUTH_CLIENT_ID=${remoteCacheAppClientId}`,
      pulumi.interpolate`NITRO_REMOTE_CACHE_AUTH_INTERNAL_ORIGIN=http://ecoma-${ns}-auth:4203`,
      // Public runtimeConfig cho SPA: tenant canonical + cache endpoint hiển thị
      // ở trang onboarding (R21). Non-secret — cấu hình hiển thị, không credential.
      pulumi.interpolate`NUXT_PUBLIC_REMOTE_CACHE_TENANT_NAME=ecoma`,
      pulumi.interpolate`NUXT_PUBLIC_REMOTE_CACHE_CACHE_ENDPOINT=https://cache.${rootHostname}`,
    ],
    labels: [
      ...Object.entries(labels).map(([label, value]) => ({ label, value })),
      { label: 'traefik.enable', value: 'true' },
      {
        // Khai network của ROUTER này cho Traefik — bắt buộc với provider docker
        // multi-tenant: vừa chọn IP đúng network cho backend, vừa là điều kiện
        // lọc container vào router của đúng worktree.
        label: 'traefik.docker.network',
        value: networkName,
      },
      {
        label: `traefik.http.routers.${traefikPrefix(ns)}.rule`,
        value: pulumi.interpolate`Host(\`remote-cache-app.${rootHostname}\`)`,
      },
      {
        label: `traefik.http.routers.${traefikPrefix(ns)}.entrypoints`,
        value: 'websecure',
      },
      { label: `traefik.http.routers.${traefikPrefix(ns)}.tls`, value: 'true' },
      {
        label: `traefik.http.services.${traefikPrefix(ns)}.loadbalancer.server.port`,
        value: String(APP_INTERNAL_PORT),
      },
    ],
    healthcheck: {
      // `/health` là liveness của app; chứa route tĩnh, không phụ thuộc backend
      // (app không có backend). Cổng lấy từ cùng hằng số với `ENV PORT` của image,
      // không hard-code lần thứ hai trong một string khác. Chỉ 2xx (`r.ok`) mới
      // healthy — một điều kiện nới hơn kiểu `status < 500` sẽ coi 404 (route sai,
      // app build sai) là healthy và phá readiness.
      tests: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${APP_INTERNAL_PORT}/health')` +
          `.then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))`,
      ],
      interval: '10s',
      timeout: '5s',
      retries: 12,
      // Cold start của container có thể vượt 30s trên host chậm; chỉ sau `startPeriod`
      // mới tính `retries`.
      startPeriod: '30s',
    },
    // Container chỉ lên sau khi schema phiên sẵn sàng — BFF middleware authn đọc
    // `remote_cache_app.bff_sessions` ở request đầu tiên.
  },
  { dependsOn: [migrate] },
);

export const imageDigest = image.digest;
export const containerName = remoteCacheApp.name;
export const containerId = remoteCacheApp.id;
export const provisionCommandName = provision.id;
export const migrateCommandName = migrate.id;
/** Namespace đã khớp stack platform — xem check fail-closed ở trên. */
export const namespaceVerified = verifiedNamespace;
