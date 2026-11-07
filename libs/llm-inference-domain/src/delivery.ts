/**
 * Delivery tới client — dữ kiện quan sát được ở phía `llm-api`, không phải
 * trạng thái thực thi của provider.
 *
 * Source of truth: `docs/domains/llm-inference/domain-model.md` §7.
 *
 * Hai dữ kiện tách biệt:
 * - **Response bytes committed** — ít nhất một byte response đã gửi cho client.
 *   Sau thời điểm này không được ngầm đổi provider cho cùng logical request.
 * - **Client disconnected** — client đóng kết nối. Đây **không** phải bằng
 *   chứng provider đã dừng thực thi, và **không** phải cancellation.
 *
 * Domain chỉ giữ dữ kiện; không có thuật ngữ SSE/HTTP/timer ở đây.
 */

import { inferenceFailure, inferenceOk, isEpochMillis, type InferenceResult } from './shared';

/** Đã có response byte tới client hay chưa. */
export type ClientDeliveryState = 'not_committed' | 'committed';

/** Dữ kiện delivery của một logical request. */
export interface ClientDelivery {
  readonly state: ClientDeliveryState;
  /** Thời điểm byte đầu tiên được commit; `null` khi chưa commit. */
  readonly committedAt: number | null;
  /** Thời điểm client ngắt kết nối (lần đầu); `null` khi chưa ngắt. */
  readonly disconnectedAt: number | null;
}

/** Trạng thái ban đầu: chưa gửi byte nào, client còn kết nối. */
export const INITIAL_CLIENT_DELIVERY: ClientDelivery = Object.freeze({
  state: 'not_committed',
  committedAt: null,
  disconnectedAt: null,
});

/** Client đã nhận ít nhất một byte response. */
export function hasClientOutputCommitted(delivery: ClientDelivery): boolean {
  return delivery.state === 'committed';
}

/** Client đã ngắt kết nối — không suy ra provider đã dừng. */
export function isClientDisconnected(delivery: ClientDelivery): boolean {
  return delivery.disconnectedAt !== null;
}

/**
 * Ghi nhận response bytes đã commit.
 *
 * Idempotent: commit lặp lại là no-op (state `committed` là absorbing). Commit
 * sau khi client đã ngắt bị từ chối — không có kênh để gửi byte nữa.
 */
export function commitClientResponse(
  delivery: ClientDelivery,
  input: { readonly committedAt: unknown },
): InferenceResult<ClientDelivery> {
  if (!isEpochMillis(input.committedAt)) {
    return inferenceFailure('invalid_timestamp');
  }
  if (delivery.state === 'committed') {
    return inferenceOk(delivery);
  }
  if (delivery.disconnectedAt !== null) {
    return inferenceFailure('invalid_delivery_transition');
  }
  return inferenceOk(
    Object.freeze({
      state: 'committed',
      committedAt: input.committedAt,
      disconnectedAt: delivery.disconnectedAt,
    }),
  );
}

/**
 * Ghi nhận client ngắt kết nối.
 *
 * Idempotent. Timestamp lùi so với lần ghi trước bị từ chối
 * (`timestamp_regression`) để trạng thái durable không phụ thuộc thứ tự giao
 * message.
 */
export function recordClientDisconnect(
  delivery: ClientDelivery,
  input: { readonly disconnectedAt: unknown },
): InferenceResult<ClientDelivery> {
  if (!isEpochMillis(input.disconnectedAt)) {
    return inferenceFailure('invalid_timestamp');
  }
  if (delivery.disconnectedAt !== null) {
    if (input.disconnectedAt < delivery.disconnectedAt) {
      return inferenceFailure('timestamp_regression');
    }
    return inferenceOk(delivery);
  }
  if (delivery.committedAt !== null && input.disconnectedAt < delivery.committedAt) {
    return inferenceFailure('timestamp_regression');
  }
  return inferenceOk(
    Object.freeze({
      state: delivery.state,
      committedAt: delivery.committedAt,
      disconnectedAt: input.disconnectedAt,
    }),
  );
}

/** Type guard cho `ClientDelivery` — dùng khi rehydrate từ persistence. */
export function isClientDelivery(value: unknown): value is ClientDelivery {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const delivery = value as ClientDelivery;
  const stateValid = delivery.state === 'not_committed' || delivery.state === 'committed';
  if (!stateValid) {
    return false;
  }
  if (delivery.committedAt !== null && !isEpochMillis(delivery.committedAt)) {
    return false;
  }
  if (delivery.disconnectedAt !== null && !isEpochMillis(delivery.disconnectedAt)) {
    return false;
  }
  return delivery.state === 'committed'
    ? delivery.committedAt !== null
    : delivery.committedAt === null;
}
