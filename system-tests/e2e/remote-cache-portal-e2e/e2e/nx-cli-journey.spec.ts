import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from './support/fixtures';
import { resolveStackOrigin } from './support/local-origin';
import { resolvePlatformNetwork } from './support/network';

/**
 * Journey Nx CLI thật với self-hosted remote cache (issue #299, #27 journey 2).
 *
 * `nx` build với `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` + token của lane phải
 * PUT cache lên lane và HIT từ container sạch (đọc từ remote, không có local
 * store). Đây là bằng chứng "Nx CLI e2e compat được verify với CLI thật" —
 * không phải mock HTTP: binary nx 23.3.2 thật (npm registry) chạy trong
 * container Node thật trên network của stack.
 *
 * ## Vì sao chạy TRONG docker network
 *
 * `remote-cache-api` không có router Traefik (quyết định #238 — service nội
 * bộ) và host không route vào network platform; Nx Rust client (reqwest) lại
 * không tin self-signed cert qua `SSL_CERT_FILE`. Chạy trong network với
 * endpoint `http://ecoma-remote-cache-api:4207` né cả hai giới hạn và vẫn là
 * HTTP thật tới server thật.
 *
 * ## Token dùng cho write path
 *
 * Portal key luôn là developer (read scope, untrusted — R20) nên PUT bằng
 * portal key bị 403 THEO THIẾT KẾ. Write path của Nx cần trusted-CI key —
 * bootstrap key của deploy (`namespace:ciKeyPlaintext`), đọc qua
 * `pulumi config get` như CI lane làm. Giá trị KHÔNG BAO GIỜ log hay commit.
 *
 * Mỗi lần chạy dựng workspace Nx tối thiểu trong tmp: project `probe` với
 * target cacheable (`cache: true`) — điều kiện bắt buộc để Nx tương tác remote
 * cache (package script target mặc định KHÔNG cacheable).
 */

const execFileAsync = promisify(execFile);

/** Alias nội bộ + port của data-plane trên network platform (deploy #238). */
const DATA_PLANE_ALIAS = 'ecoma-remote-cache-api';
const DATA_PLANE_PORT = 4207;
/** Phiên bản Nx ghim — cùng version với workspace chính của repo. */
const NX_VERSION = '23.3.2';
/** Image Node dùng cho container journey — cùng image deploy dùng. */
const NODE_IMAGE = 'node:24-bookworm-slim';

/** Đọc plaintext của bootstrap trusted-CI key từ Pulumi local state. */
function readCiKeyPlaintext(): string {
  // ESM: __dirname không tồn tại — dùng import.meta.url. Spec nằm ở `e2e/`:
  // BỐN mức `../` về repo root (e2e → suite → e2e category → system-tests → root).
  const specDir = dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = join(specDir, '../../../..');
  const deployDir = join(workspaceRoot, 'deploys/remote-cache-api-deploy');
  // Stack name theo worktree (`local-w<hash>`) — hardcode một worktree id sẽ
  // gãy trên worktree khác. Backend là `.pulumi-local-state` của chính worktree
  // này nên chỉ có MỘT stack json cho project; suy tên từ đó.
  const stacksDir = join(
    workspaceRoot,
    '.pulumi-local-state/.pulumi/stacks/remote-cache-api-deploy',
  );
  const stackFile = readdirSync(stacksDir).find(
    (name) => name.endsWith('.json') && !name.endsWith('.bak.json'),
  );
  if (stackFile === undefined) {
    throw new Error(
      'no remote-cache-api-deploy stack json in .pulumi-local-state — run local-up first',
    );
  }
  const stackName = stackFile.replace(/\.json$/u, '');
  const stdout = execFileSync(
    'pulumi',
    ['config', 'get', 'namespace:ciKeyPlaintext', '--stack', stackName],
    {
      cwd: deployDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PULUMI_BACKEND_URL: `file://${join(deployDir, '../../.pulumi-local-state')}`,
        PULUMI_CONFIG_PASSPHRASE_FILE: join(deployDir, '../../.pulumi-local-passphrase'),
      },
    },
  );
  const value = stdout.trim();
  if (value.length === 0) {
    throw new Error('bootstrap CI key is empty — check the Pulumi local state of this worktree');
  }
  return value;
}

test.describe('Nx CLI self-hosted remote cache journey', () => {
  test('a real nx run stores to and retrieves from the lane remote cache', async ({
    page: _unusedPage,
  }, testInfo) => {
    testInfo.setTimeout(300_000);
    const network = await resolvePlatformNetwork(resolveStackOrigin());
    const ciKey = readCiKeyPlaintext();

    // Workspace Nx tối thiểu trong tmp — mount vào container, KHÔNG đụng repo.
    const ws = mkdtempSync(join(tmpdir(), 'nx-remote-cache-e2e-'));
    try {
      writeFileSync(
        join(ws, 'package.json'),
        JSON.stringify(
          { name: 'nx-e2e-probe', version: '0.0.0', workspaces: ['packages/*'], private: true },
          null,
          2,
        ),
      );
      writeFileSync(join(ws, 'nx.json'), JSON.stringify({}, null, 2));
      const projectDir = join(ws, 'packages', 'probe');
      await execFileAsync('mkdir', ['-p', projectDir]);
      writeFileSync(
        join(projectDir, 'package.json'),
        JSON.stringify(
          {
            name: 'probe',
            version: '0.0.0',
            type: 'module',
            nx: {
              targets: {
                echo: {
                  executor: 'nx:run-commands',
                  options: { cwd: 'packages/probe', command: 'node echo.js' },
                  cache: true,
                },
              },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(join(projectDir, 'echo.js'), "console.log('nx-e2e-journey-ok');\n");

      // ⚠️ `-v <ws>:/ws` theo trị số của môi trường Linux host — đẻ stdout
      // password prompt không xảy ra vì docker không hỏi.
      // KHÔNG `--user`: daemon local là rootless (container root = uid worktree),
      // còn CI là rootful — container root ghi được mount trên cả hai. Đổi lại,
      // file mà npm/nx tạo có thể thuộc root trên rootful, nên cleanup xoá nội
      // dung mount bằng container root trước khi `rmSync` (lỗi CI thật #314).
      const runNx = async (_label: string): Promise<string> => {
        const { stdout } = await execFileAsync(
          'docker',
          [
            'run',
            '--rm',
            `--network=${network}`,
            '-v',
            `${ws}:/ws`,
            '-w',
            '/ws',
            '-e',
            `NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://${DATA_PLANE_ALIAS}:${DATA_PLANE_PORT}`,
            '-e',
            `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=${ciKey}`,
            NODE_IMAGE,
            'sh',
            '-c',
            `npm i -s nx@${NX_VERSION} --no-save >/dev/null 2>&1 && npx nx reset >/dev/null 2>&1 && npx nx run probe:echo 2>&1`,
          ],
          { timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
        );
        // KHÔNG attach stdout vào test artifacts: env truyền trusted-CI key
        // vào container và output của nx khi lỗi có thể in giá trị env —
        // artifact Playwright tải được về, secret không được nằm ở đó.
        return stdout;
      };

      // Run 1: workspace nội dung giống hệt các lần chạy trước của suite ⇒
      // hash task đã được STORE trên lane từ run trước, nên run đầu trong
      // container sạch có thể là MISS (store mới) hoặc HIT từ remote (entry
      // còn đó). Cả hai đều chứng minh giao thức Nx ⇄ lane hoạt động; ràng
      // buộc cứng nằm ở run 2.
      const firstRun = await runNx('run1');
      expect(firstRun).toContain('Successfully ran target echo for project probe');
      expect(firstRun).toMatch(/Cache:\s*[01]\/1 hit/u);
      expect(firstRun).toContain('nx-e2e-journey-ok');

      // Run 2 trong container SẠCH THỨ HAI (container trước đã --rm — local
      // store của nó mất cùng container): hash task GIỐNG NHAU (workspace
      // mount giữ nguyên) nhưng local store trống ⇒ 1/1 hit chỉ có thể là
      // RETRIEVE từ lane. Đây là bằng chứng put+hit hai chiều qua lane.
      const secondRun = await runNx('run2');
      expect(secondRun).toMatch(/Cache:\s*1\/1 hit/u);
    } finally {
      // Trên daemon rootful (CI), npm/nx ghi file thuộc root vào mount và
      // `rmSync` của host bị EACCES. Xoá nội dung mount bằng container root
      // (root xoá được mọi file trong mount trên CẢ rootless lẫn rootful),
      // rồi `rmSync` chỉ còn phải xoá thư mục rỗng. Best-effort: một lần
      // xoá hiếm hoi thất bại chỉ để lại thư mục tmp.
      await execFileAsync('docker', [
        'run',
        '--rm',
        '-v',
        `${ws}:/ws`,
        NODE_IMAGE,
        'sh',
        '-c',
        'rm -rf /ws/* /ws/.[!.]* /ws/..?* 2>/dev/null || true',
      ]).catch(() => undefined);
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
