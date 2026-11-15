/**
 * Contract outputs giữa `platform-deploy` và `home-deploy`.
 *
 * Hai stack Pulumi giao tiếp qua Pulumi stack reference/outputs, không qua
 * shared database hay shared resource. Contract này là hình dạng dữ liệu mà
 * consumer (`home-deploy`) gắn type qua `requirePlatformOutput` — lệch tên/khoá
 * bị bắt ở compile time phía consumer; phía producer (platform) outputs là
 * `export const` với type suy ra, nên gỡ một khoá bên producer chỉ lộ ra ở
 * runtime qua `requirePlatformOutput` (fail-closed) chứ không phải compile time
 * hai chiều.
 *
 * Nguyên tắc:
 * - Không secret nào nằm trong outputs: username/password PostgreSQL đi qua
 *   Pulumi config của consumer (plaintext cho local stack; secret cho staging/
 *   production), không qua đường stdout/outputs. Platform
 *   xuất đúng những thông tin non-secret consumer cần để kết nối và route.
 * - Mọi giá trị là kết quả ĐO ĐƯỢC sau khi resource thật sẵn sàng (đặc biệt
 *   `traefikHostPort` — Docker cấp port động tại create time).
 * - Local-only: contract này phục vụ stack `local-<namespace>`; staging/
 *   production không dùng Docker runtime nên không đi qua đây.
 */

/** Loại từng output của platform stack — hình dạng đủ cho consumer đọc. */
export interface PlatformOutputs {
  /** Namespace worktree đã dùng để đặt tên mọi resource platform. */
  namespace: string;
  /** Tên Docker network platform — consumer join network này, không tự tạo. */
  networkName: string;
  /** Service alias của PostgreSQL trong network (hostname nội bộ ổn định). */
  postgresHost: string;
  /** Cổng nội bộ của PostgreSQL trong network — không phải host port. */
  postgresPort: number;
  /**
   * Host port thực tế Docker đã cấp cho Traefik HTTPS (443 nội bộ).
   * Số duy nhất phía client cần để tạo URL `https://fbi.com:<port>`.
   */
  traefikHostPort: number;
  /** Hostname mà Traefik route — consumer (`home-deploy`) đọc để dựng router rule. */
  rootHostname: string;
  /** Service alias của object store (SeaweedFS, #19) trong network — hostname nội bộ ổn định. */
  objectStorageHost: string;
  /** Cổng nội bộ S3 của object store trong network — không phải host port. */
  objectStoragePort: number;
  /** Bucket S3 duy nhất mà remote-cache-api sử dụng (#19). */
  objectStorageBucket: string;
  /**
   * Access key ID của object store — định danh non-secret, cùng hạng với
   * `postgresHost`/username: giá trị hằng số của repo, không phải credential.
   * Secret key tương ứng KHÔNG nằm ở đây — đi qua stack config
   * `objectStorage:remoteCacheSecretKey` của platform (cùng đường với mật khẩu
   * PostgreSQL), đúng nguyên tắc "không secret nào nằm trong outputs" ở trên.
   */
  objectStorageAccessKeyId: string;
}

/** Environment key chứa `fbi.com:<traefik-host-port>` sau khi platform up. */
export const ROOT_HOST_ENV_KEY = 'ROOT_HOST';

/** Environment key chứa mật khẩu PostgreSQL local được sinh cho E2E/dev tools. */
export const POSTGRES_PASSWORD_ENV_KEY = 'POSTGRES_PASSWORD';

/**
 * Environment keys mà orchestration local flow sở hữu trong `.env`.
 *
 * Bước platform up (sau khi `pulumi up` xanh) chỉ được ghi/đè đúng các key này;
 * mọi key khác trong file `.env` hiện có phải giữ nguyên. `.env` là artifact
 * tiện dụng — nguồn sự thật cho giá trị triển khai là Pulumi outputs.
 */
export const LOCAL_ENV_OWNED_KEYS = [ROOT_HOST_ENV_KEY, POSTGRES_PASSWORD_ENV_KEY] as const;

/**
 * Environment keys đã retired — từng được `local-up` ghi vào `.env` nhưng đã
 * bị xoá khỏi tập key sở hữu phía trên.
 *
 * Upsert `.env` gỡ mọi dòng của các key này khỏi file có sẵn tại lần up kế
 * tiếp, để worktree cũ không giữ mãi key thặng dư mà không consumer nào đọc.
 * Khác với tập key sở hữu, key retired KHÔNG được ghi lại — nó chỉ được xoá.
 * (#210: `ROOT_DOMAIN` là alias E2E-facing từng trùng giá trị với `ROOT_HOST`;
 * gộp về một key duy nhất `ROOT_HOST` theo quyết định của chủ repo.)
 */
export const LOCAL_ENV_RETIRED_KEYS = ['ROOT_DOMAIN'] as const;

/** Hostname local mà Traefik route tới home. */
export const LOCAL_ROOT_HOSTNAME = 'fbi.com';

/** Cổng HTTPS nội bộ của Traefik trong platform network. */
export const TRAEFIK_INTERNAL_PORT = 443;

/**
 * Tạo giá trị `ROOT_HOST` từ outputs platform: `fbi.com:<port>`.
 *
 * Port nằm ở URL phía client — Traefik router vẫn match `Host: fbi.com`,
 * không có port trong Host rule. Không bao giờ hard-code port: giá trị chỉ
 * tồn tại sau khi Docker cấp port và Pulumi đã đọc được output.
 */
export function buildRootHost(traefikHostPort: number): string {
  return `${LOCAL_ROOT_HOSTNAME}:${traefikHostPort}`;
}

/**
 * Hostname browser-facing của một service local THEO worktree:
 * `<sub>-<namespace>.<rootHostname>`.
 *
 * #316: hai worktree chạy song song trên cùng browser profile không được chia
 * sẻ cookie — cookie scoping theo hostname (không theo port), nên mọi service
 * browser-facing cần hostname riêng theo namespace worktree. Một nhãn DNS
 * thêm vào (ví dụ `auth-w1a2b3c4d5e6f.fbi.com`) khớp đúng wildcard cert
 * (`*.fbi.com` — SAN chỉ phủ MỘT nhãn thêm) và wildcard DNS public
 * (`*.fbi.com → 127.0.0.1`); apex `fbi.com` (home) KHÔNG qua helper này —
 * home không set cookie nào nên apex giữ chia sẻ giữa các worktree.
 *
 * `namespace` đến từ `worktreeNamespace()` — cơ chế namespace DUY NHẤT; mọi
 * deploy program lẫn E2E helper phải suy origin qua helper này thay vì ghép
 * `<sub>.<rootHostname>` riêng lẻ, để issuer/audience/redirect URI/router
 * rule khớp exact-string với nhau theo cấu trúc.
 *
 * Local-only: staging/production không dùng hostname dạng này.
 */
export function localServiceHostname(sub: string, rootHostname: string, namespace: string): string {
  // Ranh giới contract: đầu vào xấu sinh hostname invalid (router `Host()` lệch,
  // cookie `__Host-` scope sai) — fail-loud thay vì ghép chuỗi hỏng lặng lẽ.
  // `sub`/`namespace` chỉ được phép là ĐÚNG MỘT DNS label (không dấu chấm): lệch
  // hợp đồng này là lỗi của caller, không phải dữ liệu cần phiên dịch.
  for (const [name, value] of [
    ['sub', sub],
    ['rootHostname', rootHostname],
    ['namespace', namespace],
  ] as const) {
    if (value.length === 0) {
      throw new Error(`localServiceHostname: ${name} must not be empty`);
    }
  }
  for (const [name, value] of [
    ['sub', sub],
    ['namespace', namespace],
  ] as const) {
    if (value.includes('.')) {
      throw new Error(
        `localServiceHostname: ${name} "${value}" must be a single DNS label (no dots) — ` +
          'the helper adds exactly one extra label to the root hostname',
      );
    }
  }
  return `${sub}-${namespace}.${rootHostname}`;
}

/**
 * Origin HTTPS browser-facing của một service local theo worktree — ghép
 * hostname qua `localServiceHostname` với port Traefik publish.
 *
 * Dành cho các chuỗi origin browser thực sự mang port (issuer, audience,
 * redirect URI — port 443 không listen nên browser chỉ tới được origin có
 * port). Router rule `Host()` thì match hostname KHÔNG port — dùng
 * `localServiceHostname` cho rule đó, đừng cắt port từ origin.
 */
export function localServiceOrigin(
  sub: string,
  rootHostname: string,
  namespace: string,
  traefikHostPort: number,
): string {
  if (!Number.isInteger(traefikHostPort) || traefikHostPort < 1 || traefikHostPort > 65535) {
    throw new Error(
      `localServiceOrigin: traefikHostPort ${traefikHostPort} is not a valid TCP port (1-65535)`,
    );
  }
  return `https://${localServiceHostname(sub, rootHostname, namespace)}:${traefikHostPort}`;
}

/**
 * Đọc `traefikHostPort` từ output của Pulumi.
 *
 * `@pulumi/docker@5.2.0` không cho "ask" host port trước create: khi
 * `ContainerPort.external` bỏ trống, Docker cấp port rảnh `>= 32768` tại
 * create time và giá trị chỉ đọc lại được qua output `ports` của container
 * SAU khi resource đã up. Helper này fail-closed khi output chưa có — consumer
 * không được tiếp tục với port `undefined` rồi sinh `fbi.com:undefined`.
 */
export function extractTraefikHostPort(
  ports: ReadonlyArray<{ external?: number; internal: number }> | undefined,
): number {
  const https = ports?.find((port) => port.internal === TRAEFIK_INTERNAL_PORT);
  if (
    https?.external === undefined ||
    https.external === null ||
    !Number.isInteger(https.external) ||
    https.external <= 0
  ) {
    throw new Error(
      `Traefik host port not ready in outputs: ` +
        `need ContainerPort(internal=${TRAEFIK_INTERNAL_PORT}) with a valid external, ` +
        `got ${JSON.stringify(ports)}`,
    );
  }
  return https.external;
}
