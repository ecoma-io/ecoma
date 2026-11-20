/**
 * Lane connectivity staging (issue #349, criterion "Tunnel + VPC Service hoạt
 * động"): tạo Workers VPC Service TCP trỏ tới origin PostgreSQL staging qua
 * Cloudflare Tunnel — đúng bảng ownership §9.1 `02-delivery.md`: hàng
 * "Workers VPC Service + Tunnel" thuộc Wrangler, `service_id` là output cho
 * wiring Hyperdrive phía sau (#350; config Hyperdrive là Pulumi — Wrangler
 * KHÔNG tạo config, `02` §9.1 hàng "Hyperdrive config").
 *
 * Platform fact VP4 (`04-platform-facts.md`): verified 2026-11-20 trên pin
 * wrangler 4.165.0 — `wrangler vpc` tồn tại (open beta) với subcommand
 * `wrangler vpc service create <name>`; `--tunnel-id` là BẮT BUỘC (service
 * gắn vào một Cloudflare Tunnel có sẵn) và stdout in dòng
 * `✅ Created VPC service: <service_id>`. TODO cũ trong
 * `deploys/staging-pg-host/index.ts` nói lệnh "chưa tồn tại" đã STALE.
 *
 * Ranh giới của lane này (mỗi ranh giới một owner khác, KHÔNG làm thay):
 * - Cloudflare Tunnel resource + `cloudflared` chạy trên VPS (#349): lane
 *   TIÊU THỤ `--tunnel-id` — host chưa provision là thiếu tunnel-id, và
 *   fail-closed ở đây chính là refusal "host #349 chưa có".
 * - DNS CNAME `pg-staging.ecoma.io.vn`: unit DNS của `platform-deploy` —
 *   lane chỉ nhận hostname làm input, không tạo record.
 * - Hyperdrive config: Pulumi (#350) — lane chỉ expose `service_id`.
 *
 * Fail-closed đối xứng `worker-secrets.ts`: cặp credential control-plane của
 * lane staging `ECOMA_CLOUDFLARE_STAGING_API_TOKEN` + `ECOMA_CLOUDFLARE_STAGING_ACCOUND_ID`
 * (§6.12, qua `resolveSecretRunEnv('staging', …)` — credential chỉ tồn tại
 * trong env của subprocess wrangler, KHÔNG BAO GIỜ qua argv); identity
 * staging bắt buộc là tên service có prefix `stg-` (cùng quy ước identity với
 * Worker secret pipeline, tái sử dụng `classifyWorkerName`); thiếu bất kỳ
 * input bắt buộc nào là TỪ CHỐI trước khi wrangler chạy. Không có secret giá
 * trị nào đi qua đường này (origin hostname/tunnel-id không phải secret) nên
 * không cần lớp redaction như worker-secret — token vẫn nằm ngoài argv/stdout.
 *
 * `--type tcp` là CỐ ĐỊNH của lane (VP2/VP3: TCP database đi qua Hyperdrive);
 * `--app-protocol` mặc định `postgresql`, `--tcp-port` mặc định 5432 — đây là
 * lane PostgreSQL staging, không phải lane generic. TLS không truyền cờ:
 * mặc định API `verify_full` (VP3); posture TLS production là mục "Chưa chốt"
 * (`01` §2) và được đo thật ở Spike S1.
 */

import { exec, type ExecResult } from '@ecoma-io/deployment';

import { classifyWorkerName, resolveSecretRunEnv } from './worker-secrets.ts';

/** Giao thức app TCP hợp lệ của VPC service — choices thật của wrangler 4.165.0 (VP3). */
export type VpcAppProtocol = 'postgresql' | 'mysql';

/** Input bắt buộc của một lần tạo VPC service staging. */
export interface VpcServiceInput {
  /** Tên service — identity staging bắt buộc prefix `stg-` (guard `classifyWorkerName`). */
  name: string;
  /** UUID Cloudflare Tunnel có sẵn — wrangler bắt buộc `--tunnel-id`. */
  tunnelId: string;
  /** Hostname origin PG (DNS record thuộc unit DNS platform-deploy — chỉ tiêu thụ). */
  hostname: string;
  /** Port TCP origin — mặc định 5432 (PostgreSQL). */
  tcpPort: number;
  /** App protocol — mặc định `postgresql` (lane PG staging). */
  appProtocol: VpcAppProtocol;
}

/** Deps inject để spec chạy không cần wrangler/token thật. */
export interface VpcServiceDeps {
  execFn: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ExecResult;
}

const defaultDeps: VpcServiceDeps = {
  execFn: (command, args, cwd, env) => exec(command, args, cwd, env),
};

/** UUID v4 — hình dạng `--tunnel-id` mà wrangler nhận (UUID của Cloudflare Tunnel). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Hostname origin: label DNS ASCII, không scheme, không khoảng trắng, không path. */
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu;

/** Kiểm UUID tunnel fail-closed — sai định dạng là typo, chặn trước khi wrangler chạy. */
export function validateTunnelId(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new Error(
      `invalid tunnel id "${raw}" — expected a UUID (wrangler vpc service create requires --tunnel-id)`,
    );
  }
  return raw;
}

/** Kiểm hostname origin fail-closed — không scheme, không path, không khoảng trắng. */
export function validateHostname(raw: string): string {
  if (!HOSTNAME_RE.test(raw)) {
    throw new Error(
      `invalid origin hostname "${raw}" — expected a bare DNS hostname (no scheme, path or port)`,
    );
  }
  return raw;
}

/** Kiểm TCP port — số nguyên 1..65535. */
export function validateTcpPort(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535) {
    throw new Error(`invalid TCP port ${raw} — expected an integer in 1..65535`);
  }
  return raw;
}

/**
 * Đối số wrangler cho một lần tạo service: `--type tcp` cố định của lane,
 * `--app-protocol`/`--tcp-port` tường minh dù đang dùng giá trị mặc định —
 * argv tự đọc được là argv đúng, không phụ thuộc default phía wrangler.
 */
export function buildVpcServiceCreateArgs(input: VpcServiceInput): string[] {
  return [
    'vpc',
    'service',
    'create',
    input.name,
    '--type',
    'tcp',
    '--tunnel-id',
    validateTunnelId(input.tunnelId),
    '--hostname',
    validateHostname(input.hostname),
    '--tcp-port',
    String(validateTcpPort(input.tcpPort)),
    '--app-protocol',
    input.appProtocol,
  ];
}

/**
 * Parse `service_id` khỏi stdout thật của wrangler (`✅ Created VPC service:
 * <id>`, đo trên wrangler 4.165.0). Thiếu dòng là wrangler đổi format output —
 * fail-closed thay vì trả service_id rỗng cho wiring Hyperdrive phía sau.
 */
export function parseServiceId(stdout: string): string {
  const match = /✅ Created VPC service: (\S+)/u.exec(stdout);
  const serviceId = match?.[1];
  if (serviceId === undefined || serviceId.length === 0) {
    throw new Error(
      'wrangler did not report a service_id in its output (expected line ' +
        '"✅ Created VPC service: <id>") — refusing to emit a service_id contract from ' +
        'unrecognized output',
    );
  }
  return serviceId;
}

/**
 * Chạy MỘT lần tạo VPC service staging.

 * Thứ tự kiểm trước khi wrangler chạy: identity `stg-` trên tên service →
 * validate tunnel-id/hostname/port → inventory token → wrangler (argv chứa
 * toàn bộ input; token CHỈ trong env subprocess). Wrangler chạy xong phải vẫn
 * parse được service_id khỏi stdout — output contract cho wiring Hyperdrive
 * #350. Bất kỳ bước nào fail là dừng với thông điệp tiếng Anh tường minh.
 */
export function createStagingVpcService(
  input: VpcServiceInput,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: VpcServiceDeps = defaultDeps,
): { serviceId: string; args: string[] } {
  if (classifyWorkerName(input.name) !== 'staging') {
    throw new Error(
      `vpc service name "${input.name}" is not a staging identity (expected prefix "stg-") — ` +
        'refusing to create a VPC service outside the staging scope',
    );
  }
  const args = buildVpcServiceCreateArgs(input);
  const { env } = resolveSecretRunEnv('staging', sourceEnv);
  const result = deps.execFn('npx', ['wrangler', ...args], process.cwd(), env);
  if (result.status !== 0) {
    const reason =
      result.error?.message ??
      (result.signal !== undefined && result.signal !== null
        ? `killed by signal ${result.signal}`
        : result.stderr.trim() === ''
          ? 'no output'
          : result.stderr.trim());
    throw new Error(`wrangler vpc service create ${input.name} failed: ${reason}`);
  }
  return { serviceId: parseServiceId(result.stdout), args };
}
