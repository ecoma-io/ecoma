/**
 * Chương trình Pulumi của `platform-deploy` — nơi duy nhất provision tài nguyên
 * Docker dùng chung cho local deployment của MỘT worktree.
 *
 * Vì sao lại tách theo worktree: nhiều worktree của cùng repository có thể chạy
 * local deployment đồng thời trên một máy developer, nên mọi tên resource ở đây
 * đều bắt đầu từ namespace hash của worktree root. Hai worktree không bao giờ
 * đụng tên, và stack Pulumi local phải đi kèm namespace vì Pulumi state là
 * nguồn sự thật của resource (`deploy-namespace` của `@ecoma-io/deployment`).
 *
 * Chương trình này KHÔNG đọc `.env`: nó nhận `namespace:worktreeRoot` qua Pulumi
 * config do entry `local-up` của chính project (`local.ts`) truyền vào. `.env` là artifact tiện dụng sinh
 * ra TỪ outputs của stack này, không phải input — đọc vòng lại sẽ thành vòng phụ
 * thuộc.
 */

import * as pulumi from '@pulumi/pulumi';
import * as docker from '@pulumi/docker';
import * as command from '@pulumi/command';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Helper/contract dùng chung qua workspace package `@ecoma-io/deployment`
// (`libs/deployment`) — một nguồn sự thật cho mọi deploy unit; copy hàm vào
// deploy unit sẽ tạo hai nơi định nghĩa cùng một thứ và để chúng lệch nhau.
// Ranh giới là một chiều: deploy → lib; lib KHÔNG được import ngược deploy
// hay `tools/dx` (contract test của lib chặn).
import {
  LOCAL_ROOT_HOSTNAME,
  TRAEFIK_INTERNAL_PORT,
  dockerResourceName,
  extractTraefikHostPort,
  normalizeWorktreeRoot,
  ownershipLabels,
  worktreeNamespace,
} from '@ecoma-io/deployment';

/**
 * Thư mục chứa chương trình này — gốc để định vị cert local.
 *
 * `import.meta.dirname` khả dụng vì package của chương trình khai
 * `"type": "module"`: Pulumi runtime `nodejs` chạy chương trình qua ts-node/esm
 * hooks (automatic ESM mode — điều kiện `type: "module"` + ts-node hiện đại
 * resolvable từ peer của `@pulumi/pulumi`, ts-node 7.0.1 vendored không có ESM
 * loader và không remap specifier `.js` sang `.ts`).
 */
const programDir = import.meta.dirname;

/**
 * Đường dẫn tuyệt đối tới một file tĩnh trong repo dùng làm bind-mount source.
 *
 * Fail sớm khi thiếu: bind-mount thiếu file ⇒ Docker TẠO THƯ MỤC tại path đó
 * trong container, process trong container chết với lỗi không chỉ ra nguyên
 * nhân thật — đúng loại lỗi mà `dockerSocketPath()` phía dưới cảnh báo. File
 * nằm trong repo nên chỉ một thay đổi layout/checkout là mất; kiểm tra ở đây
 * biến lỗi tầng Docker khó truy thành lỗi Pulumi rõ nguyên nhân.
 */
function repoMountFile(relativePath: string): string {
  const absPath = join(programDir, relativePath);
  if (!existsSync(absPath)) {
    throw new Error(
      `Missing bind-mount file ${absPath} — a bind-mount with a missing file makes Docker ` +
        'create a DIRECTORY there and the container dies with an error that does not reveal the cause.',
    );
  }
  return absPath;
}

/** Cert/key của hostname local nằm trong `local-certs/` cạnh chương trình. */
function certPath(fileName: string): string {
  return repoMountFile(join('local-certs', fileName));
}

/**
 * Đường dẫn Docker socket trên HOST để bind-mount vào Traefik.
 *
 * Nguyên tắc: socket phải thuộc ĐÚNG daemon mà `@pulumi/docker` đang nói chuyện.
 * `DOCKER_HOST` đặt thì phải là `unix://` và socket phải tồn tại thật — fallback
 * "âm thầm" sang `/var/run/docker.sock` khi `DOCKER_HOST` trỏ daemon khác (tcp://,
 * socket rootless chưa chạy) là Traefik đọc container của daemon THỨ HAI trong khi
 * provider điều khiển daemon thứ nhất: không router nào được đăng ký, mọi request
 * 404 vĩnh viễn mà không có lỗi nào chỉ ra nguyên nhân. Thiếu socket của đúng
 * daemon thì fail sớm với hướng dẫn hành động được, cùng triết lý `config.require`
 * phía dưới.
 */
function dockerSocketPath(): string {
  const explicit = process.env['DOCKER_SOCKET_PATH'];
  if (explicit !== undefined && explicit.length > 0) {
    // Dễ để lại giá trị cũ trong shell profile — kiểm tra như hai nhánh dưới,
    // không ngoại lệ "tường minh thì tin tuyệt đối".
    if (!existsSync(explicit)) {
      throw new Error(
        `DOCKER_SOCKET_PATH=${explicit} does not exist on the host — a missing bind-mount makes ` +
          'Docker create a DIRECTORY in the container and Traefik cannot connect to the daemon.',
      );
    }
    // Đối chiếu DOCKER_HOST khi nó cũng được đặt: `DOCKER_SOCKET_PATH` chỉ nói
    // "mount file này", còn provider `@pulumi/docker` điều khiển daemon mà
    // `DOCKER_HOST` trỏ tới. Hai giá trị trỏ hai socket khác nhau là Traefik
    // đọc container của daemon thứ hai trong khi provider điều khiển daemon
    // thứ nhất — đúng lớp lỗi fail-âm-thầm mà hàm này sinh ra để chặn. (`unix://`
    // prefix của `DOCKER_HOST` được chấp nhận tùy chọn để cùng một giá trị env
    // dùng được cho cả Docker CLI và biến này.)
    const host = process.env['DOCKER_HOST'] ?? '';
    if (host.length > 0 && host !== `unix://${explicit}` && host !== explicit) {
      throw new Error(
        `DOCKER_SOCKET_PATH=${explicit} and DOCKER_HOST=${host} point to two different ` +
          'sockets — Traefik will read the containers of the second daemon while the provider ' +
          'controls the first. Point both at the same socket, or unset DOCKER_HOST.',
      );
    }
    return explicit;
  }
  const host = process.env['DOCKER_HOST'] ?? '';
  if (host.length > 0) {
    if (!host.startsWith('unix://')) {
      throw new Error(
        `DOCKER_HOST=${host} is not unix:// — this program can only bind-mount unix ` +
          'sockets. Unset DOCKER_HOST to use the standard path, or set DOCKER_SOCKET_PATH ' +
          'explicitly.',
      );
    }
    const socketPath = host.slice('unix://'.length);
    if (!existsSync(socketPath)) {
      throw new Error(
        `DOCKER_HOST points to a socket that does not exist (${socketPath}) — the daemon is not ` +
          'running or the path changed. Do NOT fall back to /var/run/docker.sock: that is a different ' +
          'daemon, and Traefik would read the containers of that daemon while the provider still talks to this one.',
      );
    }
    return socketPath;
  }
  const standardSocket = '/var/run/docker.sock';
  if (existsSync(standardSocket)) return standardSocket;
  // Nhánh tới được đây thì `DOCKER_HOST` chắc chắn rỗng/unset (nhánh có host
  // phía trên đã return hoặc throw) — in "(unset)" là hằng số chết, nói thẳng
  // điều kiện thật để thông báo không gợi có thông tin khi nó không có.
  throw new Error(
    'No Docker unix socket found to bind-mount into Traefik ' +
      '(neither DOCKER_HOST nor DOCKER_SOCKET_PATH is set). ' +
      'Set DOCKER_SOCKET_PATH to point at the daemon socket ' +
      '(rootless is usually /run/user/<uid>/docker.sock).',
  );
}

/**
 * Image Traefik ghim theo DIGEST, không theo tag.
 *
 * Traefik đứng trước mọi request local nên một tag trôi (`v3`, `latest`) biến
 * thay đổi hành vi thành thay đổi hạ tầng ngoài ý muốn. Digest biến việc đó
 * thành thay đổi tường minh trong diff.
 *
 * Version TỐI THIỂU 3.6.1 là ràng buộc cứng, không phải sở thích: Traefik ≤
 * 3.6.0 ghim Docker client API version 1.24 trong source (`DockerAPIVersion`
 * trong `pkg/provider/docker/pdocker.go`, `client.WithVersion(cfg.apiVersion)`
 * chạy SAU `client.FromEnv` nên env không override được) và daemon Docker mới
 * từ chối mọi client < 1.40 — provider rơi vào vòng lặp "client version 1.24
 * is too old". 3.6.1 bỏ ghim (client dùng version mặc định mới nhất của SDK),
 * nên mọi daemon ≥ 20.10 hoạt động. Digest này là v3.7.15.
 */
const TRAEFIK_IMAGE =
  'traefik@sha256:0f6150202bc1fed72a7bd2107460eaa510e5b8a905f3fdb5b84f2c8619c33368';

/**
 * Image PostgreSQL ghim theo digest: PostgreSQL 17.11 + TimescaleDB 2.30.2 +
 * pgvector — extension của các service có time series, không phải của Traefik.
 */
const POSTGRES_IMAGE =
  'timescale/timescaledb@sha256:b346edcdb51a1fd6020e3965e0bd1c9f3406fa6d5fbce1e28f4852587ef934e2';

/** Số cổng PostgreSQL trong network — nội bộ, không phải host port. */
const POSTGRES_INTERNAL_PORT = 5432;

/**
 * Service alias của PostgreSQL trong network.
 *
 * Đây là endpoint mà một service **sở hữu** database dùng để chạm vào database
 * của chính nó, KHÔNG phải tên container. Consumer chưa tồn tại ở thời điểm
 * hiện tại: `home-deploy` CỐ Ý không đọc `postgresHost`/`postgresPort` vì
 * service không sở hữu database thì không được nối thẳng (invariant data
 * ownership, xem comment tương ứng ở đó). Tên container mang namespace theo
 * worktree nên đổi mỗi worktree; alias này cố định để contract outputs không
 * phụ thuộc worktree nào đang chạy.
 */
const POSTGRES_HOST_ALIAS = 'ecoma-postgres';

/** User và database local — hằng số, vì chúng không phải secret. */
const POSTGRES_USER = 'ecoma_local';
const POSTGRES_DB = 'ecoma_local';

/**
 * Image SeaweedFS ghim theo DIGEST — object store S3-compatible của lane local
 * (issue #19). `weed mini` chạy master + volume + filer + S3 trong MỘT process:
 * đủ cho remote-cache-api đọc/ghi cache artifacts mà không thêm service nào.
 * Entrypoint của image tự su-exec sang user `seaweed` (non-root) — command ở
 * dưới chỉ truyền subcommand + cờ, không gọi binary `weed` trực tiếp.
 */
const OBJECT_STORE_IMAGE =
  'chrislusf/seaweedfs:4.53@sha256:ccad23e18639c8b98cee17e7100b95830a06077b56d8e5b006d6dcf8ec5e94a0';

/**
 * Image node pin cho bước config-init một-shot — container ephemeral
 * `docker run --rm` ghi `s3.json` vào volume config rồi chown/chmod. Chỉ cần
 * `sh` + `chown` chạy được, không cần image SeaweedFS ở phía host path.
 */
const OBJECT_STORE_CONFIG_INIT_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/** Số cổng S3 nội bộ của SeaweedFS trong network — không publish ra host. */
const OBJECT_STORE_S3_PORT = 8333;

/**
 * Service alias của object store trong network — endpoint mà remote-cache-api
 * dùng để nói S3. Tên container mang namespace theo worktree; alias cố định để
 * contract outputs không phụ thuộc worktree nào đang chạy (cùng mô hình với
 * `POSTGRES_HOST_ALIAS` ở trên).
 */
const OBJECT_STORE_HOST_ALIAS = 'ecoma-object-store';

/** Bucket S3 duy nhất mà remote-cache-api sử dụng (issue #19). */
const OBJECT_STORE_BUCKET = 'remote-cache';

/**
 * Access key ID của client S3 — hằng số non-secret, cùng hạng với
 * `POSTGRES_USER`: định danh client, không phải credential. Secret key tương
 * ứng đi qua stack config `objectStorage:remoteCacheSecretKey` (đọc ở dưới) và
 * KHÔNG BAO GIỜ xuất ra stack output (contract `PlatformOutputs`).
 */
const OBJECT_STORE_ACCESS_KEY_ID = 'ecoma-remote-cache-local';

/**
 * Tên identity trong `s3.json` — identity SeaweedFS gắn quyền Read/Write/List
 * trên đúng bucket của remote cache, không trao quyền admin.
 */
const OBJECT_STORE_IDENTITY_NAME = 'remote-cache';

/** Đường dẫn file `s3.json` bên trong container SeaweedFS. */
const OBJECT_STORE_S3_CONFIG_PATH = '/etc/seaweedfs/s3.json';

/**
 * Target mount của volume config trong container — THƯ MỤC chứa `s3.json`.
 * Mount đè lên path cùng tên trong image: file mặc định của image bị che, file
 * duy nhất còn lại là `s3.json` do config-init ghi (xem resource tương ứng).
 */
const OBJECT_STORE_CONFIG_MOUNT_TARGET = '/etc/seaweedfs';

/** Target mount của volume dữ liệu object — nơi `weed mini` ghi cache artifacts. */
const OBJECT_STORE_DATA_MOUNT_TARGET = '/data';

/**
 * File dynamic config của Traefik — file tĩnh `traefik-dynamic.yml` cạnh
 * chương trình, bind-mount vào container (xem comment trong file đó vì sao
 * không dùng `uploads` của provider).
 *
 * Traefik v3 KHÔNG expose cờ CLI cho `certFile`/`keyFile` (kiểm trên 3.5.6: flag
 * `--entrypoints.<name>.http.tls.certificates.certFile` không tồn tại và làm
 * Traefik fail ngay lúc boot với `field not found, node: certificates`). Đường
 * hỗ trợ trong v3 là dynamic configuration qua file provider, và `/etc/traefik`
 * không có sẵn trong image nên file được mount vào `/tmp` thay vì chỉnh file
 * tĩnh của image.
 */
const TRAEFIK_DYNAMIC_CONFIG_PATH = '/tmp/traefik-dynamic.yml';

/** Thư mục chứa cert/key bind-mount. */
const CERTS_DIR = '/certs';

/**
 * Cờ khai entrypoint `websecure` — MỘT nguồn cho cả server và healthcheck.
 *
 * `traefik healthcheck` là subcommand riêng: nó đọc lại config từ chính bộ cờ
 * này để biết ping URL (`http://:<port>/ping`). Gõ lặp chuỗi ở `command` và ở
 * `healthcheck.tests` là bất biến "hai chỗ phải giống nhau" do kỷ luật sửa tay
 * giữ, không do compiler: đổi cổng nội bộ ở `command` mà quên healthcheck thì
 * container `unhealthy` dù Traefik phục vụ bình thường, với lý do rất khó đoán.
 */
const TRAEFIK_ENTRYPOINT_ADDRESS = `--entrypoints.websecure.address=:${TRAEFIK_INTERNAL_PORT}`;

/**
 * Cờ bật ping — cùng lý do: `--ping` không có cổng thì healthcheck mặc định gọi
 * `http://:8080/ping`, cổng không tồn tại ở đây (chỉ có `websecure` trên
 * `TRAEFIK_INTERNAL_PORT`), nên phải chỉ đúng entrypoint. Dùng chung một mảng
 * cho `command` và `healthcheck.tests` để hai phía không thể lệch.
 */
const TRAEFIK_PING_FLAGS = ['--ping=true', '--ping.entrypoint=websecure'] as const;

const config = new pulumi.Config('namespace');

/**
 * Worktree root do entry `local-up` (`local.ts`) truyền vào.
 *
 * `require` chứ không phải `get`: thiếu config thì namespace sẽ được hash từ
 * chuỗi rỗng và mọi tên resource trở nên không nhất quán giữa hai lần chạy — đúng
 * loại lỗi mà `deploy-namespace.ts` sinh ra để tránh. Fail sớm hơn là an toàn hơn.
 */
const worktreeRoot = config.require('worktreeRoot');
const ns = worktreeNamespace(worktreeRoot);

/**
 * Labels ownership cho MỌI resource chương trình này tạo — "giấy khai sinh"
 * dữ liệu mà `pnpm dx local-cleanup` đọc để quyết định resource nào là mồ côi:
 * không có bộ labels này, cleanup KHÔNG đụng resource dù tên trông giống
 * ecoma (`deploy-labels.ts`). `worktreePath` đã qua `normalizeWorktreeRoot`
 * tại đây: cùng nguồn normalize với side cleanup so sánh, hai lần chạy cùng
 * worktree không sinh metadata khác nhau.
 */
const labels = ownershipLabels(normalizeWorktreeRoot(worktreeRoot), ns);

/**
 * Docker network của worktree này.
 *
 * `name` khai tường minh (thay vì để Pulumi tự đặt) vì consumer đọc TÊN network
 * này từ outputs để join; tên suy ra từ URN sẽ đổi theo stack và không ổn định
 * giữa các lần chạy.
 */
const network = new docker.Network('network', {
  name: dockerResourceName(ns, 'network'),
  labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
});

/**
 * Traefik: reverse proxy duy nhất của local deployment.
 *
 * Chỉ MỘT entrypoint HTTPS ở cổng nội bộ 443. Cổng host do Docker cấp động
 * (`external` bỏ trống) và chỉ bind loopback — không publish ra mạng LAN, và không
 * đoán trước port để hai worktree không tranh nhau.
 */
const traefik = new docker.Container('traefik', {
  name: dockerResourceName(ns, 'traefik'),
  image: TRAEFIK_IMAGE,
  // Container bị dừng do reboot máy hay restart daemon được DOCKER tự start
  // lại nhờ `restart: unless-stopped` — không cần chạy lại `local-up`, và
  // cũng không thể qua `pulumi up`: Pulumi so input khai với input đã lưu trong
  // state, hai bên đều là `unless-stopped` nên không có diff nào cả; việc start
  // lại là cơ chế restart policy của Docker, không phải của Pulumi. Chỉ `docker
  // stop` tường minh là được giữ ở trạng thái dừng (policy tôn trọng nó).
  restart: 'unless-stopped',
  // Readiness thuộc resource này, không thuộc DX: `wait: true` bắt provider
  // chờ Docker healthcheck chuyển `healthy` trước khi Container báo thành
  // công — mọi resource phụ thuộc (outputs, unit kế tiếp qua StackReference)
  // chỉ resolve sau khi Traefik phục vụ thật. Traefik đọc socket Docker lúc
  // boot nên healthcheck `traefik healthcheck` có thể đỏ vài giây đầu
  // (startPeriod 5s + 5 retries × interval 5s = trần ~30s); waitTimeout 90s
  // là trần dư cho host chậm.
  wait: true,
  waitTimeout: 90,
  labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
  command: [
    TRAEFIK_ENTRYPOINT_ADDRESS,
    // Docker provider: chỉ route container nào tự gắn label routing.
    '--providers.docker=true',
    '--providers.docker.exposedbydefault=false',
    // Nói rõ network để Traefik về tới backend trong đúng network của
    // worktree này, không chọn nhầm network khác của host.
    pulumi.interpolate`--providers.docker.network=${network.name}`,
    // Lọc container vào router của ĐÚNG worktree — defense-in-depth thứ hai,
    // cạnh label `traefik.docker.network` mà home tự gắn. Không có filter này,
    // Docker provider thấy TẤT CẢ container có `traefik.enable=true` trên host
    // qua socket dùng chung (cờ `network` chỉ chọn IP khi container nằm trên
    // nhiều network, KHÔNG loại container ra khỏi config): home của worktree
    // khác vẫn được đăng ký thành router `Host(fbi.com)` thứ hai, và khi Traefik
    // trúng backend ở network không nối tới — request treo vĩnh viễn thay vì
    // lỗi rõ (đã kiểm thực nghiệm hai worktree song song). Constraint theo
    // label biến điều đó thành bất khả: container không mang label network của
    // worktree này không bao giờ vào config của Traefik này.
    pulumi.interpolate`--providers.docker.constraints=Label(\`traefik.docker.network\`, \`${network.name}\`)`,
    // File provider chỉ phục vụ dynamic config của TLS store ở trên.
    `--providers.file.filename=${TRAEFIK_DYNAMIC_CONFIG_PATH}`,
    ...TRAEFIK_PING_FLAGS,
  ],
  ports: [
    {
      internal: TRAEFIK_INTERNAL_PORT,
      // Cố ý KHÔNG khai `external`: Docker cấp port rảnh >= 32768 tại create
      // time, đọc lại được qua output `ports` SAU khi container đã tồn tại.
      ip: '127.0.0.1',
    },
  ],
  mounts: [
    {
      // Đường dẫn cert suy từ `LOCAL_ROOT_HOSTNAME` — hostname đổi thì router,
      // output và mount đi cùng một nguồn; file tĩnh `traefik-dynamic.yml` bên
      // dưới PHẢI sửa cùng lúc vì nó hardcode cùng tên file.
      source: certPath(`${LOCAL_ROOT_HOSTNAME}.crt`),
      target: `${CERTS_DIR}/${LOCAL_ROOT_HOSTNAME}.crt`,
      type: 'bind',
      readOnly: true,
    },
    {
      source: certPath(`${LOCAL_ROOT_HOSTNAME}.key`),
      target: `${CERTS_DIR}/${LOCAL_ROOT_HOSTNAME}.key`,
      type: 'bind',
      readOnly: true,
    },
    {
      // Docker socket: Traefik cần ĐỌC container labels để dựng router.
      //
      // ⚠️ `readOnly: true` KHÔNG phải ranh giới bảo mật: cờ chỉ chặn ghi qua
      // filesystem, không giới hạn Docker API — process nào trong container
      // (RCE, path traversal...) vẫn gọi được `POST /containers/create` với
      // bind-mount `/:/host` là leo thang đặc quyền trên host. Socket proxy
      // giới hạn GET-only là giảm thiểu đúng nghĩa, chưa có ở đây — đánh đổi
      // được ghi nhận ở docs (`03-operations.md` §giới hạn đã biết), không
      // phải thiếu sót vô hình.
      //
      // Máy chạy rootless Docker đặt socket ở `/run/user/<uid>/docker.sock`
      // (đó là giá trị `DOCKER_HOST` mà Docker CLI của máy đang dùng), KHÔNG
      // phải `/var/run/docker.sock` — bind-mount một path không tồn tại sẽ tạo
      // ra thư mục rỗng trong container và Traefik hỏng với lỗi dễ gây hiểu
      // nhầm ("Cannot connect to the Docker daemon") thay vì lỗi mount. Ưu
      // tiên: `DOCKER_SOCKET_PATH` tường minh > đường dẫn trong `DOCKER_HOST`
      // (chỉ chấp nhận `unix://`) > path chuẩn rootful.
      source: dockerSocketPath(),
      target: '/var/run/docker.sock',
      type: 'bind',
      readOnly: true,
    },
    {
      // Dynamic config TLS — file tĩnh trong repo, xem TRAEFIK_DYNAMIC_CONFIG_PATH.
      // Cùng kiểm tra tồn tại với cert/key qua `repoMountFile`: thiếu file là
      // Docker tạo THƯ MỤC tại target và file provider của Traefik chết lúc boot.
      source: repoMountFile('traefik-dynamic.yml'),
      target: TRAEFIK_DYNAMIC_CONFIG_PATH,
      type: 'bind',
      readOnly: true,
    },
  ],
  networksAdvanced: [{ name: network.name }],
  healthcheck: {
    // `traefik healthcheck` là subcommand RIÊNG: nó đọc config từ bộ cờ được
    // truyền trực tiếp cho NÓ, không tự đọc cờ của server — thiếu cờ entrypoint
    // là nó gọi `http://:8080/ping` mặc định, cổng không tồn tại, container bị
    // đánh `unhealthy` dù Traefik phục vụ bình thường. `TRAEFIK_ENTRYPOINT_ADDRESS`
    // + `TRAEFIK_PING_FLAGS` dùng chung với `command` ở trên, hai phía không
    // thể lệch nhau.
    tests: ['CMD', 'traefik', 'healthcheck', TRAEFIK_ENTRYPOINT_ADDRESS, ...TRAEFIK_PING_FLAGS],
    interval: '5s',
    timeout: '3s',
    retries: 5,
    startPeriod: '5s',
  },
});

/**
 * Password PostgreSQL đến từ Pulumi config dạng plaintext (local-dev only).
 *
 * Dùng `require` (không `requireSecret`): giá trị được sinh một lần bởi entry
 * up (`local.ts`) và lưu dạng plaintext trong stack config local (file
 * bị `.gitignore` — `Pulumi.*.yaml`). Passphrase local (`.pulumi-local-passphrase`)
 * mã hoá state Pulumi, KHÔNG mã hoá giá trị config này — nên `postgres:password`
 * vẫn plaintext theo chủ đích cho môi trường phát triển, KHÔNG áp dụng cho
 * staging/production.
 *
 * Giá trị vẫn được đánh dấu secret ở runtime qua `pulumi.secret(...)` khi truyền
 * vào container, để Pulumi redact nó trong diff/log/output — nhưng đó là lớp
 * redaction, không phải encryption at rest trong config file.
 *
 * ⚠️ Password này và volume PostgreSQL PHẢI CÙNG TUỔI: `POSTGRES_PASSWORD` chỉ
 * có tác dụng lúc `initdb` trên volume rỗng. Đổi password trong stack config sau
 * khi volume đã init sẽ khiến Pulumi thay container (envs nằm trong diff) nhưng
 * Postgres KHÔNG chạy lại initdb — superuser trong volume vẫn giữ mật khẩu cũ,
 * mọi kết nối bằng giá trị mới nhận `password authentication failed` trong khi
 * healthcheck `pg_isready` vẫn xanh (nó không xác thực mật khẩu). Đường đổi mật
 * khẩu hợp lệ nằm ngoài luồng này (đổi trực tiếp trong database rồi cập nhật
 * config cho khớp) — xem `docs/architecture/local-development/03-operations.md`
 * §Vòng đời dữ liệu.
 *
 * Entry up (`local.ts`) chỉ sinh password khi stack mới
 * VÀ volume chưa tồn tại; nếu volume đã có mà canonical password thiếu thì fail
 * thay vì sinh password mới không khớp.
 */
const postgresPassword = new pulumi.Config('postgres').require('password');

/**
 * Secret key S3 của remote cache đến từ Pulumi config dạng plaintext (local-dev
 * only) — cùng mô hình với `postgres:password` ở trên: sinh một lần bởi entry
 * up (`local.ts`), lưu plaintext trong stack config local (file `.gitignore`),
 * được bọc `pulumi.secret(...)` khi truyền vào command để Pulumi redact trong
 * diff/log. KHÔNG xuất ra stack output — contract `PlatformOutputs` chỉ mang
 * bốn field non-secret của object store.
 *
 * KHÁC `postgres:password` ở một điểm có chủ đích: KHÔNG có ràng buộc tuổi với
 * volume nào. File `s3.json` chỉ chứa giá trị tái sinh được và được config-init
 * ghi LẠI mỗi lần command chạy lại (trigger đổi khi secret đổi) — volume config
 * không giữ trạng thái nào khác file đó, nên mất config chỉ cần up lại là khớp,
 * không có "volume đã init bằng mật khẩu cũ" như PostgreSQL.
 */
const objectStorageSecretKey = new pulumi.Config('objectStorage').require('remoteCacheSecretKey');

/**
 * Volume dữ liệu PostgreSQL, TÁCH khỏi container VÀ tách khỏi vòng đời stack.
 *
 * Tách là bắt buộc chứ không phải sở thích: `destroy` container không được mất
 * dữ liệu, nên vòng đời volume phải độc lập với vòng đời process.
 *
 * `retainOnDelete` là mảnh thứ hai của đảm bảo đó: không có nó, `pulumi
 * destroy` xoá CẢ volume (đã kiểm thực nghiệm — volume biến mất cùng stack),
 * và destroy lỗi sẽ không tách được khỏi lỗi xoá volume (down tự gọi `docker
 * volume rm` sau destroy, xem `runPlatformDown`). Với `retainOnDelete`, xoá
 * resource khỏi state KHÔNG xoá volume Docker — volume chỉ biến mất khi down
 * của entry gọi `docker volume rm` tường minh (vô điều kiện, cảnh báo trước
 * khi mất dữ liệu).
 */
const postgresVolume = new docker.Volume(
  'postgres-volume',
  {
    name: dockerResourceName(ns, 'postgres-volume'),
    labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
  },
  { retainOnDelete: true },
);

/**
 * PostgreSQL — database của toàn bộ local deployment.
 *
 * KHÔNG khai `ports`: database không bao giờ publish cổng ra host. Chỉ service
 * trong cùng network mới chạm được nó, qua alias ổn định `ecoma-postgres`.
 *
 * Resource này CỐ Ý không xuất ra stack output: contract `PlatformOutputs` chỉ có
 * sáu khoá (xem `platform-outputs-contract` của `@ecoma-io/deployment`) và không khoá nào
 * mang id của database. Giữ nó trong state để Pulumi quản lý vòng đời — đó là
 * mục đích duy nhất cần tới biến.
 */
// oxlint-disable-next-line no-unused-vars -- resource cần tồn tại trong state, xem chú thích ngay trên
const postgres = new docker.Container('postgres', {
  name: dockerResourceName(ns, 'postgres'),
  image: POSTGRES_IMAGE,
  // Cùng lý do với traefik: `restart: unless-stopped` để DOCKER tự start lại
  // container sau reboot/restart daemon — `pulumi up` không làm được điều đó
  // vì input khai và input trong state đều là `unless-stopped`, không có diff.
  restart: 'unless-stopped',
  // Readiness resource-owned (cùng ngữ nghĩa với traefik ở trên): `pg_isready`
  // không xác thực mật khẩu nên cửa sổ chờ chỉ phụ thuộc initdb + boot —
  // startPeriod 10s + 10 retries × 5s = trần ~60s; waitTimeout 120s dư cho
  // lần đầu init volume (initdb chậm trên disk lạnh).
  wait: true,
  waitTimeout: 120,
  labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
  // `envs` là mảng `KEY=VALUE` của provider này (không phải map `env`).
  // `pulumi.secret(...)` đánh dấu value để Pulumi redact trong diff/log/output
  // — dù config lưu plaintext. `pulumi.interpolate` bên dưới KHÔNG tự redact
  // (đo thật: `pulumi.interpolate` với config plaintext in ra plaintext trong
  // output), nên phải bọc `secret` TRƯỚC rồi interpolate.
  envs: [
    `POSTGRES_USER=${POSTGRES_USER}`,
    `POSTGRES_DB=${POSTGRES_DB}`,
    pulumi.interpolate`POSTGRES_PASSWORD=${pulumi.secret(postgresPassword)}`,
    // TimescaleDB phải được preload mới chạy; nói tường minh thay vì trông
    // vào `postgresql.conf.sample` của image.
    'POSTGRES_SHARED_PRELOAD_LIBRARIES=timescaledb',
  ],
  mounts: [
    {
      source: postgresVolume.name,
      target: '/var/lib/postgresql/data',
      type: 'volume',
    },
  ],
  networksAdvanced: [{ name: network.name, aliases: [POSTGRES_HOST_ALIAS] }],
  healthcheck: {
    tests: ['CMD-SHELL', `pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}`],
    interval: '5s',
    timeout: '3s',
    retries: 10,
    startPeriod: '10s',
  },
});

/**
 * Volume config của object store — CHỈ chứa file `s3.json` do config-init ghi
 * (issue #19). CỐ Ý KHÔNG `retainOnDelete` (khác volume PostgreSQL): nội dung
 * là file tái sinh được — command config-init viết lại từ stack config ở MỌI
 * lần chạy lại, không có dữ liệu nào cần sống sót qua destroy.
 */
const objectStoreConfigVolume = new docker.Volume('object-store-config', {
  name: dockerResourceName(ns, 'object-store-config'),
  labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
});

/**
 * Volume dữ liệu object của object store — nơi `weed mini` ghi cache artifacts
 * của remote-cache-api (issue #19). CỐ Ý KHÔNG `retainOnDelete`, KHÁC volume
 * PostgreSQL một cách có chủ đích: dữ liệu cache là disposable theo yêu cầu
 * của issue #19 — mất cache chỉ là miss, không phải mất dữ liệu có thể tái
 * tạo; volume chết cùng stack là hành vi đúng, không phải quên.
 */
const objectStoreDataVolume = new docker.Volume('object-store-data', {
  name: dockerResourceName(ns, 'object-store-data'),
  labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
});

/**
 * Ghi `s3.json` vào volume config qua container node một-shot (`docker run
 * --rm` trên host — cùng kênh tin cậy với bước provision `docker exec` psql
 * của remote-cache-api-deploy). File được viết LẠI ở MỌI lần command chạy lại
 * (create lẫn update cùng script; trigger đổi khi secret đổi), nên volume chỉ
 * là nơi chứa, không phải nguồn sự thật — nguồn là stack config.
 *
 * Secret KHÔNG nằm trong chuỗi command: chuỗi đó chạy qua argv của shell host
 * lẫn của `docker run` trong container, mà argv đọc được qua
 * `ps`/`/proc/<pid>/cmdline` — interpolate secret vào command (heredoc cũ) là
 * đưa secret ra ngoài mọi liệt kê process dù `pulumi.secret` đã bọc (secret
 * chỉ redact trong state/diff/log, không biến mất khỏi argv). Transport thay
 * thế: JSON đi qua input `stdin` của resource — `pulumi.secret(...)` bọc
 * TRƯỚC khi nối JSON nên state/diff/log của stdin chỉ thấy `[secret]`, còn
 * runtime provider ghi payload vào stdin của `docker run -i`; pipe của Docker
 * dẫn thẳng tới `cat > /cfg/s3.json` trong container, nên trên argv chỉ còn
 * chuỗi command sạch — không secret, không heredoc, không cờ `-e` truyền env.
 *
 * `jsonStringify` nối JSON đúng hình cũ mà bỏ ràng buộc ký tự: heredoc không
 * quote cũ bắt buộc nội dung chỉ chứa `A-Za-z0-9-_` + punctuation JSON
 * (không có `$`/backtick để shell mở rộng); giờ giá trị `config set` thủ công
 * chứa ký tự bất kỳ cũng an toàn vì JSON không đi qua parser shell nào.
 *
 * Triggers giữ nguyên hành vi rotation: secret đổi là command chạy lại với
 * stdin mới, file được viết lại bằng credential mới.
 *
 * `chown 1000:1000` + `chmod 0600`: file chỉ đọc được bởi uid weed chạy trong
 * container (image chạy non-root user `seaweed`, uid kỳ vọng 1000 — đã xác
 * minh tại runtime qua `stat` sau lần boot đầu).
 */
const s3ConfigJson = pulumi
  .all([
    OBJECT_STORE_IDENTITY_NAME,
    OBJECT_STORE_ACCESS_KEY_ID,
    pulumi.secret(objectStorageSecretKey),
    OBJECT_STORE_BUCKET,
  ])
  .apply(([identityName, accessKeyId, secretKey, bucket]) =>
    pulumi.jsonStringify({
      identities: [
        {
          name: identityName,
          credentials: [{ accessKey: accessKeyId, secretKey }],
          actions: [`Read:${bucket}`, `Write:${bucket}`, `List:${bucket}`],
        },
      ],
    }),
  );

const s3ConfigScript = pulumi.interpolate`set -e
docker run --rm -i \\
  -v ${objectStoreConfigVolume.name}:/cfg \\
  ${OBJECT_STORE_CONFIG_INIT_IMAGE} \\
  sh -c 'cat > /cfg/s3.json && chown 1000:1000 /cfg/s3.json && chmod 0600 /cfg/s3.json'
`;

const objectStoreConfigInit = new command.local.Command(
  dockerResourceName(ns, 'object-store') + '-config-init',
  {
    create: s3ConfigScript,
    update: s3ConfigScript,
    stdin: s3ConfigJson,
    triggers: [pulumi.secret(objectStorageSecretKey), worktreeRoot],
  },
  { dependsOn: [objectStoreConfigVolume] },
);

/**
 * Object store SeaweedFS (`weed mini`) — master + volume + filer + S3 trong
 * MỘT process (issue #19). KHÔNG khai `ports`: object store không publish cổng
 * ra host — consumer duy nhất (remote-cache-api) fetch qua alias nội bộ
 * `OBJECT_STORE_HOST_ALIAS` trong network (cùng mô hình no-Traefik của
 * postgres ở trên). Mount config ở `/etc/seaweedfs` che file `s3.json` mặc định
 * của image bằng file do config-init ghi; mount data ở `/data` là nơi weed ghi
 * objects. Readiness resource-owned (`wait: true` — cùng ngữ nghĩa traefik/
 * postgres ở trên): `/healthz` trên cổng S3 không cần auth nên healthcheck
 * `curl` là bằng chứng S3 serving; startPeriod 10s + 12 retries × 5s = trần
 * ~70s, waitTimeout 120s dư cho lần boot đầu tải image.
 */
const objectStore = new docker.Container(
  'object-store',
  {
    name: dockerResourceName(ns, 'object-store'),
    image: OBJECT_STORE_IMAGE,
    // Cùng lý do với traefik/postgres: Docker tự start lại sau reboot/restart
    // daemon, `pulumi up` không có diff nào vì hai bên input đều giống nhau.
    restart: 'unless-stopped',
    wait: true,
    waitTimeout: 120,
    labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
    // Entrypoint của image tự su-exec sang user `seaweed`; command chỉ truyền
    // subcommand + cờ (binary `weed` là việc của entrypoint).
    command: [
      'mini',
      '-dir=/data',
      `-s3.config=${OBJECT_STORE_S3_CONFIG_PATH}`,
      '-s3.allowDeleteBucketNotEmpty=false',
    ],
    mounts: [
      {
        source: objectStoreConfigVolume.name,
        target: OBJECT_STORE_CONFIG_MOUNT_TARGET,
        type: 'volume',
      },
      {
        source: objectStoreDataVolume.name,
        target: OBJECT_STORE_DATA_MOUNT_TARGET,
        type: 'volume',
      },
    ],
    networksAdvanced: [{ name: network.name, aliases: [OBJECT_STORE_HOST_ALIAS] }],
    healthcheck: {
      tests: ['CMD', 'curl', '-fsS', `http://127.0.0.1:${OBJECT_STORE_S3_PORT}/healthz`],
      interval: '5s',
      timeout: '3s',
      retries: 12,
      startPeriod: '10s',
    },
  },
  { dependsOn: [objectStoreConfigVolume, objectStoreDataVolume, objectStoreConfigInit] },
);

/**
 * Guard-create bucket `remote-cache` qua container-local shell — kênh là
 * `docker exec` vào đúng container weed, tương đương mô hình tin cậy với bước
 * provision `docker exec` psql: không mở cổng nào ra host, không cần credential
 * host-side ngoài Docker CLI. Idempotent: `s3.bucket.list` đã có bucket thì
 * skip; create lỗi khi bucket đã tồn tại ("bucket already exists") không bao giờ
 * đạt được vì guard chặn trước. `grep -qw` khớp token bucket ở dạng nguyên từ
 * trong output `s3.bucket.list` (dòng dạng `  remote-cache\tsize:...`).
 */
const bucketScript = pulumi.interpolate`set -e
docker exec ${objectStore.name} sh -c 's3.bucket.list 2>/dev/null | grep -qw ${OBJECT_STORE_BUCKET} || echo "s3.bucket.create -name ${OBJECT_STORE_BUCKET}" | weed shell'
`;

const objectStoreBucket = new command.local.Command(
  dockerResourceName(ns, 'object-store') + '-bucket',
  {
    create: bucketScript,
    update: bucketScript,
    triggers: [worktreeRoot],
  },
  { dependsOn: [objectStore] },
);

/**
 * Outputs của platform stack — đây là CONTRACT với `home-deploy`, mô tả ở
 * `platform-outputs-contract` của `@ecoma-io/deployment`. Không secret nào được export.
 */
export const namespace = ns;
export const networkName = network.name;
export const postgresHost = POSTGRES_HOST_ALIAS;
export const postgresPort = POSTGRES_INTERNAL_PORT;
export const objectStorageHost = OBJECT_STORE_HOST_ALIAS;
export const objectStoragePort = OBJECT_STORE_S3_PORT;
export const objectStorageBucket = OBJECT_STORE_BUCKET;
// Access key ID là định danh non-secret (hằng số repo) — KHÔNG phải secret key;
// secret key ở stack config, không bao giờ ở outputs.
export const objectStorageAccessKeyId = OBJECT_STORE_ACCESS_KEY_ID;

/**
 * Id hai `command.local.Command` của object store — platform trước đây không
 * export gì cho command (không tạo Docker resource tồn lại), export để resource
 * được quan sát trong `pulumi stack output` (cùng pattern
 * `provisionCommandName`/`migrateCommandName` của remote-cache-api-deploy).
 * Giá trị không mang secret.
 */
export const objectStoreConfigInitCommandName = objectStoreConfigInit.id;
export const objectStoreBucketCommandName = objectStoreBucket.id;

/**
 * Host port Docker đã cấp cho Traefik HTTPS.
 *
 * `extractTraefikHostPort` FAIL-CLOSED khi Docker chưa cấp port, nên consumer
 * không bao giờ nhận `undefined` rồi sinh ra `fbi.com:undefined`.
 */
export const traefikHostPort = pulumi.output(traefik.ports).apply(extractTraefikHostPort);

export const rootHostname = LOCAL_ROOT_HOSTNAME;
