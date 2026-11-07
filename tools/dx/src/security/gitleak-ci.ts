import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineCommand } from 'citty';

import { checkScanRange, type ScanScope } from './gitleaks-scope.js';
import { gitEnv, ROOT_DIR } from '../utils.js';

/**
 * Khóa phiên bản công cụ bảo mật, đọc từ `security-tools.lock.json`.
 *
 * Field `gitleaks.image` trong file lock là nguồn sự thật duy nhất về phiên
 * bản gitleaks DX dùng — CI và local phải chạy cùng một image.
 */
interface SecurityToolsLock {
  gitleaks: { image: string };
}

/** Đường dẫn file lock của các công cụ bảo mật, tính theo vị trí file này. */
const LOCK_PATH = join(import.meta.dirname, '../..', 'security-tools.lock.json');

/** Lấy image gitleaks đang khóa, ném nếu file lock không đọc được. */
function gitleaksImage(): string {
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as SecurityToolsLock;
  if (!lock?.gitleaks?.image) {
    throw new Error('security-tools.lock.json does not define gitleaks.image');
  }

  return lock.gitleaks.image;
}

/**
 * Tóm tắt một finding trong SARIF report của gitleaks, chỉ để in ra console.
 *
 * Không dùng để quyết định pass/fail — verdict là exit code của container
 * (2 = có rò rỉ, khác 0/2 = lỗi). In findings để người đọc log biết secret
 * nào bị đánh dấu mà không phải mở file SARIF.
 */
interface GitleaksFinding {
  ruleId: string;
  path: string;
  line: number;
}

function summarizeGitleaksFindings(sarifPath: string): GitleaksFinding[] {
  try {
    const document = JSON.parse(readFileSync(sarifPath, 'utf8')) as {
      runs?: { results?: unknown[] }[];
    };
    const results = document.runs?.[0]?.results;

    if (!Array.isArray(results)) {
      return [];
    }

    return results.flatMap((raw): GitleaksFinding[] => {
      const result = raw as {
        ruleId?: string;
        locations?: {
          physicalLocation?: {
            artifactLocation?: { uri?: string };
            region?: { startLine?: number };
          };
        }[];
      };
      const location = result.locations?.[0]?.physicalLocation;

      if (result.ruleId === undefined || location?.artifactLocation?.uri === undefined) {
        return [];
      }

      return [
        {
          ruleId: result.ruleId,
          path: location.artifactLocation.uri,
          line: location.region?.startLine ?? 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * Chạy gitleaks ở git mode (dùng cho CI), fail-closed trên scan range.
 *
 * Fail-closed nghĩa là: nếu range rỗng, không tồn tại, hoặc git không resolve
 * được, thì in `::error::`, đặt `process.exitCode = 1`, và KHÔNG chạy docker.
 * Điều này ngăn việc một lần quét rỗng (gitleaks trả exit 0 kèm
 * "0 commits scanned") bị hiểu nhầm là đã qua gate.
 */
export default defineCommand({
  meta: {
    name: 'gitleak-ci',
    description: 'Run gitleaks in git mode for CI, fail-closed on the scan range',
  },

  args: {
    'git-log-opts': {
      type: 'string',
      required: true,
      description: 'Git log range passed to gitleaks via --log-opts',
    },
  },

  run({ args }) {
    const range = args['git-log-opts'];

    // Range bắt buộc và không được rỗng: một range rỗng không thể được quét,
    // và một phạm vi không được quét không phải là một lần quét sạch.
    if (!range) {
      console.error('::error::--git-log-opts is required and must not be empty.');
      process.exitCode = 1;
      return;
    }

    // Fail-closed TRƯỚC khi chạy docker: xác nhận range tồn tại và có commit.
    const scope: ScanScope = { logOpts: range, description: 'git mode CI scan' };
    const checked = checkScanRange(scope);
    if (!checked.ok) {
      console.error(`::error::${checked.reason}`);
      process.exitCode = 1;
      return;
    }

    const image = gitleaksImage();

    // SARIF ghi vào temp dir của HOST, không ghi vào repo: nó là sản phẩm phụ
    // của một lần gate, và để lại file trong worktree là cách nhanh nhất để
    // dính `results.sarif` vào commit sau này.
    const reportDir = mkdtempSync(join(tmpdir(), 'gitleak-ci-'));
    const reportPath = join(reportDir, 'results.sarif');

    const dockerArgs = [
      'run',
      '--rm',
      '--volume',
      `${ROOT_DIR}:/repo`,
      // Mount `.git` vào container: bắt buộc cho git mode (gitleaks cần lịch sử).
      '--volume',
      `${ROOT_DIR}/.git:/repo/.git`,
      '--workdir',
      '/repo',
      '--volume',
      `${reportDir}:/out`,
      // Ép rule mặc định, PR không được override.
      '-e',
      'GITLEAKS_CONFIG_TOML=[extend]\nuseDefault=true',
      image,
      'detect',
      '--source=/repo',
      '--config=/repo/gitleaks.toml',
      `--log-opts=${range}`,
      '--redact',
      // --verbose removed: not used in CI to avoid leaking context/secrets into logs.
      '--exit-code=2',
      '--report-format=sarif',
      '--report-path=/out/results.sarif',
    ];

    const run = spawnSync('docker', dockerArgs, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      // Scrub `GIT_*` để hook (ví dụ lefthook) không ghim container vào repo
      // workspace thay vì repo được chỉ định bởi `cwd`.
      env: gitEnv(),
    });

    const status = run.status ?? 1;

    // In findings nếu có, để người đọc log biết secret nào bị đánh dấu.
    const findings = summarizeGitleaksFindings(reportPath);
    if (findings.length > 0) {
      console.error(`\ngitleak-ci: ${findings.length} finding(s) detected:`);
      for (const finding of findings) {
        console.error(`  ${finding.path}:${finding.line}  [${finding.ruleId}]`);
      }
    }

    rmSync(reportDir, { recursive: true, force: true });

    if (run.error !== undefined) {
      console.error(`could not run docker: ${run.error.message}`);
      process.exitCode = 1;
      return;
    }

    // Gitleaks dùng exit code 2 để báo "leaks found".
    if (status === 2) {
      process.exitCode = 2;
      return;
    }

    if (status !== 0) {
      console.error(`\ngitleak-ci failed: docker exited with code ${status}`);
      process.exitCode = 1;
      return;
    }

    console.log(`gitleak-ci passed: ${findings.length} finding(s), none are secrets.`);
  },
});
