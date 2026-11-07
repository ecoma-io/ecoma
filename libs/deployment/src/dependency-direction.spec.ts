/**
 * Contract direction của lib: `libs/deployment` là tầng ĐÁNG TIN NHẤT dưới
 * mọi consumer — nó KHÔNG được import `tools/dx`, `deploys/*` hay bất kỳ
 * package workspace nào khác. Test này đọc nguồn lib trực tiếp (không phụ
 * thuộc oxlint chạy đúng cấu hình) nên một import ngược mới lọt qua là đỏ
 * ngay trong `nx test @ecoma-io/deployment`.
 *
 * Chiều hợp lệ duy nhất: `deploys/*` → lib, `tools/dx` → lib. Nghịch lý cần
 * chặn: lib "tiện tay" import một helper từ dx/deploy để cho một consumer
 * compile — kéo toàn bộ CLI tooling vào runtime Pulumi của deploy unit.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const LIB_SRC_DIR = dirname(import.meta.filename ?? '');

function libSources(): readonly { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const scan = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.endsWith('.spec.ts') || name.endsWith('.d.ts')) continue;
      if (name.endsWith('.ts')) {
        out.push({ file: join('src', name), source: readFileSync(path, 'utf8') });
      }
    }
  };
  scan(LIB_SRC_DIR);
  return out;
}

describe('dependency direction (the lib is the bottom of the deployment graph)', () => {
  it('the lib imports no workspace package (only node builtins and relative modules)', () => {
    // Lib nằm TẦNG DƯỚI CÙNG: import package workspace khác (`@ecoma-io/*`)
    // từ lib là cạnh ngược — consumer của lib (dx, deploys) sẽ bị cycle qua
    // package graph. Node builtin + import tương đối trong chính lib là hai
    // hình hợp lệ duy nhất.
    const offenders: string[] = [];
    for (const { file, source } of libSources()) {
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((m) => m[1]);
      for (const specifier of imports) {
        if (specifier.startsWith('@ecoma-io/')) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
