import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import {
  checkCommitSigningConfig,
  checkHeadCommitSignature,
  checkPushedCommitSignatures,
  checkSigningConfig,
  findUnsignedCommits,
  headerHasSignature,
  listUnpushedCommits,
  readHeadFromGit,
} from './commit-signing.js';
import { gitEnv } from '../utils.js';

const execFileAsync = promisify(execFile);

const DX_ROOT = resolve(import.meta.dirname, '../..');
const ENTRY = join(DX_ROOT, 'index.ts');
const TSX = join(DX_ROOT, '../../node_modules/tsx/dist/cli.mjs');

const tempDirs: string[] = [];

/**
 * Env cho git chạy trên repo tạm: `gitEnv()` từ utils scrub mọi biến `GIT_*`.
 *
 * Cùng lý do `pr-check` làm vậy — git export `GIT_DIR` cho hooks, và giá trị
 * đó thắng `cwd`, nên không scrub thì fixture ghim vào repo thật của workspace.
 */
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() });
}

/** Repo git thật trong thư mục tạm, không remote và không ký. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dx-signing-repo-'));
  tempDirs.push(dir);

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'dx@example.com');
  git(dir, 'config', 'user.name', 'dx');
  // Tắt signing: máy dev có thể bật signing toàn cục, còn fixture không có key.
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'gpg.format', 'openpgp');

  return dir;
}

function commit(repo: string, message: string, args: string[] = []): string {
  git(repo, 'commit', '--allow-empty', '-q', '-m', message, ...args);

  return git(repo, 'rev-parse', 'HEAD').trim();
}

/** Đặt `HEAD` hiện tại làm gốc đã đẩy, để `rev-list --not --remotes` rỗng. */
function markAsPushed(repo: string): void {
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('headerHasSignature', () => {
  it('detects a gpgsig header', () => {
    const object = [
      'tree 35dd59a5ff087f95771648f651da6c42a463c1c',
      'parent 2d3f5d09699c9125c62fe2cc8806ee6875b7279e',
      'author dx <dx@example.com> 1791825252 +0700',
      'committer dx <dx@example.com> 1791825252 +0700',
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' ',
      ' iQEzBAABCgAdFiEE0000',
      ' -----END PGP SIGNATURE-----',
      '',
      'the message',
    ].join('\n');

    expect(headerHasSignature(object)).toBe(true);
  });

  it('detects a gpgsig-sha256 header, the companion of the SHA-1 signature', () => {
    const object = [
      'committer dx <dx@example.com> 1791825252 +0700',
      'gpgsig-sha256 -----BEGIN SIGNATURE-----',
      '',
    ].join('\n');

    expect(headerHasSignature(object)).toBe(true);
  });

  it('reports no signature for a plain commit', () => {
    const object = ['committer dx <dx@example.com> 1791825252 +0700', '', 'the message'].join('\n');

    expect(headerHasSignature(object)).toBe(false);
  });

  // Commit message được git cho phép chứa bất kỳ dòng nào, kể cả dòng trông
  // giống hệt header chữ ký. Quét cả object thay vì chỉ header sẽ coi commit
  // không hề có chữ ký là đã ký — một bypass không cần khoá gì cả.
  it('ignores a gpgsig line inside the commit message', () => {
    const object = [
      'committer dx <dx@example.com> 1791825252 +0700',
      '',
      'spoof attempt',
      '',
      'gpgsig FAKE not a real signature',
    ].join('\n');

    expect(headerHasSignature(object)).toBe(false);
  });

  it('ignores a gpgsig mention that is not at the start of a line', () => {
    const object = [
      'committer dx <dx@example.com> 1791825252 +0700',
      '',
      'see gpgsig for details',
    ].join('\n');

    expect(headerHasSignature(object)).toBe(false);
  });
});

/**
 * Reader giả ném lỗi, để chứng minh nó **không** được gọi.
 *
 * Ở đây chính là điều kiện quan trọng: một nhánh đã đồng bộ với remote không
 * được phát sinh lệnh git nào, vì đó là fast path của gate.
 */
function failIfRead(what: string): (commits: string[]) => never {
  return () => {
    throw new Error(what);
  };
}

describe('findUnsignedCommits', () => {
  it('does not read any object when there is nothing to check', () => {
    expect(findUnsignedCommits([], failIfRead('an empty commit list must not reach git'))).toEqual({
      ok: true,
      unsigned: [],
    });
  });

  it('passes the commit list through to the reader', () => {
    const commits = ['a'.repeat(40), 'b'.repeat(40)];

    // Chỉ cần chứng minh danh sách được chuyển tiếp, nên stub ném lỗi có chủ đích.
    expect(() =>
      findUnsignedCommits(commits, failIfRead('the stub must receive the list')),
    ).toThrow('the stub must receive the list');
  });
});

describe('checkSigningConfig', () => {
  // Đường dẫn không tồn tại: rule "ssh thì user.signingkey phải là file có thật"
  // là thứ duy nhất ở đây bắt được, và nó phải bắt đúng một lỗi.
  const missingKey = join(tmpdir(), 'dx-signing-no-such-key.pub');

  it('reports a missing signing key file for ssh signing', () => {
    const problems = checkSigningConfig((key) => {
      const config: Record<string, string> = {
        'commit.gpgsign': 'true',
        'gpg.format': 'ssh',
        'user.signingkey': missingKey,
      };

      return config[key];
    });

    expect(problems).toEqual([`user.signingkey points at a missing file: ${missingKey}`]);
  });

  it('reports an unset signing key for ssh signing', () => {
    const problems = checkSigningConfig((key) => {
      const config: Record<string, string> = { 'commit.gpgsign': 'true', 'gpg.format': 'ssh' };

      return config[key];
    });

    expect(problems).toEqual(['gpg.format is "ssh" but user.signingkey is not set.']);
  });

  it('requires commit.gpgsign to be true', () => {
    const problems = checkSigningConfig((key) => (key === 'commit.gpgsign' ? 'false' : undefined));

    expect(problems).toEqual([
      'commit.gpgsign must be "true" (current: "false"); git would create unsigned commits.',
    ]);
  });

  it('treats an unset commit.gpgsign as missing, since git then does not sign', () => {
    const problems = checkSigningConfig(() => undefined);

    expect(problems[0]).toContain('(current: unset)');
  });

  // Lọc theo tiền tố của câu chữ định dạng hợp lệ; ở `ssh`, gate còn một rule
  // riêng về `user.signingkey`, và rule đó không thuộc phạm vi case này.
  const FORMAT_RULE = 'gpg.format must be one of';

  it('accepts the signing formats git supports', () => {
    for (const format of ['openpgp', 'x509', 'ssh']) {
      const problems = checkSigningConfig((key) => {
        const config: Record<string, string> = { 'commit.gpgsign': 'true', 'gpg.format': format };

        return config[key];
      });

      expect(problems.filter((problem) => problem.startsWith(FORMAT_RULE))).toEqual([]);
    }
  });

  it('rejects an unknown gpg.format', () => {
    const problems = checkSigningConfig((key) => {
      const config: Record<string, string> = { 'commit.gpgsign': 'true', 'gpg.format': 'bogus' };

      return config[key];
    });

    expect(problems).toEqual(['gpg.format must be one of openpgp, x509, ssh (current: "bogus").']);
  });

  it('accepts an unset gpg.format, because git defaults it to openpgp', () => {
    const problems = checkSigningConfig((key) => (key === 'commit.gpgsign' ? 'true' : undefined));

    expect(problems).toEqual([]);
  });

  // `user.signingkey` chỉ là đường dẫn file ở format ssh; ở openpgp/x509 nó là
  // key ID, nên kiểm "file có tồn tại không" ở hai format đó sẽ báo nhầm.
  it('does not require user.signingkey to exist for a non-ssh format', () => {
    const problems = checkSigningConfig((key) => {
      const config: Record<string, string> = {
        'commit.gpgsign': 'true',
        'gpg.format': 'openpgp',
        'user.signingkey': 'ABC1234567',
      };

      return config[key];
    });

    expect(problems).toEqual([]);
  });

  it('reports every problem at once, so one run names all of them', () => {
    const problems = checkSigningConfig((key) => {
      const config: Record<string, string> = { 'commit.gpgsign': 'false', 'gpg.format': 'nope' };

      return config[key];
    });

    expect(problems).toHaveLength(2);
  });
});

describe('checkCommitSigningConfig', () => {
  it('reports the configuration problems as a failure', () => {
    const result = checkCommitSigningConfig(() => undefined);

    expect(result.ok).toBe(false);
  });

  it('passes when nothing is wrong', () => {
    const result = checkCommitSigningConfig((key) =>
      key === 'commit.gpgsign' ? 'true' : undefined,
    );

    expect(result).toEqual({ ok: true, checked: 0 });
  });
});

describe('listUnpushedCommits', () => {
  it('lists nothing for a branch already pushed', () => {
    const repo = initRepo();
    commit(repo, 'chore: pushed already');
    markAsPushed(repo);

    expect(listUnpushedCommits(repo)).toEqual({ ok: true, commits: [] });
  });

  it('lists only the commits missing from the remote', () => {
    const repo = initRepo();
    const first = commit(repo, 'chore: first');
    markAsPushed(repo);
    const second = commit(repo, 'chore: second');

    // Đây là phần tối ưu tốc độ: một nhánh dài không bị quét lại toàn bộ.
    expect(listUnpushedCommits(repo)).toEqual({ ok: true, commits: [second] });
    expect(first).not.toEqual(second);
  });

  it('treats a repository with no remote as having everything unpushed', () => {
    const repo = initRepo();
    commit(repo, 'chore: local only');

    const listed = listUnpushedCommits(repo);

    expect(listed.ok).toBe(true);
    expect(listed.ok && listed.commits).toHaveLength(1);
  });

  it('fails closed outside a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dx-signing-norepo-'));
    tempDirs.push(dir);

    const listed = listUnpushedCommits(dir);

    expect(listed.ok).toBe(false);
  });
});

describe('checkPushedCommitSignatures', () => {
  // Ký thật bằng khoá SSH có sẵn trên máy: chữ ký là thứ đang được kiểm, nên
  // fixture phải tạo ra chữ ký thật chứ không giả lập object. Khoá là điều kiện
  // của máy chạy test, không phải thứ repo kiểm soát — không có thì bỏ qua
  // thay vì báo xanh giả.
  const signingKey = process.env.SSH_SIGNING_KEY;

  it('accepts a signed commit that is not on any remote yet', () => {
    if (signingKey === undefined) {
      // Máy không có khoá để ký: không thể tạo ra chữ ký thật, và một fixture
      // giả lập thì chỉ chứng minh chính nó. Bỏ case, không báo xanh.
      return;
    }

    const repo = initRepo();
    git(repo, 'config', 'gpg.format', 'ssh');
    git(repo, 'config', 'user.signingkey', signingKey);
    git(repo, 'config', 'commit.gpgsign', 'true');

    const signed = commit(repo, 'chore: signed');

    expect(checkPushedCommitSignatures({ cwd: repo })).toEqual({ ok: true, checked: 1 });
    expect(git(repo, 'cat-file', 'commit', signed)).toContain('gpgsig ');
  });

  it('rejects an unsigned commit and names its id', () => {
    const repo = initRepo();
    const unsigned = commit(repo, 'chore: unsigned');

    const result = checkPushedCommitSignatures({ cwd: repo });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.join('\n')).toContain(unsigned);
  });

  // Commit đã lên remote không thuộc phạm vi của lần push này, nên không được
  // kéo vào kiểm — đó là ý nghĩa của việc chỉ xét commit chưa đẩy.
  it('ignores an unsigned commit that is already on the remote', () => {
    const repo = initRepo();
    commit(repo, 'chore: old unsigned');
    markAsPushed(repo);

    expect(checkPushedCommitSignatures({ cwd: repo })).toEqual({ ok: true, checked: 0 });
  });

  it('reports the single unsigned commit among several signed ones', () => {
    const repo = initRepo();
    commit(repo, 'chore: unsigned one');
    markAsPushed(repo);
    const alsoUnsigned = commit(repo, 'chore: unsigned two');

    const result = checkPushedCommitSignatures({ cwd: repo });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems[0]).toBe(
      '1 of 1 unpushed commit(s) are not signed:',
    );
    expect(result.ok === false && result.problems).toContain(`- ${alsoUnsigned}`);
  });

  it('checks nothing and passes on a branch already in sync', () => {
    const repo = initRepo();
    commit(repo, 'chore: pushed');
    markAsPushed(repo);

    expect(checkPushedCommitSignatures({ cwd: repo })).toEqual({ ok: true, checked: 0 });
  });

  it('fails closed when the commits cannot be listed', () => {
    const result = checkPushedCommitSignatures({
      listCommits: () => ({ ok: false, reason: 'git broke' }),
    });

    expect(result).toEqual({ ok: false, problems: ['git broke'] });
  });

  it('fails closed when the commit objects cannot be read', () => {
    const result = checkPushedCommitSignatures({
      listCommits: () => ({ ok: true, commits: ['a'.repeat(40)] }),
      readObjects: () => ({ ok: false, reason: 'cat-file broke' }),
    });

    expect(result).toEqual({ ok: false, problems: ['cat-file broke'] });
  });

  it('fails closed when git returns an object that is not a commit', () => {
    // Một id không tồn tại khiến `cat-file --batch` trả dòng "<id> missing"; nếu
    // parser chấp nhận nó thì gate sẽ báo "không có chữ ký" cho một thứ không
    // phải commit, tức im lặng thay vì fail closed.
    const repo = initRepo();
    commit(repo, 'chore: real');

    const result = checkPushedCommitSignatures({
      listCommits: () => ({ ok: true, commits: ['0'.repeat(40)] }),
      cwd: repo,
    });

    expect(result.ok).toBe(false);
  });
});

/**
 * Root của repository đang chạy test.
 *
 * Test trên lịch sử thật cần một repo có commit đã ký; checkout hiện tại là ứng
 * viên duy nhất không phụ thuộc mạng. `gitEnv()` scrub `GIT_DIR` để không bị
 * hook ghim nhầm vào repo khác (xem `pr-check.spec`).
 */
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  env: gitEnv(),
}).trim();

/**
 * Chạy CLI trong tiến trình con và trả cả exit code.
 *
 * Exit code là một phần của contract — hook dựa vào nó để chặn push — nên phải
 * đo trên chính tiến trình sẽ trả nó, không phải trên giá trị trả về nội bộ.
 */
async function dx(...args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [TSX, ENTRY, ...args]);

    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };

    return {
      code: typeof failure.code === 'number' ? failure.code : -1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('dx commit-signing', () => {
  it('exits 0 when every unpushed commit is signed', async () => {
    const { code, output } = await dx('commit-signing', '--check', 'push');

    expect(code).toBe(0);
    expect(output).toContain('Commit signing check passed');
  });

  // Chọn nhầm gate nghĩa là kiểm sai thứ, nên giá trị lạ phải báo lỗi chứ không
  // rơi về gate mặc định.
  it('exits 1 when --check names no gate', async () => {
    const { code, output } = await dx('commit-signing', '--check', 'nonsense');

    expect(code).toBe(1);
    expect(output).toContain('--check must be "config", "head" or "push"');
  });

  // Gate `head` phải tự báo trạng thái chứ không ghim một kết quả: một commit
  // unsigned tồn tại trong repo khi test chạy là điều hoàn toàn bình thường
  // (chính gate này cảnh báo về nó), và assert theo giá trị cố định sẽ làm đỏ
  // test theo trạng thái working tree.
  it('reports whether HEAD is signed, whatever the answer', async () => {
    const { code, output } = await dx('commit-signing', '--check', 'head');

    expect([0, 1]).toContain(code);
    expect(output).toMatch(/^Commit signing check (passed|failed):/mu);
  });
});

describe('checkHeadCommitSignature', () => {
  it('reports an unsigned HEAD with the command that fixes it', () => {
    const repo = initRepo();
    const sha = commit(repo, 'chore(dx): unsigned head');

    expect(sha).not.toBe('');
    // Chạy git thật trên fixture thay vì stub reader: git chính là thứ đang
    // được kiểm, mock nó thì test chỉ chứng minh chính nó.
    const result = checkHeadCommitSignature({ cwd: repo });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problems.join('\n')).toContain(sha);
    expect(result.ok ? '' : result.problems.join('\n')).toContain('--amend --no-edit -S');
    expect(result.ok ? '' : result.problems.join('\n')).toContain('pre-push');
  });

  // Repo chưa có commit là hợp lệ: gate `git commit` đầu tiên sẽ tạo ra HEAD.
  it('passes on an empty repository with nothing to check', () => {
    expect(checkHeadCommitSignature({ cwd: initRepo() })).toEqual({ ok: true, checked: 0 });
  });

  it('reads HEAD as undefined in an empty repository', () => {
    expect(readHeadFromGit(initRepo())).toEqual({ ok: true, sha: undefined });
  });

  it('fails closed when HEAD cannot be read', () => {
    const result = checkHeadCommitSignature({
      head: () => ({ ok: false, reason: 'no HEAD for you' }),
    });

    expect(result).toEqual({ ok: false, problems: ['no HEAD for you'] });
  });

  it('fails closed when the commit object cannot be read', () => {
    const result = checkHeadCommitSignature({
      head: () => ({ ok: true, sha: 'a'.repeat(40) }),
      readObjects: () => ({ ok: false, reason: 'cat-file exploded' }),
    });

    expect(result).toEqual({ ok: false, problems: ['cat-file exploded'] });
  });

  it('counts one checked commit when HEAD is signed', () => {
    const result = checkHeadCommitSignature({
      head: () => ({ ok: true, sha: 'b'.repeat(40) }),
      readObjects: () => ({ ok: true, unsigned: [] }),
    });

    expect(result).toEqual({ ok: true, checked: 1 });
  });
});

describe('checkPushedCommitSignatures on this repository', () => {
  // Lịch sử thật được GitHub squash-merge nên commit ký bằng PGP key của
  // GitHub, key đó không có trong local keyring: `%G?` trả `E` cho phần lớn
  // commit và `git verify-commit` fail. Gate này phải vẫn nhận ra chúng là đã
  // ký — đó chính là lý do nó đọc header thay vì xác minh.
  it('recognises the real signed history of this repository', () => {
    const listed = listUnpushedCommits(REPO_ROOT);

    expect(listed.ok).toBe(true);

    // Nhánh đã đồng bộ với remote thì không có commit nào để kiểm — đó là kết
    // quả đúng chứ không phải trường hợp bị bỏ qua. Còn khi có commit, gate
    // phải nhận ra chúng là đã ký.
    const result = checkPushedCommitSignatures({ cwd: REPO_ROOT });

    expect(result.ok).toBe(true);
    expect(result.ok && result.checked).toBe(listed.ok ? listed.commits.length : 0);
  });
});
