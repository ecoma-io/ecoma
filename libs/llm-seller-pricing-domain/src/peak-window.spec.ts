/**
 * Ghim cách chọn peak/off-peak: window nằm trên wall-clock local của timezone
 * IANA, window qua đêm thuộc ngày bắt đầu, và DST không có nhánh code riêng.
 *
 * Mọi instant dưới đây là UTC và mọi kỳ vọng được tính tay từ giờ địa phương,
 * không suy ra từ chính hàm đang được test.
 */

import { describe, expect, it } from 'vitest';

import {
  isIanaTimeZone,
  isPeakWindow,
  isWithinPeakWindow,
  readPeakWindow,
  type PeakWindow,
} from './peak-window';

/** 09:00–17:00 mỗi ngày, theo giờ Việt Nam (UTC+7, không có DST). */
const BUSINESS_HOURS: PeakWindow = {
  timezone: 'Asia/Ho_Chi_Minh',
  days: [1, 2, 3, 4, 5, 6, 7],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
};

function utc(iso: string): number {
  return Date.parse(iso);
}

/** Cùng window giờ làm việc, đổi timezone của schedule. */
function windowIn(timezone: string): PeakWindow {
  return { ...BUSINESS_HOURS, timezone };
}

function expectOk<Value>(
  result: { ok: true; value: Value } | { ok: false; error: { code: string } },
): Value {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
}

function expectRejection(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) {
    throw new Error('expected rejection, got ok');
  }
  return result.error.code;
}

describe('isIanaTimeZone', () => {
  it('accepts IANA region names and their aliases', () => {
    expect(isIanaTimeZone('Asia/Ho_Chi_Minh')).toBe(true);
    expect(isIanaTimeZone('Asia/Saigon')).toBe(true);
    expect(isIanaTimeZone('America/New_York')).toBe(true);
    expect(isIanaTimeZone('UTC')).toBe(true);
  });

  it('rejects offsets and unknown names', () => {
    expect(isIanaTimeZone('+07:00')).toBe(false);
    expect(isIanaTimeZone('UTC+7')).toBe(false);
    expect(isIanaTimeZone('GMT-5')).toBe(false);
    expect(isIanaTimeZone('Mars/Olympus')).toBe(false);
    expect(isIanaTimeZone('')).toBe(false);
    expect(isIanaTimeZone(7)).toBe(false);
  });
});

describe('readPeakWindow', () => {
  it('freezes a valid window and normalizes the day list', () => {
    const window = expectOk(
      readPeakWindow({
        timezone: 'Asia/Ho_Chi_Minh',
        days: [5, 1, 5, 3],
        startMinute: 540,
        endMinute: 1020,
      }),
    );
    expect(window.days).toEqual([1, 3, 5]);
    expect(Object.isFrozen(window)).toBe(true);
    expect(isPeakWindow(window)).toBe(true);
  });

  it('rejects a missing or unknown timezone', () => {
    expect(expectRejection(readPeakWindow({ days: [1], startMinute: 0, endMinute: 60 }))).toEqual(
      'invalid_timezone',
    );
    expect(
      expectRejection(
        readPeakWindow({
          timezone: 'Mars/Olympus',
          days: [1],
          startMinute: 0,
          endMinute: 60,
        }),
      ),
    ).toEqual('invalid_timezone');
  });

  it('rejects minute values outside a single day', () => {
    const base = { timezone: 'Asia/Ho_Chi_Minh', days: [1] };
    expect(expectRejection(readPeakWindow({ ...base, startMinute: -1, endMinute: 60 }))).toEqual(
      'invalid_peak_window',
    );
    expect(expectRejection(readPeakWindow({ ...base, startMinute: 0, endMinute: 1440 }))).toEqual(
      'invalid_peak_window',
    );
    expect(expectRejection(readPeakWindow({ ...base, startMinute: 600, endMinute: 600 }))).toEqual(
      'invalid_peak_window',
    );
  });

  it('rejects an empty or out-of-range day list', () => {
    const base = { timezone: 'Asia/Ho_Chi_Minh', startMinute: 0, endMinute: 60 };
    expect(expectRejection(readPeakWindow({ ...base, days: [] }))).toEqual('invalid_peak_window');
    expect(expectRejection(readPeakWindow({ ...base, days: [0] }))).toEqual('invalid_peak_window');
    expect(expectRejection(readPeakWindow({ ...base, days: [8] }))).toEqual('invalid_peak_window');
    expect(expectRejection(readPeakWindow({ ...base, days: [1.5] }))).toEqual(
      'invalid_peak_window',
    );
  });
});

describe('isWithinPeakWindow', () => {
  it('matches a daytime window on the local clock, not on UTC', () => {
    // 02:00 UTC = 09:00 local — đầu window.
    expect(isWithinPeakWindow(BUSINESS_HOURS, utc('2026-03-02T02:00:00Z'))).toBe(true);
    // 01:59 UTC = 08:59 local — ngay trước window.
    expect(isWithinPeakWindow(BUSINESS_HOURS, utc('2026-03-02T01:59:00Z'))).toBe(false);
    // 10:00 UTC = 17:00 local — window là nửa mở, 17:00 không còn là peak.
    expect(isWithinPeakWindow(BUSINESS_HOURS, utc('2026-03-02T10:00:00Z'))).toBe(false);
    // 09:59 UTC = 16:59 local — phút cuối của peak.
    expect(isWithinPeakWindow(BUSINESS_HOURS, utc('2026-03-02T09:59:00Z'))).toBe(true);
  });

  it('respects the local weekday of the schedule timezone', () => {
    // 2026-03-01T20:00Z là chủ nhật ở UTC nhưng đã là thứ hai 03:00 ở UTC+7.
    const instant = utc('2026-03-01T20:00:00Z');
    expect(new Date(instant).getUTCDay()).toEqual(0);
    const earlyHours: PeakWindow = {
      timezone: 'Asia/Ho_Chi_Minh',
      days: [1],
      startMinute: 0,
      endMinute: 6 * 60,
    };
    expect(isWithinPeakWindow(earlyHours, instant)).toBe(true);
    expect(isWithinPeakWindow({ ...earlyHours, days: [7] }, instant)).toBe(false);
  });

  it('handles an overnight window as belonging to its start day', () => {
    // 22:00–06:00 chỉ vào thứ hai: 22:00 Monday → 05:59 Tuesday.
    const overnight: PeakWindow = {
      timezone: 'Asia/Ho_Chi_Minh',
      days: [1],
      startMinute: 22 * 60,
      endMinute: 6 * 60,
    };
    // Monday 22:00 local = Monday 15:00 UTC — bắt đầu window.
    expect(isWithinPeakWindow(overnight, utc('2026-03-02T15:00:00Z'))).toBe(true);
    // Monday 23:00 local = Monday 16:00 UTC.
    expect(isWithinPeakWindow(overnight, utc('2026-03-02T16:00:00Z'))).toBe(true);
    // Tuesday 05:00 local = Monday 22:00 UTC — vẫn thuộc window của thứ hai.
    expect(isWithinPeakWindow(overnight, utc('2026-03-02T22:00:00Z'))).toBe(true);
    // Tuesday 06:00 local = Monday 23:00 UTC — window kết thúc.
    expect(isWithinPeakWindow(overnight, utc('2026-03-02T23:00:00Z'))).toBe(false);
    // Monday 01:00 local = Sunday 18:00 UTC — phía trước window sẽ thuộc chủ
    // nhật, mà chủ nhật không có trong `days`, nên không khớp.
    expect(isWithinPeakWindow(overnight, utc('2026-03-01T18:00:00Z'))).toBe(false);
    // Sunday 23:00 local = Sunday 16:00 UTC — thuộc window của chủ nhật, không có.
    expect(isWithinPeakWindow(overnight, utc('2026-03-01T16:00:00Z'))).toBe(false);
  });

  it('evaluates the same instant differently across IANA timezones', () => {
    const instant = utc('2026-06-15T02:00:00Z'); // 09:00 ở Việt Nam, 04:00 ở Berlin, 11:00 ở Tokyo.
    expect(isWithinPeakWindow(windowIn('Asia/Ho_Chi_Minh'), instant)).toBe(true);
    expect(isWithinPeakWindow(windowIn('Europe/Berlin'), instant)).toBe(false);
    expect(isWithinPeakWindow(windowIn('Asia/Tokyo'), instant)).toBe(true);
    expect(isWithinPeakWindow(windowIn('America/New_York'), instant)).toBe(false);
  });

  it('matches both occurrences of a repeated fall-back hour', () => {
    // 2026-11-01 America/New_York: 01:00–01:59 xảy ra hai lần (05:00Z EDT và 06:00Z EST).
    const window: PeakWindow = {
      timezone: 'America/New_York',
      days: [7],
      startMinute: 60,
      endMinute: 120,
    };
    expect(isWithinPeakWindow(window, utc('2026-11-01T05:30:00Z'))).toBe(true); // 01:30 EDT
    expect(isWithinPeakWindow(window, utc('2026-11-01T06:30:00Z'))).toBe(true); // 01:30 EST
    expect(isWithinPeakWindow(window, utc('2026-11-01T07:30:00Z'))).toBe(false); // 02:30 EST
  });

  it('never matches the skipped spring-forward hour', () => {
    // 2026-03-08 America/New_York: 02:00–02:59 local không tồn tại.
    const window: PeakWindow = {
      timezone: 'America/New_York',
      days: [7],
      startMinute: 120,
      endMinute: 180,
    };
    expect(isWithinPeakWindow(window, utc('2026-03-08T06:59:00Z'))).toBe(false); // 01:59 EST
    expect(isWithinPeakWindow(window, utc('2026-03-08T07:00:00Z'))).toBe(false); // 03:00 EDT
    expect(isWithinPeakWindow(window, utc('2026-03-08T07:30:00Z'))).toBe(false); // 03:30 EDT
  });

  it('treats an invalid instant as outside the window', () => {
    expect(isWithinPeakWindow(BUSINESS_HOURS, Number.NaN)).toBe(false);
    expect(isWithinPeakWindow(BUSINESS_HOURS, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isWithinPeakWindow(BUSINESS_HOURS, 1e300)).toBe(false);
  });

  it('returns false instead of throwing when the window carries a broken timezone', () => {
    const broken: PeakWindow = { ...BUSINESS_HOURS, timezone: 'Mars/Olympus' };
    expect(isWithinPeakWindow(broken, Date.parse('2026-03-02T02:00:00Z'))).toBe(false);
  });
});
