#!/usr/bin/env node
/**
 * Cổng xác nhận AI Review (OpenCodeReview) thực sự đã review nội dung.
 *
 * Vì sao cần cổng này: action `alibaba/open-code-review` thoát 0 khi không có
 * file nào được chọn để review, và `ocr-result.json` lúc đó vẫn là một tài liệu
 * JSON hợp lệ (`status: "skipped"`). Nếu job chỉ tin vào exit code của action
 * thì một PR docs-only sẽ hiện check xanh trong khi không file nào được review —
 * đúng thứ issue #239 mô tả. Cổng này đọc kết quả thật và fail-closed.
 *
 * Nguồn dữ liệu:
 * - `ocr-result.json` (stdout của `ocr review --format json`) là nguồn chính:
 *   `manifest.terminal_state`, `manifest.coverage`, `summary`.
 * - `ocr-stderr.log` là nguồn phụ, chỉ dùng để nhận diện file bị bỏ qua. JSON
 *   không mang thông tin đó: file bị gate tĩnh hoặc bị gate kích thước
 *   (`too_large`) loại ra KHÔNG xuất hiện trong `coverage` — `coverage` chỉ liệt
 *   kê các item đã được chọn. Vì vậy nhận diện `too_large` buộc phải đọc log;
 *   điều kiện hợp lệ/không hợp lệ vẫn do JSON quyết định.
 * - `.github/ocr-rules.json` (base checkout) là nguồn thứ ba, chỉ dùng để
 *   đối chiếu các file bị bỏ: file khớp `include` mà không khớp `exclude` nào thì
 *   đáng lẽ phải được review, nên việc bỏ nó nghĩa là rule không còn hiệu lực.
 *
 * Hợp đồng: exit 0 = chứng minh được một trong hai điều: (a) review đã hoàn tất
 * trên ít nhất một file, hoặc (b) review bị bỏ qua (`terminal_state: "skipped"`)
 * mà TOÀN BỘ file thay đổi đều nằm ngoài phạm vi review (issue #391: rule chỉ
 * include Markdown còn PR chỉ đổi `*.spec.ts` — không có gì để review theo
 * policy, không phải xanh giả #239). Exit 1 = không chứng minh được
 * (fail-closed, mọi trường hợp thiếu dữ liệu đều rơi vào đây); exit 2 = dùng
 * sai tham số.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

const EXIT_VERIFIED = 0;
const EXIT_UNVERIFIED = 1;
const EXIT_USAGE = 2;

const DEFAULT_RESULT_PATH = '/tmp/ocr-result.json';
const DEFAULT_STDERR_PATH = '/tmp/ocr-stderr.log';
/**
 * Project rule mà `ocr` đọc để mở rộng phạm vi review (Markdown). Đường dẫn này
 * nằm trong base checkout mà workflow đã có sẵn, nên cổng soát được các file bị
 * bỏ qua có thật sự nằm ngoài phạm vi rule hay không.
 */
const DEFAULT_RULE_PATH = '.github/ocr-rules.json';

/**
 * Lý do bỏ qua được coi là hợp lệ: đúng ba nhóm gate tĩnh của CLI (`binary`,
 * `secret_exclude`, và `user_exclude`/`unsupported_ext`/`default_path` — cả ba
 * in chung một câu). Đây là các gate do path/extension quyết định, không phụ
 * thuộc nội dung, nên việc bỏ qua chúng là hành vi đã thiết kế.
 *
 * Ý nghĩa theo hợp đồng exit 0 (issue #391): với `terminal_state: "skipped"`,
 * các lý do này là bằng chứng "không có gì trong phạm vi để review" khi và chỉ
 * khi cổng chứng minh được toàn bộ file thay đổi đều nằm ngoài phạm vi rule
 * (xem `nothingInScopeEvidence`). Riêng hai lý do `binary`/`secret_exclude` không
 * cần đối chiếu rule: chúng loại file theo nội dung/đường dẫn nhạy cảm, và file
 * binary/secret không bao giờ thuộc phạm vi review muốn xem.
 */
const PERMITTED_SKIP_REASONS = new Set([
  'binary file',
  'matches a built-in secret path',
  'filtered by path/extension rules',
]);

const SKIP_LINE = /^\[ocr\] Skipping (?<path>.+?) — (?<reason>.+)$/u;
/**
 * Cùng mở đầu `[ocr] Skipping` nhưng là dòng tiến trình vô hại của CLI, không
 * phải một file bị loại: `grouping.go` in dòng grouping khi bỏ bước grouping LLM
 * cho 2–3 file reviewable, và `agent.go` in dòng plan phase cho mỗi group nhỏ.
 * Nếu không loại tường minh thì mọi job review hoàn chỉnh có 2–3 file đều bị
 * gate này fail nhầm.
 */
const BENIGN_SKIP_LINE = /^\[ocr\] Skipping (?:LLM grouping\b|plan phase for group\b)/u;
/**
 * Tiền tố dùng chung cho cả dòng bỏ file thật lẫn dòng tiến trình vô hại. Dòng
 * mang tiền tố này mà không khớp mẫu nào đã biết là dòng chưa phân loại được.
 */
const SKIP_PREFIX = /^\[ocr\] Skipping /u;
/**
 * Dạng file mà rule của repo mở rộng phạm vi review ra. Chỉ dùng khi không đọc
 * được rule: lúc đó vẫn phải nhận ra "file này đáng lẽ được review".
 */
const MARKDOWN_EXT = /\.(?:md|markdown|mdx)$/iu;
const SIZE_SKIP_LINE =
  /^\[ocr\] Skipping (?<path>.+?) \(~(?<tokens>\d+) tokens exceeds 80% of max_tokens\((?<max>\d+)\)\)$/u;
const SIZE_ROLLUP_LINE = /^\[ocr\] Pre-filtered \d+ file\(s\) exceeding 80% of max_tokens/u;
const SELECTION_LINE =
  /^\[ocr\] (?<changed>\d+) file\(s\) changed, reviewing (?<selected>\d+) in /mu;

const USAGE = `Usage: node ocr-result-gate.mjs [--result <path>] [--stderr <path>] [--rule <path>]

Reads the OpenCodeReview result and fails unless the review is proven complete.
  --result <path>  ocr-result.json path (default: ${DEFAULT_RESULT_PATH})
  --stderr <path>  ocr-stderr.log path (default: ${DEFAULT_STDERR_PATH})
  --rule <path>    project rule path (default: ${DEFAULT_RULE_PATH})
`;

/**
 * Đọc tham số dòng lệnh; chỉ nhận các cờ đường dẫn.
 * @param {string[]} argv
 * @returns {{ resultPath: string, stderrPath: string, rulePath: string }}
 */
function parseArgs(argv) {
  let resultPath = DEFAULT_RESULT_PATH;
  let stderrPath = DEFAULT_STDERR_PATH;
  let rulePath = DEFAULT_RULE_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== '--result' && flag !== '--stderr' && flag !== '--rule') {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} needs a path`);
    }
    if (flag === '--result') {
      resultPath = value;
    } else if (flag === '--stderr') {
      stderrPath = value;
    } else {
      rulePath = value;
    }
    index += 1;
  }
  return { resultPath, stderrPath, rulePath };
}

class UsageError extends Error {}

/**
 * Chuyển một glob của OpenCodeReview sang RegExp. Hỗ trợ đúng những gì rule
 * dùng: `**` (mọi cấp thư mục), `*` (trong một segment), `?` (một ký tự) và
 * `{a,b}` (danh sách lựa chọn).
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] !== '*') {
        out += '[^/]*';
      } else if (pattern[index + 2] === '/') {
        // `**/` cũng khớp trường hợp không có thư mục nào ở trước.
        out += '(?:.*/)?';
        index += 2;
      } else {
        out += '.*';
        index += 1;
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '{') {
      const end = pattern.indexOf('}', index);
      if (end === -1) {
        out += '\\{';
      } else {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(',')
          .map(escapeRegExp)
          .join('|');
        out += `(?:${alternatives})`;
        index = end;
      }
    } else {
      out += escapeRegExp(char);
    }
  }
  // CLI so khớp include/exclude sau khi hạ cả pattern lẫn path về chữ thường
  // (`system_rules.go`), nên cổng cũng phải insensitive để không phán nhầm
  // một path chứa chữ hoa là "ngoài phạm vi rule".
  return new RegExp(`^${out}$`, 'iu');
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Đọc project rule (`.github/ocr-rules.json`). Rule nằm trong base checkout
 * nên nội dung là dữ liệu đáng tin về "phạm vi review mà repo đã chọn".
 * @param {string} rulePath
 * @returns {{ available: boolean, path: string, include: string[], exclude: string[], error: string | null }}
 */
function readRule(rulePath) {
  const empty = { available: false, path: rulePath, include: [], exclude: [], error: null };
  if (!rulePath) {
    return { ...empty, error: 'no rule path given' };
  }
  let raw;
  try {
    raw = readFileSync(rulePath, 'utf8');
  } catch {
    return { ...empty, error: 'unreadable' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...empty, error: 'not valid JSON' };
  }
  if (!isRecord(parsed)) {
    return { ...empty, error: 'not a JSON object' };
  }
  const include = asArray(parsed.include) ?? [];
  const exclude = asArray(parsed.exclude) ?? [];
  return {
    available: true,
    path: rulePath,
    include: include.filter((entry) => typeof entry === 'string'),
    exclude: exclude.filter((entry) => typeof entry === 'string'),
    error: null,
  };
}

/**
 * Phân loại các dòng `[ocr] Skipping ...` trong log stderr.
 * @param {string} text
 * @returns {{
 *   permitted: Map<string, number>,
 *   ruleFiltered: string[],
 *   sizeGated: string[],
 *   sizeGatedRollup: boolean,
 *   unknown: string[],
 * }}
 */
function classifySkips(text) {
  const permitted = new Map();
  const ruleFiltered = [];
  const sizeGated = [];
  const unknown = [];
  let sizeGatedRollup = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd();
    if (SIZE_ROLLUP_LINE.test(trimmed)) {
      // Dòng tổng hợp vẫn có ích khi dòng chi tiết từng file đổi định dạng.
      sizeGatedRollup = true;
      continue;
    }
    const sizeMatch = SIZE_SKIP_LINE.exec(trimmed);
    if (sizeMatch?.groups) {
      sizeGated.push(sizeMatch.groups.path);
      continue;
    }
    if (BENIGN_SKIP_LINE.test(trimmed)) {
      continue;
    }
    const skipMatch = SKIP_LINE.exec(trimmed);
    if (!skipMatch?.groups) {
      // Dòng mang tiền tố `[ocr] Skipping` mà không khớp mẫu nào đã biết (vd CLI
      // đổi dấu phân cách em-dash) thì không phân loại được: phải tính là lý do
      // bỏ chưa nhận dạng, không được bỏ qua âm thầm — nếu không thì một dòng
      // bỏ qua mới lạ sẽ biến mất khỏi `unknown` và cổng thành fail-open.
      if (SKIP_PREFIX.test(trimmed)) {
        unknown.push(`unclassified skip line: ${trimmed}`);
      }
      continue;
    }
    const { path, reason } = skipMatch.groups;
    if (PERMITTED_SKIP_REASONS.has(reason)) {
      permitted.set(reason, (permitted.get(reason) ?? 0) + 1);
      // Cùng một câu được in cho cả `user_exclude` (policy của repo) lẫn
      // `unsupported_ext`/`default_path` (mặc định của CLI), nên phải đối chiếu
      // lại với rule để biết file bỏ qua có nằm trong phạm vi repo muốn review.
      if (reason === 'filtered by path/extension rules') {
        ruleFiltered.push(path);
      }
    } else {
      unknown.push(`${path} — ${reason}`);
    }
  }
  return { permitted, ruleFiltered, sizeGated, sizeGatedRollup, unknown };
}

/**
 * Lấy số file CLI báo là đã chọn để review, từ dòng đầu của log.
 * @param {string} text
 * @returns {number | undefined}
 */
function reportedSelectionCount(text) {
  for (const line of text.split('\n')) {
    const match = SELECTION_LINE.exec(line);
    if (match?.groups) {
      return Number(match.groups.selected);
    }
  }
  return undefined;
}

/**
 * Kiểm tra xem có đủ bằng chứng "không có file nào trong phạm vi review" cho một
 * run `skipped` hay không (issue #391). Trả về `null` nếu thiếu bất kỳ điều kiện
 * nào — khi đó đường `skipped` vẫn fail-closed như cũ.
 *
 * Các điều kiện, mỗi điều kiện chặn một kiểu "xanh giả" riêng:
 * 1. `selected === 0` và dòng selection phải có mặt — không có dòng thì không
 *    chứng minh được CLI thực sự đã thấy 0 file đáng chọn.
 * 2. Mọi file thay đổi phải được giải thích bằng một dòng skip đã phân loại
 *    (permitted hoặc size-gated): một file chưa được giải thích là một file có
 *    thể đã đáng review.
 * 3. Không file nào bị gate kích thước, không lý do lạ, không item `failed` —
 *    mỗi nhóm đó đều là "đáng lẽ phải được review".
 * 4. Không file nào `ruleFiltered` nằm trong phạm vi rule — đây chính là bảo vệ
 *    #239 trên đường `skipped`. `ruleFiltered` khác rỗng mà rule đọc không được
 *    thì không chứng minh được → `null`. Khi rule hợp lệ nhưng `include` rỗng,
 *    `auditAgainstRule` rơi về nhận diện theo phần mở rộng (fallback
 *    `MARKDOWN_EXT`, đúng ngữ nghĩa của đường `complete`): một file `.md` bị bỏ
 *    vẫn bị coi là trong phạm vi → fail-closed, một file `.spec.ts` bị bỏ vẫn
 *    ngoài phạm vi → được cấp qua.
 * @param {ReturnType<typeof classifySkips>} skips
 * @param {number | undefined} selected số file CLI báo đã chọn (dòng selection)
 * @param {number} changedCount tổng file thay đổi theo cùng dòng selection
 * @param {{ failed: number, selected: number, completed: number, reused: number }} coverage số lượng item trong manifest
 * @param {string} rulePath
 * @returns {string | null} ghi chú tiếng Anh khi đủ bằng chứng, `null` nếu không
 */
function nothingInScopeEvidence(skips, selected, changedCount, coverage, rulePath) {
  if (selected !== 0 || changedCount === 0) {
    return null;
  }
  const { permitted, ruleFiltered, sizeGated, sizeGatedRollup, unknown } = skips;
  if (
    sizeGated.length > 0 ||
    sizeGatedRollup ||
    unknown.length > 0 ||
    coverage.failed > 0 ||
    coverage.selected !== 0 ||
    coverage.completed !== 0 ||
    coverage.reused !== 0
  ) {
    return null;
  }
  // Đối chiếu từng file thay đổi với một dòng skip đã phân loại. Lưu ý
  // `ruleFiltered` KHÔNG cộng thêm vào tổng: nó là tập con của `permitted`
  // (cùng một dòng skip vừa được đếm vào `permitted` vừa được ghi lại path vào
  // `ruleFiltered` trong `classifySkips`), nên cộng cả hai sẽ đếm kép và mọi
  // case thật đều mismatch. Tổng đúng = tổng dòng skip permitted + dòng skip
  // size-gated; lệch với số file thay đổi nghĩa là có file bị bỏ không giải
  // thích được (hoặc dòng skip trỏ ra ngoài diff) → không cấp qua.
  const explained =
    [...permitted.values()].reduce((sum, count) => sum + count, 0) + sizeGated.length;
  if (explained !== changedCount) {
    return null;
  }
  if (ruleFiltered.length > 0) {
    const rule = readRule(rulePath);
    // Rule đọc không được thì không có gì để đối chiếu — "cannot prove",
    // fail-closed đúng tinh thần lỗi cùng tên của đường `complete`.
    if (!rule.available) {
      return null;
    }
    // Rule hợp lệ nhưng `include` rỗng: `auditAgainstRule` rơi về nhận diện theo
    // phần mở rộng (fallback `MARKDOWN_EXT`) — đúng ngữ nghĩa của đường
    // `complete`, nên một file `.md` bị bỏ vẫn trong phạm vi suy diễn → null,
    // còn `.spec.ts` thì ngoài phạm vi → được cấp qua.
    const audit = auditAgainstRule(ruleFiltered, rule, MARKDOWN_EXT);
    if (audit.inScope.length > 0) {
      return null;
    }
  }
  return `0 in-scope file(s): nothing to review under the project rule (${changedCount} changed file(s) all filtered out of scope)`;
}

/**
 * Đọc và parse JSON kết quả.
 * @param {string} resultPath
 * @returns {{ read: true, value: unknown } | { read: false, error: string }}
 */
function readResult(resultPath) {
  let raw;
  try {
    raw = readFileSync(resultPath, 'utf8');
  } catch (error) {
    return { read: false, error: `cannot read ${resultPath}: ${error.message}` };
  }
  try {
    return { read: true, value: JSON.parse(raw) };
  } catch (error) {
    return { read: false, error: `cannot parse ${resultPath} as JSON: ${error.message}` };
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {unknown[] | undefined}
 */
function asArray(value) {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Đối chiếu danh sách file bị bỏ với project rule, trả về các file "đáng lẽ phải
 * được review": khớp `include` nhưng không khớp `exclude` nào. Khi rule không
 * đọc được, chỉ còn cách dựa vào phần mở rộng của file (base checkout luôn có
 * rule khi workflow chạy, nên đây là nhánh phòng ngừa).
 * @param {string[]} paths
 * @param {{ available: boolean, path: string, include: string[], exclude: string[], error: string | null }} rule
 * @param {RegExp} fallback
 * @returns {{ inScope: string[], ruleAvailable: boolean, rulePath: string, ruleError: string | null }}
 */
function auditAgainstRule(paths, rule, fallback) {
  // `include` rỗng (rule hợp lệ nhưng không khai phạm vi) không được coi là
  // "phạm vi trống": nếu vậy thì mọi file bị bỏ đều "ngoài phạm vi" và cổng
  // thành fail-open. Rơi về nhận diện theo phần mở rộng.
  const useRuleInclude = rule.available && rule.include.length > 0;
  const compiledInclude = useRuleInclude ? rule.include.map(globToRegExp) : null;
  const compiledExclude = rule.available ? rule.exclude.map(globToRegExp) : null;
  const isIncluded = (path) =>
    compiledInclude === null ? fallback.test(path) : compiledInclude.some((re) => re.test(path));
  const isExcluded = (path) =>
    compiledExclude === null ? false : compiledExclude.some((re) => re.test(path));
  return {
    inScope: paths.filter((path) => isIncluded(path) && !isExcluded(path)),
    ruleAvailable: rule.available,
    rulePath: rule.path,
    ruleError: rule.error,
  };
}

/**
 * Đánh giá kết quả review. Trả về danh sách lý do không đạt (rỗng = đạt).
 * @param {unknown} result
 * @param {{ text: string, available: boolean, path: string }} stderrLog
 * @param {string} rulePath
 * @returns {{ failures: string[], notes: string[], facts: string[] }}
 */
function evaluate(result, stderrLog, rulePath) {
  const failures = [];
  const notes = [];
  const facts = [];
  let reusedCount = 0;

  if (!isRecord(result)) {
    failures.push('result is not a JSON object');
    return { failures, notes, facts };
  }

  facts.push(`status=${JSON.stringify(result.status ?? null)}`);
  if (typeof result.message === 'string' && result.message !== '') {
    facts.push(`message=${JSON.stringify(result.message)}`);
  }

  const manifest = result.manifest;
  // `terminal_state` là kết luận suy ra từ coverage, nên khi nó không phải
  // `complete` thì các kiểm tra coverage bên dưới chỉ lặp lại cùng một sự thật:
  // chúng chỉ có giá trị khi manifest *nói* đã xong mà dữ liệu bên trong lại
  // nói khác.
  let terminalStateComplete = false;
  let terminalStateSkipped = false;
  let selectedOk = false;
  let completedOrReusedOk = false;
  let failedCoverageCount = 0;
  let selectedManifestCount = 0;
  let completedManifestCount = 0;
  let reusedManifestCount = 0;
  const terminalStateFailures = [];

  if (!isRecord(manifest)) {
    // Không có manifest thì không có nguồn nào nói item nào đã được chọn và
    // item nào đã xong — thiếu dữ liệu luôn là không đạt.
    failures.push('manifest missing from result: coverage cannot be confirmed');
  } else {
    const terminalState = manifest.terminal_state;
    facts.push(`terminal_state=${JSON.stringify(terminalState ?? null)}`);
    terminalStateComplete = terminalState === 'complete';
    terminalStateSkipped = terminalState === 'skipped';

    const coverage = manifest.coverage;
    if (!isRecord(coverage)) {
      failures.push('manifest.coverage missing: cannot confirm what was reviewed');
    } else {
      const selected = asArray(coverage.selected);
      const completed = asArray(coverage.completed);
      const reused = asArray(coverage.reused);
      const failed = asArray(coverage.failed);
      if (!selected || !completed || !reused || !failed) {
        failures.push(
          'manifest.coverage is malformed: selected/completed/reused/failed must all be arrays',
        );
      } else {
        reusedCount = reused.length;
        selectedOk = selected.length > 0;
        completedOrReusedOk = completed.length + reused.length > 0;
        failedCoverageCount = failed.length;
        selectedManifestCount = selected.length;
        completedManifestCount = completed.length;
        reusedManifestCount = reused.length;
        facts.push(
          `coverage: selected=${selected.length} completed=${completed.length} ` +
            `reused=${reused.length} failed=${failed.length}`,
        );
        for (const item of failed.slice(0, 10)) {
          const path = isRecord(item) ? item.path : undefined;
          const classification = isRecord(item) ? item.classification : undefined;
          notes.push(
            `failed item: ${String(path ?? '<unknown path>')} (${String(classification ?? 'unknown')})`,
          );
        }
        if (!terminalStateComplete) {
          // Với `skipped`, lỗi này có thể được cấp qua bên dưới nếu cổng chứng
          // minh được toàn bộ diff nằm ngoài phạm vi review — nên hoãn đẩy vào
          // `failures` đến khi biết kết quả xét "nothing in scope".
          terminalStateFailures.push(
            `review did not complete: terminal_state is ${JSON.stringify(terminalState ?? null)} ` +
              `(${selected.length} selected, ${completed.length} completed, ${reused.length} reused, ${failed.length} failed)`,
          );
        }
      }
    }
  }

  const summary = result.summary;
  let filesReviewedCount = null;
  if (!isRecord(summary)) {
    failures.push('summary missing from result: files_reviewed cannot be confirmed');
  } else {
    const filesReviewed = summary.files_reviewed;
    if (
      typeof filesReviewed !== 'number' ||
      !Number.isInteger(filesReviewed) ||
      filesReviewed < 0
    ) {
      failures.push(
        `summary.files_reviewed is not a non-negative integer (got ${JSON.stringify(filesReviewed ?? null)})`,
      );
    } else {
      filesReviewedCount = filesReviewed;
      facts.push(
        `files_reviewed=${filesReviewed}` +
          (terminalStateSkipped ? ' (nothing to review for this terminal state)' : ''),
      );
    }
    if (summary.budget_exceeded === true) {
      failures.push('token budget was reached: coverage was truncated');
    }
  }

  // Manifest nói đã xong, nhưng dữ liệu bên trong phải khớp — đây là lớp chặn
  // trường hợp "xanh giả" mà không có terminal_state nào phản ánh.
  if (terminalStateComplete) {
    if (!selectedOk) {
      failures.push('coverage.selected is empty: no item was chosen for review');
    }
    if (filesReviewedCount === 0) {
      if (reusedCount === 0) {
        failures.push('summary.files_reviewed is 0: no file was reviewed');
      } else {
        // Không file nào được review trong lần chạy này, nhưng item đã được
        // review ở lần chạy trước của cùng PR (checkpoint) — không phải xanh giả.
        notes.push(
          `files_reviewed is 0 but ${reusedCount} item(s) were reused from a previous run`,
        );
      }
    }
    if (!completedOrReusedOk) {
      failures.push('coverage has neither a completed nor a reused item: nothing was reviewed');
    }
  }

  // `ocr-stderr.log` là nguồn *duy nhất* cho biết file nào bị loại vì vượt kích
  // thước: file bị loại không xuất hiện trong `coverage`. Khi không có log, hoặc
  // log rỗng (ví dụ `stream_progress` bị tắt nên progress không còn đi vào
  // stderr), thì không thể loại trừ khả năng một tài liệu mục tiêu đã bị bỏ im
  // lặng — và với `terminal_state: "complete"` thì JSON hoàn toàn không phản ánh
  // việc đó. Thiếu dữ liệu không bao giờ được coi là review sạch.
  const stderrState = !stderrLog.available
    ? 'unreadable'
    : stderrLog.text.trim() === ''
      ? 'empty'
      : null;
  if (stderrState !== null) {
    if (terminalStateComplete) {
      failures.push(`cannot rule out size-gated skips: ${stderrLog.path} is ${stderrState}`);
    } else if (terminalStateSkipped) {
      // Log thiếu/rỗng = không có bằng chứng "mọi file đều ngoài phạm vi" → không
      // cấp qua, đường `skipped` fail-closed đúng như đường `complete`.
      failures.push(...terminalStateFailures);
      failures.push(`cannot prove nothing-in-scope: ${stderrLog.path} is ${stderrState}`);
      notes.push(`note: ${stderrLog.path} is ${stderrState}`);
      return { failures, notes, facts };
    } else {
      notes.push(`note: ${stderrLog.path} is ${stderrState}`);
    }
    return { failures, notes, facts };
  }

  const { permitted, ruleFiltered, sizeGated, sizeGatedRollup, unknown } = classifySkips(
    stderrLog.text,
  );
  // Dòng đầu của log mang cả hai con số (`N file(s) changed, reviewing M`):
  // `changed` để đối chiếu giải thích từng file, `selected` để xét điều kiện
  // "reviewing 0" của hợp đồng #391. Không có dòng này thì `selected` là
  // `undefined` — tự động không đủ bằng chứng cấp qua.
  // Lấy cả hai con số từ cùng MỘT dòng selection đầu tiên để `changed` và
  // `reported` không bao giờ lệch nhau. `SELECTION_LINE` mang cờ `m` nên `^`
  // neo vào đầu từng dòng, nhưng vẫn phải lặp qua các dòng vì `RegExp.exec` trên
  // cả chuỗi chỉ trả về *đầu tiên* — và nếu CLI in preamble trước dòng selection
  // thì `exec` trên toàn bộ text vẫn trả về đúng dòng đó (nhờ cờ `m`), nhưng lặp
  // tường minh cho phép dừng ngay tại dòng đầu tiên khớp.
  let firstSelectionMatch = null;
  for (const line of stderrLog.text.split('\n')) {
    const match = SELECTION_LINE.exec(line);
    if (match?.groups) {
      firstSelectionMatch = match;
      break;
    }
  }
  const changed = firstSelectionMatch ? Number(firstSelectionMatch.groups.changed) : null;
  const reported = reportedSelectionCount(stderrLog.text);
  if (reported !== undefined) {
    facts.push(`cli_reported_selected=${reported}`);
  }
  for (const [reason, count] of permitted) {
    notes.push(`skipped by design: ${count} file(s) — ${reason}`);
  }
  if (sizeGated.length > 0) {
    failures.push(
      `review is incomplete: ${sizeGated.length} file(s) were dropped for exceeding the size limit`,
    );
    for (const path of sizeGated.slice(0, 10)) {
      notes.push(`dropped for size: ${path}`);
    }
  } else if (sizeGatedRollup) {
    // Dòng chi tiết không khớp nhưng CLI vẫn báo có file bị loại vì kích thước.
    failures.push('review is incomplete: the CLI pre-filtered file(s) exceeding the size limit');
  }
  if (unknown.length > 0) {
    failures.push(
      `review is incomplete: ${unknown.length} file(s) skipped for an unrecognized reason`,
    );
    for (const item of unknown.slice(0, 10)) {
      notes.push(`skipped (unrecognized reason): ${item}`);
    }
  }

  // File bị bỏ với câu "filtered by path/extension rules" có thể là do policy
  // của repo (`exclude` trong rule) hoặc do allowlist mặc định của CLI. Chỉ
  // policy của repo mới biện minh được cho một file nằm trong chính phạm vi mà
  // rule mở rộng ra: nếu file khớp `include` mà không khớp `exclude` nào, việc
  // bỏ nó nghĩa là rule không còn hiệu lực — đúng lỗi #239 tái diễn trong âm
  // thầm, với một file khác được review để che đi.
  if (ruleFiltered.length > 0) {
    const rule = readRule(rulePath);
    const audit = auditAgainstRule(ruleFiltered, rule, MARKDOWN_EXT);
    facts.push(`rule=${rule.path} loaded=${rule.available}`);
    if (audit.inScope.length > 0) {
      failures.push(
        audit.ruleAvailable
          ? `${audit.inScope.length} file(s) inside the project rule include scope were skipped by path/extension rules: the rule is not in effect for this run`
          : `cannot prove ${audit.inScope.length} skipped file(s) are outside the project rule include scope: ${rule.path} is ${rule.error}`,
      );
      for (const path of audit.inScope.slice(0, 10)) {
        notes.push(`skipped although the rule includes it: ${path}`);
      }
    }
  }

  // Quyết định "nothing in scope" (issue #391) được tính MỘT lần, ở cuối luồng:
  // khi đó các kiểm tra size-gate/unknown đã chạy xong, nên `failures` phản ánh
  // đúng mọi lý do từ chối cấp qua trước khi tôi quyết định số phận lỗi
  // `terminal_state: "skipped"` đã hoãn. Trả về `null` (không đủ bằng chứng) thì
  // lỗi hoãn chính là lỗi fail-closed của đường `skipped` như trước đây.
  if (terminalStateFailures.length > 0) {
    if (terminalStateSkipped) {
      // Grant chỉ dành riêng cho `skipped`: `partial` nghĩa là đã review được
      // một phần diff thật — không bao giờ là "nothing in scope".
      const grant = nothingInScopeEvidence(
        { permitted, ruleFiltered, sizeGated, sizeGatedRollup, unknown },
        reported,
        changed ?? 0,
        {
          failed: failedCoverageCount,
          selected: selectedManifestCount,
          completed: completedManifestCount,
          reused: reusedManifestCount,
        },
        rulePath,
      );
      if (grant !== null) {
        // Cấp qua có điều kiện: chỉ lỗi `terminal_state` được bỏ, mọi lỗi khác
        // (ví dụ budget_exceeded, mismatch coverage) vẫn đỏ như thường.
        notes.push(grant);
      } else {
        failures.push(...terminalStateFailures);
      }
    } else {
      // Mọi terminal state không phải `complete`/`skipped` (vd `partial`) đều
      // nhận lại lỗi đã hoãn: không có nhánh cấp qua nào cho chúng.
      failures.push(...terminalStateFailures);
    }
  }
  return { failures, notes, facts };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    throw error;
  }

  const read = readResult(args.resultPath);
  if (!read.read) {
    process.stdout.write(`[ocr-gate] NOT VERIFIED: ${read.error}\n`);
    process.stdout.write(`::error::AI review result unavailable: ${read.error}\n`);
    return EXIT_UNVERIFIED;
  }

  let stderrText = '';
  let stderrAvailable = true;
  try {
    stderrText = readFileSync(args.stderrPath, 'utf8');
  } catch {
    stderrAvailable = false;
  }

  const { failures, notes, facts } = evaluate(
    read.value,
    {
      text: stderrText,
      available: stderrAvailable,
      path: args.stderrPath,
    },
    args.rulePath,
  );
  for (const fact of facts) {
    process.stdout.write(`[ocr-gate] ${fact}\n`);
  }
  for (const note of notes) {
    process.stdout.write(`[ocr-gate] ${note}\n`);
  }
  if (failures.length > 0) {
    process.stdout.write(`[ocr-gate] NOT VERIFIED: ${failures[0]}\n`);
    for (const failure of failures.slice(1)) {
      process.stdout.write(`[ocr-gate] also: ${failure}\n`);
    }
    process.stdout.write(
      `::error::AI review did not complete: ${failures.join('; ')}. Check the run log and the uploaded ocr-result.json/ocr-stderr.log artifacts.\n`,
    );
    return EXIT_UNVERIFIED;
  }
  const nothingInScope = notes.some((note) => note.startsWith('0 in-scope file(s):'));
  process.stdout.write(
    nothingInScope
      ? '[ocr-gate] VERIFIED: no in-scope file to review under the project rule\n'
      : '[ocr-gate] VERIFIED: the review completed on the selected files\n',
  );
  return EXIT_VERIFIED;
}

process.exitCode = main();
