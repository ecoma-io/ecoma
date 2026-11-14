/**
 * Chương trình Pulumi của `auth-deploy` — deploy unit của `apps/auth`
 * (identity/auth) ở LAN LOCAL deployment.
 *
 * PR database isolation (issue #181): stack này provision `db-auth` + bộ 4 role
 * chuẩn (owner/migrator/runtime/pruner) trên PostgreSQL của platform, chạy
 * migration qua **đường canonical** (`apps/auth/db/apply.mts` — advisory lock
 * `hashtext('db-auth')`, history `auth.schema_migrations`, checksum), rồi seed
 * client public `backoffice` cho lane local (issue #194 — seed per-environment
 * vì redirect URI exact-match phải mang port động của platform).
 *
 * PR Worker runtime (issue #183): dựng WIC container (worker-in-container) —
 * image mỏng ghim `node:24-bookworm-slim` + `ca-certificates` (PF2), chứa
 * HAI process `wrangler dev` theo `wic-entrypoint.sh`: worker `ecoma-auth`
 * (port nội bộ 4203) và shim `ecoma-account-bridge` (port nội bộ 4204).
 * Repo mount READ-ONLY là KHÔNG đủ để chạy wrangler dev: nó ghi bundle tạm
 * (`getWranglerTmpDir` hard-code `<projectRoot>/.wrangler/tmp`), cache
 * `Request.cf` của miniflare (`node_modules/.mf`) và registry dev registry
 * theo đường dưới repo — mở lỗ rw trên repo RO thì mount rw-point fail ở
 * runc (mkdirat trên EROFS), symlink cũng EROFS. Nên entrypoint dựng
 * **runtime tree mirror** ghi được dưới `$PERSIST_DIR/runtime` (copy
 * `wrangler.jsonc` + `dist`, symlink `node_modules` hai tầng) và chạy
 * wrangler từ đó. Secrets đi qua `envs` của container (kênh
 * container env — không argv, không label, không log), `pulumi.secret` bọc
 * trước khi interpolate để redact trong diff/log. Traefik route
 * `Host(auth.<rootHostname>)` theo bảng hostname của `02-account-auth.md`; router
 * đọc HTTP từ workerd (workerd chỉ nghe plain HTTP — TLS do Traefik chấm dứt
 * phía trước, cùng model home/backoffice; `x-forwarded-proto` được bridge
 * provider ghi lại từ URL scheme của request Worker, runtime.ts).
 * Readiness qua `GET /ready` của auth — probe CHẠM DB thật + binding
 * ACCOUNT_SERVICE; `/health` 200 không phải bằng chứng readiness.
 *
 * Mirror `deploys/backoffice-deploy/index.ts` (cùng ownership labels, namespace,
 * stack reference, fail-closed, `command.local.Command` + `docker exec` psql qua
 * trust auth trong container — platform không publish host port nên host không
 * kết nối được container bằng TCP).
 *
 * Khác account stack ở đúng MỘT điểm ownership: role `ecoma_owner` là role dùng
 * chung hai DB, và **account stack sở hữu password của nó** — stack này
 * guard-create khi thiếu nhưng KHÔNG BAO GIỜ `ALTER ROLE ecoma_owner PASSWORD`
 * (hai stack cùng ALTER một password là race xoá mật khẩu nhau). SQL
 * provisioning theo `docs/applications/auth/03-operations.md` §3.1/§3.2 và
 * `apps/auth/migrations/README.md` §"Vai trò của operator": revoke chéo điều
 * kiện hoá theo `pg_database` (REVOKE trên database không tồn tại là lỗi),
 * PUBLIC trước per-role sau.
 */

import * as crypto from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import * as command from '@pulumi/command';
import * as docker from '@pulumi/docker';
import * as dockerBuild from '@pulumi/docker-build';
import * as pulumi from '@pulumi/pulumi';

import {
  LABEL_PREFIX,
  LOCAL_BACKOFFICE_CLIENT_ID,
  type PlatformOutputs,
  dockerResourceName,
  normalizeWorktreeRoot,
  ownershipLabels,
  shellQuote,
  sqlQuote,
  worktreeNamespace,
} from '@ecoma-io/deployment';

import { LOCAL_PACT_BROKER_CLIENT_ID, LOCAL_PACT_BROKER_CLIENT_NAME } from './local-clients.js';

import {
  MIGRATOR_PASSWORD_ENV_VAR,
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
 * container (platform facts PF5), nên `pg` của runner chỉ kết nối được từ bên
 * trong platform network. Container ephemeral chạy **tsx binary của repo** vẫn
 * là đúng một đường code canonical (`applyAllMigrations` của
 * `apps/auth/db/apply.mts`) — deploy không tự viết lại vòng migration.
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/** Alias DNS của PostgreSQL platform trong network nội bộ. */
const POSTGRES_HOST = 'ecoma-postgres';

/**
 * Cổng HTTP nội bộ của worker `ecoma-auth` trong WIC — `dev.port` của
 * `apps/auth/wrangler.jsonc`. Bên trong container KHÔNG cần phát hiện xung đột
 * port host (mỗi container có network stack riêng — static port an toàn);
 * khác với đường `local-worker-up` trên host vốn cấp phát động theo namespace.
 */
const AUTH_INTERNAL_PORT = 4203;

/**
 * Cổng HTTP nội bộ của shim `ecoma-account-bridge` trong WIC — `dev.port` của
 * `tools/account-bridge/wrangler.jsonc`. Không publish ra ngoài container:
 * traffic duy nhất đi vào là service binding từ auth (dev registry nội bộ
 * container) và probe liveness nội bộ — hằng này chỉ là tham chiếu tài liệu;
 * entrypoint không nhận port từ Pulumi (nguồn số duy nhất là wrangler.jsonc).
 */
const BRIDGE_INTERNAL_PORT_DOC = 4204;
void BRIDGE_INTERNAL_PORT_DOC;

/** Alias DNS của WIC container trong platform network — namespace theo worktree. */
const AUTH_WIC_ALIAS_PREFIX = 'ecoma-';

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

// Mật khẩu ba role của db-auth — do orchestration sinh và truyền qua --config
// (stdin, không argv). KHÔNG có ownerPassword ở đây: password của `ecoma_owner`
// thuộc về account stack (xem JSDoc đầu file).
const runtimePassword = conf.require('runtimePassword');
const migratorPassword = conf.require('migratorPassword');
const prunerPassword = conf.require('prunerPassword');

// Secrets Worker của auth (PR Worker runtime #183) — cùng kênh `--config`
// (stdin) như mật khẩu role; entry up của chính stack này sinh và set, stack
// này đọc. Thiếu key là fail ngay lúc `pulumi up` (`conf.require`) chứ không
// container với secret rỗng. `internalSecret` PHẢI bằng giá trị mà account
// stack nhận làm `NUXT_INTERNAL_HMAC_SECRET` (cùng envelope HMAC
// `ecoma-internal-v1` hai chiều) — bất biến hai-stack được giữ ở tầng entry:
// sinh MỘT giá trị rồi set cho CẢ HAI stack.
const signingKeyPem = conf.require('signingKeyPem');
const signingKeyId = conf.require('signingKeyId');
const handleKey = conf.require('handleKey');
const internalSecret = conf.require('internalSecret');
const cookieKeys = conf.require('cookieKeys');

const verifiedNamespace = pulumi.output(platformNamespace).apply((upstreamNs) => {
  if (upstreamNs !== ns) {
    throw new Error(
      `platformStackRef points to a stack of a different namespace: platform exports "${upstreamNs}" but this worktree is "${ns}".`,
    );
  }
  return ns;
});

/**
 * Provision `db-auth` + 3 role riêng + cross-DB revokes, chạy trên host qua
 * `docker exec` vào container PostgreSQL của platform. Idempotent như
 * account-deploy; khác ở: guard-create `ecoma_owner` khi thiếu (không ALTER),
 * và chiều revoke chéo ngắm vào `db-account`.
 *
 * Kênh mật khẩu: script text là ĐẦU RA của hàm thuần `buildProvisionScript`
 * (`scripts.ts`) và KHÔNG chứa giá trị secret nào. Mật khẩu ba role đi vào
 * tiến trình shell qua map `environment` của `command.local.Command` (dưới —
 * giá trị bọc `pulumi.secret`), script chỉ đọc TÊN biến môi trường, dựng SQL
 * `ALTER ROLE ... PASSWORD` trong shell và nạp psql qua **STDIN** của
 * `docker exec -i` (không `-c`): giá trị không nằm trong argv của `sh -c`, của
 * `docker exec`, của `psql`, cũng như trong `create`/`update` (plain input)
 * mà Pulumi lưu trong state. Kênh `environment` chỉ cô lập argv — KHÔNG claim
 * bảo vệ trước việc xem process environment ở tầng host. Đổi hàm build hay
 * đổi kênh truyền phải qua test argv-hygiene (`tests/integrations/`) — nó chạy
 * đúng script text này.
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
  [MIGRATOR_PASSWORD_ENV_VAR]: pulumi.secret(migratorPassword),
  [RUNTIME_PASSWORD_ENV_VAR]: pulumi.secret(runtimePassword),
  [PRUNER_PASSWORD_ENV_VAR]: pulumi.secret(prunerPassword),
};

const provision = new command.local.Command(dockerResourceName(ns, 'auth') + '-provision', {
  create: provisionScript,
  update: provisionScript,
  // Trigger gồm CẢ BA mật khẩu (bọc pulumi.secret — trigger nằm trong state
  // Pulumi, không plaintext): đổi bất kỳ mật khẩu nào là provision chạy lại
  // và áp lại toàn bộ.
  triggers: [
    pulumi.secret(runtimePassword),
    pulumi.secret(migratorPassword),
    pulumi.secret(prunerPassword),
    worktreeRoot,
  ],
  environment: provisionEnvironment,
});

/**
 * Migration qua **đường canonical**: container ephemeral trên platform network
 * chạy đúng `tsx db/apply.mts` của repo (`apps/auth/db/apply.mts` — advisory
 * lock `hashtext('db-auth')`, history `auth.schema_migrations`, checksum
 * drift-abort, thứ tự tên file). Repo mount read-only.
 *
 * Kênh `DATABASE_URL`: script text là ĐẦU RA của hàm thuần `buildMigrateScript`
 * (`scripts.ts`) và chỉ mang `-e DATABASE_URL` — CHỈ TÊN biến, không
 * `=giá trị` — nên URL (chứa password) không nằm trong argv của `sh -c`, của
 * `docker run`, của tsx bên trong container, hay trong script text nào. Giá trị
 * đi vào environ của tiến trình shell qua map `environment` của provider (dưới
 * — bọc `pulumi.secret`), rồi docker CLI đọc từ environ của chính nó và chuyển
 * vào container env. Trigger gồm password migrator + worktreeRoot (cùng bọc
 * secret): đổi mật khẩu là chạy lại migration với credential mới.
 */
const migratorDatabaseUrl = pulumi.interpolate`postgresql://ecoma_auth_migrator:${pulumi.secret(migratorPassword)}@${POSTGRES_HOST}:5432/db-auth`;

const migrateScript = networkName.apply((net) =>
  buildMigrateScript({
    networkName: net,
    worktreeRoot,
    nodeImage: NODE_IMAGE,
  }),
);

const migrate = new command.local.Command(
  dockerResourceName(ns, 'auth') + '-migrate',
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
 * Redirect URI đăng ký cho client backoffice local: callback BFF là thành phần
 * path cố định `/api/auth/callback` của chính app backoffice
 * (`apps/backoffice/server/api/auth/login.get.ts` — `callbackRedirectUri` ghép
 * header `Host` của request với path này), nên URI đăng ký là
 * `https://office.<rootHostname>:<traefikHostPort>/api/auth/callback` — đúng
 * origin Traefik serve (`office.<rootHostname>`, cùng bảng hostname của
 * `02-account-auth.md`). So khớp ở `auth` là exact string, và `Host` mà browser
 * gửi luôn mang port (`fbi.com:<port>` — port là một phần của URL client,
 * Traefik vẫn match rule `Host(office.fbi.com)` không port) — bỏ port là
 * exact-match fail ở bước authorize. URI theo output platform là cách duy nhất
 * khớp exact-match mà không seed dải port đoán trước.
 */
const redirectUriLocal = pulumi.interpolate`https://office.${rootHostname}:${traefikHostPort}/api/auth/callback`;

/**
 * Redirect URI của client `pact-broker-app` — callback BFF của
 * `pact-broker-app` (route `/api/auth/callback`, ADR-0031 §4). Cùng luật port
 * động + exact-match với `redirectUriLocal` phía trên; origin ghim này phải
 * khớp origin Traefik route `Host(pact.<rootHostname>)` của unit pact-app.
 */
const redirectUriPactLocal = pulumi.interpolate`https://pact.${rootHostname}:${traefikHostPort}/api/auth/callback`;

/**
 * Seed client public `backoffice` cho authorize endpoint sống lại trên local
 * (issue #194, phần local): `oauth_clients` rỗng là `createProvider` ném lúc
 * dựng provider — mọi `/authorize` 500 trong khi `/ready` vẫn xanh.
 *
 * ⚠️ Vì sao seed ở deploy program mà KHÔNG phải migration `apps/auth/migrations/`:
 * redirect URI được so **exact string** (`client_redirect_uris`, FR-002), và
 * origin thật của callback BFF trên local là `https://office.<rootHostname>` với
 * `<rootHostname>` mang port Docker cấp động lúc create (`buildRootHost` — port
 * chỉ có SAU khi platform up). Migration là tài sản dùng chung mọi môi trường,
 * không thể mang một URI theo môi trường — đường đúng là seed per-environment
 * thuộc deployment, cùng pattern seed machine token của `pact-broker-api-deploy`
 * (#238). Phần staging/production + audience riêng cho backoffice là việc còn
 * lại của #194, không thuộc PR này.
 *
 * ⚠️ Hình dạng client theo `provider.ts` (`loadStaticClients` chỉ nạp client
 * `active` + `public` + có ít nhất một redirect URI) và CHECK của migration
 * `0001` (public ⇒ `client_secret_hash` IS NULL — client public không secret).
 * `subject_type` mặc định `public` của schema không được ghi đè. PKCE S256,
 * `token_endpoint_auth_method: 'none'` và `id_token_signed_response_alg:
 * 'ES256'` do `toProviderClientMetadata` ghim cho MỌI client load từ db —
 * seed không (và không thể) khai lại ở row.
 *
 * Idempotent:
 * - Client: `ON CONFLICT (client_id) DO UPDATE SET allowed_scopes` — đồng bộ
 *   lại ceiling scope nếu nó đổi giữa các lần deploy; `DO NOTHING` làm mất
 *   row trả về của chính row đích, còn `DO UPDATE` luôn trả row như pattern
 *   CTE của `pact-broker-api-deploy`.
 * - Redirect URI: `ON CONFLICT DO NOTHING` (PK `(client_id, redirect_uri)`)
 *   — thêm URI mới khi port đổi; URI của port cũ vẫn còn trong bảng (vô hại,
 *   origin cũ không còn router nào trỏ về) và down platform xoá volume là
 *   đường dọn sạch chính thức.
 *
 * Chạy bằng role **migrator** qua `docker exec` trust auth trong container
 * PostgreSQL (cùng đường với provision script phía trên — platform không
 * publish host port nên host không kết nối được container bằng TCP).
 *
 * Trigger gồm `rootHostname` + `traefikHostPort`: port động đổi là platform
 * redeploy → URI mới phải được seed; hai giá trị còn lại là hằng compile-time.
 *
 * #206 (ADR-0031 §4) seed thêm client public thứ hai `pact-broker-app` trong
 * CÙNG script idempotent — BFF của pact-broker-app chạy authorization-code +
 * PKCE với scope `openid offline_access`, redirect URI callback
 * `/api/auth/callback` trên origin `https://pact.<rootHostname>:<port>`. Cùng
 * idempotency hai mệnh đề với backoffice; `client_id` sống ở
 * `./local-clients.ts` và được `pact-broker-app-deploy` đọc cross-stack qua
 * stack config `namespace:pactBrokerAppClientId`.
 *
 * `redirectUriLocal` là Output (StackReference) nên câu SQL dựng bằng
 * `pulumi.interpolate` và được quote theo đúng hai lớp: `sqlQuote` cho string
 * literal SQL (qua `.apply`), `shellQuote` cho argument của shell.
 */
const seedSql = pulumi.interpolate`INSERT INTO auth.oauth_clients (client_id, client_name, client_type, allowed_scopes)
VALUES (${sqlQuote(LOCAL_BACKOFFICE_CLIENT_ID)}, 'Backoffice (local)', 'public',
        ARRAY['openid', 'offline_access']::text[])
ON CONFLICT (client_id) DO UPDATE SET allowed_scopes = EXCLUDED.allowed_scopes;
INSERT INTO auth.client_redirect_uris (client_id, redirect_uri)
VALUES (${sqlQuote(LOCAL_BACKOFFICE_CLIENT_ID)}, ${redirectUriLocal.apply(sqlQuote)})
ON CONFLICT DO NOTHING;
INSERT INTO auth.oauth_clients (client_id, client_name, client_type, allowed_scopes)
VALUES (${sqlQuote(LOCAL_PACT_BROKER_CLIENT_ID)}, ${sqlQuote(LOCAL_PACT_BROKER_CLIENT_NAME)}, 'public',
        ARRAY['openid', 'offline_access']::text[])
ON CONFLICT (client_id) DO UPDATE SET allowed_scopes = EXCLUDED.allowed_scopes;
INSERT INTO auth.client_redirect_uris (client_id, redirect_uri)
VALUES (${sqlQuote(LOCAL_PACT_BROKER_CLIENT_ID)}, ${redirectUriPactLocal.apply(sqlQuote)})
ON CONFLICT DO NOTHING;`;

const seedScript = pulumi.interpolate`set -e
PG=${postgresContainerName}
docker exec "$PG" psql -U ecoma_auth_migrator -d db-auth -v ON_ERROR_STOP=1 -c ${seedSql.apply(shellQuote)}
`;

const seed = new command.local.Command(
  dockerResourceName(ns, 'auth') + '-seed',
  {
    create: seedScript,
    update: seedScript,
    triggers: [rootHostname, traefikHostPort, worktreeRoot],
  },
  { dependsOn: [migrate] },
);

/**
 * Image WIC — image MỎNG: chỉ image Node pin + `ca-certificates` (PF2) +
 * entrypoint script. KHÔNG build gì bên trong: repo (kèm bundle `dist/` đã
 * build từ target `build` của Nx trên host) được mount lúc runtime, và
 * `wrangler dev` chạy từ mount đó. Khác account image (multi-stage build
 * `nuxt build` trong Docker) vì auth runtime là `wrangler dev`, không phải
 * process Node đóng gói — image chỉ là "phòng chạy".
 */
const wicImageTag = dockerResourceName(ns, 'auth-wic') + ':local';
const wicImage = new dockerBuild.Image(dockerResourceName(ns, 'auth-wic-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/auth-deploy/Dockerfile` },
  tags: [wicImageTag],
  builder: { name: 'default' },
  load: true,
  push: false,
  labels,
});

/**
 * Connection string Hyperdrive local của auth (PF3/PF4): role runtime, host
 * alias `ecoma-postgres` của platform network, `sslmode=disable` — miniflare
 * bỏ proxy TLS và workerd dial thẳng host:port. `pulumi.secret` bọc TRƯỚC
 * interpolate (redact trong diff/log); giá trị đi vào container qua kênh
 * `envs` — không argv, không label, không log.
 */
const hyperdriveLocalConnectionString = pulumi.interpolate`postgresql://ecoma_auth_runtime:${pulumi.secret(runtimePassword)}@${POSTGRES_HOST}:5432/db-auth?sslmode=disable`;

/**
 * Cặp AUTH_ISSUER/AUTH_AUDIENCE giá trị local: issuer là origin HTTPS mà
 * Traefik serve (`auth.<rootHostname>:<traefikHostPort>`) — provider khởi tạo
 * với ĐÚNG origin này (resume URL, JWKS `iss`, cookies scope đều quy về origin
 * ấy, xem `oidc-fullflow.spec.ts` §bootProvider); audience là resource
 * indicator chỉ cần nhất quán trong local (config requireSecret, không
 * syntax-check).
 *
 * ⚠️ Vì sao issuer PHẢI mang port động: bốn mối quan hệ cùng quy về chuỗi này.
 *
 * (a) **Browser flows cần port trong URL** — port 443 KHÔNG listen trên host
 *     (Traefik chỉ publish MỘT host port động, bind 127.0.0.1); mọi URL browser
 *     dùng (`/authorize` redirect, discovery, JWKS) đều đi qua
 *     `https://auth.<host>:<port>`. Issuer thiếu port là browser bị redirect về
 *     một origin không tồn tại.
 *
 * (b) **oidc-provider mint `iss` từ hằng này** (`AUTH_ISSUER` → `config.issuer`)
 *     — verifier phía `backoffice` cấu hình ĐÚNG chuỗi (cùng output
 *     `rootHostname`/`traefikHostPort` qua `NUXT_BACKOFFICE_AUTH_*`) thì phép so
 *     `iss` exact khớp. Hai bên lệch một chữ (thiếu port) là mọi token `invalid`.
 *
 * (c) **Traefik match `Host()` bỏ qua port** — rule `Host(auth.<rootHostname>)`
 *     không đổi; port của Host header không tham gia so khớp, nên routing chưa
 *     cần biết issuer có port.
 *
 * (d) **Trade-off local-only**: port động đổi qua lần recreate platform là
 *     issuer đổi — token đã mint theo issuer cũ hết hiệu lực (verify fail
 *     `iss`), chấp nhận được ở local; KHÔNG phải pattern cho staging/production
 *     (issuer production là origin ổn định không port). Cùng hệ quả với
 *     redirect URI đã seed: port mới là URI mới, URI cũ vô hại còn trong bảng.
 */
const issuerLocal = pulumi.interpolate`https://auth.${rootHostname}:${traefikHostPort}`;
const audienceLocal = pulumi.interpolate`https://api.${rootHostname}:${traefikHostPort}`;

/**
 * Volume RW duy nhất của WIC: state wrangler (`--persist-to` của HAI worker —
 * D1/KV/queue local của workerd, dev registry chia sẻ cho service binding,
 * HOME/XDG cô lập của wrangler). KHÔNG nằm trong repo mount (read-only) —
 * workerd ghi state runtime liên tục; dữ liệu này là EPHEMERAL theo thiết kế
 * (cache local runtime, không phải dữ liệu developer) nên volume không
 * `retainOnDelete` và KHÔNG được liệt kê là dữ liệu persistent nào.
 */
const wicStateVolumeName = dockerResourceName(ns, 'auth-wic-state');
const wicStateVolume = new docker.Volume(wicStateVolumeName, {
  name: wicStateVolumeName,
  labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
});

/**
 * Một-shot CHOWN volume state cho uid 1000 (`node`) — Docker tạo volume mới
 * với thư mục gốc `root:root 0755`, mà container WIC chạy non-root
 * (`USER node`, cùng model home/account): node không ghi được vào volume
 * root-owned là wrangler chết ngay lúc boot (`mkdir /state/... EACCES`).
 *
 * Vì sao init container mà không khai `user` trên WIC: một-shot chạy image
 * Node pin với root (default), `chown 1000:1000 /state` rồi thoát — WIC thêm
 * `dependsOn` nó nên lần đầu tiên container lên, volume đã thuộc node. Lần
 * chạy sau là no-op (chown idempotent). Volume KHÔNG mang dữ liệu cần bảo vệ
 * trước container (state wrangler ephemeral) nên root của init container
 * không phải cảnh bảo mật.
 */
const wicStateInit = new command.local.Command(
  dockerResourceName(ns, 'auth-wic-state-init'),
  {
    create: pulumi.interpolate`docker run --rm -v ${wicStateVolume.name}:/state ${NODE_IMAGE} chown 1000:1000 /state`,
    update: pulumi.interpolate`docker run --rm -v ${wicStateVolume.name}:/state ${NODE_IMAGE} chown 1000:1000 /state`,
    triggers: [wicStateVolume.name],
  },
  { dependsOn: [wicStateVolume] },
);

/**
 * Content-hash của HAI cây bundle `dist/` (`apps/auth/dist` +
 * `tools/account-bridge/dist`) — trigger recreate của container WIC.
 *
 * Vì sao cần: entrypoint chỉ COPY `dist` vào runtime tree LÚC CONTAINER
 * START (`wic-entrypoint.sh`), còn container WIC là resource có định nghĩa
 * bất biến giữa các lần `pulumi up` — bundle build lại trên host không làm
 * thay đổi thuộc tính nào của container, Pulumi không recreate, worker chạy
 * mãi trên bundle cũ (hoặc, với worktree lần đầu, trên bundle RỖNG → wrangler
 * fail entry-point → restart loop, #247). Build prerequisite Nx
 * (`auth:build`/`account-bridge:build` trong `dependsOn` của `local-up`) chỉ
 * bảo đảm dist tồn tại TRƯỚC khi up; việc container NHẬN bundle mới phải do
 * chính stack này phát hiện.
 *
 * Cơ chế: tính SHA-256 TRỰC TIẾP trên nội dung hai cây dist bằng code Node
 * trong Pulumi program (không qua `command.local.Command`) — hàm thuần sync
 * chạy ở MỖI lần đánh giá program: bundle build lại trên host là output đổi
 * ngay tại lần up sau đó, không phụ thuộc trigger nào nhớ trạng thái cũ. Hash
 * bao phủ CẢ TÊN FILE lẫn nội dung (walk có sort tên file để thứ tự duyệt
 * không đổi kết quả), chảy vào `labels` của container (ForceNew) — hash đổi
 * là container recreate, entrypoint copy lại bundle mới. `@pulumi/docker`
 * 5.2.0 Container KHÔNG có property `triggers` (property đó thuộc
 * `remoteImage`/`registryImage`/`@pulumi/command`) — label là cơ chế ForceNew
 * tương đương.
 *
 * Hash của cây RỘNG hoặc dist vắng mặt vẫn tính được (chuỗi rỗng hash thành
 * giá trị xác định — không fail-closed ở đây): empty dist là trạng thái không
 * hợp lệ sẽ bị guard `wic.fatal: dist_missing` của entrypoint ném ra tường
 * minh.
 *
 * Hash này không phải dữ liệu bảo mật, chỉ là thay đổi-detector — nhưng vẫn
 * chỉ hash tên file tương đối + nội dung, không lẫn dữ liệu nào khác.
 */
function sha256DistTree(rootDir: string, relDir: string): string {
  const treeRoot = path.join(rootDir, relDir);
  const hash = crypto.createHash('sha256');
  if (!existsSync(treeRoot)) {
    // Dist vắng mặt (chưa build) — hash rỗng xác định; guard `dist_missing`
    // của entrypoint là nơi fail tường minh, không phải ở đây.
    return hash.digest('hex');
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    // Sort theo tên file để thứ tự duyệt không đổi kết quả hash. Target es2020
    // chưa có `toSorted` — sort trên mảng do chính hàm tạo (copy rồi sort tại chỗ).
    const entries = [...readdirSync(dir, { withFileTypes: true })];
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
      } else if (entry.isFile()) {
        files.push(path.relative(treeRoot, filePath).split(path.sep).join('/'));
      }
    }
  };
  walk(treeRoot);
  for (const relFile of files) {
    hash.update(relFile);
    hash.update('\0');
    hash.update(readFileSync(path.join(treeRoot, relFile)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const wicBundleHash = pulumi.output(
  [
    sha256DistTree(worktreeRoot, 'apps/auth/dist'),
    sha256DistTree(worktreeRoot, 'tools/account-bridge/dist'),
  ].join('-'),
);

/**
 * Container WIC — HAI worker `wrangler dev` (auth + shim bridge) qua
 * `wic-entrypoint.sh`, plain HTTP trên platform network, TLS do Traefik chấm
 * dứt phía trước (cùng model home/backoffice/account).
 *
 * Thứ tự phụ thuộc: provision → migrate → seed → image → volume → container —
 * container chỉ lên sau khi schema `db-auth` sẵn sàng VÀ client public đã có
 * row (provider ném khi `oauth_clients` rỗng — `/ready` qua DB probe vẫn thấy
 * bảng, nhưng mọi `/authorize` sẽ 500), để readiness đỏ của cửa sổ
 * chưa-migrate không bị healthcheck giết lặp vô tận.
 *
 * `wicBundleHash` là input của container (không phải của migrate): container
 * phải mang hash của LẦN build hiện hành — bundle vừa build lại thì hash mới
 * đã có trong label ngay khi Pulumi so sánh desired state, vì hash được tính
 * trực tiếp ở mỗi lần đánh giá program.
 *
 * Env:
 * - `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` (secret):
 *   wrangler của process auth đọc biến này của PROCESS để gán connection
 *   string binding HYPERDRIVE (PF3). Thiếu biến là wrangler fail boot
 *   tường minh (fail-closed, worker-config.ts cùng hợp đồng cho đường host).
 * - Secrets Worker của auth: cùng TÊN BIẾN với Worker Secrets production —
 *   wrangler dev map env process vào secrets của worker.
 * - `BRIDGE_TARGET_ORIGIN` cho shim: alias DNS container account của
 *   account stack (`dockerResourceName(ns, 'account')`, port nội bộ 3000 —
 *   cùng nguồn tên với hình dạng `ecoma-<ns>-account` trong `02-account-auth.md`).
 *   Shim thiếu biến vẫn boot nhưng trả 503 fail-closed cho mọi request qua
 *   binding (src/main.ts của bridge).
 * - `AUTH_ACCOUNT_BASE_URL` trỏ origin HTTPS của account qua Traefik — đúng
 *   origin browser dùng khi điều hướng `interactions.url`.
 *
 * KHÔNG có `ports`: WIC không publish cổng ra host — auth phục vụ qua Traefik
 * (public) và qua dev registry nội bộ container (binding), platform invariant.
 */
const wic = new docker.Container(
  dockerResourceName(ns, 'auth-wic'),
  {
    name: dockerResourceName(ns, 'auth-wic'),
    image: pulumi.interpolate`${wicImageTag}@${wicImage.digest}`,
    restart: 'unless-stopped',
    // Readiness resource-owned (`wait: true` — cùng ngữ nghĩa với platform):
    // backoffice + E2E OIDC chỉ chạy sau khi healthcheck `/ready` (DB probe +
    // fetch binding) của WIC chuyển `healthy`. Trần chờ = startPeriod 120s +
    // 30 retries × 10s = 420s (cửa sổ boot wrangler — bundle check, registry
    // connect); waitTimeout 450s dư.
    wait: true,
    waitTimeout: 450,
    // `stop_timeout` 30s khớp bounded-wait 20s của entrypoint: SIGTERM → hai
    // workerd được thời gian thoát sạch (flush D1/KV state + registry) trước
    // khi Docker SIGKILL.
    stopTimeout: 30,
    volumes: [
      {
        volumeName: wicStateVolumeName,
        containerPath: '/state',
      },
      // Repo root mount read-only — nguồn `node_modules` (binary wrangler của
      // entrypoint + resolve module hai tầng của cây runtime mirror) và
      // `wrangler.jsonc` của cả hai app. Thiếu mount này là `/repo` rỗng trừ
      // hai subtree dist bên dưới → deps check của entrypoint fail
      // `wrangler_binary_missing` → restart loop (Issue #233). RO vì WIC không
      // ghi gì xuống repo: wrangler ghi `.wrangler/tmp`, cache miniflare và
      // registry đều qua điểm ghi `/state` (xem wic-entrypoint.sh).
      {
        hostPath: worktreeRoot,
        containerPath: '/repo',
        readOnly: true,
      },
      // Bundle `dist/` của hai app: repo mount read-only không chứa dist
      // (bundle build trên host bởi target `build` của Nx), mount bind trực
      // tiếp từng thư mục dist đã build (ro: workerd chỉ ĐỌC bundle; build
      // lại bundle trên host là thay đổi nội dung mount, cùng cơ chế hot-reload
      // mà `wrangler dev` dò được).
      {
        hostPath: `${worktreeRoot}/apps/auth/dist`,
        containerPath: '/repo/apps/auth/dist',
        readOnly: true,
      },
      {
        hostPath: `${worktreeRoot}/tools/account-bridge/dist`,
        containerPath: '/repo/tools/account-bridge/dist',
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
        aliases: [`${AUTH_WIC_ALIAS_PREFIX}${ns}-auth`],
      },
    ],
    envs: [
      pulumi.interpolate`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=${pulumi.secret(hyperdriveLocalConnectionString)}`,
      pulumi.interpolate`AUTH_SIGNING_KEY=${pulumi.secret(signingKeyPem)}`,
      pulumi.interpolate`AUTH_SIGNING_KEY_ID=${signingKeyId}`,
      pulumi.interpolate`AUTH_HANDLE_KEY=${pulumi.secret(handleKey)}`,
      // '1' — phiên bản khoá handle đầu tiên của local; chỉ phải là chuỗi chữ
      // số dương (parseHandleKeyVersion) và ổn định qua các lần deploy.
      'AUTH_HANDLE_KEY_VERSION=1',
      pulumi.interpolate`AUTH_INTERNAL_SECRET=${pulumi.secret(internalSecret)}`,
      pulumi.interpolate`AUTH_ISSUER=${issuerLocal}`,
      pulumi.interpolate`AUTH_AUDIENCE=${audienceLocal}`,
      pulumi.interpolate`AUTH_COOKIE_KEYS=${pulumi.secret(cookieKeys)}`,
      // Origin browser-facing của account — CÙNG luật port động với issuer
      // phía trên: provider dựng interactions/continue URL từ hằng này và
      // browser là bên đi theo URL, nên thiếu port là browser rơi vào origin
      // không listen. Account container chỉ nhìn `Host()` (bỏ port) nên
      // routing không đổi.
      pulumi.interpolate`AUTH_ACCOUNT_BASE_URL=https://account.${rootHostname}:${traefikHostPort}`,
      pulumi.interpolate`BRIDGE_TARGET_ORIGIN=http://${dockerResourceName(ns, 'account')}:3000`,
    ],
    labels: [
      ...Object.entries(labels).map(([label, value]) => ({ label, value })),
      // Bundle-hash trigger: hash SHA-256 của 2 cây dist hiện hành. ForceNew —
      // bundle build lại trên host đổi hash ⇒ container recreate ⇒ entrypoint
      // copy lại bundle (xem JSDoc của sha256DistTree). Thuộc namespace
      // `io.ecoma` cùng họ ownership labels, không đụng `io.docker.*`.
      {
        label: `${LABEL_PREFIX}.bundle-hash`,
        value: wicBundleHash,
      },
      { label: 'traefik.enable', value: 'true' },
      // Bắt buộc với provider docker multi-tenant (memory: cùng network flag
      // KHÔNG lọc — container trên nhiều network bị Traefik thấy qua network
      // nào là do label này quyết).
      { label: 'traefik.docker.network', value: networkName },
      {
        label: `traefik.http.routers.auth-${ns}.rule`,
        value: pulumi.interpolate`Host(\`auth.${rootHostname}\`)`,
      },
      {
        label: `traefik.http.routers.auth-${ns}.entrypoints`,
        value: 'websecure',
      },
      { label: `traefik.http.routers.auth-${ns}.tls`, value: 'true' },
      {
        label: `traefik.http.routers.auth-${ns}.service`,
        value: `auth-${ns}`,
      },
      {
        label: `traefik.http.services.auth-${ns}.loadbalancer.server.port`,
        value: String(AUTH_INTERNAL_PORT),
      },
    ],
    healthcheck: {
      // `/ready` chứ không phải `/health`: readiness phải chứng minh DB probe
      // thật + ACCOUNT_SERVICE probe thành công (`02-account-auth.md` §Runtime
      // contracts) — `/health` 200 không chạm dependency nào nên không đủ làm
      // bằng chứng container phục vụ được request thật.
      tests: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${AUTH_INTERNAL_PORT}/ready')` +
          `.then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))`,
      ],
      interval: '10s',
      timeout: '15s',
      // Probe /ready mở pool Postgres + fetch binding — tổng budget có thể tới
      // ~8s trong trường hợp xấu (connect timeout 3s + account probe 3s); 15s
      // là trần thoải mái, retries cao để cửa sổ boot wrangler (bundle check,
      // registry connect) không bị coi là chết.
      retries: 30,
      // Chuỗi đúng dạng Go duration Docker chuẩn hoá khi đọc ngược (`2m0s`,
      // không phải `120s`) — lệch dạng không đổi giá trị nhưng biến mỗi cặp
      // refresh + up thành diff ảo trên healthcheck.
      startPeriod: '2m0s',
    },
  },
  { dependsOn: [seed, wicImage, wicStateVolume, wicStateInit] },
);

export const provisionCommandName = provision.id;
export const migrateCommandName = migrate.id;
export const seedCommandName = seed.id;
export const imageDigest = wicImage.digest;
export const containerName = wic.name;
export const containerId = wic.id;
export const stateVolumeName = wicStateVolume.name;
export const namespaceVerified = verifiedNamespace;
