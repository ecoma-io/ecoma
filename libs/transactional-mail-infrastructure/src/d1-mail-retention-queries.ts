import type {
  ListMailContentRetentionCandidatesInput,
  ListMailStaleNonTerminalMessagesInput,
  MailContentRetentionCandidate,
  MailRetentionQueries,
  MailStaleNonTerminalCandidate,
} from '@ecoma-io/transactional-mail-application';

import type { D1SubsetDatabase } from './d1-surface';

/**
 * Input/output của `redactContent` **suy ra từ chính port** thay vì import tên.
 *
 * `RedactMailContentInput`/`RedactMailContentResult` được export từ
 * `mail-retention-queries.ts` nhưng chưa có trong barrel `index.ts` của package — mà package
 * này chỉ public entrypoint là package root (consumer không import deep-path). Suy ra kiểu ở
 * đây giữ implementation đúng với port **tự động**: đổi shape của input trong port là dòng
 * này đỏ, thay vì âm thầm lệch.
 */
type RedactMailContentInput = Parameters<MailRetentionQueries['redactContent']>[0];
type RedactMailContentResult = Awaited<ReturnType<MailRetentionQueries['redactContent']>>;

/**
 * Chỉ-đọc cho FR-007.
 *
 * `status IN ('sent','failed')` **thừa** về mặt logic (parity CHECK đã gán `terminal_at NOT
 * NULL` đúng cho hai trạng thái đó) nhưng **không thừa về mặt index**: `mail_messages_status_
 * terminal_idx` là `(status, terminal_at)`, và SQLite chỉ seek được theo cột leading khi nó bị
 * ràng buộc. Không có vế `status` thì câu này quét index theo cột thứ hai — chậm dần theo số
 * row terminal, đúng kiểu vô hại lúc dev và thành lỗi vận hành lúc production.
 */
const LIST_CONTENT_RETENTION_CANDIDATES = `
SELECT id, delivery_id, terminal_at
FROM mail_messages
WHERE status IN ('sent', 'failed')
  AND terminal_at < ?
ORDER BY terminal_at, id
LIMIT ?
`;

/** Ba trạng thái non-terminal của §4.2 — đây là danh sách ứng viên **alert**, không phải xoá. */
const LIST_STALE_NON_TERMINAL = `
SELECT id, delivery_id, status, updated_at
FROM mail_messages
WHERE status IN ('accepted', 'queued', 'blocked')
  AND updated_at < ?
ORDER BY updated_at, id
LIMIT ?
`;

/**
 * Redact content quá hạn — FR-007.
 *
 * ⚠️ **Một** statement cho toàn bộ lô. Danh sách id đi vào **một** bound parameter JSON
 * và được bung ra bằng `json_each(?)`, không phải `IN (?, ?, …)`: cách sau dính giới hạn D1
 * DB4 (100 bound parameter) ngay tên đầu tiên vượt quá nó, còn `json_each` để **một** tham số
 * duy nhất cho cả lô. Xác nhận trên D1 thật (miniflare/workerd qua Wrangler) rằng `json_each`
 * dùng được.
 *
 * ⚠️ Vì danh sách id không còn là N tham số, `batchLimit` của composition root **không** bị
 * giới hạn bởi DB4 nữa — nhưng nó vẫn phải hữu hạn, vì một `UPDATE` không giới hạn trên Worker
 * có thể chạy quá lâu rồi bị kill giữa chừng.
 *
 * `id` đi vào JSON qua `JSON.stringify` nên **luôn** là một bound parameter: một id chứa ký tự
 * đặc biệt không thể tách khỏi chuỗi SQL, và không có đường nào nội suy giá trị vào câu.
 *
 * Ba guard trong `WHERE`, cùng lúc:
 * 1. `id IN (SELECT value FROM json_each(?))` — chỉ đúng lô được yêu cầu, không quét rộng.
 * 2. `status IN ('sent','failed')` — **không** phải thừa về mặt logic (mọi id đến từ
 *    `listContentRetentionCandidates` đều terminal) nhưng bắt buộc về mặt **race**: giữa lúc
 *    đọc danh sách và lúc chạy câu này, một message có thể đã bị redrive về `queued`/`blocked`.
 *    Không có guard này thì lệnh retention sẽ xoá content của một delivery **còn cần gửi**.
 * 3. `terminal_at < ?` — chặn việc redact một row vừa terminal ngay trước lúc ghi, vốn sẽ giữ
 *    content của nó thêm một chu kỳ retention nữa. Đây cũng là guard chính chống tranh chấp với
 *    outcome callback.
 *
 * ⚠️ `recipient = ''` **đòi migration `0007_mail_content_redaction.sql`**: schema hiện tại có
 * `mail_messages_recipient_non_empty_check CHECK (recipient <> '')`, nên câu này sẽ ném
 * `CHECK constraint failed` thay vì redact. Migration đó rebuild bảng và bỏ đúng CHECK đó —
 * xem JSDoc chi tiết trong file migration.
 *
 * ⚠️ `updated_at = ?` được đặt lại về `nowMs` của lần ghi: đó là mốc duy nhất mà
 * `listContentRetentionCandidates` không dùng (nó dùng `terminal_at`), nên việc ghi nó không
 * làm "trẻ hóa" ứng viên của chính nó — và nó giữ đúng nghĩa `updated_at` = "lần sửa gần nhất".
 */
const REDACT_CONTENT = `
UPDATE mail_messages
SET recipient = '', subject_rendered = '', body_rendered = '', updated_at = ?
WHERE id IN (SELECT value FROM json_each(?))
  AND status IN ('sent', 'failed')
  AND terminal_at < ?
RETURNING id
`;

interface ContentRetentionRow {
  readonly id: string;
  readonly delivery_id: string;
  readonly terminal_at: number;
}

interface StaleNonTerminalRow {
  readonly id: string;
  readonly delivery_id: string;
  readonly status: MailStaleNonTerminalCandidate['status'];
  readonly updated_at: number;
}

/** Hàng trả về của `REDACT_CONTENT` — chỉ cần `id` để đếm, không đọc content nào. */
interface RedactedContentRow {
  readonly id: string;
}

/** Truy vấn retention/expiry của D1 `mail` — chỉ-đọc, đúng như port. */
export class D1MailRetentionQueries implements MailRetentionQueries {
  readonly #db: D1SubsetDatabase;

  constructor(db: D1SubsetDatabase) {
    this.#db = db;
  }

  async listContentRetentionCandidates(
    input: ListMailContentRetentionCandidatesInput,
  ): Promise<readonly MailContentRetentionCandidate[]> {
    if (input.limit < 1) {
      return [];
    }

    const found = await this.#db
      .prepare(LIST_CONTENT_RETENTION_CANDIDATES)
      .bind(input.terminalBeforeMs, input.limit)
      .all<ContentRetentionRow>();

    return found.results.map((row) => ({
      messageId: row.id,
      deliveryId: row.delivery_id,
      terminalAtMs: row.terminal_at,
    }));
  }

  async listStaleNonTerminalMessages(
    input: ListMailStaleNonTerminalMessagesInput,
  ): Promise<readonly MailStaleNonTerminalCandidate[]> {
    if (input.limit < 1) {
      return [];
    }

    const found = await this.#db
      .prepare(LIST_STALE_NON_TERMINAL)
      .bind(input.updatedBeforeMs, input.limit)
      .all<StaleNonTerminalRow>();

    return found.results.map((row) => ({
      messageId: row.id,
      deliveryId: row.delivery_id,
      status: row.status,
      updatedAtMs: row.updated_at,
    }));
  }

  async redactContent(input: RedactMailContentInput): Promise<RedactMailContentResult> {
    // Danh sách rỗng là một no-op hợp đồng, không phải một câu cần chạy: `json_each('[]')` bung
    // ra không phần tử nào nên câu cũng cho 0 hàng, nhưng bỏ qua hẳn database rõ hơn — và nó
    // giữ đường này không phụ thuộc vào việc SQLite parse một JSON rỗng.
    if (input.messageIds.length === 0) {
      return { redacted: 0 };
    }

    const redacted = await this.#db
      .prepare(REDACT_CONTENT)
      .bind(input.nowMs, JSON.stringify(input.messageIds), input.nowMs)
      .all<RedactedContentRow>();

    // Số hàng đếm từ `RETURNING`, không từ `meta.changes`: local `wrangler d1 execute` không
    // điền `meta.changes` (DB3) nên đọc nó sẽ cho `0` giả và retention sẽ báo đã xoá content
    // trong khi không xoá gì — tức im lặng giữ content nhạy cảm quá hạn.
    return { redacted: redacted.results.length };
  }
}
