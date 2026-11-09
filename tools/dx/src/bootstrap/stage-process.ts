/**
 * Cổng chạy một bước bootstrap như **tiến trình con** — bản production của
 * {@link BootstrapStageRunner}.
 *
 * Vì sao spawn chứ không import: `tools/*` mang `type:tooling`, và
 * `.oxlintrc.json` chỉ cho `type:tooling` phụ thuộc `type:tooling`. Import
 * `apps/account/db/bootstrap.mts` sẽ vừa vi phạm constraint đó vừa kéo code
 * migration vào một project không sở hữu nó. Đây cùng hình dạng adapter mà
 * `local-status` dùng để gọi entry của `platform-deploy`.
 *
 * Ba bất biến của lớp này:
 *
 * 1. **Không có secret trong argv.** Credential đi qua env của tiến trình con;
 *    argv chỉ có tên action.
 * 2. **Không có PII trong log.** Runner không in payload, không in env, không
 *    in stderr thô của con — chỉ mã lý do máy đọc.
 * 3. **Fail-closed.** Con thoát khác 0 mà không có JSON lý do, hoặc in ra JSON
 *    không đúng hình dạng, đều thành lỗi tường minh — không được đọc là thành
 *    công.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { ROOT_DIR } from '../utils.js';
import type {
  BootstrapStageRequest,
  BootstrapStageRunner,
  BootstrapStageResult,
} from './bootstrap-superadmin.js';

/** Thư mục project chứa CLI bootstrap của từng service. */
const SERVICE_ROOT: Readonly<Record<BootstrapStageRequest['service'], string>> = {
  account: join(ROOT_DIR, 'apps', 'account'),
  'staff-access': join(ROOT_DIR, 'apps', 'staff-access'),
};

/**
 * Biến env mà **orchestrator** đọc để chuyển cho đúng service.
 *
 * Một tên `DATABASE_URL` duy nhất cho cả hai con là sai: hai service dùng hai
 * database khác nhau, nên truyền chung một giá trị nghĩa là bước này chạy trên
 * database của service kia. Mỗi service nhận đúng chuỗi kết nối của nó, dưới
 * tên mà CLI của nó đã đọc từ trước (`DATABASE_URL`).
 */
export const ACCOUNT_DATABASE_URL_ENV = 'ECOMA_ACCOUNT_DATABASE_URL';
export const STAFF_ACCESS_DATABASE_URL_ENV = 'ECOMA_STAFF_ACCESS_DATABASE_URL';

/** Env được truyền cho tiến trình con — `DATABASE_URL` của đúng service. */
function stageEnv(
  service: BootstrapStageRequest['service'],
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const source = service === 'account' ? ACCOUNT_DATABASE_URL_ENV : STAFF_ACCESS_DATABASE_URL_ENV;

  // Bỏ **cả hai** biến credential của orchestrator khỏi env của con: một tiến
  // trình `account` không có lý do gì đọc được chuỗi kết nối `db-staff-access`
  // (và ngược lại). Chỉ chuỗi của chính service đi vào dưới tên `DATABASE_URL`.
  const orchestratorKeys = new Set<string>([
    ACCOUNT_DATABASE_URL_ENV,
    STAFF_ACCESS_DATABASE_URL_ENV,
  ]);
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!orchestratorKeys.has(key)) childEnv[key] = value;
  }
  childEnv['DATABASE_URL'] = env[source] ?? '';

  return childEnv;
}

/** Dòng JSON cuối cùng parse được từ một stream — `undefined` khi không có. */
function lastJsonLine(text: string): Record<string, unknown> | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined || !line.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Dòng log thường bắt đầu bằng `{` nhưng không phải JSON — bỏ qua.
    }
  }
  return undefined;
}

/**
 * Dựng runner production.
 *
 * `spawn` được inject để spec kiểm nhánh lỗi mà không cần Postgres; mặc định
 * là `spawnSync` thật.
 */
export function createSpawnStageRunner(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly spawn?: typeof spawnSync;
  } = {},
): BootstrapStageRunner {
  const env = options.env ?? process.env;
  const spawn = options.spawn ?? spawnSync;

  return (request: BootstrapStageRequest): BootstrapStageResult => {
    const result = spawn(
      'npx',
      ['tsx', '--tsconfig', 'tsconfig.db.json', 'db/bootstrap.mts', request.action],
      {
        cwd: SERVICE_ROOT[request.service],
        env: stageEnv(request.service, env),
        input: `${JSON.stringify(request.input)}\n`,
        encoding: 'utf8',
        // Không dùng shell: argv không đi qua một shell interpreter nào.
        shell: false,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    if (result.error !== undefined) {
      // Lỗi spawn (thiếu tiến trình) — nêu loại lỗi, không nêu env.
      const rawCode: unknown = (result.error as unknown as { code?: unknown }).code;
      const code = typeof rawCode === 'string' ? rawCode : 'unknown';
      return {
        ok: false,
        stage: `${request.service}.${request.action}`,
        reason: `spawn_failed:${code}`,
      };
    }

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const payload = lastJsonLine(stdout);

    if (result.status === 0) {
      if (payload === undefined) {
        // Exit 0 mà không có JSON: không có bằng chứng bước nào đã chạy.
        return {
          ok: false,
          stage: `${request.service}.${request.action}`,
          reason: 'missing_json_response',
        };
      }
      const { stage, status, ...rest } = payload;
      if (typeof stage !== 'string' || typeof status !== 'string') {
        return {
          ok: false,
          stage: `${request.service}.${request.action}`,
          reason: 'malformed_json_response',
        };
      }
      return { ok: true, stage, status, payload: rest };
    }

    const denied = lastJsonLine(stderr);
    const reason = typeof denied?.['reason'] === 'string' ? denied['reason'] : 'service_failed';
    const stage =
      typeof denied?.['stage'] === 'string'
        ? denied['stage']
        : `${request.service}.${request.action}`;
    return { ok: false, stage, reason };
  };
}
