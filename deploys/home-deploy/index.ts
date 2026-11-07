/**
 * Chương trình Pulumi của `home-deploy` — deploy unit của `apps/home` ở LAN
 * LOCAL deployment.
 *
 * Phạm vi: chỉ phục vụ stack `local-<namespace>` (Docker runtime). Staging và
 * production của `home` đi đường Cloudflare Workers qua Wrangler
 * (`apps/home/wrangler.jsonc`) và **không** đi qua chương trình này.
 *
 * Ranh giới ownership: `home-deploy` KHÔNG tự tạo network, Traefik hay
 * PostgreSQL. Nó đọc chúng qua Pulumi stack reference tới `platform-deploy`
 * (producer của contract `PlatformOutputs` ở
 * `platform-outputs-contract` của `@ecoma-io/deployment`) rồi join vào network đó. Không có
 * shared database access và không có resource dùng chung nào ở đây.
 *
 * Mọi tên resource đều đi qua `dockerResourceName(ns, kind)` để hai worktree
 * chạy cạnh nhau trên một host không bao giờ trùng tên; `ns` là hash ổn định
 * của absolute worktree root.
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
  type PlatformOutputs,
  dockerResourceName,
  normalizeWorktreeRoot,
  ownershipLabels,
  worktreeNamespace,
} from '@ecoma-io/deployment';

/** Cổng nội bộ mà Nitro preset `node-server` nghe (khớp `EXPOSE`/`ENV PORT` của image). */
const HOME_INTERNAL_PORT = 3000;

/**
 * Entrypoint HTTPS của Traefik — nơi client gõ `https://fbi.com`.
 *
 * Cần đúng tên này để đặt tên router/service không trùng với router/service của
 * deploy unit khác. Namespace nằm trong tên vì Traefik đọc label **toàn cục**:
 * hai worktree có hai network riêng nhưng chung một Traefik provider, tên
 * không có namespace sẽ khiến router của worktree sau đè router của worktree
 * trước.
 */
const traefikPrefix = (ns: string): string => `home-${ns}`;

// Config bag `namespace` — CÙNG tên bag với điều `platform-deploy` nhận, vì
// orchestration truyền một bộ `--config namespace:...` duy nhất cho cả hai
// project. `new pulumi.Config()` không đối số sẽ đọc bag theo tên project
// (`home-deploy:...`) và không bao giờ thấy key orchestration truyền.
const conf = new pulumi.Config('namespace');

// Absolute worktree root — nguồn duy nhất của namespace. Cùng config key với
// điều `platform-deploy` nhận, nên hai stack luôn cùng namespace.
const worktreeRoot = conf.require('worktreeRoot');
const ns = worktreeNamespace(worktreeRoot);

/**
 * Labels ownership của resource này — cùng bộ labels với `platform-deploy`
 * (một bản duy nhất ở `deploy-labels.ts`). `pnpm dx local-cleanup` đọc bộ
 * labels này thay vì đoán từ tên: tên trông giống ecoma không phải bằng chứng
 * ownership.
 */
const labels = ownershipLabels(normalizeWorktreeRoot(worktreeRoot), ns);

// Stack reference **đầy đủ** tới stack platform của chính worktree này, do
// entry `local-up` của platform (`deploys/platform-deploy/local.ts`) ghép và
// truyền qua `--config`. Đọc từ config thay vì tự dựng `file://<dir>/local-<ns>`:
// backend `file://` và cách Pulumi resolve stack reference là chi tiết của entry;
// tự ghép chuỗi ở đây tạo ra một đường suy đoán thứ hai cho cùng một stack và
// chỗ nào lệch là deploy sai worktree.
const platform = new pulumi.StackReference(conf.require('platformStackRef'));

/**
 * Đọc MỘT output từ stack reference với ràng buộc fail-closed theo contract.
 *
 * `getOutput` trả `undefined` (không ném lỗi) khi key không còn được export —
 * ép kiểu `as` trần trụi biến tên output đổi thành deploy "xanh" nhưng rỗng:
 * `ROOT_HOST=fbi.com:undefined`, label `traefik.docker.network` trống, và vì
 * platform lọc theo label đó nên container bị loại khỏi config → 404/502 thay
 * vì lỗi deploy. Helper này biến lệch contract thành lỗi deploy tường minh.
 */
function requirePlatformOutput<K extends keyof PlatformOutputs>(
  key: K,
): pulumi.Output<PlatformOutputs[K]> {
  return pulumi.output(platform.getOutput(key)).apply((raw) => {
    if (raw === undefined || raw === null) {
      throw new Error(
        `platformStackRef does not export "${key}". Most common cause: ` +
          `the platform stack has never \`up\`ed successfully (empty outputs) or was ` +
          `destroyed — run \`pnpm nx run platform-deploy:local-up -c local\` (apply platform) first. Only if ` +
          `the PlatformOutputs contract actually renamed/removed the output should you ` +
          `change both producer/consumer sides. Do not deploy home with an empty configuration.`,
      );
    }
    return raw as PlatformOutputs[K];
  });
}

const networkName = requirePlatformOutput('networkName');
// `traefikHostPort` CỐ Ý KHÔNG đọc vào container: `apps/home` không publish cổng
// nào (mọi request đi qua Traefik), và healthcheck của container dùng cổng nội
// bộ từ hằng số dùng chung với image — không cần port đã publish ra host. Output
// vẫn thuộc contract và được entry platform đọc để dựng `ROOT_HOST` cho `.env`.
const platformNamespace = requirePlatformOutput('namespace');
// Hostname router đọc từ output của producer — KHÔNG dùng hằng
// `LOCAL_ROOT_HOSTNAME`: producer đổi hostname thì router theo output, và lệch
// contract bị bắt tại `requirePlatformOutput` thay vì âm thầm route tên cũ.
const rootHostname = requirePlatformOutput('rootHostname');
// `postgresHost`/`postgresPort` CỐ Ý KHÔNG đọc: `apps/home` không sở hữu
// database nào — tiêm endpoint PostgreSQL của platform vào env của service
// không sở hữu nó là đường nối DB trực tiếp xuyên service, trái invariant data
// ownership. Khi một service sau này sở hữu database của riêng nó, connection
// string (kèm user/database/secret) sẽ được khai ở deploy unit của service đó,
// không mượn endpoint của DB platform.

// Fail-closed khi hai stack không thuộc cùng một worktree.
//
// Cả hai đều tự suy namespace từ `worktreeRoot` nên **lệch chỉ xảy ra** khi
// orchestration truyền `platformStackRef` trỏ sang stack platform của worktree
// khác — và lúc đó mọi thứ vẫn "chạy": container tên theo namespace A nhưng
// join network của B, image đúng, build xanh, chỉ là `https://fbi.com` trỏ sang
// home của worktree khác. So sánh tường minh ở đây biến lỗi đó thành lỗi
// deploy.
//
// Kết quả được EXPORT (`namespaceVerified`, cuối file) chứ không bỏ rơi:
// Pulumi chỉ await những output có trong graph, nên một `apply()` mà kết quả bị
// vứt đi có thể nuốt exception thành rejection không ai nghe — đúng trường hợp
// lỗi im lặng mà check này sinh ra để chặn. Export nó thành output thật thì
// throw trong `apply` làm `pulumi up` fail.
const verifiedNamespace = pulumi.output(platformNamespace).apply((upstreamNs) => {
  if (upstreamNs !== ns) {
    throw new Error(
      `platformStackRef points to a stack of a different namespace: ` +
        `platform exports "${upstreamNs}" while this worktree is "${ns}". ` +
        `Both stacks must belong to the same worktree — otherwise home joins the wrong network.`,
    );
  }
  return ns;
});

/**
 * Image local của `apps/home`.
 *
 * Build context là **repo root** chứ không phải thư mục chứa Dockerfile:
 * `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `patches/` và workspace package
 * `libs/ui-ecoma-logo` đều nằm ở root, và Dockerfile cần chúng để
 * `pnpm install --frozen-lockfile`. Vì vậy mọi path COPY trong Dockerfile
 * (`deploys/home-deploy/Dockerfile`) là path tương đối với context root,
 * không phải với `deploys/home-deploy/`.
 *
 * `builder.name = 'default'` là bắt buộc trên máy builder docker driver: khi
 * không khai, provider 0.0.22 tự tạo builder `docker-container` mới và boot
 * nó trong 30s (`host.go`, hàm boot builder) — trên Docker rootless bước boot
 * đó timeout đều với "booting builder: context deadline exceeded". Trỏ thẳng
 * vào builder `default` (docker driver, sẵn có trên mọi cài Docker với
 * buildx) bỏ trọn bước boot. Xoá dòng này chỉ khi chuyển sang builder riêng.
 *
 * `load: true` + `push: false` nạp image vào Docker daemon cục bộ — local
 * deployment không có registry nào để push.
 */
/** Tag local của image home — một nguồn duy nhất cho `tags` và input `image` của container. */
const imageTag = `ecoma-home-${ns}:local`;

const image = new dockerBuild.Image(dockerResourceName(ns, 'home-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/home-deploy/Dockerfile` },
  tags: [imageTag],
  builder: { name: 'default' },
  load: true,
  push: false,
  labels,
});

/**
 * Container của `apps/home`.
 *
 * `image` là `<tag>@sha256:<digest>` — output `ref` của docker-build với
 * `push: false` CHỈ là tag (`ecoma-home-<ns>:local`, chuỗi bất biến giữa các
 * lần build): container input không đổi ⇒ Pulumi không thay container sau khi
 * code đổi, container cứ chạy image CŨ với smoke vẫn xanh. Ghim digest biến
 * mỗi rebuild thành thay đổi input thấy được — container bị thay đúng lúc.
 *
 * KHÔNG có `ports`: home không publish cổng ra host — mọi request đi qua Traefik
 * của platform. Đây là bất biến của local platform, không phải thiếu sót.
 */
const home = new docker.Container(dockerResourceName(ns, 'home'), {
  name: dockerResourceName(ns, 'home'),
  image: pulumi.interpolate`${imageTag}@${image.digest}`,
  // Cùng lý do với traefik/postgres ở `platform-deploy`: `restart:
  // unless-stopped` để DOCKER tự start lại container sau reboot/restart daemon
  // — `pulumi up` không làm được điều đó vì input khai và input trong state
  // đều như nhau, không có diff.
  restart: 'unless-stopped',
  // Readiness resource-owned (`wait: true` — cùng ngữ nghĩa với platform):
  // `local-smoke` và unit/E2E kế tiếp chỉ chạy sau khi healthcheck HTTP `/`
  // của chính container này chuyển `healthy`. Trần chờ = startPeriod 30s +
  // 12 retries × 10s = 150s; waitTimeout 180s dư cho host chậm.
  wait: true,
  waitTimeout: 180,
  networksAdvanced: [{ name: networkName, aliases: ['ecoma-home'] }],
  // `envs` (không phải `environment`): `@pulumi/docker` nhận cặp `KEY=VALUE` dạng
  // mảng chuỗi — shape của `docker run -e`, không phải map như Compose.
  // Không có `ROOT_HOST`: không có consumer nào trong `apps/` đọc biến này lúc
  // runtime (grep toàn `apps/` không có hit) — nó là artifact của orchestration
  // (.env, đúng như `01-architecture.md` mô tả), tiêm vào container chỉ tạo
  // ấn tượng app dùng nó để dựng absolute URL.
  envs: [`PORT=${HOME_INTERNAL_PORT}`, 'NODE_ENV=production'],
  labels: [
    ...Object.entries(labels).map(([label, value]) => ({ label, value })),
    { label: 'traefik.enable', value: 'true' },
    {
      // Khai network của ROUTER này cho Traefik, KHÔNG phải sở thích: không có
      // label này, Docker provider của MỌI Traefik trên host (mỗi worktree một
      // Traefik) đều thấy container này qua socket dùng chung và đăng ký router
      // `Host(fbi.com)` của nó — hai worktree chỉ ra HAI router cùng rule trên
      // MỘT Traefik, và router trúng backend ở network khác thì request treo
      // vĩnh viễn (đã kiểm thực nghiệm: smoke lúc xanh lúc treo tuỳ router
      // Traefik chọn). Platform bọc lưới bằng
      // `--providers.docker.constraints=Label('traefik.docker.network', <network>)`
      // nên label này vừa chọn IP đúng network cho backend, vừa là điều kiện
      // lọc container vào router của đúng worktree.
      label: 'traefik.docker.network',
      value: networkName,
    },
    {
      label: `traefik.http.routers.${traefikPrefix(ns)}.rule`,
      value: pulumi.interpolate`Host(\`${rootHostname}\`)`,
    },
    {
      label: `traefik.http.routers.${traefikPrefix(ns)}.entrypoints`,
      value: 'websecure',
    },
    { label: `traefik.http.routers.${traefikPrefix(ns)}.tls`, value: 'true' },
    {
      label: `traefik.http.services.${traefikPrefix(ns)}.loadbalancer.server.port`,
      value: String(HOME_INTERNAL_PORT),
    },
  ],
  healthcheck: {
    // Runtime `node-server` không có health endpoint riêng, nên check bằng HTTP
    // thật tới `/`. `/` trả 302 sang `/en` — 302 là phản hồi khỏe (SSR đã sẵn
    // sàng), nên chỉ coi là hỏng khi >= 500 hoặc fetch throw.
    tests: [
      'CMD',
      'node',
      '-e',
      // Cổng lấy từ cùng hằng số với `ENV PORT` của image, không hard-code lần
      // thứ hai trong một string khác.
      `fetch('http://127.0.0.1:${HOME_INTERNAL_PORT}/')` +
        `.then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))`,
    ],
    interval: '10s',
    timeout: '5s',
    retries: 12,
    // Nuxt SSR cold start + prerender content lúc khởi động có thể vượt 30s trên
    // host chậm; chỉ sau `startPeriod` mới tính `retries`.
    startPeriod: '30s',
  },
});

export const imageDigest = image.digest;
export const containerName = home.name;
export const containerId = home.id;
/** Namespace đã khớp stack platform — xem check fail-closed ở trên. */
export const namespaceVerified = verifiedNamespace;
