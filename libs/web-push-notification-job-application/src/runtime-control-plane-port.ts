/**
 * Port của private delivery runtime API của `push-notification` — **bốn operation**, không
 * có operation thứ năm.
 *
 * ⚠️ **Vì sao port này là một interface mà không phải client HTTP.** Client HTTP (path dựng
 * tay, header auth, parse body) là **infrastructure**; nó thuộc
 * `web-push-notification-job-infrastructure/src/runtime-control-plane.ts`. Tầng application
 * chỉ cần biết "claim một delivery", "trả lease", "ghi outcome", "báo subscription chết" —
 * và biết **kết quả có phải lỗi contract hay không**. Việc đó là chính sách, không phải giao
 * thức, nên nó thuộc tầng application.
 *
 * ⚠️ **Quyền tối thiểu là một danh sách đóng** (§6.1): `claim` · `release` · `outcome` ·
 * `invalidate`. Interface này **không** có `getDelivery` — vì private API không có `GET`
 * (§6: material chỉ trong response `200` của `claim`), và một port có method đọc là một lời
 * mời viết code đọc material mà không claim.
 *
 * ⚠️ **Fail-closed ở tầng dưới.** Secret thiếu/rỗng là `RuntimeAuthResolutionError` — **không**
 * phải `null`. Trả `null` sẽ làm caller phải tự phân biệt "chưa cấu hình" với "peer nói không",
 * và phân biệt đó là một lỗ hổng: mọi nhánh xử lý sau đó đều dễ quên "chưa cấu hình" ⇒ gửi
 * không xác thực.
 */

import type {
  ClaimRejectionReason,
  DeliveryClaim,
  DeliveryOutcomeValue,
  TerminalDeliveryStatus,
} from '@ecoma-io/push-notification-contracts';

/**
 * Lỗi cấu hình runtime API: thiếu/rỗng `RUNTIME_API_SHARED_SECRET`, hoặc thiếu
 * `RUNTIME_API_EXPECTED_PRINCIPAL`.
 *
 * ⚠️ Đây là lỗi **fail-closed**: caller **MUST NOT** gửi request nào khi bắt được lỗi này. Nó
 * tách riêng khỏi lỗi mạng vì hai thứ xử lý khác nhau — cấu hình sai thì retry cũng hỏng,
 * nên phải đi vào metric `runtime_resolution_errors` + bounded retry rồi DLQ, tuyệt đối không
 * gửi unauthenticated.
 */
export class RuntimeAuthResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeAuthResolutionError';
  }
}

/**
 * Lỗi ở tầng transport khi gọi private API: binding không tới được, response không đọc
 * được, hoặc `fetch` ném.
 *
 * ⚠️ Cố ý **không** phân loại `401`/`403` vào đây: `401` là "credential sai" — một lỗi cấu
 * hình/secret chứ không phải lỗi mạng, và nó được trả về như một **kết quả** (`auth_rejected`)
 * để metric phân biệt với outage. Trộn hai thứ làm mất khả năng trả lời "credential rotate
 * hay control plane chết".
 */
export class RuntimeTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeTransportError';
  }
}

/**
 * Lỗi contract: response của private API không khớp schema (`validateDeliveryClaim` /
 * `validateClaimRejection` / `validateOutcomeAck` … trả `ok: false`), hoặc status HTTP không
 * thuộc tập đã biết của operation.
 *
 * ⚠️ Tách khỏi {@link RuntimeTransportError} là bắt buộc: docs §11 nói rõ "contract violation
 * hoặc không gọi được control plane" đều dẫn tới bounded retry → DLQ, nhưng chúng là hai
 * chẩn đoán khác nhau cho operator (`5xx` của control plane vs peer lệch version vocabulary).
 */
export class RuntimeContractError extends Error {
  /** `reason` đóng do validator trả — hằng, không nối giá trị peer gửi (log injection). */
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = 'RuntimeContractError';
    this.reason = reason;
  }
}

/** Kết quả claim — phản ánh **đúng** hai đường của §8.1. */
export type ClaimPortResult =
  | { readonly kind: 'won'; readonly claim: DeliveryClaim }
  | { readonly kind: 'lost'; readonly rejection: ClaimRejectionPort };

/** Body `409` của claim — `reason` và `state` chỉ khi `reason = 'terminal'`. */
export interface ClaimRejectionPort {
  readonly reason: ClaimRejectionReason;
  readonly state?: TerminalDeliveryStatus;
}

/**
 * Kết quả một write có fencing token (`release`/`outcome`).
 *
 * ⚠️ `stale`/`terminal` là **no-op an toàn** (§11): worker coi là duplicate/conflict, ACK an
 * toàn, **không** gửi lại provider. Vì vậy chúng là biến thể **thành công** ở đây, không phải
 * lỗi — `attempts`/`retries` không được tăng vì chúng.
 */
export type FencedWritePortResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'rejected'; readonly reason: 'stale_write' | 'terminal' };

/**
 * Client của private delivery runtime API, giới hạn đúng bốn operation.
 *
 * ⚠️ `app` **không** xuất hiện ở đây và `X-ECOMA-APP` **không** được gửi: claim/lookup theo
 * `delivery_id`, còn `app` là thuộc tính của delivery do control plane sở hữu (§6.1).
 */
export interface DeliveryRuntimePort {
  /**
   * `POST /internal/deliveries/:delivery_id/claim` — thân **rỗng**.
   *
   * ⚠️ Đây **không** phải "resolve runtime" tách riêng: material + credential chỉ có trong
   * response `200`, và thắng/thua là một bước (FR-003). Tên method là `claim` để không ai
   * hiểu nhầm là một lời gọi chỉ đọc.
   *
   * @throws {RuntimeAuthResolutionError} Chưa cấu hình secret — **fail-closed**.
   * @throws {RuntimeTransportError} Không gọi được, hoặc response không đọc được.
   * @throws {RuntimeContractError} Status/body không thuộc contract.
   */
  claim(deliveryId: string): Promise<ClaimPortResult>;

  /**
   * `POST /internal/deliveries/:delivery_id/release` — trả lease về `queued`.
   *
   * ⚠️ **Phải** gọi trước `retry()` khi claim đã thắng (§12, FR-008): nếu không, delivery vẫn
   * `processing` với lease còn hiệu lực, message redelivery gặp `409 lease_held` và bị ACK —
   * retry của Queue **không** thực sự retry provider.
   */
  release(deliveryId: string, dispatchGeneration: number): Promise<FencedWritePortResult>;

  /** `POST /internal/deliveries/:delivery_id/outcome` — kết cục `delivered`/`failed`. */
  writeOutcome(
    deliveryId: string,
    dispatchGeneration: number,
    outcome: DeliveryOutcomeValue,
  ): Promise<FencedWritePortResult>;

  /**
   * `POST /internal/subscriptions/:subscription_id/invalidate` — thân **rỗng**.
   *
   * ⚠️ Idempotent theo kết quả: gọi lại với subscription đã `disabled` trả cùng `200`. Vì vậy
   * `404` ở đây **không** phải "không tồn tại" theo nghĩa thông thường mà là dấu hiệu caller
   * không được xác thực — nên nó đi vào cùng nhánh với `401`/`403` (`auth_rejected`) chứ không
   * phải `no_op`.
   */
  invalidateSubscription(subscriptionId: string): Promise<'disabled' | 'no_op' | 'auth_rejected'>;
}
