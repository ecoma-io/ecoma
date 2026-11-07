/**
 * Model lifecycle event trung tính của provider — ingest path cho các sự kiện hậu
 * acceptance mà provider phát ra sau khi `send()` đã trả (`delivered`, `deferred`,
 * `bounced`, `failed`, `rejected`, `complained`).
 *
 * Nguồn: `docs/applications/transactional-mailer-job/01-architecture.md` §11.3.
 *
 * ## "Trung tính" nghĩa là gì
 *
 * Model này **không** mang tên field hay giá trị của bất kỳ vendor nào: shape chuẩn hoá
 * ({@link MailLifecycleEvent}) và bộ type ({@link MAIL_LIFECYCLE_EVENT_TYPE_VALUES}) là
 * của bounded context mail. Envelope raw của provider là dữ liệu **untrusted** — chỉ
 * normalizer ({@link normalizeLifecycleEventMessage}) được chạm nó, và chỉ phát ra
 * model đã chuẩn hoá hoặc lý do từ chối đã liệt kê.
 *
 * ## Semantics đã chốt
 *
 * - **Dedupe theo `eventId`**: cùng event giao hai lần là một row — `eventId` là
 *   PRIMARY KEY của storage; replay trả `duplicate`, KHÔNG lỗi.
 * - **Correlate theo `messageId`**: `messageId` của event là `providerMessageId` mà
 *   adapter trả khi `send()` được chấp nhận. Event với `messageId` không tra được
 *   delivery nào vẫn được persist (`deliveryId = NULL`) — dữ liệu thật đã tới, drop
 *   là mất dữ liệu vận hành.
 * - **Persist trước ack**: event chưa row bền vững thì KHÔNG ack Queue message.
 * - **`deferred` không phải lệnh gửi lại**: provider vẫn tự retry delivery; event
 *   này chỉ là quan sát, không path nào ở worker được phát sinh thư mới từ nó.
 * - **Không đè outcome state machine**: `mail_jobs.status` và outcome báo control
 *   plane là nguồn sự thật về kết quả execution của worker; lifecycle events là lớp
 *   quan sát riêng (§11.3), mọi transition state machine hiện có không đọc bảng event.
 *
 * Không import gì ngoài type nội bộ — application layer không chạm D1, Cloudflare,
 * Hono hay infrastructure (`docs/architecture/05-code-architecture.md` §5).
 */

/** Sáu loại lifecycle event đã chốt cho model trung tính (§11.3). */
export const MAIL_LIFECYCLE_EVENT_TYPE_VALUES = [
  'delivered',
  'deferred',
  'bounced',
  'failed',
  'rejected',
  'complained',
] as const;

export type MailLifecycleEventType = (typeof MAIL_LIFECYCLE_EVENT_TYPE_VALUES)[number];

/** Event đã chuẩn hoá — hình dạng duy nhất mà storage và correlation nhận. */
export type MailLifecycleEvent = {
  /** Dedupe key — id sự kiện phía provider, bất biến xuyên replay. */
  readonly eventId: string;
  readonly type: MailLifecycleEventType;
  /** Correlation key — trỏ về `mail_jobs.provider_message_id`. */
  readonly messageId: string;
  /** Mốc sự kiện theo provider (epoch ms) — từ timestamp của envelope. */
  readonly occurredAt: number;
  /** Provider tuyên bố event này là trạng thái cuối của message hay chưa. */
  readonly terminal: boolean;
  /**
   * Lý do đã sanitize của event — **chỉ** từ tập token đóng dưới đây, không bao giờ
   * nguyên văn raw field của provider (`smtpResponse`, `reason` free-form bị bỏ).
   */
  readonly reasonToken: string | null;
};

/**
 * Token lý do chuẩn hoá — đóng, lowercase kebab-case, không mang dữ liệu provider.
 *
 * Token suy từ **loại cấu trúc** có mặt trên event (`bounce`, `failure`, `rejection`,
 * `complaint`), không từ giá trị free-form của chúng: một `reason: "550 5.1.1 User
 * unknown"` của provider là dữ liệu untrusted có thể chứa recipient, chỉ được giữ lại
 * dưới dạng loại cấu trúc.
 */
export const MAIL_LIFECYCLE_REASON_TOKEN_VALUES = [
  'bounce-soft',
  'bounce-hard',
  'delivery-failed',
  'policy-rejected',
  'spam-complaint',
] as const;

export type MailLifecycleReasonToken = (typeof MAIL_LIFECYCLE_REASON_TOKEN_VALUES)[number];

/** Lý do chuẩn hoá tương ứng từng loại event khi envelope không cấu trúc chi tiết nào. */
const DEFAULT_REASON_TOKEN: Readonly<
  Partial<Record<MailLifecycleEventType, MailLifecycleReasonToken>>
> = {
  deferred: 'bounce-soft',
  bounced: 'bounce-hard',
  failed: 'delivery-failed',
  rejected: 'policy-rejected',
  complained: 'spam-complaint',
};

/** Lý do từ chối của {@link normalizeLifecycleEventMessage} — đã liệt kê đóng. */
export type LifecycleEventRejectionReason =
  | 'unparseable'
  | 'missing-field'
  | 'wrong-type'
  | 'unknown-type';

/** Kết quả chuẩn hoá — hoặc event hợp lệ, hoặc lý do từ chối (không bao giờ chi tiết payload). */
export type LifecycleEventNormalization =
  | { readonly ok: true; readonly event: MailLifecycleEvent }
  | { readonly ok: false; readonly reason: LifecycleEventRejectionReason };

/** Trần độ dài của một định danh (`eventId`/`messageId`) — chặn chuỗi khổng lồ. */
const IDENTIFIER_MAX_LENGTH = 256;

/** Trần hợp lệ của mốc thời gian: sau 2020-01-01, trước năm 2100 — loại timestamp phi thực. */
const MIN_SANE_EPOCH_MS = 1_577_836_800_000;
const MAX_SANE_EPOCH_MS = 4_102_444_800_000;

/** Kiểm định danh: chuỗi khác rỗng, không vượt trần — không có gì khác được tin. */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= IDENTIFIER_MAX_LENGTH;
}

/**
 * Chuẩn hoá **một** Queue message lifecycle event thành {@link MailLifecycleEvent}.
 *
 * Input là body Queue dạng string (Queue producer của Event Subscriptions gửi JSON).
 * Mọi sai lệch shape đi qua {@link LifecycleEventNormalization} với lý do đã liệt kê —
 * KHÔNG throw, KHÔNG echo phần payload nào vào lý do (payload là dữ liệu untrusted).
 *
 * `defaultOccurredAtMs` là mốc cho event thiếu `occurredAt` — caller truyền `Date.now()`
 * của chính nó; hàm thuần, không đọc đồng hồ nào.
 *
 * Schema chấp nhận là envelope trung tính đã chốt ở §11.3 — normalizer là ranh giới
 * duy nhất biết shape raw của provider; đổi shape provider chỉ sửa hàm này cùng spec.
 */
export function normalizeLifecycleEventMessage(
  raw: string,
  defaultOccurredAtMs: number,
): LifecycleEventNormalization {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'unparseable' };
  }

  const obj = payload as {
    readonly eventId?: unknown;
    readonly type?: unknown;
    readonly messageId?: unknown;
    readonly occurredAt?: unknown;
    readonly terminal?: unknown;
  };

  if (obj.eventId === undefined || obj.type === undefined || obj.messageId === undefined) {
    return { ok: false, reason: 'missing-field' };
  }
  if (!isIdentifier(obj.eventId) || !isIdentifier(obj.messageId)) {
    return { ok: false, reason: 'wrong-type' };
  }
  if (
    typeof obj.type !== 'string' ||
    !(MAIL_LIFECYCLE_EVENT_TYPE_VALUES as readonly string[]).includes(obj.type)
  ) {
    return { ok: false, reason: 'unknown-type' };
  }

  const type = obj.type as MailLifecycleEventType;

  // `terminal` và `occurredAt` có default trung thực: thiếu `terminal` coi như
  // `false` (chưa chứng minh terminal), thiếu `occurredAt` rơi về mốc caller — event
  // vẫn persist thay vì bị drop vì một field quan sát.
  let terminal = false;
  if (obj.terminal !== undefined) {
    if (typeof obj.terminal !== 'boolean') {
      return { ok: false, reason: 'wrong-type' };
    }
    terminal = obj.terminal;
  }

  let occurredAt = defaultOccurredAtMs;
  if (obj.occurredAt !== undefined) {
    if (
      typeof obj.occurredAt !== 'number' ||
      !Number.isSafeInteger(obj.occurredAt) ||
      obj.occurredAt < MIN_SANE_EPOCH_MS ||
      obj.occurredAt > MAX_SANE_EPOCH_MS
    ) {
      return { ok: false, reason: 'wrong-type' };
    }
    occurredAt = obj.occurredAt;
  }

  return {
    ok: true,
    event: {
      eventId: obj.eventId,
      type,
      messageId: obj.messageId,
      occurredAt,
      terminal,
      // Reason luôn là token đóng suy từ type — normalizer v1 không đọc cấu trúc chi
      // tiết (bounce/failure/rejection/complaint) của provider: field đó chứa free-form
      // text chưa được chốt luật sanitize riêng, nên không đi vào model. `delivered`
      // không mang reason nào (đúng nghĩa của nó — thư đã đến nơi).
      reasonToken: DEFAULT_REASON_TOKEN[type] ?? null,
    },
  };
}

/** Deps của ingest — toàn bộ seam, không I/O ẩn. */
export type LifecycleEventIngestDeps = {
  /** Ghi event đã chuẩn hoá; trả `'stored'` hay `'duplicate'` — không bao giờ throw cho nghiệp vụ. */
  readonly store: (event: MailLifecycleEvent) => Promise<'stored' | 'duplicate'>;
  /** Mốc hiện tại cho row thiếu `occurredAt` — inject để test xác định. */
  readonly nowMs: () => number;
};

/** Kết quả ingest của **một** Queue message — ánh xạ trực tiếp sang ack/retry/quarantine. */
export type LifecycleEventIngestOutcome =
  | { readonly kind: 'stored' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'quarantined'; readonly reason: LifecycleEventRejectionReason }
  | { readonly kind: 'transient' };

/**
 * Ingest **một** Queue message lifecycle event: chuẩn hoá → persist → trả outcome.
 *
 * Hàm này **không** ack — composition root mới là nơi quyết định ack/retry từ
 * {@link LifecycleEventIngestOutcome}, cùng phân vai với `processMailCommand`:
 * - `stored`/`duplicate` → ack (duplicate là dedupe hoạt động đúng, không phải lỗi);
 * - `quarantined` → ack kèm row quarantine (payload hỏng không bao giờ retry được);
 * - `transient` → retry (lỗi ghi D1 chưa có gì bền vững để mất).
 *
 * @returns `transient` khi `store` ném — chưa có gì được persist, retry là an toàn.
 */
export async function ingestLifecycleEventMessage(
  rawBody: string,
  deps: LifecycleEventIngestDeps,
): Promise<LifecycleEventIngestOutcome> {
  const normalized = normalizeLifecycleEventMessage(rawBody, deps.nowMs());
  if (!normalized.ok) {
    return { kind: 'quarantined', reason: normalized.reason };
  }

  try {
    const stored = await deps.store(normalized.event);
    return stored === 'stored' ? { kind: 'stored' } : { kind: 'duplicate' };
  } catch {
    // Lỗi ghi D1 — chưa có gì bền vững; Queue retry sẽ giao lại message này.
    return { kind: 'transient' };
  }
}
