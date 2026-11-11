/**
 * Contract theo NGUỒN cho bước config-init của object store trong
 * `deploys/platform-deploy/index.ts`: builder `s3ConfigJson`, script
 * `s3ConfigScript` và resource `command.local.Command` đi kèm.
 *
 * Vì sao đọc source mà không chạy chương trình: `index.ts` là chương trình
 * Pulumi dựng resource ở top-level — import vào test là provision thật, nên
 * contract khả dĩ duy nhất ở tầng này là ghim cấu trúc source (tiền lệ:
 * `platform-down.spec.ts` cũng đọc source cùng kiểu).
 *
 * Ghim nguồn CHỨNG MINH được: chuỗi create/update không chứa secret, không
 * chứa heredoc và không có cờ `-e` truyền env; config được nạp qua
 * `docker run -i` + `cat > /cfg/s3.json` (stdin pipe); `set -e` và
 * ownership/permission nguyên vẹn; resource nối input `stdin` tới JSON được
 * `pulumi.secret(...)` bọc; create/update dùng chung một template; triggers
 * rotation nguyên vẹn; hằng số non-secret không trôi.
 *
 * Ghim nguồn KHÔNG chứng minh được: "secret không xuất hiện trên argv/env lúc
 * runtime" là thuộc tính vận hành của provider `@pulumi/command` + stdin pipe
 * của Docker — được chứng minh bằng quan sát process sống (`/proc/<pid>/cmdline`
 * + `/proc/<pid>/environ`) trong lúc `pulumi up` thật chạy config-init trên một
 * stack riêng (canary secret), KHÔNG phải bởi spec này và cũng không thay thế
 * được bằng stack export/scan state (redaction của Pulumi chỉ thuộc về state
 * và log, không phải argv/env). Spec chỉ chặn việc transport qua argv quay lại
 * ở tầng source.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'index.ts'), 'utf8');

/**
 * Cắt vùng source giữa hai marker (bao gồm cả marker kết thúc). Fail tường
 * minh khi marker biến mất thay vì để các assert sau đó chạy trên chuỗi rỗng
 * và pass một cách vô nghĩa.
 */
function sliceBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `source marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end, `source marker not found: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end + endMarker.length);
}

const jsonBuilder = sliceBetween('const s3ConfigJson', 'const s3ConfigScript');
const script = sliceBetween('const s3ConfigScript', 'const objectStoreConfigInit');
const commandBlock = sliceBetween(
  'const objectStoreConfigInit = new command.local.Command(',
  '\n);',
);

describe('object store config-init source contract', () => {
  it('keeps secret material out of the create/update command string', () => {
    expect(script, 'secret material found in the create/update command string').not.toContain(
      'objectStorageSecretKey',
    );
    expect(script, 'secret material found in the create/update command string').not.toContain(
      'secretKey',
    );
    expect(script, 'legacy heredoc marker found in the create/update command string').not.toContain(
      'S3CONFIG',
    );
    expect(script, 'env passthrough flag found on the docker run line').not.toMatch(
      /docker run[^\n]*\s-e[\s\\]/u,
    );
    expect(script, 'env passthrough flag --env found in the command string').not.toContain('--env');
    expect(script, 'env passthrough flag --env-file found in the command string').not.toContain(
      '--env-file',
    );
  });

  it('feeds the config into the container over docker stdin instead of a heredoc', () => {
    expect(script).toContain('docker run --rm');
    expect(script).toMatch(/-i\b/u);
    expect(script).toContain('-v ${objectStoreConfigVolume.name}:/cfg');
    expect(script).toContain('cat > /cfg/s3.json');
    expect(script, 'heredoc transport found in the create/update command string').not.toContain(
      "sh -c 'cat > /cfg/s3.json <<",
    );
  });

  it('preserves fail-fast shell and restrictive file ownership', () => {
    expect(script).toMatch(/`set -e$/mu);
    expect(script).toContain('chown 1000:1000 /cfg/s3.json');
    expect(script).toContain('chmod 0600 /cfg/s3.json');
  });

  it('wires the resource stdin input to the secret-wrapped JSON payload', () => {
    expect(commandBlock).toMatch(/stdin:\s*s3ConfigJson/u);
    expect(jsonBuilder).toContain('pulumi.jsonStringify');
    expect(jsonBuilder).toContain('pulumi.secret(objectStorageSecretKey)');
    expect(jsonBuilder).toContain('identities:');
    expect(jsonBuilder).toContain('secretKey');
    expect(jsonBuilder).toContain('accessKey');
    expect(jsonBuilder).toContain('OBJECT_STORE_IDENTITY_NAME');
    expect(jsonBuilder).toContain('OBJECT_STORE_ACCESS_KEY_ID');
    expect(jsonBuilder).toContain('OBJECT_STORE_BUCKET');
    expect(jsonBuilder).toContain('`Read:${bucket}`');
    expect(jsonBuilder).toContain('`Write:${bucket}`');
    expect(jsonBuilder).toContain('`List:${bucket}`');
  });

  it('reuses one template for create and update and re-runs on secret rotation', () => {
    expect(commandBlock).toMatch(/create:\s*s3ConfigScript/u);
    expect(commandBlock).toMatch(/update:\s*s3ConfigScript/u);
    expect(commandBlock).toMatch(
      /triggers:\s*\[\s*pulumi\.secret\(objectStorageSecretKey\),\s*worktreeRoot\s*\]/u,
    );
    expect(commandBlock).toContain('dependsOn: [objectStoreConfigVolume]');
  });

  it('pins the non-secret object store constants against identity drift', () => {
    expect(source).toContain("OBJECT_STORE_IDENTITY_NAME = 'remote-cache'");
    expect(source).toContain("OBJECT_STORE_ACCESS_KEY_ID = 'ecoma-remote-cache-local'");
    expect(source).toContain("OBJECT_STORE_BUCKET = 'remote-cache'");
  });
});
