/**
 * Entry chương trình Pulumi của `llm-api-deploy` — lane guard (pattern
 * `auth-deploy` #539, gốc `platform-deploy` #453).
 *
 * Trước guard này, MỌI stack chạy cùng một thân chương trình: `pulumi up` trên
 * backend staging khai Docker resource local sai environment (hazard thật mà
 * guard của `platform-deploy` chặn từ #368, `remote-cache-api-deploy` từ #350
 * và `auth-deploy` từ #539). Guard phân loại stack TRƯỚC KHI nạp thân:
 *
 * - `local-*` — lane local hiện hành: nạp `local-program.ts` khai Docker
 *   resource namespace-scoped (provision 3 DB + 6 role + migration + bootstrap
 *   + container WIC);
 * - `staging`/`staging-candidate` — lane staging: nạp `staging-program.ts`
 *   khai BA HyperdriveConfig `db-llm-gateway`/`db-llm-tenant`/
 *   `db-llm-marketplace` theo inventory §9.1 (config per-database, per-lane —
 *   §4.2/#345; issue #359). Origin đọc từ stack config và FAIL CLOSED khi chưa
 *   có: đường tới origin private là Tunnel/VPC Service của #349, chưa provision
 *   lần nào. Việc chạy thật còn chặn prerequisite vận hành fail-closed ở
 *   inventory của `staging-run.ts` (bootstrap backend state một lần ngoài mọi
 *   stack + token Cloudflare + R2 token bucket-scoped + passphrase per-stack) —
 *   guard không tự mở đường nào cho chương trình chạy khi thiếu điều kiện đó;
 * - khác — fail-closed: không stack lạ nào được phép khai resource nào.
 *
 * Stack outputs của lane local là namespace `export const` của
 * `local-program.ts`; lane staging trả default export
 * `{ gatewayHyperdriveConfigId, tenantHyperdriveConfigId,
 * marketplaceHyperdriveConfigId }` của `staging-program.ts` — nguồn định danh
 * để wiring `env.staging.hyperdrive[].id` của `apps/llm-api/wrangler.jsonc`
 * (§9.1: id do Pulumi cung cấp, Wrangler KHÔNG tạo config). Pulumi language
 * host (`cmd/run/run.js`) lấy **default export duy nhất** của entry làm kết
 * quả program = stack outputs, nên entry forward nguyên kết quả của lane được
 * nạp qua `export default`. Entry vì thế chỉ được phép có ĐÚNG MỘT export:
 * `default`.
 */

import * as pulumi from '@pulumi/pulumi';

import { classifyLlmApiDeployStack } from './staging-run.js';

const currentStackRef = pulumi.getStack();
const llmApiDeployStackLane = classifyLlmApiDeployStack(currentStackRef);
if (llmApiDeployStackLane === 'unknown') {
  throw new Error(
    `unknown stack "${currentStackRef}" for llm-api-deploy — allowed stacks are ` +
      'local-<namespace> (local lane) and the staging slots staging|staging-candidate (#359, ' +
      'pattern #539); this program declares namespace-scoped Docker resources (local lane) ' +
      'and the three staging Hyperdrive configs for db-llm-gateway/db-llm-tenant/' +
      'db-llm-marketplace (staging lane) and must never run on another stack',
  );
}
// Nạp thân theo lane — specifier `.js` resolvable qua ts-node/esm hooks như
// mọi import nội bộ của package (`type: "module"`).
const stagingProgramResult =
  llmApiDeployStackLane === 'staging'
    ? await import('./staging-program.js')
    : await import('./local-program.js');

export default stagingProgramResult;
