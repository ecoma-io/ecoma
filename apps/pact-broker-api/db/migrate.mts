/**
 * Hằng và helper dùng chung của migration `db-pact-broker`.
 *
 * Tính đường dẫn từ vị trí file chứ không từ `process.cwd()`: Nx đặt `cwd`
 * theo target, vitest chạy với `root` khác — `cwd` là thứ không giữ được giữa
 * hai đường chạy đó (xem `apps/account/db/migrate.mts` về cùng vấn đề).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Thư mục chứa file `.sql`, tính từ file này. */
export const MIGRATIONS_DIR = resolve(import.meta.dirname, 'migrations');

/** Tên database của service này; advisory lock lấy theo chính tên đó. */
export const PACT_BROKER_DATABASE = 'db-pact-broker';

/**
 * GUC truyền tên database cần assert provisioning (nếu sau này migration cần
 * biết tên thật của database khác); đặt sẵn như `ecoma.auth_database` của
 * account. Không file migration nào đọc nó hiện tại — giữ runner đối xứng
 * với pattern gốc và không cấm tương lai.
 */
export const AUTH_DATABASE_GUC = 'ecoma.auth_database';

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/** Thứ tự apply là thứ tự tên file (`0001_`, `0002_`, …), không phải mtime. */
export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .toSorted((a, b) => a.localeCompare(b, 'en'))
    .map((name) => ({ name, sql: readFileSync(resolve(dir, name), 'utf8') }));
}

/**
 * Thay placeholder `:"db_pact_broker_database"` bằng tên database thật.
 *
 * File migration là SQL thuần để người đọc và database thấy cùng một thứ;
 * thay ở tầng runner thay vì dùng biến `psql` — cùng lý do với
 * `renderMigration` của account.
 */
export function renderMigration(sql: string, database = PACT_BROKER_DATABASE): string {
  return sql.replaceAll(':"db_pact_broker_database"', `"${database.replaceAll('"', '""')}"`);
}
