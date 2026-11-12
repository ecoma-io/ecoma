/**
 * Kiểu môi trường (bindings) của Worker `ecoma-llm-api`.
 *
 * Ba Hyperdrive binding khớp chính xác `wrangler.jsonc` — đổi một phía là phải
 * đổi cả hai phía cùng lúc (hợp đồng đóng băng của Issue #22). Binding là
 * tuỳ chọn kiểu dữ liệu: thiếu binding trong env (vd deploy thiếu binding thật)
 * là trạng thái `missing` của readiness — fail-closed, không bao giờ suy đoán.
 *
 * Kiểu cấu trúc tối thiểu (`connectionString` là thứ driver `pg` cần qua
 * Hyperdrive) — không kéo `@cloudflare/workers-types` vào project.
 */

/** Hyperdrive binding như Worker nhận từ runtime — chỉ `connectionString` được dùng. */
export interface HyperdriveBinding {
  readonly connectionString: string;
}

/** Tên binding tới database gateway (`llm_seller` + tài chính). */
export const BINDING_GATEWAY = 'DB_LLM_GATEWAY';

/** Tên binding tới database tenant (`llm_tenant`). */
export const BINDING_TENANT = 'DB_LLM_TENANT';

/** Tên binding tới database marketplace (`llm_marketplace`). */
export const BINDING_MARKETPLACE = 'DB_LLM_MARKETPLACE';

/** Danh sách binding theo đúng thứ tự khai báo của `wrangler.jsonc`. */
export const BINDING_NAMES = [BINDING_GATEWAY, BINDING_TENANT, BINDING_MARKETPLACE] as const;

/** Tên binding hợp lệ — union literal rút từ `BINDING_NAMES`, không phải string tuỳ ý. */
export type BindingName = (typeof BINDING_NAMES)[number];

/** Shape của `env` mà Worker nhận — mỗi binding có thể vắng mặt ở runtime. */
export interface LlmApiEnv {
  readonly [BINDING_GATEWAY]?: HyperdriveBinding;
  readonly [BINDING_TENANT]?: HyperdriveBinding;
  readonly [BINDING_MARKETPLACE]?: HyperdriveBinding;
}

/**
 * Đọc một binding từ env; trả `null` khi binding thiếu hoặc sai hình —
 * fail-closed cho caller quyết định (readiness: `missing`; catalogue: lỗi).
 * Chi tiết giá trị không bao giờ đi vào log hay lỗi (chỉ tên binding).
 */
export function readBinding(env: LlmApiEnv, name: string): HyperdriveBinding | null {
  const binding: unknown = env[name as keyof LlmApiEnv];
  if (typeof binding !== 'object' || binding === null) {
    return null;
  }
  const connectionString = (binding as { connectionString?: unknown }).connectionString;
  if (typeof connectionString !== 'string' || connectionString === '') {
    return null;
  }
  return binding as HyperdriveBinding;
}
