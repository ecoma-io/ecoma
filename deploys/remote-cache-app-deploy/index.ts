/**
 * Chương trình Pulumi của `remote-cache-app-deploy` — deploy unit của
 * `apps/remote-cache-app` (composition SPA admin của Remote Cache) ở LAN LOCAL
 * deployment.
 *
 * Mirror `deploys/pact-broker-app-deploy/index.ts` (cùng ownership labels,
 * namespace, stack reference fail-closed, image build qua `@pulumi/docker-build`
 * với builder `default` + `load: true`) và đơn giản hơn: app composition này
 * KHÔNG có business backend — không database, không role, không migration,
 * không Hyperdrive/D1/R2/KV/Queue, không secret, không OIDC/client id và không
 * đọc config cross-stack nào ngoài ba output platform (network, namespace,
 * hostname). Router rule `Host(remote-cache-app.<rootHostname>)`.
 *
 * Phạm vi: chỉ phục vụ stack `local-<namespace>` (Docker runtime). Staging và
 * production của app đi đường Cloudflare Workers qua Wrangler
 * (`apps/remote-cache-app/wrangler.jsonc`, preset `cloudflare-module`) và **không**
 * đi qua chương trình này.
 *
 * Ranh giới ownership: unit này KHÔNG tạo network, Traefik hay PostgreSQL; nó
 * đọc platform outputs qua StackReference rồi join network.
 */

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

/** Cổng nội bộ mà Nitro preset `node-server` nghe (khớp `EXPOSE`/`ENV PORT` của image). */
const APP_INTERNAL_PORT = 3000;

/**
 * Entrypoint HTTPS của Traefik — nơi client gõ `https://remote-cache-app.<rootHostname>`.
 * Tên router/service mang namespace vì Traefik đọc label toàn cục (multi-tenant
 * giữa các worktree) — xem `pact-broker-app-deploy`.
 */
const traefikPrefix = (ns: string): string => `remote-cache-app-${ns}`;

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
const remoteCacheApp = new docker.Container(dockerResourceName(ns, remoteCacheAppKind), {
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
  // của `docker run -e`. App composition này không cần secret hay backend.
  envs: [`PORT=${APP_INTERNAL_PORT}`, 'NODE_ENV=production'],
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
});

export const imageDigest = image.digest;
export const containerName = remoteCacheApp.name;
export const containerId = remoteCacheApp.id;
/** Namespace đã khớp stack platform — xem check fail-closed ở trên. */
export const namespaceVerified = verifiedNamespace;
