/**
 * `RateLimitStore` trên D1 — fixed window **bền** theo `App` (FR-021).
 *
 * ⚠️ **Vì sao D1 chứ không phải counter trong memory.** Worker có nhiều isolate; một counter
 * trong memory (a) vừa cho qua vượt ngưỡng khi N isolate chạy đồng thời, (b) mất đếm khi
 * isolate bị recycle, và (c) là node-local state mà invariant của repo cấm. D1 `push` là
 * authority; rate limit mà không bền thì không phải rate limit.
 *
 * ⚠️ **`consume` là MỘT câu lệnh, không phải "đọc rồi tăng".** Hai request đồng thời có thể
 * cùng đọc "còn 1 slot" rồi cùng tiêu — đúng loại read-then-write mà §5.6 cấm ở claim và
 * §6.1 thay bằng guard ở D1. Vì vậy đây là một `INSERT … ON CONFLICT DO UPDATE … WHERE …
 * RETURNING` duy nhất, và "vượt ngưỡng" là kết quả của **câu lệnh** (`RETURNING` không trả
 * hàng) chứ không phải của một nhánh so sánh ở TypeScript.
 *
 * ⚠️ **Khi bị từ chối thì KHÔNG tiêu slot.** Lệnh chỉ ghi khi cửa sổ còn chỗ; nhánh `WHERE`
 * của `DO UPDATE` lọc ra chính request vượt ngưỡng, nên `hits` của nó không tăng. Đây là
 * điều kiện để `429` không trở thành một amplification loop: một client bị chặn mà vẫn bị
 * trừ thêm hạn mức sẽ không bao giờ tự hồi phục.
 */

import type {
  RateLimitConsumeInput,
  RateLimitOutcome,
  RateLimitStore,
} from '@ecoma-io/push-notification-application';

import type { D1DatabaseLike } from './d1-surface';

/** Một hàng `push_rate_limits`. */
interface RateLimitRow {
  readonly app: string;
  readonly window_started_at: number;
  readonly hits: number;
  readonly updated_at: number;
}

/**
 * Câu lệnh nguyên tử của một lần tiêu slot.
 *
 * ⚠️ Ba nhánh, đúng thứ tự:
 *
 * 1. **Chưa có hàng** → `INSERT` với `hits = 1`. Đây là lần tiêu slot đầu tiên của cửa sổ.
 * 2. **Cửa sổ đã đóng** (`window_started_at <= now - windowDurationMs`) → mở cửa sổ mới,
 *    `hits = 1`. Mốc `now` là **thời điểm request**, truyền vào — không phải
 *    `unixepoch('now')` của D1 — vì một test phải điều khiển được cửa sổ.
 * 3. **Cửa sổ còn mở và còn chỗ** (`hits < limit`) → `hits = hits + 1`.
 * 4. Còn lại: `WHERE` của `DO UPDATE` không khớp → **không có hàng nào được `RETURNING`**.
 *
 * ⚠️ `<=` ở điều kiện 2: một cửa sổ dài `w` tính từ `t` đã hết hạn khi `now >= t + w`, tức
 * khi `window_started_at <= now - w`. Dùng `<` sẽ giữ cửa sổ thêm một millisecond và, tệ hơn,
 * làm một cửa sổ `w = 1` không bao giờ mở lại nếu `now` lặn đúng bằng mốc.
 *
 * ⚠️ `DO UPDATE` dùng `excluded.hits` cho nhánh 2 và `hits + 1` cho nhánh 3 — hai giá trị khác
 * nhau, nên `WHERE` phải phân biệt cửa sổ. Viết `hits = excluded.hits` cho cả hai sẽ làm
 * nhánh 3 **không** tiêu slot: mọi request trong cùng cửa sổ sẽ đặt `hits` về 1 và rate limit
 * sẽ không bao giờ chạm ngưỡng.
 */
const CONSUME_SQL = `
INSERT INTO push_rate_limits (app, window_started_at, hits, updated_at)
VALUES (?1, ?2, 1, ?2)
ON CONFLICT (app) DO UPDATE SET
  hits = CASE
    WHEN push_rate_limits.window_started_at <= ?3 THEN 1
    ELSE push_rate_limits.hits + 1
  END,
  window_started_at = CASE
    WHEN push_rate_limits.window_started_at <= ?3 THEN ?2
    ELSE push_rate_limits.window_started_at
  END,
  updated_at = ?2
WHERE
  push_rate_limits.window_started_at <= ?3
  OR push_rate_limits.hits < ?4
RETURNING app, window_started_at, hits, updated_at
`;

export class D1RateLimitStore implements RateLimitStore {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async consume(input: RateLimitConsumeInput): Promise<RateLimitOutcome> {
    // `window_started_at` cột kiểu INTEGER nên ràng buộc tới **số nguyên** millisecond.
    // `Date.now()` đã là số nguyên, nhưng một `nowOverride` trong test có thể không — làm
    // tròn ở đây giữ cho "cửa sổ hiện tại" mà ta tính khớp với cửa sổ mà D1 lưu.
    const now = Math.trunc(input.now);
    const windowStartedAt = now;
    const cutoff = now - Math.trunc(input.windowDurationMs);

    const row = await this.#db
      .prepare(CONSUME_SQL)
      .bind(input.app, windowStartedAt, cutoff, input.limit)
      .first<RateLimitRow>();

    if (row !== null) {
      return { allowed: true, retryAfterMs: null };
    }

    // Không có hàng được `RETURNING` nghĩa là request **đã** vượt ngưỡng và **không** được
    // ghi.
    //
    // ⚠️ `Retry-After` trả **đúng một cửa sổ đầy**, không phải "còn bao lâu nữa thì hết hạn".
    // Với fixed window ta không biết `window_started_at` hiện tại mà không đọc thêm, và một
    // lần đọc thêm ở đây là một lần D1 không cần thiết trên **đường bị từ chối**.
    //
    // ⚠️ Hệ quả thiết kế: một client bị chặn ở cuối cửa sổ phải chờ lâu hơn thực cần. Đó là
    // cái giá của việc **không** đọc thêm, và nó chọn theo hướng thiên về người bị từ chối:
    // chờ lâu hơn thì an toàn, còn báo sớm hơn thực tế thì tạo một `429` trên một request vốn
    // đã được phép.
    return { allowed: false, retryAfterMs: Math.max(1, input.windowDurationMs) };
  }
}
