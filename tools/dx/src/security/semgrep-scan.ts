/**
 * Engine + gate dùng chung cho hai chế độ semgrep của repository.
 *
 * `semgrep-scan-local` (lefthook `pre-push`) quyết định **có chạy hay không**
 * dựa trên file đã đổi; `semgrep-scan-ci` (job `semgrep`) luôn chạy. Cả hai
 * dùng đúng một image (ghim digest), một bộ rule và một gate
 * (`filter-accepted.py`), nên "local xanh" là bằng chứng cho `analysis-gate`
 * xanh chứ không phải bằng chứng cho một chương trình khác.
 *
 * ## Vì sao policy nằm ở đây chứ không nằm trong `lefthook.yml`
 *
 * Cùng lý do `pr-check` và `gitleaks-scope` tồn tại: YAML khai báo lệnh, DX giữ
 * luật. Một danh sách extension nằm rải trong hook thì không ai dám sửa rule mà
 * không sửa cả hook, và CI thì không kiểm được.
 *
 * ## Điều kiện chạy KHÔNG thu hẹp phạm vi quét
 *
 * Điều kiện chỉ quyết định **có chạy hay không**. Khi chạy, nó quét TOÀN BỘ repo.
 * Lý do là `filter-accepted.py` fail-closed hai chiều: một entry allowlist không
 * khớp result nào thì báo stale và đỏ. Quét một tập con làm hai entry không liên
 * quan bị coi là stale — đo trên repo này, quét một file duy nhất làm gate đỏ vì
 * 2/3 entry "biến mất". Thu hẹp phạm vi ở đây sẽ hỏng gate, không tiết kiệm gì.
 *
 * ## Git dir phải được mount — nếu không, phạm vi quét khác CI
 *
 * Ở git worktree, `.git` là một file trỏ tới `<main>/.git/worktrees/<id>`, và
 * đường dẫn đó KHÔNG nằm dưới `ROOT_DIR`. Chỉ mount `ROOT_DIR:/src` thì semgrep
 * mất git integration trong container (`not a git repository`), rơi về duyệt
 * filesystem và quét cả file bị `.gitignore` loại — đo trên repo này: 1155 file
 * thay vì 1124 của CI. Fix là mount git dir ở đúng đường dẫn tuyệt đối của host,
 * read-only, và mount bằng `--mount type=bind,…,readonly` chứ không phải
 * `-v <dir>:<dir>:ro`: đo trên Docker 29.5.3 rootless, same-path `-v …:ro` cho
 * mount rỗng 10/10 lần, `--mount … readonly` đúng 10/10.
 *
 * Mount này không truyền `GIT_*` vào container. Đó vẫn là điều kiện của hợp
 * đồng: truyền `GIT_DIR` trỏ ra ngoài container từng làm semgrep quét hàng chục
 * worktree và tạo finding giả.
 *
 * ## Extension nào đủ để gọi scan — và cái lỗ hổng đã biết
 *
 * Danh sách dưới đây là ĐO, không phải suy đoán: mỗi extension được cấy một vi
 * phạm thật rồi hỏi semgrep 1.182.1 có bắt không.
 *
 *   `.ts` `.tsx`          rule `languages: [typescript]`
 *   `.yml` `.yaml`        rule `languages: [yaml]`
 *   `wrangler.jsonc`      rule `languages: [generic]` + `pattern-regex`
 *
 * **`.mts`, `.cts`, `.vue`, `.js`, `.mjs`, `.json` KHÔNG được quét** — cùng
 * khai báo `typescript` nhưng semgrep không tự sinh target cho chúng (đo trên
 * 1.182.1: 0 finding cho cả 5). Đây là lỗ hổng thật của bộ rule hiện tại, không
 * phải của hook: thêm `.vue` vào danh sách dưới đây sẽ chỉ tốn 12s rồi không
 * tìm được gì. Sửa đúng là thêm rule phủ các ngôn ngữ đó.
 *
 * Test `semgrep-scan.spec.ts` cấy vi phạm thật cho từng extension và assert danh
 * sách này khớp đúng với điều semgrep thực sự quét — để danh sách trôi khỏi rule
 * thì test đỏ, thay vì im lặng hở một lỗ hổng.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { gitEnv, ROOT_DIR } from '../utils.js';

/**
 * Image ghim theo digest, đúng bằng image CI dùng.
 *
 * Digest chứ không phải tag: tag `1.182.1` là một con trỏ có thể bị dịch chuyển,
 * còn CI và local phải chạy CÙNG một bộ rule trên cùng một engine — lệch phiên
 * bản thì "chạy xong ở local" không còn là bằng chứng cho CI. `semgrep-scan.spec.ts`
 * assert chuỗi này bằng chuỗi trong `code-analysis.yml`, nên nâng version ở một
 * bên mà quên bên kia thì test đỏ.
 */
export const SEMGREP_IMAGE =
  'semgrep/semgrep:1.185.0@sha256:67518c174185a2043fdbed16c70631b79209499b3671178e7194379b48295a0d';

/**
 * Đường dẫn mount BẮT BUỘC phải là `/src`.
 *
 * Semgrep tự phát hiện mình đang chạy trong container và bắt buộc code volume
 * nằm đúng ở `/src` — mount chỗ khác thì nó ném
 * `Detected Docker environment without a code volume`. Đó là lý do hook này
 * mount `/src` trong khi hook gitleaks mount `/repo`: hai scanner, hai quy ước.
 */
const CONTAINER_SOURCE_DIR = '/src';

/** Đường dẫn trong repo mà cả docker lẫn CI đều trỏ tới. */
const RULES_DIR = '.github/semgrep';
const ALLOWLIST_PATH = `${RULES_DIR}/accepted-shapes.json`;
const FILTER_SCRIPT = `${RULES_DIR}/filter-accepted.py`;

/**
 * Cơ sở so sánh cho lần push.
 *
 * `origin/HEAD` là cùng mốc mà lệnh `nx affected` đứng cạnh trong `lefthook.yml`
 * dùng, nên "có gì thay đổi" và "lint/test chạy trên cái gì" không lệch nhau.
 */
export const LOCAL_BASE = 'origin/HEAD';

/** Extension mà bộ rule hiện tại thực sự quét — xem JSDoc module. */
const SCANNABLE_EXTENSIONS = ['.ts', '.tsx', '.yml', '.yaml'];

/** File mà rule `generic` + `pattern-regex` nhắm tới. */
const SCANNABLE_FILENAMES = ['wrangler.jsonc'];

/**
 * Đường dẫn này có làm thay đổi kết quả scan không.
 *
 * Tên file theo `basename` chứ không theo đường dẫn đầy đủ: rule nhắm tới
 * `wrangler.jsonc` ở mọi thư mục, nên vị trí không quan trọng.
 */
export function isScannablePath(relativePath: string): boolean {
  const name = basename(relativePath);

  return (
    SCANNABLE_FILENAMES.includes(name) ||
    SCANNABLE_EXTENSIONS.some((extension) => name.endsWith(extension))
  );
}

export type ChangedFiles = { ok: true; files: string[] } | { ok: false; reason: string };

/**
 * Các file đã đổi giữa `base` và `HEAD`.
 *
 * `GIT_DIR` phải scrub: lefthook export nó ở pre-push, và giá trị đó thắng `cwd`
 * — không scrub thì lệnh đọc nhánh nào đó khác. Xem `utils.gitEnv`.
 */
export function listChangedFiles(base: string, cwd: string = ROOT_DIR): ChangedFiles {
  const result = spawnSync('git', ['diff', '--name-only', `${base}..HEAD`], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
  });

  if (result.status !== 0) {
    return {
      ok: false,
      // Không suy đoán `base` hỏng thì nên quét gì. Caller fail closed.
      reason:
        `git could not diff "${base}..HEAD": ` +
        `${(result.stderr ?? '').trim() || `exit code ${result.status}`}.`,
    };
  }

  return {
    ok: true,
    files: (result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  };
}

/** Đường dẫn trong SARIF tới một finding, đủ để người đọc tự mở file. */
export interface SarifFinding {
  rule: string;
  path: string;
  line: number;
  message: string;
}

/**
 * Tóm tắt finding trong SARIF.
 *
 * Chỉ dùng để BÁO, không dùng để quyết định pass/fail — quyết định đó thuộc
 * `filter-accepted.py`, và lặp lại logic allowlist ở đây là tạo ra một nguồn
 * sự thật thứ hai cho cùng một câu hỏi.
 *
 * Đọc `runs[0].results` và bỏ qua mọi thứ khác: đây là đường đi đúng như
 * `filter-accepted.py` đi, và lệch khỏi nó thì báo cáo sai chỗ khác gate.
 */
export function summarizeFindings(sarifPath: string): SarifFinding[] {
  const document = JSON.parse(readFileSync(sarifPath, 'utf8')) as {
    runs?: { results?: unknown[] }[];
  };
  const results = document.runs?.[0]?.results;

  if (!Array.isArray(results)) {
    return [];
  }

  return results.flatMap((raw): SarifFinding[] => {
    const result = raw as {
      ruleId?: string;
      message?: { text?: string };
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
        rule: result.ruleId,
        path: location.artifactLocation.uri,
        line: location.region?.startLine ?? 0,
        message: result.message?.text ?? '',
      },
    ];
  });
}

export type ScanResult =
  | { ok: true; findings: SarifFinding[] }
  | { ok: false; reason: string; findings: SarifFinding[] };

export type GitMounts = { ok: true; dirs: string[] } | { ok: false; reason: string };

/**
 * Thư mục git phải mount thêm, ở đúng đường dẫn tuyệt đối của host.
 *
 * `--git-common-dir` là thư mục chứa `worktrees/<id>/`, nên với worktree nó phủ
 * luôn git dir riêng của worktree. `--absolute-git-dir` được đưa vào để phòng
 * trường hợp hai đường dẫn không lồng nhau; danh sách được khử trùng lặp và bỏ
 * thư mục đã nằm trong `rootDir` (ở clone thường `.git` nằm trong `/src` rồi).
 *
 * Chạy git hỏng thì trả lỗi thay vì mount rỗng: quét mà không có git là quét
 * một tập file khác CI, và đó chính là lỗi hàm này tồn tại để chặn.
 */
export function resolveGitDirMounts(rootDir: string = ROOT_DIR): GitMounts {
  const result = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'],
    { cwd: rootDir, encoding: 'utf8', env: gitEnv() },
  );

  if (result.status !== 0) {
    return {
      ok: false,
      reason:
        `git could not resolve the repository directories in ${rootDir}: ` +
        `${(result.stderr ?? '').trim() || `exit code ${result.status}`}. ` +
        'Without them semgrep scans a different file set than CI, so the scan is not run.',
    };
  }

  const dirs = (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((dir) => (isAbsolute(dir) ? dir : resolve(rootDir, dir)));

  const root = resolve(rootDir);
  const outside = dirs.filter((dir) => dir !== root && !dir.startsWith(`${root}${sep}`));
  const unique = [...new Set(outside)];

  // Worktree: `--absolute-git-dir` là `<main>/.git/worktrees/<id>`, nằm TRONG
  // `--git-common-dir`. Mount cả hai là mount lồng nhau — và mount lồng nhau
  // dưới một bind read-only thì Docker không tạo được mountpoint
  // (`mkdirat … read-only file system`, đã gặp). Mount thư mục ngoài là đủ.
  return {
    ok: true,
    dirs: unique.filter(
      (dir) => !unique.some((other) => other !== dir && dir.startsWith(`${other}${sep}`)),
    ),
  };
}

/**
 * Dựng argv của `docker run` cho một lần scan.
 *
 * Export để spec assert được mount mà không phải chạy docker: chính shape của
 * các argument là hợp đồng với hai lỗi đã đo — mount `/src` (semgrep bắt buộc)
 * và mount git dir read-only bằng `--mount`.
 */
export function buildDockerArgs(options: {
  rootDir?: string;
  image?: string;
  reportDir: string;
  gitDirs?: string[];
}): string[] {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const image = options.image ?? SEMGREP_IMAGE;
  const containerReportDir = '/out';

  const args = [
    'run',
    '--rm',
    '--volume',
    `${rootDir}:${CONTAINER_SOURCE_DIR}`,
    '--volume',
    `${options.reportDir}:${containerReportDir}`,
    '--workdir',
    CONTAINER_SOURCE_DIR,
  ];

  for (const dir of options.gitDirs ?? []) {
    // `--mount` chứ không `-v …:ro`: same-path read-only volume bằng `-v` cho
    // mount rỗng trên Docker 29.5.3 rootless (đo 10/10), nên semgrep lại mất git.
    args.push('--mount', `type=bind,src=${dir},dst=${dir},readonly`);
  }

  args.push(
    image,
    'bash',
    '-c',
    // `--quiet`: semgrep in finding ra stdout theo bảng, nhưng ở đây người
    // đọc cần hai thứ: dòng nào bị gate chặn, và rule nào nói lý do. Bảng
    // summary không có cả hai. Thông điệp đầy đủ in ở `reportFindings`.
    // `&&` là bắt buộc: nếu scan lỗi thì không được chạy gate trên SARIF
    // không tồn tại — python sẽ ném FileNotFoundError, tức đỏ với lý do
    // sai, thay vì lý do thật.
    [
      `semgrep scan --config ${RULES_DIR} --exclude ${RULES_DIR}`,
      `--sarif --output ${containerReportDir}/semgrep.sarif --quiet`,
      `&& python3 ${FILTER_SCRIPT} gate ${containerReportDir}/semgrep.sarif ${ALLOWLIST_PATH}`,
    ].join(' '),
  );

  return args;
}

/**
 * Chạy scan + gate trong một container.
 *
 * Một container cho cả hai bước vì image `semgrep/semgrep` đã có sẵn `python3`
 * (đo: 3.12.15) — chạy thêm container thứ hai chỉ để chạy script sẽ tốn thêm
 * một lần khởi tạo container cho đúng một lệnh python.
 *
 * SARIF ghi vào thư mục tạm của HOST, không ghi vào repo: nó là sản phẩm phụ
 * của một lần gate, và để lại file trong worktree là cách nhanh nhất để dính
 * `.semgrep.sarif` vào commit sau này. Ghi ra volume phụ cũng có nghĩa một lần
 * scan phục vụ được cả HAI việc — gate và báo cáo — nên không phải chạy lần thứ
 * hai chỉ để có danh sách để in.
 *
 * ## Không truyền `GIT_*` vào container — cố ý
 *
 * Lefthook export `GIT_DIR`/`GIT_WORK_TREE` ở pre-push. Docker KHÔNG tự chuyển
 * biến môi trường của host vào container, và bản thân lệnh git để resolve mount
 * đã scrub chúng. Truyền `-e GIT_DIR` với giá trị trỏ ra ngoài container làm
 * semgrep mất thư mục làm việc và quét cả 29 worktree dưới `.claude/worktrees/`
 * → hàng chục finding giả → gate đỏ với lý do hoàn toàn sai.
 */
export function runSemgrepScan(options: {
  rootDir?: string;
  image?: string;
  reportPath?: string;
}): ScanResult {
  const rootDir = options.rootDir ?? ROOT_DIR;

  const mounts = resolveGitDirMounts(rootDir);
  if (!mounts.ok) {
    return { ok: false, findings: [], reason: mounts.reason };
  }

  const reportDir = mkdtempSync(join(tmpdir(), 'semgrep-scan-'));
  const internalReportPath = join(reportDir, 'semgrep.sarif');

  try {
    const run = spawnSync(
      'docker',
      buildDockerArgs({ rootDir, image: options.image, reportDir, gitDirs: mounts.dirs }),
      { cwd: rootDir, stdio: 'inherit' },
    );

    if (run.error !== undefined) {
      return {
        ok: false,
        findings: [],
        reason:
          `could not run docker: ${run.error.message}. ` +
          'The semgrep gate needs a running Docker daemon; it does not have a non-docker fallback.',
      };
    }

    if (options.reportPath !== undefined) {
      // CI cần file SARIF để upload: copy ra đường dẫn caller chỉ định trước khi
      // dọn dẹp thư mục tạm. Thất bại copy không che mất kết quả gate.
      try {
        const dir = dirname(options.reportPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        copyFileSync(internalReportPath, options.reportPath);
      } catch {
        // Bỏ qua: gate đã có kết quả, file SARIF là phụ kiện.
      }
    }

    if (run.status !== 0) {
      // Gate đã in lý do cụ thể lên stderr (đã inherit ở trên), nên chỉ cần một
      // dòng kết để nói rõ lần này là gate đỏ chứ không phải scanner chết giữa
      // chừng — hai lỗi đó cần hành động khác nhau.
      const detail =
        run.status === null
          ? `docker was terminated by ${run.signal ?? 'a signal'}`
          : `docker exited with code ${run.status}`;

      return {
        ok: false,
        findings: readReport(internalReportPath),
        reason: `${detail}. See the semgrep output above for the findings.`,
      };
    }

    return { ok: true, findings: readReport(internalReportPath) };
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

/**
 * Đọc SARIF; file hỏng hoặc không có thì coi như không có gì để in.
 *
 * Đường lỗi đã in lý do của gate rồi, nên hỏng report ở đây chỉ làm mất phần
 * liệt kê — không được biến nó thành lỗi thứ hai cùng lúc, vì khi đó người đọc
 * phải phân biệt hai nguyên nhân trong khi chỉ một cái là thật.
 */
function readReport(reportPath: string): SarifFinding[] {
  try {
    return summarizeFindings(reportPath);
  } catch {
    return [];
  }
}

/**
 * In finding dưới dạng người đọc được.
 *
 * Danh sách gồm cả finding ĐÃ được allowlist chấp nhận, vì lọc ở đây sẽ phải lặp
 * lại logic allowlist — và tạo ra nguồn sự thật thứ hai cho cùng một câu hỏi.
 *
 * Nhưng gate đã in `: finding outside the accepted shapes` cho từng finding bị
 * chặn, nên dòng mở đầu chỉ ra finding nào trong danh sách này là nguyên nhân.
 * Không có nó, người đọc phải tự đối chiếu từng dòng với allowlist để biết cái
 * nào cần sửa — mà allowlist thì ghim cả rule lẫn từng dòng code.
 */
export function reportFindings(findings: SarifFinding[]): void {
  if (findings.length === 0) {
    return;
  }

  console.error(
    '\nSemgrep findings (those marked "outside the accepted shapes" above are the blockers):',
  );
  for (const finding of findings) {
    console.error(`  ${finding.path}:${finding.line}  [${finding.rule}]`);
    if (finding.message !== '') {
      console.error(`    ${finding.message.replace(/\s+/gu, ' ').trim()}`);
    }
  }
}

/** In kết quả của một lần scan và đặt exit code khi gate đỏ. */
export function reportScanResult(result: ScanResult, label: string): void {
  if (result.ok) {
    console.log(
      `${label} passed: ${result.findings.length} finding(s), all accepted by the allowlist.`,
    );
    return;
  }

  console.error(`\n${label} failed: ${result.reason}`);
  reportFindings(result.findings);
  console.error(
    '\nFix the findings, or record a reviewed exception in ' +
      `${ALLOWLIST_PATH} (it pins rule, path, line range AND the exact code of each line).`,
  );

  process.exitCode = 1;
}

/**
 * Quyết định `semgrep-scan-local` có chạy hay không, dựa trên file đã đổi.
 *
 * Trả `null` nghĩa là chạy (không cần lý do); trả chuỗi nghĩa là bỏ qua kèm lý
 * do in ra log. Base không diff được KHÔNG được hiểu là "không có gì đổi" — đó
 * là im lặng bỏ gate, nên trường hợp đó trả `null` để quét hết.
 */
export function localSkipReason(
  changed: ChangedFiles,
  log: (message: string) => void = console.log,
): string | null {
  if (!changed.ok) {
    log(`${changed.reason}\nFalling back to a full scan rather than skipping the gate.`);
    return null;
  }

  const relevant = changed.files.filter((file) => isScannablePath(file));
  if (relevant.length > 0) {
    log(
      `Semgrep scan: ${relevant.length} of ${changed.files.length} changed file(s) are in scope; ` +
        'scanning the whole repository because the allowlist gate is fail-closed on partial scans.',
    );
    return null;
  }

  // Nói rõ đã BỎ QUA chứ không phải "đã pass" — hai lời đó khác nhau khi đọc log.
  const count = changed.files.length;
  const lines = [
    `Semgrep scan skipped: none of the ${count} changed file(s) are scanned by the repository's rules.`,
  ];
  if (count > 0) {
    lines.push(
      `  Only ${SCANNABLE_EXTENSIONS.join(', ')} and ${SCANNABLE_FILENAMES.join(', ')} are scanned; ` +
        'see tools/dx/src/security/semgrep-scan.ts for the measured coverage.',
    );
  }

  return lines.join('\n');
}
