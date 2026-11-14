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
 * JSONC được strip comment + trailing comma — không dependency nào thêm.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STAFF_ACCESS_SERVICE_BINDING_NAME } from '../server/lib/staff-access-client';

function parseJsonc(path: string): Record<string, unknown> {
  const withoutBlock = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
  const withoutLine = withoutBlock
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(withoutLine.replace(/,(\s*[}\]])/gu, '$1')) as Record<string, unknown>;
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
