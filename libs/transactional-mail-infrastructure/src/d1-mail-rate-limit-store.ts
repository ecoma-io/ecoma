import type {
  MailRateLimitConsumeResult,
  MailRateLimitScope,
  MailRateLimitStore,
  TryConsumeMailRateLimitInput,
} from '@ecoma-io/transactional-mail-application';

import type { D1SubsetDatabase } from './d1-surface';

/**
 * Tiêu một slot trong **một** statement: `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING`.
 *
 * Trong `DO UPDATE SET`, `window_started_at` và `hits` không trỏ tới `excluded.` là giá trị của
 * **dòng hiện tại** — đúng thứ predicate cần; `excluded.updated_at` là giá trị vừa chèn.
 *
 * Ba nhánh của `WHERE`:
 * - cửa sổ cũ (`window_started_at <= cutoff`) → **luôn** cho qua với `hits = 1` và mở cửa sổ
 *   mới tại `nowMs`, kể cả khi `hits` cũ đã vượt limit;
 * - còn chỗ (`hits < limit`, tức `hits + 1 <= limit`) → cho qua, tăng `hits`;
 * - ngược lại → `WHERE` sai → không có hàng `RETURNING` → `denied`, và `hits` giữ nguyên.
 *
 * Không có hàng trả về nghĩa là **đã bị chặn**, chứ không phải "lệnh đã hỏng": `denied` là một
 * kết quả bình đẳng với `allowed`, không phải exception.
 */
const CONSUME = `
INSERT INTO mail_rate_limits (scope_kind, principal_id, window_started_at, hits, updated_at)
VALUES (?, ?, ?, 1, ?)
ON CONFLICT (scope_kind, principal_id) DO UPDATE SET
  hits = CASE WHEN window_started_at <= ? THEN 1 ELSE hits + 1 END,
  window_started_at = CASE WHEN window_started_at <= ? THEN ? ELSE window_started_at END,
  updated_at = excluded.updated_at
WHERE window_started_at <= ? OR hits < ?
RETURNING hits, window_started_at
`;

/**
 * Chỉ-đọc, chạy **chỉ** trên nhánh `denied` — để trả về `hits` và `windowStartedAtMs` mà
 * application layer dựng `Retry-After` (FR-006). Nhánh `allowed` đã có hai giá trị đó ngay từ
 * `RETURNING`, không cần câu thứ hai.
 */
const READ_COUNTER = `
SELECT hits, window_started_at
FROM mail_rate_limits
WHERE scope_kind = ? AND principal_id = ?
`;

interface RateLimitCounterRow {
  readonly hits: number;
  readonly window_started_at: number;
}

/**
 * Cột scope theo đúng parity mà schema yêu cầu: `system` ↔ `principal_id = ''`;
 * `principal` ↔ principal thật; `idempotency-key` ↔ `'<principal>:<hash hex>'` (một dấu
 * `:`, do application layer ghim — constraint `mail_rate_limits_scope_parity_check` của
 * `0008` là lưới cuối cùng).
 */
function scopeColumns(scope: MailRateLimitScope): readonly [string, string] {
  if (scope.kind === 'system') {
    return ['system', ''];
  }
  if (scope.kind === 'principal') {
    return ['principal', scope.principalId];
  }
  return ['idempotency-key', scope.scopeValue];
}

/** Cửa sổ D1 của rate limit bền (FR-006). Xem JSDoc của từng method trong port. */
export class D1MailRateLimitStore implements MailRateLimitStore {
  readonly #db: D1SubsetDatabase;

  constructor(db: D1SubsetDatabase) {
    this.#db = db;
  }

  async tryConsume(input: TryConsumeMailRateLimitInput): Promise<MailRateLimitConsumeResult> {
    // Hai giá trị này **không** nằm trong schema (không có cột nào lưu limit hay window), nên
    // không có CHECK nào hứng: sai ở đây là sai im lặng. Refuse thay vì cho qua — cùng nhóm
    // với việc truyền `limit` vào guard thay vì lưu vào bảng.
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error('tryConsume: limit must be a positive safe integer');
    }
    if (!Number.isSafeInteger(input.windowDurationMs) || input.windowDurationMs < 1) {
      throw new Error('tryConsume: windowDurationMs must be a positive safe integer');
    }

    const [scopeKind, principalId] = scopeColumns(input.scope);
    // Cửa sổ đã cũ đúng tại thời điểm này hay chưa — tính một lần, bind cho cả WHERE lẫn CASE
    // để hai nửa của cùng một quyết định không thể lệch nhau.
    const expiredAtOrBeforeMs = input.nowMs - input.windowDurationMs;

    const consumed = await this.#db
      .prepare(CONSUME)
      .bind(
        scopeKind,
        principalId,
        input.nowMs,
        input.nowMs,
        expiredAtOrBeforeMs,
        expiredAtOrBeforeMs,
        input.nowMs,
        expiredAtOrBeforeMs,
        input.limit,
      )
      .all<RateLimitCounterRow>();

    const allowedRow = consumed.results[0];
    if (allowedRow) {
      return {
        kind: 'allowed',
        hits: allowedRow.hits,
        windowStartedAtMs: allowedRow.window_started_at,
      };
    }

    const existing = await this.#db
      .prepare(READ_COUNTER)
      .bind(scopeKind, principalId)
      .all<RateLimitCounterRow>();
    const deniedRow = existing.results[0];
    if (!deniedRow) {
      // UPSERT vừa báo "không cập nhật" mà dòng thì không tồn tại: nghĩa là WHERE sai ngay cả
      // trên dòng vừa được chèn — không có trạng thái nào của schema sinh ra điều đó. Đây là
      // một invariant bị phá, không phải một `denied` hợp lệ, nên ném thay vì bịa một con số.
      throw new Error('tryConsume: counter row was not updated and could not be read back');
    }

    return {
      kind: 'denied',
      hits: deniedRow.hits,
      windowStartedAtMs: deniedRow.window_started_at,
    };
  }
}
