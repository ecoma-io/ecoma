/**
 * Job execution state của delivery plane trên D1 `push-job` — **bốn nhóm** FR-022, và
 * **không** phải logical delivery state.
 *
 * ⚠️ **Vì sao bốn nhóm là bốn method, không phải một `put(JobState)`.** Ranh giới
 * `docs/applications/web-push-notification-job/01-architecture.md` §11b là: worker **MUST**
 * ghi đủ (1) attempt record idempotent theo `(delivery_id, attempt)`, (2) processed marker,
 * (3) **envelope của lần consume đầu** đủ bảy field, (4) reconciliation data. Một
 * `put(state)` gộp cả bốn thành một object làm mất đúng tính chất quan trọng nhất của chúng:
 * attempt record và envelope phải **idempotent theo phím riêng**, và chỉ việc đã persist
 * mới được dùng để short-circuit. Tách port buộc mỗi loại write đi qua đúng một hình dạng,
 * và bắt một người viết mới phải nghĩ về phím idempotency của nó.
 *
 * ⚠️ **Envelope lưu ở đây không được chứa gì ngoài bảy field của §5.** Không credential,
 * không `auth`/`p256dh`, không VAPID key, không header authorization. Đó là lý do
 * `recordFirstConsumption` nhận **envelope đã validate** chứ không nhận object tuỳ ý, và vì
 * vậy cũng là lý do job reconciliation có thể re-deliver **chính xác** message gốc mà không
 * cần hỏi lại control plane (payload không bao giờ nằm trong claim).
 *
 * ⚠️ **`push-job` ngoài Backup/DR scope** (§11b, §17): mất nó là chấp nhận được, hậu quả là mất
 * khả năng re-deliver **của worker** cho việc đã nhận. Message **chưa từng** được consume
 * không có job record và thuộc cơ chế (c) của control plane — job reconciliation không, và
 * không được, giả lập việc phát hiện nó.
 */

/** Envelope bảy field của §5 — dùng lại đúng kiểu canonical của contracts. */
export type StoredDeliveryEnvelope = {
  readonly version: number;
  readonly delivery_id: string;
  readonly notification_id: string;
  readonly subscription_id: string;
  readonly provider_id: string;
  readonly transport: string;
  /** Payload đã materialize ở control plane, dựng lại **nguyên văn** khi re-deliver. */
  readonly payload: Readonly<Record<string, unknown>>;
};

/**
 * Một lần thử xử lý một delivery — idempotent theo `(delivery_id, attempt)`.
 *
 * ⚠️ `attempt` là `message.attempts` của Queue, **không** phải bộ đếm tự tăng trong worker:
 * nó phải cho biết đây là lần consume thứ mấy của *cùng một message trên Queue*, và hai
 * worker cùng consume cùng message phải ghi cùng một phím. Bộ đếm nội bộ sẽ cho hai phím
 * khác nhau và biến idempotency thành tranh chấp.
 */
export interface AttemptRecord {
  readonly deliveryId: string;
  readonly attempt: number;
  /** Kết cục quan sát của lần thử, đã sanitize — **không** phải raw error của provider. */
  readonly outcome: AttemptOutcome;
  /** Provider đã nhận message rồi không; phân biệt nhóm (ii)/(iii) của §12 trong job state. */
  readonly phase: AttemptPhase;
  /** HTTP status của provider khi có; `null` cho lỗi không qua HTTP. */
  readonly httpStatus: number | null;
  /** `Retry-After` đổi ra ms khi provider trả và parse được; `null` khi không có. */
  readonly retryAfterMs: number | null;
  readonly startedAt: number;
  readonly updatedAt: number;
}

/** Kết cục đã sanitize của một attempt — tập đóng, không phải chuỗi tự do. */
export type AttemptOutcome =
  | 'consumed'
  | 'delivered'
  | 'failed'
  | 'retrying'
  | 'skipped'
  | 'contract_violation'
  | 'runtime_unavailable'
  | 'expired_before_send';

/**
 * Pha của một lần thử — phân biệt "chắc chắn chưa tới provider" với "có thể đã tới".
 *
 * ⚠️ Hai nhóm này là **nguồn duplicate tiềm năng** và docs §12 yêu cầu chúng **phải quan sát
 * được trong job state** chứ không chỉ trong log: nhóm `after_send` là nơi duplicate bên ngoài
 * xuất hiện, và một alert dựa trên tỉ lệ này cần đọc được từ D1.
 */
export type AttemptPhase =
  | 'not_sent'
  | 'before_send'
  | 'after_send'
  | 'terminal_sent'
  | 'no_provider_call';

/**
 * Job record của một delivery trên `push-job` — nhóm (1) attempt + (2) processed marker +
 * (3) envelope + (4) reconciliation data, đọc gộp lại để pipeline ra quyết định.
 */
export interface JobRecord {
  readonly deliveryId: string;
  /** Envelope của lần consume **đầu tiên** — bản duy nhất dùng để re-deliver. */
  readonly envelope: StoredDeliveryEnvelope;
  /** Đếm số lần consume đã thấy; tăng ở mỗi lần bắt đầu xử lý. */
  readonly consumeCount: number;
  /** Lần thử đang mở (chưa kết thúc) — `null` khi không có attempt nào dang dở. */
  readonly openAttempt: {
    readonly attempt: number;
    readonly startedAt: number;
  } | null;
  /** Attempt đã kết thúc gần nhất — cơ sở của bounded retry/attempt budget. */
  readonly lastAttempt: AttemptRecord | null;
  /**
   * Processed marker: `true` khi đã persist **kết cục** (delivered/failed, hoặc no-op path hợp
   * lệ như đã hết `expires_at`). Đây là thứ short-circuit redelivery.
   */
  readonly processed: boolean;
  /** Kết cục đã persist — `null` khi marker chưa được đặt. */
  readonly terminalOutcome: 'delivered' | 'failed' | 'expired' | null;
  /** Lần consume cuối cùng đã ghi log/metric; mốc thời gian cho ngưỡng "kẹt". */
  readonly lastConsumedAt: number;
  readonly updatedAt: number;
}

/**
 * Job state của chính worker — đúng bốn nhóm FR-022.
 *
 * ⚠️ **Không** có method nào ghi logical delivery state (`delivered`/`failed` trên D1 `push`):
 * đó là state của control plane và worker **MUST NOT** ghi (§23.16). Tên `markProcessed`
 * ghi **processed marker của job**, tức "việc này đã xong ở phía tôi" — khác với việc đặt
 * delivery thành terminal, việc đó đi qua `DeliveryRuntimePort.writeOutcome`.
 */
export interface JobStatePort {
  /**
   * Ghi attempt record **idempotent** theo `(delivery_id, attempt)`, và ghi envelope lần
   * consume đầu nếu chưa có.
   *
   * ⚠️ Gọi lại với cùng `(delivery_id, attempt)` **MUST** là no-op: không overwrite, không
   * tăng counter. Đây là điều kiện đủ để W1 (crash trước claim) và Queue redelivery không
   * sinh state mâu thuẫn.
   *
   * @returns `true` khi record mới được tạo, `false` khi đã tồn tại (no-op).
   */
  beginAttempt(input: {
    readonly envelope: StoredDeliveryEnvelope;
    readonly attempt: number;
    readonly nowMs: number;
  }): Promise<boolean>;

  /** Đóng attempt đang mở với kết quả đã phân loại; idempotent như {@link beginAttempt}. */
  completeAttempt(input: {
    readonly deliveryId: string;
    readonly attempt: number;
    readonly outcome: AttemptOutcome;
    readonly phase: AttemptPhase;
    readonly httpStatus: number | null;
    readonly retryAfterMs: number | null;
    readonly nowMs: number;
  }): Promise<void>;

  /**
   * Đặt processed marker — chỉ **sau khi** state cần thiết đã persist (§8).
   *
   * ⚠️ Marker là thứ cho phép skip redelivery; đặt nó sớm (trước outcome) biến một lần gửi
   * chưa persist thành một lần bị bỏ qua vĩnh viễn. Pipeline gọi nó ở đúng một chỗ: sau khi
   * đường đóa đã ghi (hoặc đã chứng minh là không cần ghi).
   */
  markProcessed(input: {
    readonly deliveryId: string;
    readonly terminalOutcome: 'delivered' | 'failed' | 'expired';
    readonly nowMs: number;
  }): Promise<void>;

  /** Đọc job record; `null` khi delivery này chưa từng được consume. */
  findByDeliveryId(deliveryId: string): Promise<JobRecord | null>;

  /**
   * Liệt kê job **đã có record** mà chưa kết thúc vượt ngưỡng — nguồn của job reconciliation.
   *
   * ⚠️ Điều kiện lọc là "chưa processed **và** `last_consumed_at` cũ hơn `stuckAfterMs`"
   * (hoặc không có gì cũ hơn), và **không bao giờ** trả về job đã processed: re-deliver một
   * việc đã xong là tạo việc mà không có lý do.
   */
  listStuck(input: {
    readonly stuckAfterMs: number;
    readonly nowMs: number;
    readonly limit: number;
    /**
     * Trần attempt cho attempt budget của job reconciliation. Job có `consume_count` hoặc
     * `lastAttempt.attempt` đạt/vượt giá trị này bị coi là **đã kiệt** và không được
     * re-deliver. Tuỳ chọn: khi vắng mặt, repository không áp ngân sách (giữ tương thích
     * với các caller cũ) — nhưng job reconciliation **bắt buộc** truyền giá trị này.
     */
    readonly maxAttempts?: number;
  }): Promise<readonly JobRecord[]>;
}
