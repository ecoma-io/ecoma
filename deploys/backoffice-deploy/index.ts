/**
 * Chương trình Pulumi của `backoffice-deploy` — deploy unit của `apps/backoffice`
 * ở LAN LOCAL deployment.
 *
 * Mirror `deploys/home-deploy/index.ts` (cùng ownership labels, namespace, stack
 * reference, fail-closed). Khác biệt: router rule `Host(office.fbi.com)` và
 * image build từ `apps/backoffice` với preset `node-server`.
 *
 * Cấu hình OIDC BFF (issue #356): container nhận đủ bộ `NUXT_BACKOFFICE_AUTH_*`
 * (issuer/audience GHIM cùng chuỗi mà auth-deploy cấp cho provider qua cùng hai
 * output platform — so `iss`/`aud` exact khớp) + origin fetch nội bộ
 * `ecoma-<ns>-auth:4203` cho JWKS/token exchange, + data mode `prototype` cho
 * bề mặt UI demo. Thiếu bộ OIDC là middleware authn 503 mọi `/api/**`.
 */

import * as command from '@pulumi/command';
import * as docker from '@pulumi/docker';
import * as dockerBuild from '@pulumi/docker-build';
import * as pulumi from '@pulumi/pulumi';

import {
  MIGRATOR_PASSWORD_ENV_VAR,
  RUNTIME_PASSWORD_ENV_VAR,
  buildProvisionScript,
} from './scripts.js';
import {
  LOCAL_BACKOFFICE_CLIENT_ID,
  type PlatformOutputs,
  dockerResourceName,
  normalizeWorktreeRoot,
  ownershipLabels,
  worktreeNamespace,
} from '@ecoma-io/deployment';

const BACKOFFICE_INTERNAL_PORT = 3000;

/**
 * Cổng HTTP nội bộ của worker `ecoma-auth` trong WIC của auth-deploy — GIÁ TRỊ
 * GHIM ở stack đó (`AUTH_INTERNAL_PORT`, nguồn số duy nhất là `dev.port` của
 * `apps/auth/wrangler.jsonc`), copy tại đây vì hai stack là hai Pulumi program
 * độc lập; lệch giá trị là connection refused ở lần fetch JWKS/token đầu tiên.
 * Alias `ecoma-<ns>-auth` + port này là đường duy nhất container Node tới được
 * auth: hostname `auth.<rootHostname>` KHÔNG resolve được trong container
 * (không có /etc/hosts entry) và host port của Traefik chỉ bind 127.0.0.1 trên
 * host — cùng pattern `AUTH_INTERNAL_PORT_OF_AUTH_WIC` mà account-deploy dùng
 * cho `NUXT_AUTH_SERVICE_URL`.
 */
const AUTH_INTERNAL_PORT_OF_AUTH_WIC = 4203;

/**
 * Cổng HTTP nội bộ của worker `ecoma-staff-access` trong WIC của staff-access-deploy
 * — `dev.port` của `apps/staff-access/wrangler.jsonc`. Giá trị này được copy vì hai
 * stack là hai Pulumi program độc lập.
 */
const STAFF_ACCESS_INTERNAL_PORT = 4206;

/**
 * Cổng HTTP nội bộ của container `ecoma-account` của account-deploy — `dev.port`
 * của `apps/account/wrangler.jsonc`. Giá trị này được copy vì hai stack là hai
 * Pulumi program độc lập. Alias `ecoma-account` + port này là đường duy nhất
 * container Node backoffice tới được account trên platform network (cùng lý
 * luận `STAFF_ACCESS_INTERNAL_PORT` ở trên).
 */
const ACCOUNT_INTERNAL_PORT = 4202;

const traefikPrefix = (ns: string): string => `backoffice-${ns}`;

const conf = new pulumi.Config('namespace');

const worktreeRoot = conf.require('worktreeRoot');
const ns = worktreeNamespace(worktreeRoot);

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

// Secret `internalHmacSecret` sinh bởi staff-access-deploy (envelope HMAC
// staff-access ↔ backoffice). Đọc lại từ stack config của staff-access-deploy
// (cùng pattern auth-deploy đọc `internalHmacSecret` từ account-deploy stack).
// Giá trị được `local.ts` đọc từ staff-access-deploy stack config và persist
// vào stack config của backoffice-deploy, nên `index.ts` chỉ cần `conf.require`.
// Vắng ⇒ backoffice container không gắn AUTH_INTERNAL_SECRET ⇒ staff-access
// client fail-closed 503 mọi `/api/staff`/`/api/roles`/`/api/permissions`.
const internalHmacSecret = conf.require('internalHmacSecret');

// Secret HMAC internal của cặp backoffice ↔ account — ĐỌC LẠI từ stack config
// của account-deploy (cùng pattern `internalHmacSecret` bên trên, và cùng
// pattern auth-deploy đọc `internalSecret` từ account-deploy). Đây là giá trị
// KHÁC `internalHmacSecret` bên trên: mỗi stack deploy sinh secret nội bộ độc
// lập, và account verify envelope bằng `internalHmacSecret` của CHÍNH stack
// account (`NUXT_INTERNAL_HMAC_SECRET` của container account). Client account
// của backoffice (`accountClientConfig`) đọc biến `ACCOUNT_INTERNAL_SECRET`;
// shim Nitro (`server/plugins/account-service-shim.ts`) nạp nó vào env theo
// từng request. Vắng ⇒ shim không nạp secret ⇒ client fail-closed `null` ⇒
// `/api/onboarding-status` 503, `/api/me` `displayName: null`.
const accountInternalHmacSecret = conf.require('accountInternalHmacSecret');

// Mật khẩu hai role local — do orchestration sinh và truyền qua --config
// (stdin, không argv); `requireSecret` để giá trị luôn là Output được đánh dấu
// secret, bọc `pulumi.secret` lần nữa ở nơi tiêu thụ (trigger/environment).
const runtimePassword = conf.requireSecret('runtimePassword');
const migratorPassword = conf.requireSecret('migratorPassword');

// Connection string runtime (role ecoma_backoffice_runtime) qua network nội bộ.
const backofficeDatabaseUrl = pulumi.interpolate`postgresql://ecoma_backoffice_runtime:${pulumi.secret(runtimePassword)}@ecoma-postgres:5432/db-backoffice`;

const verifiedNamespace = pulumi.output(platformNamespace).apply((upstreamNs) => {
  if (upstreamNs !== ns) {
    throw new Error(
      `platformStackRef points to a stack of a different namespace: platform exports "${upstreamNs}" while this worktree is "${ns}".`,
    );
  }
  return ns;
});

const imageTag = `ecoma-backoffice-${ns}:local`;

const image = new dockerBuild.Image(dockerResourceName(ns, 'backoffice-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/backoffice-deploy/Dockerfile` },
  tags: [imageTag],
  builder: { name: 'default' },
  load: true,
  push: false,
  labels,
});

/**
 * Provision `db-backoffice` + hai role + migration, chạy trên host qua `docker exec`
 * vào container PostgreSQL của platform (không publish host port).
 *
 * Idempotent: mỗi câu SQL guard bằng `IF NOT EXISTS`/`\gexec`. Chạy cả
 * `create` và `update` để redeploy cũng áp migration mới.
 *
 * Kênh credential: script do `scripts.ts` dựng (hàm thuần, test được tĩnh) —
 * mật khẩu hai role đi vào tiến trình shell qua map `environment` của command
 * resource (giá trị bọc `pulumi.secret`), script chỉ đọc bằng TÊN biến
 * (`BACKOFFICE_PW_*`); SQL mật khẩu nạp vào psql qua STDIN của `docker exec -i`.
 * Command text và argv không chứa credential nào. Phạm vi: kênh `environment`
 * chỉ cách ly argv của process host — KHÔNG bảo vệ trước việc xem process
 * environment ở tầng host.
 */
const postgresContainerName = dockerResourceName(ns, 'postgres');
const provisionScript = buildProvisionScript({ postgresContainerName, worktreeRoot });
// Map môi trường của provision — MỌI giá trị secret được bọc `pulumi.secret`:
// state/diff chỉ thấy `[secret]`, và key khớp đúng TÊN biến mà script đọc.
const provisionEnvironment = {
  [MIGRATOR_PASSWORD_ENV_VAR]: pulumi.secret(migratorPassword),
  [RUNTIME_PASSWORD_ENV_VAR]: pulumi.secret(runtimePassword),
};

const provision = new command.local.Command(
  dockerResourceName(ns, 'backoffice') + '-provision',
  {
    create: provisionScript,
    update: provisionScript,
    // Trigger vẫn đổi khi password đổi, nhưng giá trị được `pulumi.secret` bọc —
    // state/diff chỉ thấy `[secret]`, không bao giờ thấy mật khẩu plaintext
    // (trigger được lưu trong state Pulumi).
    triggers: [pulumi.secret(runtimePassword), pulumi.secret(migratorPassword), worktreeRoot],
    environment: provisionEnvironment,
  },
  { dependsOn: [image] },
);

const backoffice = new docker.Container(
  dockerResourceName(ns, 'backoffice'),
  {
    name: dockerResourceName(ns, 'backoffice'),
    image: pulumi.interpolate`${imageTag}@${image.digest}`,
    restart: 'unless-stopped',
    // Readiness resource-owned (`wait: true` — cùng ngữ nghĩa với platform):
    // unit kế tiếp (auth đọc secret account; E2E qua globalSetup) chỉ chạy
    // sau khi healthcheck `/health` của container chuyển `healthy`. Trần chờ
    // = startPeriod 30s + 12 retries × 10s = 150s; waitTimeout 180s dư.
    wait: true,
    waitTimeout: 180,
    networksAdvanced: [{ name: networkName, aliases: ['ecoma-backoffice'] }],
    envs: [
      `PORT=${BACKOFFICE_INTERNAL_PORT}`,
      'NODE_ENV=production',
      pulumi.interpolate`NITRO_BACKOFFICE_DATABASE_URL=${backofficeDatabaseUrl}`,
      // Ba biến OIDC (ADR-0012) — thiếu MỘT biến là middleware authn 503 cho
      // mọi `/api/**` (fail-closed, `server/auth/config.ts` trả `null`).
      //
      // Issuer/audience GHIM CÙNG CHUỖI với auth-deploy: cả hai stack dựng từ
      // cùng hai output platform (`rootHostname` + `traefikHostPort`), nên phép
      // so `iss`/`aud` exact giữa token do auth mint và cấu hình verify của
      // backoffice khớp theo cấu trúc, không phải theo may mắn. Port động là
      // BẮT BUỘC trong chuỗi: browser chỉ tới được origin có port (443 không
      // listen), và oidc-provider mint `iss` từ chính chuỗi này. Trade-off
      // local-only (port đổi là issuer đổi) được ghi ở JSDoc `issuerLocal` của
      // auth-deploy — không lặp lại ở đây.
      pulumi.interpolate`NUXT_BACKOFFICE_AUTH_ISSUER=https://auth.${rootHostname}:${traefikHostPort}`,
      pulumi.interpolate`NUXT_BACKOFFICE_AUTH_AUDIENCE=https://api.${rootHostname}:${traefikHostPort}`,
      // client_id public đã seed bên auth-deploy — MỘT nguồn sự thật trong
      // `local-auth-contract`, hai stack import cùng hằng; lệch giá trị là
      // authorize `invalid_client` nên không copy chuỗi.
      `NUXT_BACKOFFICE_AUTH_CLIENT_ID=${LOCAL_BACKOFFICE_CLIENT_ID}`,
      // Secret HMAC envelope dùng chung staff-access ↔ backoffice — đọc lại từ
      // stack config của staff-access-deploy (cùng pattern account-deploy → auth-deploy).
      // staff-access client của ba route `/api/staff`, `/api/roles`, `/api/permissions`
      // cần binding `STAFF_ACCESS_SERVICE` + secret này để ký envelope; thiếu biến
      // là client trả `null` ⇒ route fail-closed `503`.
      pulumi.interpolate`AUTH_INTERNAL_SECRET=${pulumi.secret(internalHmacSecret)}`,
      // Origin fetch server-side tới staff-access qua alias DNS nội bộ
      // `ecoma-staff-access` của WIC staff-access-deploy (port 4206). Container
      // Node không resolve được hostname `staff-access.<rootHostname>` và không đi
      // ra host loopback được — đường duy nhất là alias Docker trên platform network.
      // Shim Nitro trong backoffice biến URL này thành binding `STAFF_ACCESS_SERVICE`
      // lúc runtime (xem `server/plugins/staff-access-service-shim.ts`).
      pulumi.interpolate`NUXT_BACKOFFICE_STAFF_ACCESS_SERVICE_URL=http://ecoma-staff-access:${STAFF_ACCESS_INTERNAL_PORT}`,
      // Secret HMAC nội bộ của cặp backoffice ↔ account — giá trị khác
      // `AUTH_INTERNAL_SECRET` bên trên (cặp staff-access); xem JSDoc
      // `accountInternalHmacSecret`. Shim Nitro
      // (`server/plugins/account-service-shim.ts`) nạp biến này vào env theo
      // từng request để `accountClientConfig` ký envelope đúng khoá mà
      // account verify.
      pulumi.interpolate`ACCOUNT_INTERNAL_SECRET=${pulumi.secret(accountInternalHmacSecret)}`,
      // Origin fetch server-side tới account qua alias DNS nội bộ
      // `ecoma-account` của WIC account-deploy (port 4202). Cùng lý luật với
      // `NUXT_BACKOFFICE_STAFF_ACCESS_SERVICE_URL` bên trên: container Node
      // không resolve được hostname `account.<rootHostname>` — đường duy nhất
      // là alias Docker trên platform network. Shim Nitro biến URL này thành
      // binding `ACCOUNT_SERVICE` lúc runtime, bật đường onboarding-status/
      // displayName (#242); rỗng/vắng ⇒ client fail-closed như production.
      pulumi.interpolate`NUXT_BACKOFFICE_ACCOUNT_SERVICE_URL=http://ecoma-account:${ACCOUNT_INTERNAL_PORT}`,
      // Origin fetch server-side: JWKS (`/jwks.json`) và token exchange
      // (`/token`) chạy TRONG container Node, mà container không resolve được
      // `auth.<rootHostname>` và không đi ra host loopback được — đường duy
      // nhất là alias Docker của WIC auth trên platform network (plain HTTP;
      // TLS không có trên chặng này, cùng ngữ nghĩa service binding production).
      // Chuỗi issuer vẫn là danh tính `iss`/authorize — chỉ fetch origin đổi.
      // Production Workers KHÔNG đặt biến này (fetch qua issuer như cũ).
      pulumi.interpolate`NUXT_BACKOFFICE_AUTH_INTERNAL_ORIGIN=http://ecoma-${ns}-auth:${AUTH_INTERNAL_PORT_OF_AUTH_WIC}`,
      // Data mode `prototype` — bảng adapter của app chỉ có hai factory:
      // `prototype` (fixture client-side) và unavailable; chưa có mode UI nào
      // đọc DB thật, còn `/api/**` phục vụ dữ liệu DB thật độc lập với mode
      // này. `disabled` là app vào trạng thái "không khả dụng" vô ích trên
      // local. Staging ghim cùng giá trị cùng lý do (`wrangler.jsonc`).
      `NITRO_PUBLIC_BACKOFFICE_DATA_MODE=prototype`,
    ],
    labels: [
      ...Object.entries(labels).map(([label, value]) => ({ label, value })),
      { label: 'traefik.enable', value: 'true' },
      { label: 'traefik.docker.network', value: networkName },
      {
        label: `traefik.http.routers.${traefikPrefix(ns)}.rule`,
        value: pulumi.interpolate`Host(\`office.${rootHostname}\`)`,
      },
      {
        label: `traefik.http.routers.${traefikPrefix(ns)}.entrypoints`,
        value: 'websecure',
      },
      { label: `traefik.http.routers.${traefikPrefix(ns)}.tls`, value: 'true' },
      {
        label: `traefik.http.services.${traefikPrefix(ns)}.loadbalancer.server.port`,
        value: String(BACKOFFICE_INTERNAL_PORT),
      },
    ],
    healthcheck: {
      tests: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${BACKOFFICE_INTERNAL_PORT}/health')` +
          `.then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))`,
      ],
      interval: '10s',
      timeout: '5s',
      retries: 12,
      startPeriod: '30s',
    },
  },
  { dependsOn: [provision] },
);

export const imageDigest = image.digest;
export const containerName = backoffice.name;
export const containerId = backoffice.id;
export const namespaceVerified = verifiedNamespace;
