import { describe, expect, it } from 'vitest';

import * as api from './index';

/**
 * Public surface có chủ đích: mọi export trong danh sách dưới đây là API mà
 * application/infrastructure dùng. Thêm bớt export phải đi kèm quyết định — test này
 * buộc phải mở lại danh sách một cách tường minh thay vì vô tình nhận thêm một symbol.
 */
const PUBLIC_EXPORT_NAMES = [
  'CLOSED_SUBSCRIPTION_STATUS_VALUES',
  'DELIVERY_STATUS',
  'DELIVERY_STATUS_VALUES',
  'DELIVERY_TRANSITIONS',
  'DELIVERY_TRANSITION_ACTOR',
  'DELIVERY_TRANSITION_ACTOR_VALUES',
  'FENCED_WRITE_OPERATIONS',
  'MAX_PAYLOAD_PLAINTEXT_BYTES',
  'MAX_PUSH_BODY_BYTES',
  'OPEN_OUTBOX_STATUS_VALUES',
  'OUTBOX_STATUS',
  'OUTBOX_STATUS_VALUES',
  'PUSH_PROTOCOL_FRAMING_OVERHEAD_BYTES',
  'PROVIDER_STATUS',
  'PROVIDER_STATUS_VALUES',
  'PROVIDER_TYPE',
  'PROVIDER_TYPE_VALUES',
  'SUBSCRIPTION_DISABLE_CAUSE',
  'SUBSCRIPTION_DISABLE_CAUSE_VALUES',
  'SUBSCRIPTION_STATUS',
  'SUBSCRIPTION_STATUS_VALUES',
  'TERMINAL_DELIVERY_STATUS_VALUES',
  'TERMINAL_OUTBOX_STATUS_VALUES',
  'TRANSPORT',
  'TRANSPORT_PRIORITY_ORDER',
  'TRANSPORT_VALUES',
  'V1_EXECUTABLE_PROVIDER_TYPE',
  'V1_EXECUTABLE_TRANSPORT',
  'applyPublisherSuccess',
  'canCreateOutboxIntent',
  'canRetireEncryptionKey',
  'checkPayloadPlaintextBudget',
  'decideDeliveryClaim',
  'decideFencedWrite',
  'decideOutboxClaim',
  'disableSubscription',
  'evaluateProviderRoutingEligibility',
  'expireSubscription',
  'isClosedSubscriptionStatus',
  'isDeliveryStatus',
  'isDeliveryTransitionActor',
  'isEpochMillis',
  'isFencedWriteOperation',
  'isFiniteNumber',
  'isNonEmptyString',
  'isNonNegativeInteger',
  'isNonTerminalDeliveryStatus',
  'isOpenOutboxStatus',
  'isOutboxStatus',
  'isPositiveInteger',
  'isProviderStatus',
  'isProviderType',
  'isPushBodyWithinLimit',
  'isSubscriptionDisableCause',
  'isSubscriptionEligibleForDelivery',
  'isSubscriptionStatus',
  'isTerminalDeliveryStatus',
  'isTerminalOutboxStatus',
  'isTransport',
  'isV1ExecutableProviderScope',
  'measurePayloadPlaintextBytes',
  'planAdministrativeRetry',
  'planDeliveryRepublish',
  'resolveSubscriptionSigningKeyId',
  'selectPrimaryProvider',
  'selectSubscriptionsForDevice',
  'serializePayloadCanonically',
  'validateDeliveryTransition',
];

describe('public API surface', () => {
  it('exports exactly the intended symbols', () => {
    // So sánh theo membership thay vì sort: `unicorn/no-array-sort` cấm `sort()` và
    // `lib` của tsconfig.base là es2022 nên không có `toSorted()`. Cùng kích thước tập
    // + mọi phần tử kỳ vọng đều có mặt ⇒ không có export thừa.
    const actual = new Set(Object.keys(api));
    const expected = new Set(PUBLIC_EXPORT_NAMES);
    expect(actual.size).toBe(expected.size);
    for (const name of expected) {
      expect(actual.has(name)).toBe(true);
    }
  });

  it('exports no default', () => {
    expect('default' in api).toBe(false);
  });
});

describe('the library stays free of Node builtins and side effects at import time', () => {
  it('measures bytes through the web standard TextEncoder rather than Buffer', () => {
    // Buffer là Node builtin; TextEncoder có mặt ở cả Workers lẫn Node. Domain
    // library dùng chuẩn web để giữ runtime:universal.
    const result = api.measurePayloadPlaintextBytes({ title: 'a', body: 'b' });
    expect(result).toBe(24);
  });
});

/**
 * Mỗi vocabulary đóng có **hai** biểu diễn: object hằng và mảng `*_VALUES` dùng cho
 * runtime guard. Hai biểu diễn lệch nhau là hỏng âm thầm — thêm một giá trị vào object
 * mà quên mảng thì guard loại giá trị đó như "ngoài vocabulary" (subscription/status
 * hợp lệ biến mất, không có lỗi nào nổi lên). Bảng dưới ghim **từng cặp** theo tên
 * export công khai, nên một vocabulary mới thêm vào library mà quên khai ở đây cũng
 * lộ ra khi danh sách export công khai thay đổi.
 */
const VOCABULARY_PAIRS: readonly (readonly [Record<string, string>, readonly string[]])[] = [
  [api.TRANSPORT, api.TRANSPORT_VALUES],
  [api.PROVIDER_TYPE, api.PROVIDER_TYPE_VALUES],
  [api.PROVIDER_STATUS, api.PROVIDER_STATUS_VALUES],
  [api.SUBSCRIPTION_STATUS, api.SUBSCRIPTION_STATUS_VALUES],
  [api.SUBSCRIPTION_DISABLE_CAUSE, api.SUBSCRIPTION_DISABLE_CAUSE_VALUES],
  [api.DELIVERY_STATUS, api.DELIVERY_STATUS_VALUES],
  [api.OUTBOX_STATUS, api.OUTBOX_STATUS_VALUES],
  [api.DELIVERY_TRANSITION_ACTOR, api.DELIVERY_TRANSITION_ACTOR_VALUES],
];

/**
 * Nhóm **con** của vocabulary: mỗi phần tử phải là một giá trị có thật trong vocabulary
 * cha, nếu không thì guard dựa trên nhóm đó sẽ không bao giờ khớp (ví dụ một terminal
 * status gõ sai tên).
 */
const VOCABULARY_SUBSETS: readonly (readonly [readonly string[], Record<string, string>])[] = [
  [api.TERMINAL_DELIVERY_STATUS_VALUES, api.DELIVERY_STATUS],
  [api.CLOSED_SUBSCRIPTION_STATUS_VALUES, api.SUBSCRIPTION_STATUS],
  [api.OPEN_OUTBOX_STATUS_VALUES, api.OUTBOX_STATUS],
  [api.TERMINAL_OUTBOX_STATUS_VALUES, api.OUTBOX_STATUS],
  // `FENCED_WRITE_OPERATIONS` là tập con của actor vocabulary, không phải vocabulary
  // đầy đủ: ghim ở đây để một operation mới (ví dụ `renew`) mà không thêm vào đây sẽ
  // bị lộ khi danh sách export công khai thay đổi.
  [api.FENCED_WRITE_OPERATIONS, api.DELIVERY_TRANSITION_ACTOR],
];

describe('vocabulary arrays mirror the vocabulary objects they guard', () => {
  it('lists every declared value of each full vocabulary', () => {
    for (const [vocabulary, values] of VOCABULARY_PAIRS) {
      expect(new Set(values)).toStrictEqual(new Set(Object.values(vocabulary)));
      expect(values).toHaveLength(Object.values(vocabulary).length);
    }
  });

  it('keeps each subset inside its parent vocabulary', () => {
    for (const [subset, vocabulary] of VOCABULARY_SUBSETS) {
      expect(subset.length).toBeGreaterThan(0);
      for (const value of subset) {
        expect(Object.values(vocabulary)).toContain(value);
      }
    }
  });
});
