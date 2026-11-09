/**
 * Spec của `sha256DistTree` — input ForceNew của container WIC.
 *
 * Vì sao test ở đây chứ không ở `tools/dx`: hàm sống trong deploy unit sở hữu
 * nó, và contract cần chứng minh là contract của unit đó — (a) cùng một cây cho
 * cùng một hash (nếu không, mỗi `pulumi up` sẽ recreate container vô cớ), (b)
 * đổi nội dung/tên tệp thì hash đổi (nếu không, container chạy bundle cũ), (c)
 * cây thiếu/không đọc được thì NÉM chứ không trả một hash trông hợp lệ.
 *
 * Test chạy trên thư mục tạm thật (không mock `node:fs`): mock sẽ chỉ chứng
 * minh bản mock, còn ba hành vi trên là hành vi của syscall.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sha256DistTree } from './bundle-hash.js';

const REL_DIR = 'apps/staff-access/dist';

describe('sha256DistTree', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'staff-access-bundle-hash-'));
    mkdirSync(join(root, REL_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is deterministic across runs of the same tree', () => {
    // Không xác định được hash ⇒ mỗi lần đánh giá Pulumi program là một diff
    // giả và một lần recreate container.
    writeFileSync(join(root, REL_DIR, 'main.js'), 'export default {};');
    writeFileSync(join(root, REL_DIR, 'package.json'), '{"type":"module"}');

    const first = sha256DistTree(root, REL_DIR);
    const second = sha256DistTree(root, REL_DIR);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
  });

  it('changes when a file content changes', () => {
    // Đây là lý do label ForceNew tồn tại: rebuild bundle phải đổi hash, nếu
    // không container được coi là không đổi và tiếp tục chạy bundle cũ.
    writeFileSync(join(root, REL_DIR, 'main.js'), 'version-one');
    const before = sha256DistTree(root, REL_DIR);

    writeFileSync(join(root, REL_DIR, 'main.js'), 'version-two');
    expect(sha256DistTree(root, REL_DIR)).not.toBe(before);
  });

  it('changes when a file is renamed even though the content is identical', () => {
    // Tên tệp nằm trong hash: esbuild đổi tên chunk là bundle đổi, dù byte y
    // nguyên.
    writeFileSync(join(root, REL_DIR, 'chunk-a.js'), 'same-bytes');
    const before = sha256DistTree(root, REL_DIR);

    rmSync(join(root, REL_DIR, 'chunk-a.js'));
    writeFileSync(join(root, REL_DIR, 'chunk-b.js'), 'same-bytes');
    expect(sha256DistTree(root, REL_DIR)).not.toBe(before);
  });

  it('hashes nested files by their POSIX relative path', () => {
    // Bundle có thể có thư mục con (assets); bỏ sót chúng là hash thiếu input.
    mkdirSync(join(root, REL_DIR, 'assets'));
    writeFileSync(join(root, REL_DIR, 'main.js'), 'main');
    const withoutNested = sha256DistTree(root, REL_DIR);

    writeFileSync(join(root, REL_DIR, 'assets', 'worker.js'), 'asset');
    expect(sha256DistTree(root, REL_DIR)).not.toBe(withoutNested);
  });

  it('ignores files outside the hashed tree', () => {
    writeFileSync(join(root, REL_DIR, 'main.js'), 'main');
    const before = sha256DistTree(root, REL_DIR);

    writeFileSync(join(root, 'outside.js'), 'unrelated');
    expect(sha256DistTree(root, REL_DIR)).toBe(before);
  });

  it('fails loudly when the dist directory is missing', () => {
    // Fail-fast, KHÔNG trả hash của cây rỗng: hash rỗng là giá trị xác định và
    // sẽ khiến Pulumi coi container là không đổi trong khi entrypoint fail
    // `wic.fatal: dist_missing` — chẩn đoán sai hướng.
    rmSync(join(root, REL_DIR), { recursive: true, force: true });
    expect(() => sha256DistTree(root, REL_DIR)).toThrow(/bundle hash: cannot list directory/u);
    expect(() => sha256DistTree(root, REL_DIR)).toThrow(/staff-access:build/u);
  });

  it('fails loudly when the dist path is not a directory', () => {
    rmSync(join(root, REL_DIR), { recursive: true, force: true });
    writeFileSync(join(root, REL_DIR), 'not a directory');
    expect(() => sha256DistTree(root, REL_DIR)).toThrow(/bundle hash: cannot list directory/u);
  });

  it('fails loudly instead of hashing an empty tree', () => {
    expect(() => sha256DistTree(root, REL_DIR)).toThrow(
      /bundle hash: cannot find any bundle file/u,
    );
  });

  it('rejects a symlink inside the bundle instead of following or skipping it', () => {
    // Đi theo symlink hash nội dung ngoài cây bundle; bỏ qua nó hash một cây
    // thiếu. Cả hai đều là hash sai — ném.
    writeFileSync(join(root, 'outside.js'), 'outside');
    writeFileSync(join(root, REL_DIR, 'main.js'), 'main');
    symlinkSync(join(root, 'outside.js'), join(root, REL_DIR, 'linked.js'));
    expect(() => sha256DistTree(root, REL_DIR)).toThrow(
      /cannot read regular file "apps\/staff-access\/dist\/linked\.js"/u,
    );
  });

  it('does not leak file contents into the error message', () => {
    // Message chẩn đoán chỉ được chứa đường dẫn + hành động. Nội dung tệp có
    // thể là bất kỳ thứ gì người dùng cuối đưa vào bundle về sau — không đưa
    // vào log lỗi.
    writeFileSync(join(root, REL_DIR, 'main.js'), 'super-secret-bundle-content');
    symlinkSync(join(root, 'nowhere'), join(root, REL_DIR, 'broken.js'));
    let message = '';
    try {
      sha256DistTree(root, REL_DIR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('broken.js');
    expect(message).not.toContain('super-secret-bundle-content');
  });

  it('keeps the absolute worktree path out of the diagnostic message', () => {
    // Message di vao log `pulumi up`/entrypoint. Duong dan tuyet doi cua
    // worktree la cau truc noi bo cua may chay, khong can cho chan doan —
    // chi duong dan tuong doi trong bundle la du de tim ra tep hong.
    rmSync(join(root, REL_DIR), { recursive: true, force: true });
    let message = '';
    try {
      sha256DistTree(root, REL_DIR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('apps/staff-access/dist');
    expect(message).not.toContain(root);
  });

  it('rejects a relative directory that escapes the worktree', () => {
    // `relDir` do caller cung cap; mot gia tri tuyet doi hoac co `..` se hash
    // mot cay ngoai bundle — ForceNew se bao "khong doi" trong khi bundle da
    // doi (hoac nguoc lai). Tu choi truoc khi cham filesystem.
    for (const bad of ['../outside', '/etc', 'apps/../../outside', '']) {
      expect(() => sha256DistTree(root, bad)).toThrow(/bundle hash: invalid relative directory/u);
    }
  });
});
