import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createServerAccountAdapter } from './real-adapter';
import { resolveAccountDataMode } from './data-mode';

/**
 * Ranh giới import của seam `DATA_MODE` (kèm ghép cấu hình ↔ hành vi).
 *
 * Khẳng định những thứ unit test hành vi không chạm tới:
 *
 * 1. **Ranh giới import** — trên mọi file nguồn của `app/`, đúng một file được
 *    chạm vào mock adapter: điểm chọn adapter. Một `app/pages/x.vue` import
 *    thẳng `mock-adapter` là một đường lọt qua mọi gate, và phép quét toàn thư
 *    mục bắt được cả file mới (không phụ thuộc allow-list nhớ tay).
 * 2. **Ghép giá trị → hành vi** — mode `real` cho adapter thật; giá trị chuỗi
 *    `'mock'` không thể tạo adapter mock ở runtime artifact (resolver từ chối),
 *    nên test dựng adapter thật cho mode real và mock cho mode mock ở dev.
 *
 * ⚠️ Mọi khẳng định trên **source** phải chạy trên bản đã gỡ comment
 * (`withoutComments`): comment của các file này nhắc đúng tên module bị cấm
 * (`mock-adapter`) để giải thích lý do, so khớp trên source thô sẽ đỏ vì chính
 * lời giải thích.
 */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\n]*/gu, '');
}

const APP_DIR = resolve(import.meta.dirname, '..');
const COMPOSABLE = resolve(APP_DIR, 'composables/use-account-adapter.ts');

const APP_SOURCE_EXTENSION = /\.(?:ts|mts|vue)$/u;

/** Đường dẫn tương đối (POSIX) của mọi file nguồn trong `app/`. */
function listAppSources(): string[] {
  return (
    (readdirSync(APP_DIR, { recursive: true, encoding: 'utf8' }) as string[])
      .map((entry) => entry.replaceAll('\\', '/'))
      .filter((entry) => APP_SOURCE_EXTENSION.test(entry))
      // Spec colocate nằm trong `app/` nhưng là test code — được phép import mock
      // adapter — nên loại khỏi scan nguồn app, giữ nguyên bất biến.
      .filter((entry) => !/\.(?:spec|test)\.[^.]+$/u.test(entry))
  );
}

/** Mọi module specifier của `import ... from '...'` và `import('...')`. */
function importSpecifiers(source: string): string[] {
  return [
    /\bfrom\s*['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/gu,
    /\bimport\s*['"]([^'"]+)['"]/gu,
  ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1] ?? ''));
}

/** So khớp specifier với tên module, bỏ phần mở rộng. */
function importsModule(specifiers: readonly string[], moduleName: string): boolean {
  return specifiers.some((specifier) => {
    const base = specifier.replace(/\.(?:ts|mts|vue)$/u, '');
    return base === moduleName || base.endsWith(`/${moduleName}`);
  });
}

describe('data mode import boundary', () => {
  it('only the data layer and the adapter selection point import the mock adapter', () => {
    // Ba đường hợp lệ, đều nằm trong lớp dữ liệu: barrel re-export (bề mặt
    // công khai hiện có của `account-data`, dùng bởi test), `real-adapter`
    // dựng lớp mock bên dưới nó (kiến trúc delegate của PR2, PR4 sẽ thay dần),
    // và điểm chọn adapter dựng mock cho nhánh `mock` của seam. Mỗi file ngoài
    // ba đường này chạm mock là một bypass của fail-closed — phép quét toàn
    // `app/` bắt được cả file mới, không phụ thuộc danh sách nhớ tay.
    const importers = listAppSources().filter((entry) =>
      importsModule(
        importSpecifiers(withoutComments(readFileSync(resolve(APP_DIR, entry), 'utf8'))),
        'mock-adapter',
      ),
    );

    expect(importers.toSorted()).toEqual([
      'account-data/index.ts',
      'account-data/real-adapter.ts',
      'composables/use-account-adapter.ts',
    ]);
  });

  it('the selection point resolves the mode from runtime config before choosing', () => {
    const source = withoutComments(readFileSync(COMPOSABLE, 'utf8'));

    expect(source).toMatch(/resolveAccountDataMode/u);
    expect(source).toMatch(/useRuntimeConfig\(\)/u);
    // Quyết định phải thuần và đọc được từ source: không có nhánh nào đọc
    // query param, cookie, header hay hostname ngoài `runtimeConfig.public`.
    expect(source).not.toMatch(/\bgetQuery\b|\bgetRequestURL\b|\bcookie\b/iu);
  });

  it('the selection point passes an explicit derived preview flag to the real adapter', () => {
    // `isPreview` phải là dẫn xuất tường minh ở điểm chọn adapter — nếu caller
    // dựa vào default `preview = true` của factory thì banner không còn là hàm
    // của mode + domain coverage, và PR4 không còn là thay đổi một dòng ở đúng
    // một chỗ nữa.
    const source = withoutComments(readFileSync(COMPOSABLE, 'utf8'));

    expect(source).toMatch(/createServerAccountAdapter\(\{\},\s*[^)]+\)/u);
  });

  it('wires configuration through to the real adapter the deployment declares', async () => {
    // Nối cấu hình với hành vi: giá trị `real` (đáy fail-closed) đi qua đúng
    // hàm phân giải của app và cho ra adapter server thật. `isPreview` là cờ
    // **dẫn xuất** — mode real + data domain đã có đường BFF thật (PR4 wire)
    // ⇒ cờ đúng sự thật là `false`: banner preview tự tắt, không đụng UI. Nếu
    // sau này thêm domain mới chưa có đường thật, quay lại đổi dòng dưới.
    const resolved = resolveAccountDataMode('real', false);
    const dataDomainHasRealPath = true;
    const adapter = createServerAccountAdapter({}, resolved === 'mock' || !dataDomainHasRealPath);

    expect(resolved).toBe('real');
    expect(adapter.isPreview).toBe(false);
    // Bằng chứng hành vi đây là adapter thật chứ không phải mock: method đọc
    // giờ đi đường fetch thật — trong môi trường test không có server, fetch
    // ném trước cả khi có response (mock thì resolve fixture ngay lập tức).
    await expect(adapter.getProfile()).rejects.toThrow('Failed to parse URL');
  });
});
