/**
 * Provider attempt — một lần `llm-api` giao một logical request cho một
 * candidate của routing và chờ provider phản hồi.
 *
 * Source of truth: `docs/domains/llm-inference/domain-model.md` §1, §5, §6.
 *
 * Attempt là **entity con** của aggregate `LogicalRequest`: nó không tồn tại
 * độc lập và mọi thay đổi đi qua operation của aggregate. Attempt giữ quyết
 * định của routing ở dạng tham chiếu opaque (`candidateRef`, `endpointRef`) —
 * domain này không chọn candidate, không xếp thứ tự fallback, không diễn giải
 * nội dung của tham chiếu.
 */

import { EXECUTION_EVIDENCE, isExecutionEvidence, type ExecutionEvidence } from './evidence';
import { isAttemptId, isEpochMillis, isOpaqueId, type AttemptId } from './shared';

/** Phân loại kết quả của một attempt, suy ra từ evidence — không phải field lưu trữ. */
export type AttemptOutcome = 'in_progress' | 'succeeded' | 'not_executed' | 'uncertain';

/** Một lần thực thi của provider trong phạm vi một logical request. */
export interface ProviderAttempt {
  readonly attemptId: AttemptId;
  /** Thứ tự 1-based trong logical request; do domain gán, không do caller. */
  readonly sequence: number;
  /** Tham chiếu opaque tới candidate mà routing đã chọn cho attempt này. */
  readonly candidateRef: string;
  /** Tham chiếu opaque tới endpoint cụ thể, nếu caller đã chọn một endpoint. */
  readonly endpointRef: string | null;
  /** Thời điểm ghi nhận dispatch intent. */
  readonly recordedAt: number;
  readonly evidence: ExecutionEvidence;
  /** Thời điểm evidence hiện tại được ghi; `null` khi chưa có báo cáo nào. */
  readonly evidenceRecordedAt: number | null;
  /** Thời điểm attempt đóng; `null` khi provider vẫn có thể trả kết quả. */
  readonly endedAt: number | null;
}

/**
 * Suy ra phân loại kết quả từ evidence và trạng thái đóng của attempt.
 *
 * Đây là **view**, không phải nguồn sự thật thứ hai: mọi thay đổi đi qua
 * `evidence`/`endedAt`. Nhờ vậy `may_have_executed` vẫn phân biệt được với
 * `confirmed_not_executed`, và một outcome chưa xác định không bao giờ bị đọc
 * thành thất bại đã xác nhận.
 */
export function classifyAttemptOutcome(attempt: ProviderAttempt): AttemptOutcome {
  switch (attempt.evidence) {
    case EXECUTION_EVIDENCE.confirmed_completed:
      return 'succeeded';
    case EXECUTION_EVIDENCE.confirmed_not_executed:
    case EXECUTION_EVIDENCE.not_sent:
      return 'not_executed';
    case EXECUTION_EVIDENCE.may_have_executed:
      return attempt.endedAt === null ? 'in_progress' : 'uncertain';
  }
}

/** Attempt còn mở: provider vẫn có thể trả thêm kết quả. */
export function isAttemptOpen(attempt: ProviderAttempt): boolean {
  return attempt.endedAt === null;
}

/** Attempt có khả năng đã thực thi và chưa được reconcile bằng bằng chứng mạnh hơn. */
export function isAttemptUncertain(attempt: ProviderAttempt): boolean {
  return attempt.evidence === EXECUTION_EVIDENCE.may_have_executed;
}

/** Type guard cho `ProviderAttempt` — dùng khi rehydrate từ persistence. */
export function isProviderAttempt(value: unknown): value is ProviderAttempt {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const attempt = value as ProviderAttempt;
  return (
    isAttemptId(attempt.attemptId) &&
    Number.isSafeInteger(attempt.sequence) &&
    attempt.sequence > 0 &&
    isOpaqueId(attempt.candidateRef) &&
    (attempt.endpointRef === null || isOpaqueId(attempt.endpointRef)) &&
    isEpochMillis(attempt.recordedAt) &&
    isExecutionEvidence(attempt.evidence) &&
    (attempt.evidenceRecordedAt === null || isEpochMillis(attempt.evidenceRecordedAt)) &&
    (attempt.endedAt === null || isEpochMillis(attempt.endedAt)) &&
    // Đã có báo cáo evidence thì phải có thời điểm ghi, và không được lùi trước dispatch.
    (attempt.evidence === EXECUTION_EVIDENCE.not_sent
      ? true
      : attempt.evidenceRecordedAt !== null) &&
    (attempt.evidenceRecordedAt === null || attempt.evidenceRecordedAt >= attempt.recordedAt) &&
    // Attempt đã đóng thì phải có evidence và thời điểm đóng không lùi.
    (attempt.endedAt === null ||
      (attempt.evidenceRecordedAt !== null && attempt.endedAt >= attempt.recordedAt))
  );
}
