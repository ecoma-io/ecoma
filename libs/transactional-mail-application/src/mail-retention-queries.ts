import type { MailMessageStatus } from '@ecoma-io/transactional-mail-contracts';

/**
 * Dựng trạng thái mà một đường retention/ops cần biết để **ra quyết định** — không phải để
 * hiển thị hay trả về caller ngoài.
 *
 * ⚠️ Projection hẹp có chủ đích: không `recipient`, không `subjectRendered`, không
 * `bodyRendered`, không `idempotencyKey`, không `requestFingerprint`. FR-007 tách recipient +
 * nội dung render (sensitive content) khỏi operational metadata; một query chỉ-đọc để *quyết
 * định* content nào quá hạn không có lý do nào để kéo chính content đó ra khỏi database.
 */
export interface MailContentRetentionCandidate {
  readonly messageId: string;
  readonly deliveryId: string;
  readonly terminalAtMs: number;
}

/**
 * Dựng trạng thái một delivery đang dở quá tuổi — input của **alert**, không phải của một
 * lệnh xoá (FR-007: "Delivery dở quá tuổi tối đa → sinh alert (không im lặng)").
 *
 * Không chứa content: việc điều tra và remediation là việc của operator sau khi có alert.
 */
export interface MailStaleNonTerminalCandidate {
  readonly messageId: string;
  readonly deliveryId: string;
  readonly status: MailMessageStatus;
  readonly updatedAtMs: number;
}

/**
 * Truy vấn retention/expiry cho `mail_messages`.
 *
 * ⚠️ C1 chỉ cung cấp **truy vấn**. Không có method ghi nào ở đây: xoá/redact content, alert
 * và mọi thao tác destructive đều nằm ngoài phạm vi C1 (§5 của lệnh) và thuộc về PR khi
 * policy retention được chốt (`02-requirements.md` FR-007 ghi rõ các giá trị hiện tại là
 * **đề xuất cần validate**, không phải cam kết).
 *
 * Lưu ý về lịch sử: {@link MailRetentionQueries.redactContent} được thêm vào **sau** đó
 * (bổ sung FR-007), nên câu "chỉ cung cấp truy vấn" ở trên chỉ còn đúng cho hai list method.
 * `redactContent` là method ghi **duy nhất** của port này và không xoá row: nó xoá
 * **content** theo chính sách retention, giữ nguyên operational metadata (FR-007 AC
 * "Message terminal quá hạn retention → content bị xoá/redact, metadata còn").
 */
export interface MailRetentionQueries {
  /**
   * Message đã terminal (`sent`/`failed`) trước `terminalBeforeMs` — ứng viên bị xoá/redact
   * content.
   *
   * Predicate dùng đúng mốc mà schema giữ cho row terminal (`terminal_at`), không dùng
   * `updated_at`: `updated_at` đổi khi bất kỳ cột nào đổi, nên theo nó thì một row terminal
   * bị chạm bởi một UPDATE vô hại sẽ "trẻ lại" và bị bỏ qua — hoặc ngược lại, một row
   * non-terminal không bao giờ lọt vào đây: `terminal_at IS NULL` nên `terminal_at < ?`
   * không bao giờ đúng.
   *
   * `blocked` **không** lọt vào danh sách này: nó là non-terminal nên `terminal_at IS NULL`
   * (constraint `mail_messages_terminal_at_parity_check`) và câu này không chọn nó. Giữ
   * content của một delivery còn redrive được là hành động đúng — FR-007 xử lý nó bằng đường
   * "delivery non-terminal quá tuổi → alert", tức là {@link listStaleNonTerminalMessages}.
   *
   * `limit` bắt buộc vì đây là đường quét theo lô, không bao giờ quét toàn bảng trong một
   * lệnh.
   */
  listContentRetentionCandidates(
    input: ListMailContentRetentionCandidatesInput,
  ): Promise<readonly MailContentRetentionCandidate[]>;

  /**
   * Message chưa terminal mà `updated_at` cũ hơn `updatedBeforeMs` — ứng viên alert theo
   * FR-007 ("Delivery non-terminal tồn đọng không được im lặng").
   *
   * Phạm vi đúng ba trạng thái non-terminal của §4.2: `accepted`, `queued`, `blocked`.
   * `limit` bắt buộc, cùng lý lẽ với {@link listContentRetentionCandidates}.
   */
  listStaleNonTerminalMessages(
    input: ListMailStaleNonTerminalMessagesInput,
  ): Promise<readonly MailStaleNonTerminalCandidate[]>;

  /**
   * Xoá **content** đã quá hạn retention của một lô message, giữ nguyên operational
   * metadata — FR-007 ("Message terminal quá hạn retention → content bị xoá/redact,
   * metadata còn").
   *
   * Đây là **redact**, không phải `DELETE`: không row nào bị xoá, và các cột metadata
   * (`status`, `delivery_id`, `dispatch_generation`, `recovery_cycle_count`,
   * `idempotency_key`, `request_fingerprint`, `failure_reason`, `terminal_at`, timestamps)
   * giữ nguyên giá trị cũ. Delivery intent còn nguyên nên operator vẫn điều tra được
   * (`03-operations.md` §5.4) sau khi content đã biến mất.
   *
   * Chỉ ba cột **sensitive content** bị ghi: `recipient`, `subject_rendered`,
   * `body_rendered`. Không có cột nào khác của `mail_messages` bị chạm.
   *
   * ⚠️ **Guard `terminal_at < nowMs` là bắt buộc và không phải thừa.** Danh sách ứng viên
   * được đọc ở một lệnh riêng, nên giữa lúc đọc và lúc redact một message có thể vừa kết
   * thúc (terminal). Guard này loại đúng các row đó: một message vừa terminal giữ content
   * của nó thêm một chu kỳ retention nữa thay vì bị xoá sớm — hậu quả (mất bằng chứng khi
   * điều tra một lần gửi hỏng) lớn hơn hẳn chi phí của việc giữ thêm content vài giây.
   *
   * Trả **số hàng thực sự đã redact**. `messageIds` rỗng → `{ redacted: 0 }` và **không**
   * chạm database (không có câu `IN ()` hợp lệ trong SQL).
   *
   * Đếm số hàng là việc của implementation, không phải của caller: xem `d1-surface.ts`
   * (vì sao `meta.changes` không được tin).
   */
  redactContent(input: RedactMailContentInput): Promise<RedactMailContentResult>;
}

/** Kết quả của {@link MailRetentionQueries.redactContent}. */
export type RedactMailContentResult = {
  /** Số row đã bị redact content — đếm từ `RETURNING`, không từ `meta.changes`. */
  readonly redacted: number;
};

/** Input của {@link MailRetentionQueries.redactContent}. */
export interface RedactMailContentInput {
  /**
   * Danh sách `mail_messages.id` đang là ứng viên — tức là output của
   * {@link MailRetentionQueries.listContentRetentionCandidates}.
   *
   * Danh sách rỗng là một no-op hợp lệ: không chạm database, trả `{ redacted: 0 }`.
   */
  readonly messageIds: readonly string[];
  /**
   * Epoch ms — đặt `updated_at` của row bị redact, **và** mốc chặn race: chỉ redact row
   * đã terminal mà `terminal_at < nowMs`.
   */
  readonly nowMs: number;
}

/** Input của {@link MailRetentionQueries.listContentRetentionCandidates}. */
export interface ListMailContentRetentionCandidatesInput {
  /** Epoch ms — chỉ lấy row có `terminal_at < terminalBeforeMs`. */
  readonly terminalBeforeMs: number;
  /** Số hàng tối đa; `<= 0` trả rỗng, không quét. */
  readonly limit: number;
}

/** Input của {@link MailRetentionQueries.listStaleNonTerminalMessages}. */
export interface ListMailStaleNonTerminalMessagesInput {
  /** Epoch ms — chỉ lấy row có `updated_at < updatedBeforeMs`. */
  readonly updatedBeforeMs: number;
  /** Số hàng tối đa; `<= 0` trả rỗng, không quét. */
  readonly limit: number;
}
