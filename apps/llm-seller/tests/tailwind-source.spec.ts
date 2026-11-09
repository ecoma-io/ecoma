import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ghim đường dẫn tương đối trong stylesheet của app — `@source` và `@import`.
 *
 * Vì sao cần: Tailwind v4 **bỏ qua âm thầm** một `@source` trỏ tới thư mục
 * không tồn tại. Không có lỗi build, không có warning, typecheck vẫn xanh; biểu
 * hiện duy nhất là utility không được sinh ra nên shell render sai màu, sai
 * khoảng cách — mà không test nào đỏ. Lỗi này đã xảy ra thật ở `apps/home` với
 * `../../../../libs/ui-ecoma-logo/src` (4 cấp) trỏ vào `apps/libs/...`, và chỉ
 * được phát hiện nhờ test này.
 *
 * CSS của library được `@import` bằng đường dẫn tương đối chứ không qua
 * specifier của package: `alias` của app cũng bị áp cho resolver stylesheet của
 * Tailwind, nên `'@ecoma-io/ui-app-shell/styles/app-shell.css'` bị ghép thành
 * `.../src/index.ts/styles/app-shell.css` (build đỏ `ENOTDIR`). Cùng một phép
 * đếm cấp `..`, nên cùng được ghim ở đây.
 *
 * Vì sao kiểm ở đây chứ không bằng test trên CSS đã build: test trên output
 * chứng minh được "có class", không chứng minh được "nhờ library". Phải khẳng
 * định **base tĩnh của `@source` phủ đúng thư mục nguồn library**, đó mới là bất
 * biến thật — và nó không phụ thuộc vào việc app có nhắc tên class hay không.
 *
 * Tên class **không** được viết ra trong chính stylesheet (kể cả trong comment):
 * Tailwind quét cả file đó, nên một class chỉ được nhắc trong comment vẫn sinh
 * ra utility và làm phép kiểm trên CSS production trở thành đúng giả tạo.
 *
 * `node:fs` bị lint cấm trong `apps/**` (runtime:edge) nhưng file này chạy ở
 * test time trên Node, không vào Worker bundle; override của
 * `**\/*.{spec,test}.*` trong `.oxlintrc.json` đã tắt rule đó cho spec.
 */

/** Stylesheet khai báo `@source` — đường dẫn trong đó tính tương đối từ chính nó. */
const STYLESHEET = resolve(import.meta.dirname, '../app/assets/css/styles.css');

/** Gốc workspace, để đối chiếu base của `@source` với thư mục nguồn library. */
const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../..');

/** Thư mục nguồn của library phải được phủ — nơi chứa class Tailwind của shell. */
const LIB_SOURCE_DIR = resolve(WORKSPACE_ROOT, 'libs/ui-app-shell/src');

/** Entry CSS của library — nguồn của cả design token lẫn utility của shell. */
const LIB_STYLESHEET = resolve(LIB_SOURCE_DIR, 'styles/app-shell.css');

/** Phần tĩnh (trước ký tự `*` đầu tiên) của một glob, đã resolve thành đường dẫn tuyệt đối. */
function staticBaseOf(glob: string): string {
  const sourcesDir = dirname(STYLESHEET);
  const starIndex = glob.indexOf('*');
  const staticPart = starIndex === -1 ? glob : glob.slice(0, starIndex);
  return resolve(sourcesDir, staticPart);
}

/** Mọi giá trị trong `@source "..."` của stylesheet, theo thứ tự xuất hiện. */
function readSourceGlobs(css: string): string[] {
  return [...css.matchAll(/@source\s+"([^"]+)"/gu)].map((match) => match[1] as string);
}

/**
 * Mọi `@import` trỏ theo **đường dẫn tương đối** (`./` hoặc `../`) trong
 * stylesheet — đã resolve thành đường dẫn tuyệt đối.
 *
 * Chỉ lấy import tương đối: import dạng bare specifier (`tailwindcss`,
 * `katex/dist/katex.min.css`) resolve qua `node_modules`, không tính theo cấp
 * `..`, nên không thuộc bất biến mà test này ghim.
 */
function relativeImportsOf(css: string): string[] {
  return [...css.matchAll(/@import\s+['"](\.[^'"]+)['"]/gu)].map((match) =>
    resolve(dirname(STYLESHEET), match[1] as string),
  );
}

/**
 * Phần mở rộng mà glob nhắm tới, bỏ dấu chấm — hiểu cả `*.vue` lẫn `*.{vue,ts}`.
 * Cần thiết vì `*.{vue,ts}` không chứa chuỗi con `.vue`, nên kiểm bằng
 * `toContain('.vue')` sẽ đỏ dù glob hoàn toàn đúng.
 */
function extensionsOf(glob: string): string[] {
  const braced = /\.\{([^}]+)\}\s*$/u.exec(glob);
  if (braced !== null) {
    return (braced[1] as string).split(',').map((ext) => ext.trim().replace(/^\./u, ''));
  }
  const single = /\.(\w+)\s*$/u.exec(glob);
  return single === null ? [] : [single[1] as string];
}

/** Mọi file `.vue` trong thư mục nguồn library, đệ quy. */
function vueFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return vueFilesUnder(path);
    }
    return entry.name.endsWith('.vue') ? [path] : [];
  });
}

const STYLESHEET_CSS = readFileSync(STYLESHEET, 'utf8');
const SOURCE_GLOBS = readSourceGlobs(STYLESHEET_CSS);
const RELATIVE_IMPORTS = relativeImportsOf(STYLESHEET_CSS);

describe('app Tailwind @source registration', () => {
  it('declares at least one @source and every static base exists on disk', () => {
    // Base không tồn tại là lỗi im lặng của Tailwind: registration bị bỏ qua
    // hoàn toàn. Đây là assertion trực tiếp bắt lỗi đếm sai số cấp `..`.
    expect(SOURCE_GLOBS.length).toBeGreaterThan(0);

    for (const glob of SOURCE_GLOBS) {
      const base = staticBaseOf(glob);
      expect(existsSync(base)).toBe(true);
    }
  });

  it('registers the source directory of @ecoma-io/ui-app-shell', () => {
    // Không chỉ "tồn tại": base phải thật sự phủ thư mục nguồn library. Một
    // `@source` trỏ nhầm sang thư mục khác vẫn có thể tồn tại trên đĩa, nên
    // kiểm riêng điều kiện này.
    const coversLibrary = SOURCE_GLOBS.some((glob) => {
      const normalized = staticBaseOf(glob);
      return normalized === LIB_SOURCE_DIR || LIB_SOURCE_DIR.startsWith(`${normalized}/`);
    });
    expect(coversLibrary).toBe(true);
  });

  it('registers .vue files too — where the shell Tailwind classes actually live', () => {
    // Class của shell nằm trong các `.vue` của library, không nằm trong `.ts`
    // nào. Một glob chỉ có `.ts` vẫn "phủ đúng thư mục" nhưng không sinh được
    // utility nào — nên phải ghim cả phần mở rộng. Đồng thời khẳng định thực tế
    // trong thư mục library có file `.vue` để tránh assertion vô nghĩa.
    const libraryGlob = SOURCE_GLOBS.find(
      (glob) =>
        staticBaseOf(glob) === LIB_SOURCE_DIR ||
        LIB_SOURCE_DIR.startsWith(`${staticBaseOf(glob)}/`),
    );
    expect(libraryGlob).toBeDefined();

    const libVueFiles = vueFilesUnder(LIB_SOURCE_DIR);
    expect(libVueFiles.length).toBeGreaterThan(0);

    const extensions = extensionsOf(libraryGlob as string);
    expect(extensions.includes('vue')).toBe(true);
  });

  it('@imports the library CSS by a relative path pointing at the real entry', () => {
    // Entry CSS của library là nguồn của design token (`@theme`) lẫn layer
    // utility của shell, nên nếu import trỏ sai thì shell mất cả hai — và mất
    // theo kiểu im lặng nếu đích sai lại **tồn tại**.
    expect(existsSync(LIB_STYLESHEET)).toBe(true);
    expect(RELATIVE_IMPORTS).toContain(LIB_STYLESHEET);

    // và import đó phải **không** đi qua specifier của package: alias của app bị
    // áp cho cả resolver stylesheet của Tailwind, nên dạng
    // `'@ecoma-io/ui-app-shell/styles/...'` sẽ resolve sai thành
    // `<entrypoint TS>/styles/app-shell.css` và làm build đỏ `ENOTDIR`.
    expect(STYLESHEET_CSS).not.toMatch(/@import\s+['"]@ecoma-io\/ui-app-shell\//u);
  });
});
