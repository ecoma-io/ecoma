import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createBackofficeAdapter } from './adapter';
import {
  BACKOFFICE_DATA_MODE_DISABLED,
  BACKOFFICE_REALTIME_DATA_MODE,
  resolveBackofficeDataMode,
} from './data-mode';

/**
 * Hợp đồng cấu hình gating dữ liệu backoffice (E1, issue #256).
 *
 * File này khẳng định hai nhóm thứ mà unit test hành vi không chạm tới:
 *
 * 1. **Cấu hình deployment thật** — `wrangler.jsonc` khai `disabled` tường minh ở
 *    production và `prototype` tường minh ở staging; `nuxt.config.ts` có default
 *    fail-closed. Đây là thứ quyết định hành vi ở môi trường thật, không phải
 *    code đọc cấu hình.
 * 2. **Ranh giới import** — fixture chỉ đến được UI qua mock adapter, và
 *    composable không có đường đọc input từ request.
 *
 * ⚠️ Mọi khẳng định trên **source** phải chạy trên bản đã gỡ comment
 * (`withoutComments`). Comment trong các file này nhắc đúng những từ khoá bị cấm
 * (`localStorage`, `PROTOTYPE_DATA`, `prototype`) để giải thích lý do chúng không
 * được dùng — so khớp trên source thô sẽ đỏ vì chính lời giải thích, và một bản
 * sửa "xoá comment" để test xanh là bản sửa sai hướng. Ngược lại, comment cũng
 * không được phép *thoả* một khẳng định dương, nên việc gỡ comment làm cả hai
 * chiều đều trung thực.
 */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\n]*/gu, '');
}

const APP_DIR = resolve(import.meta.dirname, '..');
const DATA_DIR = resolve(APP_DIR, 'backoffice-data');

function readSource(path: string): string {
  return withoutComments(readFileSync(path, 'utf8'));
}

/**
 * Quét **toàn bộ** `app/`, không phải một danh sách file nhớ tay.
 *
 * Các test dưới dùng allow-list (`BACKOFFICE_DATA`) để khẳng định từng file trọng
 * yếu đúng đắn; allow-list chỉ nói về những file nó biết, nên một bypass nằm ở
 * file mới (một `app/pages/x.vue` import thẳng fixture, một `app/utils/*.ts` gọi
 * mock factory) sẽ lọt qua tất cả. Phép quét này khẳng định điều ngược lại: trên
 * mọi file nguồn của `app/`, chỉ đúng một file được chạm vào mock adapter và đúng
 * một file được chạm vào fixture — nên file mới không "tự động hợp lệ".
 */
const APP_SOURCE_EXTENSION = /\.(?:ts|mts|vue)$/u;

/** Đường dẫn tương đối (POSIX) của mọi file nguồn trong `app/`. */
function listAppSources(): string[] {
  return (
    (readdirSync(APP_DIR, { recursive: true, encoding: 'utf8' }) as string[])
      .map((entry) => entry.replaceAll('\\', '/'))
      .filter((entry) => APP_SOURCE_EXTENSION.test(entry))
      // Spec colocate nằm trong `app/` (chính sách test layout) nhưng là test
      // code — được phép import mock adapter/fixture — nên loại khỏi scan nguồn
      // app, giữ nguyên bất biến như khi spec còn ở `tests/`.
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

/** So khớp specifier với tên module, bỏ phần mở rộng: `'./mock-adapter'` khớp `mock-adapter`. */
function importsModule(specifiers: readonly string[], moduleName: string): boolean {
  return specifiers.some((specifier) => {
    const base = specifier.replace(/\.(?:ts|mts|vue)$/u, '');
    return base === moduleName || base.endsWith(`/${moduleName}`);
  });
}

/**
 * File duy nhất trong `app/` được import mock adapter: điểm chọn adapter. File
 * duy nhất được import fixture: chính mock adapter.
 */
const MOCK_ADAPTER_IMPORTERS = ['backoffice-data/adapter.ts'];
const PROTOTYPE_FIXTURE_IMPORTERS = ['backoffice-data/mock-adapter.ts'];

const BACKOFFICE_DATA = {
  index: readSource(resolve(DATA_DIR, 'index.ts')),
  adapter: readSource(resolve(DATA_DIR, 'adapter.ts')),
  dataMode: readSource(resolve(DATA_DIR, 'data-mode.ts')),
  mockAdapter: readSource(resolve(DATA_DIR, 'mock-adapter.ts')),
  unavailableAdapter: readSource(resolve(DATA_DIR, 'unavailable-adapter.ts')),
  fixture: readSource(resolve(DATA_DIR, 'prototype-fixture.ts')),
} as const;

const COMPOSABLE = readSource(resolve(APP_DIR, 'composables/use-backoffice-adapter.ts'));
const NUXT_CONFIG = readSource(resolve(import.meta.dirname, '../../nuxt.config.ts'));
const NITRO_CONFIG = readSource(resolve(import.meta.dirname, '../../nitro.config.ts'));
/** Wrangler config là JSONC, không phải TS: dùng cùng luật gỡ comment. */
const WRANGLER_CONFIG = withoutComments(
  readFileSync(resolve(import.meta.dirname, '../../wrangler.jsonc'), 'utf8'),
);

/** Giá trị thô của `NITRO_PUBLIC_BACKOFFICE_DATA_MODE` trong một env của wrangler. */
function declaredMode(env: 'staging' | 'production'): string | undefined {
  const block = new RegExp(
    `"${env}"\\s*:\\s*\\{[\\s\\S]*?\\}\\s*,?\\s*(?:"production"|\\}\\s*,?\\s*\\|$)`,
    'u',
  ).exec(WRANGLER_CONFIG)?.[0];
  const scope = block ?? WRANGLER_CONFIG.slice(WRANGLER_CONFIG.indexOf(`"${env}"`));

  return scope.match(/"NITRO_PUBLIC_BACKOFFICE_DATA_MODE"\s*:\s*"([^"]*)"/u)?.[1];
}

describe('deployment configuration', () => {
  it('production declares NITRO_PUBLIC_BACKOFFICE_DATA_MODE=disabled explicitly', () => {
    expect(declaredMode('production')).toBe('disabled');
  });

  it('staging declares NITRO_PUBLIC_BACKOFFICE_DATA_MODE=realtime explicitly', () => {
    expect(declaredMode('staging')).toBe('realtime');
  });

  it('the two envs declare vars separately (vars do not inherit)', () => {
    // Một khai báo duy nhất ở top-level sẽ làm production thừa hưởng giá trị của
    // một env — đúng thứ `wrangler` không làm, và đúng thứ không được dựa vào.
    const topLevel = WRANGLER_CONFIG.slice(0, WRANGLER_CONFIG.indexOf('"env"'));
    expect(topLevel).not.toMatch(/NITRO_PUBLIC_BACKOFFICE_DATA_MODE/u);

    const occurrences = [...WRANGLER_CONFIG.matchAll(/NITRO_PUBLIC_BACKOFFICE_DATA_MODE/gu)];
    expect(occurrences).toHaveLength(2);
  });

  it('the value production declares resolves, through the real decision, to the unavailable adapter', async () => {
    // Nối cấu hình với hành vi: giá trị nằm trong `wrangler.jsonc` cho production
    // phải đi qua đúng hàm phân giải của app và cho ra adapter không phục vụ dữ liệu.
    const resolved = resolveBackofficeDataMode(declaredMode('production'));
    const adapter = createBackofficeAdapter(resolved);

    expect(resolved).toBe('unavailable');
    expect(adapter.isPreview).toBe(false);
    await expect(adapter.listStaff()).rejects.toMatchObject({
      code: 'backoffice_backend_unavailable',
    });
  });

  it('the value staging declares resolves, through the real decision, to the real adapter', () => {
    const resolved = resolveBackofficeDataMode(declaredMode('staging'));
    const adapter = createBackofficeAdapter(resolved);

    expect(resolved).toBe('realtime');
    expect(adapter.isPreview).toBe(false);
  });

  it('the values the two envs declare are the constants the module names', () => {
    // Hai khẳng định literal ở trên ghim chính xác chuỗi nằm trong file; test này
    // nối chúng với **hằng số của module**, để `data-mode.ts` là nơi khai tập giá
    // trị hợp lệ và việc đổi giá trị ở đó mà quên cấu hình (hoặc ngược lại) là đỏ.
    expect(declaredMode('staging')).toBe(BACKOFFICE_REALTIME_DATA_MODE);
    expect(declaredMode('production')).toBe(BACKOFFICE_DATA_MODE_DISABLED);
  });

  it('nuxt.config.ts imports and uses the disabled constant (single source of truth)', () => {
    const runtimeConfig = /runtimeConfig\s*:\s*\{[\s\S]*?\n {2}\}/u.exec(NUXT_CONFIG)?.[0] ?? '';

    expect(runtimeConfig).not.toBe('');
    expect(runtimeConfig).toMatch(/backofficeDataMode\s*:\s*BACKOFFICE_DATA_MODE_DISABLED/u);
    // Nhập **hằng** từ module lớp dữ liệu (barrel hay đường dẫn sâu đều được), chứ
    // không khai lại giá trị: một `const BACKOFFICE_DATA_MODE_DISABLED = 'disabled'`
    // cục bộ ở đây là lại có thêm một chỗ khai tập giá trị hợp lệ.
    expect(NUXT_CONFIG).toMatch(
      /import \{[^}]*BACKOFFICE_DATA_MODE_DISABLED[^}]*\} from '\.\/app\/backoffice-data/u,
    );
    expect(BACKOFFICE_DATA_MODE_DISABLED).toBe('disabled');
  });

  it('nitro.config.ts does not redeclare the mode key (single source)', () => {
    expect(NITRO_CONFIG).not.toMatch(/backofficeDataMode/u);
  });
});

describe('import boundaries', () => {
  it('only mock-adapter.ts imports the prototype fixture', () => {
    expect(BACKOFFICE_DATA.mockAdapter).toMatch(/from '\.\/prototype-fixture'/u);

    for (const [name, source] of Object.entries(BACKOFFICE_DATA)) {
      if (name === 'mockAdapter' || name === 'fixture') {
        continue;
      }
      expect(source).not.toMatch(/from '\.\/prototype-fixture'/u);
    }
  });

  it('the fixture is not re-exported from the barrel (closes the bypass)', () => {
    expect(BACKOFFICE_DATA.index).not.toMatch(/PROTOTYPE_DATA/u);
    expect(BACKOFFICE_DATA.fixture).toMatch(/export const PROTOTYPE_DATA/u);
  });

  it('the barrel does not re-export the mock factory (createBackofficeAdapter is the only entry)', () => {
    // Barrel tự khai là API công khai ("các file bên ngoài chỉ import từ đây").
    // Re-export factory mock ở đó cho phép lấy adapter fixture mà không qua
    // `createBackofficeAdapter`, tức bỏ qua gating — cùng loại bypass như
    // `PROTOTYPE_DATA` ở trên.
    expect(BACKOFFICE_DATA.index).not.toMatch(/createMockBackofficeAdapter|mock-adapter/u);
  });

  it('adapter.ts imports only the gating modules, no request API', () => {
    expect(BACKOFFICE_DATA.adapter).toMatch(/from '\.\/data-mode'/u);
    expect(BACKOFFICE_DATA.adapter).toMatch(/import\('\.\/mock-adapter'\)/u);
    expect(BACKOFFICE_DATA.adapter).toMatch(/from '\.\/unavailable-adapter'/u);
    expect(BACKOFFICE_DATA.adapter).toMatch(/from '\.\/real-adapter'/u);
    expect(BACKOFFICE_DATA.adapter).not.toMatch(/#app|#imports|nitropack|h3/u);
  });

  it('adapter.ts loads the mock adapter through a dynamic import, not a static one', () => {
    // Import tĩnh của `mock-adapter` kéo `prototype-fixture` vào client bundle
    // của mọi env (S6): gating chỉ chặn *dùng* fixture, không chặn *phát bytes*.
    // Dynamic `import()` là điều kiện để bundler tách fixture thành chunk riêng,
    // nên assertion này phải khẳng định cả hai chiều: specifier động có mặt ở
    // điểm chọn adapter, và dạng tĩnh không tồn tại ở đó.
    expect(BACKOFFICE_DATA.adapter).toMatch(/import\('\.\/mock-adapter'\)/u);
    expect(BACKOFFICE_DATA.adapter).not.toMatch(/from '\.\/mock-adapter'/u);
  });

  it('adapter.ts pins the factory registry exhaustively, with no type cast', () => {
    // Bảng mode → factory được đánh dấu `satisfies Readonly<Record<...>>`:
    // thêm mode mới vào `data-mode.ts` mà quên khai factory là lỗi compile.
    // `as unknown as` ở đây chính là lỗ hổng S7 — nó tắt đúng phép kiểm đó,
    // nên cả ba chiều được ghim: `satisfies` phải có mặt (mutation "bỏ
    // satisfies" đỏ), phép cast bị cấm (mutation "thêm lại cast" đỏ), và
    // chú thích `Partial` phải có mặt (mutation "đổi sang Record đầy đủ rồi
    // bỏ `??` fallback" sẽ đi qua đây). Ghim trên chữ đã gỡ comment: comment
    // có nhắc `as unknown as` để giải thích lý do cấm thì không được thoá.
    expect(BACKOFFICE_DATA.adapter).toMatch(/satisfies Readonly<Record<BackofficeDataMode/u);
    expect(BACKOFFICE_DATA.adapter).toMatch(/Partial<Record<BackofficeDataMode/u);
    expect(BACKOFFICE_DATA.adapter).not.toMatch(/as unknown as/u);
  });

  it('adapter.ts compares against the mode constant, not a literal', () => {
    // Hai chỗ cùng khai `'prototype'` làm "nguồn duy nhất" chỉ còn đúng trong
    // comment: đổi tên mode ở `data-mode.ts` sẽ lặng lẽ làm adapter rơi về
    // unavailable (fail-closed nên không lộ dữ liệu, nhưng staging mất mẫu im lặng).
    expect(BACKOFFICE_DATA.adapter).toMatch(/BACKOFFICE_PREVIEW_DATA_MODE/u);
    expect(BACKOFFICE_DATA.adapter).not.toMatch(/===\s*'prototype'/u);
    expect(BACKOFFICE_DATA.dataMode).toMatch(/BACKOFFICE_PREVIEW_DATA_MODE\s*=\s*'prototype'/u);
  });

  it('data-mode derives its type from the constant and returns the constant', () => {
    expect(BACKOFFICE_DATA.dataMode).toMatch(
      /type BackofficeDataMode =\s*\|\s*typeof BACKOFFICE_PREVIEW_DATA_MODE/u,
    );
    expect(BACKOFFICE_DATA.dataMode).toMatch(/\| typeof BACKOFFICE_REALTIME_DATA_MODE/u);
    expect(BACKOFFICE_DATA.dataMode).toMatch(/\| 'unavailable'/u);
    expect(BACKOFFICE_DATA.dataMode).toMatch(/return BACKOFFICE_PREVIEW_DATA_MODE/u);
    expect(BACKOFFICE_DATA.dataMode).toMatch(/return BACKOFFICE_REALTIME_DATA_MODE/u);
    expect(BACKOFFICE_DATA.dataMode).not.toMatch(/return 'prototype'/u);
  });

  it('the unavailable adapter imports no fixture and returns rejected promises', () => {
    expect(BACKOFFICE_DATA.unavailableAdapter).not.toMatch(/prototype-fixture|PROTOTYPE_DATA/u);
    expect(BACKOFFICE_DATA.unavailableAdapter).toMatch(/async/u);
    expect(BACKOFFICE_DATA.unavailableAdapter).toMatch(
      /throw new BackofficeBackendUnavailableError/u,
    );
  });

  it('data-mode is a pure module: imports no #app and reads no request', () => {
    expect(BACKOFFICE_DATA.dataMode).not.toMatch(/#app|#imports|h3|nitropack/u);
    expect(BACKOFFICE_DATA.dataMode).not.toMatch(/use(?:Route|Cookie|Request\w*)\(/u);
  });

  it('the composable reads only runtimeConfig; it has no request-derived branch', () => {
    expect(COMPOSABLE).toMatch(/useRuntimeConfig\(\)/u);
    expect(COMPOSABLE).toMatch(/resolveBackofficeDataMode\(/u);
    expect(COMPOSABLE).toMatch(/createBackofficeAdapter\(/u);

    for (const forbidden of [
      /useRoute\(/u,
      /useCookie\(/u,
      /useRequestHeaders\(/u,
      /useRequestURL\(/u,
      /useRequestEvent\(/u,
      /useRequestFetch\(/u,
      /localStorage/u,
      /document\.cookie/u,
      /window\.location/u,
      /process\.env/u,
      /import\.meta\.(?:dev|client|server)/u,
    ]) {
      expect(COMPOSABLE).not.toMatch(forbidden);
    }
  });

  it('the composable does not import mock-adapter directly (it must go through the selection point)', () => {
    expect(COMPOSABLE).not.toMatch(/mock-adapter|prototype-fixture|unavailable-adapter/u);
    expect(COMPOSABLE).not.toMatch(/from '\.\.\/backoffice-data\//u);
    expect(COMPOSABLE).toMatch(/from '\.\.\/backoffice-data'/u);
  });

  it('scans every app source so a new file cannot import the mock adapter or the fixture', () => {
    const files = listAppSources();
    const mockImporters: string[] = [];
    const fixtureImporters: string[] = [];

    for (const file of files) {
      const specifiers = importSpecifiers(readSource(resolve(APP_DIR, file)));
      if (importsModule(specifiers, 'mock-adapter')) {
        mockImporters.push(file);
      }
      if (importsModule(specifiers, 'prototype-fixture')) {
        fixtureImporters.push(file);
      }
    }

    // Chốt chặn cho chính phép quét: nếu đường dẫn/đuôi file sai thì hai khẳng
    // định dưới xanh một cách vô nghĩa (không file nào bị quét).
    expect(files).toContain('backoffice-data/mock-adapter.ts');
    expect(files).toContain('composables/use-backoffice-adapter.ts');
    expect(new Set(mockImporters)).toEqual(new Set(MOCK_ADAPTER_IMPORTERS));
    expect(new Set(fixtureImporters)).toEqual(new Set(PROTOTYPE_FIXTURE_IMPORTERS));
  });

  it('app code imports the data layer through the barrel so the barrel is not dead code', () => {
    const barrelImporters: string[] = [];

    for (const file of listAppSources()) {
      if (file === 'backoffice-data/index.ts') {
        continue;
      }

      const specifiers = importSpecifiers(readSource(resolve(APP_DIR, file)));
      if (importsModule(specifiers, 'backoffice-data')) {
        barrelImporters.push(file);
      }
    }

    // Barrel khai mình là bề mặt công khai của lớp dữ liệu; nếu không file app nào
    // import qua nó thì bề mặt đó chỉ là mô tả sai, và "chỗ lộ bypass" mà barrel
    // được cho là ghim thực chất không gác gì cả.
    expect(new Set(barrelImporters)).toEqual(
      new Set(['composables/use-backoffice-adapter.ts', 'pages/audit.vue', 'pages/staff.vue']),
    );
  });
});
