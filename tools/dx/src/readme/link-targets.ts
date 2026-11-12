/**
 * Phân loại và resolve đích của một link Markdown trong README.
 *
 * Ngữ nghĩa đã chọn (khớp cách GitHub render repo content):
 * - Link tương đối (`./x`, `../x`, `x`) resolve từ THƯ MỤC của README.
 * - Link root-relative (`/x`) resolve từ ROOT của repository — GitHub render
 *   `/x` từ repo root của repository chứa file, không phải từ thư mục file.
 * - Percent-encoding được decode theo từng phần sau khi tách anchor: split trên
 *   `#` thô TRƯỚC khi decode, vì `%23` là `#` literal trong tên file chứ không
 *   phải dấu bắt đầu anchor. Chuỗi percent không hợp lệ (vd `%zz`) được giữ
 *   nguyên như GitHub — GitHub cũng render literal thay vì bỏ link.
 * - Anchor (`#slug`) không tự resolve được ở đây: chỉ tách và trả về cho checker
 *   đối chiếu với heading của file đích bằng `headingSlugs` (github-slugger).
 * - Link vào một THƯ MỤC là hợp lệ khi thư mục tồn tại (GitHub mở tree view);
 *   thư mục không thể mang anchor, nên `dir#anchor` là broken.
 *
 * An toàn trên mọi filesystem:
 * - Resolve đi theo từng segment qua `readdir` và so khớp TUYỆT ĐỐI (exact
   match) trước, rồi mới so khớp lowercase: segment gõ sai case là broken
 *   `case-mismatch` kể cả khi mount case-insensitive cho nó qua — check phải đúng
 *   trên case-sensitive filesystem (Linux/CI) mà không âm thầm pass trên macOS.
 * - Traversal từ đi (`../../..` ra ngoài workspace) bị chặn ở bước lexical
 *   TRƯỚC khi chạm filesystem — không có fs operation nào chạy trên đường dẫn
 *   nằm ngoài workspace.
 * - Symlink được resolve bằng realpath của đích cuối; đích thật nằm ngoài
 *   workspace là broken `symlink-escapes-workspace`, kể cả khi đường dẫn lexical
 *   nhìn vào trong.
 *
 * Link ngoài (`http:`, `https:`, `mailto:`, scheme tuỳ ý) chỉ được NHẬN DIỆN —
 * không bao giờ được fetch; toàn bộ module này không có đường network nào.
 */

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Kết quả phân loại một đích link. */
export type LinkResolution =
  | { kind: 'external'; url: string }
  /** `[text](#)` hoặc `[text]()` — trỏ về chính trang hiện tại, luôn hợp lệ. */
  | { kind: 'page-top' }
  /** `[text](#anchor)` — checker phải đối chiếu `anchor` với slug của chính README. */
  | { kind: 'self-anchor'; anchor: string }
  | { kind: 'file'; absPath: string; anchor?: string }
  | { kind: 'directory'; absPath: string }
  | { kind: 'broken'; code: string; message: string; hint: string };

/** URI scheme bất kỳ (`http:`, `https:`, `mailto:`, `tel:`, ...) — khi đó là link ngoài. */
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;

/**
 * Decode một phần của link. Percent-encoding không hợp lệ (vd `%zz`, `%` trôi)
 * được giữ nguyên: GitHub render literal tương tự, nên một file tên thật chứa
 * `%` không bị báo oan.
 */
function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Đường dẫn nằm trong workspace (so sánh lexical trên đường dẫn đã realpath). */
function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/** Đường dẫn hiển thị trong diagnostics: tương đối repo root khi nằm trong workspace. */
export function displayPath(absPath: string, workspaceRoot: string): string {
  if (isInside(absPath, workspaceRoot)) {
    const rel = relative(workspaceRoot, absPath);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }
  return absPath;
}

/** Bối cảnh resolve dùng chung cho cả một lần chạy checker. */
export interface ResolutionContext {
  /** Realpath của thư mục chứa README đang xét. */
  readmeDir: string;
  /** Realpath của repo root — gốc để chặn traversal và so containment. */
  workspaceRoot: string;
  /**
   * Cache `readdir` theo thư mục, chia sẻ giữa mọi link của lần chạy: resolve
   * đi theo segment nên cùng một thư mục được đọc lại nhiều lần; cache giữ cho
   * lần chạy đầy đủ workspace nằm gọn trong mục tiêu warm < 1s.
   */
  readdirCache: Map<string, readonly string[]>;
}

function readdirCached(ctx: ResolutionContext, dir: string): readonly string[] {
  const cached = ctx.readdirCache.get(dir);
  if (cached) return cached;
  const entries = readdirSync(dir);
  ctx.readdirCache.set(dir, entries);
  return entries;
}

/**
 * Đi theo từng segment của đường dẫn tương đối từ `base`, so khớp case tuyệt đối
 * qua listing thư mục. Trả về đường dẫn tuyệt đối ứng viên, hoặc broken khi một
 * segment không tồn tại / sai case / cha không phải thư mục.
 */
function walkSegments(
  ctx: ResolutionContext,
  base: string,
  segments: readonly string[],
): { absPath: string } | { broken: true; code: string; message: string; hint: string } {
  let current = base;
  for (const segment of segments) {
    if (segment === '..') {
      current = dirname(current);
      continue;
    }
    let entries: readonly string[];
    try {
      entries = readdirCached(ctx, current);
    } catch (error) {
      const notDirectory = (error as NodeJS.ErrnoException).code === 'ENOTDIR';
      return {
        broken: true,
        code: notDirectory ? 'parent-not-directory' : 'target-not-found',
        message: notDirectory
          ? `path segment "${displayPath(current, ctx.workspaceRoot)}" is not a directory`
          : `path segment "${displayPath(current, ctx.workspaceRoot)}" does not exist`,
        hint: 'point the link at a path that exists relative to the README (or to the repository root for "/..." links)',
      };
    }
    const exact = entries.find((entry) => entry === segment);
    if (exact !== undefined) {
      current = join(current, exact);
      continue;
    }
    // So khớp lowercase chỉ để CHẨN ĐOÁN sai case — không bao giờ dùng làm đích.
    const caseMatch = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
    if (caseMatch !== undefined) {
      return {
        broken: true,
        code: 'case-mismatch',
        message: `path segment "${segment}" matches on-disk entry "${caseMatch}" only case-insensitively`,
        hint: `use the on-disk casing "${caseMatch}"; the check compares paths case-sensitively so it is correct on every filesystem`,
      };
    }
    return {
      broken: true,
      code: 'target-not-found',
      message: `link target does not exist: no entry "${segment}" in "${displayPath(current, ctx.workspaceRoot)}"`,
      hint: 'point the link at a path that exists relative to the README (or to the repository root for "/..." links)',
    };
  }
  return { absPath: current };
}

/**
 * Resolve đích thô của một link (inline hoặc definition) thành `LinkResolution`.
 * Không bao giờ ném lỗi: mọi thất bại đều là `broken` kèm code, message, hint.
 */
export function resolveLinkTarget(rawTarget: string, ctx: ResolutionContext): LinkResolution {
  const trimmed = rawTarget.trim();

  // Link ngoài: nhận diện và dừng — không fetch, không đụng filesystem.
  if (URI_SCHEME.test(trimmed)) {
    return { kind: 'external', url: trimmed };
  }

  // Tách anchor trên `#` thô, TRƯỚC decode — `%23` là `#` trong tên file.
  const hashIndex = trimmed.indexOf('#');
  const rawPath = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const rawAnchor = hashIndex === -1 ? undefined : trimmed.slice(hashIndex + 1);
  const anchor = rawAnchor === undefined ? undefined : decodePart(rawAnchor);

  const decodedPath = decodePart(rawPath);

  if (decodedPath === '') {
    if (anchor === undefined || anchor === '') return { kind: 'page-top' };
    return { kind: 'self-anchor', anchor };
  }

  // Root-relative resolve từ repo root, dùng join để `/etc/passwd` không thoát
  // lexical base — `/...` trên GitHub luôn là đường dẫn trong repository.
  const rootRelative = decodedPath.startsWith('/');
  const base = rootRelative ? ctx.workspaceRoot : ctx.readmeDir;
  const relPath = rootRelative ? decodedPath.slice(1) : decodedPath;

  // Chặn traversal lexical TRƯỚC filesystem: đích tính được nằm ngoài workspace
  // thì không đọc gì cả.
  const lexical = resolve(base, relPath);
  if (!isInside(lexical, ctx.workspaceRoot)) {
    return {
      kind: 'broken',
      code: 'path-escapes-workspace',
      message: `link target "${trimmed}" resolves outside the repository workspace`,
      hint: 'remove the extra "../" hops so the link stays inside the repository',
    };
  }

  const segments = relPath.split('/').filter((segment) => segment !== '' && segment !== '.');
  const walked = walkSegments(ctx, base, segments);
  if ('broken' in walked) return { kind: 'broken', ...walked };

  let realPath: string;
  try {
    // Symlink chain được resolve tại đây: đích THẬT phải nằm trong workspace.
    realPath = realpathSync(walked.absPath);
  } catch {
    return {
      kind: 'broken',
      code: 'target-not-found',
      message: `link target "${trimmed}" does not exist`,
      hint: 'point the link at a path that exists relative to the README (or to the repository root for "/..." links)',
    };
  }

  if (!isInside(realPath, ctx.workspaceRoot)) {
    return {
      kind: 'broken',
      code: 'symlink-escapes-workspace',
      message: `link target "${trimmed}" resolves (through a symlink) to "${realPath}" outside the repository workspace`,
      hint: 'link to the in-repository path directly instead of going through a symlink that leaves the workspace',
    };
  }

  let stats;
  try {
    stats = statSync(realPath);
  } catch {
    return {
      kind: 'broken',
      code: 'target-not-found',
      message: `link target "${trimmed}" is not a readable file or directory`,
      hint: 'point the link at a path that exists relative to the README (or to the repository root for "/..." links)',
    };
  }

  if (stats.isDirectory()) {
    if (anchor !== undefined && anchor !== '') {
      return {
        kind: 'broken',
        code: 'anchor-on-directory',
        message: `link target "${trimmed}" is a directory and cannot carry an anchor`,
        hint: 'link to a Markdown file for an anchor, or drop the "#..." part to link to the directory',
      };
    }
    return { kind: 'directory', absPath: realPath };
  }

  if (!stats.isFile()) {
    return {
      kind: 'broken',
      code: 'unsupported-target-type',
      message: `link target "${trimmed}" is not a regular file or directory`,
      hint: 'link to a regular file or a directory inside the repository',
    };
  }

  return { kind: 'file', absPath: realPath, anchor };
}

/**
 * Filename Markdown cho việc validate anchor: chỉ `.md`/`.mdx` có heading slug
 * để đối chiếu; đích không Markdown mang anchor là unsupported (không âm thầm pass).
 */
export function isMarkdownFile(absPath: string): boolean {
  const lower = absPath.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx');
}
