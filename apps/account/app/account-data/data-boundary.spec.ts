import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createServerAccountAdapter } from './real-adapter';
import { resolveAccountDataMode } from './data-mode';

/**
 * Ranh giới import của seam `DATA_MODE` (kèm ghép cấu hình ↔ hành vi).
 *
 * Từ Issue #123, ranh giới đổi hình dạng: mock **không còn nằm dưới adapter
 * thật** (đó chính là đường lọt — spread từ mock cho bốn phương thức credential
 * chạy in-memory ở mode real). Kiến trúc mới tách hai đường:
 *
 * - **Artifact**: `real-adapter` tự hiện thực mọi phương thức; composable chỉ
 *   biết `createServerAccountAdapter`. Không file nào trong graph của artifact
 *   chạm `mock-adapter` — được quét toàn thư mục dưới đây.
 * - **Preview (chỉ `nuxt dev`)**: `preview-adapter` ghép fixtures mock lên
 *   adapter thật; plugin dev-only (`preview-adapter-plugin.ts`) là **duy nhất**
 *   chạm nó, và module trong `nuxt.config.ts` chỉ đăng ký plugin đó khi
 *   `nuxt.options.dev`.
 *
 * Phép quét toàn thư mục bắt được cả file mới — không phụ thuộc allow-list nhớ
 * tay. Một `app/pages/x.vue` import thẳng `mock-adapter` hay `preview-adapter`
 * là một đường lọt qua mọi gate.
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
const PROJECT_DIR = resolve(APP_DIR, '..');
const COMPOSABLE = resolve(APP_DIR, 'composables/use-account-adapter.ts');
const PLUGIN = resolve(APP_DIR, 'account-data/preview-adapter-plugin.ts');
const NUXT_CONFIG = resolve(PROJECT_DIR, 'nuxt.config.ts');

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
  it('only the preview composition imports the mock adapter', () => {
    // Một đường hợp lệ duy nhất: `preview-adapter` ghép fixtures mock lên adapter
    // thật. `real-adapter` **không** chạm mock nữa (hiện thực tường minh mọi
    // phương thức), barrel không re-export, composable không biết mock tồn tại.
    const importers = listAppSources().filter((entry) =>
      importsModule(
        importSpecifiers(withoutComments(readFileSync(resolve(APP_DIR, entry), 'utf8'))),
        'mock-adapter',
      ),
    );

    expect(importers.toSorted()).toEqual(['account-data/preview-adapter.ts']);
  });

  it('only the dev-only plugin imports the preview adapter', () => {
    // Cùng phép quét cho nửa preview: chỉ plugin dev-only được chạm
    // `preview-adapter`. Đây là điều kiện để loại trừ build graph có thật —
    // `preview-adapter` (và theo đó `mock-adapter`) chỉ vào module graph qua
    // plugin mà `nuxt.config.ts` chỉ đăng ký dưới `nuxt dev`.
    const importers = listAppSources().filter((entry) =>
      importsModule(
        importSpecifiers(withoutComments(readFileSync(resolve(APP_DIR, entry), 'utf8'))),
        'preview-adapter',
      ),
    );

    expect(importers.toSorted()).toEqual(['account-data/preview-adapter-plugin.ts']);
  });

  it('no app source imports the test adapter double', () => {
    // `tests/test-adapter.ts` là test double scripted auth — chỉ `tests/` được
    // phép dùng. Một import từ `app/` sẽ đưa đường giả vào artifact (và vi phạm
    // chính phần loại trừ build graph ở trên), nên phép quét chặn ngay ở tầng
    // nguồn thay vì dựa vào vị trí file.
    const importers = listAppSources().filter((entry) =>
      importsModule(
        importSpecifiers(withoutComments(readFileSync(resolve(APP_DIR, entry), 'utf8'))),
        'test-adapter',
      ),
    );

    expect(importers).toEqual([]);
  });

  it('registers the preview plugin only under nuxt dev', () => {
    // Module inline trong `nuxt.config.ts` là cơ chế loại trừ build graph: nó
    // phải có guard `nuxt.options.dev` trước khi push plugin, và không có đường
    // dynamic import nào làm phương án "guard runtime" thay thế (lazy chunk
    // vẫn ship trong artifact — `frontend-data-mocking` §H).
    const source = withoutComments(readFileSync(NUXT_CONFIG, 'utf8'));

    expect(source).toMatch(/nuxt\.options\.plugins\.push/u);
    expect(source).toMatch(/if\s*\(!nuxt\.options\.dev\)\s*\{?\s*return/u);
    expect(source).toMatch(/preview-adapter-plugin/u);
    // Không có `import()` nào trong config — mọi đường vào mock là push plugin
    // được guard ở trên.
    expect(source).not.toMatch(/\bimport\s*\(/u);
  });

  it('the selection point has no mock branch and always creates the real adapter', () => {
    const source = withoutComments(readFileSync(COMPOSABLE, 'utf8'));

    expect(source).toMatch(/createServerAccountAdapter\(\)/u);
    // Điểm chọn adapter của artifact không được có nhánh mode nào: resolver mode
    // chỉ phục vụ plugin preview, composable fallback luôn là đường thật.
    expect(source).not.toMatch(/resolveAccountDataMode/u);
    expect(source).not.toMatch(/useRuntimeConfig/u);
    expect(source).not.toMatch(/mock-adapter/u);
  });

  it('the preview plugin seeds only in mock mode', () => {
    const source = withoutComments(readFileSync(PLUGIN, 'utf8'));

    // Plugin tự phân giải mode từ runtime config — dev server chạy với
    // `NITRO_PUBLIC_ACCOUNT_DATA_MODE=real` vẫn giữ đường thật.
    expect(source).toMatch(/resolveAccountDataMode/u);
    expect(source).toMatch(/ACCOUNT_DATA_MODE_MOCK/u);
    expect(source).toMatch(/createPreviewAccountAdapter\(\)/u);
    expect(source).toMatch(/\$accountAdapter \?\?= createPreviewAccountAdapter\(\)/u);
  });

  it('wires configuration through to the real adapter the deployment declares', async () => {
    // Nối cấu hình với hành vi: giá trị `real` (đáy fail-closed) đi qua đúng
    // hàm phân giải của app và cho ra adapter server thật, `isPreview` `false`.
    const resolved = resolveAccountDataMode('real', false);
    const adapter = createServerAccountAdapter();

    expect(resolved).toBe('real');
    expect(adapter.isPreview).toBe(false);
    // Bằng chứng hành vi đây là adapter thật chứ không phải mock: method đọc
    // giờ đi đường fetch thật — trong môi trường test không có server, fetch
    // ném trước cả khi có response (mock thì resolve fixture ngay lập tức).
    await expect(adapter.getProfile()).rejects.toThrow('Failed to parse URL');
  });
});
