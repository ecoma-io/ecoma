import type { MailRateLimitConsumeResult, MailRateLimitScope } from './records';

/**
 * Counter rate limit bền trong D1 `mail` (FR-006).
 *
 * ⚠️ D1 `mail` là **authority**: một Worker có nhiều isolate, nên mọi bộ đếm trong memory sẽ
 * vừa cho qua vượt ngưỡng vừa mất đếm khi isolate bị recycle (`01-architecture.md` §8,
 * invariant "không state node-local"). Port này không có và không bao giờ có một đường ghi
 * nào ra ngoài database.
 *
 * Mô hình **fixed window theo scope**: một dòng là một counter đang mở cho đúng một scope.
 * Lệnh gọi là một `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING` duy nhất, nên hai
 * request đồng thời không cùng "thừa" một slot.
 */
export interface MailRateLimitStore {
  /**
   * Tiêu một slot cho `scope` trong cửa sổ đang mở, hoặc mở cửa sổ mới.
   *
   * Predicate của `ON CONFLICT … DO UPDATE` (một statement, không read-then-write):
   *
   * - `window_started_at <= nowMs - windowDurationMs` → cửa sổ cũ → **luôn** cho qua với
   *   `hits = 1` và `window_started_at = nowMs` (mở cửa sổ mới), kể cả khi `hits` cũ đã vượt
   *   limit — hết cửa sổ thì hạn mức mới.
   * - ngược lại → `hits + 1 <= limit` → cho qua với `hits + 1`, giữ nguyên cửa sổ.
   *   Không còn chỗ → `WHERE` sai → **không có hàng nào trả về** → `denied`.
   *
   * `denied` **không** tiêu slot: row giữ nguyên `hits` cũ, nên một luồng bị chặn không kéo
   * luôn cửa sổ sang người khác.
   *
   * Kết quả trả `hits` và `windowStartedAtMs` của dòng **sau** lệnh gọi — kể cả khi `denied`
   * (lúc đó cần một `SELECT` chỉ-đọc để lấy hai giá trị đó). Hai giá trị đó là thứ
   * application layer dùng để dựng `Retry-After` của `429` (FR-006): thời điểm cửa sổ đóng là
   * `windowStartedAtMs + windowDurationMs`.
   *
   * Giá trị vận hành do caller truyền, không suy ra từ schema: `limit` và `windowDurationMs`
   * là ngưỡng chốt ở deploy (cùng nhóm với `maxPublishAttempts`), nên đổi ngưỡng là đổi
   * config chứ không phải migration.
   *
   * Cả hai đều phải là số nguyên an toàn `>= 1`; nếu không, method **ném lỗi** và **không**
   * chạm database. Refuse thay vì trả `denied`: hai giá trị này không có cột nào trong schema
   * để CHECK hứng, nên một `limit = 0` vô tình sẽ biến thành "429 cho tất cả mọi người" một
   * cách im lặng — đó là bug vận hành phải nổi lên, không phải kết quả hợp lệ. Đây là **fail
   * closed**: exception không bao giờ được dịch thành "cho qua".
   *
   * Ngược lại, `denied` do chạm limit là **kết quả bình đẳng** với `allowed`, không phải
   * exception — đó là đường đi của lưu lượng bình thường.
   *
   * Phạm vi sai (scope `principal` với principal rỗng) **không** được kiểm ở đây: việc đó
   * schema đã có `mail_rate_limits_scope_parity_check`, và để DB ném đúng tên constraint vẫn
   * hơn là nhân bản luật ở hai nơi.
   *
   * Port **cố ý không** có đường ghi nào khác: không "reset" thủ công, không `DELETE`, không
   * read-then-write. Cửa sổ tự đóng bằng cách `window_started_at` cũ đi, đúng cách một fixed
   * window tự kết thúc; test đọc trạng thái bằng truy vấn thô chứ không qua port, để assertion
   * không đi qua chính code đang bị kiểm.
   */
  tryConsume(input: TryConsumeMailRateLimitInput): Promise<MailRateLimitConsumeResult>;
}

/** Input của {@link MailRateLimitStore.tryConsume}. */
export interface TryConsumeMailRateLimitInput {
  readonly scope: MailRateLimitScope;
  /** Độ dài cửa sổ cố định (epoch ms) — cùng đơn vị với `window_started_at`. */
  readonly windowDurationMs: number;
  /** Số slot tối đa trong một cửa sổ; `>= 1`. */
  readonly limit: number;
  /** Epoch ms — mốc so với `window_started_at` và đặt `updated_at`. */
  readonly nowMs: number;
}
