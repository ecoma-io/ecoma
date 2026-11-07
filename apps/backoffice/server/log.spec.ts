/**
 * Test của structured logger — tầng duy nhất của app được phép `console.*`,
 * nên mọi thứ khác của hợp đồng này đều xoay quanh hai bất biến:
 *
 * 1. **Allowlist field (SR-014):** một field không nằm trong danh sách thì
 *    không có đường vào dòng log, kể cả khi caller truyền nhầm —
 *    token/cookie/verifier phải rơi khỏi output, không phải hiện ra ở đó.
 * 2. **Nuốt mọi lỗi (NFR-004):** một dòng log mất không được biến thành
 *    `500` — serialize hỏng, field lạ, object circular đều không được ném.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeLog } from './log';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Ghi lại output `console.log` của một lần gọi `writeLog`. */
function captureConsole(): { lines: () => string } {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  });
  return { lines: () => lines.join('\n') };
}

describe('writeLog — field allowlist (SR-014)', () => {
  it('emits the seven allowlisted fields it is given', () => {
    const out = captureConsole();

    writeLog({
      event: 'backoffice_login.done',
      route: '/api/auth/callback',
      method: 'GET',
      status: 302,
      sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reason: 'exchange_failed',
      request_id: 'req-1',
    });

    const line = out.lines();
    expect(line).toContain('event="backoffice_login.done"');
    expect(line).toContain('route="/api/auth/callback"');
    expect(line).toContain('method="GET"');
    expect(line).toContain('status=302');
    expect(line).toContain('sub="sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(line).toContain('reason="exchange_failed"');
    expect(line).toContain('request_id="req-1"');
  });

  it('drops a non-allowlisted field even when the caller passes it explicitly', () => {
    // Mutation evidence: thêm một field tuỳ ý vào interface `LogFields` (hoặc
    // nới vòng lặp thành "in mọi field của caller") thì test này đỏ — thứ
    // không có trong allowlist không bao giờ được ra log, vì SR-014 cấm
    // token/cookie/secret ở bất kỳ dòng log nào.
    const out = captureConsole();

    writeLog({
      event: 'backoffice_login.rejected',
      ...({ access_token: 'leak-me', set_cookie: 'session=leak-me' } as Record<string, never>),
    });

    expect(out.lines()).not.toContain('leak-me');
    expect(out.lines()).not.toContain('access_token');
    expect(out.lines()).not.toContain('set_cookie');
  });

  it('skips fields that are undefined or null instead of printing "undefined"', () => {
    const out = captureConsole();

    writeLog({ event: 'e', route: undefined, status: undefined });

    expect(out.lines()).toBe('event="e"');
  });
});

describe('writeLog — sanitisation', () => {
  it('strips control characters that would enable log injection', () => {
    const out = captureConsole();

    writeLog({ event: 'login\u000Brejected', reason: 'bad\nNEWLINE=forged_event' });

    const line = out.lines();
    expect(line).not.toContain('\u000B');
    expect(line).not.toContain('\n');
    expect(line).toContain('NEWLINE=forged_event');
  });

  it('truncates a field past the cap instead of emitting it whole', () => {
    const out = captureConsole();

    writeLog({ event: 'e', reason: 'r'.repeat(500) });

    const line = out.lines();
    expect(line.length).toBeLessThan(400);
    expect(line).toContain('…');
  });

  it('drops a field that sanitises to empty rather than emitting an empty pair', () => {
    const out = captureConsole();

    writeLog({ event: 'e', reason: '\u0007' });

    expect(out.lines()).toBe('event="e"');
  });

  it('drops the whole line when the mandatory event sanitises away', () => {
    // Không có `event` thì dòng log không group được — bỏ hết thay vì ghi rác.
    const out = captureConsole();

    writeLog({ event: '', reason: 'anything' });

    expect(out.lines()).toBe('');
  });
});

describe('writeLog — never throws (NFR-004)', () => {
  it('swallows a hostile field value instead of failing the request', () => {
    // Đối tượng có `toString` ném là hình dạng thật của một giá trị lạ đi qua
    // biên — logger không được biến nó thành lỗi của request (observability
    // không là serving-path dependency). ⚠️ Hợp đồng nuốt **cả dòng**: vòng
    // lặp field nằm trong cùng `try` với `console.log`, nên một field không
    // serialize được là dòng đó mất — chấp nhận được vì `event` group đã rời
    // khỏi dòng, và đường này không bao giờ ném lên caller.
    const out = captureConsole();

    expect(() =>
      writeLog({
        event: 'e',
        ...({
          reason: {
            toString() {
              throw new Error('boom');
            },
          },
        } as unknown as Record<string, never>),
      }),
    ).not.toThrow();

    expect(out.lines()).toBe('');
  });
});
