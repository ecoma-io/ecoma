import { describe, expect, it } from 'vitest';
import appShellCss from '../../styles/app-shell.css?raw';
import {
  APP_SHELL_THEME_COLORS,
  DEFAULT_APP_SHELL_PREFERENCES,
  appShellColorClass,
  appShellHeadAttributes,
  isAppShellDirection,
  isAppShellPreferences,
  isAppShellThemeColor,
  migrateLegacyAppSettings,
  parseAppShellPreferences,
} from './index';

/**
 * Hợp đồng của cấu hình shell. Ba nhóm bất biến ở đây là thứ dễ vỡ im lặng
 * nhất: danh sách màu lệch khỏi CSS, giá trị đã lưu không hợp lệ lọt qua, và
 * shell lỡ nhận một cấu hình thuộc về nguồn (theme.type, sidebar.variant).
 */
describe('parseAppShellPreferences', () => {
  it('returns deterministic defaults for empty and non-object input', () => {
    expect(parseAppShellPreferences(undefined)).toEqual(DEFAULT_APP_SHELL_PREFERENCES);
    expect(parseAppShellPreferences(null)).toEqual(DEFAULT_APP_SHELL_PREFERENCES);
    expect(parseAppShellPreferences('nonsense')).toEqual(DEFAULT_APP_SHELL_PREFERENCES);
    expect(parseAppShellPreferences(42)).toEqual(DEFAULT_APP_SHELL_PREFERENCES);
    expect(parseAppShellPreferences({})).toEqual(DEFAULT_APP_SHELL_PREFERENCES);
  });

  it('keeps valid persisted values', () => {
    expect(parseAppShellPreferences({ themeColor: 'teal', direction: 'rtl' })).toEqual({
      themeColor: 'teal',
      direction: 'rtl',
    });
  });

  it('falls back per field, so one bad field cannot reset the other', () => {
    expect(parseAppShellPreferences({ themeColor: 'teal', direction: 'sideways' })).toEqual({
      themeColor: 'teal',
      direction: 'ltr',
    });

    expect(parseAppShellPreferences({ themeColor: 'chartreuse', direction: 'rtl' })).toEqual({
      themeColor: 'default',
      direction: 'rtl',
    });
  });

  it('rejects colours that exist in the source CSS but have no UI path', () => {
    // `.color-amber` va `.color-purple` co trong CSS nguon nhung khong nam
    // trong bang chon mau, nen chung khong duoc coi la gia tri hop le.
    expect(isAppShellThemeColor('amber')).toBe(false);
    expect(isAppShellThemeColor('purple')).toBe(false);
    expect(parseAppShellPreferences({ themeColor: 'amber' }).themeColor).toBe('default');
  });

  it('ignores source-only settings instead of resurrecting them', () => {
    const parsed = parseAppShellPreferences({
      themeColor: 'blue',
      direction: 'rtl',
      theme: { color: 'violet', type: 'mono' },
      sidebar: { variant: 'floating', side: 'right', collapsible: 'icon' },
    });

    expect(parsed).toEqual({ themeColor: 'blue', direction: 'rtl' });
    expect(parsed).not.toHaveProperty('theme');
    expect(parsed).not.toHaveProperty('sidebar');
  });

  it('always returns exactly the two supported keys', () => {
    expect(Object.keys(parseAppShellPreferences({ themeColor: 'red', direction: 'ltr' }))).toEqual([
      'themeColor',
      'direction',
    ]);
  });
});

describe('isAppShellPreferences', () => {
  it('accepts a fully valid value', () => {
    expect(isAppShellPreferences({ themeColor: 'default', direction: 'ltr' })).toBe(true);
  });

  it('rejects partial, wrongly typed and extra-keyed values', () => {
    expect(isAppShellPreferences({ themeColor: 'default' })).toBe(false);
    expect(isAppShellPreferences({ direction: 'rtl' })).toBe(false);
    expect(isAppShellPreferences({ themeColor: 'default', direction: 'up' })).toBe(false);
    expect(isAppShellPreferences(null)).toBe(false);
    expect(isAppShellPreferences([])).toBe(false);
    // Gia tri thua khoa van la du lieu cua phien ban cu: khong nhan.
    expect(
      isAppShellPreferences({ themeColor: 'default', direction: 'ltr', sidebar: 'icon' }),
    ).toBe(false);
  });
});

describe('isAppShellDirection', () => {
  it('accepts only ltr and rtl', () => {
    expect(isAppShellDirection('ltr')).toBe(true);
    expect(isAppShellDirection('rtl')).toBe(true);
    expect(isAppShellDirection('auto')).toBe(false);
    expect(isAppShellDirection(undefined)).toBe(false);
  });
});

describe('migrateLegacyAppSettings', () => {
  it('maps the legacy colour and the legacy sidebar side', () => {
    expect(
      migrateLegacyAppSettings({ theme: { color: 'violet' }, sidebar: { side: 'right' } }),
    ).toEqual({
      themeColor: 'violet',
      direction: 'rtl',
    });

    expect(migrateLegacyAppSettings({ sidebar: { side: 'left' } })).toEqual({
      themeColor: 'default',
      direction: 'ltr',
    });
  });

  it('drops legacy values the shell no longer supports', () => {
    const migrated = migrateLegacyAppSettings({
      theme: { color: 'blue', type: 'scaled' },
      sidebar: { variant: 'inset', collapsible: 'icon' },
    });

    expect(migrated).toEqual({ themeColor: 'blue', direction: 'ltr' });
  });

  it('carries nothing when the only legacy values are unsupported ones', () => {
    // Khong co truong nao doc duoc: khong tao ra mot "cuoc migration rong" ma
    // caller lai phai ghi cookie. Ket qua nguoi dung thay van la mac dinh, vi
    // `parseAppShellPreferences(undefined)` da cho dung mac dinh do.
    expect(migrateLegacyAppSettings({ theme: { color: 'aubergine' } })).toBeUndefined();
    expect(migrateLegacyAppSettings({ theme: { color: 'amber' } })).toBeUndefined();
  });

  it('fills the unsupported half from defaults when the other half is readable', () => {
    expect(
      migrateLegacyAppSettings({ theme: { color: 'amber' }, sidebar: { side: 'right' } }),
    ).toEqual({ themeColor: 'default', direction: 'rtl' });
  });

  it('returns undefined when nothing is migratable', () => {
    expect(migrateLegacyAppSettings(undefined)).toBeUndefined();
    expect(migrateLegacyAppSettings({})).toBeUndefined();
    expect(migrateLegacyAppSettings({ theme: { type: 'mono' } })).toBeUndefined();
  });
});

describe('appShellHeadAttributes', () => {
  it('always puts the dark class on html, because the shell has one mode', () => {
    expect(
      appShellHeadAttributes({ themeColor: 'default', direction: 'ltr' }).htmlAttrs.class,
    ).toBe('dark');
    expect(appShellHeadAttributes({ themeColor: 'violet', direction: 'rtl' }).htmlAttrs.class).toBe(
      'dark',
    );
  });

  it('puts the colour class on body, never together with dark on html', () => {
    // `.color-x` phai la hau due cua `.dark` thi khoi `@variant dark` ben trong
    // moi class mau moi khop; dat chung tren <html> la mat nhanh mau toi.
    const violet = appShellHeadAttributes({ themeColor: 'violet', direction: 'ltr' });
    expect(violet.bodyAttrs.class).toBe('color-violet');
    expect(violet.htmlAttrs.class).not.toContain('color-');

    const fallback = appShellHeadAttributes({ themeColor: 'default', direction: 'ltr' });
    expect(fallback.bodyAttrs.class).toBeUndefined();
  });

  it('maps the default colour to no colour class', () => {
    expect(appShellColorClass('default')).toBe('');
    expect(appShellColorClass('green')).toBe('color-green');
  });

  it('reports direction independently of anything sidebar-related', () => {
    expect(appShellHeadAttributes({ themeColor: 'default', direction: 'rtl' }).htmlAttrs.dir).toBe(
      'rtl',
    );
    expect(appShellHeadAttributes({ themeColor: 'teal', direction: 'ltr' }).htmlAttrs.dir).toBe(
      'ltr',
    );
  });
});

/**
 * Nội dung CSS thật của library, lấy qua `?raw` của Vite chứ không qua
 * `node:fs`. Lý do: trong môi trường jsdom của Vitest `import.meta.url` không
 * còn là URL `file:` nên `fileURLToPath` ném "The URL must be of scheme file",
 * còn `process.cwd()` thì phụ thuộc chỗ gọi. `?raw` đọc file lúc transform, nên
 * test khẳng định đúng trên file đã ship.
 */
const css = appShellCss;

describe('theme colour list against the shipped stylesheet', () => {
  const classesInCss = new Set(
    [...css.matchAll(/^\.color-([a-z]+)\s*\{/gmu)].map((match) => match[1]),
  );

  it('finds the colour classes at all, so the assertions below cannot pass vacuously', () => {
    expect(classesInCss.size).toBeGreaterThanOrEqual(8);
  });

  it('gives every selectable colour a CSS counterpart', () => {
    const missing = APP_SHELL_THEME_COLORS.filter(
      (color) => color.name !== 'default' && !classesInCss.has(color.name),
    ).map((color) => color.name);

    expect(missing).toEqual([]);
  });

  it('keeps the two source-only palettes, which no picker offers', () => {
    // Chung co that trong CSS nguon (va duoc giu nguyen), nhung khong nam trong
    // danh sach chon — dieu nguoc lai moi la loi: mot lua chon khong co CSS.
    expect(classesInCss.has('amber')).toBe(true);
    expect(classesInCss.has('purple')).toBe(true);

    // So tren `string`: kieu `AppShellThemeColor` da loai hai ten nay, nen so
    // truc tiep voi chung la so voi mot gia tri khong the ton tai — dung y do
    // phai doc tu du lieu runtime chu khong tu kieu.
    const selectableNames: readonly string[] = APP_SHELL_THEME_COLORS.map((color) => color.name);
    expect(selectableNames).not.toContain('amber');
    expect(selectableNames).not.toContain('purple');
  });

  it('has no light-mode branch left in the stylesheet', () => {
    expect(css).not.toContain('.light');
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).toContain('color-scheme: dark');
  });

  it('does not keep the typography settings that were removed', () => {
    // Soi theo *selector*, khong theo chuoi: header cua chinh file CSS co nhac
    // ten hai class nay de giai thich ly do bo, va mot cau comment thi khong
    // lam gi ca.
    expect(css).not.toMatch(/^\.theme-(?:mono|scaled)\s*\{/mu);
  });

  it('declares no chart-library token, which belonged to a dropped dependency', () => {
    expect(css).not.toMatch(/^\s*--vis-/mu);
  });

  it('offers exactly the palette of the source, one swatch per colour', () => {
    // Nguon (`app/constants/themes.ts`) co dung 9 mau; bang chon o day phai
    // khop, vi them hay bot mot mau la lech giao dien so voi nguon.
    expect(APP_SHELL_THEME_COLORS).toHaveLength(9);

    const names: readonly string[] = APP_SHELL_THEME_COLORS.map((color) => color.name);
    const swatches: readonly string[] = APP_SHELL_THEME_COLORS.map((color) => color.swatch);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(swatches).size).toBe(swatches.length);

    // O mau phai la mot gia tri mau CSS that (nguon lay tu bang mau Tailwind),
    // khong phai chuoi trang tri dat cho.
    const notAColor = APP_SHELL_THEME_COLORS.filter(
      (color) => !color.swatch.startsWith('oklch('),
    ).map((color) => color.name);
    expect(notAColor).toEqual([]);
  });
});
