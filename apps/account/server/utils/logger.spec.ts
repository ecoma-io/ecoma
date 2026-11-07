import { describe, expect, it } from 'vitest';

import { pickLogFields, sanitizeFieldValue } from './logger';

/**
 * Test logger theo **luật**, không theo implementation.
 *
 * Mỗi test ở đây là một cách rò dữ liệu đã bị chặn; nếu một luật trong SR-001 bị
 * nới lỏng thì test tương ứng đỏ. Vì vậy không có test nào chỉ khẳng định "hàm trả
 * về object" — mỗi test đều hỏi "giá trị này có lọt vào log không".
 */

/** Hex SHA-256 hợp lệ — dạng duy nhất được nhận cho `session_id`. */
const HASH = 'a'.repeat(64);

describe('pickLogFields', () => {
  it('keeps every allowlisted field', () => {
    expect(
      pickLogFields({
        event: 'login.attempt',
        route: '/login',
        method: 'POST',
        status: 200,
        sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        session_id: HASH,
        error_code: 'E_PASSWORD_WRONG',
        reason: 'bad_credentials',
        request_id: '0192f0a1-0000-7000-8000-000000000000',
      }),
    ).toEqual({
      event: 'login.attempt',
      route: '/login',
      method: 'POST',
      status: 200,
      sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      session_id: HASH,
      error_code: 'E_PASSWORD_WRONG',
      reason: 'bad_credentials',
      request_id: '0192f0a1-0000-7000-8000-000000000000',
    });
  });

  it('drops a field outside the allowlist', () => {
    // `password` không có trong allowlist nên không có đường đi vào dòng log, kể cả
    // khi caller truyền nó một cách vô tình qua object trải.
    const picked = pickLogFields({
      event: 'x',
      ...({ password: 'hunter2' } as Record<string, never>),
    });
    expect(picked).toEqual({ event: 'x' });
    expect(JSON.stringify(picked)).not.toContain('hunter2');
  });

  it('drops an unhashed session identifier', () => {
    // Giá trị session thật không bao giờ được ghi — chỉ dạng SHA-256 hex mới qua.
    const picked = pickLogFields({ event: 'x', session_id: 's_abc123' });
    expect(picked).toEqual({ event: 'x' });
  });

  it('drops a session identifier that is not 64 lowercase hex characters', () => {
    expect(pickLogFields({ event: 'x', session_id: 'A'.repeat(64) })).toEqual({ event: 'x' });
    expect(pickLogFields({ event: 'x', session_id: 'a'.repeat(63) })).toEqual({ event: 'x' });
  });

  it('strips control characters so a log line cannot be forged', () => {
    const picked = pickLogFields({ event: 'x', reason: 'a\n{"level":"error"}' });
    expect(picked.reason).toBe('a{"level":"error"}');
    // Một dòng log = một event; giá trị có newline sẽ tách thành hai dòng và dòng
    // thứ hai trông như một event hợp lệ.
    expect(String(picked.reason)).not.toContain('\n');
  });

  it('preserves a numeric status as a number', () => {
    expect(pickLogFields({ event: 'x', status: 503 })).toEqual({ event: 'x', status: 503 });
  });

  it('ignores undefined and null values', () => {
    expect(
      pickLogFields({ event: 'x', route: undefined, method: null as unknown as string }),
    ).toEqual({ event: 'x' });
  });
});

describe('sanitizeFieldValue', () => {
  it('returns undefined when only control characters were supplied', () => {
    // Chỉ ký tự điều khiển, không ký tự in được nào cả.
    expect(sanitizeFieldValue('\u0000\u0007\u001B\u007F')).toBeUndefined();
  });

  it('strips control characters but keeps the printable ones around them', () => {
    // ANSI escape sequence: `\u001B` là ký tự điều khiển nên bị bỏ, còn `[31m`
    // là ký tự in được nên đi qua. Đây là hành vi mong muốn — bỏ escape là đủ để
    // dòng log không còn mang điều khiển terminal, mà không cần xoá nội dung.
    expect(sanitizeFieldValue('\u001B[31m')).toBe('[31m');
  });

  it('keeps Unicode intact', () => {
    expect(sanitizeFieldValue('Hồ Vân')).toBe('Hồ Vân');
  });

  it('truncates a value longer than the field limit', () => {
    const long = 'a'.repeat(500);
    const result = sanitizeFieldValue(long);
    expect(result?.startsWith('a'.repeat(200))).toBe(true);
    expect(result).not.toContain('a'.repeat(201));
  });
});
