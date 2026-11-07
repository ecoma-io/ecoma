/**
 * Hang va helper dung chung cua migration `db-remote-cache`.
 *
 * Tinh duong dan tu vi tri file chu khong tu `process.cwd()`: Nx dat `cwd`
 * theo target, vitest chay voi `root` khac — `cwd` la thu khong giu duoc giua
 * hai duong chay do (pattern `apps/staff-access/db/migrate.mts`).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Thu muc chua file `.sql`, tinh tu file nay. */
export const MIGRATIONS_DIR = resolve(import.meta.dirname, 'migrations');

/** Ten database cua service nay; advisory lock lay theo chinh ten do. */
export const REMOTE_CACHE_DATABASE = 'db-remote-cache';

/**
 * GUC truyen ten database can assert provisioning (neu sau nay migration can
 * biet ten that cua database khac); dat san nhu `ecoma.staff_access_database`
 * cua staff-access. Khong file migration nao doc no hien tai — giu runner
 * doi xung voi pattern goc va khong cam tuong lai.
 */
export const REMOTE_CACHE_DATABASE_GUC = 'ecoma.remote_cache_database';

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/** Thu tu apply la thu tu ten file (`0001_`, `0002_`, ...), khong phai mtime. */
export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .toSorted((a, b) => a.localeCompare(b, 'en'))
    .map((name) => ({ name, sql: readFileSync(resolve(dir, name), 'utf8') }));
}

/**
 * Thay placeholder `:"db_remote_cache_database"` bang ten database that.
 *
 * File migration la SQL thuan de nguoi doc va database thay cung mot thu;
 * thay o tang runner thay vi dung bien `psql` — cung ly do voi
 * `renderMigration` cua staff-access va pact-broker.
 */
export function renderMigration(sql: string, database = REMOTE_CACHE_DATABASE): string {
  return sql.replaceAll(':"db_remote_cache_database"', `"${database.replaceAll('"', '""')}"`);
}
