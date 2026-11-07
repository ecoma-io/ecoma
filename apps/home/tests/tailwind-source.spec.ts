import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ghim đường dẫn `@source` trong stylesheet của app — bắt lỗi đếm sai số cấp.
 *
 * Vì sao cần: Tailwind v4 **bỏ qua âm thầm** một `@source` trỏ tới thư mục
 * không tồn tại. Không có lỗi build, không có warning, typecheck vẫn xanh; biểu
 * hiện duy nhất là utility không được sinh ra nên component render sai màu. Lỗi
 * này đã xảy ra thật: `../../../../libs/ui-ecoma-logo/src` (4 cấp) trỏ vào
 * `apps/libs/...` không tồn tại thay vì root workspace, và việc CSS production
 * vẫn có `.fill-brand`/`.fill-foam` chỉ là **trùng hợp** — hai class đó cũng
 * xuất hiện trong comment của `PublicHeader.vue`/`PublicFooter.vue` và trong
 * assertion của `public-shell-ssr.spec.ts`/`home-page.spec.ts`, nên Tailwind
 * quét được chúng từ chính `apps/home/**` dù library chưa từng được đăng ký.
 * Xoá các chuỗi đó khỏi app là mất màu logo mà không test nào đỏ.
 *
 * Vì sao kiểm ở đây chứ không bằng test trên CSS đã build: test trên output
 * chứng minh được "có class", không chứng minh được "nhờ library". Phải khẳng
 * định **base tĩnh của `@source` phủ đúng thư mục nguồn library**, đó mới là
 * bất biến thật — và nó không phụ thuộc vào việc app có nhắc tên class hay không.
 *
 * `node:fs` bị lint cấm trong `apps/**` (runtime:edge) nhưng file này chạy ở
 * test time trên Node, không vào Worker bundle; override của
 * `**\/*.{spec,test}.*` trong `.oxlintrc.json` đã tắt rule đó cho spec.
 */

/** Stylesheet khai báo `@source` — đường dẫn trong đó tính tương đối từ chính nó. */
const STYLESHEET = resolve(import.meta.dirname, '../app/assets/css/styles.css');

/** Gốc workspace, để đối chiếu base của `@source` với thư mục nguồn library. */
const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../..');

/** Thư mục nguồn của library phải được phủ — nơi chứa class Tailwind của logo. */
const LIB_SOURCE_DIR = resolve(WORKSPACE_ROOT, 'libs/ui-ecoma-logo/src');

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

describe('Tailwind @source registration of the app', () => {
  it('declares at least one @source and every static base exists on disk', () => {
    // Base không tồn tại là lỗi im lặng của Tailwind: registration bị bỏ qua
    // hoàn toàn. Đây là assertion trực tiếp bắt lỗi đếm sai số cấp `..`.
    expect(SOURCE_GLOBS.length).toBeGreaterThan(0);

    for (const glob of SOURCE_GLOBS) {
      const base = staticBaseOf(glob);
      expect(existsSync(base)).toBe(true);
    }
  });

  it('registers the source directory of @ecoma-io/ui-ecoma-logo', () => {
    // Không chỉ "tồn tại": base phải thật sự phủ thư mục nguồn library. Một
    // `@source` trỏ nhầm sang thư mục khác vẫn có thể tồn tại trên đĩa, nên
    // kiểm riêng điều kiện này.
    const coversLibrary = SOURCE_GLOBS.some((glob) => {
      const normalized = staticBaseOf(glob);
      return normalized === LIB_SOURCE_DIR || LIB_SOURCE_DIR.startsWith(`${normalized}/`);
    });
    expect(coversLibrary).toBe(true);
  });

  it('also registers .vue files — where the Tailwind classes of the logo actually live', () => {
    // Class `fill-brand`/`fill-foam` nằm trong `EcomaLogo.vue`, không nằm trong
    // `.ts` nào. Một glob chỉ có `.ts` vẫn "phủ đúng thư mục" nhưng không sinh
    // được utility nào — nên phải ghim cả phần mở rộng. Đồng thời khẳng định
    // thực tế trong thư mục library có file `.vue` để tránh assertion vô nghĩa.
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
});
