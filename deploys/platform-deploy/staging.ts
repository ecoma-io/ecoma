/**
 * Entry lifecycle staging của `platform-deploy` — `preview`/`up` trên stack
 * `staging` của project này (executor ĐẦU TIÊN của lane provisioning
 * staging, #368). Chạy qua target Nx: `nx run platform-deploy:staging-preview
 * -c staging` → `npx tsx staging.ts preview` (tương tự `staging-up`).
 *
 * Đối lập với `local.ts`: KHÔNG có `down`/`destroy` — teardown staging KHÔNG
 * có workflow (§7.4.1: destroy block ở lớp workflow); checklist tay thuộc
 * runbook vận hành (#364). Mọi đối số khác `preview`/`up` bị từ chối tường
 * minh, không đoán.
 *
 * Mỗi lần chạy ghi MỘT bản ghi evidence JSON mới vào
 * `.staging-evidence/` của project (ngoài Git, `.gitignore`) — hợp đồng
 * provenance §7.3: stack, revision, resource changes, outcome, timestamp.
 *
 * Credential fail-closed (xem `resolveStagingRunEnv`): thiếu bất kỳ khóa
 * environment bắt buộc nào là từ chối TRƯỚC KHI đụng Pulumi — đặc biệt
 * `ECOMA_PULUMI_STATE_URL_STAGING` thiếu nghĩa là staging chưa được bootstrap
 * (#350), tuyệt đối không fallback sang backend khác.
 */

// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// báo cáo duy nhất của operator (như `local.ts`).

import { runStagingPhase, parseStagingPhaseArg } from './staging-run.js';

const REFUSAL_MESSAGE = (verb: string): string =>
  `[platform-deploy] staging refused: "${verb}" is not a staging lifecycle phase — ` +
  'only preview | up are allowed. There is NO staging down/destroy workflow: ' +
  'teardown is a manual operator procedure (checklist runbook, issue #364), ' +
  'never an ad-hoc CLI verb.';

/**
 * `--project <name>` cho unit deployment khác tái sử dụng CÙNG engine này
 * (`staging-pg-host` #349) mà không nhân bản logic credential/evidence.
 * Mặc định là chính project này — hành vi target của #453 KHÔNG đổi.
 */
function resolveTargetProject(argv: readonly string[]): {
  project: string;
  rest: readonly string[];
} {
  const flagIndex = argv.indexOf('--project');
  if (flagIndex < 0) return { project: 'platform-deploy', rest: argv };
  const name = argv[flagIndex + 1];
  if (name === undefined || !/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
    throw new Error(`--project requires a plain project name (got: ${String(name)})`);
  }
  return { project: name, rest: [...argv.slice(0, flagIndex), ...argv.slice(flagIndex + 2)] };
}

function main(argv: readonly string[]): number {
  let project: string;
  let phaseArgv: readonly string[];
  try {
    ({ project, rest: phaseArgv } = resolveTargetProject(argv));
  } catch (error) {
    console.error(`[platform-deploy] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const parsed = parseStagingPhaseArg(phaseArgv);
  if (parsed.kind === 'missing') {
    console.error('[platform-deploy] usage: npx tsx staging.ts <preview|up> [--project <name>]');
    return 1;
  }
  if (parsed.kind === 'refused') {
    console.error(REFUSAL_MESSAGE(parsed.verb));
    return 1;
  }
  try {
    const { record, recordPath } = runStagingPhase(parsed.phase, project);
    console.log(
      `[platform-deploy] staging ${record.phase} OK: ${record.stackRef} ` +
        `(revision ${record.revision ?? 'n/a'}, changes ${JSON.stringify(record.resourceChanges ?? {})})`,
    );
    console.log(`[platform-deploy] evidence record: ${recordPath}`);
    return 0;
  } catch (error) {
    console.error(
      `[platform-deploy] staging ${parsed.phase} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
