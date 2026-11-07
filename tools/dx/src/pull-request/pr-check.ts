import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import load from '@commitlint/load';
import { parse } from '@commitlint/parse';
import { defineCommand } from 'citty';

import { gitEnv, ROOT_DIR } from '../utils.js';

/**
 * Các event của GitHub Actions có payload chứa `pull_request`.
 *
 * Cả hai đều mang cùng một object `pull_request`, nên đọc title không phụ thuộc
 * vào việc workflow khai báo `pull_request` hay `pull_request_target`.
 */
const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

/**
 * Binary commitlint đã cài trong repository.
 *
 * Gọi bằng `process.execPath` chứ không qua `npx`: `npx` có thể rời khỏi
 * `node_modules` local để tìm package khi cache trống, và một lần tìm kiếm như
 * thế là một lần phụ thuộc mạng vào lúc check đang chạy.
 */
const COMMITLINT_CLI = join(ROOT_DIR, 'node_modules/@commitlint/cli/cli.js');

/**
 * Commit id đầy đủ mà GitHub ghi vào payload (`pull_request.*.sha`).
 *
 * Chỉ nhận hex 40 hoặc 64 ký tự: hai giá trị này được ghép thẳng thành range
 * của `git log`, nên một chuỗi không phải commit id phải bị chặn ở đây với lý
 * do rõ ràng thay vì để git trả về một lỗi mơ hồ (hoặc tệ hơn, tôn trọng một
 * cái tên ref do payload đưa vào).
 */
const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/iu;

export interface LintResult {
  /** Exit code 0 của commitlint nghĩa là title hợp lệ. */
  ok: boolean;
  /** Output của commitlint đã trim; rỗng khi không có gì để báo. */
  report: string;
}

/**
 * Kiểm title bằng chính cấu hình commitlint của repository.
 *
 * `commitlint.config.mjs` là source of truth cho Conventional Commits và Nx
 * scope, nên pr-check không viết lại rule nào: nó dựng tiến trình commitlint
 * với stdin là title rồi đọc exit code.
 */
export function lintTitle(title: string): LintResult {
  const result = spawnSync(process.execPath, [COMMITLINT_CLI, '--no-color'], {
    cwd: ROOT_DIR,
    input: `${title}\n`,
    encoding: 'utf8',
  });

  if (result.error) {
    return { ok: false, report: `commitlint could not run: ${result.error.message}` };
  }

  const report = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();

  return { ok: result.status === 0, report };
}

/**
 * Khoảng commit của PR: từ `pull_request.base.sha` tới `pull_request.head.sha`.
 */
export interface CommitRange {
  base: string;
  head: string;
}

export type PullRequestSource =
  | { ok: true; title: string; range: CommitRange }
  | { ok: false; reason: string };

/**
 * Đọc PR từ event payload mà GitHub Actions đã ghi ra đĩa.
 *
 * Title và khoảng development commit đều đến từ `GITHUB_EVENT_PATH` chứ không
 * phải từ đối số của CI: một lệnh gọi trong YAML sẽ lại là chỗ để YAML tự parse
 * payload, và đúng chỗ đó là nơi policy lệch khỏi code. Đọc sai bối cảnh là
 * lỗi, không phải bỏ qua — một lệnh check không đọc được input thì không có
 * quyền báo xanh.
 *
 * Range đến từ SHA của payload chứ không phải từ GitHub API: checkout trong CI
 * (`fetch-depth: 0`) đã mang đủ history, nên việc đối chiếu SHA với git local
 * giữ được tính deterministic và không thêm phụ thuộc mạng.
 */
export function readPullRequest(
  env: NodeJS.ProcessEnv = process.env,
  readEvent: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): PullRequestSource {
  const eventName = env.GITHUB_EVENT_NAME;
  if (!eventName) {
    return {
      ok: false,
      reason:
        'GITHUB_EVENT_NAME is not set; pr-check must run in a GitHub Actions pull_request event.',
    };
  }

  if (!PR_EVENTS.has(eventName)) {
    return {
      ok: false,
      reason: `GITHUB_EVENT_NAME is "${eventName}"; pr-check requires a pull_request event.`,
    };
  }

  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return {
      ok: false,
      reason: 'GITHUB_EVENT_PATH is not set; GitHub did not publish an event payload for this run.',
    };
  }

  let raw: string;
  try {
    raw = readEvent(eventPath);
  } catch (error) {
    return {
      ok: false,
      reason: `cannot read the event payload at ${eventPath}: ${errorMessage(error)}`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: `event payload at ${eventPath} is not valid JSON: ${errorMessage(error)}`,
    };
  }

  const pullRequest = (
    payload as {
      pull_request?: {
        title?: unknown;
        base?: { sha?: unknown };
        head?: { sha?: unknown };
      };
    } | null
  )?.pull_request;

  const title = pullRequest?.title;
  if (typeof title !== 'string' || title.trim() === '') {
    return {
      ok: false,
      reason: `event payload at ${eventPath} has no non-empty pull_request.title.`,
    };
  }

  // Không có SHA thì không xác định được development commits; fail closed thay
  // vì bỏ qua phần kiểm commit và âm thầm cho qua.
  for (const side of ['base', 'head'] as const) {
    const sha = pullRequest?.[side]?.sha;
    if (typeof sha !== 'string') {
      return {
        ok: false,
        reason: `event payload at ${eventPath} has no pull_request.${side}.sha; pr-check cannot determine the development commits.`,
      };
    }
    if (!COMMIT_ID.test(sha)) {
      return {
        ok: false,
        reason: `event payload at ${eventPath} has pull_request.${side}.sha that is not a full commit id: "${sha}".`,
      };
    }
  }

  return {
    ok: true,
    title,
    range: {
      base: pullRequest?.base?.sha as string,
      head: pullRequest?.head?.sha as string,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type CommitListResult = { ok: true; messages: string[] } | { ok: false; reason: string };

/**
 * Liệt kê message của các development commit trong `base..head`.
 *
 * `base..head` chính là tập commit của PR theo định nghĩa của git: reachable
 * từ head nhưng chưa reachable từ base. Với topology mà repository hỗ trợ —
 * nhánh phát triển phân nhánh từ base, có thể tiến xa hơn merge-base khi base
 * mới thêm commit, có thể merge base trở lại — tập này luôn đúng: commit chỉ
 * có trên base không reachable từ head nên không bao giờ lọt vào, và commit
 * của PR không bị loại oan vì chúng chưa ở trên base. Nhờ đó commit của base
 * branch không bao giờ bị nhầm thành development commit, kể cả khi PR đã merge
 * base vào nhánh phát triển; merge commit của PR thì nằm trong range nhưng
 * message của nó không phải Conventional Commit nên không được tính là một
 * development commit hợp lệ.
 *
 * `git log -z --format=%H%x00%B`: NUL là byte duy nhất git cấm trong commit
 * message, nên nó tách field an toàn với body/footer tùy ý; `-z` thay newline
 * kết thúc record bằng NUL để message nhiều dòng không làm vỡ cấu trúc.
 *
 * Mọi thất bại — git không chạy được, SHA không tồn tại, format bất thường —
 * trả `ok: false`: không đọc được history thì không được báo xanh.
 */
export function listDevelopmentCommits(
  range: CommitRange,
  cwd: string = ROOT_DIR,
): CommitListResult {
  if (!COMMIT_ID.test(range.base) || !COMMIT_ID.test(range.head)) {
    return {
      ok: false,
      reason: `development commit range must be two full commit ids, got "${range.base}..${range.head}".`,
    };
  }

  const result = spawnSync(
    'git',
    ['--no-pager', 'log', '--reverse', '-z', '--format=%H%x00%B', `${range.base}..${range.head}`],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: gitEnv() },
  );

  if (result.error) {
    return { ok: false, reason: `git could not run: ${result.error.message}` };
  }

  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}`.trim() || `exit code ${result.status}`;
    return {
      ok: false,
      reason: `git could not read development commits in ${range.base}..${range.head}: ${detail}`,
    };
  }

  const tokens = result.stdout.split('\0');
  if (tokens.at(-1) === '') {
    tokens.pop();
  }
  if (tokens.length % 2 !== 0) {
    return {
      ok: false,
      reason: `git returned an unexpected log format for ${range.base}..${range.head}.`,
    };
  }

  const messages: string[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    messages.push(tokens[index + 1]);
  }

  return { ok: true, messages };
}

type RepositoryConfig = Awaited<ReturnType<typeof load>>;

/**
 * Tải `commitlint.config.mjs` của repository, một lần cho mỗi lần chạy lệnh.
 *
 * Cùng một cấu hình mà `lintTitle` vẫn giao cho tiến trình commitlint chấm điểm,
 * nên việc đọc nó ở đây không mở ra một bộ rule mới.
 */
let repositoryConfig: Promise<RepositoryConfig> | undefined;

function loadRepositoryConfig(): Promise<RepositoryConfig> {
  repositoryConfig ??= load({}, { cwd: ROOT_DIR });

  return repositoryConfig;
}

/**
 * Chọn `parserOpts` đúng như commitlint CLI chọn khi nó chấm title.
 *
 * CLI đọc `parserPreset.parserOpts` từ cấu hình đã load rồi truyền cho parser;
 * pr-check phải truyền đúng object đó. Khác một nhịp là hỏng ngay: preset mặc
 * định của `@commitlint/parse` là angular, còn repository này dùng
 * `conventional-changelog-conventionalcommits`, và hai preset tách `feat(dx)!:` ra
 * kết quả khác nhau — một pr-check tách sai thì chính sách của nó cũng sai.
 */
function selectParserOpts(config: RepositoryConfig): Parameters<typeof parse>[2] {
  const parserOpts = config.parserPreset?.parserOpts;

  return typeof parserOpts === 'object' && parserOpts !== null
    ? (parserOpts as Parameters<typeof parse>[2])
    : undefined;
}

/**
 * Tách field của một message mà commitlint sẽ chấm điểm.
 *
 * Hàm này không phải Conventional Commit parser: grammar thuộc về commitlint,
 * và đây chính là cặp `load` + `parse` mà commitlint CLI dùng, nên pr-check đọc
 * `type`/`scope`/`header` với đúng grammar vừa được chấm điểm thay vì viết một
 * bản grammar thứ hai. Không regex mới, không mô phỏng lại định nghĩa header.
 */
async function parseWithRepositoryPreset(message: string): ReturnType<typeof parse> {
  const config = await loadRepositoryConfig();

  return parse(message, undefined, selectParserOpts(config));
}

/**
 * Chính sách title mà commitlint không thể đảm nhiệm: scope là optional, nhưng
 * nếu có thì phải là đúng MỘT Nx scope.
 *
 * Phần còn lại máy kiểm được ở đây là số scope: commitlint chấm `scope-enum`
 * trên từng phần tách bởi `,` `/` `\`, nên `feat(dx,docs)` vẫn qua được
 * commitlint — số lượng scope chỉ nằm ở chỗ này. Scope rỗng thì không có gì để
 * kiểm: policy của repository cho phép title không scope. Type của title không
 * bị giới hạn: mọi type hợp lệ đều được, và không có bất biến nào về số lượng
 * type trong development commits.
 *
 * Trả về danh sách lỗi; rỗng nghĩa là không vi phạm. Khi header sai dạng thì
 * không có gì để kiểm và commitlint đã báo lỗi syntax từ trước.
 */
export async function checkTitlePolicy(title: string): Promise<string[]> {
  const { type, scope } = await parseWithRepositoryPreset(title);
  if (!type) {
    return [];
  }

  const problems: string[] = [];

  // Scope vắng mặt (hoặc rỗng) là hợp lệ; chỉ scope có giá trị mới phải là
  // đúng một phần — và phần đó có phải Nx project hay không do commitlint
  // `scope-enum` chấm, pr-check không nhân danh Nx project.
  if (scope && scope.trim() !== '' && /[\s,/\\]/u.test(scope)) {
    // commitlint tách scope theo `,` `/` `\` rồi kiểm TỪNG phần trong scope-enum,
    // nên "feat(dx,docs)" hợp lệ trong commitlint — số lượng scope chỉ nằm ở đây.
    problems.push(`PR title must declare exactly one Nx scope, got "${scope}".`);
  }

  return problems;
}

/**
 * Chính sách development commits: không giới hạn số lượng và không kiểm type.
 *
 * Một PR được phép có bất kỳ số lượng development commit nào, bất kể type là
 * gì (`feat`, `fix`, `chore`, `docs`, ...). Hàm này giữ nguyên bước parse để
 * đảm bảo mọi development commit đều đọc được từ git history — nếu không đọc
 * được history thì fail closed, không mặc định là "0 commit vi phạm".
 *
 * Message của từng commit được parse bằng `@commitlint/load` +
 * `@commitlint/parse` với parser preset của repository — cùng grammar mà hook
 * `commit-msg` của commitlint dùng — nên pr-check không có một Conventional
 * Commit parser thứ hai. Tổng số `pull_request.commits` không tham gia: nó chỉ
 * là số đếm, không nói gì về type.
 *
 * Hàm không trả lỗi khi commit không phải feat/fix — repository không có bất
 * biến về số lượng type trong development commits; hàm chỉ báo lỗi khi một
 * message không parse được bằng Conventional Commit grammar.
 */
export async function checkDevelopmentCommits(messages: string[]): Promise<string[]> {
  for (const message of messages) {
    try {
      await parseWithRepositoryPreset(message);
    } catch (error) {
      // Không phân loại được thì không được im lặng cho qua: fail closed.
      return [`pr-check could not parse a development commit: ${errorMessage(error)}`];
    }
  }

  return [];
}

export interface PrCheckDeps {
  /** Bỏ trống thì đọc `process.env`; test truyền env giả vào đây. */
  env?: NodeJS.ProcessEnv;
  /** Bỏ trống thì đọc file thật; test truyền reader giả vào đây. */
  readEvent?: (path: string) => string;
  /** Bỏ trống thì dùng `lintTitle` với commitlint thật. */
  lint?: (title: string) => LintResult;
  /** Bỏ trống thì dùng `listDevelopmentCommits` với git thật; test truyền nguồn commit giả vào đây. */
  listCommits?: (range: CommitRange) => CommitListResult;
}

export type PrCheckResult =
  | { ok: true; title: string }
  | { ok: false; title?: string; problems: string[] };

/**
 * Ghép các bước của PR policy: đọc title và range từ payload, lint title bằng
 * commitlint, áp chính sách scope (optional, có thì đúng một Nx scope), rồi liệt
 * kê development commits từ git local và xác nhận mỗi message parse được. Mọi lỗi
 * được gom lại một lần để một lần chạy báo đủ những gì sai thay vì bắt người
 * chạy sửa từng vòng.
 *
 * Không đọc được development commits (thiếu SHA, git hỏng, range không tồn
 * tại) là lỗi của chính policy: range không xác định được thì fail closed.
 */
export async function checkPullRequest(deps: PrCheckDeps = {}): Promise<PrCheckResult> {
  const source = readPullRequest(deps.env, deps.readEvent);
  if (!source.ok) {
    return { ok: false, problems: [source.reason] };
  }

  const problems: string[] = [];

  const linted = (deps.lint ?? lintTitle)(source.title);
  if (!linted.ok) {
    problems.push(linted.report || 'commitlint rejected the PR title.');
  }
  problems.push(...(await checkTitlePolicy(source.title)));

  const listed = (deps.listCommits ?? listDevelopmentCommits)(source.range);
  if (!listed.ok) {
    problems.push(listed.reason);
  } else {
    problems.push(...(await checkDevelopmentCommits(listed.messages)));
  }

  if (problems.length > 0) {
    return { ok: false, title: source.title, problems };
  }

  return { ok: true, title: source.title };
}

export default defineCommand({
  meta: {
    name: 'pr-check',
    description: 'Check a pull request against repository PR policy',
  },

  async run() {
    const result = await checkPullRequest();

    if (result.ok) {
      console.log(`PR policy check passed: ${result.title}`);
      return;
    }

    console.error(`PR policy check failed${result.title ? `: ${result.title}` : ''}`);
    for (const problem of result.problems) {
      console.error(problem);
    }

    process.exitCode = 1;
  },
});
