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
 * revision, resource changes, outcome, timestamp. Stack khai R2 bucket object
 * storage (`staging-program.ts`, #514) và HyperdriveConfig của `db-remote-cache`
 * (scope #350, pattern pilot #539; origin đọc từ stack config và fail-closed
 * khi chưa có — đường tới origin private là Tunnel/VPC Service của #349) —
 * một lần chạy hiện vẫn dừng TRƯỚC Pulumi khi thiếu prerequisite vận hành
 * (bootstrap backend state + credential, inventory fail-closed của
 * `staging-run.ts`); khi đã đủ điều kiện, evidence ghi kèm resource changes.
 *
 * Sau một lần `up` xanh, entry đọc stack output `hyperdriveConfigId` — nguồn
 * định danh để wiring `env.staging.hyperdrive` của
 * `apps/remote-cache-api/wrangler.jsonc` (§9.1: id do Pulumi cung cấp,
 * Wrangler không tạo config; guard `resource-bindings` chặn placeholder). Id
 * đọc được là surface KẾT QUẢ cho operator fill vào wrangler.jsonc — entry
 * không tự sửa file đó: wrangler config là tài sản review-able trong Git,
 * không phải ghi-deploy-time. Id không đọc được (lỗi/placeholder) → cảnh báo,
 * KHÔNG biến một lần provision thành công thành thất bại.
 *
 * Credential fail-closed (xem `resolveStagingRunEnv`): thiếu bất kỳ khóa
 * environment bắt buộc nào là từ chối TRƯỚC KHI đụng Pulumi — đặc biệt
 * `ECOMA_PULUMI_STATE_URL_STAGING` thiếu nghĩa là staging chưa được bootstrap
 * (#350), tuyệt đối không fallback sang backend khác.
 */

// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// báo cáo duy nhất của operator (như `local.ts`).

import { deployProjectDir, stagingDeploymentAdapter } from '@ecoma-io/deployment';

import {
  parseStagingPhaseArg,
  readHyperdriveConfigId,
  resolveStagingRunEnv,
  runStagingPhase,
} from './staging-run.js';

const REFUSAL_MESSAGE = (verb: string): string =>
  `[remote-cache-api-deploy] staging refused: "${verb}" is not a staging lifecycle phase — ` +
  'only preview | up are allowed. There is NO staging down/destroy workflow: ' +
  'teardown is a manual operator procedure (checklist runbook, issue #364), ' +
  'never an ad-hoc CLI verb.';

// Toàn thân main nằm trong MỘT try: mọi throw bất ngờ (từ parse, chạy pulumi,
// ghi evidence) vẫn ra message hợp đồng trên stderr + exit 1, không bao giờ
// để Node in stack trace thay message cho operator.
function main(argv: readonly string[]): number {
  try {
    const parsed = parseStagingPhaseArg(argv);
    if (parsed.kind === 'missing') {
      console.error('[remote-cache-api-deploy] usage: npx tsx staging.ts <preview|up>');
      return 1;
    }
    if (parsed.kind === 'refused') {
      console.error(REFUSAL_MESSAGE(parsed.verb));
      return 1;
    }
    const { record, recordPath } = runStagingPhase(parsed.phase, 'remote-cache-api-deploy');
    console.log(
      `[remote-cache-api-deploy] staging ${record.phase} OK: ${record.stackRef} ` +
        `(revision ${record.revision ?? 'n/a'}, changes ${JSON.stringify(record.resourceChanges ?? {})})`,
    );
    console.log(`[remote-cache-api-deploy] evidence record: ${recordPath}`);
    if (parsed.phase === 'up') {
      // Đọc output id bằng CÙNG inventory + selection của lần `up` vừa xanh —
      // một lần `resolveStagingRunEnv` duy nhất cho khối này.
      const projectDir = deployProjectDir('remote-cache-api-deploy');
      const { backendUrl, env } = resolveStagingRunEnv();
      const selection = stagingDeploymentAdapter.stackSelection('remote-cache-api-deploy', {
        slot: 'staging',
        backendUrl,
      });
      const hyperdriveConfigId = readHyperdriveConfigId(projectDir, selection, env);
      if (hyperdriveConfigId === undefined) {
        console.error(
          '[remote-cache-api-deploy] staging up OK but the hyperdrive config id could not be read from ' +
            'stack output `hyperdriveConfigId` (missing, unreadable, or placeholder-shaped) — ' +
            'do NOT fill a guessed id into apps/remote-cache-api/wrangler.jsonc; inspect the stack and ' +
            're-read `pulumi stack output hyperdriveConfigId` manually',
        );
      } else {
        console.log(
          `[remote-cache-api-deploy] hyperdrive config id: ${hyperdriveConfigId} — wiring step: fill it as ` +
            '`env.staging.hyperdrive[0].id` (binding DB_REMOTE_CACHE) in apps/remote-cache-api/wrangler.jsonc; ' +
            'never a placeholder (review guard refuses all-zeros/empty ids) (#350)',
        );
      }
    }
    return 0;
  } catch (error) {
    console.error(
      `[remote-cache-api-deploy] staging failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
