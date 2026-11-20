/**
 * Entry lifecycle staging của `transactional-mail-deploy` — `preview`/`up`
 * trên stack `staging` của project này (port của `auth-deploy/staging.ts`,
 * #539). Chạy qua target Nx: `nx run transactional-mail-deploy:staging-preview
 * -c staging` → `npx tsx staging.ts preview` (tương tự `staging-up`).
 *
 * Đối lập với `local.ts`: KHÔNG có `down`/`destroy` — teardown staging KHÔNG
 * có workflow (§7.4.1: destroy block ở lớp workflow); checklist tay thuộc
 * runbook vận hành (#364). Mọi đối số khác `preview`/`up` bị từ chối tường
 * minh, không đoán.
 *
 * Chương trình trên stack staging khai D1 `stg-mail` + chuỗi bốn Queue
 * (#355, `staging-program.ts`). Việc chạy thật dừng TRƯỚC Pulumi khi thiếu
 * prerequisite vận hành (bootstrap backend state + credential, inventory
 * fail-closed của `staging-run.ts`); khi đã đủ điều kiện, evidence ghi kèm
 * resource changes của provisioning.
 *
 * Sau một lần `up` xanh, entry đọc stack output `mailDatabaseId` — nguồn
 * định danh để wiring `env.staging.d1_databases` của
 * `apps/transactional-mail/wrangler.jsonc` (§9.1: id do Pulumi cung cấp,
 * Wrangler không tạo resource). Id đọc được là surface KẾT QUẢ cho operator
 * fill vào wrangler.jsonc — entry không tự sửa file đó: wrangler config là
 * tài sản review-able trong Git, không phải ghi-deploy-time. Id không đọc
 * được (lỗi/placeholder) → cảnh báo, KHÔNG biến một lần provision thành công
 * thành thất bại.
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
  readDatabaseId,
  resolveStagingRunEnv,
  runStagingPhase,
} from './staging-run.js';

const REFUSAL_MESSAGE = (verb: string): string =>
  '[transactional-mail-deploy] staging refused: "' +
  verb +
  '" is not a staging lifecycle phase — ' +
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
      console.error('[transactional-mail-deploy] usage: npx tsx staging.ts <preview|up>');
      return 1;
    }
    if (parsed.kind === 'refused') {
      console.error(REFUSAL_MESSAGE(parsed.verb));
      return 1;
    }
    const { record, recordPath } = runStagingPhase(parsed.phase, 'transactional-mail-deploy');
    console.log(
      `[transactional-mail-deploy] staging ${record.phase} OK: ${record.stackRef} ` +
        `(revision ${record.revision ?? 'n/a'}, changes ${JSON.stringify(record.resourceChanges ?? {})})`,
    );
    console.log(`[transactional-mail-deploy] evidence record: ${recordPath}`);
    if (parsed.phase === 'up') {
      // Đọc output id bằng CÙNG inventory + selection của lần `up` vừa xanh —
      // một lần `resolveStagingRunEnv` duy nhất cho khối này.
      const projectDir = deployProjectDir('transactional-mail-deploy');
      const { backendUrl, env } = resolveStagingRunEnv();
      const selection = stagingDeploymentAdapter.stackSelection('transactional-mail-deploy', {
        slot: 'staging',
        backendUrl,
      });
      const mailDatabaseId = readDatabaseId(projectDir, selection, env);
      if (mailDatabaseId === undefined) {
        console.error(
          '[transactional-mail-deploy] staging up OK but the mail database id could not be read ' +
            'from stack output `mailDatabaseId` (missing, unreadable, or placeholder-shaped) — ' +
            'do NOT fill a guessed id into apps/transactional-mail/wrangler.jsonc; inspect the ' +
            'stack and re-read `pulumi stack output mailDatabaseId` manually',
        );
      } else {
        console.log(
          `[transactional-mail-deploy] mail database id: ${mailDatabaseId} — wiring step: fill it as ` +
            '`env.staging.d1_databases[0].database_id` (binding mail, database_name stg-mail) in ' +
            'apps/transactional-mail/wrangler.jsonc; never a placeholder (review guard refuses ' +
            'all-zeros/empty ids) (#355). Queue names are the stg- constants of staging-run.ts — ' +
            'apps/transactional-mailer-job/wrangler.jsonc must reference the same chain',
        );
      }
    }
    return 0;
  } catch (error) {
    console.error(
      `[transactional-mail-deploy] staging failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
