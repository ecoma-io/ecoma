import { spawnSync } from 'node:child_process';

import { defineCommand } from 'citty';

import { gitEnv, ROOT_DIR } from '../utils.js';

/**
 * Commit id đầy đủ: 40 hex (SHA-1) hoặc 64 hex (SHA-256).
 *
 * Mọi giá trị sẽ được ghép thẳng thành range truyền cho `git log`, nên một chuỗi
 * không phải commit id phải bị chặn ở đây — nếu không thì git có thể tôn trọng
 * nó như một tên ref, và một range sai sẽ im lặng quét 0 commit.
 */
const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/iu;

/**
 * SHA "không có" của Git: khi branch vừa được tạo, payload `push` gửi `before`
 * bằng toàn số 0. `git log 000…0..HEAD` lỗi `Invalid revision range`, nên
 * trường hợp này phải được nhận ra trước và thay bằng quét toàn bộ lịch sử.
 */
const ZERO_SHA = /^0+$/u;

export interface ScanScope {
  /** Chuỗi truyền cho `gitleaks --log-opts`. */
  logOpts: string;
  /** Mô tả ngắn để in ra log, giúp người đọc biết job đang quét cái gì. */
  description: string;
}

export type ScanScopeResult = { ok: true; scope: ScanScope } | { ok: false; reason: string };

/**
 * Quét toàn bộ lịch sử của các ref đã checkout.
 *
 * Dùng cho `schedule` / `workflow_dispatch` (audit lịch sử) và cho lần push đầu
 * tiên lên một branch mới, khi không có commit "trước đó" để so.
 */
export function fullHistoryScope(reason: string): ScanScope {
  return { logOpts: '--all', description: `full history of the checked-out refs (${reason})` };
}

export interface ScanScopeEnv {
  eventName?: string;
  /** `pull_request.base.sha`. */
  baseSha?: string;
  /** `pull_request.head.sha`. */
  headSha?: string;
  /** `push.before`. */
  before?: string;
  /** `push.after`. */
  after?: string;
}

/**
 * Chọn phạm vi quét cho từng event mà workflow khai báo.
 *
 * Mỗi event trả lời một câu hỏi khác nhau: PR chỉ chịu trách nhiệm phần nó đưa
 * vào, push vào `main` chỉ chịu trách nhiệm phần vừa đẩy, còn lịch audit thì
 * nhìn toàn bộ. Trả về `logOpts` để gitleaks dựng `git log` tương ứng.
 *
 * Không có nhánh nào "mặc định" quét hết: `origin/main` không phải câu trả lời
 * chung, vì nó sai ngay với PR nhắm base khác và với push lên branch không phải
 * `main`.
 */
export function resolveScanScope(env: ScanScopeEnv): ScanScopeResult {
  switch (env.eventName) {
    case 'pull_request': {
      const base = env.baseSha;
      const head = env.headSha;

      if (!base || !COMMIT_ID.test(base)) {
        return {
          ok: false,
          reason: `pull_request.base.sha is missing or not a full commit id: "${base ?? ''}".`,
        };
      }
      if (!head || !COMMIT_ID.test(head)) {
        return {
          ok: false,
          reason: `pull_request.head.sha is missing or not a full commit id: "${head ?? ''}".`,
        };
      }

      // `base..head` là tập commit của PR theo định nghĩa git: reachable từ head
      // nhưng chưa reachable từ base. Dùng SHA thật của payload (không phải
      // ref merge tổng hợp của GitHub) nên kết quả tái lập được và không phụ
      // thuộc base trỏ về nhánh nào.
      return {
        ok: true,
        scope: {
          logOpts: `${base}..${head}`,
          description: 'the commits this pull request adds',
        },
      };
    }

    case 'push': {
      const before = env.before;
      const after = env.after;

      if (!after || !COMMIT_ID.test(after)) {
        return {
          ok: false,
          reason: `push.after is missing or not a full commit id: "${after ?? ''}".`,
        };
      }

      // Branch vừa tạo: `before` là toàn số 0, không phải commit nào để so.
      // Quét toàn bộ lịch sử là hành vi đúng cho lần đẩy đầu tiên — đó cũng chính
      // là lúc một secret lọt vào branch mới cần bị chặn.
      if (!before || ZERO_SHA.test(before)) {
        return {
          ok: true,
          scope: fullHistoryScope('push with no previous commit for this ref'),
        };
      }
      if (!COMMIT_ID.test(before)) {
        return {
          ok: false,
          reason: `push.before is not a full commit id: "${before}".`,
        };
      }

      return {
        ok: true,
        scope: {
          logOpts: `${before}..${after}`,
          description: 'the commits this push adds',
        },
      };
    }

    case 'schedule':
    case 'workflow_dispatch': {
      // Audit có chủ ý: đây là lần duy nhất nhìn toàn bộ lịch sử, để bắt secret
      // đã nằm im trong main từ lâu chứ không ai push nó.
      return { ok: true, scope: fullHistoryScope(`${env.eventName} audit`) };
    }

    default: {
      return {
        ok: false,
        reason: `no gitleaks scan scope is defined for the "${env.eventName ?? 'unknown'}" event.`,
      };
    }
  }
}

export type RangeCheckResult = { ok: true; commits: number } | { ok: false; reason: string };

/** `git` chạy trong repo cho trước, với `GIT_*` đã scrub. */
function runGit(
  args: string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });

  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Xác nhận range sắp quét thực sự tồn tại và có commit để quét.
 *
 * Gitleaks 8.30.1 **không** phân biệt được "quét xong, không có secret" với
 * "quét sai phạm vi rồng ra số không": range rỗng, range trỏ tới commit không có
 * trong checkout, và range sai đều cho exit code 0 kèm dòng `0 commits scanned`.
 * Với exit code 0 là tín hiệu xanh của `analysis-gate`, một lần quét rỗng như
 * vậy là một required check xanh trong khi chưa quét gì — nên việc kiểm này phải
 * chạy TRƯỚC khi gọi gitleaks, và hỏng thì fail closed.
 */
export function checkScanRange(scope: ScanScope, cwd: string = ROOT_DIR): RangeCheckResult {
  if (scope.logOpts === '--all') {
    // Quét toàn bộ: git không cần một range cụ thể để hỏng, nhưng một repo không
    // có commit nào thì quét cũng rỗng — vẫn phải bắt.
    const listed = runGit(['rev-list', '--all', '--count'], cwd);
    if (listed.status !== 0) {
      return {
        ok: false,
        reason: `git could not count commits: ${listed.stderr.trim() || `exit code ${listed.status}`}`,
      };
    }

    const total = Number.parseInt(listed.stdout.trim(), 10);
    if (!Number.isFinite(total) || total < 1) {
      return { ok: false, reason: 'the checkout has no commits to scan.' };
    }

    return { ok: true, commits: total };
  }

  // `git rev-list --count <range>` trả về 0 cho range hợp lệ nhưng rỗng, và lỗi
  // (non-zero) cho range không tồn tại — hai trường hợp cần báo khác nhau.
  const counted = runGit(['rev-list', '--count', scope.logOpts], cwd);

  if (counted.status !== 0) {
    return {
      ok: false,
      reason:
        `git could not resolve the scan range "${scope.logOpts}": ` +
        `${counted.stderr.trim() || `exit code ${counted.status}`}. ` +
        'A range that does not resolve cannot be scanned, and an unscanned range is not a clean pass.',
    };
  }

  const commits = Number.parseInt(counted.stdout.trim(), 10);
  if (!Number.isFinite(commits) || commits < 1) {
    return {
      ok: false,
      reason:
        `the scan range "${scope.logOpts}" contains no commits. ` +
        'Refusing to report a clean scan over an empty range.',
    };
  }

  return { ok: true, commits };
}

export default defineCommand({
  meta: {
    name: 'gitleaks-scope',
    description: 'Resolve and validate the gitleaks scan scope for this event',
  },

  run() {
    const scope = resolveScanScope({
      eventName: process.env.GITLEAKS_EVENT_NAME ?? process.env.GITHUB_EVENT_NAME,
      baseSha: process.env.GITLEAKS_BASE_SHA,
      headSha: process.env.GITLEAKS_HEAD_SHA,
      before: process.env.GITLEAKS_BEFORE_SHA,
      after: process.env.GITLEAKS_AFTER_SHA,
    });

    if (!scope.ok) {
      console.error(`::error::${scope.reason}`);
      process.exitCode = 1;
      return;
    }

    const checked = checkScanRange(scope.scope);
    if (!checked.ok) {
      console.error(`::error::${checked.reason}`);
      process.exitCode = 1;
      return;
    }

    // `key=value` để CI nạp vào step output; phần còn lại để người đọc log
    // biết job đang quét đúng cái gì mà không phải mở xem workflow.
    console.log(`gitleaks scope: ${scope.scope.description}`);
    console.log(`gitleaks commits: ${checked.commits}`);
    console.log(`log-opts=${scope.scope.logOpts}`);
    console.log(`commits=${checked.commits}`);
  },
});
