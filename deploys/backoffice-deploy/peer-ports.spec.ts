/**
 * Ghim drift port nội bộ của peer stack (OCR round 5, `local-program.ts`):
 * `AUTH_INTERNAL_PORT_OF_AUTH_WIC`, `STAFF_ACCESS_INTERNAL_PORT` và
 * `ACCOUNT_INTERNAL_PORT` là bản copy giá trị GHIM ở stack peer — trước spec
 * này không có cơ chế nào chọn lỗi khi peer đổi port, và lệch port là
 * connection refused ở lần fetch đầu tiên (pattern của `account-deploy`
 * `peer-ports.spec.ts`).
 *
 * Cơ chế: extract hằng từ NGUỒN `local-program.ts` (không import — module chạy
 * `pulumi.Config` lúc eval) rồi so với nguồn số duy nhất của từng peer
 * (`dev.port` của wrangler.jsonc cho worker WIC; container account dùng
 * `ACCOUNT_INTERNAL_PORT` của chính stack đó — Nitro node-server mặc định
 * 3000, ghim trực tiếp giá trị đó).
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
  // Chấp nhận biến thể khai báo tường minh: `export` tuỳ chọn, khoảng trắng
  // tuỳ ý, type annotation tuỳ chọn — DRIFT GIÁ TRỊ vẫn bắt được vì số trong
  // khai báo là nhóm bắt duy nhất; khai báo đổi hình ngoài các biến thể này
  // phải sửa regex một cách tường minh (fail-loud, không đoán).
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

/** Parse `dev.port` thuần — throw với message rõ, KHÔNG chạm vitest. */
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

  it('STAFF_ACCESS_INTERNAL_PORT matches the dev.port of apps/staff-access/wrangler.jsonc', () => {
    expect(readProgramConstant(programSource, 'STAFF_ACCESS_INTERNAL_PORT')).toBe(
      readWranglerDevPort(resolve(import.meta.dirname, '../../apps/staff-access/wrangler.jsonc')),
    );
  });

  it('ACCOUNT_INTERNAL_PORT matches the port pinned by the account-deploy stack', () => {
    // Container account là Nitro node-server (không phải WIC) — nguồn số duy
    // nhất là hằng `ACCOUNT_INTERNAL_PORT` của `account-deploy`.
    expect(readProgramConstant(programSource, 'ACCOUNT_INTERNAL_PORT')).toBe(
      readProgramConstant(
        resolve(import.meta.dirname, '../account-deploy/local-program.ts'),
        'ACCOUNT_INTERNAL_PORT',
      ),
    );
  });
});
