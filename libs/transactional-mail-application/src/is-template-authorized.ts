/**
 * Use case authorization theo template — SR-001 authorization table (route "Bước 3b").
 *
 * Principal chỉ được tạo message với logical template đã approve cho chính nó; danh sách
 * đó là **allowlist theo principal**, không phải thuộc tính của template.
 *
 * ⚠️ Allowlist đến từ **config boot-time** (server-controlled): payload của request
 * **không** có đường nào đổi verdict — `template` trong body chỉ được so khớp, không bao
 * giờ được merge vào allowlist.
 *
 * ⚠️ `403` dùng chung một message hằng cho "không có trong allowlist" — tầng route **không**
 * phân biệt "template của principal khác" với "template chưa approve", vì sự phân biệt đó
 * là oracle liệt kê catalog template. Verdict ở đây chỉ là boolean; message và status code
 * HTTP là việc của tầng route.
 *
 * Hàm **thuần**, không I/O và không biết template nào đang active trong catalog: một
 * template chưa approve bị chặn ở đây ngay cả khi nó không tồn tại — `404 template_not_found`
 * chỉ dành cho template ĐÃ được approve nhưng không còn version active (quyết định bởi vị
 * trí bước authorize **trước** use case tạo message ở tầng route).
 */

/**
 * Kết quả authorization theo template của một principal.
 *
 * Trả verdict **không mang lý do chi tiết**: mọi nhánh deny là cùng một `403` ở tầng route,
 * nên kết quả cũng không cung cấp thêm thông tin nào để phân biệt hai trường hợp deny.
 */
export type IsTemplateAuthorizedResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'template-not-allowed' };

/**
 * Kiểm principal có được dùng `template` không, theo allowlist của chính principal đó.
 *
 * ⚠️ Principal **không có entry** trong allowlist và principal có entry **rỗng** là **cùng
 * một kết quả deny** (default-deny, fail-closed): không có giá trị "cho phép tất cả", một
 * allowlist mở là bỏ authorization.
 */
export function isTemplateAuthorized(input: {
  /** Principal do server kiểm soát — đã authenticate ở tầng trên, không lấy từ request. */
  readonly principalId: string;
  /** Logical template từ request, đã qua validate shape ở tầng trên. */
  readonly template: string;
  /** Allowlist theo principal — config boot-time, server-controlled. */
  readonly templatesByPrincipal: ReadonlyMap<string, readonly string[]>;
}): IsTemplateAuthorizedResult {
  const allowedTemplates = input.templatesByPrincipal.get(input.principalId);
  if (allowedTemplates === undefined || !allowedTemplates.includes(input.template)) {
    return { allowed: false, reason: 'template-not-allowed' };
  }
  return { allowed: true };
}
