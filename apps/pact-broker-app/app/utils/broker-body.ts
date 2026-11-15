/**
 * Đọc một trường mảng (có thể lồng nhau) từ body JSON có thể là `null`
 * (`.catch(() => null)` của lần đọc body) hoặc mang shape lạ — hợp đồng
 * "shape lạ ⇒ rỗng" của #181: bao giờ cũng trả mảng, không bao giờ ném, nên
 * một body bất thường không bao giờ biến thành error state của `useAsyncState`.
 */
export function arrayField(body: unknown, ...path: string[]): unknown[] {
  let value: unknown = body;
  for (const key of path) {
    if (value === null || typeof value !== 'object') {
      return [];
    }
    value = (value as Record<string, unknown>)[key];
  }
  return Array.isArray(value) ? value : [];
}
