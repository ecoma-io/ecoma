import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import {
  checkDevelopmentCommits,
  checkPullRequest,
  checkTitlePolicy,
  listDevelopmentCommits,
  readPullRequest,
  type CommitRange,
  type LintResult,
} from './pr-check.js';
import { gitEnv } from '../utils.js';

const execFileAsync = promisify(execFile);

const DX_ROOT = resolve(import.meta.dirname, '../..');
const ENTRY = join(DX_ROOT, 'index.ts');
const TSX = join(DX_ROOT, '../../node_modules/tsx/dist/cli.mjs');

/**
 * HEAD của repository thật.
 *
 * Payload `pull_request` luôn mang SHA đầy đủ, nên env fixture cũng phải vậy —
 * `readPullRequest` không nhận một giá trị tạm bợ, và range mặc định
 * `HEAD..HEAD` (0 development commit) để các test title không đụng tới lịch sử.
 */
const HEAD_SHA = execFileSync('git', ['-C', DX_ROOT, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  env: gitEnv(),
}).trim();

const tempDirs: string[] = [];

/** Ghi payload ra file tạm và trả về đúng đường dẫn mà GitHub Actions sẽ đặt. */
function eventFile(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dx-pr-check-'));
  tempDirs.push(dir);

  const path = join(dir, 'event.json');
  const contents = typeof payload === 'string' ? payload : JSON.stringify(payload);
  writeFileSync(path, contents, 'utf8');

  return path;
}

/** Env của một run pull_request hợp lệ trỏ vào payload vừa ghi. */
function prEnv(
  title: string,
  overrides: { base?: string; head?: string; commits?: number } = {},
): NodeJS.ProcessEnv {
  const pullRequest: Record<string, unknown> = {
    title,
    base: { sha: overrides.base ?? HEAD_SHA },
    head: { sha: overrides.head ?? HEAD_SHA },
  };
  if (overrides.commits !== undefined) {
    pullRequest.commits = overrides.commits;
  }

  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventFile({ pull_request: pullRequest }),
  };
}

/** Lint giả: test chỉ nói về policy sẽ không spawn commitlint thêm một lần. */
const lintPasses = (): LintResult => ({ ok: true, report: '' });

/**
 * Env cho git chạy trên repo tạm: `gitEnv()` từ utils scrub mọi biến `GIT_*`.
 *
 * Git export `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` cho hooks (lefthook
 * pre-push chạy suite này), và giá trị đó trỏ vào repo thật của workspace —
 * không scrub thì `git init` của fixture vẫn bị ghim vào repo thật (`GIT_DIR`
 * thắng `cwd`), `checkout -b` đè branch thật và commit fixture rơi vào lịch sử
 * của workspace.
 */
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() });
}

/**
 * Repo git thật trong thư mục tạm.
 *
 * Range của PR là nghiệp vụ của git, nên phần đó phải chứng minh trên git
 * thật chứ không phải trên một bản mô phỏng. `commit.gpgsign` bị tắt vì máy
 * dev có thể bật signing toàn cục mà fixture không có key.
 */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dx-pr-check-repo-'));
  tempDirs.push(dir);

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'dx@example.com');
  git(dir, 'config', 'user.name', 'dx');
  git(dir, 'config', 'commit.gpgsign', 'false');

  return dir;
}

/** Commit một message vào nhánh hiện tại rồi trả về commit id của nó. */
function commit(repo: string, message: string): string {
  git(repo, 'commit', '--allow-empty', '-q', '-m', message);

  return git(repo, 'rev-parse', 'HEAD').trim();
}

/**
 * Tạo topology của một PR: base có commit riêng, nhánh `feature` mang các
 * development commit. Trả về range `base..head` đúng như payload sẽ đưa.
 */
function featureBranch(messages: string[]): { repo: string; range: CommitRange } {
  const repo = initRepo();
  const base = commit(repo, 'chore(dx): base commit');
  git(repo, 'checkout', '-q', '-b', 'feature');
  for (const message of messages) {
    commit(repo, message);
  }

  return { repo, range: { base, head: git(repo, 'rev-parse', 'HEAD').trim() } };
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readPullRequest', () => {
  it('reads the title and the development commit range from the event payload', () => {
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);

    const source = readPullRequest(prEnv('feat(dx): add pr-check', { base, head }));

    expect(source).toEqual({
      ok: true,
      title: 'feat(dx): add pr-check',
      range: { base, head },
    });
  });

  it('fails when GitHub did not publish an event name', () => {
    const source = readPullRequest({
      GITHUB_EVENT_PATH: eventFile({ pull_request: { title: 'feat(dx): x' } }),
    });

    expect(source.ok).toBe(false);
    expect(source).toMatchObject({ reason: expect.stringContaining('GITHUB_EVENT_NAME') });
  });

  it('fails when the event is not a pull request event', () => {
    const source = readPullRequest({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: eventFile({ pull_request: { title: 'feat(dx): x' } }),
    });

    expect(source).toMatchObject({ reason: expect.stringContaining('pull_request') });
  });

  it('fails when GitHub published no event payload path', () => {
    const source = readPullRequest({ GITHUB_EVENT_NAME: 'pull_request' });

    expect(source).toMatchObject({ reason: expect.stringContaining('GITHUB_EVENT_PATH') });
  });

  it('fails when the event payload file does not exist', () => {
    const source = readPullRequest({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: join(tmpdir(), 'dx-pr-check-missing', 'event.json'),
    });

    expect(source).toMatchObject({
      reason: expect.stringContaining('cannot read the event payload'),
    });
  });

  it('fails when the event payload is not JSON', () => {
    const source = readPullRequest({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventFile('not json'),
    });

    expect(source).toMatchObject({ reason: expect.stringContaining('not valid JSON') });
  });

  it('fails when the payload carries no pull request title', () => {
    const source = readPullRequest({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventFile({ pull_request: { number: 1 } }),
    });

    expect(source).toMatchObject({ reason: expect.stringContaining('pull_request.title') });
  });

  it('fails when the pull request title is blank', () => {
    const source = readPullRequest(prEnv('   '));

    expect(source.ok).toBe(false);
  });

  it('fails when the payload carries no base sha', () => {
    // Không có SHA thì không xác định được development commits; thiếu metadata
    // không được xử lý như một range trống.
    const source = readPullRequest({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventFile({
        pull_request: { title: 'feat(dx): x', head: { sha: HEAD_SHA } },
      }),
    });

    expect(source).toMatchObject({
      ok: false,
      reason: expect.stringContaining('pull_request.base.sha'),
    });
  });

  it('fails when the payload carries no head sha', () => {
    const source = readPullRequest({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventFile({
        pull_request: { title: 'feat(dx): x', base: { sha: HEAD_SHA } },
      }),
    });

    expect(source).toMatchObject({
      ok: false,
      reason: expect.stringContaining('pull_request.head.sha'),
    });
  });

  it('fails when a payload sha is not a full commit id', () => {
    const source = readPullRequest(prEnv('feat(dx): x', { base: 'abc123' }));

    expect(source).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not a full commit id'),
    });
  });
});

describe('checkTitlePolicy', () => {
  it('accepts feat and fix carrying exactly one Nx scope', async () => {
    expect(await checkTitlePolicy('feat(dx): add pr-check')).toEqual([]);
    expect(await checkTitlePolicy('fix(dx): correct pr-check')).toEqual([]);
    expect(await checkTitlePolicy('feat(home): add landing page')).toEqual([]);
    expect(await checkTitlePolicy('fix(account): reject malformed locale')).toEqual([]);
    expect(await checkTitlePolicy('feat(dx)!: drop the legacy path')).toEqual([]);
  });

  it('accepts titles that carry no feat or fix at all', async () => {
    // Một PR không phải feature và cũng không phải bug fix vẫn là PR hợp lệ;
    // title của nó có scope thì phải đúng một Nx scope, không scope cũng được.
    // Không có gate type feat/fix nào.
    expect(await checkTitlePolicy('chore(dx): tidy up')).toEqual([]);
    expect(await checkTitlePolicy('docs(dx): update readme')).toEqual([]);
    expect(await checkTitlePolicy('refactor(dx): split the module')).toEqual([]);
    expect(await checkTitlePolicy('ci(dx): refresh workflow')).toEqual([]);
  });

  it('accepts a title with no scope at all', async () => {
    // Scope là optional. Type vẫn phải là Conventional Commit hợp lệ — đó là
    // việc của commitlint, không phải việc của rule này.
    expect(await checkTitlePolicy('chore: update repository tooling')).toEqual([]);
    expect(await checkTitlePolicy('ci: update workflow')).toEqual([]);
    expect(await checkTitlePolicy('docs: update repository docs')).toEqual([]);
    expect(await checkTitlePolicy('refactor: extract the helper')).toEqual([]);
    expect(await checkTitlePolicy('feat: add pr-check')).toEqual([]);
    expect(await checkTitlePolicy('fix: correct pr-check')).toEqual([]);
  });

  it('reads type and scope with the preset commitlint itself uses', async () => {
    // `@commitlint/parse` mặc định là preset angular, nơi dấu `!` làm type thành
    // null nên chính sách sẽ im lặng và title này thoát; repository này lại chấm
    // bằng conventionalcommits, nên nó vẫn phải bị chặn ở số scope.
    expect(await checkTitlePolicy('chore(dx,home)!: drop the legacy path')).toEqual([
      'PR title must declare exactly one Nx scope, got "dx,home".',
    ]);
  });

  it('rejects more than one scope', async () => {
    expect(await checkTitlePolicy('feat(dx,account): add pr-check')).toEqual([
      'PR title must declare exactly one Nx scope, got "dx,account".',
    ]);
    expect(await checkTitlePolicy('feat(dx account): add pr-check')).toEqual([
      'PR title must declare exactly one Nx scope, got "dx account".',
    ]);
    // commitlint chấm `,` và `/` là delimiter của scope-enum rồi kiểm từng phần,
    // nên các title trên đi qua commitlint mà không hỏng — chỉ số lượng scope
    // phải chặn ở đây.
    expect(await checkTitlePolicy('feat(dx/account): add pr-check')).toEqual([
      'PR title must declare exactly one Nx scope, got "dx/account".',
    ]);
  });

  it('stays quiet when the header is not a conventional commit', async () => {
    // Syntax là việc của commitlint; ở đây không có type/scope để kiểm nên
    // không được bịa thêm một lỗi song song.
    expect(await checkTitlePolicy('not a conventional commit')).toEqual([]);
    expect(await checkTitlePolicy('invalid title')).toEqual([]);
  });
});

describe('listDevelopmentCommits', () => {
  it('reads only the PR commits in order, never commits that live only on base', () => {
    // `base..head` phải cho đúng tập commit của PR kể cả khi base đã tiến xa
    // hơn điểm phân nhánh: commit mới của base không reachable từ head nên
    // không lọt vào range, và commit feat của base không bao giờ bị nhầm thành
    // development commit.
    const repo = initRepo();
    commit(repo, 'chore(dx): base one');
    const branchPoint = commit(repo, 'chore(dx): base two');
    git(repo, 'checkout', '-q', '-b', 'feature');
    commit(repo, 'chore(dx): branch work');
    const head = commit(repo, 'docs(dx): more docs');
    git(repo, 'checkout', '-q', 'main');
    const base = commit(repo, 'feat(dx): land an unrelated feature on main');

    const listed = listDevelopmentCommits({ base, head }, repo);

    expect(listed).toEqual({
      ok: true,
      messages: ['chore(dx): branch work\n', 'docs(dx): more docs\n'],
    });
    // Từ điểm phân nhánh range cho cùng tập commit — base..head và
    // merge-base..head không thể phân biệt được với tập reachable từ head.
    expect(listDevelopmentCommits({ base: branchPoint, head }, repo)).toEqual(listed);
  });

  it('excludes base commits even when the feature branch merged the base in', () => {
    // Topology có merge: PR merge main vào feature rồi mới commit tiếp. Range
    // vẫn là `base..head`, merge commit của PR nằm trong range, nhưng commit
    // của base branch thì không — dù nó đã trở thành tổ tiên của head.
    const repo = initRepo();
    commit(repo, 'chore(dx): base one');
    commit(repo, 'chore(dx): base two');
    git(repo, 'checkout', '-q', '-b', 'feature');
    commit(repo, 'chore(dx): branch work');
    git(repo, 'checkout', '-q', 'main');
    const base = commit(repo, 'feat(dx): land an unrelated feature on main');
    git(repo, 'checkout', '-q', 'feature');
    git(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'main' into feature", 'main');
    const head = commit(repo, 'docs(dx): after the merge');

    const listed = listDevelopmentCommits({ base, head }, repo);

    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      throw new Error(listed.reason);
    }
    expect(listed.messages.map((message) => message.trim())).toEqual([
      'chore(dx): branch work',
      "Merge branch 'main' into feature",
      'docs(dx): after the merge',
    ]);
    expect(listed.messages.join('')).not.toContain('land an unrelated feature');
  });

  it('reads a commit message with a body and footer verbatim', () => {
    const repo = initRepo();
    const base = commit(repo, 'chore(dx): base commit');
    git(repo, 'checkout', '-q', '-b', 'feature');
    const head = commit(repo, 'feat(dx): add checker\n\nBody of the commit.\n\nRefs: #42');

    expect(listDevelopmentCommits({ base, head }, repo)).toEqual({
      ok: true,
      messages: ['feat(dx): add checker\n\nBody of the commit.\n\nRefs: #42\n'],
    });
  });

  it('returns an empty list when base and head are the same commit', () => {
    const repo = initRepo();
    const sha = commit(repo, 'chore(dx): only commit');

    expect(listDevelopmentCommits({ base: sha, head: sha }, repo)).toEqual({
      ok: true,
      messages: [],
    });
  });

  it('fails closed when git cannot resolve the range', () => {
    // Range không tồn tại không được coi là "không có commit feat/fix nào".
    const repo = initRepo();
    const head = commit(repo, 'chore(dx): only commit');
    const listed = listDevelopmentCommits({ base: '0'.repeat(40), head }, repo);

    expect(listed).toMatchObject({
      ok: false,
      reason: expect.stringContaining('could not read development commits'),
    });
  });

  it('rejects a range that is not built from full commit ids', () => {
    // Ref name cũng không được: payload của GitHub là SHA, và một range do
    // payload đặt tên thì không có quyền chọn ref cho git.
    const repo = initRepo();
    const head = commit(repo, 'chore(dx): only commit');

    expect(listDevelopmentCommits({ base: 'main', head }, repo)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('full commit ids'),
    });
  });
});

describe('checkDevelopmentCommits', () => {
  it('accepts an empty development history', async () => {
    expect(await checkDevelopmentCommits([])).toEqual([]);
  });

  it('accepts any number of development commits of any type', async () => {
    expect(
      await checkDevelopmentCommits([
        'chore(dx): setup tooling',
        'docs(dx): update docs',
        'refactor(dx): simplify parser',
        'ci(dx): update workflow',
      ]),
    ).toEqual([]);
  });

  it('accepts any number of feat and fix commits together', async () => {
    expect(
      await checkDevelopmentCommits([
        'feat(dx): add checker',
        'docs(dx): document checker',
        'fix(dx): repair checker',
        'feat(dx): add another feature',
        'fix(dx): repair another bug',
      ]),
    ).toEqual([]);
  });

  it('accepts two feat commits', async () => {
    expect(
      await checkDevelopmentCommits(['feat(dx): add first thing', 'feat(dx): add second thing']),
    ).toEqual([]);
  });

  it('accepts two fix commits', async () => {
    expect(
      await checkDevelopmentCommits([
        'fix(dx): repair first thing',
        'fix(dx): repair second thing',
      ]),
    ).toEqual([]);
  });

  it('parses each commit even when messages carry bodies and footers', async () => {
    expect(
      await checkDevelopmentCommits([
        'feat(dx): add checker\n\nBody of the feature commit.\n\nRefs: #1\n',
        'fix(dx): repair checker\n\nBody of the fix commit.\n\nRefs: #2\n',
      ]),
    ).toEqual([]);
  });

  it('parses with the repository parser preset, not the angular default', async () => {
    // Preset angular trả type null cho `feat(dx)!:` nên commit này sẽ không
    // được đếm và kết quả sai là pass; repository dùng conventionalcommits,
    // nên nó phải được đọc đúng và không gây lỗi parse.
    expect(
      await checkDevelopmentCommits([
        'feat(dx)!: drop the legacy path',
        'fix(dx): repair the legacy path',
      ]),
    ).toEqual([]);
  });

  it('ignores messages that are not conventional commits, such as merge commits', async () => {
    expect(
      await checkDevelopmentCommits([
        "Merge branch 'main' into feature",
        'feat(dx): add checker',
        "Merge branch 'main' into feature",
        'not a conventional commit',
      ]),
    ).toEqual([]);
  });
});

describe('checkPullRequest', () => {
  // Những case dưới đây đi qua commitlint thật: chúng kiểm đúng phần pr-check
  // không được viết lại — Conventional Commits syntax và Nx scope.
  it('accepts a valid feat title', async () => {
    const result = await checkPullRequest({ env: prEnv('feat(dx): add pr-check') });

    expect(result).toEqual({ ok: true, title: 'feat(dx): add pr-check' });
  });

  it('accepts a valid fix title', async () => {
    const result = await checkPullRequest({ env: prEnv('fix(dx): correct pr-check') });

    expect(result).toEqual({ ok: true, title: 'fix(dx): correct pr-check' });
  });

  it('accepts a valid feat title scoped to another Nx project', async () => {
    const result = await checkPullRequest({ env: prEnv('feat(home): add landing page') });

    expect(result).toEqual({ ok: true, title: 'feat(home): add landing page' });
  });

  it('accepts a valid fix title scoped to another Nx project', async () => {
    const result = await checkPullRequest({
      env: prEnv('fix(account): reject malformed locale'),
    });

    expect(result).toEqual({ ok: true, title: 'fix(account): reject malformed locale' });
  });

  it('rejects invalid conventional commit syntax', async () => {
    const result = await checkPullRequest({ env: prEnv('not a conventional commit') });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ problems: [expect.stringContaining('type-empty')] });
  });

  it('rejects a scope that is not an Nx project', async () => {
    const result = await checkPullRequest({ env: prEnv('feat(no-such-project): add pr-check') });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ problems: [expect.stringContaining('scope-enum')] });
  });

  it('accepts a chore title that carries no feat or fix', async () => {
    const result = await checkPullRequest({ env: prEnv('chore(dx): tidy up') });

    expect(result).toEqual({ ok: true, title: 'chore(dx): tidy up' });
  });

  it('accepts a docs title that carries no feat or fix', async () => {
    const result = await checkPullRequest({ env: prEnv('docs(dx): update readme') });

    expect(result).toEqual({ ok: true, title: 'docs(dx): update readme' });
  });

  it('accepts a refactor title that carries no feat or fix', async () => {
    const result = await checkPullRequest({ env: prEnv('refactor(dx): split the module') });

    expect(result).toEqual({ ok: true, title: 'refactor(dx): split the module' });
  });

  it('rejects several Nx scopes even though commitlint accepts them', async () => {
    // scope-enum tách theo `,` và kiểm từng phần, nên title này hợp lệ với
    // commitlint; chỉ policy của pr-check mới chặn được nó.
    const result = await checkPullRequest({ env: prEnv('feat(dx,home): add pr-check') });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ problems: [expect.stringContaining('exactly one Nx scope')] });
  });

  it('rejects a slash-separated scope even though commitlint accepts it', async () => {
    const result = await checkPullRequest({ env: prEnv('feat(dx/home): add pr-check') });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ problems: [expect.stringContaining('exactly one Nx scope')] });
  });

  it('rejects a space-separated scope that commitlint cannot resolve either', async () => {
    // commitlint chấm "dx docs" là MỘT scope, không thấy trong scope-enum nên nó
    // đã báo lỗi trước; pr-check vẫn phải báo thêm lỗi số lượng scope của mình.
    const result = await checkPullRequest({ env: prEnv('feat(dx docs): add pr-check') });

    expect(result).toMatchObject({
      ok: false,
      problems: [
        expect.stringContaining('scope-enum'),
        expect.stringContaining('exactly one Nx scope'),
      ],
    });
  });

  it('reads the development commit range from the payload SHAs', async () => {
    // Range phải đến từ base/head của payload — không phải từ
    // `pull_request.commits`, và cũng không phải suy ra từ title.
    const ranges: CommitRange[] = [];
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);

    const result = await checkPullRequest({
      env: prEnv('chore(dx): tidy up', { base, head, commits: 42 }),
      lint: lintPasses,
      listCommits: (range) => {
        ranges.push(range);

        return { ok: true, messages: [] };
      },
    });

    expect(result).toEqual({ ok: true, title: 'chore(dx): tidy up' });
    expect(ranges).toEqual([{ base, head }]);
  });

  it('accepts a PR whose development commits contain one feat', async () => {
    const result = await checkPullRequest({
      env: prEnv('chore(dx): tidy up'),
      lint: lintPasses,
      listCommits: () => ({
        ok: true,
        messages: ['chore(dx): setup', 'feat(dx): add checker', 'docs(dx): document checker'],
      }),
    });

    expect(result).toEqual({ ok: true, title: 'chore(dx): tidy up' });
  });

  it('accepts a PR whose development commits mix feat and fix', async () => {
    // Không còn bất invariant feat/fix: nhiều feat/fix cùng hợp lệ.
    const result = await checkPullRequest({
      env: prEnv('docs(dx): tidy up'),
      lint: lintPasses,
      listCommits: () => ({
        ok: true,
        messages: ['feat(dx): add checker', 'fix(dx): repair checker'],
      }),
    });

    expect(result).toEqual({ ok: true, title: 'docs(dx): tidy up' });
  });

  it('fails closed when the development commits cannot be read', async () => {
    // Không đọc được history không được mặc định là "0 commit feat/fix".
    const result = await checkPullRequest({
      env: prEnv('chore(dx): tidy up'),
      lint: lintPasses,
      listCommits: () => ({
        ok: false,
        reason: 'git could not read development commits in base..head: fatal',
      }),
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      problems: [expect.stringContaining('could not read development commits')],
    });
  });

  it('reads development commits from git history, not from pull_request.commits count', async () => {
    // Tổng số commit trong payload không nói gì về type — chỉ số lượng commit
    // trong git history được đọc, và số lượng đó không còn ảnh hưởng kết quả.
    const claimsOne = await checkPullRequest({
      env: prEnv('feat(dx): add checker', { commits: 1 }),
      lint: lintPasses,
      listCommits: () => ({
        ok: true,
        messages: ['feat(dx): add first thing', 'fix(dx): repair second thing'],
      }),
    });

    expect(claimsOne).toEqual({ ok: true, title: 'feat(dx): add checker' });

    // Payload nói 42 commit nhưng không có feat/fix nào → hợp lệ.
    const claimsFortyTwo = await checkPullRequest({
      env: prEnv('chore(dx): tidy up', { commits: 42 }),
      lint: lintPasses,
      listCommits: () => ({
        ok: true,
        messages: Array.from({ length: 42 }, (_, index) => `chore(dx): commit ${index + 1}`),
      }),
    });

    expect(claimsFortyTwo).toEqual({ ok: true, title: 'chore(dx): tidy up' });
  });

  it('passes a PR whose 42 development commits carry no feat or fix', async () => {
    // Số lượng development commit không tham gia policy — 40+
    // commit thuần chore/docs vẫn là PR hợp lệ.
    const { repo, range } = featureBranch(
      Array.from({ length: 42 }, (_, index) => `chore(dx): development commit ${index + 1}`),
    );

    const result = await checkPullRequest({
      env: prEnv('chore(dx): tidy up', range),
      lint: lintPasses,
      listCommits: (commitRange) => listDevelopmentCommits(commitRange, repo),
    });

    expect(result).toEqual({ ok: true, title: 'chore(dx): tidy up' });
  });

  it('passes a PR whose 42 development commits contain feat and fix', async () => {
    // Không còn bất invariant feat/fix: 42 commit gồm feat và fix vẫn hợp lệ.
    const messages = Array.from(
      { length: 42 },
      (_, index) => `chore(dx): development commit ${index + 1}`,
    );
    messages[1] = 'feat(dx): add the checker';
    messages[40] = 'fix(dx): repair the checker';
    const { repo, range } = featureBranch(messages);

    const result = await checkPullRequest({
      env: prEnv('chore(dx): tidy up', range),
      lint: lintPasses,
      listCommits: (commitRange) => listDevelopmentCommits(commitRange, repo),
    });

    expect(result).toEqual({ ok: true, title: 'chore(dx): tidy up' });
  });

  it('applies the PR policy on top of a title commitlint already accepted', async () => {
    // lint giả để test này chỉ nói về phần policy, không spawn commitlint thêm
    // một lần nữa cho một rule mà checkTitlePolicy đã kiểm riêng. Title chứa
    // multi-scope hợp lệ với commitlint (`scope-enum` tách theo `,`), nên phần
    // policy phải là thứ duy nhất chặn nó.
    const result = await checkPullRequest({
      env: prEnv('feat(dx,home): add pr-check'),
      lint: lintPasses,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ problems: [expect.stringContaining('exactly one Nx scope')] });
  });

  it('accepts an unscoped PR title end to end', async () => {
    // Title không scope được phép; commitlint `scope-enum` vẫn chấm (scope rỗng
    // thì trả `[true, …]`), và checkTitlePolicy không còn phạt thiếu scope.
    const result = await checkPullRequest({ env: prEnv('chore: update repository tooling') });

    expect(result).toEqual({ ok: true, title: 'chore: update repository tooling' });
  });

  it('fails without a GitHub pull request context', async () => {
    const result = await checkPullRequest({ env: {} });

    expect(result).toEqual({
      ok: false,
      problems: [expect.stringContaining('GITHUB_EVENT_NAME')],
    });
  });
});

/**
 * Chạy CLI trong tiến trình con: exit code là một phần của contract nên phải
 * đo trên chính tiến trình sẽ trả nó, không phải trên giá trị trả về nội bộ.
 *
 * GitHub cho phép unset một biến env bằng `undefined`; dựng object mới chỉ
 * chứa biến có giá trị thay vì `delete` key động.
 */
async function prCheck(env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync('node', [TSX, ENTRY, 'pr-check'], {
      env: childEnv,
    });

    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };

    return {
      code: typeof failure.code === 'number' ? failure.code : -1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('dx pr-check', () => {
  it('exits 0 when the PR satisfies the policy', async () => {
    const { code, output } = await prCheck(prEnv('feat(dx): add pr-check'));

    expect(code).toBe(0);
    expect(output).toContain('PR policy check passed');
  });

  it('exits 1 when the PR title violates the policy', async () => {
    const { code, output } = await prCheck(prEnv('feat(dx,home): add pr-check'));

    expect(code).toBe(1);
    expect(output).toContain('PR policy check failed');
    expect(output).toContain('exactly one Nx scope');
  });

  it('exits 1 when git cannot read the development commit range', async () => {
    // Fail closed qua toàn bộ CLI: range không tồn tại thì không có quyền xanh,
    // dù title có hợp lệ đến đâu.
    const { code, output } = await prCheck(prEnv('chore(dx): tidy up', { base: '0'.repeat(40) }));

    expect(code).toBe(1);
    expect(output).toContain('git could not read development commits');
  });

  it('exits 1 when there is no GitHub pull request context', async () => {
    const { code, output } = await prCheck({
      GITHUB_EVENT_NAME: undefined,
      GITHUB_EVENT_PATH: undefined,
    });

    expect(code).toBe(1);
    expect(output).toContain('GITHUB_EVENT_NAME');
  });
});
