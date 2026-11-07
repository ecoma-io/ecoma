/**
 * **Error matrix** của delivery plane, dùng chung bởi classification và bởi use case.
 *
 * ⚠️ **Vì sao đây là một bảng và không phải chuỗi `if` trong pipeline.** Bảng matrix là
 * canonical (`docs/applications/push-notification/03-operations.md` §5, dùng chung cả hai plane),
 * và nó ánh xạ **một** kết quả của adapter thành **một** cặp hành động cụ thể. Viết chuỗi
 * `if` trong use case nghĩa là mỗi `failureClass` mới phải được nhớ ở một chỗ khác — và lỗi
 * nguy hiểm nhất ở đây không phải quên thêm nhánh, mà là **invalidate nhầm**: chỉ
 * `endpoint_invalid` được invalidate, còn `provider_auth`/`redirect_not_followed` tuy cũng
 * permanent đều **không** (§7.2, §5).
 *
 * ⚠️ **Nhánh `unknown` bị cấm trong type** (`WebPushSendResult` không có nó), nhưng adapter
 * là code của runtime — một kết quả không khớp union là vi phạm contract, và pipeline phải
 * xử lý **như transient** (đường an toàn duy nhất) chứ không phải như terminal. Đó là lý do
 * {@link classifySendResult} nhận `unknown` và **luôn** trả một quyết định.
 */

import type {
  WebPushPermanentFailureClass,
  WebPushSendResult,
  WebPushTransientPhase,
} from './web-push-sender';
import type { AttemptOutcome, AttemptPhase } from './job-state-port';

/**
 * Hành động cụ thể cho **một** kết quả provider — tập đóng, mỗi thành viên là một tổ hợp
 * duy nhất, không phải cờ độc lập.
 *
 * ⚠️ Dùng **một** kiểu discriminated thay vì `{ invalidate: boolean; retry: boolean; … }`:
 * với cờ độc lập, một tổ hợp không hợp lệ (invalidate **và** retry) vẫn biên dịch được và lỗi
 * đó chỉ lộ khi chạy production. Ở đây mọi tổ hợp không hợp lệ đều **không tồn tại trong type**.
 */
export type ProviderAction =
  /** `2xx`: ghi outcome `delivered`, đặt processed marker, ACK. */
  | { readonly kind: 'record_delivered' }
  /**
   * Permanent failure **có** bằng chứng endpoint chết: ghi outcome `failed`, **báo**
   * invalidate (fire, không chặn outcome), đặt processed marker, ACK.
   */
  | { readonly kind: 'record_failed_and_invalidate'; readonly failureClass: 'endpoint_invalid' }
  /** Permanent failure **không** invalidate: ghi outcome `failed`, marker, ACK. */
  | {
      readonly kind: 'record_failed';
      readonly failureClass: Exclude<WebPushPermanentFailureClass, 'endpoint_invalid'>;
    }
  /**
   * Transient: **release lease trước** rồi `retry()`.
   *
   * ⚠️ `releaseFirst` là bắt buộc ở đây chứ không phải ở adapter: adapter không biết claim đã
   * thắng hay chưa, còn pipeline biết (§12, FR-008).
   */
  | {
      readonly kind: 'release_then_retry';
      readonly phase: WebPushTransientPhase;
      readonly retryAfterMs: number | null;
    };

/**
 * Phân loại một kết quả adapter thành hành động.
 *
 * ⚠️ **`vapid_key_missing` là permanent của attempt, không phải transient** (§18): không
 * resolve được key của `vapid_key_id` đã ghi là một lỗi credential mà retry không sửa được
 * (control plane phải rotate/repair, `03-operations.md` §7.2), nên nó **không** release+retry —
 * release ở đây chỉ tạo thêm một vòng claim với kết quả y hệt.
 *
 * ⚠️ **Mọi kết quả không khớp union → `release_then_retry`**, không phải terminal. Đây là
 * lựa chọn fail-safe: một lỗi adapter chưa được phân loại thì retry vô hạn **bounded** vẫn
 * tốt hơn việc đánh dấu một delivery thành `failed` với một lý do bịa ra. `retry_count` +
 * DLQ là hai chỗ dữ liệu thật cho việc đó.
 */
export function classifySendResult(result: unknown): ProviderAction {
  if (!isSendResultShape(result)) {
    return {
      kind: 'release_then_retry',
      phase: 'before_send',
      retryAfterMs: null,
    };
  }
  if (result.outcome === 'delivered') {
    return { kind: 'record_delivered' };
  }
  if (result.outcome === 'failed') {
    if (result.failureClass === 'endpoint_invalid') {
      return { kind: 'record_failed_and_invalidate', failureClass: 'endpoint_invalid' };
    }
    return { kind: 'record_failed', failureClass: result.failureClass };
  }
  return { kind: 'release_then_retry', phase: result.phase, retryAfterMs: result.retryAfterMs };
}

/**
 * Thứ mà pipeline ghi vào job state cho một hành động provider — dùng chung để attempt record
 * và log **không** trôi khỏi nhau.
 */
export interface AttemptProjection {
  readonly outcome: AttemptOutcome;
  readonly phase: AttemptPhase;
}

/**
 * Chiếu hành động provider thành (outcome, phase) để ghi vào job state.
 *
 * ⚠️ `record_failed*` dùng `terminal_sent` (đã có một request tới provider) còn
 * `record_delivered` cũng vậy — nhưng hai cái này được phân biệt bằng `outcome`, không
 * phải `phase`, vì `phase` trả lời "chắc chắn chưa tới provider hay không" và cả hai đều trả
 * lời "không, đã tới".
 */
export function projectAttempt(action: ProviderAction): AttemptProjection {
  switch (action.kind) {
    case 'record_delivered':
      return { outcome: 'delivered', phase: 'terminal_sent' };
    case 'record_failed_and_invalidate':
    case 'record_failed':
      return { outcome: 'failed', phase: 'terminal_sent' };
    case 'release_then_retry':
      return {
        outcome: 'retrying',
        phase: action.phase === 'after_send' ? 'after_send' : 'before_send',
      };
    default:
      return assertNever(action);
  }
}

/**
 * Kiểm một giá trị có khớp union `WebPushSendResult` **mà không ép kiểu**.
 *
 * ⚠️ Đây là **hàng phòng thủ cuối cùng**, không phải validation đầy đủ: một union ba nhánh
 * đã được TypeScript kiểm ở call site của chính repo này, nhưng adapter là code ở biên runtime
 * và `result` đến từ một `Promise` mà không ai kiểm tay được. Kiểm `outcome` + hình dạng tối
 * thiểu của nhánh đủ để phân loại đúng; các field còn lại được đọc qua optional access vì
 * classification chỉ cần `outcome`/`failureClass`/`phase`/`retryAfterMs`.
 */
function isSendResultShape(result: unknown): result is WebPushSendResult {
  if (typeof result !== 'object' || result === null) {
    return false;
  }
  const record = result as { readonly outcome?: unknown };
  if (record.outcome === 'delivered') {
    return true;
  }
  if (record.outcome === 'failed') {
    const failure = result as { readonly failureClass?: unknown };
    return typeof failure.failureClass === 'string';
  }
  if (record.outcome === 'transient') {
    const transient = result as { readonly phase?: unknown };
    return transient.phase === 'before_send' || transient.phase === 'after_send';
  }
  return false;
}

/** `never` sau khi đã duyệt hết thành viên — bắt thành viên mới bị bỏ sót. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled delivery action: ${JSON.stringify(value)}`);
}
