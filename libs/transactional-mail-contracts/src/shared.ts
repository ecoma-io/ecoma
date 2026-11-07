/**
 * Kiểu chạy trên wire, dùng chung cho cả provider (`transactional-mail`) lẫn consumer
 * (`transactional-mailer-job`) và cho các application gọi `POST /v1/messages`.
 *
 * ⚠️ Mọi union ở đây được **khai báo lại ở tầng contracts** theo đúng quy tắc của
 * `docs/architecture/05-code-architecture.md` §4: `type:contracts` không được phụ thuộc
 * `type:domain` kể cả gián tiếp, nên không có chuyện import union từ tầng domain —
 * contract là thứ provider publish, không phải một tầng để đi theo chiều phụ thuộc.
 *
 * Mọi giá trị dưới đây đều lấy từ tài liệu đã chốt; file này **không** tự đặt giá trị
 * mới. Nguồn của từng tập được ghi ngay trên hằng tương ứng.
 */

/** Trạng thái logical của một `Mail Message` — nguồn: `docs/applications/transactional-mail/01-architecture.md` §4.2. */
export const MAIL_MESSAGE_STATUS_VALUES = [
  'accepted',
  'queued',
  'sent',
  'failed',
  'blocked',
] as const;

/** Union trạng thái message trên wire. */
export type MailMessageStatus = (typeof MAIL_MESSAGE_STATUS_VALUES)[number];

/**
 * Outcome mà delivery worker báo lên control plane — nguồn:
 * `docs/applications/transactional-mail/01-architecture.md` §7.2 và
 * `docs/applications/transactional-mailer-job/02-requirements.md` FR-007.
 */
export const MAIL_OUTCOME_VALUES = ['sent', 'failed', 'blocked'] as const;

/** Union outcome trên wire. */
export type MailOutcome = (typeof MAIL_OUTCOME_VALUES)[number];

/**
 * Bộ phân loại lỗi canonical của mail delivery — nguồn duy nhất:
 * `docs/applications/transactional-mailer-job/03-operations.md` §3 (năm loại MUST tách bạch).
 *
 * ⚠️ Hai giá trị `execution-budget-exhausted` và `delivery-not-found` **không** thuộc bộ
 * này: chúng là trạng thái nội bộ của worker/control plane, không bao giờ được gửi làm
 * `error_class` (`docs/applications/transactional-mail/02-requirements.md` FR-005).
 */
export const MAIL_ERROR_CLASS_VALUES = [
  'retryable',
  'permanent',
  'credential',
  'contract',
  'internal-auth',
] as const;

/** Union `error_class` trên wire. */
export type MailErrorClass = (typeof MAIL_ERROR_CLASS_VALUES)[number];

/**
 * Kết quả của `POST /internal/deliveries/:delivery_id/outcome` — nguồn:
 * `docs/applications/transactional-mail/01-architecture.md` §6.2.2.
 *
 * `stale` **không** phải success; worker chỉ coi outcome đã được chấp nhận bền vững khi
 * `result ∈ {applied, duplicate}`.
 */
export const OUTCOME_RESULT_VALUES = ['applied', 'duplicate', 'stale'] as const;

/** Union `result` trên wire. */
export type OutcomeResult = (typeof OUTCOME_RESULT_VALUES)[number];

/**
 * `content_type` của v1 là **hằng của service**, không phải cột database
 * (`docs/applications/transactional-mail/01-architecture.md` §7.2): FR-003 render với
 * HTML-escape cho mọi biến nên một message chỉ có một định dạng.
 */
export const MAIL_CONTENT_TYPE = 'text/html';

/** Union `content_type` trên wire — v1 chỉ có một giá trị. */
export type MailContentType = typeof MAIL_CONTENT_TYPE;

/**
 * Kiểm tra một giá trị có phải chuỗi khác rỗng sau trim hay không.
 *
 * Đây là mức kiểm **tối thiểu** mà tài liệu đã chốt cho các định danh trên wire.
 * ⚠️ **Không** kiểm tiền tố `dlv_`/`msg_` hay ngữ pháp của suffix: mẫu định danh đó
 * (`delivery_id` (`dlv_`) ở `01-architecture.md` §4.2) là khai báo schema, trong khi
 * **ID strategy vẫn là mục chưa chốt** ở `docs/architecture/01-architecture.md` §10.
 * Hard-code tiền tố lúc này sẽ biến một quyết định đang mở thành contract chính thức.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Kiểm tra một giá trị có phải số nguyên an toàn dương hay không (dùng cho `dispatch_generation`). */
export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
