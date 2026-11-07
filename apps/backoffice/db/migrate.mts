import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Đường dẫn thư mục `apps/backoffice/db/migrations`.
 *
 * Tính từ vị trí file này chứ không từ `process.cwd()` — cùng lý do với
 * `apps/account/db/migrate.mts`: Nx đặt `cwd: apps/backoffice` cho target của
 * project, còn vitest chạy với root khác.
 */
export const MIGRATIONS_DIR = resolve(import.meta.dirname, 'migrations');

/** Tên database của service này trong provisioning; không hard-code trong SQL. */
export const BACKOFFICE_DATABASE = 'db-backoffice';

/**
 * Khóa advisory chặn hai migration chạy song song.
 *
 * ⚠️ Số được chọn theo chính tên database để hai service (account,
 * backoffice, ...) trên một PostgreSQL instance dùng chung không tranh cùng
 * một khóa (A21, §8: "Shared PostgreSQL ≠ shared write authority" — chung
 * instance ≠ chung khóa migration). Hash theo `hashtext` phía server thay vì
 * hard-code hash trong code: đổi tên database thì khóa đổi theo, và giá trị
 * cụ thể không mang ý nghĩa gì.
 *
 * ⚠️ Runner **không** dùng số này: nó lấy khóa bằng
 * `hashtext(BACKOFFICE_DATABASE)` phía server để khóa đổi theo tên database.
 * Hằng tồn tại cho test assert rằng khóa runner khớp đúng tên mà
 * {@link BACKOFFICE_DATABASE} khai báo — hai thứ phải là một, nếu không thì
 * `MIGRATION_LOCK_KEY` chỉ là một con số chết.
 */
export const MIGRATION_LOCK_KEY = 9_137_204n;

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/**
 * Tên file migration phải khớp `NNNN_<slug>.sql` — **4 chữ số** rồi gạch dưới.
 *
 * ⚠️ Vì sao 4 chữ số là bắt buộc chứ không phải "sở thích": thứ tự apply là
 * thứ tự **tên file** (`localeCompare`), nên tiền tố số phải có **cùng độ dài**
 * để so sánh lexicographic khớp thứ tự số. `0003_` < `0010_` đúng, nhưng
 * `2_x.sql` (thiếu zero) sort **sau** `0003_` — file đó sẽ chạy ở sai vị trí
 * trong lịch sử migration, và không có gì báo.
 *
 * Nên quy ước này được **khai báo và kiểm**, không chỉ ghi trong README:
 * `listMigrations` ném lỗi ngay khi thấy tên vi phạm, trước khi bất kỳ DDL nào
 * được apply — lỗi rõ ràng ("tên file này sai quy ước") hơn là một schema sai
 * không ai biết.
 */
export const MIGRATION_FILE_NAME_PATTERN = /^\d{4}_.+\.sql$/u;

/**
 * Thứ tự apply là thứ tự tên file (`0001_`, `0002_`, ...), không phải mtime.
 *
 * ⚠️ `localeCompare` chỉ đúng khi mọi tiền tố số có cùng độ dài — vì vậy mọi
 * tên file phải khớp {@link MIGRATION_FILE_NAME_PATTERN}; file không khớp thì
 * hàm ném lỗi thay vì sort sai.
 *
 * @throws Error nếu có file `.sql` không khớp quy ước tên.
 */
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

/**
 * File migration là SQL thuần, không có placeholder tên database — `db-backoffice`
 * không cần được inject vì migration không chạm database khác (ranh giới cross-DB
 * là provisioning, xem `03-operations` pattern của `account`). Hàm giữ lại để
 * runner và harness cùng một đường code như `account`, nhưng không thay thế gì.
 */
export function renderMigration(sql: string): string {
  return sql;
}
