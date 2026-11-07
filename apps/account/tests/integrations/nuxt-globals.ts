/**
 * `useRuntimeConfig` — auto-import của Nitro, không tồn tại ngoài runtime Nitro.
 *
 * Middleware và route của `server/` gọi `useRuntimeConfig()` mà không import: khi
 * chạy bằng Vitest (không có Nitro), tên đó là `ReferenceError` đúng ở dòng đầu
 * tiên chạm tới nó. Helper này cung cấp:
 *
 * 1. **Khai báo global** để `tsc -p tsconfig.db.json` (target `typecheck-db`)
 *    typecheck được các file `server/` mà spec import — không có khai báo này,
 *    `useRuntimeConfig` là `TS2304` và target đỏ trước khi test kịp chạy.
 * 2. **Stub runtime** trả cấu hình do test chỉ định — test đổi object giữa các
 *    case (thiếu secret, thiếu binding) mà không cần import lại module.
 *
 * ⚠️ Khai báo global chỉ dành cho **test**. Worker thật lấy config từ Nitro
 * preset (`runtimeConfig` trong `nuxt.config.ts` + Worker Secret); stub ở đây
 * không và không được tồn tại trong bundle production.
 */

/** Phần `runtimeConfig` mà middleware internal-auth và bindings đọc. */
export interface AccountTestRuntimeConfig {
  internalHmacSecret?: unknown;
  internalAuthSkewSeconds?: unknown;
  /** Secret HMAC của OTP — dùng bởi `server/api/auth/*`. */
  otpHmacSecret?: unknown;
  /** Origin của transactional-mail — dùng bởi `server/api/auth/challenge`. */
  mailServiceUrl?: unknown;
  /** Credential HMAC ký cho path Account↔Mail — dùng bởi `server/api/auth/challenge`. */
  mailInternalAuthSecret?: unknown;
  /** Origin của worker auth — dùng bởi `server/api/auth/verify` dựng `confirmUrl`. */
  authIssuer?: unknown;
  cloudflare?: unknown;
}

declare global {
  // Nitro auto-import; ký tự `event` giữ cho khớp call site `useRuntimeConfig(event)`.
  function useRuntimeConfig(event?: unknown): AccountTestRuntimeConfig;
}

/**
 * Cài stub `globalThis.useRuntimeConfig` đọc từ một mutable cell — trả về
 * hàm để test gán lại cấu hình giữa các case mà không phải cài lại.
 */
export function installRuntimeConfigStub(
  initial: AccountTestRuntimeConfig,
): (next: AccountTestRuntimeConfig) => void {
  let current = initial;
  globalThis.useRuntimeConfig = (): AccountTestRuntimeConfig => current;
  return (next: AccountTestRuntimeConfig) => {
    current = next;
  };
}
