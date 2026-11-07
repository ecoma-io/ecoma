/**
 * Model dữ liệu của job execution state (D1 `mail-job`).
 *
 * Nguồn canonical: `docs/applications/transactional-mailer-job/01-architecture.md` §7, §9.2.1,
 * §9.5. File này **không** định nghĩa lại semantics — chỉ dựng enum đóng, record type và
 * hai loại lỗi mà mọi tầng dưới phải dùng thay vì ném `Error` chung chung.
 *
 * Không có import nào ở đây ngoài type nội bộ: application layer không được chạm D1,
 * Cloudflare, Hono hay infrastructure (`docs/architecture/05-code-architecture.md` §5).
 */

/** Enum đóng của `mail_jobs.status` (§7). */
export const MAIL_JOB_STATUS_VALUES = ['processing', 'sent', 'failed', 'blocked'] as const;

export type MailJobStatus = (typeof MAIL_JOB_STATUS_VALUES)[number];

/** Enum đóng của `mail_jobs.outcome_report_state` (§7). */
export const OUTCOME_REPORT_STATE_VALUES = [
  'none',
  'pending',
  'reported',
  'superseded',
  'orphaned',
] as const;

export type OutcomeReportState = (typeof OUTCOME_REPORT_STATE_VALUES)[number];

/**
 * Enum đóng của `quarantine.reason` (`03-operations.md` §3.1).
 *
 * Tập này là canonical của **reject reason**; nó không phải tập `error_class` gửi lên
 * control plane (`MAIL_ERROR_CLASS_VALUES` trong `@ecoma-io/transactional-mail-contracts`).
 */
export const QUARANTINE_REASON_VALUES = [
  'missing-delivery-id',
  'unparseable-body',
  'unsupported-version',
  'forbidden-field',
  'lifecycle-event-invalid',
] as const;

export type QuarantineReason = (typeof QUARANTINE_REASON_VALUES)[number];

/**
 * Ba trạng thái terminal-theo-execution mà persist result có thể ghi (§9.2.2 hàng 1–4).
 *
 * `processing` cố ý **không** nằm trong tập: row `processing` là row đang giữ hoặc chờ
 * lease, và statement persist result luôn release lease trong cùng UPDATE — ghi
 * `processing` qua đường này sẽ phá vỡ cặp `lease_owner`/`lease_expires_at`.
 */
export const MAIL_JOB_PERSISTABLE_STATUS_VALUES = ['sent', 'failed', 'blocked'] as const;

export type MailJobPersistableStatus = (typeof MAIL_JOB_PERSISTABLE_STATUS_VALUES)[number];

/**
 * Ba trạng thái report mà một lần báo outcome có thể chốt (§9.5).
 *
 * `pending` cố ý **không** nằm trong tập: giữ `pending` là một operation riêng
 * (`keepReportPending`), tách khỏi việc chốt terminal, vì hai điều đó có guard
 * và có ý nghĩa vận hành khác nhau.
 */
export const MAIL_JOB_REPORTABLE_STATE_VALUES = ['reported', 'superseded', 'orphaned'] as const;

export type MailJobReportableState = (typeof MAIL_JOB_REPORTABLE_STATE_VALUES)[number];

/**
 * `last_error_class` do statement (c) ghi cứng trong SQL (§9.2.1).
 *
 * Docs **chưa** chốt bộ giá trị đóng cho cột này (xem ghi chú migration `0001`), nên
 * hằng này chỉ là một giá trị đã biết, không phải điểm mở của một enum. Không được
 * suy ra rằng mọi `last_error_class` hợp lệ đều nằm trong danh sách hằng ở đây.
 */
export const MAIL_JOB_BUDGET_EXHAUSTED_ERROR_CLASS = 'execution-budget-exhausted' as const;

/**
 * `last_error_class` cho job `failed` khi delivery không tồn tại ở control plane
 * (`01-architecture.md` §8, `03-operations.md` §3.1 hàng 6).
 */
export const MAIL_JOB_DELIVERY_NOT_FOUND_ERROR_CLASS = 'delivery-not-found' as const;

/**
 * `last_error_class` cho job `blocked` khi auto-resend đã ngoài cửa sổ an toàn: kết quả
 * provider KHÔNG XÁC ĐỊNH bền vững (marker trước call còn sống, `provider_call_at` cách
 * đây hơn ~24 giờ là giới hạn upstream của Resend, non-configurable) và worker không được
 * tự gọi lại provider (issue #37). Chỉ redrive có authorize mở khoá.
 *
 * Token là worker-internal — không phải error_class canonical của control plane (sweep đã
 * lọc trước khi báo wire, `report-sweeps.ts` `canonicalErrorClass`).
 */
export const MAIL_JOB_PROVIDER_AMBIGUOUS_ERROR_CLASS = 'provider-ambiguous-outcome' as const;

/**
 * Row `mail_jobs` sau khi đã decode và validate.
 *
 * Mọi giá trị đều đã qua parity invariant của schema: cặp lease cùng null hoặc cùng
 * có, `blocked_at` tương ứng `status = 'blocked'`, và `outcome_report_state = 'none'`
 * đúng khi `status = 'processing'`. Decode một row không thỏa các bất biến đó là
 * {@link MalformedMailJobStateError}, không phải "giá trị mặc định".
 */
export type MailJobRecord = {
  readonly deliveryId: string;
  readonly messageId: string | null;
  readonly dispatchGeneration: number;
  readonly executionGeneration: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: number | null;
  readonly status: MailJobStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly lastErrorClass: string | null;
  readonly providerMessageId: string | null;
  readonly outcomeReportState: OutcomeReportState;
  readonly reportLeaseOwner: string | null;
  readonly reportLeaseExpiresAt: number | null;
  readonly reportAttempts: number;
  readonly blockedAt: number | null;
  /**
   * Marker bền vững của lần gọi provider đầu tiên đã ghi (migration `0003`), epoch ms.
   *
   * `null` = chưa từng có request nào rời khỏi worker được ghi bền vững — có thể chưa gọi,
   * có thể worker chết giữa hai statement. Giá trị khác null là "provider CÓ THỂ đã nhận
   * email": bắt đầu cửa sổ mơ hồ theo `provider-safety-window` (không exactly-once §9.3).
   * Marker **không** bao giờ bị xoá hay reset — kể cả khi redrive tăng
   * `dispatch_generation` (statement (b) không đụng nó): sự thật về thế giới không rút lại
   * được.
   */
  readonly providerCallAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** Bản ghi quarantine sau khi decode và validate. */
export type QuarantineRecord = {
  readonly quarantineId: string;
  readonly queueMessageId: string;
  readonly reason: QuarantineReason;
  readonly fieldName: string | null;
  readonly attempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * Caller truyền tham số không hợp lệ (delivery_id rỗng, generation âm, token không
 * phải số nguyên an toàn...).
 *
 * Lỗi này xảy ra **trước** khi chạm database, nên caller an toàn khi coi nó là bug
 * nội bộ: không có partial write nào đã xảy ra.
 */
export class MailJobValidationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'MailJobValidationError';
    this.code = code;
  }
}

/**
 * Row đã lưu trong database vi phạm một parity invariant mà schema không encode được.
 *
 * Đây là tình huống fail-closed: tuyệt đối **không** được "sửa về trạng thái executable
 * mặc định". Mọi operation đọc row phải ném lỗi này để tầng trên dừng xử lý và alert;
 * nếu một transition trả row hỏng như thể nó hợp lệ thì một delivery có thể bị gửi
 * lại hoặc một lease có thể bị bỏ qua.
 */
export class MalformedMailJobStateError extends Error {
  readonly deliveryId: string;
  readonly rule: string;

  constructor(deliveryId: string, rule: string, detail: string) {
    super(`Malformed mail_jobs row for delivery ${deliveryId}: ${rule} (${detail})`);
    this.name = 'MalformedMailJobStateError';
    this.deliveryId = deliveryId;
    this.rule = rule;
  }
}

/**
 * Pattern của một error token đã sanitize.
 *
 * §11.1 buộc `errorCode` là "token đã sanitize" và cấm recipient, nội dung, endpoint,
 * credential hay raw body. Schema không bound được nội dung cột (`0001`), nên ranh giới
 * phải nằm ở writer: tập con lowercase kebab-case là tập mà tài liệu thực sự dùng
 * (`http-429`, `timeout`, `network`, `malformed-response`, `execution-budget-exhausted`,
 * `delivery-not-found`), và nó loại được mọi chuỗi free-form có khoảng trắng, ký tự
 * control hay dữ liệu cá nhân.
 */
export const SANITIZED_ERROR_TOKEN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

/** Chiều dài tối đa của một error token, tính bằng code point. */
export const SANITIZED_ERROR_TOKEN_MAX_LENGTH = 64;

/**
 * Kiểm một error token và trả lại **nguyên văn** giá trị đã kiểm, hoặc ném
 * {@link MailJobValidationError}.
 *
 * Hàm này cố ý **ném** thay vì trả `boolean`: một token không hợp lệ không bao giờ
 * được ghi xuống database, nên caller bắt buộc phải xử lý nhánh lỗi — trả `false` sẽ
 * mở đường cho caller "ghi đại rồi tính". Kiểm kiểu (`string`) là trách nhiệm của
 * chỗ decode row; hàm này nhận `string | null` đúng theo type đã khai.
 *
 * @param value Giá trị ứng viên; `null` được chấp nhận và trả về `null`.
 * @param field Tên cột, dùng trong thông báo lỗi (không nêu giá trị).
 * @throws {MailJobValidationError} Khi giá trị không phải null và không khớp pattern.
 */
export function sanitizeErrorToken(value: string | null, field: string): string | null {
  if (value === null) {
    return null;
  }

  const length = [...value].length;
  if (length === 0 || length > SANITIZED_ERROR_TOKEN_MAX_LENGTH) {
    throw new MailJobValidationError(
      `${field} must be 1..${SANITIZED_ERROR_TOKEN_MAX_LENGTH} code points, got ${length}`,
      'error-token-length',
    );
  }

  if (!SANITIZED_ERROR_TOKEN_PATTERN.test(value)) {
    throw new MailJobValidationError(
      `${field} must be a lowercase kebab-case token ([a-z0-9-], 1..${SANITIZED_ERROR_TOKEN_MAX_LENGTH})`,
      'error-token-pattern',
    );
  }

  return value;
}

/**
 * Pattern của một **tên** key vi phạm trong quarantine record.
 *
 * Khác với error token: key của JSON command là case-sensitive (`api_key`, `myField`)
 * và có thể chứa `_` — đúng tập mà tài liệu liệt kê (`02-requirements.md` §FR: `secret`,
 * `token`, `recipient`, `api_key`, `subject`, `body`). Dùng chung pattern kebab-case
 * của {@link sanitizeErrorToken} sẽ **từ chối chính `api_key`** — một record canonical
 * không ghi được.
 *
 * Vẫn phải bound (§6: không nhận chuỗi tùy ý vào persisted state): tập nhận là
 * identifier-ish `[A-Za-z0-9._-]`, dài 1..128 code point — loại được khoảng trắng, ký tự
 * control, quote và dữ liệu cá nhân biến đổi dạng thành "tên key".
 */
export const QUARANTINE_FIELD_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

/** Chiều dài tối đa của một tên key vi phạm, tính bằng code point. */
export const QUARANTINE_FIELD_NAME_MAX_LENGTH = 128;

/**
 * Kiểm một tên key vi phạm và trả lại **nguyên văn** giá trị đã kiểm, hoặc ném
 * {@link MailJobValidationError}.
 *
 * Data policy (`03-operations.md` §3.1) cho phép ghi **tên** key, không bao giờ ghi
 * value; hàm này là ranh giới của "tên": không rỗng, không quá dài, không mang ký tự
 * ngoài tập identifier-ish.
 *
 * @param value Tên key ứng viên.
 * @param field Tên tham số, dùng trong thông báo lỗi (không nêu giá trị).
 * @throws {MailJobValidationError} Khi giá trị không khớp pattern.
 */
export function sanitizeFieldName(value: string, field: string): string {
  if (!QUARANTINE_FIELD_NAME_PATTERN.test(value)) {
    throw new MailJobValidationError(
      `${field} must be an identifier-like key name ([A-Za-z0-9._-], 1..${QUARANTINE_FIELD_NAME_MAX_LENGTH})`,
      'field-name-pattern',
    );
  }
  return value;
}

/** Giá trị integer an toàn (không NaN/Infinity, trong khoảng vừa đủ cho cột INTEGER). */
const SAFE_INTEGER_MIN = -(2 ** 53 - 1);
const SAFE_INTEGER_MAX = 2 ** 53 - 1;

/**
 * Kiểm một tham số bắt buộc là số integer an toàn.
 *
 * D1 lưu INTEGER theo SQLite: một giá trị tràn 64-bit hoặc một float sẽ được lưu im
 * lặng theo cách khác caller mong đợi, và sau đó guard `WHERE attempts < :max` so sánh
 * với đúng giá trị đã lưu — sai khác ở đây là sai khác của state machine.
 */
export function assertSafeInteger(value: number, field: string): number {
  if (!Number.isInteger(value)) {
    throw new MailJobValidationError(`${field} must be an integer`, 'integer-type');
  }
  if (value < SAFE_INTEGER_MIN || value > SAFE_INTEGER_MAX) {
    throw new MailJobValidationError(`${field} is outside the safe integer range`, 'integer-range');
  }
  return value;
}

/**
 * Kiểm một tham số đếm/ngân sách là số nguyên **dương**.
 *
 * Dùng cho `dispatch_generation` (schema bắt buộc `>= 1`), `leaseMs`/`reportLeaseMs`
 * (lease `0` đồng nghĩa không có lease: statement sẽ luôn fail mà không nói được vì sao)
 * và `maxExecutionAttempts` (guard `attempts < :max` với `max = 0` khiến mọi claim
 * thất bại ngầm, biến ngân sách B thành chặn vô điều kiện).
 */
export function assertPositiveInteger(value: number, field: string): number {
  assertSafeInteger(value, field);
  if (value < 1) {
    throw new MailJobValidationError(
      `${field} must be a positive integer (>= 1)`,
      'integer-positive',
    );
  }
  return value;
}

/**
 * Kiểm một tham số trạng thái nằm đúng trong tập đóng của cột.
 *
 * Statement ghi nhận `outcome`/`disposition` dưới dạng bound parameter, nên **type**
 * union không bảo vệ được khi caller là JavaScript hay dữ liệu đã parse từ JSON: giá trị
 * ngoài tập sẽ either bị CHECK của schema chặn (trả lỗi hạ tầng) hoặc — tệ hơn — ghi
 * được một trạng thái mà state machine không có đường ra. Kiểm ở đây trả
 * {@link MailJobValidationError} (lỗi caller, không phải lỗi hạ tầng) trước khi chạm D1.
 */
export function assertClosedValue<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new MailJobValidationError(
      `${field} must be one of ${allowed.join(', ')}`,
      'closed-value',
    );
  }
  return value as T;
}

/**
 * Kiểm một tham số chuỗi bắt buộc không rỗng.
 *
 * `delivery_id` là idempotency key cấp logical delivery; một chuỗi rỗng qua được ở đây
 * sẽ tạo một row vô nghĩa mà không trigger được `mail_jobs_delivery_id_non_empty_check`
 * ở nơi có lợi (ở đó lỗi chỉ xuất hiện sau khi đã đi hết đường claim).
 */
export function assertNonEmptyString(value: string, field: string): string {
  if (value.length === 0) {
    throw new MailJobValidationError(`${field} must be a non-empty string`, 'string-non-empty');
  }
  return value;
}

/**
 * Bound dùng chung cho identifier lưu vào cột TEXT của repository
 * (`delivery_id`, `quarantine_id`, `queue_message_id`): không ép format, nhưng
 * chặn chuỗi rỗng và chuỗi quá dài để cột không biến thành chỗ chứa dữ liệu tự
 * do — thống nhất với bound của `lease_owner` và `field_name` (128).
 */
export const MAIL_JOB_IDENTIFIER_MAX_LENGTH = 128;

/**
 * Kiểm identifier bắt buộc bị ràng buộc (non-empty, tối đa
 * {@link MAIL_JOB_IDENTIFIER_MAX_LENGTH} code points).
 */
export function assertBoundedString(value: string, field: string): string {
  assertNonEmptyString(value, field);
  if ([...value].length > MAIL_JOB_IDENTIFIER_MAX_LENGTH) {
    throw new MailJobValidationError(
      `${field} must be at most ${MAIL_JOB_IDENTIFIER_MAX_LENGTH} code points`,
      `string-${field}-too-long`,
    );
  }
  return value;
}

/**
 * Kiểm chuỗi tuỳ chọn bị ràng buộc (identifier/message-id từ caller, ví dụ
 * `message_id`, `provider_message_id`).
 *
 * Decoder (`readNullableString`) coi `''` trong một cột nullable là row hỏng —
 * "writer đáng ra phải ghi `NULL`". Nếu writer-side không chặn `''` tại đây, một
 * tham số rỗng sẽ tạo (hoặc, với persist-result, commit rồi mới ném trên đường
 * đọc lại) một row mà chính repository không đọc lại được. Độ dài tối đa giữ các
 * cột TEXT này không bị dùng làm chỗ chứa dữ liệu tự do, thống nhất với bound của
 * `lease_owner` (128) và `field_name` (128).
 */
export function assertBoundedOptionalString(
  value: string | undefined,
  field: string,
  maxLength = 128,
): string | null {
  if (value === undefined) {
    return null;
  }
  assertNonEmptyString(value, field);
  if ([...value].length > maxLength) {
    throw new MailJobValidationError(
      `${field} must be at most ${maxLength} code points`,
      `string-${field}-too-long`,
    );
  }
  return value;
}

/**
 * Kiểm định danh execution/sweeper (`lease_owner`).
 *
 * Không ép format UUID: §9.2.1 chỉ nói "UUID sinh local", và ép một format cụ thể ở
 * tầng này sẽ chặn một implementation UUID hợp lệ của caller sau này. Chỉ chặn chuỗi
 * rỗng và chuỗi quá dài để guard `WHERE lease_owner = :owner` không bị dùng như một
 * chỗ chứa dữ liệu tự do.
 */
export function assertLeaseOwner(owner: string, field: string): string {
  assertNonEmptyString(owner, field);
  if ([...owner].length > 128) {
    throw new MailJobValidationError(
      `${field} must be at most 128 code points`,
      'lease-owner-length',
    );
  }
  return owner;
}
