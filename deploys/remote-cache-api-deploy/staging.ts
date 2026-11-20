/**
 * Entry lifecycle staging của `remote-cache-api-deploy` — `preview`/`up` trên
 * stack `staging` của project này (port của `platform-deploy/staging.ts`,
 * #453; lane này là một phần của wiring mở rộng theo #350). Chạy qua target
 * Nx: `nx run remote-cache-api-deploy:staging-preview -c staging` →
 * `npx tsx staging.ts preview` (tương tự `staging-up`).
 *
 * Đối lập với `local.ts`: KHÔNG có `down`/`destroy` — teardown staging KHÔNG
 * có workflow (§7.4.1: destroy block ở lớp workflow); checklist tay thuộc
 * runbook vận hành (#364). Mọi đối số khác `preview`/`up` bị từ chối tường
 * minh, không đoán.
 *
 * Mỗi lần chạy ghi MỘT bản ghi evidence JSON mới vào `.staging-evidence/`
 * của project (ngoài Git, `.gitignore`) — hợp đồng provenance §7.3: stack,
 * revision, resource changes, outcome, timestamp. Trên stack marker hiện tại
 * (chưa khai resource nào — bucket R2 là scope #350 sau quyết định tên
 * bucket + bootstrap), một lần chạy chứng minh backend/stack/credential/
 * evidence, không chứng minh resource.
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
  `[remote-cache-api-deploy] staging refused: "${verb}" is not a staging lifecycle phase — ` +
  'only preview | up are allowed. There is NO staging down/destroy workflow: ' +
  'teardown is a manual operator procedure (checklist runbook, issue #364), ' +
  'never an ad-hoc CLI verb.';

function main(argv: readonly string[]): number {
  const parsed = parseStagingPhaseArg(argv);
  if (parsed.kind === 'missing') {
    console.error('[remote-cache-api-deploy] usage: npx tsx staging.ts <preview|up>');
    return 1;
  }
  if (parsed.kind === 'refused') {
    console.error(REFUSAL_MESSAGE(parsed.verb));
    return 1;
  }
  try {
    const { record, recordPath } = runStagingPhase(parsed.phase, 'remote-cache-api-deploy');
    console.log(
      `[remote-cache-api-deploy] staging ${record.phase} OK: ${record.stackRef} ` +
        `(revision ${record.revision ?? 'n/a'}, changes ${JSON.stringify(record.resourceChanges ?? {})})`,
    );
    console.log(`[remote-cache-api-deploy] evidence record: ${recordPath}`);
    return 0;
  } catch (error) {
    console.error(
      `[remote-cache-api-deploy] staging ${parsed.phase} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
