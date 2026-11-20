/**
 * Entry chương trình Pulumi của `transactional-mail-deploy` — lane guard #355.
 *
 * Trước guard này, MỌI stack chạy cùng một thân chương trình: `pulumi up` trên
 * backend staging khai Docker resource local sai environment (cùng hazard mà
 * guard của `platform-deploy` chặn từ #368, `remote-cache-api-deploy` và
 * `auth-deploy` từ #350/#539 — pattern #453). Guard phân loại stack TRƯỚC KHI
 * nạp thân:
 *
 * - `local-*` — lane local hiện hành: nạp `local-program.ts` khai Docker
 *   resource namespace-scoped (WIC container hai worker);
 * - `staging` — lane staging continuous: nạp `staging-program.ts` khai D1
 *   `stg-mail` + chuỗi bốn Queue staging theo inventory §9.1 (#355);
 * - `staging-candidate` — KHÔNG ĐƯỢC chạy qua guard này (từ chối tường minh,
 *   khác pilot `auth-deploy` route chung): tên resource của slot candidate
 *   (`-cand`, §4.2) thuộc #381 — slot này chưa định danh tài nguyên nào, mà
 *   D1/Queue là tài nguyên account-unique, chạy chương trình continuous trên
 *   slot candidate là collision tên trên cùng account;
 * - khác — fail-closed: không stack lạ nào được phép khai resource nào.
 *
 * Stack outputs của lane local là namespace `export const` của
 * `local-program.ts`; lane staging trả `{ mailDatabaseId }` của
 * `staging-program.ts` — nguồn định danh wiring `env.staging.d1_databases` của
 * `apps/transactional-mail/wrangler.jsonc` (§9.1: id do Pulumi cung cấp,
 * Wrangler không tự tạo resource). Pulumi language host (`cmd/run/run.js`)
 * import entry, unwrap `.default` của ENTRY đúng MỘT lần rồi lấy từng property
 * của kết quả làm stack output — nên lane local (named exports) forward nguyên
 * namespace, còn lane staging (default export) phải unwrap thêm tầng
 * `.default`: forwarding cả namespace sẽ sinh output `default` thay vì
 * `mailDatabaseId`. Entry vì thế chỉ được phép có ĐÚNG MỘT export: `default`.
 */

import * as pulumi from '@pulumi/pulumi';

import { classifyTransactionalMailDeployStack } from './staging-run.js';

const currentStackRef = pulumi.getStack();
const mailDeployStackLane = classifyTransactionalMailDeployStack(currentStackRef);
if (mailDeployStackLane === 'unknown' || mailDeployStackLane === 'staging-candidate') {
  throw new Error(
    `refused stack "${currentStackRef}" for transactional-mail-deploy — allowed stacks are ` +
      'local-<namespace> (local lane, Docker WIC program) and the continuous staging slot ' +
      'staging (D1 + queue provisioning, #355). The staging-candidate slot is owned by #381: ' +
      'its resource names are not defined yet and D1/Queue names are account-unique, so ' +
      'running the continuous program there would collide on the shared Cloudflare account',
  );
}
// Nạp thân theo lane — specifier `.js` resolvable qua ts-node/esm hooks như
// mọi import nội bộ của package (`type: "module"`). Host unwrap `.default`
// của entry ĐÚNG MỘT LẦN (cmd/run/run.js) rồi lấy từng property của kết quả
// làm stack output: namespace của lane local (named exports) forward nguyên
// vẹn; default export của lane staging phải unwrap thêm một tầng — forwarding
// cả namespace sẽ sinh output `default`, không phải `mailDatabaseId` mà
// `readDatabaseId` đọc sau `up`.
export default mailDeployStackLane === 'staging'
  ? (await import('./staging-program.js')).default
  : await import('./local-program.js');
