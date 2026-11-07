/**
 * Execution evidence — bằng chứng bền về việc provider có thực thi hay không.
 *
 * Source of truth: `docs/domains/llm-inference/domain-model.md` §2.
 *
 * Bốn giá trị canonical. Domain không thêm giá trị thứ năm: một trạng thái
 * không chắc chắn luôn được biểu diễn bằng `may_have_executed`, không bằng một
 * giá trị mới. Khi adapter không đủ căn cứ để khẳng định, caller phải truyền
 * `may_have_executed` (fail-safe).
 *
 * Đây là **nguồn sự thật duy nhất** của vocabulary này trong codebase.
 * `llm-consumer-routing` khai báo lại union tương đương ở biên của nó (không được import
 * xuyên bounded context) và một compile-time assertion ở phía routing giữ hai
 * khai báo không lệch nhau.
 */

/** Bằng chứng thực thi của một provider attempt. */
export type ExecutionEvidence =
  | 'not_sent'
  | 'may_have_executed'
  | 'confirmed_completed'
  | 'confirmed_not_executed';

/** Giá trị canonical, dùng thay cho string literal rải rác. */
export const EXECUTION_EVIDENCE = {
  not_sent: 'not_sent',
  may_have_executed: 'may_have_executed',
  confirmed_completed: 'confirmed_completed',
  confirmed_not_executed: 'confirmed_not_executed',
} as const;

/** Toàn bộ vocabulary, theo thứ tự khai báo — dùng cho test và audit. */
export const EXECUTION_EVIDENCE_VALUES: readonly ExecutionEvidence[] = Object.freeze([
  EXECUTION_EVIDENCE.not_sent,
  EXECUTION_EVIDENCE.may_have_executed,
  EXECUTION_EVIDENCE.confirmed_completed,
  EXECUTION_EVIDENCE.confirmed_not_executed,
]);

/** Type guard cho `ExecutionEvidence`. */
export function isExecutionEvidence(value: unknown): value is ExecutionEvidence {
  return (
    typeof value === 'string' && (EXECUTION_EVIDENCE_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Bằng chứng khẳng định (authoritative): provider đã xác nhận một kết quả cuối
 * cùng. Chỉ `confirmed_*` là authoritative; `not_sent` và `may_have_executed`
 * đều **không** phải khẳng định của provider.
 */
export function isAuthoritativeEvidence(evidence: ExecutionEvidence): boolean {
  return (
    evidence === EXECUTION_EVIDENCE.confirmed_completed ||
    evidence === EXECUTION_EVIDENCE.confirmed_not_executed
  );
}

/**
 * Bằng chứng cho phép thêm attempt mới, xét riêng khía cạnh thực thi.
 *
 * `not_sent` và `confirmed_not_executed` chứng minh provider không thực thi,
 * nên không tạo side effect trùng. `may_have_executed` và
 * `confirmed_completed` đều chặn retry.
 */
export function isRetrySafeEvidence(evidence: ExecutionEvidence): boolean {
  return (
    evidence === EXECUTION_EVIDENCE.not_sent ||
    evidence === EXECUTION_EVIDENCE.confirmed_not_executed
  );
}

/**
 * Ma trận chuyển đổi evidence cho **cùng một** attempt.
 *
 * Quy tắc:
 * - Bằng chứng chỉ được **mạnh lên**, không bao giờ bị hạ cấp. Ví dụ
 *   `may_have_executed → not_sent` bị từ chối vì nó xoá mất khả năng provider
 *   đã thực thi.
 * - `confirmed_not_executed` và `confirmed_completed` loại trừ nhau: hai khẳng
 *   định authoritative trái ngược không được chuyển đổi qua lại trong domain
 *   này. Một correction như vậy cần quy trình riêng (xem §12.2 của domain design).
 * - `not_sent → confirmed_*` được phép: đó là bằng chứng authoritative đến muộn,
 *   mạnh hơn kết luận trước đó.
 * - Chuyển sang chính nó (idempotent) luôn được phép.
 */
const EVIDENCE_TRANSITIONS: Readonly<Record<ExecutionEvidence, readonly ExecutionEvidence[]>> =
  Object.freeze({
    not_sent: Object.freeze([
      EXECUTION_EVIDENCE.not_sent,
      EXECUTION_EVIDENCE.may_have_executed,
      EXECUTION_EVIDENCE.confirmed_not_executed,
      EXECUTION_EVIDENCE.confirmed_completed,
    ]),
    may_have_executed: Object.freeze([
      EXECUTION_EVIDENCE.may_have_executed,
      EXECUTION_EVIDENCE.confirmed_not_executed,
      EXECUTION_EVIDENCE.confirmed_completed,
    ]),
    confirmed_not_executed: Object.freeze([EXECUTION_EVIDENCE.confirmed_not_executed]),
    confirmed_completed: Object.freeze([EXECUTION_EVIDENCE.confirmed_completed]),
  });

/** Kiểm tra một chuyển đổi evidence có hợp lệ không. */
export function canTransitionEvidence(from: ExecutionEvidence, to: ExecutionEvidence): boolean {
  const allowed = EVIDENCE_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/** Toàn bộ chuyển đổi được phép từ một giá trị — đọc-only, phục vụ test/audit. */
export function allowedEvidenceTargets(from: ExecutionEvidence): readonly ExecutionEvidence[] {
  return EVIDENCE_TRANSITIONS[from];
}

/**
 * Phân loại evidence từ dữ kiện adapter quan sát được.
 *
 * Adapter **không** được suy ra `confirmed_not_executed` chỉ từ HTTP status.
 * Chỉ truyền `confirmed_not_executed` khi semantics của provider chứng minh
 * chắc chắn không có thực thi; mọi trường hợp còn lại truyền
 * `may_have_executed`.
 */
export function classifyEvidence(facts: {
  readonly dispatchAttempted: boolean;
  readonly providerConfirmedCompleted: boolean;
  readonly providerConfirmedNotExecuted: boolean;
}): ExecutionEvidence {
  if (facts.providerConfirmedCompleted) {
    return EXECUTION_EVIDENCE.confirmed_completed;
  }
  if (facts.providerConfirmedNotExecuted) {
    return EXECUTION_EVIDENCE.confirmed_not_executed;
  }
  if (facts.dispatchAttempted) {
    return EXECUTION_EVIDENCE.may_have_executed;
  }
  return EXECUTION_EVIDENCE.not_sent;
}
