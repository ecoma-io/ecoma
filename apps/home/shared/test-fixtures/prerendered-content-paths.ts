/**
 * Stub virtual module `#build/prerendered-content-paths` cho Vitest — ngoài
 * Nitro không có hook `nitro:config` nào chạy, nên test luôn thấy manifest
 * rỗng (khác với Worker production nơi manifest được lấp sau prerender).
 * Nội dung phải khớp đúng shape mà `server/middleware/prerendered-content-404.ts`
 * consume (một named export duy nhất).
 */
export const PRERENDERED_CONTENT_PATHS: readonly string[] = [];
