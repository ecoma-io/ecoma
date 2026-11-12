import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalWorkspace } from '@pulumi/pulumi/automation';
import * as pulumi from '@pulumi/pulumi';
import * as command from '@pulumi/command';

/**
 * Failure-path regression cho Issue #42: khi một provisioning operation THẤT BẠI
 * trong khi sentinel credential đang được sử dụng, sentinel không được phép xuất
 * hiện trong stdout/stderr/Diagnostics của `pulumi up`, và engine phải thoát với
 * exit code khác 0.
 *
 * Suite này chạy qua **`@pulumi/command` thật** (provider 1.2.1, Pulumi engine
 * thật qua Automation API, state backend `file://` cô lập trong tmpdir) — không
 * phải static source assertion. Hai stack:
 *
 * 1. `control` — chứng minh harness có độ nhạy: sentinel được NỘI SUY vào
 *    command text (pattern lỗi mà Issue #42 mô tả và đã đo thực nghiệm); provider
 *    echo command text ra stdout lẫn Diagnostics (đo được thực tế: echo xuất
 *    hiện ở cả hai kênh, với `"`/`\`/backtick bị escape) nên sentinel PHẢI xuất
 *    hiện trong output thu được. Nếu control không thấy sentinel thì harness
 *    hoặc premise cần xem lại.
 * 2. `fix-shape` — mô phỏng đúng shape đã sửa: sentinel CHỈ đi qua `environment`
 *    (bọc `pulumi.secret`), command text chỉ tham chiếu TÊN biến; script mô phỏng
 *    provisioning (ALTER ROLE ... WITH PASSWORD truyền qua STDIN của `psql`) và
 *    cố tình thất bại. Sentinel KHÔNG được xuất hiện ở bất kỳ kênh output nào.
 *
 * Quy ước chống tự-lộ: mọi assertion kiểm tra `includes(sentinel)` và chỉ assert
 * kết quả boolean — sentinel không bao giờ được in ra terminal/Nx terminal-output
 * cache, kể cả khi assertion thất bại (vitest chỉ in boolean, không in
 * `expected/received`). Lỗi automation cũng không được propagate thẳng ra.
 */

const SENTINEL_CORE = `fp-sentinel-${Math.random().toString(36).slice(2, 10)}`;
// Giá trị env chứa ký tự đặc biệt: kiểm thêm rằng kênh environment đưa nguyên
// giá trị đến tiến trình mà không qua shell quoting.
const SENTINEL = `${SENTINEL_CORE}-P@ss'Quo"te\\$B4th;\`tick\``;
/**
 * Provider escape `"` → `\"`, `\` → `\\`, `` ` `` → `` \` `` khi nhúng command
 * text vào message Diagnostics, nên kiểm tra rò rỉ phải chạy trên cả haystack
 * thô lẫn cặp đã bỏ backslash **cả hai phía** — sentinel vốn chứa `\` của
 * riêng nó, nên bỏ backslash chỉ ở haystack thì escaped form không bao giờ
 * khớp sentinel gốc (nhận xét review của PR #157).
 */
const deBackslash = (s: string): string => s.replaceAll('\\', '');
const sentinelLeaked = (haystack: string): boolean =>
  haystack.includes(SENTINEL) || deBackslash(haystack).includes(deBackslash(SENTINEL));

/** Toàn bộ kênh text thu được từ một lần `up` thất bại hoặc thành công. */
type Captured = { out: string; errText: string; exitCode: number | null };

async function runStack(
  workDir: string,
  stackName: string,
  leakIntoText: boolean,
): Promise<Captured> {
  // Command text không bao giờ chứa sentinel ở nhánh fix-shape; nhánh control
  // nhúng sentinel thẳng vào text như một literal — đúng kênh mà Issue #42 mô
  // tả (secret chỉ nội suy vào command text, KHÔNG nằm trong environment của
  // resource, nên provider không có giá trị secret nào để tự mask).
  const sqlLine = leakIntoText
    ? `printf 'ALTER ROLE ecoma_runtime WITH LOGIN PASSWORD %s;' "$ACCOUNT_PW_RUNTIME" --interp="${SENTINEL}" | fake-psql --set=ON_ERROR_STOP=1`
    : `printf 'ALTER ROLE ecoma_runtime WITH LOGIN PASSWORD %s;' "$ACCOUNT_PW_RUNTIME" | fake-psql --set=ON_ERROR_STOP=1`;
  const createText = [
    '#!/bin/sh',
    // Mô phỏng pattern provisioning: SQL chứa WITH PASSWORD truyền qua STDIN,
    // giá trị chỉ đến qua TÊN biến môi trường của tiến trình command.
    sqlLine,
    // Thất bại chủ đích: `fake-psql` không tồn tại, pipeline hỏng rồi script
    // thoát 7 — bắt buộc đi vào kênh Diagnostics.
    'echo "provision intentionally failed"',
    'exit 7',
  ].join('\n');

  const stack = await LocalWorkspace.createOrSelectStack(
    {
      stackName,
      projectName: 'issue42_failure_path',
      program: async () => {
        void new command.local.Command('probe', {
          create: createText,
          environment: leakIntoText
            ? { ACCOUNT_PW_RUNTIME: 'harmless-placeholder' }
            : { ACCOUNT_PW_RUNTIME: pulumi.secret(SENTINEL) },
        });
      },
    },
    {
      workDir,
      envVars: {
        // Local backend + state `file://` hoàn toàn cô lập trong tmpdir; không
        // chạm backend mặc định của máy.
        PULUMI_CONFIG_PASSPHRASE: 'failure-path-fixture-passphrase',
        PULUMI_BACKEND_URL: `file://${workDir}/state`,
        PULUMI_SKIP_UPDATE_CHECK: 'true',
        // CI (npm `pulumi` shim) thỉnh thoảng in thêm dòng ngoài stdout khiến
        // Automation API không parse được version (đo được: red CI #157, chỉ
        // control stack dính). Skip version check là override chính thức của
        // Automation API; CLI thực sự được dùng ở bước `up` vẫn phải hoạt động
        // hoặc fixture đỏ như ý muốn.
        PULUMI_AUTOMATION_API_SKIP_VERSION_CHECK: 'true',
      },
    },
  );
  try {
    await stack.destroy({ onOutput: (chunk) => void chunk });
  } catch {
    // Stack chưa có trong state là bình thường cho lần chạy đầu.
  }
  const captured: Captured = { out: '', errText: '', exitCode: null };
  try {
    await stack.up({
      onOutput: (chunk) => {
        captured.out += chunk;
      },
    });
    // fix-shape PHẢI thất bại; nếu nó thành công thì fixture sai sơ đồ.
    if (!leakIntoText) throw new Error('fixture broken: fix-shape stack unexpectedly succeeded');
  } catch (e) {
    const code =
      typeof e === 'object' && e !== null && 'commandResult' in e
        ? ((e as { commandResult?: { code?: number } }).commandResult?.code ?? null)
        : null;
    captured.exitCode = code;
    captured.errText += e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  return captured;
}

describe('local.Command failure-path hygiene (real @pulumi/command engine)', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue42-failure-path-'));
    fs.writeFileSync(
      path.join(workDir, 'Pulumi.yaml'),
      [
        'name: issue42-failure-path',
        'runtime: nodejs',
        'description: Issue #42 failure-path fixture',
        '',
      ].join('\n'),
    );
    // Backend `file://` yêu cầu thư mục state tồn tại sẵn.
    fs.mkdirSync(path.join(workDir, 'state'));
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('surfaces an interpolated sentinel in command output — harness sensitivity control', async () => {
    const captured = await runStack(workDir, 'control', true);
    const haystack = `${captured.out}\n${captured.errText}`;
    // Assert qua boolean để sentinel không bao giờ in ra terminal/Nx cache.
    expect(
      haystack.includes(SENTINEL_CORE),
      'control stack did NOT surface an interpolated sentinel — harness sensitivity broken',
    ).toBe(true);
    // Provider echo ở dạng escaped — chính logic `sentinelLeaked` mà assertion
    // absence dùng phải nhận ra haystack NÀY là leak, nếu không absence check
    // có thể bỏ sót leak thật (tự-chứng minh độ nhạy của chuẩn so khớp).
    expect(
      sentinelLeaked(haystack),
      'sentinelLeaked() did NOT flag the escaped echo — absence-check logic broken',
    ).toBe(true);
  }, 300_000);

  it('keeps the sentinel out of stdout, stderr and Diagnostics when provisioning fails', async () => {
    const captured = await runStack(workDir, 'fix-shape', false);
    const haystack = `${captured.out}\n${captured.errText}`;
    expect(captured.exitCode, 'provisioning failure must exit non-zero').not.toBeNull();
    expect(
      sentinelLeaked(haystack),
      'sentinel leaked through the environment channel on the failure path',
    ).toBe(false);
    expect(captured.errText, 'engine failure output must be captured for diagnosis').not.toBe('');
    expect(
      haystack.includes('WITH PASSWORD'),
      'echoed output must not carry WITH PASSWORD SQL text',
    ).toBe(false);
  }, 300_000);
});
