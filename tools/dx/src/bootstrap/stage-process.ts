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

/**
 * Env **tối thiểu** để `npx tsx` khởi động được, lấy nguyên giá trị từ env của
 * orchestrator. Đây là allowlist, không phải denylist: biến không nằm trong danh
 * sách này không bao giờ tới tiến trình con.
 *
 * Vì sao allowlist: env của người vận hành có thể chứa credential của dịch vụ
 * khác, token CI, hay biến của một shell tương tác. Sao chép toàn bộ env rồi bỏ
 * hai tên credential đã biết là một danh sách chặn — mọi secret khác vẫn đi qua,
 * và một biến mới xuất hiện sau này cũng mặc định đi qua. Chỉ những gì `node`,
 * `npx` và `tsx` thật sự cần mới được chuyển.
 *
 * `PATH`/`HOME`/`TMPDIR` cần cho việc tìm binary, cache và thư mục tạm của npm.
 * `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `NODE_NO_WARNINGS` và `FORCE_COLOR`
 * điều khiển runtime Node; một tập **đóng** biến `npm_config_*` điều khiển `npx`.
 *
 * Không chuyển cả tiền tố `npm_config_*`: tiền tố đó bao gồm cả
 * `npm_config__authToken` và `npm_config_https_proxy` (một proxy có thể mang
 * `user:password` trong URL), tức là thêm hai credential nữa tới tiến trình con.
 */
const INHERITED_NPM_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'npm_config_cache',
  'npm_config_registry',
  'npm_config_userconfig',
  'npm_config_prefix',
  'npm_config_loglevel',
  'npm_config_yes',
  'npm_config_offline',
  'npm_config_prefer_offline',
  'npm_config_ignore_scripts',
  'npm_config_update_notifier',
]);

const INHERITED_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_NO_WARNINGS',
  'FORCE_COLOR',
  'NO_COLOR',
  'CI',
] as const;

/** Tên credential — chỉ được xuất hiện dưới dạng `DATABASE_URL` của đúng service. */
const CREDENTIAL_ENV_KEYS: ReadonlySet<string> = new Set([
  ACCOUNT_DATABASE_URL_ENV,
  STAFF_ACCESS_DATABASE_URL_ENV,
]);

/**
 * Env của tiến trình con: allowlist tối thiểu + `DATABASE_URL` của đúng service.
 *
 * Không bao giờ chuyển cả hai credential: một tiến trình `account` cầm được
 * chuỗi kết nối `db-staff-access` là vượt ranh giới sở hữu dữ liệu, kể cả khi nó
 * không dùng tới.
 */
function stageEnv(
  service: BootstrapStageRequest['service'],
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};

  for (const key of INHERITED_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && !CREDENTIAL_ENV_KEYS.has(key)) childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (CREDENTIAL_ENV_KEYS.has(key)) continue;
    if (INHERITED_NPM_CONFIG_KEYS.has(key)) childEnv[key] = value;
  }

  const source = service === 'account' ? ACCOUNT_DATABASE_URL_ENV : STAFF_ACCESS_DATABASE_URL_ENV;
  // Chỉ `DATABASE_URL` của **chính** service. Rỗng nghĩa là chưa cấu hình; CLI
  // sẽ từ chối bằng `DATABASE_URL is not set` thay vì đoán một database mặc định.
  childEnv['DATABASE_URL'] = env[source] ?? '';

  return childEnv;
}

/** Stage name mỗi action **phải** in ra — chốt cả service lẫn action. */
const EXPECTED_STAGE: Readonly<Record<BootstrapStageRequest['action'], string>> = {
  provision: 'account.provision',
  verify: 'account.verify',
  'staff-provision': 'staff.provision',
  'staff-assign': 'staff.assign',
  'staff-verify': 'staff.verify',
};

/** Mã lý do hợp lệ của service: snake_case, không khoảng trắng, không dấu. */
const REASON_CODE = /^[a-z][a-z0-9_]*$/u;

/**
 * Status mà mỗi action **được** phép trả về khi exit 0.
 *
 * Không có tập này thì một con thoát 0 kèm `status: "denied"` bị đọc thành thành
 * công — đúng cái mà exit code lẽ ra phải ngăn. Tập là đóng theo action: `verify`
 * của Account không bao giờ trả `created`, `staff-verify` không bao giờ trả
 * `converged`.
 */
const SUCCESS_STATUS: Readonly<Record<BootstrapStageRequest['action'], ReadonlySet<string>>> = {
  provision: new Set(['created', 'converged']),
  verify: new Set(['converged']),
  'staff-provision': new Set(['created', 'converged']),
  'staff-assign': new Set(['created', 'converged']),
  'staff-verify': new Set(['verified']),
};

/**
 * Trần thời gian một bước. `pg` mặc định không có connect timeout, không
 * `statement_timeout` và không `lock_timeout`, nên một host bị chặn hoặc một
 * `pg_advisory_xact_lock` đang bị giữ sẽ treo procedure vô hạn — và một lần chạy
 * treo không báo được gì cả. Timeout biến nó thành một mã lý do đọc được.
 */
const STAGE_TIMEOUT_MS = 120_000;

/**
 * Dòng JSON cuối cùng của một stream — `undefined` khi dòng cuối không phải
 * một JSON object.
 *
 * Chỉ đọc dòng **cuối cùng** không rỗng: quét ngược tới dòng JSON parse được
 * đầu tiên sẽ nhận một dòng cũ khi dòng cuối bị cắt cụt, tức đọc một kết quả
 * cũ thành kết quả của lần chạy này.
 */
function lastJsonLine(text: string): Record<string, unknown> | undefined {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const last = lines[lines.length - 1]?.trim();
  if (last === undefined || !last.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(last);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Dòng cuối không phải JSON — coi như không có phản hồi.
  }
  return undefined;
}

/**
 * Tìm envelope từ chối của **đúng bước này** trong stderr, quét ngược từ dòng
 * cuối.
 *
 * Không chỉ đọc dòng cuối: `npm` in cảnh báo/notice trên stderr của tiến trình
 * con và có thể in chúng *sau* dòng JSON của con, nên đọc mỗi dòng cuối sẽ biến
 * một `mode_mismatch` rõ ràng thành `service_failed` — mất đúng lý do mà bảng
 * quyết định của runbook dựa vào. Quét ngược vẫn giữ tính fail-closed: chỉ một
 * object có `stage` khớp bước đang chạy và `reason` đúng dạng mã mới được nhận,
 * nên text tuỳ ý của con không vào được nhật ký.
 */
function denialEnvelope(
  stderr: string,
  expectedStage: string,
): { readonly stage: string; readonly reason: string } | undefined {
  const lines = stderr.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if (record['stage'] !== expectedStage) continue;
      if (typeof record['reason'] !== 'string' || !REASON_CODE.test(record['reason'])) continue;
      return { stage: expectedStage, reason: record['reason'] };
    } catch {
      // Dòng không phải JSON — thử dòng trước đó.
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
    // Thiếu credential là điều kiện tất định, kiểm được trước khi spawn: để con
    // chạy rồi chết vì `DATABASE_URL is not set` sẽ hiện ra thành
    // `service_failed`, không phân biệt được với lỗi spawn hay lỗi usage.
    const source =
      request.service === 'account' ? ACCOUNT_DATABASE_URL_ENV : STAFF_ACCESS_DATABASE_URL_ENV;
    if ((env[source] ?? '') === '') {
      return {
        ok: false,
        stage: EXPECTED_STAGE[request.action],
        reason: `database_url_missing:${source}`,
      };
    }

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
        timeout: STAGE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );

    if (result.error !== undefined) {
      // Lỗi spawn (thiếu tiến trình) — nêu loại lỗi, không nêu env. `ENOBUFS` là
      // mã Node gán khi con in vượt `maxBuffer`; nó không phải "không spawn
      // được", nên tách thành mã riêng để người vận hành biết nhìn vào output
      // của con thay vì tìm một binary không tồn tại.
      const rawCode: unknown = (result.error as unknown as { code?: unknown }).code;
      const code = typeof rawCode === 'string' ? rawCode : 'unknown';
      if (code === 'ENOBUFS') {
        return {
          ok: false,
          stage: EXPECTED_STAGE[request.action],
          reason: 'output_limit_exceeded',
        };
      }
      if (code === 'ETIMEDOUT') {
        return {
          ok: false,
          stage: EXPECTED_STAGE[request.action],
          reason: 'stage_timeout',
        };
      }
      return {
        ok: false,
        stage: EXPECTED_STAGE[request.action],
        reason: `spawn_failed:${code}`,
      };
    }

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const expectedStage = EXPECTED_STAGE[request.action];

    if (result.status === 0) {
      const payload = lastJsonLine(stdout);
      if (payload === undefined) {
        // Exit 0 mà không có JSON: không có bằng chứng bước nào đã chạy.
        return {
          ok: false,
          stage: expectedStage,
          reason: 'missing_json_response',
        };
      }
      const { stage, status, ...rest } = payload;
      // `stage` phải đúng bước đã yêu cầu: nhận một stage khác nghĩa là kết quả
      // này không chứng minh action vừa chạy. `status` phải nằm trong tập thành
      // công của action: exit 0 kèm `status: "denied"` không phải thành công.
      if (
        typeof stage !== 'string' ||
        typeof status !== 'string' ||
        stage !== expectedStage ||
        !REASON_CODE.test(status) ||
        !SUCCESS_STATUS[request.action].has(status)
      ) {
        return {
          ok: false,
          stage: expectedStage,
          reason: 'malformed_json_response',
        };
      }
      return { ok: true, stage, status, payload: rest };
    }

    const denied = denialEnvelope(stderr, expectedStage);
    // Chỉ chấp nhận mã lý do máy đọc; mọi text khác của con bị bỏ, nên một con
    // lỗi không chèn được địa chỉ, DSN hay nội dung tuỳ ý vào nhật ký vận hành.
    if (denied === undefined) {
      return { ok: false, stage: expectedStage, reason: 'service_failed' };
    }
    return { ok: false, stage: denied.stage, reason: denied.reason };
  };
}
