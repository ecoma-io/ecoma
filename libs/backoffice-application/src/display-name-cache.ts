/**
 * Cache `displayName` theo `sub` của BFF — TTL ngắn (~120s), mức module.
 *
 * ## Vì sao cache isolate memory mà không vi phạm invariant 12
 *
 * Cùng lập luận với JWKS cache của `backoffice-infrastructure` (`auth/jwks.ts`):
 * invariant 12 cấm **correctness** phụ thuộc isolate-global state. Cache tên
 * hiển thị thỏa điều kiện đó theo cả hai hướng:
 *
 * - Cache **đủ** thì không đổi kết quả — tên hiển thị là dữ liệu *presentation*:
 *   đọc từ cache hay đọc từ `account` cho cùng một giá trị trong TTL. Độ tươi
 *   tối đa của tên là TTL (issue #325: "đổi tên ở account, backoffice nhìn thấy
 *   ở lần đọc kế tiếp" — không có event đồng bộ, TTL là chính sách đồng bộ).
 * - Cache **thiếu** (isolate mới, TTL hết) thì đọc từ `account` — đường duy nhất
 *   mà merge ở `staff.get` phụ thuộc là batch call, không phải memory.
 *
 * Khác với cache JWKS, dữ liệu ở đây **thay đổi được** (user tự đặt/đổi tên).
 * Vì vậy TTL ngắn hơn nhiều (120s so với 600s): đủ ngắn để một lần đổi tên
 * hiện ở sổ staff trong vòng vài phút; đủ dài để một lần mở sổ với N staff
 * chỉ tạo một batch call thay vì N.
 *
 * ## Chính sách cache `null`
 *
 * `displayName: null` ("chưa đặt tên") cũng được cache — nhưng **không quá một
 * TTL** kể từ lần fetch, dù lần đọc sau đó có hit hay không. Lý do: null là
 * trạng thái khởi đầu của onboarding; nếu null được refresh trượt (mỗi hit nối
 * dài TTL) thì một user vừa đặt tên có thể bị kẹt ở màn onboarding lâu hơn
 * TTL thật. Đánh đổi được ghi: một sub chưa đặt tên tần suất đọc cao tạo một
 * batch call mỗi TTL — chấp nhận được vì batch là **một** call cho cả sổ.
 */

/** TTL của cache (giây). Export để test khoá bất biến "dương, trong khoảng ngắn". */
export const DISPLAY_NAME_CACHE_TTL_SECONDS = 120;

/** Một entry cache: giá trị + mốc hết hạn tuyệt đối (epoch ms). */
interface DisplayNameCacheEntry {
  readonly displayName: string | null;
  /** Mốc hết hạn — giá trị `null` bị xoá tại đúng mốc này, không được nối dài. */
  readonly expiresAtMs: number;
}

/** Cache theo sub, mức module (isolate scope — cùng ý nghĩa với JWKS cache). */
const cacheBySub = new Map<string, DisplayNameCacheEntry>();

/**
 * Đọc `displayName` đã cache cho một sub.
 *
 * @returns Giá trị đã cache (có thể là `null`), hoặc `undefined` khi cache
 *   không còn giá trị tươi cho sub đó.
 */
export function cachedDisplayName(sub: string, nowMs: number): string | null | undefined {
  const entry = cacheBySub.get(sub);
  if (entry === undefined) {
    return undefined;
  }
  if (nowMs >= entry.expiresAtMs) {
    // Xoá tại chỗ thay vì chờ lazy-read sau: giữ map không phình vô hạn giữa
    // các lần isolate phục vụ nhiều request.
    cacheBySub.delete(sub);
    return undefined;
  }
  return entry.displayName;
}

/**
 * Ghi kết quả một lần batch call vào cache.
 *
 * ⚠️ Một entry **đã có sẵn** (tươi) cho sub đó được **ghi đè** bằng giá trị
 * mới: batch call là dữ liệu mới nhất từ authority, không có trường hợp nào
 * cache cũ "tươi hơn" response vừa về.
 *
 * ⚠️ `nowMs` do caller truyền (cùng mốc với lần đọc), không đọc đồng hồ ở đây —
 * hàm thuần theo thời gian truyền vào, test không phụ thuộc `Date.now` thật.
 */
export function storeDisplayNames(
  entries: ReadonlyArray<{ readonly sub: string; readonly displayName: string | null }>,
  nowMs: number,
): void {
  const expiresAtMs = nowMs + DISPLAY_NAME_CACHE_TTL_SECONDS * 1_000;
  for (const entry of entries) {
    cacheBySub.set(entry.sub, { displayName: entry.displayName, expiresAtMs });
  }
}

/** Xoá toàn bộ cache — đường reset duy nhất cho unit test. */
export function resetDisplayNameCacheForTests(): void {
  cacheBySub.clear();
}
