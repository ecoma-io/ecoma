/**
 * Provider port nội bộ của worker `transactional-mailer-job` — seam **duy nhất**
 * mà worker core dùng để giao một delivery ra provider.
 *
 * Nguồn canonical: `docs/applications/transactional-mailer-job/01-architecture.md`
 * §11.1 (contract và bảng chiếu error matrix), §11.2 (trách nhiệm adapter); yêu
 * cầu FR-005 ở `02-requirements.md`. Khối type ở §11.1 là canonical **cho tới
 * khi** port được materialize; từ file này trở đi **đây** là bản canonical của
 * shape, còn tài liệu giữ seam, boundary và bất biến.
 *
 * Port là interface **nội bộ** giữa các layer trong cùng bounded context, không
 * phải wire contract giữa hai service: nó không nằm ở
 * `@ecoma-io/transactional-mail-contracts` và không thuộc quyền sở hữu của control
 * plane. Vì vậy kết quả của port không bao giờ mang class `contract` hay
 * `internal-auth` — hai class đó không phát sinh từ provider
 * (`03-operations.md` §3), và chúng bị loại khỏi nhóm provider bằng cấu trúc
 * type chứ không bằng quy ước: lỗi `401`/`403` của private API là lỗi
 * authn/authz của **chính worker**, không phải input của port này.
 */

/**
 * Một lần giao delivery cho provider adapter.
 *
 * Request mang **đúng sáu field**. Port cố ý **không** mang `app`, `messageId`,
 * `dispatchGeneration`, sender/`from`, endpoint, credential hay template
 * metadata: fencing state và định danh nội bộ của control plane không đi ra
 * provider (§11.1). Cần sender theo từng app là một contract mới phải sửa port,
 * không được adapter tự suy ra từ `deliveryId` hay recipient.
 */
export type MailProviderSendRequest = {
  /**
   * Định danh ổn định của logical delivery — **ứng viên** idempotency key khi
   * provider hỗ trợ cơ chế (§9.3). Giá trị không đổi xuyên
   * `dispatch_generation`: redrive tăng generation nhưng giữ nguyên key.
   *
   * Không phải guarantee chống duplicate. Port này không tự bảo đảm exactly-once
   * và không tuyên bố dedupe nào trừ khi trạng thái provider idempotency đã
   * `verified` (§9.3).
   */
  readonly deliveryId: string;

  /** Recipient cuối cùng, resolve từ runtime material của private interface. */
  readonly recipient: string;

  /** Subject đã render. */
  readonly subject: string;

  /** Body đã render. */
  readonly body: string;

  /**
   * Định dạng nội dung của message — ở v1 **chỉ** `'text/html'`.
   *
   * Literal viết thẳng ở đây chứ không import hằng tương ứng của bounded context
   * (`MAIL_CONTENT_TYPE`, `libs/transactional-mail-contracts/src/shared.ts`, theo
   * `transactional-mail/01-architecture.md` §7.2): port này **không import gì**
   * (bất biến được spec chốt), nên giá trị v1 của contract phải được viết lại
   * bằng literal thay vì trỏ sang một package khác. Hệ quả là đổi giá trị ở
   * contracts **không** tự động làm đỏ test ở đây — hai chỗ khai cùng một giá trị
   * và phải sửa cùng nhau; spec chỉ ghim được phía port (`'text/plain'` và
   * `'application/json'` bị `@ts-expect-error` loại).
   */
  readonly contentType: 'text/html';

  /**
   * Trần cứng cho **toàn bộ** lần gọi này, tính bằng **epoch milliseconds tuyệt
   * đối** — không phải timeout duration.
   *
   * Worker resolve bằng `min(now + providerTimeoutMs, lease_expires_at)` với
   * lease **sau** khi đã renew cho execution (§9.2.1). Adapter MUST bắt buộc
   * deadline này và MUST NOT kéo dài nó (§11.1).
   *
   * `deadlineMs <= now` khi request tới adapter nghĩa là claim vừa mất hoặc lease
   * vừa hết: adapter MUST trả ngay `rejected` / `retryable` (`errorCode` là
   * `timeout`) mà **không** gọi provider — không side effect, không tiêu network.
   * Deadline chỉ cắt lời chờ của worker; nó không chứng minh request chưa rời
   * khỏi Worker.
   */
  readonly deadlineMs: number;
};

/**
 * Lớp lỗi canonical của provider — **đúng ba value**.
 *
 * Đây là alias của union inline ở §11.1, không phải một biến thể khác của
 * contract: adapter, test và orchestration dùng chung một định nghĩa thay vì
 * chép lại ba literal ở ba nơi.
 */
export type MailProviderErrorClass = 'retryable' | 'permanent' | 'credential';

/**
 * Kết quả một lần gọi provider, đóng ở đúng hai nhánh.
 *
 * `accepted` là bằng chứng provider **đã chấp nhận** request, không hơn: nó
 * không chứng minh thư đã tới inbox (§9.3), và nó cũng không hoàn tác được —
 * deadline hay huỷ request không rút lại một acceptance đã xảy ra (§9.1).
 */
export type MailProviderSendResult =
  | {
      readonly kind: 'accepted';

      /**
       * Chỉ có giá trị khi adapter xác định được **đáng tin cậy** từ response
       * của provider; chuỗi rỗng hoặc chỉ có whitespace cũng tính là không có.
       * Adapter MUST NOT bịa, MUST NOT suy ra từ dữ liệu khác (`deliveryId`,
       * recipient), và worker MUST NOT dùng nó để kết luận thư đã tới inbox.
       */
      readonly providerMessageId: string | null;

      /**
       * Token cảnh báo **đã sanitize** cho trường hợp acceptance vẫn được xác
       * nhận, ví dụ `malformed-response`. Không đổi outcome: giá trị này đi vào
       * provider error metric và audit, **không** vào `last_error` (§11.1).
       */
      readonly warningCode: string | null;
    }
  | {
      readonly kind: 'rejected';

      /** Xem {@link MailProviderErrorClass}. */
      readonly errorClass: MailProviderErrorClass;

      /**
       * Sàn cho lần thử kế tiếp, là **độ trễ tương đối** theo milliseconds;
       * `null` khi provider không trả `Retry-After`. Việc clamp về giây nguyên
       * và theo retention của Queue là của worker, không phải của adapter
       * (§11.1) — và nó MUST NOT được dùng để giữ Queue message ở trạng thái
       * processing.
       */
      readonly retryAfterMs: number | null;

      /**
       * Token **đã sanitize**, ví dụ `http-429`, `http-3xx`, `timeout`,
       * `network`, `malformed-response`; giá trị này đi vào `last_error` và
       * metric. MUST NOT chứa recipient, nội dung thư, endpoint, credential hay
       * raw body của provider.
       */
      readonly errorCode: string;
    };

/**
 * Seam duy nhất để worker giao một delivery ra provider.
 *
 * Worker core, orchestration và test MUST inject port này thay vì gọi network
 * trực tiếp, để state machine test được ngay cả khi provider thật chưa được
 * chọn. Đây cũng là lý do fake adapter dùng **chính** interface này, không tạo
 * một API test riêng (§11.2).
 *
 * Port không tự quyết định `ack()` / `retry()` / `sent` / `failed` / `blocked`:
 * phân loại kết quả thành hành động là việc của Queue consumer và state machine,
 * không phải của port hay adapter.
 */
export interface MailProviderPort {
  /**
   * Giao **một** delivery đã claim cho provider.
   *
   * Adapter **resolve**, không reject: mọi outcome nghiệp vụ — kể cả `retryable`,
   * `permanent` và `credential` — đi qua {@link MailProviderSendResult}. Throw chỉ
   * dành cho bug nội bộ không biểu diễn được hợp lệ bằng result contract (§11.1).
   *
   * Một lần gọi tương ứng với **một** attempt của **một** execution đã claim:
   * adapter MUST NOT retry bên trong lần gọi này (§11.2).
   */
  send(request: MailProviderSendRequest): Promise<MailProviderSendResult>;
}
