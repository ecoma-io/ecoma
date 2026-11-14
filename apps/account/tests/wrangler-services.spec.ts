/**
 * Binding `STAFF_ACCESS_SERVICE` trong `wrangler.jsonc` khớp đúng tên mà client
 * verdict đọc (`STAFF_ACCESS_SERVICE_BINDING_NAME` của
 * `server/lib/staff-access-client.ts`).
 *
 * Vì sao phải ghim: lệch tên là fail-closed **im lặng vĩnh viễn** — client đọc
 * `env.STAFF_ACCESS_SERVICE`, không thấy thì trả `authorization_surface_
 * not_configured`, không gì nổ lúc deploy. Trên workerd, service được trỏ tới
 * không tồn tại là lỗi boot; còn lệch **tên binding** (phía code đọc) thì mọi
 * environment cùng chết im lặng. Test tĩnh này là chỗ duy nhất nhìn thấy cả hai
 * phía cùng nhau.
 *
 * JSONC được strip comment + trailing comma — không dependency nào thêm. Strip
 * nhận biết chuỗi (string-aware): scanner tự viết đi qua file một lần, không
 * strip bên trong string literal (một giá trị chứa `//` — vd URL — không bị
 * hỏng), thay vì regex mù.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STAFF_ACCESS_SERVICE_BINDING_NAME } from '../server/lib/staff-access-client';

/** Strip line comments (`//`) and block comments outside string literals, then drop trailing commas. */
function parseJsonc(path: string): Record<string, unknown> {
  const source = readFileSync(path, 'utf8');
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      out += char;
      // `\"` escape là phần của string, không đóng string.
      if (char === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 1;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      out += '\n';
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) {
        throw new Error('unterminated block comment in wrangler.jsonc');
      }
      i = end + 1;
      continue;
    }
    out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/gu, '$1')) as Record<string, unknown>;
}

describe('wrangler.jsonc staff-access service binding', () => {
  it('declares STAFF_ACCESS_SERVICE pointing at the ecoma-staff-access worker', () => {
    const config = parseJsonc(resolve(import.meta.dirname, '../wrangler.jsonc'));
    const services = config['services'] as Array<{ binding?: unknown; service?: unknown }>;

    const match = services?.find((entry) => entry.binding === STAFF_ACCESS_SERVICE_BINDING_NAME);
    expect(match, `missing binding ${STAFF_ACCESS_SERVICE_BINDING_NAME}`).toBeDefined();
    expect(match?.service).toBe('ecoma-staff-access');
  });
});
