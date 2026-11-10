/**
 * Contract static-output giữa **lúc build** và **lúc test** của `apps/home`.
 *
 * Suite `tests/static-output.spec.ts` assert trên artifact production thật
 * (`.output/public`). Sau khi gỡ stack @nuxt/content (issue #72), bề mặt
 * prerendered (SSG) còn đúng ba file HTML: homepage hai locale và `404.html`
 * (artifact của route ảo `/en/__not-found`). Một build mà prerender im lặng
 * bỏ sót route (seed sai, hook `prerender:generate` nuốt nhầm lỗi, page bị
 * xoá) vẫn kết thúc "thành công" ở bước build — lỗi chỉ lộ ở test, không ai
 * nhìn ra nguyên nhân build-side. Hai phía dùng chung các hằng số ở đây:
 *
 * - **Test** (`static-output.spec.ts`) so inventory HTML thực đếm được với
 *   danh sách mong đợi qua `assessOutputHtmlInventory`, fail-loud với thông
 *   báo có hướng sửa khi lệch;
 * - mọi thay đổi bề mặt prerendered (thêm route SSG, xoá `404.html`) phải
 *   cập nhật `EXPECTED_OUTPUT_HTML_PATHS` **và** các assertion per-file của
 *   static-output test cùng một lúc — hai nơi nhìn thấy nhau qua file này.
 */

/**
 * Inventory HTML **đầy đủ** mà `.output/public` phải có sau một build thành
 * công. So sánh là **set equality** (dư hoặc thiếu đều vi phạm) để một route
 * mới xuất hiện ngoài ý muốn cũng bị bắt, không chỉ route bị mất.
 */
export const EXPECTED_OUTPUT_HTML_PATHS: readonly string[] = Object.freeze([
  '404.html',
  'en/index.html',
  'vi/index.html',
]);

/**
 * Đánh giá inventory HTML thực đếm được so với danh sách mong đợi.
 *
 * Hàm thuần (không I/O, không phụ thuộc Nuxt/Nitro) để unit test chốt đúng
 * các nhánh: khớp, thiếu file, thừa file, vừa thiếu vừa thừa.
 *
 * @param actualPaths Đường dẫn tương đối `.output/public` của mọi file
 *   `.html` đếm được trong artifact (định dạng phần tử giống
 *   `EXPECTED_OUTPUT_HTML_PATHS`).
 * @returns `null` khi inventory khớp chính xác; khi lệch, một câu tiếng Anh
 *   fail-loud nêu rõ thiếu/thừa gì và hướng chẩn đoán build-side.
 */
export function assessOutputHtmlInventory(actualPaths: readonly string[]): string | null {
  const expected = EXPECTED_OUTPUT_HTML_PATHS;
  const actualSet = new Set(actualPaths);
  const expectedSet = new Set(expected);

  const missing = expected.filter((path) => !actualSet.has(path));
  const extra = actualPaths.filter((path) => !expectedSet.has(path)).toSorted();

  if (missing.length === 0 && extra.length === 0) {
    return null;
  }

  const parts: string[] = [
    `Static output contract violation in .output/public: expected exactly ` +
      `[${expected.join(', ')}] as the complete prerendered HTML inventory.`,
  ];
  if (missing.length > 0) {
    parts.push(
      `Missing: [${missing.join(', ')}] — the prerender step did not emit these ` +
        'routes. Check the prerender seeds in nitro.config.ts (prerender.routes) ' +
        'and the virtual 404 route hook (prerender:routes / prerender:generate); ' +
        'a validate rejection or a swallowed prerender error leaves the build ' +
        'green but the artifact incomplete.',
    );
  }
  if (extra.length > 0) {
    parts.push(
      `Unexpected: [${extra.join(', ')}] — routes prerendered without being part ` +
        'of the contract. Add them to EXPECTED_OUTPUT_HTML_PATHS together with ' +
        'per-file assertions in tests/static-output.spec.ts, or remove the ' +
        'prerender seed that emitted them.',
    );
  }
  return parts.join(' ');
}
