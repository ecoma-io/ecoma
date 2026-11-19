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
 *
 * Stack outputs của lane local là `export const` của `local-program.ts`
 * (traefikHostPort, namespace...). Pulumi language host (`cmd/run/run.js`)
 * lấy **default export duy nhất** của entry làm kết quả program = stack
 * outputs, nên entry forward nguyên namespace của local-program qua
 * `export default` — đảm bảo outputs của lane local KHÔNG ĐỔI so với thời
 * thân chương trình nằm ngay trong entry; lane staging trả `undefined`
 * (stack không có output nào, đúng hợp đồng marker-only). Entry vì thế chỉ
 * được phép có ĐÚNG MỘT export: `default`.
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
// Báo rõ marker-only thay vì im lặng: operator đọc log phải thấy ngay đây
// là hành vi chủ đích, không phải chương trình hỏng.
const stagingProgramResult =
  platformStackLane === 'staging-marker'
    ? (pulumi.log.warn(
        'platform-deploy staging stack intentionally declares NO resources — ' +
          'staging resources are owned by #349/#350/#351; this run only exercises ' +
          'the stack lifecycle (backend, credentials, evidence record).',
      ),
      undefined)
    : // Lane local: nạp thân chương trình resource và forward nguyên namespace
      // làm kết quả program — specifier `.js` resolvable qua ts-node/esm hooks
      // như mọi import nội bộ của package (`type: "module"`).
      await import('./local-program.js');

export default stagingProgramResult;
