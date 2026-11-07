/**
 * Kiểm parity của ba catalog message.
 *
 * ⚠️ Đây là **test chống trôi cây key**, và nó cần hai chiều:
 *
 * - thiếu ở `vi`/`zh-CN` → bắt được nhờ kiểu `AccountMessages` (`MessageTree` giữ
 *   cấu trúc key của `en`), nhưng kiểu chỉ bắt được lỗi lúc **compile**, và chỉ
 *   khi ai đó gán `const messages: AccountMessages`. Test này bắt được lúc **chạy**,
 *   kể cả khi catalog được import bằng đường khác;
 * - **thừa** ở `vi`/`zh-CN` → kiểu bắt không được (xem `messages.ts`), và một key
 *   lạ ở đây là một key mà `en` không có, nên `t()` sẽ rơi về `fallbackLocale` và
 *   render tiếng Anh ở giữa một catalog tiếng Việt.
 *
 * Vì vậy phần đối chiếu chạy trên **cả hai chiều** cho cả ba catalog, và test
 * cuối cùng cố tình làm hỏng một catalog để chứng minh bộ so sánh này thật sự
 * bắt được lệch — một parity test luôn xanh là một parity test chưa từng chạy.
 */
import { describe, expect, it } from 'vitest';

import en from './en';
import vi from './vi';
import zhCN from './zh-CN';
import { ACCOUNT_LOCALE_DEFINITIONS, type AccountLocale } from '../locale-registry';

/** Cây key phẳng, phân biệt chữ hoa — `nav.x` khác `nav.X`. */
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

/** Key chứa placeholder — dùng để kiểm hai catalog nội suy cùng tên biến. */
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

const CATALOGS: Readonly<Record<AccountLocale, unknown>> = {
  en,
  vi,
  'zh-CN': zhCN,
};

describe('catalog parity', () => {
  const enKeys = flattenKeys(en);

  it('declares exactly the three supported locales in the registry', () => {
    expect(ACCOUNT_LOCALE_DEFINITIONS.map((definition) => definition.code)).toEqual([
      'en',
      'vi',
      'zh-CN',
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
        expect([...(placeholdersHere.get(key) ?? [])].toSorted(), `key ${key}`).toEqual(
          [...names].toSorted(),
        );
      }
    });
  }

  it('has no empty or whitespace-only string in any catalog', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
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
      expect(empty, `${locale} has empty messages`).toEqual([]);
    }
  });

  /**
   * Mutation check: bỏ một key khỏi `en`, rồi chạy lại đúng phép so sánh trên. Nếu
   * bộ so sánh này không đỏ, thì các `it` ở trên đang xanh vì lý do sai — và một
   * parity test xanh sai là tệ hơn không có test.
   */
  it('detects a key missing from a translated catalog', () => {
    const broken = { ...(vi as { common: Record<string, string> }) };
    broken.common = { ...broken.common };
    delete broken.common.retry;

    const keys = flattenKeys(broken);
    const missing = [...enKeys].filter((key) => !keys.has(key)).toSorted();
    expect(missing).toContain('common.retry');
  });

  it('detects a key that exists only in a translated catalog', () => {
    const broken = {
      ...(zhCN as { common: Record<string, string> }),
      common: { ...(zhCN as { common: Record<string, string> }).common, mysteryKey: '???' },
    };
    const keys = flattenKeys(broken);
    const extra = [...keys].filter((key) => !enKeys.has(key)).toSorted();
    expect(extra).toContain('common.mysteryKey');
  });
});
