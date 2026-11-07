import type { Hyperdrive } from '@cloudflare/workers-types';

/**
 * Tên binding Hyperdrive tới `db-account`.
 *
 * Khớp `wrangler.jsonc` và `03-operations.md` §1. Không có `id` trong code: `id`
 * của Hyperdrive config là định danh hạ tầng theo môi trường và chỉ tồn tại trong
 * `wrangler.jsonc` (invariant 4 — application code chỉ chứa **tên** binding, không
 * host/port/user/node identity).
 */
export const DB_ACCOUNT_BINDING = 'DB_ACCOUNT';

/** Binding Worker mà app này thực sự dùng. */
interface CloudflareEnv {
  /** Hyperdrive tới `db-account`. Xem {@link DB_ACCOUNT_BINDING}. */
  DB_ACCOUNT?: Hyperdrive;
}

/** Phần `runtimeConfig` do Nitro preset Cloudflare bổ sung. */
interface CloudflareRuntimeConfig {
  cloudflare?: {
    /** Binding Worker. */
    env?: CloudflareEnv;
  };
}

/**
 * Đọc binding Hyperdrive `DB_ACCOUNT` ra khỏi `runtimeConfig` của Nitro.
 *
 * ## Vì sao nhận `unknown` thay vì khai kiểu cho `runtimeConfig`
 *
 * Binding khai trong `wrangler.jsonc` được Nitro preset `cloudflare-module` đẩy
 * vào `runtimeConfig.cloudflare.env` lúc runtime, nhưng `cloudflare` **không** nằm
 * trong `runtimeConfig` khai ở `nuxt.config.ts` — nên kiểu Nuxt sinh ra cho
 * `useRuntimeConfig()` là `{}` ở nhánh này và đọc thẳng sẽ lỗi
 * `Property 'env' does not exist on type '{}'`.
 *
 * Đã thử và **không** dùng:
 * - `as any` / ép kiể tại từng route: làm hỏng fail-closed, vì mất kiểm hình dạng thật.
 * - Module augmentation của `@nuxt/schema`: `tsconfig.server.json` bật `skipLibCheck`
 *   và file `.d.ts` khai augmentation không được typecheck cùng các route đang dùng.
 *
 * Nhận `unknown` ở đây giữ đúng ba tính chất: một nơi khai để sửa, không ép kiểu ở
 * call site, và vẫn kiểm hình dạng thật của binding trước khi dùng.
 *
 * ⚠️ `unknown` không phải là lười — đây là ranh giới nơi dữ liệu từ **hạ tầng** đi
 * vào app: không có gì đảm bảo `wrangler.jsonc` và code deploy cùng nhau. Vì vậy
 * hàm kiểm hình dạng thật thay vì tin kiểu.
 *
 * @param runtimeConfig - Giá trị trả về từ `useRuntimeConfig()`.
 * @returns Binding, hoặc `null` khi môi trường không khai báo nó (hoặc khai sai
 *   hình dạng). `null` **không phải** "chạy được không cần DB": mọi caller đều fail
 *   closed khi nhận `null` — `/ready` trả 503, và contract status trả 503 chứ
 *   **không** trả `not_found`.
 */
export function accountHyperdrive(runtimeConfig: unknown): Hyperdrive | null {
  const env = (runtimeConfig as CloudflareRuntimeConfig | undefined)?.cloudflare?.env;
  const binding = env?.[DB_ACCOUNT_BINDING];
  // Không dùng `instanceof` hay duck-type sâu: object binding của Workers đi qua
  // shim nên không có prototype ổn định, nên chỉ kiểm `connectionString` là chuỗi.
  if (typeof (binding as Hyperdrive | undefined)?.connectionString !== 'string') {
    return null;
  }
  return binding as Hyperdrive;
}
