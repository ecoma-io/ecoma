/**
 * Entry chương trình Pulumi của `platform-deploy` — lane guard #368.
 *
 * Program này khai Docker resource namespace-scoped cho local deployment
 * (thân nằm ở `local-program.ts`). Trước guard này, MỌI stack chạy cùng một
 * thân chương trình: `pulumi up -c staging` trên backend staging khai Docker
 * resource local sai environment (hazard thật của #368). Guard phân loại
 * stack TRƯỚC KHI nạp thân:
 *
 * - `local-*` — lane local hiện hành: nạp `local-program.ts`;
 * - `staging`/`staging-candidate` — lane staging: khai **0 resource** (scope
 *   #349/#350/#351 khai resource thật của staging); một lần `preview`/`up`
 *   là vòng đời stack no-op CÓ CHỦ ĐÍCH — chứng minh backend/stack/
 *   credential/evidence, KHÔNG chứng minh resource nào tồn tại. Module kết
 *   thúc bình thường sau warn (KHÔNG `process.exit` — exit giữa chừng dưới
 *   Pulumi runtime bị tính là chương trình lỗi, promises leaked);
 * - khác — fail-closed: không stack lạ nào được phép khai Docker resource.
 */

import * as pulumi from '@pulumi/pulumi';

import { classifyPlatformStack } from './staging-run.js';

const currentStackRef = pulumi.getStack();
const platformStackLane = classifyPlatformStack(currentStackRef);
if (platformStackLane === 'unknown') {
  throw new Error(
    `unknown stack "${currentStackRef}" for platform-deploy — allowed stacks are ` +
      'local-<namespace> (local lane) and the staging slots staging|staging-candidate (#368); ' +
      'this program declares namespace-scoped Docker resources and must never run on another stack',
  );
}
if (platformStackLane === 'staging-marker') {
  // Báo rõ marker-only thay vì im lặng: operator đọc log phải thấy ngay đây
  // là hành vi chủ đích, không phải chương trình hỏng.
  pulumi.log.warn(
    'platform-deploy staging stack intentionally declares NO resources — ' +
      'staging resources are owned by #349/#350/#351; this run only exercises ' +
      'the stack lifecycle (backend, credentials, evidence record).',
  );
} else {
  // Lane local: nạp thân chương trình resource. Dynamic import (không phải
  // import tĩnh) đảm bảo thân KHÔNG BAO GIỜ được evaluate khi lane không phải
  // local — specifier `.js` resolvable qua ts-node/esm hooks như mọi import
  // nội bộ của package (`type: "module"`).
  await import('./local-program.js');
}
