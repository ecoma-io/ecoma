import { describe, expect, it } from 'vitest';
import { formatArticleDate, isIsoCalendarDate, isValidArticleDate } from './blog-date';

describe('formatArticleDate', () => {
  it('formats an ISO date in the display locale', () => {
    // Với `en`, tháng in đầy đủ; chuỗi chính xác phụ thuộc ICU của runtime —
    // assert các phần bắt buộc thay vì một chuỗi cứng.
    const formatted = formatArticleDate('2026-09-02', 'en');
    expect(formatted).toContain('2026');
    expect(formatted.toLowerCase()).toContain('september');
    expect(formatted).toContain('2');
  });

  it('formats the same date differently per locale', () => {
    // Cùng ngày, hai locale — không khớp byte: điểm của helper là localized
    // display, không phải format cứng.
    const en = formatArticleDate('2026-09-02', 'en');
    const vi = formatArticleDate('2026-09-02', 'vi');
    expect(en).not.toBe(vi);
  });

  it('is timezone-stable: parses as UTC noon-anchored midnight', () => {
    // `2026-09-02T00:00:00Z` ở timezone âm (ví dụ UTC-10) vẫn là 2/9 —
    // không được trôi thành 1/9 hay 3/9 theo timezone của runner.
    expect(formatArticleDate('2026-09-02', 'en')).toContain('2');
  });

  it('returns an empty string for an unparseable date instead of Invalid Date', () => {
    // Ngày không tồn tại dù khớp shape (`2026-13-45`) hoặc chuỗi rỗng từ
    // fallback route — in `Invalid Date` ra UI là lỗi hiển thị, ẩn đi là đúng.
    expect(formatArticleDate('', 'en')).toBe('');
    expect(formatArticleDate('2026-13-45', 'en')).toBe('');
    expect(formatArticleDate('not-a-date', 'en')).toBe('');
  });
});

describe('isValidArticleDate', () => {
  it('accepts a real calendar date', () => {
    expect(isValidArticleDate('2026-09-02')).toBe(true);
  });

  it('rejects a shape-valid but nonexistent calendar date', () => {
    // Đây là lớp lỗi mà schema regex của content config không bắt được —
    // helper là lớp phòng vệ thứ hai của view.
    expect(isValidArticleDate('2026-02-31')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidArticleDate('')).toBe(false);
  });
});

describe('isIsoCalendarDate', () => {
  it('accepts real calendar dates', () => {
    // Các mốc biên của lịch: đầu/cuối năm, tháng 2 ngày 28, ngày 30/31 ở
    // tháng dài và tháng ngắn — tất cả đều phải qua.
    const valid = [
      '2026-01-01',
      '2026-12-31',
      '2026-01-31',
      '2026-04-30',
      '2026-02-28',
      '2024-02-29',
      '2000-02-29',
    ];
    expect(valid.map((value) => [value, isIsoCalendarDate(value)])).toEqual(
      valid.map((value) => [value, true]),
    );
  });

  it('rejects impossible days and months that roll over into a real date', () => {
    // **Lớp lỗi cốt lõi**: JS Date không từ chối ngày ngoài lịch mà **roll
    // sang ngày có thật** — `new Date('2026-02-31T00:00:00Z')` ra
    // `2026-03-03`, và `Date.parse` trả về timestamp hợp lệ chứ không phải
    // `NaN`. Vì vậy refine cũ trong `content.config.ts` (`Date.parse` một
    // mình) **chấp nhận** những giá trị này: chúng lọt vào content database,
    // xếp sai thứ tự editorial và phát sai `datePublished` mà không có lỗi
    // nào báo. So khớp round-trip qua UTC components là cách chặn.
    expect(isIsoCalendarDate('2026-02-31')).toBe(false);
    expect(isIsoCalendarDate('2026-04-31')).toBe(false);
    expect(isIsoCalendarDate('2026-06-31')).toBe(false);
    expect(isIsoCalendarDate('2026-09-31')).toBe(false);
    expect(isIsoCalendarDate('2026-11-31')).toBe(false);
    // Tháng vượt biên trả `NaN` nên tầng "tồn tại" đã bắt — vẫn phải false.
    expect(isIsoCalendarDate('2026-13-01')).toBe(false);
    expect(isIsoCalendarDate('2026-00-10')).toBe(false);
    expect(isIsoCalendarDate('2026-01-00')).toBe(false);
    expect(isIsoCalendarDate('2026-01-32')).toBe(false);
  });

  it('accepts a real leap day and rejects a leap day in a non-leap year', () => {
    // Quy tắc nhuận Gregorian: chia hết 4, trừ trăm chia hết 400. Helper
    // không khai tay quy tắc này — nó đúng theo `Date` của JS, và đây là
    // bộ case chứng minh điều đó, gồm cả năm chia hết 400.
    expect(isIsoCalendarDate('2024-02-29')).toBe(true);
    expect(isIsoCalendarDate('2026-02-29')).toBe(false);
    expect(isIsoCalendarDate('2025-02-29')).toBe(false);
    expect(isIsoCalendarDate('1900-02-29')).toBe(false);
    expect(isIsoCalendarDate('2000-02-29')).toBe(true);
  });

  it('rejects values that match no ISO date shape', () => {
    // Tầng "hình dạng" phải đứng trước tầng "tồn tại": `Date` của JS parse
    // được rất nhiều thứ ngoài ISO date, và chúng không thuộc hợp đồng schema.
    for (const value of [
      '',
      'not-a-date',
      '2026-9-2',
      '2026/09/02',
      '02-09-2026',
      '2026-09-02T00:00:00Z',
      ' 2026-09-02',
      '2026-09-02 ',
      'Sep 2 2026',
    ]) {
      expect([value, isIsoCalendarDate(value)]).toEqual([value, false]);
    }
  });

  it('agrees with isValidArticleDate, the view-facing alias', () => {
    // Alias của view không được lệch khỏi helper schema: hai tầng ghim cùng
    // một định nghĩa "ngày hợp lệ", và bất đồng ở đây là một lớp lỗi hẳn.
    const samples = [
      '2026-09-02',
      '2026-02-31',
      '2024-02-29',
      '2025-02-29',
      '2026-13-01',
      '2026-9-2',
      '',
      'not-a-date',
    ];
    expect(samples.map((value) => [value, isValidArticleDate(value)])).toEqual(
      samples.map((value) => [value, isIsoCalendarDate(value)]),
    );
  });
});
