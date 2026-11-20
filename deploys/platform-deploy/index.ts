/**
 * Entry chương trình Pulumi của `platform-deploy` — lane guard #368.
 *
 * Program này khai resource namespace-scoped theo LANE: Docker local cho
 * `local-*` (thân `local-program.ts`), hạ tầng staging thật cho slot
 * `staging`/`staging-candidate` (thân `staging-program.ts` — từ #349: DNS
 * zone `ecoma.io.vn`; trước #349 lane staging là marker-only 0-resource).
 * Trước guard này, MỌI stack chạy cùng một thân chương trình: `pulumi up -c
 * staging` trên backend staging khai Docker resource local sai environment
 * (hazard thật của #368). Guard phân loại stack TRƯỚC KHI nạp thân:
 *
 * - `local-*` — lane local hiện hành: nạp `local-program.ts`;
 * - `staging`/`staging-candidate` — lane staging: nạp `staging-program.ts`;
 * - khác — fail-closed: không stack lạ nào được phép khai resource nào.
 *
 * Stack outputs là `export const` của thân lane được nạp (traefikHostPort...
 * cho local; zoneId... cho staging). Pulumi language host (`cmd/run/run.js`)
 * lấy **default export duy nhất** của entry làm kết quả program = stack
 * outputs, nên entry forward nguyên namespace của thân tương ứng qua
 * `export default`. Entry vì thế chỉ được phép có ĐÚNG MỘT export: `default`.
 */

import * as pulumi from '@pulumi/pulumi';

import { classifyPlatformStack } from './staging-run.js';

const currentStackRef = pulumi.getStack();
const platformStackLane = classifyPlatformStack(currentStackRef);
if (platformStackLane === 'unknown') {
  throw new Error(
    `unknown stack "${currentStackRef}" for platform-deploy — allowed stacks are ` +
      'local-<namespace> (local lane) and the staging slots staging|staging-candidate (#368); ' +
      'this program declares namespace-scoped resources and must never run on another stack',
  );
}
// Nạp thân theo lane và forward nguyên namespace làm kết quả program —
// specifier `.js` resolvable qua ts-node/esm hooks như mọi import nội bộ của
// package (`type: "module"`). Dynamic import (không phải import tĩnh) đảm bảo
// thân KHÔNG BAO GIỜ được evaluate khi lane không tương ứng.
export default platformStackLane === 'staging'
  ? await import('./staging-program.js')
  : await import('./local-program.js');
