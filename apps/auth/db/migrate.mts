import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Đường dẫn thư mục authority `deploys/auth-db/migrations` (02-delivery.md §3a.1).
 *
 * Tính từ vị trí file này chứ không từ `process.cwd()`: Nx đặt `cwd: apps/auth`
 * cho target của project, còn `vitest` lại chạy với `root` khác, và `cwd` là
 * thứ không giữ được giữa hai đường chạy đó. `..` giữa chừng được giữ nguyên vì
 * `resolve` chỉ chuẩn hoá, không cần `dirname(fileURLToPath(...))` cho một đường
 * dẫn đã là tuyệt đối.
 *
 * Migration SQL + runbook operator sống ở project authority `deploys/auth-db`
 * (runbook: `deploys/auth-db/migrations/README.md`); helper này chỉ ĐỌC file SQL
 * cho test integration — app consumer → `deploys/<name>-db` là chiều dependency
 * được phép theo §3a.1.
 */
export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../deploys/auth-db/migrations');

/**
 * Tên database của service này trong provisioning; runner dùng chính tên này
 * làm advisory lock key qua `hashtext` phía server — đổi tên database thì khóa
 * đổi theo.
 */
export const AUTH_DATABASE = 'db-auth';

/**
 * Tên database của service kia. Runner KHÔNG `REVOKE CONNECT` trên nó — phần
 * chặn chéo là việc của provisioning (bước operator, `README.md` §"Vai trò của
 * operator" bước 5), cần quyền sở hữu database đích mà migrator không có và
 * không được có. Hằng tồn tại để test assert rằng khóa advisory của runner này
 * là `hashtext('db-auth')` — khác khóa của `db-account`, hai runner song song
 * trên hai database không chặn lẫn nhau ngoài ý muốn.
 */
export const ACCOUNT_DATABASE = 'db-account';

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/** Thứ tự apply là thứ tự tên file (`0001_`, `0002_`, ...), không phải mtime. */
export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .toSorted((a, b) => a.localeCompare(b, 'en'))
    .map((name) => ({ name, sql: readFileSync(resolve(dir, name), 'utf8') }));
}

/**
 * Checksum sha256 (hex) của nội dung file — ghi nhận dạng file đã áp vào
 * `auth.schema_migrations`. Lệch checksum với lịch sử là drift: file đã đổi sau
 * khi áp, apply phải dừng chứ không "sửa chữa" âm thầm.
 */
export function checksumMigration(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}
