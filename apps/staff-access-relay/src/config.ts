/**
 * Loader cấu hình của relay Worker `staff-access-relay` — wiring: đọc và kiểm
 * `env`, không chứa policy của thuật toán relay (policy sống ở application lib
 * dưới dạng tham số {@link RelayCycleDeps}).
 *
 * ⚠️ **Fail-closed**: thiếu Hyperdrive binding hay Queue binding là `throw` —
 * cron invocation đỏ ở Past events, không "bỏ qua run này" (cùng lập luận với
 * `apps/auth-nonce-prune-job/src/config.ts`: một relay không chạy được là một
 * lỗi cần thấy, không phải một lần bỏ qua; event backlog sẽ được relay lần sau,
 * nhưng không thấy được rằng relay đang hỏng thì không ai sửa).
 *
 * ⚠️ Message lỗi chỉ nêu **tên binding**, không bao giờ giá trị — connection
 * string của Hyperdrive là admin-path credential (SR-001).
 */

import { backoffDelayMs, type QueuePublisher } from '@ecoma-io/staff-access-relay-application';

/**
 * Pattern của `env` Worker: mapping của binding + biến cấu hình Workers, vậy
 * nên khai `unknown` — loader tự kiểm từng binding cần ở runtime.
 */
export type RelayEnv = Readonly<Record<string, unknown>>;

/** Lớp lỗi riêng của cấu hình — để composition root bắt khác với lỗi lớp statement. */
export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayConfigError';
  }
}

/** Tên Hyperdrive binding của `db-staff-access` — role runtime của relay. */
export const DB_STAFF_ACCESS_BINDING = 'DB_STAFF_ACCESS';

/** Tên Queue producer binding — Cloudflare Queues của entitlement events. */
export const ENTITLEMENT_EVENTS_QUEUE_BINDING = 'ENTITLEMENT_EVENTS_QUEUE';

/** Shape tối thiểu của một Hyperdrive binding ở `env`. */
export interface HyperdriveBindingLike {
  readonly connectionString: string;
}

/**
 * Shape tối thiểu của một Queue producer binding ở `env` — chỉ phần mà relay cần.
 * Cloudflare Queues producer binding có `send(message, opts?)`; `idempotency_key`
 * truyền qua `contentType`/option tùy platform version — adapter ở main.ts quyết
 * định cách truyền, loader chỉ kiểm `send` là function.
 */
export interface QueueBindingLike {
  readonly send: (message: unknown, options?: unknown) => Promise<void>;
}

/**
 * Nạp và kiểm cấu hình của Worker: Hyperdrive + Queue binding bắt buộc.
 *
 * ⚠️ Không default ngầm: một binding missing là `throw`, không "skip run này".
 *
 * @throws {RelayConfigError} Khi thiếu bất kỳ binding nào hoặc binding sai shape.
 */
export function loadRelayConfig(env: RelayEnv): {
  readonly db: HyperdriveBindingLike;
  readonly queue: QueueBindingLike;
} {
  return {
    db: requireHyperdriveBinding(env, DB_STAFF_ACCESS_BINDING),
    queue: requireQueueBinding(env, ENTITLEMENT_EVENTS_QUEUE_BINDING),
  };
}

/**
 * Đọc một Hyperdrive binding bắt buộc: object mang `connectionString` string khác
 * rỗng. Giá trị `connectionString` không bao giờ rơi ra log hay message lỗi.
 */
function requireHyperdriveBinding(env: RelayEnv, name: string): HyperdriveBindingLike {
  const bindingValue = env[name];
  if (typeof bindingValue !== 'object' || bindingValue === null) {
    throw new RelayConfigError(
      `${name} chua dc gan: Hyperdrive binding thieu trong env cua Worker`,
    );
  }
  const connectionString = (bindingValue as { connectionString?: unknown }).connectionString;
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new RelayConfigError(`${name} khong the doc connectionString (binding sai hinh)`);
  }
  return bindingValue as HyperdriveBindingLike;
}

/**
 * Đọc một Queue producer binding bắt buộc: object mang `send` là function.
 * Binding sai shape là deploy/config lỗi — cùng lớp lỗi với missing.
 */
function requireQueueBinding(env: RelayEnv, name: string): QueueBindingLike {
  const bindingValue = env[name];
  if (typeof bindingValue !== 'object' || bindingValue === null) {
    throw new RelayConfigError(
      `${name} chua dc gan: Queue producer binding thieu trong env cua Worker`,
    );
  }
  const send = (bindingValue as { send?: unknown }).send;
  if (typeof send !== 'function') {
    throw new RelayConfigError(`${name} khong co send() (binding sai hinh)`);
  }
  return bindingValue as QueueBindingLike;
}

export { backoffDelayMs };
export type { QueuePublisher };
