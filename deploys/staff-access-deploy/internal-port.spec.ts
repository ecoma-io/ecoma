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

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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

describe('readProgramConstant declaration-shape tolerance', () => {
  const fixture = [
    'const STAFF_ACCESS_INTERNAL_PORT = 4206;',
    'export const STAFF_ACCESS_INTERNAL_PORT = 4206;',
    'const   STAFF_ACCESS_INTERNAL_PORT   =   4206  ;',
    'export const STAFF_ACCESS_INTERNAL_PORT: number = 4206;',
  ].join('\n');

  it('extracts the value across export, whitespace and type-annotation variants', () => {
    for (const [index, source] of fixture.split('\n').entries()) {
      const file = join(tmpdir(), `internal-port-shape-${index}.ts`);
      writeFileSync(file, source, 'utf8');
      try {
        expect(readProgramConstant(file, 'STAFF_ACCESS_INTERNAL_PORT')).toBe(4206);
      } finally {
        rmSync(file, { force: true });
      }
    }
  });

  it('a declaration that no longer matches the known shapes fails loudly, never silently skips', () => {
    const file = join(tmpdir(), 'internal-port-shape-broken.ts');
    writeFileSync(file, 'const STAFF_ACCESS_INTERNAL_PORT = 42 + 6;', 'utf8');
    try {
      expect(() => readProgramConstant(file, 'STAFF_ACCESS_INTERNAL_PORT')).toThrow(
        /constant STAFF_ACCESS_INTERNAL_PORT not found/u,
      );
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe('internal port pin (local-program.ts)', () => {
  it('STAFF_ACCESS_INTERNAL_PORT matches the dev.port of apps/staff-access/wrangler.jsonc', () => {
    const pinned = readProgramConstant(
      resolve(import.meta.dirname, 'local-program.ts'),
      'STAFF_ACCESS_INTERNAL_PORT',
    );
    const config = parseJsonc(
      resolve(import.meta.dirname, '../../apps/staff-access/wrangler.jsonc'),
    );
    // Parse thuần trước, expect trong test case (OCR round 3) — helper không
    // gắn bó ngữ cảnh vitest.
    const dev = config['dev'] as { port?: unknown } | undefined;
    if (typeof dev?.port !== 'number') {
      throw new Error('dev.port not found (or not a number) in apps/staff-access/wrangler.jsonc');
    }
    expect(pinned).toBe(dev.port);
  });
});
