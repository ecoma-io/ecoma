/**
 * Peak window của một pricing schedule — "khi nào áp dụng bộ giá peak".
 *
 * Source of truth: `docs/domains/llm-seller-pricing/domain-model.md` §4.
 *
 * - Window nằm trên **local wall-clock** của timezone IANA do schedule khai báo,
 *   không phải UTC: seller cấu hình "giờ cao điểm" theo giờ mà customer của họ
 *   nhìn thấy.
 * - `startMinute`/`endMinute` là phút tính từ nửa đêm local. `endMinute <
 *   startMinute` là **window qua đêm**, và window đó **thuộc về ngày bắt đầu**
 *   của nó: window 22:00–06:00 của Monday phủ 22:00 Monday → 05:59 Tuesday.
 * - `days` dùng ISO-8601: 1 = Monday … 7 = Sunday.
 *
 * **DST không có quy tắc riêng.** Admission timestamp được quy về wall-clock
 * local rồi so với window. Giờ lặp lại (fall-back) xuất hiện hai lần trên đồng hồ
 * địa phương nên cả hai lần đều khớp window như nhau; giờ bị bỏ qua
 * (spring-forward) không tồn tại trên đồng hồ địa phương nên không admission
 * timestamp nào rơi vào đó. Đây là hệ quả của việc so trên wall-clock, không phải
 * một nhánh code xử lý DST.
 */

import { isRecord } from './guards';
import { isEpochMillis } from './instant';
import { pricingFailure, pricingOk, type PricingResult } from './result';

/** Số phút trong một ngày. */
const MINUTES_PER_DAY = 1440;

/** Một window peak trên wall-clock local. */
export interface PeakWindow {
  /** IANA timezone, ví dụ `Asia/Ho_Chi_Minh`. */
  readonly timezone: string;
  /** Các ngày ISO-8601 bắt đầu window (1 = Monday … 7 = Sunday), tăng dần. */
  readonly days: readonly number[];
  /** Phút bắt đầu, tính từ nửa đêm local — `[0, 1440)`. */
  readonly startMinute: number;
  /** Phút kết thúc (không bao gồm), tính từ nửa đêm local — `[0, 1440)`. */
  readonly endMinute: number;
}

/**
 * Kiểm một timezone là IANA timezone hợp lệ với runtime hiện tại.
 *
 * Không dùng `Intl.supportedValuesOf('timeZone')` làm danh sách đóng: danh sách
 * đó chỉ trả canonical zone và sẽ từ chối alias hợp lệ (`Asia/Saigon`,
 * `US/Pacific`) mà seller hoàn toàn có thể cấu hình. Thay vào đó để `Intl` tự
 * xác nhận, và chỉ loại dạng offset thuần (`+07:00`, `UTC+7`) — những chuỗi
 * `Intl` chấp nhận nhưng không phải tên vùng, nên không mang nghĩa "timezone của
 * schedule".
 */
export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (/^[+-]/u.test(value) || /^(?:UTC|GMT)[+-]/u.test(value)) {
    return false;
  }
  try {
    // Dựng formatter là phép kiểm thật: `Intl` ném `RangeError` với tên zone
    // không tồn tại. Không so `resolvedOptions().timeZone` với input — alias
    // (`Asia/Saigon`) được resolve về zone canonical, và đó vẫn là cấu hình hợp
    // lệ; so sánh sẽ từ chối alias. Gán vào biến chỉ để formatter thật sự được
    // dựng (`no-new` cấm `new` thuần vì side effect).
    const probe = new Intl.DateTimeFormat('en-US', { timeZone: value });
    return probe !== null;
  } catch {
    return false;
  }
}

/**
 * Type guard cho `PeakWindow` — kiểm cấu trúc, không cấp phát object mới.
 *
 * `days` cũng phải tăng dần: kiểu khai báo danh sách đã chuẩn hoá, nên một
 * window giữ nguyên thứ tự caller truyền vào không đúng kiểu. Thứ tự không đổi
 * kết quả `isWithinPeakWindow`, nhưng để guard nhận nó là hợp lệ sẽ khiến hai
 * window cùng tập ngày so sánh khác nhau — và snapshot là thứ được đem đi so
 * sánh/audit.
 */
export function isPeakWindow(value: unknown): value is PeakWindow {
  if (!isRecord(value)) {
    return false;
  }
  const timezone = value['timezone'];
  const days = value['days'];
  const startMinute = value['startMinute'];
  const endMinute = value['endMinute'];
  return (
    isIanaTimeZone(timezone) &&
    Array.isArray(days) &&
    days.length > 0 &&
    days.every((day: unknown) => isIsoWeekday(day)) &&
    isStrictlyAscending(days) &&
    isMinuteOfDay(startMinute) &&
    isMinuteOfDay(endMinute) &&
    startMinute !== endMinute
  );
}

function isStrictlyAscending(days: readonly unknown[]): boolean {
  for (let index = 0; index < days.length - 1; index += 1) {
    if ((days[index] as number) >= (days[index + 1] as number)) {
      return false;
    }
  }
  return true;
}

function isMinuteOfDay(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MINUTES_PER_DAY
  );
}

/** Ngày ISO-8601 hợp lệ: số nguyên 1–7. */
function isIsoWeekday(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;
}

/**
 * Validate một `PeakWindow` đọc từ dữ liệu ngoài.
 *
 * `days` phải không rỗng, chỉ chứa số nguyên 1–7, không trùng; bản đã freeze
 * được sắp tăng dần để kết quả không phụ thuộc thứ tự caller truyền vào
 * (determinism — `docs/domains/llm-seller-pricing/domain-model.md` §4).
 */
export function readPeakWindow(value: unknown): PricingResult<PeakWindow> {
  if (!isRecord(value)) {
    return pricingFailure('invalid_peak_window');
  }
  const timezone = value['timezone'];
  if (!isIanaTimeZone(timezone)) {
    return pricingFailure('invalid_timezone');
  }
  const startMinute = value['startMinute'];
  if (!isMinuteOfDay(startMinute)) {
    return pricingFailure('invalid_peak_window');
  }
  const endMinute = value['endMinute'];
  if (!isMinuteOfDay(endMinute) || endMinute === startMinute) {
    return pricingFailure('invalid_peak_window');
  }
  const rawDays = value['days'];
  const days = readIsoWeekdays(rawDays);
  if (days === null) {
    return pricingFailure('invalid_peak_window');
  }
  return pricingOk(
    Object.freeze({
      timezone,
      days: Object.freeze(days),
      startMinute,
      endMinute,
    }),
  );
}

/**
 * Chuẩn hoá danh sách ISO weekday: bỏ trùng, sắp tăng. Trả `null` nếu có giá trị
 * ngoài `[1, 7]` hoặc danh sách rỗng.
 */
function readIsoWeekdays(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const unique = new Set<number>();
  for (const entry of value) {
    if (!isIsoWeekday(entry)) {
      return null;
    }
    unique.add(entry);
  }
  // `Set` giữ thứ tự chèn; sắp lại để hai input cùng tập ngày cho cùng window.
  // Tự sắp (7 phần tử) thay vì `Array#sort`/`toSorted`: `lib` của package là
  // `es2022` nên `toSorted` không có trong type, và `sort` bị lint cấm vì mutate.
  const sorted: number[] = [];
  for (const day of unique) {
    let index = 0;
    while (index < sorted.length && sorted[index] < day) {
      index += 1;
    }
    sorted.splice(index, 0, day);
  }
  return sorted;
}

/** Các thành phần của một thời điểm trên wall-clock local. */
interface LocalWallClock {
  /** ISO-8601 weekday của ngày local: 1 = Monday … 7 = Sunday. */
  readonly isoWeekday: number;
  /** Phút tính từ nửa đêm local. */
  readonly minuteOfDay: number;
}

/**
 * Quy một instant UTC về wall-clock local của `timezone`.
 *
 * Trả `null` nếu instant nằm ngoài miền `Date` — trường hợp này là admission
 * timestamp không hợp lệ, không phải "không rơi vào window". `isEpochMillis` đã
 * chặn cùng biên đó, nên nhánh này chỉ còn phòng thủ cho window dựng tay.
 */
function toLocalWallClock(timezone: string, instant: number): LocalWallClock | null {
  if (!isEpochMillis(instant)) {
    return null;
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    parts = formatter.formatToParts(new Date(instant));
  } catch {
    // Timezone hỏng thì `Intl` ném `RangeError`. Function này là hàm public và
    // nhận window từ caller, nên không được để lỗi đó thoát ra ngoài dưới dạng
    // exception không kiểu — coi như "không xác định được", tức không phải peak.
    return null;
  }
  const year = readNumericPart(parts, 'year');
  const month = readNumericPart(parts, 'month');
  const day = readNumericPart(parts, 'day');
  const hour = readNumericPart(parts, 'hour');
  const minute = readNumericPart(parts, 'minute');
  if (year === null || month === null || day === null || hour === null || minute === null) {
    return null;
  }
  return {
    isoWeekday: isoWeekdayOf(year, month, day),
    minuteOfDay: hour * 60 + minute,
  };
}

function readNumericPart(parts: Intl.DateTimeFormatPart[], type: string): number | null {
  for (const part of parts) {
    if (part.type === type) {
      const parsed = Number(part.value);
      return Number.isInteger(parsed) ? parsed : null;
    }
  }
  return null;
}

/**
 * ISO weekday của một ngày dương lịch local. Dựng lại ngày đó như một ngày UTC
 * để đọc thứ bằng `getUTCDay()` — không parse tên thứ theo locale, nên kết quả
 * không phụ thuộc ngôn ngữ của ICU.
 */
function isoWeekdayOf(year: number, month: number, day: number): number {
  // Dựng bằng `Date(0)` + `setUTCFullYear` thay vì `Date.UTC(year, ...)`: `Date.UTC`
  // ánh xạ năm 0–99 sang 1900–1999, còn setter nhận đúng năm thật.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const sundayBased = date.getUTCDay();
  return sundayBased === 0 ? 7 : sundayBased;
}

/** ISO weekday của ngày trước `isoWeekday`. */
function previousIsoWeekday(isoWeekday: number): number {
  return isoWeekday === 1 ? 7 : isoWeekday - 1;
}

/**
 * Kiểm một admission instant có rơi vào peak window không.
 *
 * Instant không hợp lệ trả `false`; caller đã validate admission timestamp trước
 * khi tới đây, và một instant hỏng không được biến thành "peak" hay "off-peak"
 * một cách âm thầm — nó là rejection ở tầng operation.
 */
export function isWithinPeakWindow(window: PeakWindow, instant: number): boolean {
  const local = toLocalWallClock(window.timezone, instant);
  if (local === null) {
    return false;
  }
  const { isoWeekday, minuteOfDay } = local;
  if (window.endMinute > window.startMinute) {
    return (
      minuteOfDay >= window.startMinute &&
      minuteOfDay < window.endMinute &&
      window.days.includes(isoWeekday)
    );
  }
  // Window qua đêm: [start, 24:00) thuộc ngày bắt đầu; [00:00, end) thuộc ngày
  // trước đó — nên phải lùi weekday một bước mới biết window nào đang phủ.
  if (minuteOfDay >= window.startMinute) {
    return window.days.includes(isoWeekday);
  }
  if (minuteOfDay < window.endMinute) {
    return window.days.includes(previousIsoWeekday(isoWeekday));
  }
  return false;
}
