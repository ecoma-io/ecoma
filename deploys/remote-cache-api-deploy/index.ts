/**
 * Entry chương trình Pulumi của `remote-cache-api-deploy` — lane guard #350.
 *
 * Trước guard này, MỌI stack chạy cùng một thân chương trình: `pulumi up -c
 * staging` trên backend staging khai Docker resource local sai environment
 * (cùng hazard mà guard của `platform-deploy` chặn từ #368 — port theo
 * pattern đã merge đó, #453). Guard phân loại stack TRƯỚC KHI nạp thân:
 *
 * - `local-*` — lane local hiện hành: nạp `local-program.ts` khai Docker
 *   resource namespace-scoped;
 * - `staging`/`staging-candidate` — lane staging: nạp `staging-program.ts`
 *   khai R2 bucket object storage của remote-cache theo inventory §7.4.1
 *   (scope #350; tên bucket là đề xuất chờ duyệt trong PR của slice). Việc
 *   chạy thật còn chặn prerequisite vận hành fail-closed ở inventory của
 *   `staging-run.ts` (bootstrap backend state một lần ngoài mọi stack +
 *   token Cloudflare + R2 token bucket-scoped + passphrase per-stack) —
 *   guard không tự mở đường nào cho chương trình chạy khi thiếu điều kiện đó;
 * - khác — fail-closed: không stack lạ nào được phép khai resource nào.
 *
 * Stack outputs của lane local là namespace `export const` của
 * `local-program.ts` (provisionCommandName, containerName...); lane staging
 * trả `{ bucketName }` của `staging-program.ts`. Pulumi language host
 * (`cmd/run/run.js`) lấy **default export duy nhất** của entry làm kết quả
 * program = stack outputs, nên entry forward nguyên kết quả của lane được
 * nạp qua `export default` — outputs của lane local KHÔNG ĐỔI so với thời
 * thân chương trình nằm ngay trong entry. Entry vì thế chỉ được phép có ĐÚNG
 * MỘT export: `default`.
 */

import * as pulumi from '@pulumi/pulumi';

import { classifyRemoteCacheApiStack } from './staging-run.js';

const currentStackRef = pulumi.getStack();
const remoteCacheStackLane = classifyRemoteCacheApiStack(currentStackRef);
if (remoteCacheStackLane === 'unknown') {
  throw new Error(
    `unknown stack "${currentStackRef}" for remote-cache-api-deploy — allowed stacks are ` +
      'local-<namespace> (local lane) and the staging slots staging|staging-candidate (#350, ' +
      'pattern #453); this program declares namespace-scoped Docker resources (local lane) ' +
      'and the staging R2 object-storage bucket (staging lane) and must never run on ' +
      'another stack',
  );
}
// Nạp thân theo lane — specifier `.js` resolvable qua ts-node/esm hooks như
// mọi import nội bộ của package (`type: "module"`).
const stagingProgramResult =
  remoteCacheStackLane === 'staging'
    ? await import('./staging-program.js')
    : await import('./local-program.js');

export default stagingProgramResult;
