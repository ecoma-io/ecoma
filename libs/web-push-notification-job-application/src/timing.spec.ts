// Hai khái niệm hạn tách biệt của §16, và phép tính backoff của Queue.
//
// ⚠️ `expires_at` trên wire là RFC3339 string còn mọi so sánh nội bộ là epoch millis. Đây là
// chỗ **duy nhất** quy đổi giữa hai thứ — một `Date.parse` lọt vào pipeline và tự quyết định
// sai là một lớp lỗi không có test nào bắt được.

import { describe, expect, it } from 'vitest';

import { WEB_PUSH_REQUEST_TIMEOUT_MS, computeTtlSeconds, queueRetryDelaySeconds } from './timing';

const T0 = Date.parse('2026-03-01T12:00:00.000Z');

describe('computeTtlSeconds', () => {
  it('returns the whole seconds left before the business expiry', () => {
    expect(computeTtlSeconds('2026-03-01T12:00:00.000Z', T0)).toBe(0);
    expect(computeTtlSeconds('2026-03-01T12:00:30.000Z', T0)).toBe(30);
    expect(computeTtlSeconds('2026-03-01T13:00:00.000Z', T0)).toBe(3_600);
  });

  // `TTL = 0` là "không giữ lại nếu user agent chưa sẵn sàng" (WP4) — và làm tròn lên ở ranh
  // giới 1 giây là một message sống **dài** hơn hạn nghiệp vụ, đúng thứ §16 cấm.
  it('floors a partial second rather than rounding up', () => {
    expect(computeTtlSeconds('2026-03-01T12:00:00.001Z', T0)).toBe(0);
    expect(computeTtlSeconds('2026-03-01T12:00:00.999Z', T0)).toBe(0);
    expect(computeTtlSeconds('2026-03-01T12:00:01.999Z', T0)).toBe(1);
  });

  it('clamps an already expired notification to zero instead of a negative TTL', () => {
    expect(computeTtlSeconds('2026-03-01T11:59:59.000Z', T0)).toBe(0);
    expect(computeTtlSeconds('2020-01-01T00:00:00.000Z', T0)).toBe(0);
  });

  // TTL của provider không bao giờ được vượt hạn nghiệp vụ, kể cả khi `lease_expires_at`
  // (mà claim cũng trả) còn xa hơn — `expires_at` là hạn **nghiệp vụ** và nó là hạn duy nhất
  // đi vào TTL.
  it('never exceeds the remaining business window even when the lease outlives it', () => {
    const ttl = computeTtlSeconds('2026-03-01T12:05:00.000Z', T0);
    expect(ttl).toBe(300);
    expect(ttl).toBeLessThan(3_600);
  });

  // Dữ liệu hỏng từ peer là contract violation, KHÔNG phải TTL = 0 im lặng — `0` ở đây là
  // "gửi không giữ lại", tức biến một hỏng thành một gửi.
  it.each([
    ['an empty string', ''],
    ['a non-date string', 'không phải ngày'],
    ['a bare number as a string', '1772366400000'],
    ['an invalid month', '2026-13-01T12:00:00.000Z'],
    ['an invalid day of month', '2026-02-30T12:00:00.000Z'],
    ['an invalid hour', '2026-03-01T25:00:00.000Z'],
  ])('returns null for %s instead of a silent zero', (_name, expiresAt) => {
    expect(computeTtlSeconds(expiresAt, T0)).toBeNull();
  });

  it('accepts the RFC3339 forms a control plane may emit', () => {
    expect(computeTtlSeconds('2026-03-01T12:00:30Z', T0)).toBe(30);
    expect(computeTtlSeconds('2026-03-01T12:00:30.123Z', T0)).toBe(30);
    expect(computeTtlSeconds('2026-03-01T14:00:30+02:00', T0)).toBe(30);
  });
});

describe('queueRetryDelaySeconds', () => {
  // `Retry-After` của provider là **mức sàn** — một delay ngắn hơn thứ provider đã yêu cầu là
  // vi phạm §17, nên phải làm tròn **lên** theo giây.
  it.each([
    [1, 1],
    [999, 1],
    [1_000, 1],
    [1_001, 2],
    [4_500, 5],
    [60_000, 60],
  ])('turns Retry-After %ims into a %is delay, rounding up', (retryAfterMs, expected) => {
    expect(queueRetryDelaySeconds({ attempts: 1, retryAfterMs })).toBe(expected);
  });

  // Không có yêu cầu cụ thể thì trả `undefined` để `retry()` dùng policy của Queue — tự bịa
  // một delay là tạo một operational gate chưa được quyết định (docs §4: `retry_delay` chưa
  // chốt). `undefined` và `0` KHÔNG phải cùng một thứ.
  it('defers to the queue policy when the provider gave no Retry-After', () => {
    expect(queueRetryDelaySeconds({ attempts: 3, retryAfterMs: null })).toBeUndefined();
  });

  it.each([0, -1, -1_000])(
    'defers to the queue policy for a non-positive Retry-After of %ims',
    (retryAfterMs) => {
      expect(queueRetryDelaySeconds({ attempts: 3, retryAfterMs })).toBeUndefined();
    },
  );

  it('ignores attempts when a Retry-After is present, because the protocol wins', () => {
    expect(queueRetryDelaySeconds({ attempts: 99, retryAfterMs: 3_000 })).toBe(3);
    expect(queueRetryDelaySeconds({ attempts: 0, retryAfterMs: 3_000 })).toBe(3);
  });
});

describe('WEB_PUSH_REQUEST_TIMEOUT_MS', () => {
  // FR-013 chỉ yêu cầu "timeout hữu hạn" và không chốt giá trị; hằng này là hằng kỹ thuật có
  // chủ đích, KHÔNG phải config key. Test ghim nó là hằng để một đổi giá trị bất tiện phải là
  // một quyết định có ý thức — và để nó không bao giờ thành `0`/`Infinity`/`NaN`.
  it('is a finite positive number of milliseconds', () => {
    expect(Number.isFinite(WEB_PUSH_REQUEST_TIMEOUT_MS)).toBe(true);
    expect(WEB_PUSH_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isInteger(WEB_PUSH_REQUEST_TIMEOUT_MS)).toBe(true);
  });

  it('stays under the CPU budget of a worker for a single HTTP round trip', () => {
    // Một Worker không có runtime I/O miễn phí; một timeout dài hơn hạn CPU của một isolate
    // chỉ có nghĩa là một timeout không bao giờ kịp chạy.
    expect(WEB_PUSH_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
