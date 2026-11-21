/**
 * Ghim drift port nội bộ của peer stack (OCR round 2, `local-program.ts`):
 * `AUTH_INTERNAL_PORT_OF_AUTH_WIC`, `STAFF_ACCESS_INTERNAL_PORT_OF_STAFF_ACCESS_WIC`
 * và `MAIL_INTERNAL_PORT_OF_MAIL_WIC` là bản copy giá trị GHIM ở stack peer —
 * trước spec này không có cơ chế nào chọn lỗi khi peer đổi port, và lệch port
 * là connection refused ở lần gọi đầu tiên (không fail ở lúc deploy vì
 * healthcheck của account chỉ probe DB của chính nó).
 *
 * Cơ chế: extract hằng từ NGUỒN `local-program.ts` (không import — module chạy
 * `pulumi.Config` lúc eval) rồi so với nguồn số duy nhất của từng peer
 * (`dev.port` của wrangler.jsonc cho worker WIC, hằng `MAIL_INTERNAL_PORT`
 * của transactional-deploy cho mail). Đổi một phía mà không đổi copy là test
 * ĐỎ với message nêu đúng hằng phải sync. File peer được khai trong `inputs`
 * của target `test` (`package.json`) và `implicitDependencies` để `nx affected`
 * chọn đúng project khi peer đổi.
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
  // Chấp nhận biến thể khai báo tường minh (OCR round 3): `export` tuỳ chọn,
  // khoảng trắng tuỳ ý, type annotation tuỳ chọn — DRIFT GIÁ TRỊ vẫn bắt được
  // vì số trong khai báo là nhóm bắt duy nhất; khai báo đổi hình ngoài các
  // biến thể này phải sửa regex một cách tường minh (fail-loud, không đoán).
  const match = source.match(
    new RegExp(
      `^(?:export )?const[ \\t]+${name}(?:[ \\t]*:[^=;\\n]+)?[ \\t]*=[ \\t]*(\\d+)[ \\t]*;[ \\t]*$`,
      'mu',
    ),
  );
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

/** Parse `dev.port` thuần — throw với message rõ, KHÔNG chạm vitest (OCR round 3). */
function readWranglerDevPort(file: string): number {
  const config = parseJsonc(file);
  const dev = config['dev'] as { port?: unknown } | undefined;
  if (typeof dev?.port !== 'number') {
    throw new Error(`dev.port not found (or not a number) in ${file}`);
  }
  return dev.port;
}

const programSource = resolve(import.meta.dirname, 'local-program.ts');

describe('peer internal port pins (local-program.ts)', () => {
  it('AUTH_INTERNAL_PORT_OF_AUTH_WIC matches the dev.port of apps/auth/wrangler.jsonc', () => {
    expect(readProgramConstant(programSource, 'AUTH_INTERNAL_PORT_OF_AUTH_WIC')).toBe(
      readWranglerDevPort(resolve(import.meta.dirname, '../../apps/auth/wrangler.jsonc')),
    );
  });

  it('STAFF_ACCESS_INTERNAL_PORT_OF_STAFF_ACCESS_WIC matches the dev.port of apps/staff-access/wrangler.jsonc', () => {
    expect(
      readProgramConstant(programSource, 'STAFF_ACCESS_INTERNAL_PORT_OF_STAFF_ACCESS_WIC'),
    ).toBe(
      readWranglerDevPort(resolve(import.meta.dirname, '../../apps/staff-access/wrangler.jsonc')),
    );
  });

  it('MAIL_INTERNAL_PORT_OF_MAIL_WIC matches MAIL_INTERNAL_PORT pinned by transactional-mail-deploy', () => {
    expect(readProgramConstant(programSource, 'MAIL_INTERNAL_PORT_OF_MAIL_WIC')).toBe(
      readProgramConstant(
        resolve(import.meta.dirname, '../transactional-mail-deploy/local-program.ts'),
        'MAIL_INTERNAL_PORT',
      ),
    );
  });
});
