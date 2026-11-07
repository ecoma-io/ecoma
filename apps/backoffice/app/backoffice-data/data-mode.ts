/**
 * Quyết định chế độ dữ liệu của backoffice, thuần và không phụ thuộc runtime.
 *
 * Đây là **một nơi duy nhất** quyết định mock có được bật hay không. Tách khỏi
 * composable để unit test được toàn bộ matrix mà không cần dựng Nuxt, và để mọi
 * call-site dùng chung một luật thay vì tự suy luận môi trường.
 *
 * Luật là fail-closed: chỉ đúng chuỗi `'prototype'` mới bật mock. Mọi giá trị
 * khác — `undefined`, `null`, số, boolean, chuỗi sai chính tả, sai hoa/thường,
 * có khoảng trắng thừa — đều rơi vào `'unavailable'`. Nhờ vậy một `vars` bị đặt
 * sai ở Production không thể vô tình bật fixture, và việc gõ `'Prototype'` hay
 * `'prototype '` cũng không mở cổng.
 *
 * Giá trị đầu vào chỉ đến từ `runtimeConfig.public` (deployment configuration).
 * Không có nhánh nào đọc query param, cookie, header, localStorage hay hostname.
 */

/** Giá trị duy nhất của `runtimeConfig.public.backofficeDataMode` bật mock. */
export const BACKOFFICE_PREVIEW_DATA_MODE = 'prototype' as const;

/** Giá trị của `runtimeConfig.public.backofficeDataMode` bật adapter thật. */
export const BACKOFFICE_REALTIME_DATA_MODE = 'realtime' as const;

/**
 * Giá trị cấu hình nghĩa là **không** bật mock — mặc định của
 * `runtimeConfig.public.backofficeDataMode` và là giá trị khai ở lane
 * Production.
 *
 * Ba giá trị hợp lệ của `NITRO_PUBLIC_BACKOFFICE_DATA_MODE` là `'prototype'`
 * (bật mock), `'realtime'` (bật adapter thật) và `'disabled'` (không bật);
 * đọc file này là biết hết tập giá trị, không phải tra `nuxt.config.ts`/`wrangler.jsonc`.
 * Mọi giá trị khác — kể cả gõ sai `'disabled'` — fail closed về `'unavailable'`.
 */
export const BACKOFFICE_DATA_MODE_DISABLED = 'disabled' as const;

/**
 * Chế độ đã được phân giải, dùng làm đầu vào cho điểm chọn adapter.
 *
 * Vế `typeof BACKOFFICE_PREVIEW_DATA_MODE` thay vì literal `'prototype'`: đổi giá
 * trị hằng thì union đổi theo, nên `resolveBackofficeDataMode` và `adapter.ts`
 * không thể lệch khỏi hằng mà vẫn typecheck. Viết literal ở đây thì một lần đổi
 * giá trị hằng sẽ làm nhánh mock biến mất ở **mọi** lane mà không có tín hiệu nào
 * (fail-closed nên không lộ dữ liệu, nhưng mất preview im lặng).
 *
 * `'unavailable'` vẫn là literal vì nó **không** phải giá trị cấu hình: nó là
 * trạng thái fail-closed khi cấu hình thiếu/sai, không lane nào khai nó.
 */
export type BackofficeDataMode =
  | typeof BACKOFFICE_PREVIEW_DATA_MODE
  | typeof BACKOFFICE_REALTIME_DATA_MODE
  | 'unavailable';

/**
 * Phân giải giá trị thô của deployment configuration thành chế độ dữ liệu.
 *
 * @param raw Giá trị đọc từ `runtimeConfig.public.backofficeDataMode`.
 * @returns `BACKOFFICE_PREVIEW_DATA_MODE` chỉ khi `raw` đúng bằng nó; ngược lại
 *          `'unavailable'`.
 */
export function resolveBackofficeDataMode(raw: unknown): BackofficeDataMode {
  if (raw === BACKOFFICE_PREVIEW_DATA_MODE) {
    return BACKOFFICE_PREVIEW_DATA_MODE;
  }

  if (raw === BACKOFFICE_REALTIME_DATA_MODE) {
    return BACKOFFICE_REALTIME_DATA_MODE;
  }

  return 'unavailable';
}
