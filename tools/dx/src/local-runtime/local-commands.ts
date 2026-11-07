/**
 * Hợp phần chung của ba lệnh `local-*`: arg `--worktree-root` và error boundary.
 *
 * `--worktree-root` là test seam được lộ ra CLI: hàm orchestration nhận tham số
 * để spec truyền thư mục tạm, còn CLI thì mặc định checkout hiện hành. NGHĨA
 * CHÍNH XÁC: flag chỉ đổi **state/namespace/.env** của worktree đích (namespace
 * Docker, Pulumi stack, `.pulumi-local-state`, `.env`); chương trình Pulumi và
 * smoke vẫn chạy từ checkout ĐANG GÕ LỆNH (`ROOT_DIR`) — không phải "chạy deploy
 * của worktree kia". Description của arg phải nói đúng điều đó.
 */
import { statSync } from 'node:fs';

/** Arg `--worktree-root` dùng chung cho cả ba lệnh `local-*` — một bản duy nhất. */
export const worktreeRootArg = {
  type: 'string',
  description:
    'Worktree whose state/namespace/.env is targeted (Docker namespace, Pulumi stack, ' +
    '.pulumi-local-state); defaults to this checkout — the Pulumi program always runs from it',
  required: false,
} as const;

/**
 * Arg `--worktree-root` riêng cho family `local-worker-*` (OCR PR #36 low):
 * description của `worktreeRootArg` nhắc Docker/Pulumi — hoàn toàn không
 * liên quan worker runtime; người dùng đọc `--help` sẽ hiểu sai flag điều
 * khiển gì. Bản này mô tả đúng stateDir/persist dir của worker runtime.
 */
export const workerWorktreeRootArg = {
  type: 'string',
  description:
    'Worktree whose worker local state is targeted (.worker-local-state stateDir, ' +
    'generated configs, --persist-to dir); defaults to this checkout',
  required: false,
} as const;

/**
 * Error boundary của entry `run()`: mọi exception thoát từ hàm orchestration
 * (path không tồn tại từ `realpathSync`, `.env` không đọc được, Pulumi fail
 * ngoài nhánh đã xử lý...) thành thông điệp `[local-<cmd>] <lý do>` + exit 1 —
 * thay vì stack trace Node với exit code không kiểm soát được.
 *
 * Nhận cả action đồng bộ lẫn async (Promise<number>): up của entry deploy cần
 * sinh khoá ký ES256 qua WebCrypto (`crypto.subtle` — API chỉ có dạng
 * promise), nên luồng up trả Promise. Lỗi rejection cũng bị nuốt vào
 * cùng biên lỗi — một Promise từ chối thoát ra ngoài là unhandled rejection
 * với exit code không kiểm soát được, đúng thứ boundary này cấm.
 */
export async function runLocalCommand(
  command: string,
  action: () => number | Promise<number>,
): Promise<number> {
  try {
    return await action();
  } catch (error) {
    console.error(`[local-${command}] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Validate `--worktree-root` ở biên CLI: phải là thư mục tồn tại. */
export function requireDirectoryRoot(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!statSync(raw).isDirectory()) {
    throw new Error(`--worktree-root is not a directory: ${raw}`);
  }
  return raw;
}

/**
 * Bản async của `runLocalCommand` cho orchestration async
 * (`local-worker-up`/`local-worker-down`): cùng chính sách error
 * `[local-<cmd>] <lý do>` + exit 1, một nơi duy nhất thay vì lặp IIFE
 * try/catch ở từng command (OCR PR #36 low — hai bản copy dễ lệch; IIFE
 * trần còn có nguy cơ unhandled rejection nếu console.error tự throw).
 *
 * Trả về promise để caller vẫn có thể `void`-gọi không block run() —
 * service của citty chạy sync nên exit code được set trong promise body.
 */
export function runLocalCommandAsync(command: string, action: () => Promise<void>): Promise<void> {
  return (async () => {
    try {
      await action();
    } catch (error) {
      console.error(`[local-${command}] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  })();
}
