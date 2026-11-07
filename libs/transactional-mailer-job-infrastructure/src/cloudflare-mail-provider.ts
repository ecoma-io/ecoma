/**
 * Adapter provider thật: Cloudflare Email Sending (binding `send_email`), đứng sau
 * {@link MailProviderPort} — seam duy nhất mà worker core dùng để giao một delivery
 * ra provider (`docs/applications/transactional-mailer-job/01-architecture.md` §11.1).
 *
 * Đây là **chỗ duy nhất** chứa chi tiết vendor của Cloudflare: shape `send()`, bộ mã
 * lỗi `E_*` và semantics của binding không rò lên trên port, và port không biết
 * Cloudflare tồn tại (§11.2).
 *
 * ## Mô hình lỗi của binding khác hẳn HTTP relay
 *
 * `send()` của binding **throw** thay vì trả status: mọi outcome nghiệp vụ phải được
 * bắt ở đây rồi phân loại vào {@link MailProviderSendResult} — resolve, không reject
 * (§11.1). `error.code` của Cloudflare là dữ liệu **untrusted** ở ranh giới adapter:
 * chỉ một tập mã **đã liệt kê tường minh** được map sang class canonical; mã lạ
 * (provider thêm mã mới) rơi về `retryable`/`provider-unknown-error` — fail-closed về
 * retry thay vì `permanent`, vì không có bằng chứng nào request sai.
 *
 * ## Không có idempotency API
 *
 * Binding `send()` **không** nhận idempotency key nào (khác Resend có `Idempotency-Key`
 * đã tài liệu hóa): adapter coi mọi lần gọi là **có thể gửi trùng**, không tuyên bố
 * dedupe nào — trạng thái idempotency của provider ở §9.3 là `unsupported`, không phải
 * `unverified`. Hệ quả: cửa sổ an toàn sau marker `provider_call_at` của §9.6 không có
 * nhánh "auto-resend an toàn" — mọi mơ hồ đều đi tới `provider-ambiguous-outcome`.
 *
 * ## Ranh giới bảo mật (không thỏa hiệp — cùng quy tắc Resend adapter)
 *
 * - **Không có một lệnh log nào** trong file này: sender, recipient, subject, body và
 *   mọi message của exception **không** bao giờ chạm log hay metric (§13, §11.2).
 * - **Resolve, không reject**: mọi outcome nghiệp vụ — kể cả `retryable` — đi qua
 *   {@link MailProviderSendResult}; `send` chỉ ném khi chính adapter có bug.
 * - **Không retry nội bại**: một lần gọi port là **một** attempt của **một** execution
 *   đã claim, slot ngân sách **B** đã tiêu ở claim (§9.2.1 (a)); binding tự quản retry
 *   delivery phía provider (soft bounce) — đó không phải retry của worker.
 * - **Không log exception/stack nguyên văn**: `error.message` của binding có thể mang
 *   dữ liệu request; chỉ `error.code` **thuộc tập đã liệt kê** đi ra ngoài dưới dạng
 *   token đã sanitize.
 * - **Sender identity thuộc trusted config**: `from` đến từ config của adapter, không
   từ request/port (§11.1).
 */

import type {
  MailProviderPort,
  MailProviderSendRequest,
  MailProviderSendResult,
} from '@ecoma-io/transactional-mailer-job-application';

/* -------------------------------------------------------------------------------------------- */
/* Shape binding — khai tối thiểu, không import workers-types                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * Binding `send_email` ở đúng subset mà adapter dùng.
 *
 * Khai cục bộ đúng subset thay vì lấy surface đầy đủ từ ambient types: cùng lý do với
 * Resend adapter (docblock module của nó) và `d1-database-like.ts` — lib là `runtime:edge`,
 * bề mặt type của adapter phải hẹp đúng những gì nó gọi. Composition root cast env binding
 * qua `unknown` vào shape này — tương thích subset được ghim ở spec, không chứng minh lại
 * tại call site.
 */
export interface SendEmailBindingLike {
  send(message: {
    readonly to: string;
    readonly from: string;
    readonly subject: string;
    readonly html: string;
  }): Promise<{ readonly messageId: string }>;
}

/* -------------------------------------------------------------------------------------------- */
/* Config và deps                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * Cấu hình provider Cloudflare — **mirror cấu trúc** của `CloudflareProviderConfig` ở
 * `apps/transactional-mailer-job/src/config.ts` (cùng cơ chế ghim hai phía bằng spec
 * đối chiếu field như `ResendProviderConfig`).
 *
 * Không có endpoint/token: binding là kênh in-process của cùng Cloudflare account
 * (không qua internet, không credential trong worker — architecture `01` §6). `sender`
 * là địa chỉ sender cố định từ trusted config; binding còn bị chặn thêm bởi
 * `allowed_sender_addresses` ở wrangler.jsonc — hai lớp chặn độc lập.
 */
export interface CloudflareProviderConfig {
  /** Binding `send_email` từ `env` — bắt buộc tồn tại, thiếu là fail-closed ở loader. */
  readonly binding: SendEmailBindingLike;
  /** Sender cố định (trusted config) — `no-reply@ecoma.io` ở mọi environment. */
  readonly sender: string;
  /** Trần chờ của **một** request provider (milliseconds). */
  readonly timeoutMs: number;
}

/** Dependency inject được — để test không chạm binding thật và không phụ thuộc đồng hồ. */
export type CloudflareMailProviderDeps = {
  /** Mặc định `Date.now`. Inject để mọi ca deadline xác định. */
  readonly nowMs?: () => number;
};

/* -------------------------------------------------------------------------------------------- */
/* Hằng đã sanitize                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * Token `errorCode`/`warningCode` — kebab-case đúng quy tắc token đã sanitize
 * (`SANITIZED_ERROR_TOKEN_PATTERN`), hình dạng `provider-*` như bảng của Resend
 * adapter, để `last_error` và metric phân biệt được nhánh mà không mang dữ liệu request.
 */
const ERROR_CODES = {
  /** Deadline đã qua, hoặc không xác định được — §11.1. */
  timeout: 'timeout',
  /** Exception không mang `code` đọc được — nhánh fail-closed. */
  unknownError: 'provider-unknown-error',
  /** `send()` resolve nhưng không xác định được `messageId` đáng tin cậy. */
  unparseableId: 'provider-id-unparseable',
  /** Lỗi tạm thời phía Cloudflare hoặc transport — thử lại có cơ hội. */
  rateLimited: 'provider-rate-limited',
  transportRetryable: 'provider-transport-error',
  /** Lỗi cấu hình domain/account/sender — credential-class (blocked, không retry). */
  senderUnverified: 'provider-sender-unverified',
  accountSuspended: 'provider-account-suspended',
  /** Request bị provider từ chối vĩnh viễn (validation, recipient bị chặn). */
  requestRejected: 'provider-request-rejected',
  recipientRejected: 'provider-recipient-rejected',
} as const;

/**
 * Map `error.code` của Cloudflare → kết quả port canonical.
 *
 * Chỉ mã **đã liệt kê trong tài liệu chính thức** (`email-service/api/send-emails/
 * workers-api`, snapshot 2026-10) được map. Mã lạ → `retryable` (`provider-unknown-error`):
 * không có bằng chứng nào request sai nên không được chốt `permanent`, và retry một
 * lần qua Queue rẻ hơn misclassify một lỗi tạm thời thành `failed`.
 */
const ERROR_CODE_CLASSIFICATION: Readonly<
  Map<
    string,
    { readonly errorClass: 'retryable' | 'permanent' | 'credential'; readonly errorCode: string }
  >
> = new Map([
  // Tạm thời — retry có cơ hội.
  ['E_RATE_LIMIT_EXCEEDED', { errorClass: 'retryable', errorCode: ERROR_CODES.rateLimited }],
  ['E_DAILY_LIMIT_EXCEEDED', { errorClass: 'retryable', errorCode: ERROR_CODES.rateLimited }],
  [
    'E_INTERNAL_SERVER_ERROR',
    { errorClass: 'retryable', errorCode: ERROR_CODES.transportRetryable },
  ],
  // Cấu hình sender/domain/account — credential-class (blocked), sửa config chứ không retry.
  ['E_SENDER_NOT_VERIFIED', { errorClass: 'credential', errorCode: ERROR_CODES.senderUnverified }],
  [
    'E_SENDER_DOMAIN_NOT_AVAILABLE',
    { errorClass: 'credential', errorCode: ERROR_CODES.senderUnverified },
  ],
  ['E_ACCOUNT_SUSPENDED', { errorClass: 'credential', errorCode: ERROR_CODES.accountSuspended }],
  // Từ chối vĩnh viễn nội dung/định dạng request.
  ['E_VALIDATION_ERROR', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  ['E_FIELD_MISSING', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  ['E_TOO_MANY_RECIPIENTS', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  ['E_TOO_MANY_ATTACHMENTS', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  ['E_CONTENT_TOO_LARGE', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  ['E_HEADER_NOT_ALLOWED', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  ['E_HEADER_USE_API_FIELD', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  ['E_HEADER_VALUE_INVALID', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  ['E_HEADER_VALUE_TOO_LONG', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  ['E_HEADER_NAME_INVALID', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  ['E_HEADERS_TOO_LARGE', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  ['E_HEADERS_TOO_MANY', { errorClass: 'permanent', errorCode: ERROR_CODES.requestRejected }],
  // Recipient bị chặn — permanent: retry cùng recipient chỉ lặp lại đúng lỗi này.
  [
    'E_RECIPIENT_NOT_ALLOWED',
    { errorClass: 'permanent', errorCode: ERROR_CODES.recipientRejected },
  ],
  ['E_RECIPIENT_SUPPRESSED', { errorClass: 'permanent', errorCode: ERROR_CODES.recipientRejected }],
  // SMTP delivery đã thất bại vĩnh viễn phía provider (soft bounce hết retry hay hard
  // bounce): lần gọi send() này đã đi tới provider, retry từ worker sẽ gửi thư thứ hai
  // cho cùng delivery — tín hiệu chuẩn là lifecycle event `bounced`/`failed` của provider.
  ['E_DELIVERY_FAILED', { errorClass: 'permanent', errorCode: 'provider-delivery-failed' }],
]);

/**
 * Trần chờ thực tế của lần gọi này: `min(timeout cấu hình, phần deadline còn lại)` —
 * cùng `callBudgetMs` của Resend adapter (§11.1 bắt buộc adapter không kéo dài deadline).
 */
function callBudgetMs(configuredTimeoutMs: number, remainingDeadlineMs: number): number {
  const configured = Number.isFinite(configuredTimeoutMs)
    ? Math.max(0, configuredTimeoutMs)
    : remainingDeadlineMs;

  return Math.min(configured, remainingDeadlineMs);
}

/* -------------------------------------------------------------------------------------------- */
/* Adapter                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * Dựng adapter Cloudflare Email Sending cho {@link MailProviderPort}.
 *
 * Một lần gọi `send` tương ứng với **một** attempt của **một** execution đã claim:
 * không retry nội bại (§11.2). Binding **không** nhận `AbortSignal` trong shape mà
 * adapter dùng, nên trần chờ thực thi bằng `Promise.race` với timeout — hết trần vẫn
 * **không** hoàn tác một acceptance có thể đã xảy ra (§9.1); adapter trả `rejected`/
 * `retryable`/`timeout` và để worker xử lý mơ hồ theo §9.6.
 *
 * @param config Binding, sender cố định và timeout — tất cả từ trusted config của
 * chính worker; adapter không nhận gì từ request, runtime material hay Queue ngoài
 * sáu field của port.
 * @param deps Dependency inject cho test (`nowMs`).
 */
export function createCloudflareMailProvider(
  config: CloudflareProviderConfig,
  deps: CloudflareMailProviderDeps = {},
): MailProviderPort {
  const now = deps.nowMs ?? Date.now;

  return {
    async send(request: MailProviderSendRequest): Promise<MailProviderSendResult> {
      const startedAtMs = now();

      // Deadline trước **mọi** thứ khác — cùng bất biến với Resend adapter (§11.1):
      // quá hạn thì không có side effect nào. Cả hai vế của phép so sánh phải hữu hạn:
      // một đồng hồ `NaN` làm `deadlineMs <= nowMs` luôn `false` và request đã quá hạn
      // rơi xuống đường gửi — trần cứng bị vô hiệu hoá im lặng.
      if (!Number.isFinite(request.deadlineMs) || !Number.isFinite(startedAtMs)) {
        return rejectedResult('retryable', ERROR_CODES.timeout);
      }
      if (request.deadlineMs <= startedAtMs) {
        return rejectedResult('retryable', ERROR_CODES.timeout);
      }

      const budgetMs = callBudgetMs(config.timeoutMs, request.deadlineMs - startedAtMs);

      // Race giữa lời gọi binding và một timer **báo hiệu** (`TIMEOUT_SIGNAL`, không phải
      // giá trị result): timer thắng nghĩa là hết trần chờ — request có thể vẫn đang chạy
      // phía binding (không huỷ được), nên đây là mơ hồ §9.1, trả `retryable`/`timeout`.
      const sendPromise = config.binding
        .send({
          to: request.recipient,
          from: config.sender,
          subject: request.subject,
          // `contentType` của port v1 chỉ là `'text/html'` (§11.1) — body đi vào `html`,
          // không có nhánh text nào để cấu hình sai.
          html: request.body,
        })
        .catch((error: unknown) => {
          throw new BindingSendError(error);
        });

      let timedOut = false;
      const timeoutPromise = new Promise<typeof TIMEOUT_SIGNAL>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve(TIMEOUT_SIGNAL);
        }, budgetMs);
      });

      try {
        const outcome = await Promise.race([sendPromise, timeoutPromise]);

        if (outcome === TIMEOUT_SIGNAL) {
          return rejectedResult('retryable', ERROR_CODES.timeout);
        }

        const messageId =
          typeof outcome.messageId === 'string' && outcome.messageId.trim().length > 0
            ? outcome.messageId
            : null;

        return {
          kind: 'accepted',
          // Binding trả `messageId` là correlation key cho lifecycle event; không có/
          // không đọc được thì `null` — không bịa, không suy từ `deliveryId` (§11.1).
          providerMessageId: messageId,
          warningCode: messageId === null ? ERROR_CODES.unparseableId : null,
        };
      } catch (error: unknown) {
        if (timedOut) {
          // Hết trần chờ đúng lúc binding ném lỗi: mơ hồ vẫn là mơ hồ — `timeout`.
          return rejectedResult('retryable', ERROR_CODES.timeout);
        }

        const code = BindingSendError.codeOf(error);
        if (code === null) {
          // Exception không phải `BindingSendError` — bug nội bộ của adapter. §11.1 cho
          // phép throw ở nhánh này; worker xử lý như state chưa persist được (hàng 8).
          throw error;
        }
        const mapped = ERROR_CODE_CLASSIFICATION.get(code);
        if (mapped !== undefined) {
          return rejectedResult(mapped.errorClass, mapped.errorCode);
        }
        // Mã Cloudflare chưa liệt kê — fail-closed về `retryable` (xem JSDoc map).
        return rejectedResult('retryable', ERROR_CODES.unknownError);
      }
    },
  };
}

/** Sentinel phân biệt "timer hết trần" với mọi giá trị result của binding. */
const TIMEOUT_SIGNAL: unique symbol = Symbol('cloudflare-mail-provider-timeout');

/** Nhánh `rejected` — `retryAfterMs` luôn `null`: binding không có cơ chế `Retry-After`. */
function rejectedResult(
  errorClass: 'retryable' | 'permanent' | 'credential',
  errorCode: string,
): MailProviderSendResult {
  return { kind: 'rejected', errorClass, errorCode, retryAfterMs: null };
}

/** Mô hình event-loop của workerd: `setTimeout` có ở global, khai module-scope như Resend adapter. */
declare function setTimeout(handler: () => void, timeout: number): number;

/**
 * Wrapper giữ `error.code` nguyên thuỷ của binding mà không làm `error.message` rò qua
 * bất kỳ đường nào: chỉ {@link BindingSendError.codeOf} đọc được nó, và chỉ trả về
 * `code` khi nó là chuỗi.
 */
class BindingSendError extends Error {
  readonly #causeError: unknown;

  constructor(causeError: unknown) {
    // KHÔNG truyền `causeError` vào `super(..., { cause })`: một số runtime serialize
    // `cause` khi log Error — message của exception gốc là bề mặt rò rỉ tiếp theo (§11.2).
    super('binding send failed');
    this.name = 'BindingSendError';
    this.#causeError = causeError;
  }

  /** Chỉ trả `error.code` khi là chuỗi; mọi thứ khác của exception gốc không đi ra. */
  static codeOf(error: unknown): string | null {
    if (error instanceof BindingSendError) {
      const code = (error.#causeError as { readonly code?: unknown } | null)?.code;
      return typeof code === 'string' ? code : null;
    }
    return null;
  }
}
