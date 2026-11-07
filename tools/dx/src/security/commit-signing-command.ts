import { defineCommand } from 'citty';

import {
  checkCommitSigningConfig,
  checkHeadCommitSignature,
  checkPushedCommitSignatures,
  type SigningCheckResult,
} from './commit-signing.js';

/**
 * Entry `pnpm dx commit-signing`.
 *
 * Một command phục vụ cả hai hook, phân biệt bằng `--check`:
 *
 * - `config` cho `pre-commit`: chỉ đọc cấu hình ký, vì commit chưa tồn tại ở
 *   thời điểm đó. Rẻ và chạy trước khi git làm bất cứ việc gì.
 * - `head` cho `post-commit`: commit vừa tạo có chữ ký không. Hook này **không**
 *   chặn được — nó chỉ báo, vì commit đã tồn tại. Cần nó vì lefthook bỏ qua mọi
 *   command pre-push khi lần push không đổi file nào.
 * - `push` cho `pre-push`: kiểm chữ ký thật của các commit chưa có trên remote.
 *
 * Mặc định là `push` vì đó là gate có tác dụng chặn thật; `config` là guard
 * tiện lợi mà `--no-verify` bỏ qua được.
 */
export default defineCommand({
  meta: {
    name: 'commit-signing',
    description: 'Check commit signing configuration and the signature of unpushed commits',
  },

  args: {
    check: {
      type: 'string',
      default: 'push',
      description:
        'Which gate to run: "config" (pre-commit), "head" (post-commit) or "push" (pre-push)',
    },
  },

  run({ args }) {
    const mode = args.check;

    if (mode !== 'config' && mode !== 'head' && mode !== 'push') {
      console.error(`--check must be "config", "head" or "push", got "${mode}".`);
      process.exitCode = 1;
      return;
    }

    const gates = {
      config: checkCommitSigningConfig,
      head: checkHeadCommitSignature,
      push: checkPushedCommitSignatures,
    };
    const result: SigningCheckResult = gates[mode]();

    if (result.ok) {
      // Nói rõ đã kiểm bao nhiêu commit: "0" là thông tin có giá trị, người đọc
      // cần phân biệt "không có gì để kiểm" với "đã kiểm và không thấy vấn đề".
      console.log(
        result.checked === 0
          ? 'Commit signing check passed: nothing to check.'
          : `Commit signing check passed: ${result.checked} unpushed commit(s) are signed.`,
      );
      return;
    }

    const headlines = {
      config: 'Commit signing is not configured for this repository:',
      head: 'Commit signing check failed:',
      push: 'Commit signing check failed:',
    };
    console.error(headlines[mode]);
    for (const problem of result.problems) {
      console.error(problem);
    }

    process.exitCode = 1;
  },
});
