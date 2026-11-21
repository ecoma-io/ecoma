/**
 * Entry chương trình Pulumi của `remote-cache-app-deploy` — lane guard #350
 * (pattern `auth-deploy`, pilot Hyperdrive #539).
 *
 * Trước guard này, MỌI stack chạy cùng một thân chương trình: `pulumi up` trên
 * backend staging khai Docker resource local sai environment (cùng hazard mà
 * guard của `platform-deploy` chặn từ #368, `remote-cache-api-deploy` và
 * `auth-deploy` từ #350 — pattern #453). Guard phân loại stack TRƯỚC KHI nạp
 * thân:
 *
 * - `local-*` — lane local hiện hành: nạp `local-program.ts` khai Docker
 *   resource namespace-scoped;
 * - `staging`/`staging-candidate` — lane staging: nạp `staging-program.ts`
 *   khai HyperdriveConfig của `db-remote-cache-app` theo inventory §9.1
 *   (config per-database per-lane, #357/#350). Origin đọc từ stack config và
 *   FAIL CLOSED khi chưa có: đường tới origin private là Tunnel/VPC Service
 *   của #349, chưa provision lần nào. Việc chạy thật còn chặn prerequisite
 *   vận hành fail-closed ở inventory của `staging-run.ts` (bootstrap backend
 *   state một lần ngoài mọi stack + token Cloudflare + R2 token
 *   bucket-scoped + passphrase per-stack) — guard không tự mở đường nào cho
 *   chương trình chạy khi thiếu điều kiện đó;
 * - khác — fail-closed: không stack lạ nào được phép khai resource nào.
 *
 * Stack outputs của lane local là namespace `export const` của
 * `local-program.ts`; lane staging trả `{ hyperdriveConfigId }` của
 * `staging-program.ts` — nguồn định danh để wiring `env.staging.hyperdrive`
 * của `apps/remote-cache-app/wrangler.jsonc` về sau (id do Pulumi cung cấp,
 * Wrangler KHÔNG tạo config — §9.1). Pulumi language host
 * (`cmd/run/run.js`) lấy **default export duy nhất** của entry làm kết quả
 * program = stack outputs, nên entry forward nguyên kết quả của lane được nạp
 * qua `export default`. Entry vì thế chỉ được phép có ĐÚNG MỘT export:
 * `default`.
 */

import * as pulumi from '@pulumi/pulumi';

import { classifyRemoteCacheAppDeployStack } from './staging-run.js';

const currentStackRef = pulumi.getStack();
const remoteCacheAppDeployStackLane = classifyRemoteCacheAppDeployStack(currentStackRef);
if (remoteCacheAppDeployStackLane === 'unknown') {
  throw new Error(
    `unknown stack "${currentStackRef}" for remote-cache-app-deploy — allowed stacks are ` +
      'local-<namespace> (local lane) and the staging slots staging|staging-candidate (#350, ' +
      'pattern #453); this program declares namespace-scoped Docker resources (local lane) ' +
      'and the staging Hyperdrive config for db-remote-cache-app (staging lane) and must never run on ' +
      'another stack',
  );
}
// Nạp thân theo lane — specifier `.js` resolvable qua ts-node/esm hooks như
// mọi import nội bộ của package (`type: "module"`).
const laneModule =
  remoteCacheAppDeployStackLane === 'staging'
    ? await import('./staging-program.js')
    : await import('./local-program.js');

// Language host lấy default export của entry làm stack outputs: forward đúng
// surface phẳng — default của thân staging (`{ hyperdriveConfigId }`), hoặc
// nguyên namespace khi thân không có default (lane local, các `export const`
// phẳng). Forward nguyên namespace staging là lồng outputs dưới khoá `default`.
export default 'default' in laneModule ? laneModule.default : laneModule;
