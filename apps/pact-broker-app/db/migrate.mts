import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Metadata migration của `pact-broker-app` — cùng đường code `db/migrate.mts`
 * của `backoffice` (deliberate duplication giữa hai deploy unit — module
 * boundary cấm import chéo, 06-testing.md §6 / 05-code-architecture.md §7).
 *
 * Tên database của service này trong provisioning; không hard-code trong SQL.
 */
export const PACT_BROKER_APP_DATABASE = 'db-pact-broker-app';

/**
 * Khóa advisory chặn hai migration chạy song song — runner LẤY khóa bằng
 * `hashtext(PACT_BROKER_APP_DATABASE)` phía server để khóa đổi theo tên
 * database. Hằng tồn tại cho test assert runner khớp đúng tên khai báo.
 */
export const MIGRATION_LOCK_KEY = 12_884_501n;

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/** Thư mục migrations — resolve từ vị trí file, không từ `process.cwd()`. */
export const MIGRATIONS_DIR = resolve(import.meta.dirname, 'migrations');

/**
 * Tên file migration phải khớp `NNNN_<slug>.sql` — 4 chữ số rồi gạch dưới.
 * Thứ tự apply là thứ tự tên file (localeCompare) nên tiền tố phải cùng độ
 * dài; file vi phạm là ném lỗi TRƯỚC khi DDL nào chạy.
 */
export const MIGRATION_FILE_NAME_PATTERN = /^\d{4}_.+\.sql$/u;

export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const names = readdirSync(dir).filter((entry) => entry.endsWith('.sql'));

  const invalid = names.filter((name) => !MIGRATION_FILE_NAME_PATTERN.test(name));
  if (invalid.length > 0) {
    throw new Error(
      `migration file name must match ${String(MIGRATION_FILE_NAME_PATTERN)} ` +
        `(4-digit prefix + '_' + slug + '.sql'); offending file(s): ${invalid.toSorted().join(', ')}`,
    );
  }

  return names
    .toSorted((a, b) => a.localeCompare(b, 'en'))
    .map((name) => ({ name, sql: readFileSync(resolve(dir, name), 'utf8') }));
}

/** SQL thuần, không placeholder — giữ cho runner và harness một đường code. */
export function renderMigration(sql: string): string {
  return sql;
}
