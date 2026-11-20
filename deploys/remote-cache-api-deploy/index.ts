/**
 * Entry chương trình Pulumi của `remote-cache-api-deploy` — lane guard #350.
 *
 * Program này khai Docker resource namespace-scoped cho local deployment
 * (thân nằm ở `local-program.ts`). Trước guard này, MỌI stack chạy cùng một
 * thân chương trình: `pulumi up -c staging` trên backend staging khai Docker
 * resource local sai environment (cùng hazard mà guard của `platform-deploy`
 * chặn từ #368 — port theo pattern đã merge đó, #453). Guard phân loại stack
 * TRƯỚC KHI nạp thân:
 *
 * - `local-*` — lane local hiện hành: nạp `local-program.ts`;
 * - `staging`/`staging-candidate` — lane staging: khai **0 resource**.
 *   Resource staging thật của unit này theo bảng inventory §7.4.1 là R2
 *   bucket object storage của remote-cache — scope #350, đang chờ hai điều
 *   kiện chưa đóng (không đoán): quyết định tên bucket + account id
 *   (jurisdiction) và bootstrap backend state staging
 *   (`ECOMA_PULUMI_STATE_URL_STAGING`, một lần NGOÀI mọi stack). Một lần
 *   `preview`/`up` hiện tại là vòng đời stack no-op CÓ CHỦ ĐÍCH — chứng minh
 *   backend/stack/credential/evidence, KHÔNG chứng minh resource nào tồn tại.
 *   Module kết thúc bình thường sau warn (KHÔNG `process.exit` — exit giữa
 *   chừng dưới Pulumi runtime bị tính là chương trình lỗi, promises leaked);
 * - khác — fail-closed: không stack lạ nào được phép khai Docker resource.
 *
 * Stack outputs của lane local là `export const` của `local-program.ts`
 * (provisionCommandName, containerName...). Pulumi language host
 * (`cmd/run/run.js`) lấy **default export duy nhất** của entry làm kết quả
 * program = stack outputs, nên entry forward nguyên namespace của
 * local-program qua `export default` — đảm bảo outputs của lane local KHÔNG
 * ĐỔI so với thời thân chương trình nằm ngay trong entry; lane staging trả
 * `undefined` (stack không có output nào, đúng hợp đồng marker-only). Entry
 * vì thế chỉ được phép có ĐÚNG MỘT export: `default`.
 */

import * as pulumi from '@pulumi/pulumi';

import { classifyRemoteCacheApiStack } from './staging-run.js';

const currentStackRef = pulumi.getStack();
const remoteCacheStackLane = classifyRemoteCacheApiStack(currentStackRef);
if (remoteCacheStackLane === 'unknown') {
  throw new Error(
    `unknown stack "${currentStackRef}" for remote-cache-api-deploy — allowed stacks are ` +
      'local-<namespace> (local lane) and the staging slots staging|staging-candidate (#350, ' +
      'pattern #453); this program declares namespace-scoped Docker resources and must never ' +
      'run on another stack',
  );
}
// Báo rõ marker-only thay vì im lặng: operator đọc log phải thấy ngay đây
// là hành vi chủ đích, không phải chương trình hỏng.
const stagingProgramResult =
  remoteCacheStackLane === 'staging-marker'
    ? (pulumi.log.warn(
        'remote-cache-api-deploy staging stack intentionally declares NO resources — ' +
          'the staging R2 object-storage bucket is owned by #350 and waits for the ' +
          'bucket-name/account decision and the state-backend bootstrap; this run only ' +
          'exercises the stack lifecycle (backend, credentials, evidence record).',
      ),
      undefined)
    : // Lane local: nạp thân chương trình resource và forward nguyên namespace
      // làm kết quả program — specifier `.js` resolvable qua ts-node/esm hooks
      // như mọi import nội bộ của package (`type: "module"`).
      await import('./local-program.js');

export default stagingProgramResult;
