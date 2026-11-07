/**
 * Ghim key i18n cho **catalog permission thật** — issue #107 (P4).
 *
 * ## Vấn đề
 *
 * `apps/backoffice/app/i18n/locales/*.ts` khai `permissions.items` theo
 * `<domain>.<action>` hai tầng. Trang Permissions render mô tả bằng
 * `i18n.t(\`permissions.items.${domain}.${action}\`)` (`app/pages/permissions.vue`).
 * Nhưng trước khi PR này, catalog i18n chỉ có key của **fixture prototype**
 * (`delivery.redrive`, `mail.read`, `mail.send`, `staff.read`, `role.assign`,
 * `audit.read`), còn catalog **thật** — seed ở
 * `db/migrations/0003_permission_catalog_seed.sql` — có 3 id `staff.read`,
 * `role.read`, `permission.read`. Hai id sau **không có key** ở cả ba locale ⇒
 * khi adapter thật thay fixture, 2/3 hàng trang Permissions hiện chuỗi rỗng
 * hoặc lộ tên key.
 *
 * ## Vì sao đọc id từ file migration thay vì chép tay
 *
 * Danh sách id phải **bám theo catalog**, không bám theo test: một danh sách
 * chép tay trong test là một nguồn sự thật thứ hai, và nó sẽ trôi khỏi catalog
 * đúng lúc catalog đổi — tức là lúc test vẫn xanh. Vì vậy test này đọc **mọi**
 * file migration trong `db/migrations/` và suy ra id từ những câu `INSERT` tìm
 * thấy. Đọc cả thư mục chứ không chỉ `0003` là để một seed migration mới thêm
 * permission vào catalog thì test tự phủ, thay vì lại phải sửa test.
 *
 * ⚠️ Parser phải **fail** khi không tìm thấy câu `INSERT` nào — nếu parse ra danh
 * sách rỗng thì mọi khẳng định bên dưới tự động xanh mà không kiểm gì
 * ("vacuous green"). Cùng lý do, mỗi id phải bằng `domain.action` đúng quy
 * ước ADR-0010: nếu shape id đổi, key i18n phải đổi theo, và test phải đỏ
 * chứ không âm thầm tra key cũ.
 *
 * ## Phạm vi
 *
 * Phép kiểm này phủ **id của catalog thật**. Key của fixture prototype được
 * phủ ở `prototype-fixture.spec.ts` của `app/backoffice-data/` (id trong fixture có mô tả ở `en`) và
 * `catalogs.spec.ts` của `app/i18n/` (ba catalog cùng tập key). Ở đây thêm một điều mà
 * hai file kia không nói trực tiếp: **mọi** id của fixture phải dịch được ở
 * **mọi** locale, không chỉ ở `en` — vì fixture vẫn là nguồn dữ liệu của UI ở
 * giai đoạn hiện tại, và xoá một key của nó là làm UI prototype mất nhãn.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROTOTYPE_DATA } from '../backoffice-data/prototype-fixture';
import { backofficeMessages } from './catalogs';
import { BACKOFFICE_LOCALE_DEFINITIONS } from './locale-registry';

/** Thư mục migration — nơi duy nhất một permission được coi là có thật. */
const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../db/migrations');

/** Một permission đọc được từ câu `INSERT` của migration seed. */
type SeededPermission = {
  readonly id: string;
  readonly domain: string;
  readonly action: string;
};

/**
 * Câu `INSERT` vào catalog permission, kèm phần `VALUES` của nó.
 *
 * Cắt tại `ON CONFLICT` / `;` / `RETURNING` để phần còn lại của file không lẫn
 * vào danh sách tuple.
 */
const PERMISSION_INSERT_RE =
  /INSERT\s+INTO\s+backoffice\.permissions\s*\(([^)]*)\)([\s\S]*?)(?=ON\s+CONFLICT|;|RETURNING)/giu;

/** Một tuple giá trị của câu `INSERT` — `(id, domain, action, status)`.
 *  Chỉ khớp tuple bắt đầu bằng một chuỗi trích dẫn, để bỏ qua các cặp ngoặc
 *  không phải giá trị (ví dụ `(id, domain, action, status)` trong `AS v(...)`).
 */
const VALUE_TUPLE_RE = /\(\s*'[^']*'[^)]*\)/gu;

/**
 * Parse permission đã seed từ nội dung một file migration.
 *
 * Trả về mảng rỗng khi file **không** có câu `INSERT` nào — phần lớn các
 * migration không seed permission, nên đó là tình huống bình thường.
 *
 * @throws khi file có câu `INSERT` nhưng parse ra **không** tuple nào — xem JSDoc
 *   module về "vacuous green": một câu `INSERT` không đọc được là catalog không
 *   đọc được, và test phải nói thay vì im lặng bỏ qua.
 */
function parseSeededPermissions(sql: string, fileName: string): SeededPermission[] {
  const permissions: SeededPermission[] = [];

  for (const statement of sql.matchAll(PERMISSION_INSERT_RE)) {
    // Tên cột đọc từ câu `INSERT` chứ không giả định thứ tự: đổi thứ tự cột là
    // thay đổi câu SQL, và test phải theo câu SQL chứ không theo một giả định.
    const columns = (statement[1] ?? '').split(',').map((column) => column.trim().toLowerCase());

    let rowsInStatement = 0;
    for (const tuple of (statement[2] ?? '').matchAll(VALUE_TUPLE_RE)) {
      const inner = tuple[0].slice(1, -1);
      const values = inner.split(',').map((value) => value.trim().replace(/^'(.*)'$/u, '$1'));
      const row = new Map<string, string>();
      columns.forEach((column, index) => {
        row.set(column, values[index] ?? '');
      });

      permissions.push({
        id: row.get('id') ?? '',
        domain: row.get('domain') ?? '',
        action: row.get('action') ?? '',
      });
      rowsInStatement += 1;
    }

    if (rowsInStatement === 0) {
      throw new Error(
        `no permission row could be parsed from the "INSERT INTO backoffice.permissions" statement in ${fileName} — the seeded catalog is unreadable, so this test would check nothing`,
      );
    }
  }

  return permissions;
}

/**
 * Mọi permission đã seed, đọc từ **mọi** file migration.
 *
 * Thứ tự file là thứ tự tên file (`0001_`, `0002_`, …) — cùng quy ước với
 * `db/migrate.mts`, nên danh sách id ổn định giữa các lần chạy.
 *
 * ⚠️ Regex có cờ `g` nên `lastIndex` của nó là **state**: `.test()`/`.exec()`
 * tuần tự trên cùng một object regex làm lần sau bắt đầu từ vị trí của lần
 * trước, và `matchAll` **copy** `lastIndex` của regex gốc vào bản clone của nó.
 * Vì vậy ở đây chỉ dùng `matchAll` — không `test`/`exec` trực tiếp trên
 * `PERMISSION_INSERT_RE` — để mỗi file được parse từ đầu.
 */
function readSeededPermissions(): SeededPermission[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith('.sql'))
    .toSorted((a, b) => a.localeCompare(b, 'en'));

  const permissions: SeededPermission[] = [];
  for (const file of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    permissions.push(...parseSeededPermissions(sql, file));
  }

  return permissions;
}

/** Đọc một key phân giải dấu chấm trong cây catalog. */
function getNestedKey(tree: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, segment) => {
    if (typeof node !== 'object' || node === null) {
      return undefined;
    }
    return (node as Record<string, unknown>)[segment];
  }, tree);
}

/** Key i18n của một permission: `<domain>.<action>` → path hai tầng. */
function descriptionKey(domain: string, action: string): string {
  return `permissions.items.${domain}.${action}`;
}

const SEEDED_PERMISSIONS = readSeededPermissions();

const LOCALES = BACKOFFICE_LOCALE_DEFINITIONS.map((definition) => definition.code);

describe('permission catalog i18n coverage', () => {
  it('reads the seeded permission ids from the catalog migrations', () => {
    // Chống "vacuous green": parser trả rỗng thì các test dưới tự xanh mà
    // không kiểm gì. Dùng `> 0` chứ không phải một con số cụ thể — số lượng id
    // là của migration, không phải của test này.
    expect(SEEDED_PERMISSIONS.length).toBeGreaterThan(0);
  });

  it('reads permission ids shaped as <domain>.<action>', () => {
    // Quy ước ADR-0010: `id` bằng đúng chuỗi `<domain>.<action>`. Key i18n dựng
    // từ `domain` + `action`, nên lệch ở đây là lệch ở key — và test phải đỏ.
    for (const permission of SEEDED_PERMISSIONS) {
      expect(permission.id).toBe(`${permission.domain}.${permission.action}`);
    }
  });

  for (const locale of LOCALES) {
    it(`defines an i18n description for every seeded permission in ${locale}`, () => {
      const catalog = backofficeMessages[locale];
      const missing: string[] = [];

      for (const permission of SEEDED_PERMISSIONS) {
        const key = descriptionKey(permission.domain, permission.action);
        const description = getNestedKey(catalog, key);

        if (typeof description !== 'string' || description.trim() === '') {
          missing.push(
            `locale "${locale}" has no description for permission "${permission.id}" (expected key "${key}")`,
          );
        }
      }

      expect(missing).toEqual([]);
    });
  }

  it('keeps a description for every prototype fixture permission in every locale', () => {
    // Fixture prototype vẫn là nguồn dữ liệu của UI ở giai đoạn hiện tại: xoá một
    // key của nó là làm UI prototype mất nhãn, dù id đó không có trong catalog
    // thật. `prototype-fixture.spec.ts` của `app/backoffice-data/` chỉ kiểm ở `en`, nên locale còn lại
    // cần một chốt chặn riêng.
    const missing: string[] = [];

    for (const locale of LOCALES) {
      const catalog = backofficeMessages[locale];
      for (const permission of PROTOTYPE_DATA.permissions) {
        const key = descriptionKey(permission.domain, permission.action);
        const description = getNestedKey(catalog, key);

        if (typeof description !== 'string' || description.trim() === '') {
          missing.push(
            `locale "${locale}" has no description for fixture permission "${permission.id}" (expected key "${key}")`,
          );
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
