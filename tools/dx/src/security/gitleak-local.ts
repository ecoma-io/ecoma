import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineCommand } from 'citty';

import { gitEnv, ROOT_DIR } from '../utils.js';

/**
 * Trích xuất image gitleaks từ `security-tools.lock.json` tại runtime.
 *
 * Không hard-code version ở đây: image được ghim trong lock file và CI /
 * lefthook cũng đọc cùng một file, nên nâng version ở một bên mà quên bên
 * kia sẽ bị test wiring bắt (gần giống `semgrep-scan.spec.ts` assert image
 * khớp với CI).
 */
export function readGitleaksImage(
  lockPath: string = join(ROOT_DIR, 'tools/dx/security-tools.lock.json'),
): string {
  let lock: { gitleaks?: { image?: string } };

  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `failed to parse security-tools.lock.json at ${lockPath}: ${err instanceof Error ? err.message : String(err)}.`,
      { cause: err },
    );
  }

  const image = lock.gitleaks?.image;

  if (typeof image !== 'string' || image === '') {
    throw new Error(
      `gitleaks image is not defined in ${lockPath}: expected a non-empty string at gitleaks.image.`,
    );
  }

  return image;
}

/**
 * Cờ gitleaks cố định cho chế độ scan-dir (không thay đổi theo người dùng).
 */
const GITLEAKS_FLAGS = [
  '--config',
  'gitleaks.toml',
  '--no-banner',
  '--redact',
  '--verbose',
  '--exit-code',
  '1',
];

/**
 * Dựng argv của `docker run` cho lệnh `gitleaks dir` ở chế độ scan-dir.
 *
 * Volume `<ROOT_DIR>:/repo` là bắt buộc; volume `.git` chỉ mount khi thư mục
 * đó tồn tại (worktree có thể không mang `.git` đầy đủ). Các argument còn
 * lại của CLI được đính vào cuối để người dùng tuỳ chỉnh lệnh gitleaks.
 */
export function buildDockerArgs(
  image: string,
  extraArgs: string[],
  rootDir: string = ROOT_DIR,
): string[] {
  const args: string[] = ['run', '--rm', '--volume', `${rootDir}:/repo`, '--workdir', '/repo'];

  const gitDir = join(rootDir, '.git');
  if (existsSync(gitDir)) {
    args.push('--volume', `${gitDir}:/repo/.git`);
  }

  args.push(image, 'dir', ...GITLEAKS_FLAGS, ...extraArgs);

  return args;
}

/**
 * Chạy gitleaks ở chế độ scan-dir qua docker.
 *
 * `stdio: 'inherit'` để output của container stream trực tiếp ra terminal —
 * người dùng nhìn thấy finding cùng lúc gitleaks in, không đợi buffer giữ
 * lại rồi in một lúc. Nếu docker không chạy được hoặc gitleaks exit khác 0,
 * gán `process.exitCode = 1` và in lỗi bằng tiếng Anh (không bao giờ dump
 * nội dung prompt/response, chẳng hạn không in toàn bộ stdout/stderr của
 * container khi chưa cần).
 */
export function runGitleaksLocal(
  image: string,
  extraArgs: string[],
  rootDir: string = ROOT_DIR,
): void {
  const args = buildDockerArgs(image, extraArgs, rootDir);

  const result = spawnSync('docker', args, { cwd: rootDir, stdio: 'inherit', env: gitEnv() });

  if (result.error !== undefined) {
    console.error(
      `could not run docker: ${result.error.message}. The gitleak-local command needs a running Docker daemon; it does not have a non-docker fallback.`,
    );
    process.exitCode = 1;
    return;
  }

  if (result.status !== 0) {
    const detail =
      result.status === null
        ? `docker was terminated by ${result.signal ?? 'a signal'}`
        : `gitleaks exited with code ${result.status}`;

    console.error(`${detail}. See the gitleaks output above for the findings.`);

    process.exitCode = 1;
    return;
  }

  console.log('gitleaks scan passed: no secrets detected.');
}

export default defineCommand({
  meta: {
    name: 'gitleak-local',
    description: 'Run gitleaks in scan-dir mode against the repository root via docker',
  },

  run({ rawArgs }) {
    const image = readGitleaksImage();
    runGitleaksLocal(image, rawArgs);
  },
});
