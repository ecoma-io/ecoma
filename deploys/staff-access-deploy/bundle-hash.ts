/**
 * Hash cây bundle `dist/` — input ForceNew của container WIC
 * (`deploys/staff-access-deploy/index.ts`).
 *
 * Tách khỏi `index.ts` để test được bằng Vitest: `index.ts` là chương trình
 * Pulumi, đánh giá ngay khi import (đọc stack config, dựng resource), nên không
 * thể import từ một spec. Hàm ở đây chỉ đọc filesystem — không Pulumi, không
 * state — nên cùng một input luôn cho cùng một output.
 *
 * ⚠️ **Fail-fast, không "best effort".** Hàm này là thay-đổi-detector: hash
 * thiếu input nghĩa là Pulumi có thể coi container là không đổi trong khi nội
 * dung mount đã đổi (hoặc ngược lại), và lỗi biểu hiện ở nơi khác (entrypoint
 * `wic.fatal: dist_missing`, worker restart loop) với chẩn đoán sai hướng. Vì
 * vậy mọi bất thường — thư mục gốc vắng mặt, thư mục/tệp không đọc được, entry
 * không phải tệp/thư mục thường (symlink, socket) — đều NÉM lỗi kèm đường dẫn
 * tương đối và hành động cần làm. Không bao giờ bỏ qua một phần cây rồi trả
 * hash của phần còn lại.
 */

import * as crypto from 'node:crypto';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import * as path from 'node:path';

/**
 * SHA-256 trên (đường dẫn tương đối, nội dung) của mọi tệp thường dưới
 * `rootDir/relDir`.
 *
 * Định dạng hash: với mỗi tệp theo thứ tự tên đã sort ở từng cấp, cập nhật
 * `relPath`, `\0`, nội dung, `\0`. Tên tệp nằm trong hash nên đổi tên một tệp
 * cũng đổi hash; delimiter `\0` không xuất hiện trong đường dẫn POSIX nên hai
 * cây khác nhau không thể cho cùng chuỗi byte.
 *
 * @param rootDir Thư mục gốc (worktree root) — dùng để dựng đường dẫn tuyệt đối.
 * @param relDir Thư mục tương đối cần hash, ví dụ `apps/staff-access/dist`.
 * @throws {Error} Khi `relDir` không phải đường dẫn tương đối hợp lệ, khi cây
 *   không đọc được, hoặc khi cây chứa entry không phải tệp/thư mục thường.
 *   Message chỉ chứa đường dẫn tương đối + hành động; không chứa nội dung tệp
 *   và không chứa đường dẫn tuyệt đối của worktree.
 */
export function sha256DistTree(rootDir: string, relDir: string): string {
  // `relDir` do caller (chinh deploy unit) cung cap, nhung mot gia tri sai —
  // tuyet doi, co `..`, hoac rong — se hash mot cay NGOAI bundle du dinh va
  // bien ForceNew thanh tin hieu vo nghia. Kiem truoc khi cham filesystem.
  if (relDir === '' || path.isAbsolute(relDir) || relDir.split('/').includes('..')) {
    throw new Error(
      `bundle hash: invalid relative directory "${relDir}": must be a non-empty path inside the worktree without ".." segments`,
    );
  }
  const treeRoot = path.join(rootDir, relDir);
  const hash = crypto.createHash('sha256');
  const files: string[] = [];

  const fail = (action: string, relPath: string, cause?: unknown): never => {
    // Message cua syscall mang duong dan TUYET DOI (`scandir '/…/dist'`).
    // Thay bang duong dan tuong doi de chan doan van du ma khong dua cau
    // truc noi bo cua may chay vao log `pulumi up`.
    const detail =
      cause instanceof Error ? `: ${cause.message.split(rootDir).join('<worktree>')}` : '';
    throw new Error(
      `bundle hash: cannot ${action} "${path.posix.join(relDir, relPath)}"${detail}. ` +
        'Run `pnpm nx run @ecoma-io/staff-access:build` so the mounted dist tree is complete.',
    );
  };

  const readDirectory = (dir: string, relDirPath: string): Dirent[] => {
    try {
      return [...readdirSync(dir, { withFileTypes: true })];
    } catch (error) {
      return fail('list directory', relDirPath, error);
    }
  };

  const readFile = (relFile: string): Buffer => {
    try {
      return readFileSync(path.join(treeRoot, relFile));
    } catch (error) {
      return fail('read file', relFile, error);
    }
  };

  const walk = (dir: string, relDirPath: string): void => {
    // Sort theo tên để thứ tự duyệt — và do đó hash — không phụ thuộc thứ tự
    // readdir của filesystem. `toSorted` chưa có ở target es2020, nên copy rồi
    // sort tại chỗ trên mảng do chính hàm này tạo.
    const entries = [...readDirectory(dir, relDirPath)];
    entries.sort((a, b) => {
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      const relPath = relDirPath === '' ? entry.name : path.posix.join(relDirPath, entry.name);
      if (entry.isDirectory()) {
        walk(filePath, relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      } else {
        // Symlink/socket/thiết bị trong dist là bất thường (bundle do esbuild
        // sinh). Đi theo symlink có thể hash nội dung ngoài cây bundle; bỏ qua
        // là hash một cây KHÔNG đầy đủ. Cả hai đều sai — ném.
        fail('read regular file', relPath);
      }
    }
  };
  walk(treeRoot, '');
  if (files.length === 0) {
    // Cây rỗng là bundle KHÔNG đầy đủ (entrypoint đòi `dist/main.js`): hash của
    // nó không phân biệt được "chưa build" với "build ra rỗng", nên nó là một
    // giá trị trông hợp lệ nhưng vô nghĩa — ném thay vì trả.
    fail('find any bundle file in', '');
  }

  for (const relFile of files) {
    hash.update(relFile);
    hash.update('\0');
    hash.update(readFile(relFile));
    hash.update('\0');
  }
  return hash.digest('hex');
}
