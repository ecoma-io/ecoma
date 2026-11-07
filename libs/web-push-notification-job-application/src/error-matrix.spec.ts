// Error matrix canonical của delivery plane (`docs/applications/push-notification/03-operations.md`
// §5, dùng chung cả hai plane) và phép chiếu của nó sang job state.
//
// ⚠️ Suite này khẳng định **ánh xạ**, không khẳng định adapter: mỗi `failureClass` phải dẫn
// tới đúng một tổ hợp hành động, và tổ hợp đó phải là hằng. Điểm nguy hiểm nhất ở bảng này
// không phải quên một nhánh, mà là **invalidate nhầm** — chỉ `endpoint_invalid` được invalidate.

import { describe, expect, it } from 'vitest';

import { classifySendResult, projectAttempt } from './error-matrix';
import type { WebPushPermanentFailureClass } from './web-push-sender';

const ALL_PERMANENT_CLASSES: readonly WebPushPermanentFailureClass[] = [
  'endpoint_invalid',
  'provider_auth',
  'payload_too_large',
  'redirect_not_followed',
  'vapid_key_missing',
];

describe('classifySendResult', () => {
  it('maps a 2xx to record_delivered and nothing else', () => {
    expect(classifySendResult({ outcome: 'delivered' })).toEqual({ kind: 'record_delivered' });
  });

  // FR-009: `endpoint_invalid` là class DUY NHẤT được invalidate. `provider_auth` là
  // provider-level failure và `redirect_not_followed` bị cấm invalidate — nếu chỉ cần một
  // `expect(action.kind).toBe('record_failed')` thì cả ba đều xanh và lỗi invalidate nhầm lọt.
  //
  // ⚠️ `it.each` với `if` **bên trong** thân test là `vitest(no-conditional-expect`: có
  // branch không bao giờ chạy `expect` nghĩa là branch đó không được kiểm gì. Vì vậy kỳ vọng
  // được **tính** ra rồi assert một lần, thay vì rẽ nhánh rồi assert.
  it.each(ALL_PERMANENT_CLASSES)(
    'maps failureClass %s to the right invalidate decision',
    (failureClass) => {
      const action = classifySendResult({ outcome: 'failed', failureClass, httpStatus: 500 });
      const expected =
        failureClass === 'endpoint_invalid'
          ? { kind: 'record_failed_and_invalidate', failureClass: 'endpoint_invalid' }
          : { kind: 'record_failed', failureClass };
      expect(action).toEqual(expected);
    },
  );

  it('never maps a non-endpoint_invalid permanent failure to an invalidate action', () => {
    for (const failureClass of ALL_PERMANENT_CLASSES) {
      const action = classifySendResult({ outcome: 'failed', failureClass, httpStatus: 400 });
      expect(action.kind === 'record_failed_and_invalidate').toBe(
        failureClass === 'endpoint_invalid',
      );
    }
  });

  it.each(['before_send', 'after_send'] as const)(
    'maps transient phase %s to release_then_retry carrying the phase',
    (phase) => {
      expect(
        classifySendResult({ outcome: 'transient', phase, retryAfterMs: null, httpStatus: 503 }),
      ).toEqual({
        kind: 'release_then_retry',
        phase,
        retryAfterMs: null,
      });
    },
  );

  it('carries Retry-After through the transient branch so the caller can respect it', () => {
    expect(
      classifySendResult({
        outcome: 'transient',
        phase: 'before_send',
        retryAfterMs: 4_500,
        httpStatus: 429,
      }),
    ).toEqual({ kind: 'release_then_retry', phase: 'before_send', retryAfterMs: 4_500 });
  });

  // Adapter là code ở biên runtime: một kết quả không khớp union là vi phạm contract, và
  // đường an toàn duy nhất là transient (retry bounded + DLQ), KHÔNG phải terminal — terminal
  // ở đây là một lý do bịa ra cho một delivery chưa từng được thử thật.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'delivered'],
    ['a number', 42],
    ['an empty object', {}],
    ['an unknown outcome', { outcome: 'maybe' }],
    ['failed without a failureClass', { outcome: 'failed', httpStatus: 404 }],
    [
      'failed with a non-string failureClass',
      { outcome: 'failed', failureClass: 404, httpStatus: 404 },
    ],
    ['transient without a phase', { outcome: 'transient', retryAfterMs: null, httpStatus: 503 }],
    [
      'transient with an unknown phase',
      { outcome: 'transient', phase: 'during_send', retryAfterMs: null },
    ],
    [
      'transient with phase missing',
      { outcome: 'transient', phase: undefined, retryAfterMs: null },
    ],
  ])('treats %s as transient before_send, never as terminal', (_name, result) => {
    expect(classifySendResult(result)).toEqual({
      kind: 'release_then_retry',
      phase: 'before_send',
      retryAfterMs: null,
    });
  });

  it('never returns a terminal action for a result that does not match the closed union', () => {
    const hostile = [
      { outcome: 'delivered', failureClass: 'endpoint_invalid' },
      { outcome: 'failed', failureClass: 'endpoint_invalid', phase: 'before_send' },
      { outcome: 'transient', phase: 'before_send', retryAfterMs: 'soon' },
      { outcome: 'DELIVERED' },
    ];
    for (const result of hostile) {
      // `delivered` với field lạ vẫn là `record_delivered` — union cho phép field lạ ở
      // nhánh đã nhận diện, và việc siết thêm là thứ adapter phải tự làm. Chỉ assert rằng
      // không nhánh nào trong danh sách này đi vào `record_failed_and_invalidate` sai lý do.
      const action = classifySendResult(result);
      expect(
        action.kind === 'record_failed_and_invalidate' &&
          action.failureClass !== 'endpoint_invalid',
      ).toBe(false);
    }
  });
});

describe('projectAttempt', () => {
  it('records a delivered outcome as terminal_sent', () => {
    expect(projectAttempt({ kind: 'record_delivered' })).toEqual({
      outcome: 'delivered',
      phase: 'terminal_sent',
    });
  });

  it.each(ALL_PERMANENT_CLASSES)('records failed %s as terminal_sent', (failureClass) => {
    const action =
      failureClass === 'endpoint_invalid'
        ? ({ kind: 'record_failed_and_invalidate', failureClass } as const)
        : ({ kind: 'record_failed', failureClass } as const);
    // Phase trả lời "chắc chắn chưa tới provider hay không" — cả hai nhánh terminal đều đã
    // có một request tới provider, và chúng phân biệt nhau bằng `outcome`.
    expect(projectAttempt(action)).toEqual({ outcome: 'failed', phase: 'terminal_sent' });
  });

  it('preserves after_send so the potential-duplicate group stays readable from D1', () => {
    expect(
      projectAttempt({ kind: 'release_then_retry', phase: 'after_send', retryAfterMs: null }),
    ).toEqual({ outcome: 'retrying', phase: 'after_send' });
  });

  it('normalizes an unknown transient phase to before_send, the safe side', () => {
    const action = {
      kind: 'release_then_retry',
      phase: 'mystery_phase',
      retryAfterMs: null,
    } as unknown as Parameters<typeof projectAttempt>[0];
    expect(projectAttempt(action)).toEqual({ outcome: 'retrying', phase: 'before_send' });
  });
});
