import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Đường dẫn thư mục `apps/account/db/migrations`.
 *
 * Tính từ vị trí file này chứ không từ `process.cwd()`: Nx đặt `cwd: apps/account`
 * cho target của project, còn `vitest` lại chạy với `root` khác, và `cwd` là
 * thứ không giữ được giữa hai đường chạy đó.
 *
 * `resolve` chuẩn hoá `import.meta.dirname`, và `..` ở giữa được giữ nguyên vì
 * `resolve` chỉ chuẩn hoá, không cần `dirname(fileURLToPath(...))` cho một đường
 * dẫn đã là tuyệt đối.
 */
export const MIGRATIONS_DIR = resolve(import.meta.dirname, 'migrations');

/** Tên database của service này trong provisioning; không hard-code trong SQL. */
export const ACCOUNT_DATABASE = 'db-account';

/**
 * Tên database của service kia. Chỉ dùng để `REVOKE CONNECT` — đây là lớp
 * enforce thật của ranh giới database (`03-operations.md` §3.1), và `account`
 * không bao giờ đọc hay ghi vào nó.
 */
export const AUTH_DATABASE = 'db-auth';

/** GUC tự định nghĩa chỉ để truyền tên `db-auth` vào SQL, không lưu cấu hình ở đây. */
export const AUTH_DATABASE_GUC = 'ecoma.auth_database';

/**
 * Khóa advisory chặn hai migration chạy song song.
 *
 * Số được chọn theo chính tên database để hai service không tranh cùng một
 * khóa. Hash theo `hashtext` phía server thay vì hard-code hash trong code:
 * đổi tên database thì khóa đổi theo, và giá trị cụ thể không mang ý nghĩa gì.
 *
 * ⚠️ Runner **không** dùng số này: nó lấy khóa bằng `hashtext(ACCOUNT_DATABASE)`
 * phía server để khóa đổi theo tên database. Hằng ở đây tồn tại cho test assert
 * rằng runner khóa đúng tên mà `ACCOUNT_DATABASE` khai báo — hai thứ phải là một,
 * nếu không thì `MIGRATION_LOCK_KEY` chỉ là một con số chết.
 */
export const MIGRATION_LOCK_KEY = 4_827_163n;

/**
 * Cửa sổ skew của internal envelope (giây) — giá trị giao thức, phải bằng
 * `DEFAULT_SKEW_SECONDS` trong `libs/internal-auth-contracts/src/internal-auth.ts`.
 *
 * ⚠️ Số được **lặp lại** ở đây chứ không import từ lib, và đó là điểm cần nói rõ:
 * `apps/account/tests/databases/` chạy bằng `vitest.config.mts` của app, mà
 * config đó không khai báo alias `@ecoma-io/*` — nên import lib ở đây sẽ hỏng
 * trước khi test kịp chạy. Lặp lại hằng là thứ lỗi nhất có thể, và
 * `internal-nonces.spec.ts` assert hai bên bằng nhau nên lệch sẽ đỏ ngay.
 *
 * Lệch theo hai hướng đều hỏng âm thầm: skew ở đây **nhỏ hơn** lib thì bảng
 * expire sớm hơn cửa sổ chấp nhận và prune xoá nonce còn hiệu lực; **lớn hơn**
 * thì bảng phình vô hạn mà không thêm an toàn nào.
 *
 * ⚠️ Phần serving (`server/middleware/internal-auth.ts`) **không** import hằng ở
 * đây, mà khai báo lại của riêng nó. Hằng thuộc về giao thức, không thuộc tầng
 * migration: file này là script Node đọc `node:fs` để liệt kê file, và import nó
 * từ Worker kéo `node:fs` vào bundle của `/internal/**` (đo: `nuxt build` đỏ với
 * `RollupError: db/migrate.mts (71:44): Expected ',', got ':'`). `internal-nonces.spec.ts`
 * assert hai bên bằng nhau nên lệch sẽ đỏ ngay.
 */
export const INTERNAL_SKEW_SECONDS = 300;

/**
 * Biên an toàn cho TTL của nonce so với skew (giây) — **bản lặp lại có chủ ý**.
 *
 * `expires_at` của một nonce = `timestamp của envelope + INTERNAL_SKEW_SECONDS +
 * INTERNAL_NONCE_BUFFER_SECONDS`. Neo theo **envelope** chứ không theo đồng hồ của
 * verifier: `verifyRequest` chấp nhận khi `|now − timestamp| ≤ skew`, nên cửa sổ
 * replay của envelope kết thúc đúng tại `timestamp + skew` — TTL gắn vào chính
 * timestamp đó sống qua cửa sổ đúng bằng buffer, không cần đoán lệch đồng hồ giữa
 * caller và verifier. Buffer cuối cùng tồn tại vì prune chạy theo lô, không chạy
 * đúng thời điểm hết hạn.
 *
 * ⚠️ **Giá trị canonical là `NONCE_TTL_BUFFER_SECONDS` trong
 * `libs/internal-auth-contracts/src/internal-auth.ts`.** Phần serving
 * (`server/middleware/internal-auth.ts`) import thẳng hằng đó, vì lib
 * `runtime:universal` dùng được ở cả hai runtime. File này **không** import được:
 * đây là script Node đọc `node:fs` để liệt kê file migration, và kéo `node:fs` vào
 * bundle của `/internal/**` làm `nuxt build` đỏ với
 * `RollupError: db/migrate.mts (71:44): Expected ',', got ':'`. Hằng thuộc về giao
 * thức, không thuộc tầng migration, nên nó được lặp lại ở đây và
 * `internal-nonces.spec.ts` assert hai bên bằng nhau bằng cách đọc nguồn — lệch là
 * một lỗi giao thức, và lệch theo cả hai hướng đều hỏng âm thầm: buffer ở đây
 * **nhỏ hơn** lib thì prune xoá nonce còn nằm trong cửa sổ replay; **lớn hơn** thì
 * bảng phình ra mà không thêm an toàn nào.
 */
export const INTERNAL_NONCE_BUFFER_SECONDS = 60;

/**
 * `expires_at` của một nonce đã xác thực, từ epoch giây của envelope.
 *
 * Công thức khớp tầng serving (`makeNonceGuard` trong
 * `server/middleware/internal-auth.ts`): `timestamp + skew + buffer`. Hai bên
 * lặp lại hằng số chứ không import chéo (Worker không được import `db/` — xem
 * JSDoc của `INTERNAL_SKEW_SECONDS`); `internal-nonces.spec.ts` assert hai bên
 * bằng nhau nên lệch sẽ đỏ ngay.
 */
export function nonceExpiry(timestampSeconds: number): Date {
  return new Date(
    (timestampSeconds + INTERNAL_SKEW_SECONDS + INTERNAL_NONCE_BUFFER_SECONDS) * 1000,
  );
}

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
 * Thay `:"db_account_database"` bằng tên database thật rồi bọc thành identifier
 * đã quote.
 *
 * SQL không thể `format()` được trực tiếp vì file migration là SQL thuần để
 * người đọc và cơ sở dữ liệu đều nhìn thấy cùng một thứ; nên thay placeholder
 * ở tầng runner thay vì dùng biến `psql`.
 */
export function renderMigration(sql: string, database = ACCOUNT_DATABASE): string {
  return sql.replaceAll(':"db_account_database"', `"${database.replaceAll('"', '""')}"`);
}
