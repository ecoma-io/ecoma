/**
 * Đọc-trắng-hại-đọc trạng thái lane local của một worktree — SỞ HỮU bởi
 * `platform-deploy` (platform là unit duy nhất sở hữu stack outputs mà status
 * đọc), bề mặt CLI là `pnpm dx local-status` (adapter mỏng chỉ spawn entry
 * này).
 *
 * READ-ONLY tuyệt đối: không tạo stack, không deploy, không ghi `.env`, không
 * destroy gì. Thất bại backend/parse → exit != 0 (không nuốt lỗi thật thành
 * "chưa deploy").
 */
// oxlint-disable no-console -- CLI đọc-trắng-hại-đọc chạy trên Node; console
// là kênh output DUY NHẤT của nó (`pnpm dx local-status` spawn với stdio
// inherit, không có logger nào khác).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  describeSpawnFailure,
  dockerResourceName,
  exec,
  fullStackRef,
  localStateDir,
  POSTGRES_PASSWORD_ENV_KEY,
  pulumiEnv,
  resolveContext,
  resolveLocalPassphrase,
  ROOT_HOST_ENV_KEY,
  type ExecResult,
  type LocalDeployContext,
} from '@ecoma-io/deployment';

/** Root của workspace, suy từ vị trí file này (`deploys/platform-deploy`). */
const WORKSPACE_ROOT = join(import.meta.dirname, '../..');

/** Tên Nx project của platform — duy nhất sở hữu stack outputs mà status đọc. */
const PLATFORM_PROJECT = 'platform-deploy';

function projectDir(project: string): string {
  return join(WORKSPACE_ROOT, 'deploys', project);
}

/**
 * Phân loại trạng thái stack platform — nguồn duy nhất cho `localStatus`.
 *
 * Kết quả PHẢI phân biệt được "chưa deploy" với "backend hỏng": gộp hai trạng
 * thái là cách status nói dối — backend không đọc được bị bắn ra thành "chưa
 * deploy" và người dùng chạy local-up vào một backend đang hỏng.
 */
export type PlatformStatusResult =
  | { state: 'no-stack' }
  | { state: 'no-outputs' }
  | { state: 'deployed'; outputs: Record<string, unknown> }
  | { state: 'backend-error'; detail: string }
  | { state: 'parse-error'; detail: string };

/** Hàm phân loại thuần — test được không cần Pulumi thật. */
export function classifyStackOutput(result: ExecResult): PlatformStatusResult {
  if (result.status === 0) {
    if (result.stdout.trim().length === 0) {
      // Không xảy ra với `--json` (thường luôn in `{}`) nhưng fail-closed vẫn đúng hơn im lặng.
      return { state: 'no-outputs' };
    }
    try {
      const outputs = JSON.parse(result.stdout) as Record<string, unknown>;
      if (Object.keys(outputs).length === 0) {
        // `stack output --json` exit 0 với `{}` = stack init nhưng CHƯA từng up.
        return { state: 'no-outputs' };
      }
      return { state: 'deployed', outputs };
    } catch (error) {
      return {
        state: 'parse-error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const combined = `${result.stderr}\n${result.stdout}`;
  if (/no stack named/iu.test(combined)) {
    return { state: 'no-stack' };
  }
  // `status === null` nghĩa là process CHẠY CHƯA ĐƯỢC (binary không tồn tại,
  // không executable...) hoặc bị SIGNAL kill (OOM...) — stderr/stdout rỗng lúc
  // đó, nếu đi tiếp sẽ thành "lỗi Pulumi không xác định" và người dùng không
  // cài `pulumi` bị báo thành lỗi backend. Báo đúng nguyên nhân qua helper
  // dùng chung (cùng chuẩn với `execStreaming`/`pulumiRun`).
  if (result.status === null) {
    return {
      state: 'backend-error',
      detail: `pulumi could not run: ${describeSpawnFailure(result)}`,
    };
  }
  if (
    /unable to open state directory|unable to find backend|cannot connect|dial tcp|permission denied/iu.test(
      combined,
    )
  ) {
    return { state: 'backend-error', detail: combined.trim() };
  }
  // Lỗi không nhận diện được → backend-error (không nuốt). stderr có thể chứa
  // path backend — không in path nhạy cảm, chỉ in dòng lỗi đầu.
  const firstLine = combined
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return { state: 'backend-error', detail: firstLine ?? 'unknown Pulumi error' };
}

/** Truy vấn trạng thái stack platform — read-only, qua context đúng worktree. */
export function queryPlatformStatus(
  ctx: LocalDeployContext,
  env: NodeJS.ProcessEnv,
): PlatformStatusResult {
  // Backend `file://` đòi thư mục state tồn tại trước (PU11). Worktree chưa
  // từng deploy thì thư mục này chưa ai tạo (chỉ `ensureStack` mới mkdir) —
  // bấm CLI lúc đó chỉ nhận `unable to open state directory`, mà phân loại
  // thành `backend-error` là sai chẩn: trạng thái đúng là "chưa deploy".
  // Vẫn read-only: chỉ KIỂM tra sự tồn tại, không tạo gì.
  if (!existsSync(localStateDir(ctx.worktreeRoot))) {
    return { state: 'no-stack' };
  }
  const result = exec(
    'pulumi',
    ['stack', 'output', '--json', '--stack', fullStackRef(PLATFORM_PROJECT, ctx)],
    projectDir(PLATFORM_PROJECT),
    env,
  );
  return classifyStackOutput(result);
}

/**
 * In trạng thái hiện tại: namespace, stack, và trạng thái platform stack.
 *
 * READ-ONLY: không tạo stack, không deploy, không ghi `.env`, không destroy gì.
 */
export function localStatus(options: { worktreeRoot?: string }): number {
  const ctx = resolveContext(options.worktreeRoot);
  console.log(`namespace:      ${ctx.namespace}`);
  console.log(`stack:          ${ctx.stackName}`);
  console.log(`state backend:  ${ctx.stateUrl}`);
  console.log(`network:        ${dockerResourceName(ctx.namespace, 'network')}`);
  console.log(`traefik:        ${dockerResourceName(ctx.namespace, 'traefik')}`);
  console.log(`postgres:       ${dockerResourceName(ctx.namespace, 'postgres')}`);
  console.log(`volume:         ${dockerResourceName(ctx.namespace, 'postgres-volume')}`);
  console.log(`home:           ${dockerResourceName(ctx.namespace, 'home')}`);
  console.log(`backoffice:     ${dockerResourceName(ctx.namespace, 'backoffice')}`);

  const envPath = join(ctx.worktreeRoot, '.env');
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith(`${ROOT_HOST_ENV_KEY}=`));
    if (line !== undefined) console.log(`.env ${ROOT_HOST_ENV_KEY}:  ${line.split('=')[1]}`);
    // KHÔNG in `POSTGRES_PASSWORD` — `local-status` là lệnh hay được chạy và
    // paste output vào ticket/chat. Chỉ báo **có** mặt hay không.
    const hasPassword = readFileSync(envPath, 'utf8')
      .split('\n')
      .some((entry) => entry.startsWith(`${POSTGRES_PASSWORD_ENV_KEY}=`));
    console.log(`.env ${POSTGRES_PASSWORD_ENV_KEY}: ${hasPassword ? 'set' : 'not set'}`);
  }

  // Passphrase: dùng file của worktree nếu có, không thì biến môi trường.
  // `create: false` — `local-status` là read-only, không được tạo file
  // passphrase. Không có passphrase thì vẫn chạy được: `pulumi stack output`
  // đọc outputs mà KHÔNG cần giải mã (đo thật trên CLI 3.270 — khác với
  // `up`/`preview`/`destroy` vốn phải nạp stack config đầy đủ).
  const passphrase = resolveLocalPassphrase(ctx.worktreeRoot, { create: false });
  const env = pulumiEnv(ctx, passphrase);

  const status = queryPlatformStatus(ctx, env);
  switch (status.state) {
    case 'no-stack': {
      console.log('platform:       no stack in the backend — run the local-up lane');
      return 0;
    }
    case 'no-outputs': {
      console.log(
        'platform:       stack exists but has never been up (outputs empty) — run the local-up lane',
      );
      return 0;
    }
    case 'deployed': {
      console.log(`platform outputs: ${JSON.stringify(status.outputs)}`);
      return 0;
    }
    case 'parse-error': {
      console.error(`[local-status] failed to parse platform outputs as JSON: ${status.detail}`);
      return 1;
    }
    case 'backend-error': {
      console.error(`[local-status] Pulumi/backend error: ${status.detail}`);
      return 1;
    }
  }
}

/**
 * CLI entry khi chạy trực tiếp (`npx tsx platform-status.ts --worktree-root
 * <dir>`): nhận cùng cờ với adapter `pnpm dx local-status` và forward nguyên
 * ngữ nghĩa — cùng `--worktree-root` tùy chọn, cùng exit code. Module này chỉ
 * có ĐÚNG một cách thực thi: trực tiếp qua tsx (adapter của dx spawn đúng thế)
 * — không đường import nào khác, nên chạy main ở mức module là đủ.
 */
const rootArgIndex = process.argv.indexOf('--worktree-root');
const rootArg = rootArgIndex >= 0 ? process.argv[rootArgIndex + 1] : undefined;
process.exitCode = localStatus({ worktreeRoot: rootArg });
