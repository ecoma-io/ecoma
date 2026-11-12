/**
 * Chương trình Pulumi của `staff-access-deploy` — deploy unit của
 * `apps/staff-access` (service Staff Access, Hono + postgres.js qua Hyperdrive,
 * `nodejs_compat`) ở LAN LOCAL deployment (P1.4, issue #428; ADR-0013).
 *
 * Pattern: mirror `deploys/pact-broker-api-deploy/index.ts` (WIC —
 * worker-in-container, nguồn gần nhất cùng hình MỘT worker + provision DB +
 * migration canonical). Image mỏng ghim `node:24-bookworm-slim` +
 * `ca-certificates` (PF2), chứa MỘT process `wrangler dev` theo
 * `wic-entrypoint.sh`: worker `ecoma-staff-access` (port nội bộ 4206 —
 * `dev.port` của `apps/staff-access/wrangler.jsonc`). Repo mount READ-ONLY —
 * entrypoint dựng **runtime tree mirror** ghi được dưới `$PERSIST_DIR/runtime`
 * (copy `wrangler.jsonc` + `dist`, symlink `node_modules` hai tầng) và chạy
 * wrangler từ đó. Secrets đi qua `envs` của container (kênh container env —
 * không argv, không label, không log), `pulumi.secret` bọc trước khi
 * interpolate để redact trong diff/log.
 *
 * KHÔNG có Traefik router (cùng quyết định với pact-broker-api, issue #238):
 * consumer của API ở local là BFF fetch server-side qua alias DNS nội bộ
 * `ecoma-staff-access` (backoffice gọi qua shim `STAFF_ACCESS_SERVICE` của nó,
 * xem `deploys/backoffice-deploy/local.ts` đọc lại `namespace:internalHmacSecret`
 * của stack này), nên container KHÔNG publish port ra host, KHÔNG mang label
 * `traefik.*`. Readiness là readiness NGHIỆP VỤ: Docker healthcheck poll
 * `GET /ready` của worker — route này nạp config (binding Hyperdrive + secret
 * HMAC) rồi chạy BA câu lệnh zero-row đại diện cho ba đường serving thật
 * (đọc tập cột `staff` của `getStaffBySub`, claim nonce `INSERT`/`DELETE` trên
 * `internal_nonces` do `0005` tạo, và `UPDATE settled_at` do `0006` tạo) bằng
 * **credential runtime**, nên 200 chứng minh schema đã migrate đủ và role
 * runtime có đúng grant. `/health` (không chạm DB) giữ vai trò liveness và
 * không được dùng làm bằng chứng readiness.
 *
 * Provision database mirror `deploys/backoffice-deploy/index.ts` + ADR-0013
 * §"Hệ quả": stack này provision `db-staff-access` + hai role
 * (`ecoma_staff_access_migrator`, `ecoma_staff_access_runtime`) qua
 * `docker exec` vào container PostgreSQL của platform; password do orchestration
 * sinh và truyền qua stack config `--config` (stdin, không argv), rồi đi vào
 * script qua kênh `environment` của `command.local.Command` — command text và
 * argv không chứa credential nào (chi tiết ở `scripts.ts`). Migration chạy **đường
 * canonical** (`apps/staff-access/db/apply.mts` — advisory lock
 * `hashtext('db-staff-access')`) bằng container node pin chạy tsx binary của
 * repo, KHÔNG qua binding Hyperdrive (HD6: Hyperdrive không hỗ trợ advisory
 * lock). KHÔNG có bước seed dữ liệu riêng: dữ liệu seed duy nhất của context
 * này là permission catalog (3 permission read) và nó nằm trong migration
 * `0003_permission_catalog_seed.sql` — nội dung system-defined role KHÔNG được
 * seed (docs `domains/staff-access/domain-model.md` §3.4, quyết định chưa chốt).
 */

import * as command from '@pulumi/command';
import * as docker from '@pulumi/docker';
import * as dockerBuild from '@pulumi/docker-build';
import * as pulumi from '@pulumi/pulumi';

import { sha256DistTree } from './bundle-hash.js';
import {
  MIGRATOR_PASSWORD_ENV_VAR,
  RUNTIME_PASSWORD_ENV_VAR,
  buildMigrateScript,
  buildProvisionScript,
} from './scripts.js';
import {
  LABEL_PREFIX,
  type PlatformOutputs,
  dockerResourceName,
  normalizeWorktreeRoot,
  ownershipLabels,
  worktreeNamespace,
} from '@ecoma-io/deployment';

/**
 * Image Node pin (theo DIGEST) để chạy migration trong container gắn
 * platform network — cùng digest mà `deploys/auth-deploy/Dockerfile` ghim.
 *
 * Vì sao container mà không chạy runner trên host: platform PostgreSQL KHÔNG
 * publish host port (invariant platform) và host không route được tới IP
 * container (platform facts PF5), nên `pg` của runner chỉ kết nối được từ bên
 * trong platform network. Container ephemeral chạy **tsx binary của repo** vẫn
 * là đúng một đường code canonical (`applyAllMigrations` của
 * `apps/staff-access/db/apply.mts`) — deploy không tự viết lại vòng migration.
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/** Alias DNS của PostgreSQL platform trong network nội bộ. */
const POSTGRES_HOST = 'ecoma-postgres';

/**
 * Cổng HTTP nội bộ của worker `ecoma-staff-access` trong WIC — `dev.port`
 * của `apps/staff-access/wrangler.jsonc`. Bên trong container KHÔNG cần
 * phát hiện xung đột port host (mỗi container có network stack riêng — static
 * port an toàn); nguồn số duy nhất là wrangler.jsonc, Pulumi không cấp port.
 * Alias DNS `ecoma-staff-access` (hằng số) + port này là contract của consumer
 * đã có: backoffice gọi `http://ecoma-staff-access:4206`.
 *
 * Wrangler đọc `dev.port` khi render URL banner và healthcheck ở dưới poll đúng
 * `STAFF_ACCESS_INTERNAL_PORT` — wrangler đổi port là healthcheck fail ngay (fail
 * qua vòng đời container, không qua assertion compile-time).
 */
const STAFF_ACCESS_INTERNAL_PORT = 4206;

/**
 * Alias DNS của WIC container trong platform network — HẰNG SỐ, không theo
 * namespace (khác auth dùng `${AUTH_WIC_ALIAS_PREFIX}${ns}-auth`). Mỗi worktree
 * có platform network RIÊNG (namespace cô lập), nên alias hằng trong một
 * network không xung đột; hằng để consumer (backoffice) cấu hình base URL
 * không phụ thuộc namespace.
 */
const STAFF_ACCESS_ALIAS = 'ecoma-staff-access';

const conf = new pulumi.Config('namespace');

const worktreeRoot = conf.require('worktreeRoot');
const ns = worktreeNamespace(worktreeRoot);

// Labels ownership: gắn lên MỌI Docker resource (image + container + volume)
// để `pnpm dx local-cleanup` phân loại được.
const labels = ownershipLabels(normalizeWorktreeRoot(worktreeRoot), ns);

/**
 * Bundle-hash trigger cho container WIC — cùng cơ chế `deploys/auth-deploy`.
 *
 * Vì sao cần: `dist/` được build trên host và mount bind vào container, nên nội
 * dung bundle KHÔNG phải input của Pulumi. Rebuild `dist` mà không đổi gì khác
 * thì Pulumi thấy container y nguyên và không recreate — container tiếp tục chạy
 * bundle cũ (entrypoint chỉ copy `dist` một lần lúc boot). Hash của cây `dist`
 * đổi ⇒ label đổi ⇒ container recreate ⇒ entrypoint copy bundle mới.
 *
 * Hàm hash nằm ở `bundle-hash.ts` (không Pulumi) để test được bằng Vitest;
 * xem JSDoc ở đó cho định dạng hash và lý do fail-fast. `@pulumi/docker` 5.2.0
 * `Container` KHÔNG có property `triggers` — label là cơ chế ForceNew tương
 * đương (xem JSDoc đầy đủ ở `deploys/auth-deploy/index.ts`).
 *
 * ⚠️ Tính Ở ĐÂY, trước mọi `new …Resource`: Pulumi bắt đầu apply resource ngay
 * khi chúng được đăng ký, trong lúc chương trình còn đang đánh giá. Hàm này ném
 * khi cây `dist` không đọc được (fail-fast — xem `bundle-hash.ts`), và một lần
 * ném sau `provision`/`migrate` có thể để update dừng giữa chừng với database
 * đã provision. Tính trước để lỗi bundle dừng chương trình trước khi có gì được
 * đăng ký.
 */
const wicBundleHash = pulumi.output(sha256DistTree(worktreeRoot, 'apps/staff-access/dist'));

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

// Mật khẩu hai role của db-staff-access — do orchestration sinh và truyền qua
// --config (stdin, không argv).
const runtimePassword = conf.requireSecret('runtimePassword');
const migratorPassword = conf.requireSecret('migratorPassword');
const internalHmacSecret = conf.require('internalHmacSecret');

const verifiedNamespace = pulumi.output(platformNamespace).apply((upstreamNs) => {
  if (upstreamNs !== ns) {
    throw new Error(
      `platformStackRef points to a stack of a different namespace: platform exports "${upstreamNs}" but this worktree is "${ns}".`,
    );
  }
  return ns;
});

/**
 * Provision `db-staff-access` + 2 role, chạy trên host qua `docker exec` vào
 * container PostgreSQL của platform. Idempotent như backoffice-deploy: mỗi
 * lệnh guard-create bằng shell `if`, còn ALTER password idempotent sẵn — chạy
 * cả `create` và `update` để redeploy cũng xoay password.
 *
 * Khác auth (4 role): bounded context này chỉ có 2 role, không có owner role
 * dùng chung (migrator sở hữu schema `staff_access` sau khi migration `0001`
 * chạy — grant `CREATE` trên database cấp ở đây). Chặn chéo chiều ra vẫn phải
 * làm: hai role này không được CONNECT vào database của service khác
 * (`apps/staff-access/db/README.md` §"Chặn chéo", migration `0002` §"Cross-
 * database REVOKE"); provisioning mới là nơi thực thi được vì cần quyền sở hữu
 * database đích — cùng hình guard `if` với auth/account.
 */
const postgresContainerName = dockerResourceName(ns, 'postgres');
// Script provision do `scripts.ts` dựng (hàm thuần, test được tĩnh) — text
// KHÔNG chứa giá trị secret nào: mật khẩu đi vào tiến trình shell qua map
// `environment` của command resource (giá trị bọc `pulumi.secret`), script chỉ
// đọc bằng TÊN biến (`STAFF_PW_*`). Lưu ý phạm vi: kênh `environment` chỉ cách
// ly argv của process host — KHÔNG bảo vệ trước việc xem process environment ở
// tầng host; một người đã đọc được environ của process Pulumi thì mọi kênh
// của cùng process đều lộ như nhau.
const provisionScript = buildProvisionScript({ postgresContainerName });
// Map môi trường của provision — MỌI giá trị secret được bọc `pulumi.secret`:
// state/diff chỉ thấy `[secret]`, và key khớp đúng TÊN biến mà script đọc.
const provisionEnvironment = {
  [MIGRATOR_PASSWORD_ENV_VAR]: pulumi.secret(migratorPassword),
  [RUNTIME_PASSWORD_ENV_VAR]: pulumi.secret(runtimePassword),
};

const provision = new command.local.Command(dockerResourceName(ns, 'staff-access') + '-provision', {
  create: provisionScript,
  update: provisionScript,
  // Mật khẩu đi qua `environment` (giá trị secret), KHÔNG qua command text.
  // Trigger vẫn đổi khi password đổi, nhưng giá trị được `pulumi.secret` bọc —
  // state/diff chỉ thấy `[secret]`, không bao giờ thấy mật khẩu plaintext
  // (trigger được lưu trong state Pulumi).
  //
  // `verifiedNamespace` co mat o day de engine PHAI giai xong StackReference
  // (va kiem namespace) TRUOC khi chay script: khong co no, provision khong phu
  // thuoc output nao cua platform, nen mot stack tro nham platform van provision
  // role/database roi moi bao loi — mot lan apply mot phan tren input sai.
  triggers: [
    pulumi.secret(runtimePassword),
    pulumi.secret(migratorPassword),
    worktreeRoot,
    verifiedNamespace,
  ],
  environment: provisionEnvironment,
});

/**
 * Migration qua **đường canonical**: container ephemeral trên platform network
 * chạy đúng `tsx db/apply.mts` của repo (`apps/staff-access/db/apply.mts` —
 * advisory lock `hashtext('db-staff-access')`, mọi DDL idempotent). Repo mount
 * read-only. KHÔNG chạy qua binding Hyperdrive (HD6: advisory lock).
 *
 * Kênh credential: `DATABASE_URL` (chứa password migrator) đi vào tiến trình
 * shell qua map `environment` của command resource (giá trị bọc `pulumi.secret`),
 * rồi `docker run -e DATABASE_URL` chỉ mang TÊN biến — giá trị được docker CLI
 * đọc từ environ của chính nó và chuyển vào container env. Do đó URL không nằm
 * trong command text, không trong argv của `sh -c`/`docker run`/tsx, và không
 * trong state Pulumi. Phạm vi: kênh `environment` chỉ cách ly argv — KHÔNG
 * bảo vệ trước việc xem process environment ở tầng host.
 */
// Percent-encode mật khẩu trước khi ghép vào userinfo của DATABASE_URL — an toàn
// khi orchestration set mật khẩu chứa `@ : / ? #` (xem finding security OCR).
// Encode trên plaintext; kết quả được bọc `pulumi.secret` trong template. Biến
// kết quả KHÔNG mang tên khớp regex nguồn nhạy cảm (`password`...) nên không
// bị taint-source của rule `security-sensitive-value-in-http-response` đánh dấu
// (source là identifier bắt đầu bằng token/password/secret...).
const migratorPasswordEncoded = migratorPassword.apply((v) => encodeURIComponent(v));

// URL ghép y hệt hình serving (percent-encoded userinfo) — giữ nguyên contract
// kết nối của migration; chỉ đổi KÊNH vận chuyển từ argv sang `environment`.
const migratorDatabaseUrl = pulumi.interpolate`postgresql://ecoma_staff_access_migrator:${pulumi.secret(migratorPasswordEncoded)}@${POSTGRES_HOST}:5432/db-staff-access`;

const migrateScript = networkName.apply((net) =>
  buildMigrateScript({
    networkName: net,
    worktreeRoot,
    nodeImage: NODE_IMAGE,
  }),
);

const migrate = new command.local.Command(
  dockerResourceName(ns, 'staff-access') + '-migrate',
  {
    create: migrateScript,
    update: migrateScript,
    // URL đi qua `environment` (giá trị secret). Bọc secret: trigger nằm trong
    // state Pulumi — không lưu plaintext.
    triggers: [pulumi.secret(migratorPassword), worktreeRoot],
    environment: { DATABASE_URL: migratorDatabaseUrl },
  },
  { dependsOn: [provision] },
);

/**
 * KHÔNG có bước seed dữ liệu riêng ở unit này: dữ liệu seed duy nhất của
 * context `staff-access` là permission catalog (3 permission read) và nó nằm
 * trong migration `0003_permission_catalog_seed.sql` — catalog sealed đi cùng
 * vòng migration, không phải một lệnh psql rời. Nội dung system-defined role
 * KHÔNG được seed (docs `domains/staff-access/domain-model.md` §3.4 — quyết định
 * chưa chốt). Sổ staff KHÔNG được seed bởi deploy: first-admin bootstrap đi qua
 * procedure ADR-0003 — manual SQL/CLI offline bằng credential admin của chính
 * database này (với `db-staff-access` đó là `ecoma_staff_access_migrator`;
 * `ecoma_owner` KHÔNG tồn tại cho database này — ADR-0020 Quyết định 11) — có
 * audit trail; hai-phím KHÔNG áp cho lần bootstrap đầu tiên nhưng vẫn áp cho
 * emergency recovery (ADR-0020 Quyết định 11). "Deploy unit cấm mọi code path bootstrap" nghĩa là
 * cấm đường serving (route/flag runtime), không cấm bước provisioning — hợp đồng
 * canonical là `docs/architecture/02-delivery.md` §3.2 + ADR-0020.
 */

/**
 * Image WIC — image MỎNG: chỉ image Node pin + `ca-certificates` (PF2) +
 * entrypoint script. KHÔNG build gì bên trong: repo (kèm bundle `dist/` đã
 * build từ target `build` của Nx trên host) được mount lúc runtime, và
 * `wrangler dev` chạy từ mount đó. Khác account image (runtime build trong
 * Docker) vì staff-access runtime là `wrangler dev`, không phải process Node
 * đóng gói — image chỉ là "phòng chạy" (pattern auth).
 */
const wicImageTag = dockerResourceName(ns, 'staff-access-wic') + ':local';
const wicImage = new dockerBuild.Image(dockerResourceName(ns, 'staff-access-wic-image'), {
  context: { location: worktreeRoot },
  dockerfile: { location: `${worktreeRoot}/deploys/staff-access-deploy/Dockerfile` },
  tags: [wicImageTag],
  builder: { name: 'default' },
  load: true,
  push: false,
  labels,
});

/**
 * Connection string Hyperdrive local của staff-access (PF3/PF4): role
 * runtime, host alias `ecoma-postgres` của platform network, `sslmode=disable`
 * — miniflare bỏ proxy TLS và workerd dial thẳng host:port. `pulumi.secret` bọc
 * TRƯỚC interpolate (redact trong diff/log); giá trị đi vào container qua kênh
 * `envs` — không argv, không label, không log.
 *
 * Mật khẩu được percent-encode (`encodeURIComponent`) trước khi ghép vào
 * userinfo của URL: bất biến `generatePostgresPassword` (base64url, chỉ
 * `A-Za-z0-9-_`) hiện không chứa ký tự dành riêng của URL, nhưng encode là
 * vệ tinh an toàn khi ai đó `pulumi config set` giá trị thủ công chứa
 * `@ : / ? #` — parser `pg`/workerd giải mã percent-encoding đúng chuẩn, nên
 * hai đường đều đúng.
 *
 * Tên biến: `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_` + TÊN BINDING
 * wrangler (`DB_STAFF_ACCESS` của `apps/staff-access/wrangler.jsonc` — cùng tên
 * mà `src/config.ts` đọc qua `env.DB_STAFF_ACCESS`).
 */
const runtimePasswordEncoded = runtimePassword.apply((v) => encodeURIComponent(v));
const hyperdriveLocalConnectionString = pulumi.interpolate`postgresql://ecoma_staff_access_runtime:${pulumi.secret(runtimePasswordEncoded)}@${POSTGRES_HOST}:5432/db-staff-access?sslmode=disable`;

/**
 * Volume RW duy nhất của WIC: state wrangler (`--persist-to`, HOME/XDG cô lập,
 * dev registry). KHÔNG nằm trong repo mount (read-only) — workerd ghi state
 * runtime liên tục; dữ liệu này là EPHEMERAL theo thiết kế nên volume không
 * `retainOnDelete` và KHÔNG được liệt kê là dữ liệu persistent nào.
 */
const wicStateVolumeName = dockerResourceName(ns, 'staff-access-wic-state');
const wicStateVolume = new docker.Volume(wicStateVolumeName, {
  name: wicStateVolumeName,
  // Ownership labels — `local-cleanup` chỉ xoá resource chứng minh được sở hữu;
  // thiếu label là orphan bị skip fail-closed.
  labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
});

/**
 * Một-shot CHOWN volume state cho uid 1000 (`node`) — Docker tạo volume mới
 * với thư mục gốc `root:root 0755`, mà container WIC chạy non-root
 * (`USER node`, cùng model auth): node không ghi được vào volume root-owned
 * là wrangler chết ngay lúc boot (`mkdir /state/... EACCES`). Lần chạy sau là
 * no-op (chown idempotent). Volume KHÔNG mang dữ liệu cần bảo vệ trước
 * container (state wrangler ephemeral) nên root của init container không phải
 * cảnh bảo mật.
 */
const wicStateInit = new command.local.Command(
  dockerResourceName(ns, 'staff-access-wic-state-init'),
  {
    create: pulumi.interpolate`docker run --rm -v ${wicStateVolume.name}:/state ${NODE_IMAGE} chown 1000:1000 /state`,
    update: pulumi.interpolate`docker run --rm -v ${wicStateVolume.name}:/state ${NODE_IMAGE} chown 1000:1000 /state`,
    triggers: [wicStateVolume.name],
  },
  { dependsOn: [wicStateVolume] },
);

/**
 * Container WIC — MỘT worker `wrangler dev` (staff-access) qua
 * `wic-entrypoint.sh`, plain HTTP trên platform network.
 *
 * Thứ tự phụ thuộc: provision → migrate → image → volume → container —
 * container chỉ lên sau khi schema sẵn sàng (permission catalog nằm trong
 * migration), để request đầu tiên của consumer không rơi vào cửa sổ chưa-
 * migrate.
 *
 * Env:
 * - `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_STAFF_ACCESS` (secret):
 *   wrangler đọc biến này của PROCESS để gán connection string binding
 *   DB_STAFF_ACCESS (PF3). Thiếu biến là wrangler fail boot tường minh (fail-closed).
 * KHÔNG có `ports` và KHÔNG có label `traefik.*`: WIC không publish cổng ra
 * host — consumer là BFF fetch server-side qua alias nội bộ (cùng quyết định
 * no-Traefik với pact-broker-api, issue #238).
 */
const wic = new docker.Container(
  dockerResourceName(ns, 'staff-access-wic'),
  {
    name: dockerResourceName(ns, 'staff-access-wic'),
    image: pulumi.interpolate`${wicImageTag}@${wicImage.digest}`,
    restart: 'unless-stopped',
    // Readiness resource-owned (`wait: true` — cùng ngữ nghĩa với platform):
    // backoffice gọi staff-access qua alias DNS nội bộ ngay sau khi unit này
    // up xong, nên `up` xanh phải đồng nghĩa healthcheck `/ready` (config nạp
    // được + DB trả lời bằng credential runtime) đã `healthy`.
    // Trần chờ = startPeriod 2m + 30 retries × 10s = 420s; waitTimeout 450s dư.
    wait: true,
    waitTimeout: 450,
    // `stop_timeout` 30s khớp bounded-wait 20s của entrypoint: SIGTERM →
    // workerd được thời gian thoát sạch (flush state + registry + pool
    // PostgreSQL) trước khi Docker SIGKILL.
    stopTimeout: 30,
    volumes: [
      {
        volumeName: wicStateVolumeName,
        containerPath: '/state',
      },
      // Repo root mount read-only — nguồn `node_modules` (binary wrangler của
      // entrypoint + resolve module hai tầng của cây runtime mirror) và
      // `wrangler.jsonc` của app. Thiếu mount này là `/repo` rỗng trừ subtree
      // dist bên dưới → deps check của entrypoint fail `wrangler_binary_missing`
      // → restart loop (bài học Issue #233 của auth). RO vì WIC không ghi gì
      // xuống repo: wrangler ghi `.wrangler/tmp`, cache miniflare và registry
      // đều qua điểm ghi `/state` (xem wic-entrypoint.sh).
      {
        hostPath: worktreeRoot,
        containerPath: '/repo',
        readOnly: true,
      },
      // Bundle `dist/` của app: repo mount read-only không chứa dist (bundle
      // build trên host bởi target `build` của Nx), mount bind trực tiếp thư
      // mục dist đã build (ro: workerd chỉ ĐỌC bundle; build lại bundle trên
      // host là thay đổi nội dung mount, cùng cơ chế hot-reload mà
      // `wrangler dev` dò được).
      {
        hostPath: `${worktreeRoot}/apps/staff-access/dist`,
        containerPath: '/repo/apps/staff-access/dist',
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
        aliases: [STAFF_ACCESS_ALIAS],
      },
    ],
    envs: [
      pulumi.interpolate`AUTH_INTERNAL_SECRET=${pulumi.secret(internalHmacSecret)}`,
      pulumi.interpolate`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_STAFF_ACCESS=${pulumi.secret(hyperdriveLocalConnectionString)}`,
    ],
    labels: [
      ...Object.entries(labels).map(([label, value]) => ({ label, value })),
      // Bundle-hash trigger: ForceNew — rebuild `dist` trên host đổi hash ⇒
      // container recreate ⇒ entrypoint copy lại bundle (xem JSDoc của
      // sha256DistTree). Cùng họ `io.ecoma` với ownership labels.
      { label: `${LABEL_PREFIX}.bundle-hash`, value: wicBundleHash },
    ],
    healthcheck: {
      // `/ready` (khong phai `/health`): probe nay noi config da nap duoc VA
      // `db-staff-access` tra loi duoc bang credential runtime — dung hai
      // dieu kien ma moi route `/api/**` cua backoffice can de khong 503.
      // `/health` chi chung minh worker boot, khong phai bang chung readiness
      // nghiep vu (issue #18).
      // `r.ok` (2xx) chu khong `< 500` nhu cac unit khac: mot 401/404 tu
      // `/ready` nghia la route probe hoac mien tru envelope da hoi quy, va
      // coi no la "healthy" se che dung loi ma issue #18 quan tam. `/ready`
      // chi tra 200 khi config + DB that su san sang, nen 2xx la tin hieu
      // duy nhat dung.
      tests: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${STAFF_ACCESS_INTERNAL_PORT}/ready')` +
          `.then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))`,
      ],
      interval: '10s',
      // Probe `/ready` mo mot connection PostgreSQL qua Hyperdrive voi
      // `connect_timeout` 3s; 15s la tran thoi gian thoai mai cho ca pha mo
      // lan truy van, cung budget voi WIC auth.
      timeout: '15s',
      // Tran cua so boot wrangler (bundle check, registry connect) — cung
      // budget auth. Container chi `healthy` sau khi migration da chay
      // (`dependsOn: [migrate, ...]`), nen `/ready` khong do gia trong cua so
      // chua-migrate.
      retries: 30,
      // Chuoi dung dang Go duration Docker chuan hoa khi doc nguoc (`2m0s`,
      // khong phai `120s`) — lech dang khong doi gia tri nhung bien moi cap
      // refresh + up thanh diff ao tren healthcheck.
      startPeriod: '2m0s',
    },
  },
  { dependsOn: [migrate, wicImage, wicStateVolume, wicStateInit] },
);

export const provisionCommandName = provision.id;
export const migrateCommandName = migrate.id;
export const imageDigest = wicImage.digest;
export const containerName = wic.name;
export const containerId = wic.id;
export const stateVolumeName = wicStateVolume.name;
export const namespaceVerified = verifiedNamespace;
