/**
 * Test cho quy ước tên file migration của `db-backoffice` (follow-up 4 của
 * issue #106).
 *
 * ## Gap mà test này đóng
 *
 * Thứ tự apply migration là thứ tự **tên file** (`localeCompare`), nên tiền tố
 * số phải có **cùng độ dài** để so sánh lexicographic khớp thứ tự số. Một file
 * `2_x.sql` (thiếu zero) sẽ sort **sau** `0003_` — nó chạy ở sai vị trí trong
 * lịch sử migration, và không có tín hiệu nào báo.
 *
 * Vì vậy `listMigrations` phải **ném lỗi** khi thấy tên không khớp quy ước,
 * trước khi bất kỳ DDL nào được apply.
 *
 * ⚠️ Test này **không** cần Docker: nó gọi `listMigrations` trên một thư mục
 * tạm, không chạm database. Nó vẫn nằm trong `tests/databases/` và chạy dưới
 * `test-integration`, nên lần chạy của nó vẫn trả phí một probe Docker từ
 * `globalSetup` —probe hỏng là toàn bộ lần chạy đỏ, đúng chính sách fail-loud
 * dù suite này không đụng DB.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listMigrations, MIGRATION_FILE_NAME_PATTERN } from '../../db/migrate.mts';

const temporaryDirectories: string[] = [];

/** Tạo thư mục tạm chứa các file migration được cho trước. */
function migrationsDir(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ecoma-backoffice-migrations-'));
  temporaryDirectories.push(dir);
  for (const name of files) {
    writeFileSync(join(dir, name), 'SELECT 1;\n', 'utf8');
  }
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('migration file naming convention', () => {
  it('accepts four-digit prefixed names and keeps them in numeric order', () => {
    const dir = migrationsDir(
      '0010_tenth.sql',
      '0002_second.sql',
      '0001_first.sql',
      '0009_ninth.sql',
    );

    expect(listMigrations(dir).map((migration) => migration.name)).toEqual([
      '0001_first.sql',
      '0002_second.sql',
      '0009_ninth.sql',
      '0010_tenth.sql',
    ]);
  });

  it('rejects a name whose numeric prefix is not padded to four digits', () => {
    // Mutation evidence: bỏ assertion regex trong `listMigrations` thì test này
    // đỏ — file `2_bad.sql` (thiếu zero) được sort **sau** `0003_` mà không
    // có tín hiệu nào, tức nó chạy ở sai vị trí trong lịch sử migration.
    const dir = migrationsDir('0001_first.sql', '2_bad.sql');

    expect(() => listMigrations(dir)).toThrow(/2_bad\.sql/u);
    expect(() => listMigrations(dir)).toThrow(/migration file name must match/u);
  });

  it('rejects a name with no numeric prefix at all', () => {
    const dir = migrationsDir('0001_first.sql', 'notes.sql');

    expect(() => listMigrations(dir)).toThrow(/notes\.sql/u);
  });

  it('ignores files that are not migrations', () => {
    const dir = migrationsDir('0001_first.sql', 'README.md');

    expect(listMigrations(dir).map((migration) => migration.name)).toEqual(['0001_first.sql']);
  });

  it('matches the shipped migration files', () => {
    // Guard: quy ước phải khớp **file đang có**, không chỉ file giả trong test.
    const shipped = listMigrations();

    expect(shipped.length).toBeGreaterThan(0);
    for (const migration of shipped) {
      expect(migration.name).toMatch(MIGRATION_FILE_NAME_PATTERN);
    }
  });
});
