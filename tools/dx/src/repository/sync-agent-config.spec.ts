import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncAgentConfig } from './sync-agent-config.js';
import { gitEnv, ROOT_DIR } from '../utils.js';

/**
 * Mọi cây thư mục test đều là một git repository thật (`git init`), vì
 * `syncAgentConfig` resolve repo root và gọi `git check-ignore` qua shell.
 *
 * Git spawn trong fixture dùng `gitEnv()` từ utils để scrub mọi biến `GIT_*`:
 * lefthook pre-push chạy suite này với `GIT_DIR` trỏ vào repo thật của
 * workspace, và giá trị đó thắng `cwd` — không scrub thì `git init` của fixture
 * ghim vào repo thật và mọi kiểm tra ignore chạy nhầm trên workspace.
 */

async function repo(shape: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dx-sync-'));

  for (const [relativePath, contents] of Object.entries(shape)) {
    const full = join(root, relativePath);

    if (relativePath.endsWith('/')) {
      await mkdir(full, { recursive: true });
    } else {
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, contents, 'utf8');
    }
  }

  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', env: gitEnv() });

  return root;
}

async function makeDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });

  return path;
}

const roots: string[] = [];
const extraDirs: string[] = [];
const logs: string[] = [];

/** Dựng repo và ghi nhớ để dọn ở afterEach. */
async function makeRepo(shape: Record<string, string>): Promise<string> {
  const root = await repo(shape);
  roots.push(root);

  return root;
}

async function makeTempDir(prefix = 'dx-sync-out-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  extraDirs.push(dir);

  return dir;
}

/**
 * Mọi đường dẫn tương đối bên trong `root`, trừ `.git`.
 *
 * Trả về dạng object để có thể `toEqual` theo nội dung bất kể thứ tự duyệt của
 * `readdir` — không cần sort (`.sort` bị linter cấm, `.toSorted` cần lib es2023
 * mà dx không dùng).
 */
async function listTree(root: string): Promise<Record<string, true>> {
  const found: Record<string, true> = {};

  const walk = async (dir: string, base: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (base === '' && entry.name === '.git') {
        continue;
      }

      const relativePath = base === '' ? entry.name : `${base}/${entry.name}`;
      found[relativePath] = true;

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(join(dir, entry.name), relativePath);
      }
    }
  };

  await walk(root, '');

  return found;
}

/**
 * Ảnh chụp trạng thái để so sánh giữa hai lần chạy: path, loại và mtime.
 *
 * Cũng là dạng object (không cần sort), kèm mtime để phát hiện file bị ghi lại.
 */
async function snapshot(root: string): Promise<Record<string, true>> {
  const lines: Record<string, true> = {};

  const walk = async (dir: string, base: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (base === '' && entry.name === '.git') {
        continue;
      }

      const relativePath = base === '' ? entry.name : `${base}/${entry.name}`;
      const full = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        lines[`${relativePath} symlink`] = true;
        continue;
      }

      if (entry.isDirectory()) {
        lines[`${relativePath} dir`] = true;
        await walk(full, relativePath);
      } else {
        const info = await stat(full);
        lines[`${relativePath} file ${String(info.size)} ${String(info.mtimeMs)}`] = true;
      }
    }
  };

  await walk(root, '');

  return lines;
}

describe('syncAgentConfig - skills synchronization', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map((value) => String(value)).join(' '));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    logs.splice(0);
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    await Promise.all(extraDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('copies nested skills and their supporting resources, not only SKILL.md', async () => {
    const root = await makeRepo({
      '.agents/skills/demo/SKILL.md': '# demo\n',
      '.agents/skills/demo/references/notes.md': 'notes\n',
      '.agents/skills/demo/assets/logo.txt': 'logo\n',
      '.agents/skills/other/SKILL.md': '# other\n',
    });

    await syncAgentConfig(root);

    const expected = {
      demo: true,
      'demo/SKILL.md': true,
      'demo/assets': true,
      'demo/assets/logo.txt': true,
      'demo/references': true,
      'demo/references/notes.md': true,
      other: true,
      'other/SKILL.md': true,
    };

    expect(await listTree(join(root, '.claude/skills'))).toEqual(expected);
    expect(await listTree(join(root, '.opencode/skills'))).toEqual(expected);
  });

  it('mirrors content exactly', async () => {
    const root = await makeRepo({
      '.agents/skills/demo/SKILL.md': '# demo\n',
      '.agents/skills/demo/references/notes.md': 'notes\n',
    });

    await syncAgentConfig(root);

    for (const dest of ['.claude/skills', '.opencode/skills']) {
      expect(await readFile(join(root, dest, 'demo/references/notes.md'), 'utf8')).toBe('notes\n');
    }
  });

  it('writes to both destinations even though they are gitignored', async () => {
    // Chỉ cây nguồn tôn trọng .gitignore; đích là output sinh tự động nên việc
    // nó bị bỏ qua không được chặn ghi.
    const root = await makeRepo({
      '.gitignore': '.claude/skills/\n.opencode/skills/\n',
      '.agents/skills/demo/SKILL.md': '# demo\n',
    });

    await syncAgentConfig(root);

    expect(existsSync(join(root, '.claude/skills/demo/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.opencode/skills/demo/SKILL.md'))).toBe(true);
  });

  it('updates changed files and removes stale destination files and directories', async () => {
    const root = await makeRepo({
      '.agents/skills/demo/SKILL.md': 'v1\n',
      '.agents/skills/demo/references/notes.md': 'notes\n',
    });

    await syncAgentConfig(root);

    // Đổi nội dung nguồn, bỏ một cây con, rồi bồi thêm entry thừa vào đích.
    await writeFile(join(root, '.agents/skills/demo/SKILL.md'), 'v2\n', 'utf8');
    await rm(join(root, '.agents/skills/demo/references'), { recursive: true, force: true });
    for (const dest of ['.claude/skills', '.opencode/skills']) {
      await makeDir(join(root, dest, 'demo/stale-dir'));
      await writeFile(join(root, dest, 'demo/stale-dir/x.md'), 'x\n', 'utf8');
      await writeFile(join(root, dest, 'demo/stale.md'), 'x\n', 'utf8');
    }

    await syncAgentConfig(root);

    for (const dest of ['.claude/skills', '.opencode/skills']) {
      expect(await readFile(join(root, dest, 'demo/SKILL.md'), 'utf8')).toBe('v2\n');
      expect(existsSync(join(root, dest, 'demo/references'))).toBe(false);
      expect(existsSync(join(root, dest, 'demo/stale-dir'))).toBe(false);
      expect(existsSync(join(root, dest, 'demo/stale.md'))).toBe(false);
    }
  });

  it('replaces a destination file that collides with a source directory', async () => {
    const root = await makeRepo({ '.agents/skills/demo/SKILL.md': '# demo\n' });

    await makeDir(join(root, '.claude/skills'));
    await writeFile(join(root, '.claude/skills/demo'), 'a file where a dir belongs\n', 'utf8');

    await syncAgentConfig(root);

    const info = await lstat(join(root, '.claude/skills/demo'));

    expect(info.isDirectory()).toBe(true);
    expect(existsSync(join(root, '.claude/skills/demo/SKILL.md'))).toBe(true);
  });

  it('preserves the existing destination when .agents/skills is absent', async () => {
    const root = await makeRepo({ 'svc/AGENTS.md': 'rules\n' });

    for (const dest of ['.claude/skills', '.opencode/skills']) {
      await makeDir(join(root, dest, 'demo'));
      await writeFile(join(root, dest, 'demo/SKILL.md'), 'keep me\n', 'utf8');
    }

    await syncAgentConfig(root);

    for (const dest of ['.claude/skills', '.opencode/skills']) {
      expect(await readFile(join(root, dest, 'demo/SKILL.md'), 'utf8')).toBe('keep me\n');
    }

    expect(logs.some((line) => line.includes('.agents/skills') && /skip/iu.test(line))).toBe(true);
  });

  it('empties the destination for an existing but empty source directory', async () => {
    const root = await makeRepo({
      '.agents/skills/': '',
      '.claude/skills/demo/SKILL.md': 'stale\n',
      '.opencode/skills/demo/SKILL.md': 'stale\n',
    });

    await syncAgentConfig(root);

    expect(await listTree(join(root, '.claude/skills'))).toEqual({});
    expect(await listTree(join(root, '.opencode/skills'))).toEqual({});
  });

  it('creates an empty destination for an existing but empty source directory', async () => {
    const root = await makeRepo({ '.agents/skills/': '' });

    await syncAgentConfig(root);

    for (const dest of ['.claude/skills', '.opencode/skills']) {
      expect(await listTree(join(root, dest))).toEqual({});
      expect((await stat(join(root, dest))).isDirectory()).toBe(true);
    }
  });

  it('skips gitignored source files and directories', async () => {
    const root = await makeRepo({
      '.gitignore': 'ignored-dir/\n.agents/skills/demo/secret.md\n',
      '.agents/skills/demo/SKILL.md': '# demo\n',
      '.agents/skills/demo/secret.md': 'shh\n',
      '.agents/skills/ignored-dir/a.md': 'a\n',
    });

    await syncAgentConfig(root);

    for (const dest of ['.claude/skills', '.opencode/skills']) {
      expect(existsSync(join(root, dest, 'demo/SKILL.md'))).toBe(true);
      expect(existsSync(join(root, dest, 'demo/secret.md'))).toBe(false);
      expect(existsSync(join(root, dest, 'ignored-dir'))).toBe(false);
    }
  });

  it('does not follow a file symlink that escapes the source tree', async () => {
    const root = await makeRepo({ '.agents/skills/demo/SKILL.md': '# demo\n' });
    const outside = await makeTempDir();
    await writeFile(join(outside, 'secret.md'), 'secret\n', 'utf8');
    await symlink(join(outside, 'secret.md'), join(root, '.agents/skills/demo/link.md'));

    await syncAgentConfig(root);

    expect(existsSync(join(root, '.claude/skills/demo/link.md'))).toBe(false);
    expect(existsSync(join(root, '.opencode/skills/demo/link.md'))).toBe(false);
    expect(logs.some((line) => line.includes('skipped symlink'))).toBe(true);
  });

  it('does not follow a directory symlink', async () => {
    const root = await makeRepo({ '.agents/skills/demo/SKILL.md': '# demo\n' });
    const outside = await makeTempDir();
    await makeDir(join(outside, 'hidden'));
    await writeFile(join(outside, 'hidden/x.md'), 'x\n', 'utf8');
    await symlink(join(outside, 'hidden'), join(root, '.agents/skills/demo/linked'));

    await syncAgentConfig(root);

    expect(existsSync(join(root, '.claude/skills/demo/linked'))).toBe(false);
    expect(existsSync(join(root, '.opencode/skills/demo/linked'))).toBe(false);
  });

  it('refuses a symlinked .claude instead of writing and deleting outside the repository', async () => {
    const root = await makeRepo({ '.agents/skills/demo/SKILL.md': '# demo\n' });
    const outside = await makeTempDir();
    await makeDir(join(outside, 'skills/important-skill'));
    await writeFile(join(outside, 'skills/important-skill/data.md'), 'keep\n', 'utf8');
    await symlink(outside, join(root, '.claude'));

    // Chuỗi path `.claude/skills` trông như nằm trong repository, nhưng thao tác
    // thật sẽ rơi vào `outside` — phải từ chối thay vì ghi/xoá ở đó.
    await expect(syncAgentConfig(root)).rejects.toThrow(/symbolic link/u);

    expect(existsSync(join(outside, 'skills/important-skill/data.md'))).toBe(true);
    expect(existsSync(join(outside, 'skills/demo'))).toBe(false);
    expect(existsSync(join(root, '.opencode'))).toBe(false);
  });

  it('refuses a symlinked .agents/skills source root instead of following it', async () => {
    const root = await makeRepo({});
    const outside = await makeTempDir();
    await makeDir(join(outside, 'demo'));
    await writeFile(join(outside, 'demo/SKILL.md'), '# demo\n', 'utf8');
    await makeDir(join(root, '.agents'));
    await symlink(outside, join(root, '.agents', 'skills'));

    await expect(syncAgentConfig(root)).rejects.toThrow(/symbolic link/u);

    expect(existsSync(join(root, '.claude'))).toBe(false);
  });

  it('handles names that merely start with two dots', async () => {
    // `..data` là tên hợp lệ, không phải đường dẫn thoát ra ngoài. Nếu phép kiểm
    // tra dùng `startsWith('..')` thì entry này bị từ chối lúc dọn, và vì
    // `repo-prepare` chạy trong `pnpm prepare` nên cả bước chuẩn bị sẽ hỏng.
    const root = await makeRepo({
      '.agents/skills/..data/x.md': 'x\n',
      '.claude/skills/..stale/y.md': 'y\n',
    });

    await syncAgentConfig(root);

    for (const dest of ['.claude/skills', '.opencode/skills']) {
      expect(existsSync(join(root, dest, '..data/x.md'))).toBe(true);
      expect(existsSync(join(root, dest, '..stale'))).toBe(false);
    }
  });

  it('runs repeatedly without rewriting or removing anything on the second run', async () => {
    const root = await makeRepo({
      'svc/AGENTS.md': 'rules\n',
      '.agents/skills/demo/SKILL.md': '# demo\n',
      '.agents/skills/demo/references/notes.md': 'notes\n',
    });

    await syncAgentConfig(root);
    const before = await snapshot(root);

    logs.splice(0);
    await syncAgentConfig(root);

    expect(await snapshot(root)).toEqual(before);
    expect(logs.filter((line) => /created|copied|updated|removed/u.test(line))).toEqual([]);
  });
});

describe('syncAgentConfig - failure handling', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map((value) => String(value)).join(' '));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    logs.splice(0);
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    await Promise.all(extraDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reports a directory that is not a git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dx-sync-plain-'));
    extraDirs.push(root);
    await writeFile(join(root, 'AGENTS.md'), 'rules\n', 'utf8');

    await expect(syncAgentConfig(root)).rejects.toThrow(/git repository root/u);
  });

  it('surfaces a git invocation failure instead of treating it as "not ignored"', async () => {
    const root = await makeRepo({ '.agents/skills/demo/SKILL.md': '# demo\n' });

    // Lần chạy đầu resolve và nhớ repo root; phá `.git` rồi chạy lại khiến
    // `git check-ignore` trả exit code khác 0 và 1 — đó phải là lỗi thật, chứ
    // không bị đọc thành "không bị bỏ qua".
    await syncAgentConfig(root);
    await rm(join(root, '.git'), { recursive: true, force: true });

    await expect(syncAgentConfig(root)).rejects.toThrow(/check-ignore failed/u);
  });

  // Chạy dưới root thì quyền bị bỏ qua, nên kiểm tra này vô nghĩa.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'surfaces a permission error instead of swallowing it',
    async () => {
      const root = await makeRepo({ '.agents/skills/demo/SKILL.md': '# demo\n' });
      const dest = await makeDir(join(root, '.claude/skills'));

      await chmod(dest, 0o500);
      try {
        await expect(syncAgentConfig(root)).rejects.toThrow(/EACCES|permission/u);
      } finally {
        await chmod(dest, 0o700);
      }
    },
  );

  it('leaves nothing behind when both sources are missing', async () => {
    const root = await makeRepo({ 'svc/AGENTS.md': 'rules\n' });
    const before = await listTree(root);

    await syncAgentConfig(root);

    // Không có nguồn nào trong `.agents/` thì không đích nào được tạo — và đặc
    // biệt là không còn file `CLAUDE.md` nào được sinh.
    expect(await listTree(root)).toEqual(before);
    expect(existsSync(join(root, '.claude'))).toBe(false);
    expect(existsSync(join(root, '.opencode'))).toBe(false);
    expect(existsSync(join(root, 'svc/CLAUDE.md'))).toBe(false);
  });

  it('logs paths relative to the processed directory, not to ROOT_DIR', async () => {
    // `syncAgentConfig` nhận `dir` để test và để tái sử dụng; đường dẫn trong log
    // phải theo chính `dir` đó, nếu không một lần chạy trên cây ngoài workspace sẽ
    // in ra chuỗi `../../..` vô nghĩa.
    const root = await makeRepo({ '.agents/skills/demo/SKILL.md': '# demo\n' });

    await syncAgentConfig(root);

    expect(logs).toContain('copied .claude/skills/demo/SKILL.md');
    expect(logs).toContain('copied .opencode/skills/demo/SKILL.md');
    expect(logs.some((line) => line.includes('..'))).toBe(false);
  });

  it('keeps ROOT_DIR out of the removal path', async () => {
    // Không có `.agents/skills` trong repo tạm: bản sao dọn dẹp phải không bao
    // giờ chạm tới gì ngoài `.claude/skills` của repo đang xử lý.
    const root = await makeRepo({ 'svc/AGENTS.md': 'rules\n' });

    // Trạng thái `.claude/skills` của repo thật được chụp lại thay vì giả định
    // nó luôn vắng mặt: spec CLI ở `index.spec.ts` cố ý chạy sync-agent-config
    // thật trên ROOT_DIR, nên artifact đó có thể tồn tại sẵn tuỳ thứ tự chạy.
    // Điều cần chứng minh là lần chạy này không tạo, xoá hay đổi nó.
    const generated = [
      '.claude/skills',
      '.claude/agents',
      '.opencode/skills',
      '.opencode/agents',
    ].map((label) => join(ROOT_DIR, ...label.split('/')));
    const existedBefore = generated.map((path) => existsSync(path));

    await syncAgentConfig(root);

    expect(relative(ROOT_DIR, root).startsWith('..')).toBe(true);
    expect(generated.map((path) => existsSync(path))).toEqual(existedBefore);
  });
});

describe('syncAgentConfig - agent definitions', () => {
  const REVIEWER = [
    '---',
    'name: reviewer',
    'description: Review code without changing it',
    'tools: Read, Grep, Bash',
    'model: claude-sonnet-5-5',
    '---',
    'You are a reviewer.',
    '',
  ].join('\n');

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map((value) => String(value)).join(' '));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    logs.splice(0);
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    await Promise.all(extraDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('generates one definition per target', async () => {
    const root = await makeRepo({ '.agents/agents/reviewer.md': REVIEWER });

    await syncAgentConfig(root);

    for (const dest of ['.claude/agents', '.opencode/agents']) {
      expect(await listTree(join(root, dest))).toEqual({ 'reviewer.md': true });
    }
  });

  it('carries every declared field and the prompt into the Claude definition', async () => {
    const root = await makeRepo({ '.agents/agents/reviewer.md': REVIEWER });

    await syncAgentConfig(root);

    const contents = await readFile(join(root, '.claude/agents/reviewer.md'), 'utf8');

    expect(contents).toContain('name: "reviewer"');
    expect(contents).toContain('description: "Review code without changing it"');
    expect(contents).toContain('tools: "Read, Grep, Bash"');
    expect(contents).toContain('model: "claude-sonnet-5-5"');
    expect(contents.endsWith('You are a reviewer.\n')).toBe(true);
  });

  it('gives OpenCode a subagent mode, permission rules and no Claude-only keys', async () => {
    const root = await makeRepo({ '.agents/agents/reviewer.md': REVIEWER });

    await syncAgentConfig(root);

    const contents = await readFile(join(root, '.opencode/agents/reviewer.md'), 'utf8');

    expect(contents).not.toContain('name:');
    expect(contents).not.toContain('tools:');
    expect(contents).toContain('mode: subagent');
    expect(contents).toContain('description: "Review code without changing it"');
    expect(contents.endsWith('You are a reviewer.\n')).toBe(true);
  });

  it('puts the catch-all deny before the allowed actions', async () => {
    // OpenCode áp rule khai báo sau thắng rule khai báo trước, nên thứ tự này là
    // thứ duy nhất thực sự giới hạn quyền của agent.
    const root = await makeRepo({
      '.agents/agents/reviewer.md': [
        '---',
        'name: reviewer',
        'description: Review only',
        'tools: Read, Grep',
        '---',
        'Prompt.',
        '',
      ].join('\n'),
    });

    await syncAgentConfig(root);

    const contents = await readFile(join(root, '.opencode/agents/reviewer.md'), 'utf8');
    const deny = contents.indexOf('effect: deny');
    const allow = contents.indexOf('effect: allow');

    expect(deny).toBeGreaterThan(-1);
    expect(deny).toBeLessThan(allow);
    expect(contents).toContain('action: "read"');
    expect(contents).toContain('action: "grep"');
    expect(contents).not.toContain('action: "shell"');
  });

  it('leaves permissions out when the source declares no tools', async () => {
    const root = await makeRepo({
      '.agents/agents/helper.md': [
        '---',
        'name: helper',
        'description: Inherits the default tool access',
        '---',
        'Prompt.',
        '',
      ].join('\n'),
    });

    await syncAgentConfig(root);

    expect(await readFile(join(root, '.opencode/agents/helper.md'), 'utf8')).not.toContain(
      'permissions:',
    );
  });

  it('accepts tools as a YAML list', async () => {
    const root = await makeRepo({
      '.agents/agents/reader.md': [
        '---',
        'name: reader',
        'description: Reads only',
        'tools:',
        '  - Read',
        '  - Glob',
        '---',
        'Prompt.',
        '',
      ].join('\n'),
    });

    await syncAgentConfig(root);

    expect(await readFile(join(root, '.claude/agents/reader.md'), 'utf8')).toContain(
      'tools: "Read, Glob"',
    );
  });

  it('warns and omits a model alias OpenCode cannot resolve', async () => {
    const root = await makeRepo({
      '.agents/agents/quick.md': [
        '---',
        'name: quick',
        'description: Uses a Claude alias',
        'model: sonnet',
        '---',
        'Prompt.',
        '',
      ].join('\n'),
    });

    await syncAgentConfig(root);

    expect(await readFile(join(root, '.claude/agents/quick.md'), 'utf8')).toContain(
      'model: "sonnet"',
    );
    expect(await readFile(join(root, '.opencode/agents/quick.md'), 'utf8')).not.toContain('model:');
    expect(logs.some((line) => line.includes('provider/model'))).toBe(true);
  });

  it('removes definitions that no longer exist in the source', async () => {
    const root = await makeRepo({ '.agents/agents/reviewer.md': REVIEWER });
    await syncAgentConfig(root);

    // Nguồn còn tồn tại nhưng rỗng là trạng thái hợp lệ, khác với nguồn vắng
    // mặt: nó có nghĩa là không còn agent nào, nên đích phải được dọn.
    await rm(join(root, '.agents/agents'), { recursive: true, force: true });
    await makeDir(join(root, '.agents/agents'));

    await syncAgentConfig(root);

    expect(existsSync(join(root, '.claude/agents/reviewer.md'))).toBe(false);
    expect(existsSync(join(root, '.opencode/agents/reviewer.md'))).toBe(false);
  });

  it('preserves both destinations when .agents/agents is absent', async () => {
    const root = await makeRepo({});
    for (const dest of ['.claude/agents', '.opencode/agents']) {
      await makeDir(join(root, dest));
      await writeFile(join(root, dest, 'hand.md'), 'keep me\n', 'utf8');
    }

    await syncAgentConfig(root);

    for (const dest of ['.claude/agents', '.opencode/agents']) {
      expect(await readFile(join(root, dest, 'hand.md'), 'utf8')).toBe('keep me\n');
    }

    expect(logs.some((line) => line.includes('.agents/agents') && /skip/iu.test(line))).toBe(true);
  });

  it('rejects a definition without frontmatter', async () => {
    const root = await makeRepo({ '.agents/agents/broken.md': 'no frontmatter\n' });

    await expect(syncAgentConfig(root)).rejects.toThrow(/missing YAML frontmatter/u);
  });

  it('rejects a name that does not match the file name', async () => {
    const root = await makeRepo({
      '.agents/agents/reviewer.md': [
        '---',
        'name: other',
        'description: Mismatched name',
        '---',
        'Prompt.',
        '',
      ].join('\n'),
    });

    await expect(syncAgentConfig(root)).rejects.toThrow(/must match the file name/u);
  });

  it('rejects an unknown frontmatter key', async () => {
    const root = await makeRepo({
      '.agents/agents/reviewer.md': [
        '---',
        'name: reviewer',
        'description: Has an extra key',
        'mode: subagent',
        '---',
        'Prompt.',
        '',
      ].join('\n'),
    });

    await expect(syncAgentConfig(root)).rejects.toThrow(/unsupported frontmatter key "mode"/u);
  });

  it('rejects an empty tools list instead of generating a tool-less agent', async () => {
    const root = await makeRepo({
      '.agents/agents/locked.md': [
        '---',
        'name: locked',
        'description: Declares tools but names none',
        'tools: ""',
        '---',
        'Prompt.',
        '',
      ].join('\n'),
    });

    // `tools:` rỗng từng sinh `tools: ""` cho Claude và chỉ một catch-all `deny`
    // cho OpenCode — hai kết quả khác nhau từ cùng một nguồn mơ hồ. Bỏ hẳn key là
    // cách duy nhất để nói "giữ bộ tool mặc định".
    await expect(syncAgentConfig(root)).rejects.toThrow(/names no tool/u);
  });

  it('skips non-.md entries in the source instead of failing the whole sync', async () => {
    const root = await makeRepo({
      '.agents/agents/reviewer.md': REVIEWER,
      '.agents/agents/.gitkeep': '',
      '.agents/agents/notes.txt': 'not an agent\n',
    });

    await syncAgentConfig(root);

    for (const dest of ['.claude/agents', '.opencode/agents']) {
      expect(await listTree(join(root, dest))).toEqual({ 'reviewer.md': true });
    }

    expect(logs.some((line) => line.includes('not a .md agent definition'))).toBe(true);
  });

  it('rejects an unknown tool instead of silently dropping it', async () => {
    const root = await makeRepo({
      '.agents/agents/reviewer.md': [
        '---',
        'name: reviewer',
        'description: Typo in tools',
        'tools: Read, Bashe',
        '---',
        'Prompt.',
        '',
      ].join('\n'),
    });

    await expect(syncAgentConfig(root)).rejects.toThrow(/unknown tool "Bashe"/u);
  });
});
