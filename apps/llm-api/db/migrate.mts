/**
 * Hang va helper dung chung cho migration runner `db/apply.mts` cua
 * `db-llm-gateway`, `db-llm-tenant`, `db-llm-marketplace` (llm-api, slice db-migration cua Issue #22).
 *
 * Tinh duong dan tu vi tri file chu khong tu `process.cwd()`: Nx dat `cwd`
 * theo target, vitest chay voi `root` khac — `cwd` la thu khong giu duoc giua
 * hai duong chay do (pattern `apps/remote-cache-api/db/migrate.mts`).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Target chon database dich cua runner; moi target map toi mot DB va mot thu muc migration. */
export type MigrationTarget = 'gateway' | 'tenant' | 'marketplace';

/** Bien moi truong bat buoc cho runner CLI: chuoi ket noi PostgreSQL cua **migrator** cua DB dich. */
export const MIGRATOR_DATABASE_URL_ENV = 'DATABASE_URL';

/** Map target -> (ten database, thu muc file .sql), tinh tu file nay. */
export const MIGRATION_TARGETS: ReadonlyMap<
  MigrationTarget,
  { readonly database: string; readonly migrationsDir: string }
> = new Map([
  [
    'gateway',
    {
      database: 'db-llm-gateway',
      migrationsDir: resolve(import.meta.dirname, 'migrations', 'gateway'),
    },
  ],
  [
    'tenant',
    {
      database: 'db-llm-tenant',
      migrationsDir: resolve(import.meta.dirname, 'migrations', 'tenant'),
    },
  ],
  [
    'marketplace',
    {
      database: 'db-llm-marketplace',
      migrationsDir: resolve(import.meta.dirname, 'migrations', 'marketplace'),
    },
  ],
]);

/** Ten database dich cua target; advisory lock lay theo chinh ten do. */
export function databaseFor(target: MigrationTarget): string {
  const entry = MIGRATION_TARGETS.get(target);
  if (!entry)
    throw new Error(
      `Unknown migration target "${target}"; expected one of ${[...MIGRATION_TARGETS.keys()].join(', ')}.`,
    );
  return entry.database;
}

/** Thu muc chua file `.sql` cua target, tinh tu file nay. */
export function migrationsDirFor(target: MigrationTarget): string {
  const entry = MIGRATION_TARGETS.get(target);
  if (!entry)
    throw new Error(
      `Unknown migration target "${target}"; expected one of ${[...MIGRATION_TARGETS.keys()].join(', ')}.`,
    );
  return entry.migrationsDir;
}

/** Thu tu apply la thu tu ten file (`0001_`, `0002_`, ...), khong phai mtime. */
export function listMigrations(dir: string): { readonly name: string; readonly sql: string }[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .toSorted((a, b) => a.localeCompare(b, 'en'))
    .map((name) => ({ name, sql: readFileSync(resolve(dir, name), 'utf8') }));
}
