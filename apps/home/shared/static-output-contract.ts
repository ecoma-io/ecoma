/**
 * Contract static-output giữa **lúc build** và **lúc test** của `apps/home`.
 *
 * Suite `tests/static-output.spec.ts` assert trên artifact production thật
 * (`.output/public`), nhưng một build mà `nuxt-content-assets` nuốt lỗi load
 * config (module bắt lỗi và chỉ `warn` - cảnh báo bị Nx ẩn khi task vẫn pass)
 * vẫn sinh ra HTML prerender hoàn chỉnh, chỉ thiếu thư mục `assets/` - lỗi
 * lúc đó chỉ lộ ở test như "expected 0 to be greater than or equal to 6",
 * không ai nhìn ra nguyên nhân build-side. Hai phía dùng chung các hằng số
 * ở đây để:
 *
 * - **Build** (hook `nitro:build:public-assets` trong `modules/static-assets-guard.ts`)
 *   fail LÚC BUILD với thông báo có hướng sửa, thay vì để test mòm mèm đỏ sau đó;
 * - **Test** (`static-output.spec.ts`) báo đúng tiền đề khi glob asset rỗng
 *   trong khi HTML prerender có nội dung - phân biệt "build hỏng" với
 *   "assertion sai".
 */

/**
 * Số file `.svg` tối thiểu mà `.output/public/assets` phải có sau một build
 * thành công. Content tree hiện tại khai 30 cover/inline asset; sàn 6 là
 * dưới cùng biên an toàn - đủ bắt một build mất trắng thư mục assets, không
 * đủ thấp đến mức một build đúng nào cũng vi phạm.
 */
export const MIN_OUTPUT_SVG_ASSETS = 6;

/** Thư mục assets trong output production, tính từ project root của app. */
export const OUTPUT_ASSETS_DIR = '.output/public/assets';

/**
 * Đánh giá số asset thực đếm được so với sàn tối thiểu.
 *
 * Hàm thuần (không I/O, không phụ thuộc Nuxt/Nitro) để hook build và unit
 * test cùng gọi - unit test chốt đúng ba nhánh: thiếu nặng, đủ sàn, vượt sàn.
 *
 * @param actualCount Số file `.svg` đếm được trong thư mục assets output.
 * @returns `null` khi đạt sàn; khi vi phạm, một câu tiếng Anh giải thích
 *   nguyên nhân khả dĩ nhất (module content-assets nuốt lỗi) và cách chẩn
 *   đoán - câu này được throw nguyên văn ở lúc build.
 */
export function assessOutputSvgAssets(actualCount: number): string | null {
  if (actualCount >= MIN_OUTPUT_SVG_ASSETS) {
    return null;
  }
  return (
    `Output assets directory ${OUTPUT_ASSETS_DIR} contains ${actualCount} .svg file(s), ` +
    `but the static-output contract requires at least ${MIN_OUTPUT_SVG_ASSETS}. ` +
    'The prerendered HTML was produced, so the content pipeline ran; an empty or ' +
    'missing assets directory means the nuxt-content-assets module contributed ' +
    'no assets in this build (it swallows content-config load errors with only a ' +
    "warning: look for '[content-assets] Unable to load content config' in the " +
    'untruncated build output of this task) or its cache/public directory was ' +
    'never copied. Re-run the build outside Nx (npx nuxt build in apps/home) to ' +
    'see module warnings directly, and compare the content.config.ts load path ' +
    'between the green and red runs.'
  );
}
