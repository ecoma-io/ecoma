/**
 * Hang va helper dung chung cua migration `db-staff-access`.
 *
 * Tinh duong dan tu vi tri file chu khong tu `process.cwd()`: Nx dat `cwd`
 * theo target, vitest chay voi `root` khac — `cwd` la thu khong giu duoc giua
 * hai duong chay do (xem `apps/account/db/migrate.mts` ve cung van de).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Thu muc chua file `.sql`, tinh tu file nay. */
export const MIGRATIONS_DIR = resolve(import.meta.dirname, 'migrations');

/** Ten database cua service nay; advisory lock lay theo chinh ten do. */
export const STAFF_ACCESS_DATABASE = 'db-staff-access';

/**
 * GUC truyen ten database can assert provisioning (neu sau nay migration can
 * biet ten that cua database khac); dat san nhu `ecoma.auth_database` cua
 * account va `ecoma.pact_broker_database` cua pact-broker. Khong file
 * migration nao doc no hien tai — giu runner doi xung voi pattern goc va
 * khong cam tuong lai.
 */
export const STAFF_ACCESS_DATABASE_GUC = 'ecoma.staff_access_database';

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
 * Thay placeholder `:"db_staff_access_database"` bang ten database that.
 *
 * File migration la SQL thuan de nguoi doc va database thay cung mot thu;
 * thay o tang runner thay vi dung bien `psql` — cung ly do voi
 * `renderMigration` cua account va pact-broker.
 */
export function renderMigration(sql: string, database = STAFF_ACCESS_DATABASE): string {
  return sql.replaceAll(':"db_staff_access_database"', `"${database.replaceAll('"', '""')}"`);
}
