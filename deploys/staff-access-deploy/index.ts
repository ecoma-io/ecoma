/**
 * Entry chương trình Pulumi của `staff-access-deploy` — lane guard #354.
 *
 * Trước guard này, MỌI stack chạy cùng một thân chương trình: `pulumi up`
 * trên backend staging khai Docker resource local sai environment (cùng hazard
 * mà guard của `platform-deploy` chặn từ #368 — port theo pattern đã merge
 * #453, giữ pattern copy của `remote-cache-api-deploy`/`auth-deploy`). Guard
 * phân loại stack TRƯỚC KHI nạp thân:
 *
 * - `local-*` — lane local hiện hành: nạp `local-program.ts` khai Docker
 *   resource namespace-scoped (WIC container `ecoma-staff-access` + database
 *   `db-staff-access` và hai role PostgreSQL);
 * - `staging`/`staging-candidate` — lane staging: nạp `staging-program.ts`
 *   khai HyperdriveConfig của `db-staff-access` theo inventory §9.1 (config
 *   per-database per-lane, scope #354 theo pattern pilot #350/#539). Origin
 *   đọc từ stack config và FAIL CLOSED khi chưa có: đường tới origin private
 *   là Tunnel/VPC Service của #349, chưa provision lần nào. Việc chạy thật còn
 *   chặn prerequisite vận hành fail-closed ở inventory của `staging-run.ts`
 *   (bootstrap backend state một lần ngoài mọi stack + token Cloudflare + R2
 *   token bucket-scoped + passphrase per-stack) — guard không tự mở đường nào
 *   cho chương trình chạy khi thiếu điều kiện đó;
 * - khác — fail-closed: không stack lạ nào được phép khai resource nào.
 *
 * Stack outputs của lane local là namespace `export const` của
 * `local-program.ts`; lane staging trả `{ hyperdriveConfigId }` của
 * `staging-program.ts` — nguồn định danh để wiring
 * `env.staging.hyperdrive` của `apps/staff-access/wrangler.jsonc` về sau (id do
 * Pulumi cung cấp, Wrangler KHÔNG tạo config — §9.1). Pulumi language host
 * (`cmd/run/run.js`) lấy **default export duy nhất** của entry làm kết quả
 * program = stack outputs, nên entry forward nguyên kết quả của lane được nạp
 * qua `export default` — outputs của lane local KHÔNG ĐỔI so với thời thân
 * chương trình nằm ngay trong entry. Entry vì thế chỉ được phép có ĐÚNG MỘT
 * export: `default`.
 */

import * as pulumi from '@pulumi/pulumi';

import { classifyStaffAccessDeployStack } from './staging-run.js';

const currentStackRef = pulumi.getStack();
const staffAccessDeployStackLane = classifyStaffAccessDeployStack(currentStackRef);
if (staffAccessDeployStackLane === 'unknown') {
  throw new Error(
    `unknown stack "${currentStackRef}" for staff-access-deploy — allowed stacks are ` +
      'local-<namespace> (local lane) and the staging slots staging|staging-candidate (#354, ' +
      'pattern #453); this program declares namespace-scoped Docker resources (local lane) ' +
      'and the staging Hyperdrive config for db-staff-access (staging lane) and must never run on ' +
      'another stack',
  );
}
// Nạp thân theo lane — specifier `.js` resolvable qua ts-node/esm hooks như
// mọi import nội bộ của package (`type: "module"`).
const stagingProgramResult =
  staffAccessDeployStackLane === 'staging'
    ? await import('./staging-program.js')
    : await import('./local-program.js');

// Language host (`cmd/run/run.js`) unwrap ĐÚNG MỘT LẦN ở entry: nếu entry có
// default export thì lấy giá trị đó làm program result. Forward nguyên namespace
// của lane staging sẽ lồng outputs dưới khóa `default` (`pulumi stack output
// hyperdriveConfigId` không tìm thấy) — lane staging có default export nên
// forward đúng object đó; lane local chỉ có named exports (`default` undefined)
// nên forward nguyên namespace. OCR head 7c145f3b #354.
export default (stagingProgramResult as { default?: unknown }).default ?? stagingProgramResult;
