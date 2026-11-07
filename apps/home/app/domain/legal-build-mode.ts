/**
 * Build-time gate cho draft preview của collection `legal`.
 *
 * Đây là **cờ build**, không phải cờ runtime: nó được đọc đúng một lần khi
 * module được load (build trên Node — prerender query chạy trong tiến trình
 * build), đóng băng thành hằng của bundle, và KHÔNG BAO GIỜ suy từ hostname
 * hay request nào. Hai giá trị:
 *
 * - `true` — **staging build**: draft được prerender, hiển thị kèm nhãn Draft
 *   + review status; noindex của staging vẫn do `NITRO_PUBLIC_NO_INDEX` và
 *   `_headers` đảm nhiệm (không đổi).
 * - `false` — **production build** (mặc định): draft bị loại trước khi route
 *   prerender, không vào manifest, không có HTML — direct route trả 404 qua
 *   middleware gate `prerendered-content-404.ts` (path không có trong
 *   manifest) và không bao giờ tới query.
 *
 * Fail-closed by design: biến môi trường **thiếu, sai hoặc rỗng** → `false`.
 * Chỉ đúng chuỗi `"true"` (wrangler/staging workflow chỉ cần đặt đúng một
 * giá trị này) bật preview. Production không đặt biến — không đường nào
 * production build nhìn thấy draft.
 *
 * Vì sao env mà không phải wrangler env hay runtime config: draft exclusion
 * phải xảy ra ở **build** (prerender là lúc HTML được sinh ra và manifest
 * được đóng băng), còn runtime config là thứ của request. Staging build và
 * production build dùng cùng lệnh `nx build` — cờ đi qua biến môi trường
 * `NUXT_PUBLIC_LEGAL_INCLUDE_DRAFTS` (Nitro `applyEnv` map biến có prefix
 * `NUXT_` vào `runtimeConfig.public` — cùng cơ chế `NITRO_PUBLIC_NO_INDEX`),
 * workflow staging set nó trước khi build, production rebuild từ tag không set.
 */

/**
 * Cờ draft-preview của build hiện tại — đọc một lần lúc module load.
 *
 * `process.env` trên Node build là nguồn duy nhất; Worker runtime không bao
 * giờ re-evaluate vì giá trị đã đóng băng vào bundle prerender. Raw string
 * được so khớp strict — `destr()`-style lỏng lẻo (`"1"`, `"yes"`) không được
 * chấp nhận để không có đường nào bật nhầm preview.
 */
export function legalIncludeDrafts(): boolean {
  return process.env['NUXT_PUBLIC_LEGAL_INCLUDE_DRAFTS'] === 'true';
}
