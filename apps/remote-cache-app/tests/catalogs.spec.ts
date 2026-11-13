import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import en from '../app/i18n/locales/en';
import vi from '../app/i18n/locales/vi';
import zhCN from '../app/i18n/locales/zh-CN';
import {
  REMOTE_CACHE_APP_LOCALE_DEFINITIONS,
  type RemoteCacheAppLocale,
} from '../app/i18n/locale-registry';

function flattenKeys(tree: unknown, prefix = ''): Set<string> {
  if (typeof tree !== 'object' || tree === null) {
    return new Set([prefix]);
  }
  const keys = new Set<string>();
  for (const [name, value] of Object.entries(tree)) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    if (typeof value === 'object' && value !== null) {
      for (const nested of flattenKeys(value, path)) {
        keys.add(nested);
      }
    } else {
      keys.add(path);
    }
  }
  return keys;
}

function placeholders(tree: unknown, prefix = ''): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  if (typeof tree !== 'object' || tree === null) {
    return found;
  }
  for (const [name, value] of Object.entries(tree)) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    if (typeof value === 'object' && value !== null) {
      for (const [key, names] of placeholders(value, path)) {
        found.set(key, names);
      }
    } else if (typeof value === 'string') {
      const names = new Set([...value.matchAll(/\{(\w+)\}/gu)].map((match) => match[1] as string));
      if (names.size > 0) {
        found.set(path, names);
      }
    }
  }
  return found;
}

const CATALOGS: Readonly<Record<RemoteCacheAppLocale, unknown>> = {
  en,
  vi,
  'zh-CN': zhCN,
};

describe('remote-cache-app catalog parity', () => {
  const enKeys = flattenKeys(en);

  it('declares exactly the three supported locales in the registry', () => {
    expect(REMOTE_CACHE_APP_LOCALE_DEFINITIONS.map((definition) => definition.code)).toEqual([
      'en',
      'vi',
      'zh-CN',
    ]);
  });

  it('declares the text direction of every locale in the registry', () => {
    // `dir` là thuộc tính của ngôn ngữ (issue #213), khai ngay tại registry —
    // cùng nguồn với `<html lang>`. Cả ba locale hiện tại đều `'ltr'`; một locale
    // RTL (`ar`, `he`, `fa`…) thêm sau này phải khai `'rtl'` ngay tại đây, và
    // không có setting người dùng nào đổi được giá trị này.
    expect(REMOTE_CACHE_APP_LOCALE_DEFINITIONS.map((definition) => definition.dir)).toEqual([
      'ltr',
      'ltr',
      'ltr',
    ]);
  });

  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    it(`${locale} has exactly the same keys as en (both directions)`, () => {
      const keys = flattenKeys(catalog);
      expect([...keys].filter((key) => !enKeys.has(key)).toSorted()).toEqual([]);
      expect([...enKeys].filter((key) => !keys.has(key)).toSorted()).toEqual([]);
    });
  }

  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    it(`${locale} interpolates the same placeholder names as en`, () => {
      const enPlaceholders = placeholders(en);
      const placeholdersHere = placeholders(catalog);
      for (const [key, names] of enPlaceholders) {
        const namesHere = [...(placeholdersHere.get(key) ?? [])].toSorted();
        expect(namesHere).toEqual([...names].toSorted());
      }
    });
  }

  it('has no empty or whitespace-only string in any catalog', () => {
    for (const [_locale, catalog] of Object.entries(CATALOGS)) {
      const empty: string[] = [];
      const walk = (tree: unknown, prefix: string): void => {
        if (typeof tree === 'string') {
          if (tree.trim() === '') {
            empty.push(prefix);
          }
          return;
        }
        if (typeof tree !== 'object' || tree === null) {
          return;
        }
        for (const [name, value] of Object.entries(tree)) {
          walk(value, prefix === '' ? name : `${prefix}.${name}`);
        }
      };
      walk(catalog, '');
      expect(empty).toEqual([]);
    }
  });
});

/**
 * Phép so sánh ba catalog ở trên chỉ kiểm tra ba catalog **khớp nhau**. Nó mù với một key
 * mà cả ba cùng thiếu: `t('overview.title')` trong page vẫn chạy, vue-i18n
 * fallback về chính chuỗi key, và cả ba test parity vẫn xanh trong khi giao diện
 * hiển thị `overview.title`. Đó là lỗi thật đã lọt qua CI một lần ở app khác.
 *
 * Khối này đóng lỗ đó: quét source của app và bắt mọi key tĩnh mà app gọi phải
 * tồn tại trong cả ba catalog. Key dựng động (`t(\`...\`)`) không thấy được bằng
 * regex; đây là chốt chặn cho phần còn lại, không phải chứng minh đầy đủ.
 */
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

// `\bt` chỉ khớp khi `t` đứng riêng, nên không nuốt `format(` hay `split(`.
const TRANSLATION_CALL_RE = /(?:\bi18n\s*\.\s*t|\$t|\btranslate|\bt)\s*\(\s*['"]([\w.]+)['"]/gu;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      // `app/i18n` là chính catalog, không phải nơi tiêu thụ key.
      if (entry !== 'i18n') {
        files.push(...sourceFiles(path));
      }
    } else if (/\.(?:vue|ts)$/u.test(entry) && !/\.(?:spec|test)\.ts$/u.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

function keysCalledInApp(): Set<string> {
  const keys = new Set<string>();
  for (const file of sourceFiles(APP_DIR)) {
    for (const match of readFileSync(file, 'utf8').matchAll(TRANSLATION_CALL_RE)) {
      keys.add(match[1] as string);
    }
  }
  return keys;
}

describe('remote-cache-app catalog coverage of app usage', () => {
  const usedKeys = keysCalledInApp();

  it('finds the keys the app actually calls', () => {
    // Chống test rỗng: regex hỏng thì `usedKeys` rỗng và mọi khẳng định dưới
    // đây tự động xanh mà không kiểm gì. Sàn thấp hơn số key tĩnh hiện tại
    // một khoảng đủ để regex hỏng cục bộ vẫn đỏ — số key giảm có chủ đích khi
    // bảng settings (8 key) được thay bằng color mode (4 key), issue #213. Ba
    // key dưới đây đến từ ba bề mặt khác nhau của app — page, nav của shell,
    // và language selector.
    expect(usedKeys.size).toBeGreaterThanOrEqual(16);
    expect([...usedKeys]).toContain('overview.title');
    expect([...usedKeys]).toContain('nav.overview');
    expect([...usedKeys]).toContain('shell.language.label');
  });

  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    it(`${locale} defines every key the app calls`, () => {
      const declared = flattenKeys(catalog);
      expect([...usedKeys].filter((key) => !declared.has(key)).toSorted()).toEqual([]);
    });
  }
});
