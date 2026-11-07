/**
 * Quét **call-site** của các entry point enforcement trong `apps/backoffice/server/**`
 * để lấy ra permission literal mà call site đó dùng.
 *
 * ## Vì sao cần máy quét
 *
 * `CatalogPermission` là `string` tự do (`libs/backoffice-domain`), và
 * `requirePermission` **không** đối chiếu với catalog ở tầng DB: nó đánh giá
 * trên ảnh assignment đã đồng bộ (ADR-0009 — không sync-call mỗi request).
 * Nên một id sai ở call-site không hỏng gì lúc chạy: nó chỉ khiến mọi
 * request bị deny (`403`) mà **không có gate đỏ** nào báo trước.
 *
 * Id sai đến từ đâu là rất dễ:
 *
 * - copy từ fixture prototype (`delivery.redrive`, `mail.read`, `mail.send`,
 *   `audit.read` — ví dụ minh hoạ, **không** có trong catalog);
 * - nhầm kiểu đặt tên (`staff:read` thay vì `staff.read`).
 *
 * Contract test đối chiếu id đó với catalog thật (status `active`) — xem
 * `permission-catalog-contract.spec.ts`.
 *
 * ## Vì sao quét bằng máy quét tự viết, không dùng TypeScript compiler API
 *
 * `typescript` là devDependency của **workspace root**, không phải của
 * `apps/backoffice` — import nó từ đây là dùng dependency chưa khai báo (mùi
 * mà `vitest.config.mts` đã ghi rõ về `vue-i18n`). Vì vậy máy quét ở đây tự
 * đọc nguồn: nó chỉ cần nhận biết **string literal** và **dấu phẩy ở tầng
 * ngoài cùng**, không cần cây cú pháp đầy đủ.
 *
 * ⚠️ Ranh giới đã biết, nói thẳng để không ai hiểu nhầm:
 *
 * - Chỉ **literal** mới được kiểm. Call-site truyền biến (`requirePermission(permission, …)`)
 *   không kiểm được ở tầng static — đó là hình dạng hiện tại của `read-route.ts`,
 *   nơi permission đến từ route chứ không phải hằng số.
 * - File `*.spec.ts` trong `server/**` **không** quét: đó là fixture của unit
 *   test, dùng id minh hoạ (`delivery.redrive`) cố ý để kiểm policy, không
 *   phải call-site production.
 * - Máy quét là **best effort theo hình dạng cú pháp**: một call-site viết
 *   bằng cú pháp lạ (ví dụ `requirePermission` gọi qua biến hàm) không bị
 *   bắt. Vì vậy test contract có một **canary**: nó assert máy quét tìm thấy
 *   đúng các id của route hiện tại — máy quét hỏng thì canary đỏ, không phải
 *   test xanh vì không tìm thấy gì.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * Entry point enforcement và **vị trí** của permission trong lời gọi (0-based).
 *
 * - `requirePermission(permission, principal, auditClient, options?)` — tham số 0.
 * - `withReadEnforcement(event, permission, read)` — tham số 1.
 */
const PERMISSION_ARGUMENT_INDEX: Readonly<Record<string, number>> = {
  requirePermission: 0,
  withReadEnforcement: 1,
};

/** Một call-site đã biết permission literal. */
export interface PermissionCallSite {
  /** Đường dẫn file tương đối so với project root — để báo cáo đọc được. */
  readonly file: string;
  /** Tên entry point của enforcement. */
  readonly entryPoint: string;
  /** Permission literal truyền vào entry point đó. */
  readonly permission: string;
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/u.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/u.test(char);
}

/**
 * Đọc một string literal bắt đầu tại `start`.
 *
 * @returns `value` = nội dung literal nếu đó là literal **đơn giản** (chuỗi
 *   hoặc template literal không có interpolation); `null` nếu là template
 *   literal có `${…}` (không phải hằng số) hoặc chuỗi không đóng.
 */
function readLiteral(source: string, start: number): { value: string | null; end: number } {
  const quote = source.charAt(start);
  let index = start + 1;
  let value = '';

  while (index < source.length) {
    const char = source.charAt(index);

    if (char === '\\') {
      value += source.charAt(index + 1);
      index += 2;
      continue;
    }

    if (char === quote) {
      index += 1;
      // Template literal có interpolation không phải hằng số — không kiểm được.
      if (quote === '`' && value.includes('${')) {
        return { value: null, end: index };
      }
      return { value, end: index };
    }

    value += char;
    index += 1;
  }

  return { value: null, end: index };
}

/**
 * Tách danh sách tham số của một lời gọi, theo dấu phẩy ở **tầng ngoài cùng**.
 *
 * Dấu phẩy bên trong ngoặc/ngoặc vuông/ngoặc nhọn và bên trong string literal
 * không được tính — `requirePermission('a,b', principal)` là **một** tham số.
 *
 * @param openParenIndex Vị trí ký tự `(` mở lời gọi.
 */
function splitArguments(source: string, openParenIndex: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let index = openParenIndex;

  while (index < source.length) {
    const char = source.charAt(index);

    if (char === "'" || char === '"' || char === '`') {
      const literal = readLiteral(source, index);
      current += source.slice(index, literal.end);
      index = literal.end;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      if (depth === 1) {
        index += 1;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(current);
        return args;
      }
      current += char;
      index += 1;
      continue;
    }

    if (char === ',' && depth === 1) {
      args.push(current);
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  args.push(current);
  return args;
}

/**
 * Giá trị của một tham số, **chỉ** khi tham số đó là string literal thuần.
 *
 * Một biểu thức như `'staff' + '.read'` không phải literal — trả `null` để
 * không kiểm nhầm (tính đúng một phần của id còn thiếu cũng là sai).
 */
function literalValue(argument: string): string | null {
  const trimmed = argument.trim();
  if (trimmed.length < 2) {
    return null;
  }

  const quote = trimmed.charAt(0);
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return null;
  }

  const literal = readLiteral(trimmed, 0);
  // Literal phải chiếm **trọn** tham số — nếu không thì tham số là biểu thức.
  if (literal.end !== trimmed.length) {
    return null;
  }

  return literal.value;
}

/**
 * Quét một file nguồn, trả về mọi call-site enforcement có permission literal.
 *
 * @param source Nội dung file.
 * @param file Đường dẫn dùng để báo cáo.
 */
export function scanPermissionCallSites(source: string, file: string): PermissionCallSite[] {
  const sites: PermissionCallSite[] = [];
  const length = source.length;
  let index = 0;
  // Ký tự "có ý nghĩa" gần nhất — dùng để bỏ qua member call (`obj.requirePermission(…)`).
  let previousSignificant = '';

  while (index < length) {
    const char = source.charAt(index);

    // Comment dòng.
    if (char === '/' && source.charAt(index + 1) === '/') {
      while (index < length && source.charAt(index) !== '\n') {
        index += 1;
      }
      continue;
    }

    // Comment khối.
    if (char === '/' && source.charAt(index + 1) === '*') {
      index += 2;
      while (
        index < length &&
        !(source.charAt(index) === '*' && source.charAt(index + 1) === '/')
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }

    // String literal — bỏ qua nội dung, chỉ cần biết nó kết thúc ở đâu.
    if (char === "'" || char === '"' || char === '`') {
      const literal = readLiteral(source, index);
      index = literal.end;
      previousSignificant = 'literal';
      continue;
    }

    if (isIdentifierStart(char)) {
      let end = index + 1;
      while (end < length && isIdentifierPart(source.charAt(end))) {
        end += 1;
      }

      const name = source.slice(index, end);
      const argumentIndex = PERMISSION_ARGUMENT_INDEX[name];
      if (
        argumentIndex !== undefined &&
        source.charAt(end) === '(' &&
        previousSignificant !== '.'
      ) {
        const args = splitArguments(source, end);
        const argument = args[argumentIndex];
        const permission = argument === undefined ? null : literalValue(argument);
        if (permission !== null) {
          sites.push({ file, entryPoint: name, permission });
        }
      }

      previousSignificant = name;
      index = end;
      continue;
    }

    if (!/\s/u.test(char)) {
      previousSignificant = char;
    }
    index += 1;
  }

  return sites;
}

/** Liệt kê file nguồn (`.ts`/`.mts`) trong một cây thư mục, bỏ qua `*.spec.ts`. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.mts')) {
      continue;
    }
    // Fixture của unit test trong `server/**` dùng id minh hoạ cố ý
    // (`delivery.redrive`) — không phải call-site production.
    if (entry.name.endsWith('.spec.ts')) {
      continue;
    }
    files.push(full);
  }

  return files.toSorted((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Quét toàn bộ call-site enforcement trong một cây thư mục server.
 *
 * @param serverDir Thư mục chứa code server (ví dụ `apps/backoffice/server`).
 * @param projectRoot Project root — chỉ dùng để làm đường dẫn tương đối trong
 *   báo cáo.
 */
export function readServerCallSites(serverDir: string, projectRoot: string): PermissionCallSite[] {
  return collectSourceFiles(serverDir).flatMap((file) =>
    scanPermissionCallSites(readFileSync(file, 'utf8'), relative(projectRoot, file)),
  );
}
