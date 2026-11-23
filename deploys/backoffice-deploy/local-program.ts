/**
 * Thân chương trình Pulumi LAN LOCAL của `backoffice-deploy` — module này được
 * guard ở `index.ts` nạp QUA dynamic import CHỈ cho stack
 * `local-<namespace>` (lane local hiện hành); stack
 * `staging`/`staging-candidate` KHÔNG BAO GIỜ nạp thân này — nó khai Docker
 * resource namespace-scoped của lane local, chạy trên backend R2 staging là
 * khai resource sai environment. Thân được TÁCH NGUYÊN VĂN từ `index.ts`
 * (lane-guard port #354 theo pattern đã merge của `remote-cache-api-deploy`
 * #350 / `auth-deploy` #539) — không có thay đổi hành vi nào so với thời
 * thân nằm ngay trong entry.
 *
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
  buildMigrateScript,
  buildProvisionScript,
} from './scripts.js';
import {
  LOCAL_BACKOFFICE_CLIENT_ID,
  type PlatformOutputs,
  dockerResourceName,
  localServiceHostname,
  localServiceOrigin,
  normalizeWorktreeRoot,
  ownershipLabels,
  worktreeNamespace,
} from '@ecoma-io/deployment';

const BACKOFFICE_INTERNAL_PORT = 3000;

/**
 * Image Node pin theo DIGEST dùng cho container migrate ephemeral — cùng pin
 * với các deploy unit khác (một image Node duy nhất chạy tsx của repo).
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/**
 * Cổng HTTP nội bộ của worker `ecoma-auth` trong WIC của auth-deploy — GIÁ TRỊ
 * GHIM ở stack đó (`AUTH_INTERNAL_PORT`, nguồn số duy nhất là `dev.port` của
 * `apps/auth/wrangler.jsonc`), copy tại đây vì hai stack là hai Pulumi program
 * độc lập; lệch giá trị là connection refused ở lần fetch JWKS/token đầu tiên.
 * Alias `ecoma-<ns>-auth` + port này là đường duy nhất container Node tới được
 * auth: hostname `auth-<ns>.<rootHostname>` KHÔNG resolve được trong container
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
 * Cổng HTTP nội bộ của container `ecoma-account` của account-deploy —
 * `ACCOUNT_INTERNAL_PORT` của stack đó (Nitro `node-server` mặc định 3000, không
 * phải `dev.port` của wrangler: account ở đây là container Node, không phải WIC).
 * Giá trị này được copy vì hai stack là hai Pulumi program độc lập. Alias
 * `ecoma-account` + port này là đường duy nhất container Node backoffice tới được
 * account trên platform network (cùng lý luận `STAFF_ACCESS_INTERNAL_PORT` ở trên).
 */
const ACCOUNT_INTERNAL_PORT = 3000;

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

// Hostname/origin browser-facing theo worktree (#316) — mọi chuỗi OIDC ghim
// qua contract `@ecoma-io/deployment`, cùng nguồn với auth-deploy và các
// consumer khác; lệch một chữ giữa issuer/audience/router là token invalid.
// `rootHostname`/`traefikHostPort` là Output (StackReference) nên công thức
// apply một lần qua lambda cục bộ; helper trong lib giữ thuần string.
const serviceOrigin = (sub: string): pulumi.Output<string> =>
  pulumi
    .all([rootHostname, traefikHostPort])
    .apply(([rh, port]) => localServiceOrigin(sub, rh, ns, port));
const authOrigin = serviceOrigin('auth');
const audienceOrigin = serviceOrigin('api');
const officeHostname = rootHostname.apply((rh) => localServiceHostname('office', rh, ns));

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
 * Provision `db-backoffice` + hai role, chạy trên host qua `docker exec` vào
 * container PostgreSQL của platform (không publish host port). Migration KHÔNG
 * đi cùng provision nữa (cutover #375) — nó là container `migrate` riêng dưới.
 *
 * Idempotent: role/database guard bằng shell `if`, password ALTER idempotent.
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
const provisionScript = buildProvisionScript({ postgresContainerName });
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
    triggers: [pulumi.secret(runtimePassword), pulumi.secret(migratorPassword)],
    environment: provisionEnvironment,
  },
  { dependsOn: [image] },
);

/**
 * Migration qua **đường canonical** (cutover #375): container ephemeral trên
 * platform network chạy runner thật của `databases/backoffice-db` (wrapper
 * §3a.3 — guard `current_database()` fail-closed, advisory lock giữ nguyên khóa
 * `hashtext('db-backoffice')` của pipe cũ, `drizzle-kit migrate` atomic
 * per-run). Chuỗi `adopt && migrate`: trên stack legacy (đã có bảng schema
 * `backoffice`, chưa có history Drizzle) adopt stamp toàn bộ journal để
 * migrate KHÔNG replay; stack trắng migrate apply lần đầu; stack đã-cutover
 * adopt là no-op.
 *
 * Kênh `DATABASE_URL`: script text là ĐẦU RA của hàm thuần `buildMigrateScript`
 * (`scripts.ts`) và chỉ mang `-e DATABASE_URL` — CHỈ TÊN biến, không
 * `=giá trị` — nên URL (chứa password) không nằm trong argv của `sh -c`, của
 * `docker run`, của tsx bên trong container, hay trong script text nào. Giá trị
 * đi vào environ của tiến trình shell qua map `environment` của provider, rồi
 * docker CLI đọc từ environ của chính nó và chuyển vào container env. Trigger
 * gồm password migrator + worktreeRoot (cùng bọc secret): đổi mật khẩu là chạy
 * lại migration với credential mới.
 */
const migratorDatabaseUrl = pulumi.interpolate`postgresql://ecoma_backoffice_migrator:${pulumi.secret(migratorPassword)}@ecoma-postgres:5432/db-backoffice`;

const migrateScript = networkName.apply((net) =>
  buildMigrateScript({
    networkName: net,
    worktreeRoot,
    nodeImage: NODE_IMAGE,
  }),
);

const migrate = new command.local.Command(
  dockerResourceName(ns, 'backoffice') + '-migrate',
  {
    create: migrateScript,
    update: migrateScript,
    triggers: [pulumi.secret(migratorPassword), worktreeRoot],
    // Giá trị bọc secret: provider đặt vào environ của tiến trình script.
    environment: { DATABASE_URL: migratorDatabaseUrl },
  },
  { dependsOn: [provision] },
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
      // Issuer/audience GHIM CÙNG CHUỖI với auth-deploy: cả hai stack dựng chuỗi
      // qua cùng contract `localServiceOrigin` (`@ecoma-io/deployment`), nên phép
      // so `iss`/`aud` exact giữa token do auth mint và cấu hình verify của
      // backoffice khớp theo cấu trúc, không phải theo may mắn. Port động là
      // BẮT BUỘC trong chuỗi: browser chỉ tới được origin có port (443 không
      // listen), và oidc-provider mint `iss` từ chính chuỗi này. Trade-off
      // local-only (port đổi là issuer đổi) được ghi ở JSDoc `issuerLocal` của
      // auth-deploy — không lặp lại ở đây.
      pulumi.interpolate`NUXT_BACKOFFICE_AUTH_ISSUER=${authOrigin}`,
      pulumi.interpolate`NUXT_BACKOFFICE_AUTH_AUDIENCE=${audienceOrigin}`,
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
      // Node không resolve được hostname `staff-access-<ns>.<rootHostname>` và không đi
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
      // `ecoma-account` của container account-deploy (port 3000). Cùng lý luật
      // với
      // `NUXT_BACKOFFICE_STAFF_ACCESS_SERVICE_URL` bên trên: container Node
      // không resolve được hostname `account-<ns>.<rootHostname>` — đường duy nhất
      // là alias Docker trên platform network. Shim Nitro biến URL này thành
      // binding `ACCOUNT_SERVICE` lúc runtime, bật đường onboarding-status/
      // displayName (#242); rỗng/vắng ⇒ client fail-closed như production.
      pulumi.interpolate`NUXT_BACKOFFICE_ACCOUNT_SERVICE_URL=http://ecoma-account:${ACCOUNT_INTERNAL_PORT}`,
      // Origin fetch server-side: JWKS (`/jwks.json`) và token exchange
      // (`/token`) chạy TRONG container Node, mà container không resolve được
      // `auth-<ns>.<rootHostname>` và không đi ra host loopback được — đường duy
      // nhất là alias Docker của WIC auth trên platform network (plain HTTP;
      // TLS không có trên chặng này, cùng ngữ nghĩa service binding production).
      // Chuỗi issuer vẫn là danh tính `iss`/authorize — chỉ fetch origin đổi.
      // Production Workers KHÔNG đặt biến này (fetch qua issuer như cũ).
      pulumi.interpolate`NUXT_BACKOFFICE_AUTH_INTERNAL_ORIGIN=http://ecoma-${ns}-auth:${AUTH_INTERNAL_PORT_OF_AUTH_WIC}`,
      // Data mode `realtime` (#182): các staff pages đọc dữ liệu thật qua
      // `/api/**` (Staff Access là nguồn authorization sau mốc cutover dưới
      // đây, #241), nên lane local chạy đường adapter thật như staging
      // (`wrangler.jsonc`) thay vì fixture. Prototype vẫn tồn tại cho preview
      // UI (lane browser suite ghim riêng) nhưng không còn là mode của lane.
      `NITRO_PUBLIC_BACKOFFICE_DATA_MODE=realtime`,
      // Mốc cutover authorization (issue #241): từ mốc này projection của
      // Staff Access là nguồn quyết định permission của BFF thay cho legacy
      // `db-backoffice` rỗng (ADR-0023 Quyết định 2 — verdict do Staff Access
      // sở hữu). Giá trị GHIM do deploy layer cấp, không hard-code trong app
      // source; quyết định nguồn được ghi ở
      // `docs/features/internal-access/access-protected-staff-resources.md`.
      // Gate fail-closed: cutover bật mà projection không đọc được/quá TTL thì
      // fallback legacy kèm log (`server/read-route.ts`); preset node-server
      // nhận biến qua shim worker-env (`server/plugins/staff-access-service-shim.ts`).
      `BACKOFFICE_AUTHZ_PROJECTION_CUTOVER_AT=2026-11-14T00:00:00Z`,
    ],
    labels: [
      ...Object.entries(labels).map(([label, value]) => ({ label, value })),
      { label: 'traefik.enable', value: 'true' },
      { label: 'traefik.docker.network', value: networkName },
      {
        label: `traefik.http.routers.${traefikPrefix(ns)}.rule`,
        value: pulumi.interpolate`Host(\`${officeHostname}\`)`,
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
  // Container chỉ lên sau khi schema sẵn sàng: migrate (và gián tiếp provision
  // qua nó) — thứ tự provision → migrate → container của các deploy unit khác.
  { dependsOn: [migrate] },
);

export const imageDigest = image.digest;
export const containerName = backoffice.name;
export const containerId = backoffice.id;
export const namespaceVerified = verifiedNamespace;
