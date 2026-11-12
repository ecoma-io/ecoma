/**
 * Orchestrator của readme-check: duyệt từng Nx project và áp toàn bộ contract.
 *
 * Mỗi project đi qua bốn lớp kiểm trên đúng một file — `README.md` tại project
 * root trả về bởi project graph:
 *
 * 1. **File-level** — tồn tại, là file thường (symlink là finding: nội dung của
 *    một symlink được quản ở chỗ khác và có thể đổi mà không qua history của
 *    project), không rỗng.
 * 2. **Contract heading** — H1 duy nhất và sáu section H2 bắt buộc có nội dung
 *    (`readme-contract.ts`).
 * 3. **Cú pháp không hỗ trợ** — mọi construct parser không diễn giải được cho
 *    việc extract link thành finding cứng (`unparseable-markdown`,
 *    `unsupported-syntax`), không bao giờ skip lặng lẽ.
 * 4. **Link** — mọi link nội bộ resolve được: đường dẫn (case-sensitive theo
 *    segment, traversal + symlink phải nằm trong workspace), anchor đối chiếu
 *    heading của file đích theo GitHub slug rules. Link ngoài chỉ đếm, không
 *    bao giờ fetch.
 *
 * Một vi phạm = một finding gắn với dòng gây ra nó; kết quả được sort tất định
 * (project → file → dòng → code → message) nên hai lần chạy cùng workspace cho
 * cùng một output byte-for-byte.
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ROOT_DIR } from '../utils.js';
import { headingSlugs } from './anchor-slugs.js';
import {
  isMarkdownFile,
  resolveLinkTarget,
  displayPath,
  type ResolutionContext,
} from './link-targets.js';
import { parseMarkdown, splitLines } from './markdown-ast.js';
import type { ParsedMarkdown } from './markdown-ast-types.js';
import { sortFindings, type ReadmeCheckResult, type ReadmeFinding } from './findings.js';
import { checkHeadingContract } from './readme-contract.js';
import type { ReadmeTarget } from './project-graph.js';

/** Tuỳ chọn chạy checker; mặc định lấy workspace từ vị trí của tools/dx. */
export interface CheckReadmesOptions {
  /** Repo root; bỏ trống thì dùng `ROOT_DIR` suy ra từ vị trí file. */
  workspaceRoot?: string;
}

/** Cache parse + slug của một file Markdown đích, dùng cho validate anchor. */
interface CachedTarget {
  slugs?: ReadonlySet<string>;
  /** Lỗi đọc/parse file đích — mọi anchor trỏ vào nó đều broken, không âm thầm pass. */
  error?: { code: string; message: string; hint: string };
}

/** Cache dùng chung của một lần chạy: readdir cho resolve, parse cho anchor-target. */
interface RunShared {
  readdirCache: Map<string, readonly string[]>;
  anchorTargets: Map<string, CachedTarget>;
}

function fileLevelFinding(
  target: ReadmeTarget,
  readmeRelative: string,
  code: string,
  message: string,
  hint: string,
): ReadmeFinding {
  return { project: target.name, file: readmeRelative, line: 0, code, message, hint };
}

/**
 * Đọc và parse một file Markdown để đối chiếu anchor. Cache theo realpath: hai
 * project khác nhau trỏ cùng một file (vd hai README cùng link một doc) parse
 * đúng một lần.
 */
function anchorTargetFor(shared: RunShared, absPath: string, workspaceRoot: string): CachedTarget {
  const cached = shared.anchorTargets.get(absPath);
  if (cached) return cached;

  let result: CachedTarget;
  try {
    const source = readFileSync(absPath, 'utf8');
    const parsed = parseMarkdown(source);
    result = { slugs: headingSlugs(parsed.headings) };
  } catch (error) {
    result = {
      error: {
        code: 'anchor-target-unreadable',
        message: `cannot analyze the anchor target "${displayPath(absPath, workspaceRoot)}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        hint: 'fix the target file so it is readable Markdown; the checker refuses to pass an anchor it cannot verify',
      },
    };
  }
  shared.anchorTargets.set(absPath, result);
  return result;
}

/** Kiểm toàn bộ contract trên README của một project; trả về findings của project đó. */
function checkProject(
  target: ReadmeTarget,
  shared: RunShared,
  workspaceRoot: string,
): { findings: ReadmeFinding[]; externalLinks: number } {
  const findings: ReadmeFinding[] = [];
  const readmeRelative = `${target.root}/README.md`;
  const readmeAbsolute = join(workspaceRoot, target.root, 'README.md');

  let stats;
  try {
    // lstat (không theo symlink) để phân biệt file thường với symlink.
    stats = lstatSync(readmeAbsolute);
  } catch {
    findings.push(
      fileLevelFinding(
        target,
        readmeRelative,
        'missing-readme',
        `no README.md exists at the project root "${target.root}"`,
        `create "${readmeRelative}" with one H1 and the six required H2 sections`,
      ),
    );
    return { findings, externalLinks: 0 };
  }

  if (stats.isSymbolicLink()) {
    findings.push(
      fileLevelFinding(
        target,
        readmeRelative,
        'symlinked-readme',
        'README.md is a symlink, not a regular file',
        'replace the symlink with a regular file owned by the project',
      ),
    );
    return { findings, externalLinks: 0 };
  }

  if (!stats.isFile()) {
    findings.push(
      fileLevelFinding(
        target,
        readmeRelative,
        'readme-not-a-file',
        'README.md exists but is not a regular file',
        'remove the non-file entry at the project root and add a regular README.md',
      ),
    );
    return { findings, externalLinks: 0 };
  }

  const source = readFileSync(readmeAbsolute, 'utf8');
  if (source.length === 0) {
    findings.push(
      fileLevelFinding(
        target,
        readmeRelative,
        'empty-readme',
        'README.md is empty',
        'write the project README: one H1 and the six required H2 sections',
      ),
    );
    return { findings, externalLinks: 0 };
  }

  let parsed: ParsedMarkdown;
  try {
    parsed = parseMarkdown(source);
  } catch (error) {
    findings.push(
      fileLevelFinding(
        target,
        readmeRelative,
        'unparseable-markdown',
        `README.md cannot be parsed as Markdown: ${error instanceof Error ? error.message : String(error)}`,
        'fix the Markdown syntax; the checker refuses to pass content it cannot analyze',
      ),
    );
    return { findings, externalLinks: 0 };
  }

  // Thư mục chứa README đã realpath — base cho mọi link tương đối của project này.
  // Cache readdir được chia sẻ qua các project; chỉ `readmeDir` là của riêng project.
  const readmeDir = dirname(readmeAbsolute);
  const resolutionCtx: ResolutionContext = {
    readmeDir: realpathSync(readmeDir),
    workspaceRoot,
    readdirCache: shared.readdirCache,
  };

  for (const violation of checkHeadingContract(parsed, splitLines(source))) {
    findings.push({
      project: target.name,
      file: readmeRelative,
      line: violation.line,
      code: violation.code,
      message: violation.message,
      hint: violation.hint,
    });
  }

  // Cú pháp parser không diễn giải được — finding cứng từng dòng, không skip lặng lẽ.
  for (const construct of parsed.unsupported) {
    findings.push({
      project: target.name,
      file: readmeRelative,
      line: construct.line,
      code: 'unsupported-syntax',
      message: `unsupported Markdown construct: ${construct.detail}`,
      hint: 'rewrite the construct with plain Markdown link/heading syntax the checker can verify',
    });
  }

  const ownSlugs = headingSlugs(parsed.headings);
  let externalLinks = 0;

  for (const link of parsed.links) {
    // Reference-style: đích thật nằm trong definition; finding vẫn gắn với DÒNG
    // của reference — chỗ người đọc nhấp vào link.
    let rawTarget = link.target;
    const line = link.line;
    if (link.kind === 'reference') {
      const definition = parsed.definitions.get(link.target);
      // Reference KHÔNG có definition không phải link: CommonMark (và GitHub
      // theo CommonMark) render `[doc][missing]` thành văn bản thường. Báo
      // nó là link hỏng sẽ oan — README thật của repository chứa các cụm như
      // `[A-Za-z0-9][A-Za-z0-9_-]` trong prose (mẫu regex) và chúng KHÔNG
      // phải link. micromark đã quyết định phần này: một reference không có
      // definition không xuất hiện trong AST.
      if (!definition) continue;
      rawTarget = definition.target;
    }

    const resolution = resolveLinkTarget(rawTarget, resolutionCtx);
    if (resolution.kind === 'external') {
      // Link ngoài: đếm để tổng kết, KHÔNG fetch — không có network trong checker.
      externalLinks++;
      continue;
    }
    if (resolution.kind === 'page-top') continue;
    if (resolution.kind === 'directory') continue;

    if (resolution.kind === 'broken') {
      findings.push({
        project: target.name,
        file: readmeRelative,
        line,
        code: resolution.code,
        message: resolution.message,
        hint: resolution.hint,
      });
      continue;
    }

    if (resolution.kind === 'self-anchor') {
      if (!ownSlugs.has(resolution.anchor)) {
        findings.push({
          project: target.name,
          file: readmeRelative,
          line,
          code: 'anchor-not-found',
          message: `anchor "#${resolution.anchor}" does not match any heading in this README`,
          hint: 'use the exact GitHub anchor of a heading (lowercased, spaces as hyphens, duplicates numbered -1, -2)',
        });
      }
      continue;
    }

    // file + anchor: anchor phải khớp heading của file đích (chỉ file Markdown).
    if (resolution.anchor !== undefined && resolution.anchor !== '') {
      if (!isMarkdownFile(resolution.absPath)) {
        findings.push({
          project: target.name,
          file: readmeRelative,
          line,
          code: 'unsupported-anchor-target',
          message: `anchor "#${resolution.anchor}" points at "${displayPath(resolution.absPath, workspaceRoot)}" which is not a Markdown file; its anchor cannot be verified`,
          hint: 'link to a Markdown file for heading anchors, or drop the "#..." part for non-Markdown files',
        });
        continue;
      }
      const cachedTarget = anchorTargetFor(shared, resolution.absPath, workspaceRoot);
      if (cachedTarget.error) {
        findings.push({
          project: target.name,
          file: readmeRelative,
          line,
          code: cachedTarget.error.code,
          message: cachedTarget.error.message,
          hint: cachedTarget.error.hint,
        });
      } else if (!cachedTarget.slugs?.has(resolution.anchor)) {
        findings.push({
          project: target.name,
          file: readmeRelative,
          line,
          code: 'anchor-not-found',
          message: `anchor "#${resolution.anchor}" does not match any heading in "${displayPath(resolution.absPath, workspaceRoot)}"`,
          hint: 'use the exact GitHub anchor of a heading in the target file (lowercased, spaces as hyphens, duplicates numbered -1, -2)',
        });
      }
    }
  }

  return { findings, externalLinks };
}

/**
 * Kiểm README của mọi project truyền vào và trả kết quả sort tất định. Hàm
 * không tự khám phá project — `collectReadmeTargets()` lo việc đó, để unit test
 * nuôi targets giả mà không spawn Nx.
 */
export function checkProjectReadmes(
  targets: readonly ReadmeTarget[],
  options: CheckReadmesOptions = {},
): ReadmeCheckResult {
  const workspaceRoot = realpathSync(options.workspaceRoot ?? ROOT_DIR);
  const shared: RunShared = {
    readdirCache: new Map(),
    anchorTargets: new Map(),
  };

  const findings: ReadmeFinding[] = [];
  let externalLinks = 0;
  for (const target of targets) {
    const result = checkProject(target, shared, workspaceRoot);
    findings.push(...result.findings);
    externalLinks += result.externalLinks;
  }

  const sorted = sortFindings(findings);
  return {
    findings: sorted,
    summary: {
      projects: targets.length,
      findings: sorted.length,
      externalLinks,
    },
  };
}
