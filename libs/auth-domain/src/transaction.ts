import { OAuthProtocolError } from './errors';

/**
 * Trạng thái của một authorization transaction.
 *
 * ⚠️ Tập trạng thái này là HỮU HẠN và chuyển tiếp là MỘT CHIỀU — không có
 * đường quay lui. Đó là điều làm cho "code chỉ được cấp một lần" trở thành hệ
 * quả của state machine thay vì một kiểm tra rời có thể quên (hàng 9 của bảng
 * 5.1.2 trong `docs/applications/auth/01-architecture.md`).
 *
 * Nhánh `denied` là kết thúc KHÔNG cấp code, nhưng vẫn phải qua Z + cookie để
 * dựng `error=access_denied` tới `redirect_uri`: chỉ `auth` được dựng OAuth
 * error redirect (invariant 12).
 */
export type AuthorizationTransactionState =
  | 'pending_browser'
  | 'browser_confirmed'
  | 'awaiting_consent'
  | 'ready_to_complete'
  | 'completed'
  | 'denied';

/** Trạng thái mà một handle Z có thể được tiêu thụ. */
export const COMPLETABLE_STATES: ReadonlySet<AuthorizationTransactionState> = new Set([
  'ready_to_complete',
  'denied',
]);

/**
 * `browser_confirmed` là ĐIỀU KIỆN TIÊN QUYẾT, không phải bước kiểm tra thông
 * thường: request chưa qua `/authorize/confirm` bị từ chối TRƯỚC KHI đọc bất
 * kỳ trường nào khác (FR-016q, SR-013a). Đây là chốt chặn duy nhất chống việc
 * attacker chiếm handle X rồi đẩy kết quả xác minh bằng session của chính hắn.
 */
export function assertBrowserConfirmed(state: AuthorizationTransactionState): void {
  if (state === 'pending_browser') {
    throw OAuthProtocolError.directInvalidRequest('transaction chua duoc browser xac nhan');
  }
}

export function isTerminal(state: AuthorizationTransactionState): boolean {
  return state === 'completed' || state === 'denied';
}

/**
 * Bảng chuyển tiếp hợp lệ. Dùng để chặn việc ghi một trạng thái không thể đạt
 * tới — một bug trong lớp repository có thể vô tình reset transaction về
 * `pending_browser` và làm nó dùng lại được.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<AuthorizationTransactionState, ReadonlySet<AuthorizationTransactionState>>
> = {
  pending_browser: new Set(['browser_confirmed']),
  browser_confirmed: new Set(['awaiting_consent', 'ready_to_complete', 'denied']),
  awaiting_consent: new Set(['ready_to_complete', 'denied']),
  ready_to_complete: new Set(['completed', 'denied']),
  // `completed` và `denied` là đích — không có đường ra.
  completed: new Set<AuthorizationTransactionState>(),
  denied: new Set<AuthorizationTransactionState>(),
};

export function canTransition(
  from: AuthorizationTransactionState,
  to: AuthorizationTransactionState,
): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function assertTransition(
  from: AuthorizationTransactionState,
  to: AuthorizationTransactionState,
): void {
  if (!canTransition(from, to)) {
    throw OAuthProtocolError.directInvalidRequest(
      `khong chuyen trang thai hop le: ${from} -> ${to}`,
    );
  }
}
