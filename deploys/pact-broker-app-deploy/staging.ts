/**
 * Entry lifecycle staging của `pact-broker-app-deploy` — `preview`/`up` trên
 * stack `staging` của project này (port của `auth-deploy/staging.ts`, #539;
 * lane thuộc wiring staging Pact Broker theo #358). Chạy qua target Nx:
 * `nx run pact-broker-app-deploy:staging-preview -c staging` →
 * `npx tsx staging.ts preview` (tương tự `staging-up`).
 *
 * Đối lập với `local.ts`: KHÔNG có `down`/`destroy` — teardown staging KHÔNG
 * có workflow (§7.4.1: destroy block ở lớp workflow); checklist tay thuộc
 * runbook vận hành (#364). Mọi đối số khác `preview`/`up` bị từ chối tường
 * minh, không đoán.
 *
 * Chương trình trên stack staging khai HyperdriveConfig của `db-pact-broker-app`
 * (#358, `staging-program.ts`) — origin đọc từ stack config và fail-closed khi
 * chưa có: đường tới origin private là Tunnel/VPC Service của #349, chưa
 * provision lần nào. Một lần chạy hiện vẫn dừng TRƯỚC Pulumi khi thiếu
 * prerequisite vận hành (bootstrap backend state + credential, inventory
 * fail-closed của `staging-run.ts`); khi đã đủ điều kiện, evidence ghi kèm
 * resource changes của config.
 *
 * Sau một lần `up` xanh, entry đọc stack output `hyperdriveConfigId` — nguồn
 * định danh để wiring `env.staging.hyperdrive` của
 * `apps/pact-broker-app/wrangler.jsonc` (§9.1: id do Pulumi cung cấp, Wrangler
 * không tạo config; guard `resource-bindings` chặn placeholder). Id đọc được
 * là surface KẾT QUẢ cho operator fill vào wrangler.jsonc — entry không tự sửa
 * file đó: wrangler config là tài sản review-able trong Git, không phải
 * ghi-deploy-time. Id không đọc được (lỗi/placeholder) → cảnh báo, KHÔNG biến
 * một lần provision thành công thành thất bại.
 *
 * Credential fail-closed (xem `runStagingPhase`): thiếu bất kỳ khóa
 * environment bắt buộc nào là từ chối TRƯỚC KHI đụng Pulumi — đặc biệt
 * `ECOMA_PULUMI_STATE_URL_STAGING` thiếu nghĩa là staging chưa được bootstrap,
 * tuyệt đối không fallback sang backend khác. Env được resolve một lần trong
 * `runStagingPhase` và tái dùng qua `runEnv` cho cả phase lẫn bước đọc output.
 */

// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// báo cáo duy nhất của operator (như `local.ts`).

import { parseStagingPhaseArg, readHyperdriveConfigId, runStagingPhase } from './staging-run.js';

const REFUSAL_MESSAGE = (verb: string): string =>
  `[pact-broker-app-deploy] staging refused: "${verb}" is not a staging lifecycle phase — ` +
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
      console.error('[pact-broker-app-deploy] usage: npx tsx staging.ts <preview|up>');
      return 1;
    }
    if (parsed.kind === 'refused') {
      console.error(REFUSAL_MESSAGE(parsed.verb));
      return 1;
    }
    const { record, recordPath, env, selection, projectDir } = runStagingPhase(
      parsed.phase,
      'pact-broker-app-deploy',
    );
    console.log(
      `[pact-broker-app-deploy] staging ${record.phase} OK: ${record.stackRef} ` +
        `(revision ${record.revision ?? 'n/a'}, changes ${JSON.stringify(record.resourceChanges ?? {})})`,
    );
    console.log(`[pact-broker-app-deploy] evidence record: ${recordPath}`);
    if (parsed.phase === 'up') {
      // Đọc output id bằng ĐÚNG env/selection/projectDir đã resolve MỘT lần
      // trong `runStagingPhase` — inventory fail-closed chạy đúng một lần cho
      // cả phase lẫn bước đọc.
      const hyperdriveConfigId = readHyperdriveConfigId(projectDir, selection, env);
      if (hyperdriveConfigId === undefined) {
        console.error(
          '[pact-broker-app-deploy] staging up OK but the hyperdrive config id could not be ' +
            'read from stack output `hyperdriveConfigId` (missing, unreadable, or ' +
            'placeholder-shaped) — do NOT fill a guessed id into ' +
            'apps/pact-broker-app/wrangler.jsonc; inspect the stack and re-read ' +
            '`pulumi stack output hyperdriveConfigId` manually',
        );
      } else {
        console.log(
          `[pact-broker-app-deploy] hyperdrive config id: ${hyperdriveConfigId} — wiring step: ` +
            'fill it as `env.staging.hyperdrive[0].id` (binding DB_PACT_BROKER_APP) in ' +
            'apps/pact-broker-app/wrangler.jsonc; never a placeholder (review guard refuses ' +
            'all-zeros/empty ids) (#358)',
        );
      }
    }
    return 0;
  } catch (error) {
    console.error(
      `[pact-broker-app-deploy] staging failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
