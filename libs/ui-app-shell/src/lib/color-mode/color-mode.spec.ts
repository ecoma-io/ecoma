import { describe, expect, it } from 'vitest';
import appShellCss from '../../styles/app-shell.css?raw';
import {
  APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT,
  APP_SHELL_COLOR_MODE_COOKIE,
  DEFAULT_APP_SHELL_COLOR_MODE,
  appShellApplyColorMode,
  appShellColorModeIsDark,
  isAppShellColorMode,
  parseAppShellColorMode,
} from './index';

/**
 * Hợp đồng của color mode: allowlist ba giá trị, một quy tắc quyết định `dark`
 * dùng chung mọi đường, và script bootstrap phải tự sống sót khi cookie hỏng,
 * `matchMedia` vắng mặt hay `prefers-color-scheme` đổi giữa chừng.
 */
describe('parseAppShellColorMode', () => {
  it('falls back to system for anything that is not a stored mode', () => {
    expect(parseAppShellColorMode(undefined)).toBe('system');
    expect(parseAppShellColorMode(null)).toBe('system');
    expect(parseAppShellColorMode('nonsense')).toBe('system');
    expect(parseAppShellColorMode(42)).toBe('system');
  });

  it('keeps valid persisted values, including an explicit light choice', () => {
    expect(parseAppShellColorMode('light')).toBe('light');
    expect(parseAppShellColorMode('dark')).toBe('dark');
    expect(parseAppShellColorMode('system')).toBe('system');
  });

  it('accepts only the three canonical modes', () => {
    expect(isAppShellColorMode('auto')).toBe(false);
    expect(isAppShellColorMode('DARK')).toBe(false);
    expect(isAppShellColorMode('')).toBe(false);
  });

  it('defaults to system, which follows the operating system', () => {
    expect(DEFAULT_APP_SHELL_COLOR_MODE).toBe('system');
  });
});

describe('appShellColorModeIsDark', () => {
  it('follows explicit modes without consulting the system', () => {
    expect(appShellColorModeIsDark('dark', false)).toBe(true);
    expect(appShellColorModeIsDark('light', true)).toBe(false);
  });

  it('defers to the system only in system mode', () => {
    expect(appShellColorModeIsDark('system', true)).toBe(true);
    expect(appShellColorModeIsDark('system', false)).toBe(false);
  });
});

describe('appShellApplyColorMode', () => {
  it('toggles the dark class on the document element', () => {
    document.documentElement.classList.remove('dark');
    appShellApplyColorMode('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    appShellApplyColorMode('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    appShellApplyColorMode('system');
    // jsdom không có matchMedia: "không biết" hệ điều hành → sáng, khớp CSS
    // mặc định khi không có class nào.
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT', () => {
  it('reads the canonical cookie name, so script and cookie cannot drift', () => {
    expect(APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT).toContain(`'${APP_SHELL_COLOR_MODE_COOKIE}'`);
  });

  it('resolves dark and system modes before paint', () => {
    expect(APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT).toContain('prefers-color-scheme: dark');
    expect(APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT).toContain('classList.toggle("dark"');
    // Giá trị lạ phải rơi về "system" — không bao giờ mặc định tối.
    expect(APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT).toContain(':"system"');
  });

  it('stays ES5-safe: no arrow functions, optional chaining or template literals', () => {
    expect(APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT).not.toMatch(/=>/u);
    expect(APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT).not.toMatch(/\?\./u);
    expect(APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT).not.toMatch(/`/u);
  });

  it('only follows live OS changes while the mode is system', () => {
    expect(APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT).toContain('"change"');
    expect(APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT).toContain('==="system"');
  });
});

describe('app-shell.css color contract', () => {
  it('declares light tokens on :root and dark tokens under .dark', () => {
    // :root bây giờ là nhánh sáng (color-scheme: light); mọi giá trị tối phải
    // nằm trong .dark — một token nào lạc ra ngoài là một chế độ bị bỏ quên.
    expect(appShellCss).toMatch(/:root\s*\{\s*color-scheme:\s*light/u);
    expect(appShellCss).toMatch(/\.dark\s*\{\s*color-scheme:\s*dark/u);
  });

  it('keeps no per-colour palette behind — the picker is gone', () => {
    expect(appShellCss).not.toMatch(/^\.color-/mu);
  });

  it('keeps the token indirection the primitives rely on', () => {
    expect(appShellCss).toContain('--color-background: var(--background)');
  });
});
