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
}

/** Environment key chứa `fbi.com:<traefik-host-port>` sau khi platform up. */
export const ROOT_HOST_ENV_KEY = 'ROOT_HOST';

/**
 * Environment key canonical dành cho system E2E suite: `host[:port]` gốc của
 * mọi origin `https://<sub>.<host[:port]>` sau khi platform up.
 *
 * Giá trị GIỐNG HỆT `ROOT_HOST` (`outputs.rootHost` = `fbi.com:<port>`) —
 * hai key là hai tên gọi cho cùng một giá trị vì consumer khác nhau đọc hai
 * khái niệm khác nhau: `ROOT_HOST` là key hiện có của consumer cũ
 * (home-deploy v.v.), còn `ROOT_DOMAIN` là key E2E-facing mà suite hệ thống
 * đọc để suy root domain. Không xoá `ROOT_HOST`: các consumer hiện có vẫn
 * đang đọc key đó.
 */
export const ROOT_DOMAIN_ENV_KEY = 'ROOT_DOMAIN';

/** Environment key chứa mật khẩu PostgreSQL local được sinh cho E2E/dev tools. */
export const POSTGRES_PASSWORD_ENV_KEY = 'POSTGRES_PASSWORD';

/**
 * Environment keys mà orchestration local flow sở hữu trong `.env`.
 *
 * Bước platform up (sau khi `pulumi up` xanh) chỉ được ghi/đè đúng các key này;
 * mọi key khác trong file `.env` hiện có phải giữ nguyên. `.env` là artifact
 * tiện dụng — nguồn sự thật cho giá trị triển khai là Pulumi outputs.
 */
export const LOCAL_ENV_OWNED_KEYS = [
  ROOT_HOST_ENV_KEY,
  ROOT_DOMAIN_ENV_KEY,
  POSTGRES_PASSWORD_ENV_KEY,
] as const;

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
