/**
 * Chương trình Pulumi của `transactional-mail-deploy` — deploy unit của cặp
 * worker `transactional-mail` (control plane) + `transactional-mailer-job`
 * (queue consumer) ở LAN LOCAL deployment, trong MỘT WIC container.
 *
 * Mirror auth-deploy (#183): image mỏng ghim `node:24-bookworm-slim` +
 * `ca-certificates` (PF2) chứa HAI process `wrangler dev` theo
 * `wic-entrypoint.sh`:
 *
 *   1. `ecoma-transactional-mail` (control plane — port nội bộ 4206) boot
 *      TRƯỚC: consumer resolve service binding `TRANSACTIONAL_MAIL_SERVICE`
 *      qua dev registry, chỉ `[connected]` khi control plane đã đăng ký entry
 *      (bằng chứng spike §2, docs/architecture/local-development/evidence/worker-runtime-spike.md). Control plane
 *      bind `0.0.0.0` (flag `--ip`) vì container account gọi tới nó qua alias
 *      network — bind mặc định `localhost` của miniflare là loopback-only
 *      trong netns của container, alias không với tới được.
 *   2. `ecoma-transactional-mailer-job` (consumer — port nội bộ 4207, không ai
 *      gọi HTTP trực tiếp) boot sau, cùng `$PERSIST_DIR` +
 *      `WRANGLER_REGISTRY_PATH` — queue local, D1 local và binding
 *      cross-process sống nhờ chung persist dir + registry.
 *
 * KHÁC auth ở ports: hai `wrangler.jsonc` của mail KHÔNG khai `dev.port`
 * (đường host `local-worker-up` cấp phát động theo namespace) — chạy `wrangler
 * dev` không `--port` thì CẢ HAI rơi về mặc định 8787, process sau chết
 * `Address already in use`. Entrypoint truyền `--port` tường minh cho từng
 * process; trong container có network stack riêng nên port tĩnh không đụng
 * host (cùng lập luận `AUTH_INTERNAL_PORT` của auth-deploy).
 *
 * Repo mount READ-ONLY là KHÔNG đủ để chạy wrangler dev (giải thích đầy đủ ở
 * JSDoc auth-deploy: `.wrangler/tmp` hard-code, cache miniflare, dev registry
 * đều là đường ghi dưới repo) — entrypoint dựng runtime tree mirror ghi được
 * dưới `$PERSIST_DIR/runtime` và chạy wrangler từ đó. Secrets đi qua `envs`
 * của container (kênh container env — không argv, không label, không log),
 * `pulumi.secret` bọc trước khi interpolate để redact trong diff/log.
 *
 * KHÔNG có route Traefik: cả hai worker đều internal-only (wrangler.jsonc
 * không khai `routes`; control plane chỉ có internal API). Traffic vào duy
 * nhất: container account → `http://ecoma-mail:4206` (path OTP login, scope
 * issue #183) và service binding của consumer qua dev registry nội bộ.
 *
 * Readiness qua `GET /health` của control plane — khác auth (`/ready` probe
 * DB + binding): mail control plane chỉ có `/health` (200, không chạm
 * dependency nào) nên healthcheck chứng minh "container phục vụ được HTTP",
 * không hơn — mức evidence cao nhất service này có.
 *
 * Migrations D1 (`mail` + `mail-job`) chạy TRƯỚC container qua
 * `wrangler d1 migrations apply <db> --config <path> --local --persist-to
 * /state` (cùng grammar `applyLocalD1Migrations`) trong container ephemeral
 * mount cùng volume — WIC `dependsOn` migrate. Migration `0009` của `mail`
 * tự seed template `account.login-otp` mà account path dùng.
 *
 * Provider local: `MAIL_PROVIDER_KIND=fake` — config consumer FORBID
 * `MAIL_PROVIDER_ENDPOINT`/`MAIL_PROVIDER_TOKEN` khi kind=fake, nên KHÔNG có
 * provider SMTP thật nào được cấu hình; gửi thật fail ở bước provider, message
 * row trong D1 `mail` là assertion local (cùng trạng thái script e2e
 * script mail-worker-runtime-e2e của tools/dx).
 */

import { createHmac } from 'node:crypto';

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
 * và là base của image WIC; cùng digest auth/account ghim.
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/**
 * Cổng HTTP nội bộ của control plane — nguồn cho (a) flag `--port` của
 * entrypoint, (b) account container trỏ `NUXT_MAIL_SERVICE_URL=http://
 * ecoma-mail:<port>`, (c) healthcheck. BÁO GIÁ TRỊ NÀY trong PR body.
 */
const MAIL_INTERNAL_PORT = 4206;

/**
 * Cổng HTTP nội bộ của consumer — chỉ tham chiếu tài liệu (flag `--port`
 * tương ứng nằm trong entrypoint; consumer không expose API nào, wrangler vẫn
 * bind để process sống). Không publish ra ngoài container.
 */
const MAIL_JOB_INTERNAL_PORT_DOC = 4207;
void MAIL_JOB_INTERNAL_PORT_DOC;

/** Alias DNS của WIC trong platform network — account gọi `http://ecoma-mail`. */
const MAIL_ALIAS = 'ecoma-mail';

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

/**
 * Secret HMAC path Account↔Mail — CÙNG GIÁ TRỊ account stack đã persist làm
 * `namespace:mailInternalAuthSecret` (MỘT giá trị: entry up của account persist
 * vào stack config của nó, entry up của stack này đọc lại — cùng cơ chế
 * `identityInternalSecret` của auth). Control plane giữ nó làm entry `MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT`
 * (principal `svc.account`); account ký envelope với
 * `NUXT_MAIL_INTERNAL_AUTH_SECRET` cùng giá trị. Thiếu key là fail ngay lúc
 * `pulumi up` (`conf.require`).
 */
const mailInternalAuthSecret = conf.require('mailInternalAuthSecret');

/**
 * Secret HMAC cặp mail nội bộ consumer↔control plane: consumer ký internal
 * request với env `TRANSACTIONAL_MAIL_INTERNAL_AUTH_SECRET`; control plane
 * giữ CÙNG giá trị làm entry `MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_
 * MAILER_JOB` (internal-delivery-client.ts §hợp đồng hai biến một giá trị).
 * Orchestration sinh giá trị riêng (không lộ ra ngoài cặp).
 */
const mailerJobInternalSecret = conf.require('mailerJobInternalSecret');

/**
 * Khoá HMAC 64 hex (32 byte) của keyring `request_fingerprint` — orchestration
 * sinh; program bọc vào JSON keyring `{"current":"p1.k1","keys":{"p1.k1":...}}`
 * đúng shape `parseFingerprintKeyring` yêu cầu (current phải trỏ key có thật).
 */
const mailFingerprintKey = conf.require('mailFingerprintKey');

/** Khoá HMAC 64 hex của quarantine consumer — orchestration sinh. */
const mailQuarantineHmacKey = conf.require('mailQuarantineHmacKey');

/**
 * Hai credential placeholder của registry cho principal KHÔNG có đường gọi
 * nào trong repo (`svc.auth`, `svc.payment` — allowlist rỗng, nhận credential
 * nhưng 403 mọi template). Registry ĐÒI đủ bốn slot `current` và từ chối giá
 * trị trùng nhau (envelope không mang key id — hai entry trùng là không phân
 * biệt được ở runtime), nên giá trị phải tồn tại VÀ phân biệt.
 *
 * Vì sao derived mà không sinh thêm config key: đây là credential không caller
 * nào dùng ở local; derive HMAC-SHA256 từ secret orchestration với label khác
 * nhau cho giá trị ổn định trong một lần up, phân biệt chắc chắn giữa các
 * principal, và không bao giờ in ra log (chỉ đi vào `envs` bọc `pulumi.secret`).
 */
function derivePlaceholderCredential(label: string): string {
  return createHmac('sha256', mailInternalAuthSecret).update(`ecoma-local/${label}`).digest('hex');
}

const svcAuthCredential = derivePlaceholderCredential('svc-auth');
const svcPaymentCredential = derivePlaceholderCredential('svc-payment');

const verifiedNamespace = pulumi.output(platformNamespace).apply((upstreamNs) => {
  if (upstreamNs !== ns) {
    throw new Error(
      `platformStackRef points to a stack of a different namespace: platform exports "${upstreamNs}" but this worktree is "${ns}".`,
    );
  }
  return ns;
});

/**
 * Volume RW duy nhất của WIC: state wrangler (`--persist-to` của HAI worker —
 * D1 `mail`/`mail-job` local, queue local, dev registry cho service binding,
 * runtime tree mirror, HOME/XDG của wrangler). Dữ liệu EPHEMERAL theo thiết kế
 * (state local runtime, không phải dữ liệu developer) — không `retainOnDelete`.
 */
const wicStateVolumeName = dockerResourceName(ns, 'mail-wic-state');
const wicStateVolume = new docker.Volume(wicStateVolumeName, {
  name: wicStateVolumeName,
  labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
});

/**
 * Một-shot CHOWN volume cho uid 1000 (`node`) — cùng cơ chế auth-wic-state:
 * Docker tạo volume mới `root:root`, mà cả migrate lẫn WIC chạy non-root;
 * file root-owned trong volume là EACCES ngay lúc migrate.
 */
const wicStateInit = new command.local.Command(
  dockerResourceName(ns, 'mail-wic-state-init'),
  {
    create: pulumi.interpolate`docker run --rm -v ${wicStateVolume.name}:/state ${NODE_IMAGE} chown 1000:1000 /state`,
    update: pulumi.interpolate`docker run --rm -v ${wicStateVolume.name}:/state ${NODE_IMAGE} chown 1000:1000 /state`,
    triggers: [wicStateVolume.name],
  },
  { dependsOn: [wicStateVolume] },
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
/repo/node_modules/.bin/wrangler d1 migrations apply mail --config /repo/apps/transactional-mail/wrangler.jsonc --local --persist-to /state
/repo/node_modules/.bin/wrangler d1 migrations apply mail-job --config /repo/apps/transactional-mailer-job/wrangler.jsonc --local --persist-to /state
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
  dockerResourceName(ns, 'mail-wic') + '-d1-migrate',
  {
    create: migrateScript,
    update: migrateScript,
    triggers: [worktreeRoot],
  },
  { dependsOn: [wicStateVolume, wicStateInit] },
);

/**
 * Image WIC — image MỎNG (mirror auth): Node pin + `ca-certificates` +
 * entrypoint. Build bundle là việc của target `build` Nx trên host; image chỉ
 * là "phòng chạy".
 */
const wicImageTag = dockerResourceName(ns, 'mail-wic') + ':local';
const wicImage = new dockerBuild.Image(dockerResourceName(ns, 'mail-wic-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/transactional-mail-deploy/Dockerfile` },
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
 * - Registry credential của control plane: bốn slot `current` với giá trị PHÂN
 *   BIỆT (registry fail-closed khi trùng). Slot `SVC_ACCOUNT` = secret
 *   Account↔Mail orchestration đã chia cho account; slot
 *   `SVC_TRANSACTIONAL_MAILER_JOB` = secret consumer đang giữ (hai env NAME ở
 *   hai process, một GIÁ TRỊ).
 * - Keyring fingerprint + quarantine key: giá trị orchestration sinh.
 * - Giá trị vận hành còn lại: tối thiểu để loader fail-closed của hai app PASS
 *   lúc boot (cùng tập giá trị script e2e đã chứng minh chạy được).
 */
const wic = new docker.Container(
  dockerResourceName(ns, 'mail-wic'),
  {
    name: dockerResourceName(ns, 'mail-wic'),
    image: pulumi.interpolate`${wicImageTag}@${wicImage.digest}`,
    restart: 'unless-stopped',
    // Readiness resource-owned (`wait: true` — cùng ngữ nghĩa với platform):
    // identity-login-e2e (nhận OTP qua mail sink) chỉ chạy sau khi healthcheck
    // `/health` của WIC chuyển `healthy`. Trần chờ = startPeriod 120s +
    // 30 retries × 10s = 420s; waitTimeout 450s dư.
    wait: true,
    waitTimeout: 450,
    // `stop_timeout` 30s khớp bounded-wait 20s của entrypoint (SIGTERM → hai
    // workerd thoát sạch trước khi Docker SIGKILL) — cùng luật auth.
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
        hostPath: `${worktreeRoot}/apps/transactional-mail/dist`,
        containerPath: '/repo/apps/transactional-mail/dist',
        readOnly: true,
      },
      {
        hostPath: `${worktreeRoot}/apps/transactional-mailer-job/dist`,
        containerPath: '/repo/apps/transactional-mailer-job/dist',
        readOnly: true,
      },
    ],
    networksAdvanced: [
      {
        name: networkName,
        aliases: [MAIL_ALIAS],
      },
    ],
    envs: [
      // --- Registry credential của control plane (bốn slot, giá trị phân biệt) ---
      pulumi.interpolate`MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT=${pulumi.secret(mailInternalAuthSecret)}`,
      pulumi.interpolate`MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH=${pulumi.secret(svcAuthCredential)}`,
      pulumi.interpolate`MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT=${pulumi.secret(svcPaymentCredential)}`,
      pulumi.interpolate`MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB=${pulumi.secret(mailerJobInternalSecret)}`,
      // --- Cặp consumer <-> control plane: hai env NAME, một GIÁ TRỊ ---
      pulumi.interpolate`TRANSACTIONAL_MAIL_INTERNAL_AUTH_SECRET=${pulumi.secret(mailerJobInternalSecret)}`,
      // --- Keyring fingerprint (JSON, secret) + quarantine key ---
      pulumi.interpolate`MAIL_FINGERPRINT_KEYRING=${pulumi.secret(pulumi.interpolate`{"current":"p1.k1","keys":{"p1.k1":"${mailFingerprintKey}"}}`)}`,
      pulumi.interpolate`MAIL_QUARANTINE_HMAC_KEY=${pulumi.secret(mailQuarantineHmacKey)}`,
      // --- Giá trị vận hành control plane (tối thiểu hợp lệ, cùng script e2e) ---
      'MAIL_INTERNAL_AUTH_SKEW_SECONDS=300',
      'MAIL_RATE_LIMIT_PRINCIPAL_LIMIT=100',
      'MAIL_RATE_LIMIT_PRINCIPAL_WINDOW_MS=60000',
      'MAIL_RATE_LIMIT_SYSTEM_LIMIT=1000',
      'MAIL_RATE_LIMIT_SYSTEM_WINDOW_MS=60000',
      'MAIL_RATE_LIMIT_KEY_LIMIT=100',
      'MAIL_RATE_LIMIT_KEY_WINDOW_MS=60000',
      'MAIL_RENDER_MAX_BYTES=65536',
      'MAIL_PUBLISH_LEASE_MS=30000',
      'MAIL_PUBLISH_BATCH_LIMIT=10',
      'MAIL_PUBLISH_MAX_ATTEMPTS=3',
      'MAIL_PUBLISH_BACKOFF_BASE_MS=1000',
      'MAIL_RECONCILER_MAX_AGE_MS=600000',
      'MAIL_RECONCILER_BATCH_LIMIT=10',
      'MAIL_RECOVERY_MAX_CYCLES=2',
      'MAIL_NONCE_PRUNE_BATCH_LIMIT=100',
      'MAIL_RETENTION_CONTENT_MS=2592000000',
      'MAIL_RETENTION_STALE_ALERT_MS=86400000',
      // --- Giá trị vận hành consumer: fake provider — KHÔNG có SMTP thật ---
      'MAIL_PROVIDER_KIND=fake',
      'MAIL_PROVIDER_TIMEOUT_MS=10000',
      'MAIL_JOB_MAX_EXECUTION_ATTEMPTS=4',
      'MAIL_JOB_EXECUTION_LEASE_MS=30000',
      'MAIL_JOB_PROVIDER_CALL_SAFE_WINDOW_MS=3600000',
      'MAIL_JOB_REPORT_LEASE_MS=30000',
      'MAIL_JOB_MAX_REPORT_ATTEMPTS=3',
      'MAIL_JOB_SWEEP_BATCH_LIMIT=10',
    ],
    labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
    healthcheck: {
      // `/health` của control plane (port nội bộ 4206) — KHÔNG `/ready` kiểu
      // auth vì mail control plane không có route đó. `/health` không chạm
      // dependency nào nên healthcheck này chứng minh HTTP serve, không hơn.
      tests: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${MAIL_INTERNAL_PORT}/health')` +
          `.then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))`,
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
