/**
 * Ghim drift port nội bộ của WIC (OCR round 2, `local-program.ts`):
 * `STAFF_ACCESS_INTERNAL_PORT` phải khớp `dev.port` của
 * `apps/staff-access/wrangler.jsonc` — đó là nguồn số duy nhất mà entrypoint
 * `wrangler dev` đọc. Trước spec này lệch port chỉ lộ ở lúc deploy (healthcheck
 * poll 127.0.0.1:<port>/ready fail → container không bao giờ `healthy`), tức
 * fail-loud nhưng muộn; spec biến lệch thành đỏ ngay lúc test.
 *
 * Cơ chế: extract hằng từ NGUỒN `local-program.ts` (không import — module chạy
 * `pulumi.Config` lúc eval) rồi so với wrangler.jsonc của app. File app được
 * khai trong `inputs` của target `test` (`package.json`); `implicitDependencies`
 * đã trỏ `@ecoma-io/staff-access` nên `nx affected` chọn đúng project khi app
 * đổi.
 *
 * JSONC được strip comment + trailing comma — không dependency nào thêm.
 * Strip nhận biết chuỗi (string-aware), cùng kỹ thuật với
 * `apps/account/tests/wrangler-services.spec.ts`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Đọc text nguồn và extract giá trị hằng `const NAME = <số>;` — thiếu là lỗi test. */
function readProgramConstant(file: string, name: string): number {
  const source = readFileSync(file, 'utf8');
  const match = source.match(new RegExp(`^const ${name} = (\\d+);$`, 'mu'));
  if (match === null) {
    throw new Error(`constant ${name} not found in ${file}`);
  }
  return Number(match[1]);
}

/** Strip line/block comments ngoài string literal rồi bỏ trailing comma (JSONC). */
function parseJsonc(path: string): Record<string, unknown> {
  const source = readFileSync(path, 'utf8');
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      out += char;
      if (char === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 1;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`unterminated block comment in ${path}`);
      i = end + 1;
      continue;
    }
    out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/gu, '$1')) as Record<string, unknown>;
}

describe('internal port pin (local-program.ts)', () => {
  it('STAFF_ACCESS_INTERNAL_PORT matches the dev.port of apps/staff-access/wrangler.jsonc', () => {
    const pinned = readProgramConstant(
      resolve(import.meta.dirname, 'local-program.ts'),
      'STAFF_ACCESS_INTERNAL_PORT',
    );
    const config = parseJsonc(
      resolve(import.meta.dirname, '../../apps/staff-access/wrangler.jsonc'),
    );
    const dev = config['dev'] as { port?: unknown } | undefined;
    expect(dev?.port, `dev.port not found in apps/staff-access/wrangler.jsonc`).toBeTypeOf(
      'number',
    );
    expect(pinned).toBe(dev?.port as number);
  });
});
