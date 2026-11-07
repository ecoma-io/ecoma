import { execSync, type ExecSyncOptions } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Thư mục gốc của repository, suy ra từ vị trí của file này.
 *
 * Tính toán thay vì đọc từ thư mục tiến trình, để mọi command luôn chạy từ cùng
 * một nơi dù `pnpm dx` được gọi từ đâu. `src/` nằm sâu hơn package hai cấp, và
 * package nằm ở `<root>/tools/dx`.
 */
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Env scrub `GIT_*` cho git spawn.
 *
 * Git export `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR` cho
 * hooks (suite chạy dưới lefthook pre-push), và giá trị đó trỏ vào repo của
 * workspace thay vì repo mà `cwd`/`-C` chỉ tới — `GIT_DIR` thắng `cwd`. Không
 * scrub thì lệnh git của fixture đè lên repo thật của workspace.
 *
 * Lọc theo prefix `GIT_` thay vì liệt kê từng biến: cùng họ "thắng `cwd`/config"
 * còn có `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_CONFIG_COUNT`,
 * `GIT_CEILING_DIRECTORIES`, `GIT_NAMESPACE`... — một danh sách cập nhật tay dễ
 * lọt sót khi git thêm biến mới.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

/**
 * Chạy một lệnh shell trong thư mục gốc repository, stream output của nó.
 *
 * Exit code khác 0 sẽ kết thúc tiến trình: các lệnh này là các bước thiết lập,
 * nên đi tiếp sau một lỗi sẽ khiến repository chỉ chuẩn bị được một nửa, mà
 * không có manh mối bước nào đã hỏng.
 */
export function runCommand(command: string, options?: ExecSyncOptions): void {
  try {
    execSync(command, { cwd: ROOT_DIR, stdio: 'inherit', ...options });
  } catch {
    console.error(`Command failed: ${command}`);
    process.exit(1);
  }
}
