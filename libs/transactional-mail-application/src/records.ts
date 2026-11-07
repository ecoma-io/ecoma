import type { MailMessageStatus } from '@ecoma-io/transactional-mail-contracts';

/**
 * Bản ghi bền đọc ra từ D1 `mail`.
 *
 * Mọi mốc thời gian là **epoch miligiây UTC** (`*_Ms`) — cùng quy ước với mọi cột thời gian
 * của D1 `mail` (`01-architecture.md` §4). Giao thức nội bộ (nonce) tính bằng epoch **giây**;
 * việc đổi đơn vị chỉ diễn ra ở application layer, không bao giờ ở infrastructure.
 *
 * Port mô tả *dữ liệu đã bền hoá*, không mô tả wire contract: không field nào của
 * `@ecoma-io/transactional-mail-contracts` bị sửa để khớp schema, và không type nào ở đây rò
 * rỉ binding của Cloudflare (không `D1Database`, không `Env`, không type Hono).
 */

/** Trạng thái template — `01-architecture.md` §4.1. */
export type MailTemplateStatus = 'active' | 'disabled';

/**
 * Trạng thái publish của outbox — `01-architecture.md` §6.2.
 *
 * Đây là lớp "Queue command đã được send chưa", tách khỏi delivery outcome
 * (`MailMessageStatus`). Hai lớp **không bao giờ ghi đè lên nhau**: outbox chỉ phản ánh việc
 * publish, message chỉ phản ánh kết quả giao thư do outcome callback ghi.
 */
export type MailOutboxStatus = 'pending' | 'publishing' | 'published' | 'failed';

/**
 * Bản khai báo template (`mail_templates`) — target của read/seed.
 *
 * `variablesSchemaJson` là **metadata** khai báo biến theo FR-003 — không phải bản sao giá trị
 * biến. Lệnh cấm persist raw `variables` (FR-007) áp cho `mail_messages`, không áp cho cột này.
 */
export interface MailTemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly locale: string;
  readonly version: number;
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
  readonly variablesSchemaJson: string;
  readonly status: MailTemplateStatus;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/**
 * Lá thư đã render (`mail_messages`).
 *
 * ⚠️ Không có field `variables` — FR-007: worker render một lần tại request time và chỉ persist
 * template version đã chọn cùng nội dung đã render. `requestFingerprint` là HMAC có khoá dạng
 * `p1.k1:<64 hex>`, **không** phải hash trần và **không** chứa raw `variables`.
 */
export interface MailMessageRecord {
  readonly id: string;
  readonly app: string;
  readonly principalId: string;
  readonly templateId: string;
  readonly templateName: string;
  readonly templateVersion: number;
  readonly locale: string;
  /** Nhạy cảm: không đưa vào log, Queue payload hay error message. */
  readonly recipient: string;
  readonly subjectRendered: string;
  readonly bodyRendered: string;
  readonly status: MailMessageStatus;
  readonly deliveryId: string;
  /** Fencing: chỉ redrive có authorize tăng nó (`01-architecture.md` §6.2.2). */
  readonly dispatchGeneration: number;
  /** Ngân sách A — chỉ tăng, không reset (`01-architecture.md` §6.5). */
  readonly recoveryCycleCount: number;
  /**
   * Khóa idempotency cấp principal (UNIQUE `(principal_id, idempotency_key)`).
   *
   * Nhạy cảm theo FR-007: không đưa vào log hay error message. Khớp khoá ở đây **không** có
   * nghĩa là replay tương đương — việc so `requestFingerprint` là việc của application layer
   * sau khi đọc bản ghi, không phải việc của persistence (xem `mail-message-repository.ts`).
   */
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly correlationId: string | null;
  /** Chỉ chứa `error_class` đã validate — không bao giờ là chuỗi tự do của caller (FR-002). */
  readonly failureReason: string | null;
  /**
   * Mốc FR-007 cho retention. NULL đúng khi trạng thái KHÔNG phải `sent`/`failed`
   * (constraint `mail_messages_terminal_at_parity_check`): `blocked` là non-terminal nên vẫn
   * giữ nguyên `terminal_at IS NULL`.
   */
  readonly terminalAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Outbox row — `01-architecture.md` §4.3. Một `delivery_id` đúng một row (UNIQUE). */
export interface MailOutboxRecord {
  readonly id: string;
  readonly deliveryId: string;
  /** Bản sao generation của lần dispatch mà row này đại diện. */
  readonly dispatchGeneration: number;
  readonly status: MailOutboxStatus;
  /**
   * Số lần thử trong chu kỳ publish **hiện tại**; reset về 0 khi row được re-enqueue.
   *
   * ⚠️ **Không** phải recovery cycle guard: ngân sách A nằm ở
   * `MailMessageRecord.recoveryCycleCount`. Hai bộ đếm không thay thế nhau.
   */
  readonly publishAttempts: number;
  /** Epoch ms sớm nhất được claim; publish retry đẩy ra sau theo backoff. */
  readonly availableAtMs: number;
  readonly claimedAtMs: number | null;
  /** Token fencing của lease — cùng null hoặc cùng có (constraint `…_lease_pair_check`). */
  readonly claimedBy: string | null;
  readonly publishedAtMs: number | null;
  /** Error code/token đã sanitize — không chứa recipient, nội dung render hay credential. */
  readonly lastError: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/**
 * Phạm vi của một counter rate limit (FR-006): đúng ba hình thức mà schema chấp nhận.
 *
 * `system` dùng `principalId = ''`; `principal` bắt buộc có principal thật;
 * `idempotency-key` (FR-002, chặn probe `409` lặp trên cùng một key) mang
 * `scopeValue = '<principal_id>:<hash hex của idempotency key>'` — key gốc của caller
 * **không bao giờ** đi vào storage, chỉ hash do caller tính trước khi gọi
 * ({@link MailRateLimitStore.tryConsume}).
 */
export type MailRateLimitScope =
  | { readonly kind: 'system' }
  | { readonly kind: 'principal'; readonly principalId: string }
  | { readonly kind: 'idempotency-key'; readonly scopeValue: string };

/** Kết quả của một lần gọi `MailRateLimitStore.tryConsume`. */
export interface MailRateLimitConsumeResult {
  readonly kind: 'allowed' | 'denied';
  /** Số hit đã ghi bền cho lần này — `hits` của dòng counter sau lệnh gọi. */
  readonly hits: number;
  readonly windowStartedAtMs: number;
}
