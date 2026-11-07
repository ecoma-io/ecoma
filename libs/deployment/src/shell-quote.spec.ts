/**
 * Test `shellQuote`/`sqlQuote` bằng POSIX shell thật (`/bin/sh`).
 *
 * Yêu cầu của task: "không dùng string-only unit assertion làm bằng chứng
 * duy nhất" — chuỗi output đúng chưa đủ, phải chứng minh shell THẬT nhận giá
 * trị nguyên vẹn. Test spawn `sh` trong thư mục tạm (không env, không shell
 * cấu hình riêng, không external service):
 *
 * 1. Viết script `set -- <quoted>` + `printf` vào file tạm.
 * 2. Chạy `sh script`.
 * 3. Assert argument shell nhận về BẰNG ĐÚNG giá trị gốc.
 *
 * `eval set -- <quoted>` là cách chuẩn để ép shell parse chuỗi quote thành
 * argument (POSIX.1-2017 §2.2.2 cho single quote). Với các giá trị hình
 * command substitution, assert thêm rằng KHÔNG có lệnh nào chạy: script bảo
 * `set -e`, và marker file chỉ được tạo nếu `$(touch …)` được evaluate.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { shellQuote, sqlQuote } from './shell-quote.js';

/** Shell POSIX thuần — không bash, không zsh: cùng ngữ nghĩa mà `command.local.Command` dùng. */
const POSIX_SHELL = '/bin/sh';

// Anchor repo root từ vị trí file này (`libs/deployment/src`) — ba mức `../`
// về root; spec đọc trực tiếp file caller ở `deploys/` nên anchor sai một mức
// là ENOENT ngay khi chạy.
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Cho shell thật parse `set -- <quoted>` rồi trả về argument thứ nhất.
 *
 * `env: {}` — môi trường rỗng để không giá trị ambient nào (IFS, PS1, shell
 * option...) tham gia vào parse. `PATH` tối thiểu vì `sh` cần resolve printf
 * builtin không cần PATH, nhưng một số sh vẫn check PATH khi khởi động.
 */
function shellFirstArgument(quoted: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shell-quote-spec-'));
  cleanup.push(dir);
  const script = join(dir, 'probe.sh');
  // `printf '%s\n' "$1"` in argument ra stdout byte-for-byte (printf builtin
  // POSIX không biến đổi %s).
  writeFileSync(script, `set -- ${quoted}\nprintf '%s\\n' "$1"\n`, 'utf8');
  const run = spawnSync(POSIX_SHELL, [script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  expect(run.status).toBe(0);
  // Bỏ newline cuối của printf — mọi phần khác là nguyên văn argument.
  const stdout = run.stdout;
  if (!stdout.endsWith('\n')) {
    throw new Error(
      `shell probe did not print a trailing newline (stdout=${JSON.stringify(stdout)})`,
    );
  }
  return stdout.slice(0, -1);
}

/**
 * Cho shell thật parse `quoted(markerScript)`, assert marker KHÔNG được tạo.
 *
 * Giá trị hình command substitution phải được passed LITERALLY — nếu shell
 * evaluate nó thì `touch` tạo marker file, tức shell đã chạy mã từ input.
 * `quoted` là hàm quote đang kiểm (shellQuote hoặc tổ hợp với sqlQuote);
 * trả về argument shell nhận được để caller assert thêm nội dung nếu cần.
 */
function shellDoesNotEvaluate(quoted: (value: string) => string, markerScript: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shell-quote-noeval-'));
  cleanup.push(dir);
  const marker = join(dir, 'pwned-marker');
  // Script chèn marker path vào trong chuỗi quoted — marker chỉ được tạo khi
  // substitution được evaluate THẬT SỰ (không phải string match).
  const script = join(dir, 'probe.sh');
  writeFileSync(script, `set -- ${quoted(markerScript)}\nprintf '%s\\n' "$1"\n`, 'utf8');
  const run = spawnSync(POSIX_SHELL, [script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  expect(run.status).toBe(0);
  expect(existsSync(marker)).toBe(false);
  return marker;
}

describe('shellQuote', () => {
  it('round-trips a plain value through a real POSIX shell', () => {
    expect(shellFirstArgument(shellQuote('plain-value'))).toBe('plain-value');
  });

  it('round-trips a value with single quotes', () => {
    const value = "it's a test";
    expect(shellFirstArgument(shellQuote(value))).toBe(value);
  });

  it('round-trips spaces and tabs', () => {
    const value = 'two  spaces\tand-tab trailing ';
    expect(shellFirstArgument(shellQuote(value))).toBe(value);
  });

  it('round-trips dollar signs and command substitution literally', () => {
    const value = 'cost is $100 and $(echo substituted) stays literal';
    expect(shellFirstArgument(shellQuote(value))).toBe(value);
  });

  it('round-trips backticks literally', () => {
    const value = 'backtick `id` stays literal';
    expect(shellFirstArgument(shellQuote(value))).toBe(value);
  });

  it('round-trips semicolons and parentheses without splitting arguments', () => {
    const value = 'one;two (three) four;five';
    expect(shellFirstArgument(shellQuote(value))).toBe(value);
  });

  it('round-trips backslashes', () => {
    const value = String.raw`back\slash and \\ doubled \" quote`;
    expect(shellFirstArgument(shellQuote(value))).toBe(value);
  });

  it('round-trips double quotes and newlines', () => {
    const value = 'double "quotes" and a\nnewline';
    expect(shellFirstArgument(shellQuote(value))).toBe(value);
  });

  it('round-trips unicode', () => {
    const value = 'unicode with diacritics: ếMech latin éxtra — ✓';
    expect(shellFirstArgument(shellQuote(value))).toBe(value);
  });

  it('round-trips an empty string as exactly one empty argument', () => {
    // Hợp đồng: `''` là MỘT argument rỗng (không phải zero argument).
    expect(shellFirstArgument(shellQuote(''))).toBe('');
  });

  it('round-trips consecutive single quotes', () => {
    const value = "''already tricky''";
    expect(shellFirstArgument(shellQuote(value))).toBe(value);
  });

  it('does not let a command-substitution-shaped value execute inside the shell', () => {
    // Đây là assert an toàn, không phải round-trip: nếu shell evaluate
    // `$(touch ...)` thì marker file xuất hiện. `touch` là binary có sẵn ở
    // mọi môi trường POSIX; nó chạy trong thư mục tạm của test.
    const marker = shellDoesNotEvaluate(shellQuote, '$(touch $(dirname "$0")/pwned-marker)');
    expect(marker).toMatch(/pwned-marker$/u);
  });

  it('does not let a backtick substitution execute inside the shell', () => {
    const marker = shellDoesNotEvaluate(shellQuote, '`touch $(dirname "$0")/pwned-marker`');
    expect(marker).toMatch(/pwned-marker$/u);
  });

  it('produces exactly one argument for a value containing IFS characters', () => {
    // Ký tự phân tách field phải KHÔNG tách argument: `set -- <quoted>` cho
    // đúng 1 argument, kiểm qua $#.
    const dir = mkdtempSync(join(tmpdir(), 'shell-quote-argcount-'));
    cleanup.push(dir);
    const script = join(dir, 'probe.sh');
    writeFileSync(script, `set -- ${shellQuote('a b\tc')}\nprintf '%s' "$#"\n`, 'utf8');
    const run = spawnSync(POSIX_SHELL, [script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('1');
  });
});

describe('sqlQuote', () => {
  /**
   * Chạy câu SQL qua psql parser thật là quá nặng cho unit test (cần
   * PostgreSQL). Biên SQL được kiểm ở tầng chuỗi: output của `sqlQuote` cho
   * giá trị chứa nháy đơn phải là nháy đơn đôi — chuẩn SQL standard_conforming_strings.
   * ĐIỀU QUAN TRỌNG: caller (backoffice-deploy) phải shellQuote TOÀN BỘ câu
   * SQL ở biên shell — test bên dưới chứng minh tổ hợp đó qua shell thật.
   */
  it('doubles embedded single quotes (SQL literal escaping)', () => {
    expect(sqlQuote("it's")).toBe("'it''s'");
    expect(sqlQuote("a'b'c")).toBe("'a''b''c'");
  });

  it('wraps the value in single quotes', () => {
    expect(sqlQuote('plain')).toBe("'plain'");
    expect(sqlQuote('')).toBe("''");
  });

  it('leaves shell metacharacters untouched — sqlQuote does not solve the shell boundary', () => {
    // Hàm này KHÔNG phải lớp bảo vệ shell: `$`, backtick, `"` đi qua nguyên
    // vẹn vì nhiệm vụ của nó là biên SQL. Chứng minh bằng assert để ai đọc
    // code không lầm: caller bắt buộc shellQuote ở biên shell.
    const value = 'has $(id) and `bt` and "dq';
    expect(sqlQuote(value)).toBe(`'${value}'`);
  });
});

describe('shellQuote + sqlQuote together (the backoffice-deploy ALTER ROLE boundary)', () => {
  it('delivers the full SQL statement as one intact shell argument through a real shell', () => {
    // Tái hiện ĐÚNG tổ hợp mà `deploys/backoffice-deploy/index.ts` dùng:
    //   -c ${shellQuote(`ALTER ROLE ... WITH PASSWORD ${sqlQuote(pw)};`)}
    // Bằng chứng cần thu được: shell nhận ĐÚNG MỘT argument, bên trong là câu
    // SQL với literal đã escape SQL-style — và `$(id)` trong password KHÔNG
    // được evaluate (test trước đây đã đo: sqlQuote một mình trong double
    // quotes của shell cho shell mở rộng substitution trước psql).
    const password = 'pw$(id)-and-`bt`-and-"dq-and-\'quote';
    const sql = `ALTER ROLE role1 WITH PASSWORD ${sqlQuote(password)};`;
    const delivered = shellFirstArgument(shellQuote(sql));
    expect(delivered).toBe(sql);
    // Literal SQL bên trong đúng chuẩn: nháy đơn nhúng thành nháy đơn đôi.
    expect(delivered).toContain(`PASSWORD 'pw$(id)-and-\`bt\`-and-"dq-and-''quote';`);
  });

  it('never evaluates a password-shaped command substitution at the shell boundary', () => {
    // Password hình command substitution — đúng kịch bản A2: giá trị đi qua
    // sqlQuote (biên SQL) rồi shellQuote (biên shell) phải tới psql nguyên vẹn,
    // và marker KHÔNG được tạo (shell không được chạy mã từ password).
    const markerScript = '$(touch $(dirname "$0")/pwned-marker)';
    const sql = `ALTER ROLE role1 WITH PASSWORD ${sqlQuote(markerScript)};`;
    const marker = shellDoesNotEvaluate(shellQuote, sql);
    expect(marker).toMatch(/pwned-marker$/u);
  });
});

describe('wiring', () => {
  const CALLER = join(REPO_ROOT, 'deploys/backoffice-deploy/index.ts');

  it('pins the backoffice provision SQL to the two-boundary shellQuote composition', () => {
    // Test tổ hợp phía trên chỉ chứng minh module `shell-quote` ĐÚNG — nó
    // không nhìn thấy caller. Nếu ai revert `index.ts` về nối SQL vào double
    // quotes của shell (`-c "... ${sqlQuote(pw)} ..."`), mọi test module vẫn
    // xanh trong khi lỗ hổng quay lại (đã đo: shell mở rộng `$(...)` trước
    // psql). Assert này đọc chính file caller và yêu cầu mật khẩu đi qua
    // `-c ${shellQuote(...)}` — cùng mẫu wiring mà `namedInputs` của
    // `@ecoma-io/deployment` đảm bảo CHẠY THẬT khi file này đổi: spec đọc
    // caller nên caller đổi là input `production` của lib đổi (xem
    // `namedInputs` trong package.json của project).
    const source = readFileSync(CALLER, 'utf8');

    for (const role of ['ecoma_backoffice_migrator', 'ecoma_backoffice_runtime']) {
      const pattern = new RegExp(
        `psql [^\\n]*-c \\$\\{shellQuote\\(\`ALTER ROLE ${role} WITH PASSWORD \\$\\{sqlQuote\\([^}]+\\)\\};\`\\)\\}`,
        'u',
      );
      expect(source).toMatch(pattern);
    }
    // Không còn đường nối password vào double quotes của shell: câu ALTER ROLE
    // nằm trong `"..."` kèm `${sqlQuote(` là chính revert mutation cần chặn.
    const doubleQuotedPassword = /-c "[^"\n]*PASSWORD \$\{sqlQuote\(/u;
    expect(source).not.toMatch(doubleQuotedPassword);
  });
});
