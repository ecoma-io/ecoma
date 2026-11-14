/**
 * Chương trình Pulumi của `pact-broker-app-deploy` — deploy unit của
 * `apps/pact-broker-app` (dashboard BFF của pact-broker) ở LAN LOCAL
 * deployment.
 *
 * Mirror `deploys/home-deploy/index.ts` và `deploys/backoffice-deploy/index.ts`
 * (cùng ownership labels, namespace, stack reference fail-closed, image build
 * qua `@pulumi/docker-build` với builder `default` + `load: true`). Khác biệt:
 * router rule `Host(pact.<rootHostname>)` và container cần:
 * - **database riêng của unit** `db-pact-broker-app` (ADR-0031 §2, #206): hai
 *   role + database được provision bằng script của unit này (`scripts.ts`) và
 *   migration của `apps/pact-broker-app` chạy qua container ephemeral trên
 *   platform network — unit SỞ HỮU database phiên BFF của chính mình (invariant
 *   1 theo hình mới trong `docs/applications/pact-broker/01-architecture.md` §9);
 * - **OIDC BFF** (ADR-0031 §4): issuer/audience ghim từ cùng hai platform
 *   outputs mà auth-deploy dùng (structural exact match), `client_id` đọc từ
 *   stack config do `local.ts` persist sau khi đọc cross-stack từ auth-deploy,
 *   origin fetch nội bộ trỏ thẳng container `auth` trong network;
 * - **base URL của pact-broker-api** — alias nội bộ, port contract. KHÔNG còn
 *   machine token nào: token máy của BFF bị retire hoàn toàn (ADR-0031 §5) —
 *   BFF forward access token của chủ phiên (§1).
 *
 * Phạm vi: chỉ phục vụ stack `local-<namespace>` (Docker runtime). Staging và
 * production của app đi đường Cloudflare Workers qua Wrangler
 * (`apps/pact-broker-app/wrangler.jsonc`, preset `cloudflare-module`) và
 * **không** đi qua chương trình này.
 *
 * Ranh giới ownership: unit này KHÔNG tạo network, Traefik hay PostgreSQL; nó
 * SỞ HỮU database `db-pact-broker-app` (roles + DB + migration) bên trong
 * PostgreSQL platform, đọc platform outputs qua StackReference rồi join network.
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
const PACT_APP_INTERNAL_PORT = 3000;

/**
 * Cổng nội bộ của container `pact-broker-api` mà BFF gọi qua HTTP.
 *
 * Cùng giá trị với `PACT_API_INTERNAL_PORT` của unit `pact-broker-api-deploy`
 * (healthcheck của nó nghe đúng port này); alias `PACT_API_ALIAS` khớp alias
 * mà `pact-broker-api-deploy` đặt cho container của nó. Đổi một bên là đổi cả
 * hai — hai hằng số này là contract một chặng fetch server-side.
 */
const PACT_API_INTERNAL_PORT = 4204;

/** Alias DNS của container pact-broker-api trong network nội bộ — xem contract phía trên. */
const PACT_API_ALIAS = 'ecoma-pact-api';

/**
 * Image Node pin (theo DIGEST) chạy migration runner trong container gắn
 * platform network — cùng digest mà `pact-broker-api-deploy` ghim (một nguồn
 * sự thật cho "image chạy tsx của repo", copy có chủ ý của hằng đó).
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/**
 * Alias DNS + cổng nội bộ của WIC `auth` (auth-deploy đặt alias
 * `ecoma-<ns>-auth`, worker nghe `AUTH_INTERNAL_PORT` 4203) — origin fetch
 * server-side mà BFF dùng cho token exchange + JWKS thay vì origin issuer công
 * khai (hostname issuer không resolve được từ container Node local).
 */
const AUTH_INTERNAL_PORT = 4203;

/**
 * Entrypoint HTTPS của Traefik — nơi client gõ `https://pact.<rootHostname>`.
 * Tên router/service mang namespace vì Traefik đọc label toàn cục (multi-tenant
 * giữa các worktree) — xem `home-deploy`.
 */
const traefikPrefix = (ns: string): string => `pact-app-${ns}`;

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
// orchestration ghép và truyền qua `--config` — xem `home-deploy`.
const platform = new pulumi.StackReference(conf.require('platformStackRef'));

/**
 * Đọc MỘT output từ stack reference với ràng buộc fail-closed theo contract —
 * biến lệch contract thành lỗi deploy tường minh thay vì deploy "xanh" nhưng
 * rỗng. Xem giải thích đầy đủ ở `home-deploy`.
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
          `Refusing to deploy pact-broker-app with an empty configuration.`,
      );
    }
    return raw as PlatformOutputs[K];
  });
}

const networkName = requirePlatformOutput('networkName');
const platformNamespace = requirePlatformOutput('namespace');
const rootHostname = requirePlatformOutput('rootHostname');
// Port động Traefik — issuer/audience ghim từ cùng nguồn với auth-deploy nên
// exact match là cấu trúc (cùng hai outputs, cùng format), không phải hiệp
// bằng tay giữa hai stack.
const traefikHostPort = requirePlatformOutput('traefikHostPort');

// Mật khẩu hai role của db-pact-broker-app — orchestration sinh và truyền qua
// --config (stdin, không argv); `requireSecret` như api-deploy: đánh dấu output
// là secret bất kể stack config lưu plaintext, nên state Pulumi mã hoá giá trị
// ở mọi lần dùng.
const runtimePassword = conf.requireSecret('runtimePassword');
const migratorPassword = conf.requireSecret('migratorPassword');

/**
 * `client_id` của client public `pact-broker-app` tại `auth` (ADR-0031 §4) —
 * `local.ts` đọc cross-stack từ stack auth-deploy (đơn vị seed client) rồi
 * persist vào stack config của stack này. ĐỊNH DANH công khai OAuth, không
 * phải secret → `conf.require` thường; thiếu là fail ngay lúc `pulumi up`
 * chứ không chạy BFF không client.
 */
const pactBrokerAppClientId = conf.require('pactBrokerAppClientId');

// Fail-closed khi hai stack không thuộc cùng một worktree — export ở cuối file
// để throw trong `apply` làm `pulumi up` fail. Xem `home-deploy`.
const verifiedNamespace = pulumi.output(platformNamespace).apply((upstreamNs) => {
  if (upstreamNs !== ns) {
    throw new Error(
      `platformStackRef points to a stack of a different namespace: ` +
        `platform exports "${upstreamNs}" but this worktree is "${ns}". ` +
        `Both stacks must belong to the same worktree — otherwise pact-broker-app joins the wrong network.`,
    );
  }
  return ns;
});

// ---------------------------------------------------------------------------
// Provision + migrate của db-pact-broker-app (ADR-0031 §2) — cùng mô hình
// kênh secret với `pact-broker-api-deploy` cho db-pact-broker: mật khẩu qua
// map `environment` của provider (không argv), `docker run -e DATABASE_URL`
// chỉ mang TÊN biến, script text là đầu ra hàm thuần `scripts.ts` (không chứa
// giá trị secret nào) và được spec colocated chấm đúng text chạy thật.
// ---------------------------------------------------------------------------

const postgresContainerName = dockerResourceName(ns, 'postgres');

const provisionScript = buildProvisionScript({ postgresContainerName });

const provisionEnvironment: Record<string, pulumi.Output<string>> = {
  [MIGRATOR_PASSWORD_ENV_VAR]: migratorPassword,
  [RUNTIME_PASSWORD_ENV_VAR]: runtimePassword,
};

const provision = new command.local.Command(dockerResourceName(ns, 'pact-app') + '-provision', {
  create: provisionScript,
  update: provisionScript,
  // Trigger bọc secret: state/diff chỉ thấy `[secret]`, không bao giờ thấy mật
  // khẩu plaintext (trigger được lưu trong state Pulumi).
  triggers: [pulumi.secret(runtimePassword), pulumi.secret(migratorPassword), worktreeRoot],
  environment: provisionEnvironment,
  // ⚠️ Không có `dependsOn` Pulumi nào ở đây — có chủ đích (review #254):
  // container PostgreSQL platform là tài nguyên của stack `platform-deploy`
  // khác, và unit này chỉ chạm nó qua `docker exec` (tên container là chuỗi
  // theo convention, không phải Output nào của platform stack). Pulumi không
  // biểu diễn được dependency cross-stack tới tài nguyên không tự quản; chỉnh
  // thứ tự chạy bằng Nx task ordering: `pact-broker-app-deploy` chỉ được chạy
  // sau `platform-deploy:local-up` (orchestration của `local-up` ghép, cùng
  // mô hình với `pact-broker-api-deploy`). Chạy `pulumi up` trực tiếp trên
  // stack này khi platform chưa `up`: `docker exec` vào container vắng mặt ⇒
  // provision fail-loud ngay, không có nhánh im lặng nào.
});

// Percent-encode mật khẩu trước khi ghép vào userinfo của DATABASE_URL — encode
// là việc của hàm dựng URL (`buildMigratorConnectionUrl`); URL hoàn chỉnh bọc
// `pulumi.secret` ngay dưới. Biến kết quả KHÔNG mang tên khớp regex nguồn nhạy
// cảm (rule Semgrep `security-sensitive-value-in-http-response`).
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
  dockerResourceName(ns, 'pact-app') + '-migrate',
  {
    create: migrateScript,
    update: migrateScript,
    triggers: [pulumi.secret(migratorPassword), worktreeRoot],
    environment: { DATABASE_URL: migratorConnectionUrl },
  },
  { dependsOn: [provision] },
);

/**
 * Image local của `apps/pact-broker-app` — contract build giống `home-image`:
 * context repo root, builder `default` (bỏ bước boot builder `docker-container`
 * timeout trên Docker rootless), `load: true` + `push: false` (local không có
 * registry). Xem `home-deploy` cho từng cờ.
 */
/** Tag local của image — một nguồn duy nhất cho `tags` và input `image` của container. */
const imageTag = `ecoma-pact-app-${ns}:local`;

const image = new dockerBuild.Image(dockerResourceName(ns, 'pact-app-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/pact-broker-app-deploy/Dockerfile` },
  tags: [imageTag],
  builder: { name: 'default' },
  load: true,
  push: false,
  labels,
});

/**
 * Container của `apps/pact-broker-app`.
 *
 * Ghim digest (`tag@sha256:...`) biến mỗi rebuild thành thay đổi input thấy
 * được — container bị thay đúng lúc. KHÔNG có `ports`: mọi request đi qua
 * Traefik của platform — bất biến của local platform.
 */
// Percent-encode + bọc secret cho URL runtime của container — cùng lý do với
// `migratorConnectionUrl` phía trên.
const runtimeConnectionUrl = pulumi.secret(
  runtimePassword.apply((raw) => buildRuntimeConnectionUrl({ password: raw })),
);

const pactApp = new docker.Container(
  dockerResourceName(ns, 'pact-app'),
  {
    name: dockerResourceName(ns, 'pact-app'),
    image: pulumi.interpolate`${imageTag}@${image.digest}`,
    // `restart: unless-stopped` để DOCKER tự start lại container sau
    // reboot/restart daemon — cùng lý do với traefik/postgres ở `platform-deploy`.
    restart: 'unless-stopped',
    // Readiness resource-owned (`wait: true` — cùng ngữ nghĩa với platform):
    // Nuxt SSR cold start có thể vượt 30s; Trần chờ = startPeriod 30s +
    // 12 retries × 10s = 150s; waitTimeout 180s dư.
    wait: true,
    waitTimeout: 180,
    networksAdvanced: [{ name: networkName, aliases: ['ecoma-pact-app'] }],
    // `envs` (không phải `environment`): cặp `KEY=VALUE` dạng mảng chuỗi — shape
    // của `docker run -e`.
    //
    // Broker config: base URL trỏ alias nội bộ với port contract (phía trên) —
    // sai port chỉ làm `/api/broker/**` trả 502, còn `/health` vẫn xanh vì
    // healthcheck cố ý không phụ thuộc API. KHÔNG có biến token nào (ADR-0031
    // §5): BFF forward access token của chủ phiên, machine token của deploy unit
    // đã retire. Chuỗi kết nối DB bọc `pulumi.secret` nên interpolate giữ redact.
    envs: [
      `PORT=${PACT_APP_INTERNAL_PORT}`,
      'NODE_ENV=production',
      `NITRO_PACT_BROKER_API_BASE_URL=http://${PACT_API_ALIAS}:${PACT_API_INTERNAL_PORT}`,
      pulumi.interpolate`NITRO_PACT_BROKER_APP_DATABASE_URL=${runtimeConnectionUrl}`,
      // Issuer/audience ghim từ platform outputs — cùng nguồn với auth-deploy
      // (structural exact match); client_id từ stack config; origin fetch nội bộ
      // trỏ thẳng container auth trong network (local-only, production vắng mặt).
      pulumi.interpolate`NITRO_PACT_BROKER_AUTH_ISSUER=https://auth.${rootHostname}:${traefikHostPort}`,
      pulumi.interpolate`NITRO_PACT_BROKER_AUTH_AUDIENCE=https://api.${rootHostname}:${traefikHostPort}`,
      pulumi.interpolate`NITRO_PACT_BROKER_AUTH_CLIENT_ID=${pactBrokerAppClientId}`,
      pulumi.interpolate`NITRO_PACT_BROKER_AUTH_INTERNAL_ORIGIN=http://ecoma-${ns}-auth:${AUTH_INTERNAL_PORT}`,
    ],
    labels: [
      ...Object.entries(labels).map(([label, value]) => ({ label, value })),
      { label: 'traefik.enable', value: 'true' },
      {
        // Khai network của ROUTER này cho Traefik — bắt buộc với provider docker
        // multi-tenant: vừa chọn IP đúng network cho backend, vừa là điều kiện
        // lọc container vào router của đúng worktree. Xem `home-deploy`.
        label: 'traefik.docker.network',
        value: networkName,
      },
      {
        label: `traefik.http.routers.${traefikPrefix(ns)}.rule`,
        value: pulumi.interpolate`Host(\`pact.${rootHostname}\`)`,
      },
      {
        label: `traefik.http.routers.${traefikPrefix(ns)}.entrypoints`,
        value: 'websecure',
      },
      { label: `traefik.http.routers.${traefikPrefix(ns)}.tls`, value: 'true' },
      {
        label: `traefik.http.services.${traefikPrefix(ns)}.loadbalancer.server.port`,
        value: String(PACT_APP_INTERNAL_PORT),
      },
    ],
    healthcheck: {
      // `/health` chứ KHÔNG phải `/ready`: liveness container không được phụ
      // thuộc cấu hình broker — `/ready` trả 503 `broker_not_configured` khi
      // thiếu cấu hình broker/OIDC (fail-closed đúng của app nhưng sai làm
      // healthcheck container, làm container bị coi là hỏng trong cửa sổ
      // wiring). `/health` trả 2xx JSON tĩnh, không chạm broker API.
      tests: [
        'CMD',
        'node',
        '-e',
        // Cổng lấy từ cùng hằng số với `ENV PORT` của image, không hard-code lần
        // thứ hai trong một string khác. Chỉ 2xx (`r.ok`) mới healthy — một điều
        // kiện nới hơn kiểu `status < 500` sẽ coi 404 (route sai, app build sai)
        // là healthy và phá readiness.
        `fetch('http://127.0.0.1:${PACT_APP_INTERNAL_PORT}/health')` +
          `.then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))`,
      ],
      interval: '10s',
      timeout: '5s',
      retries: 12,
      // Nuxt SSR cold start có thể vượt 30s trên host chậm; chỉ sau `startPeriod`
      // mới tính `retries`.
      startPeriod: '30s',
    },
    // Container chỉ khởi khi database của unit đã provision + migrate xong —
    // không có cửa sổ container sống mà bảng phiên chưa tồn tại.
  },
  { dependsOn: [migrate] },
);

export const imageDigest = image.digest;
export const containerName = pactApp.name;
export const containerId = pactApp.id;
/** Namespace đã khớp stack platform — xem check fail-closed ở trên. */
export const namespaceVerified = verifiedNamespace;
