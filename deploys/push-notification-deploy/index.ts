/**
 * Chương trình Pulumi của `push-notification-deploy` — deploy unit của cặp
 * worker `push-notification` (control plane) + `web-push-notification-job`
 * (queue consumer) ở LAN LOCAL deployment, trong MỘT WIC container.
 *
 * Mirror `deploys/transactional-mail-deploy/index.ts` (wave 2, issue #264):
 * image mỏng ghim `node:24-bookworm-slim` + `ca-certificates` (PF2) chứa HAI
 * process `wrangler dev` theo `wic-entrypoint.sh`:
 *
 *   1. `ecoma-push-notification` (control plane — port nội bộ 4208) boot
 *      TRƯỚC: consumer resolve service binding `PUSH_NOTIFICATION_SERVICE`
 *      qua dev registry, chỉ `[connected]` khi control plane đã đăng ký entry
 *      (cùng bằng chứng spike §2 như mail). Control plane bind `0.0.0.0`
 *      (flag `--ip`) vì consumer gọi nó qua alias network — bind mặc định
 *      `localhost` của miniflare là loopback-only trong netns của container.
 *   2. `ecoma-web-push-notification-job` (consumer — port nội bộ 4209, không
 *      ai gọi HTTP trực tiếp ngoài operator reconcile) boot sau, cùng
 *      `$PERSIST_DIR` + `WRANGLER_REGISTRY_PATH` — queue local, D1 local và
 *      binding cross-process sống nhờ chung persist dir + registry.
 *
 * KHÁC mail ở ports và readiness: hai `wrangler.jsonc` của push KHÔNG khai
 * `dev.port` (như mail), nên entrypoint truyền `--port` tường minh cho từng
 * process (4208/4209 — không flag thì cả hai rơi về 8787, process sau chết
 * `Address already in use`). Control plane push KHÔNG có route `/health`
 * (khác mail) — entrypoint gate boot bằng banner `Ready on http` của wrangler
 * trên stdout (cùng readiness declaration `log-banner` mà
 * `apps/push-notification/local-worker.jsonc` khai cho host lane); Docker
 * healthcheck dùng `POST /v1/notifications` KHÔNG hợp lệ (đổi state) và
 * `GET /admin/v1/providers` cần bearer token, nên healthcheck probe một route
 * `notFound` (404 ổn định, chứng minh worker serve HTTP — cùng mức evidence
 * "HTTP serve được" như `/health` của mail).
 *
 * Repo mount READ-ONLY; entrypoint dựng runtime tree mirror ghi được dưới
 * `$PERSIST_DIR/runtime` (copy `wrangler.jsonc` + `dist`, symlink
 * `node_modules` hai tầng) và chạy wrangler từ đó — giống hệt mail. Secrets đi
 * qua `envs` của container (kênh container env — không argv, không label, không
 * log), `pulumi.secret` bọc trước khi interpolate để redact trong diff/log.
 *
 * KHÔNG có route Traefik: control plane chỉ phục vụ application/admin/runtime
 * API nội bộ (consumer duy nhất ở local là consumer qua service binding);
 * wrangler.jsonc không khai `routes` ở local. KHÔNG publish port ra host.
 *
 * Migrations D1 (`push` + `push-job`) chạy TRƯỚC container qua
 * `wrangler d1 migrations apply <db> --config <path> --local --persist-to
 * /state` trong container ephemeral mount cùng volume — WIC `dependsOn`
 * migrate (cùng grammar mail; `apply` tự idempotent qua bảng `d1_migrations`).
 *
 * Provider Web Push thật KHÔNG được cấu hình ở local: không có subscription
 * nào được tạo trong lane (chưa có UI/device registration path wired), nên
 * worker không bao giờ dial push service thật. Consumer chạy đủ boot path
 * (queue consumer + service binding) là mức evidence của unit này.
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

/**
 * Image Node pin (theo DIGEST) — chạy migrations D1 trong container ephemeral
 * và là base của image WIC; cùng digest auth/account/mail ghim.
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/**
 * Cổng HTTP nội bộ của control plane — nguồn cho (a) flag `--port` của
 * entrypoint, (b) healthcheck probe. KHÔNG có consumer nào ngoài container gọi
 * qua port này ở local (consumer đi qua service binding của dev registry).
 */
const PUSH_INTERNAL_PORT = 4208;

/**
 * Cổng HTTP nội bộ của consumer — chỉ tham chiếu tài liệu (flag `--port`
 * tương ứng nằm trong entrypoint; consumer không expose API nào, wrangler vẫn
 * bind để process sống). Không publish ra ngoài container.
 */
const PUSH_JOB_INTERNAL_PORT_DOC = 4209;
void PUSH_JOB_INTERNAL_PORT_DOC;

/** Alias DNS của WIC trong platform network — consumer gọi control plane qua service binding. */
const PUSH_ALIAS = 'ecoma-push';

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

/**
 * Secret HMAC dùng chung control plane <-> consumer: consumer gọi private
 * delivery runtime API với header `authorization` mang secret nguyên văn +
 * `X-ECOMA-PRINCIPAL` (`svc.web-push-notification-job` — hằng
 * `RUNTIME_CALLER_PRINCIPAL` của infrastructure client); control plane giữ
 * CÙNG giá trị làm `RUNTIME_API_SHARED_SECRET` và so expected principal
 * `RUNTIME_API_EXPECTED_PRINCIPAL`. Hai process nhận CÙNG giá trị trong CÙNG
 * một lần up (cùng container, hai env NAME) — không cần cross-stack read.
 */
const runtimeSharedSecret = conf.require('runtimeSharedSecret');

/** Bearer token + principal của Admin API (operator surface ở local). */
const adminToken = conf.require('adminToken');

/** Bearer token + principal của Application API (`POST /v1/notifications`). */
const applicationToken = conf.require('applicationToken');

/**
 * Root encryption key của credential keyring — base64 của 32 byte AES-256
 * (mà `buildCipher` của app kiểm). Orchestration sinh ngẫu nhiên mỗi lần up:
 * credential KHÔNG tồn tại xuyên các lần up ở local (D1 `push` trên volume
 * state là ephemeral theo thiết kế), nên xoay key mỗi up không phá dữ liệu nào
 * và không cần persist vào stack config.
 */
const credentialRootKey = conf.require('credentialRootKey');

/**
 * Volume RW duy nhất của WIC: state wrangler (`--persist-to` của HAI worker —
 * D1 `push`/`push-job` local, queue local, dev registry cho service binding,
 * runtime tree mirror, HOME/XDG của wrangler). Dữ liệu EPHEMERAL theo thiết kế
 * (state local runtime, không phải dữ liệu developer) — không `retainOnDelete`.
 */
const wicStateVolumeName = dockerResourceName(ns, 'push-wic-state');
const wicStateVolume = new docker.Volume(wicStateVolumeName, {
  name: wicStateVolumeName,
  labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
});

/**
 * Một-shot CHOWN volume cho uid 1000 (`node`) — cùng cơ chế mail/auth-wic-state:
 * Docker tạo volume mới `root:root`, mà cả migrate lẫn WIC chạy non-root;
 * file root-owned trong volume là EACCES ngay lúc migrate.
 */
const wicStateInit = new docker.Container(
  dockerResourceName(ns, 'push-wic-state-init'),
  {
    name: dockerResourceName(ns, 'push-wic-state-init'),
    image: NODE_IMAGE,
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
    labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
  },
  { dependsOn: [wicStateVolume], retainOnDelete: true },
);

/**
 * Nội dung script migrate chạy BÊN TRONG container ephemeral — cùng grammar
 * với `applyLocalD1Migrations` (`wrangler d1 migrations apply <db> --config
 * <path> --local --persist-to <dir>`). `apply` tự idempotent (đọc bảng
 * `d1_migrations`, chỉ áp file chưa chạy) nên create === update, không cần
 * guard thêm. HOME ghi được là bắt buộc (wrangler đọc/ghi OAuth/XDG cache
 * dưới home) — `/tmp` của container là 1777.
 */
const migrateInnerScript = `set -e
export HOME=/tmp/wrangler-home
export XDG_CONFIG_HOME="$HOME"
/repo/node_modules/.bin/wrangler d1 migrations apply push --config /repo/apps/push-notification/wrangler.jsonc --local --persist-to /state
/repo/node_modules/.bin/wrangler d1 migrations apply push-job --config /repo/apps/web-push-notification-job/wrangler.jsonc --local --persist-to /state
`;

/**
 * Migrations qua container ephemeral: repo mount ro + node_modules rw (binary
 * `wrangler` là shim symlink xuyên node_modules; ro đủ vì migrate chỉ ĐỌC) +
 * cùng volume `/state` mà WIC sẽ mount. `-u 1000:1000` để SQLite rơi vào
 * volume đúng owner `node` — file root-owned trước WIC là EACCES lúc boot.
 * KHÔNG gắn platform network: D1 local là SQLite trên volume, không đụng
 * PostgreSQL platform.
 */
const migrateScript = pulumi.interpolate`set -e
docker run --rm \\
  -u 1000:1000 \\
  -v ${shellQuote(worktreeRoot)}:/repo:ro \\
  -v ${shellQuote(worktreeRoot)}/node_modules:/repo/node_modules \\
  -v ${wicStateVolume.name}:/state \\
  -v /etc/ssl/certs:/etc/ssl/certs:ro \\
  --entrypoint sh \\
  ${NODE_IMAGE} \\
  -c ${shellQuote(migrateInnerScript)}
`;

const d1Migrate = new command.local.Command(
  dockerResourceName(ns, 'push-wic') + '-d1-migrate',
  {
    create: migrateScript,
    update: migrateScript,
    triggers: [worktreeRoot],
  },
  { dependsOn: [wicStateVolume, wicStateInit] },
);

/**
 * Image WIC — image MỎNG (mirror mail): Node pin + `ca-certificates` +
 * entrypoint. Build bundle là việc của target `build` Nx trên host; image chỉ
 * là "phòng chạy".
 */
const wicImageTag = dockerResourceName(ns, 'push-wic') + ':local';
const wicImage = new dockerBuild.Image(dockerResourceName(ns, 'push-wic-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/push-notification-deploy/Dockerfile` },
  tags: [wicImageTag],
  builder: { name: 'default' },
  load: true,
  push: false,
  labels,
});

/**
 * Container WIC — HAI worker `wrangler dev` qua `wic-entrypoint.sh`, plain
 * HTTP trên platform network. KHÔNG route Traefik, KHÔNG publish port.
 *
 * Env (thành bindings qua `CLOUDFLARE_INCLUDE_PROCESS_ENV` mà entrypoint bật):
 * - Secret + principal của private delivery runtime API: consumer và control
 *   plane nhận CÙNG giá trị — hai env NAME ở hai process, một GIÁ TRỊ.
 * - Token Admin/Application API: orchestration sinh.
 * - Root key credential: `PUSH_CREDENTIAL_ROOT_KEY_K1` (một version duy nhất
 *   ở local — `CREDENTIAL_KEY_VERSION=k1`... CHÚ Ý casing: keyring của app
 *   phân biệt hoa thường qua CSV `CREDENTIAL_SERVING_VERSIONS`, và secret
 *   name được dựng `${PREFIX}${version}` — version local là `K1` khớp fixture
 *   test của app).
 * - Sáu giá trị SLA là tối thiểu để loader fail-closed của control plane PASS
 *   lúc boot; ràng buộc coherence (retention >= retry window, retry window <=
 *   max TTL) được giữ. KHÔNG phải quyết định vận hành — local-only giá trị,
 *   cùng tính chất các giá trị vận hành mail.
 */
const wic = new docker.Container(
  dockerResourceName(ns, 'push-wic'),
  {
    name: dockerResourceName(ns, 'push-wic'),
    image: pulumi.interpolate`${wicImageTag}@${wicImage.digest}`,
    restart: 'unless-stopped',
    // Readiness resource-owned (`wait: true` — cùng ngữ nghĩa với platform):
    // healthcheck là HEAD `/__wic_probe` (404 ổn định của `notFound`) —
    // chứng minh workerd boot và serve HTTP. Trần chờ = startPeriod 120s +
    // 30 retries × 10s = 420s; waitTimeout 450s dư.
    wait: true,
    waitTimeout: 450,
    // `stop_timeout` 30s khớp bounded-wait 20s của entrypoint (SIGTERM → hai
    // workerd thoát sạch trước khi Docker SIGKILL) — cùng luật mail/auth.
    stopTimeout: 30,
    volumes: [
      {
        volumeName: wicStateVolumeName,
        containerPath: '/state',
      },
      // Repo root mount read-only — nguồn wrangler binary + wrangler.jsonc +
      // cây node_modules hai tầng cho runtime mirror (deps check của
      // entrypoint fail-loud khi thiếu — Issue #233).
      {
        hostPath: worktreeRoot,
        containerPath: '/repo',
        readOnly: true,
      },
      // Bundle `dist/` của hai app — build trên host bởi target `build` Nx,
      // mount bind ro trực tiếp vào vị trí repo mount kỳ vọng.
      {
        hostPath: `${worktreeRoot}/apps/push-notification/dist`,
        containerPath: '/repo/apps/push-notification/dist',
        readOnly: true,
      },
      {
        hostPath: `${worktreeRoot}/apps/web-push-notification-job/dist`,
        containerPath: '/repo/apps/web-push-notification-job/dist',
        readOnly: true,
      },
    ],
    networksAdvanced: [
      {
        name: networkName,
        aliases: [PUSH_ALIAS],
      },
    ],
    envs: [
      // --- Cặp control plane <-> consumer: hai env NAME, một GIÁ TRỊ ---
      pulumi.interpolate`RUNTIME_API_SHARED_SECRET=${pulumi.secret(runtimeSharedSecret)}`,
      // Principal cố định của client delivery runtime (hằng
      // RUNTIME_CALLER_PRINCIPAL của web-push-notification-job infrastructure).
      'RUNTIME_API_EXPECTED_PRINCIPAL=svc.web-push-notification-job',
      // --- Auth Admin/Application API ---
      pulumi.interpolate`ADMIN_API_TOKEN=${pulumi.secret(adminToken)}`,
      'ADMIN_API_PRINCIPAL=backoffice',
      pulumi.interpolate`APPLICATION_API_TOKEN=${pulumi.secret(applicationToken)}`,
      'APPLICATION_API_PRINCIPAL=ecoma-io',
      // --- Credential keyring + root key (một version ở local) ---
      'CREDENTIAL_KEY_VERSION=K1',
      'CREDENTIAL_SERVING_VERSIONS=K1',
      pulumi.interpolate`PUSH_CREDENTIAL_ROOT_KEY_K1=${pulumi.secret(credentialRootKey)}`,
      // --- Sáu SLA (launch gate của app; local-only giá trị, coherence giữ) ---
      'IDEMPOTENCY_RETENTION_MS=86400000',
      'CALLER_RETRY_WINDOW_MS=300000',
      'MAX_NOTIFICATION_TTL_MS=604800000',
      'PAYLOAD_DIGEST_ALGORITHM=none',
      'OUTBOX_RECOVERY_SLA_MS=900000',
      'DELIVERY_RECONCILIATION_AGE_MS=900000',
      // --- Metadata ---
      'ENVIRONMENT=local',
      'LOG_LEVEL=info',
    ],
    labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
    healthcheck: {
      // Control plane KHÔNG có `/health` (thiết kế của app) — probe một route
      // không tồn tại: `notFound` trả 404 ổn định và không chạm dependency nào,
      // chứng minh workerd boot và serve HTTP (cùng mức evidence "HTTP serve"
      // như `/health` của mail — không hơn). 404 là status THIẾT YẾU của probe
      // này; một status khác (503 config error, 500) là fail.
      tests: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${PUSH_INTERNAL_PORT}/__wic_probe', { method: 'HEAD' })` +
          `.then(r => process.exit(r.status === 404 ? 0 : 1)).catch(() => process.exit(1))`,
      ],
      interval: '10s',
      timeout: '5s',
      retries: 30,
      // Chuỗi đúng dạng Go duration Docker chuẩn hoá khi đọc ngược (`2m0s`,
      // không phải `120s`) — lệch dạng không đổi giá trị nhưng biến mỗi cặp
      // refresh + up thành diff ảo trên healthcheck.
      startPeriod: '2m0s',
    },
  },
  { dependsOn: [d1Migrate, wicImage, wicStateVolume, wicStateInit] },
);

export const migrateCommandName = d1Migrate.id;
export const imageDigest = wicImage.digest;
export const containerName = wic.name;
export const containerId = wic.id;
export const stateVolumeName = wicStateVolume.name;
export const namespaceVerified = verifiedNamespace;
