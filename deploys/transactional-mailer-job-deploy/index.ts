/**
 * Entry chương trình Pulumi của `transactional-mailer-job-deploy` — lane
 * guard #355. Project này KHÔNG có lane local: trước guard, entry là scaffold
 * trống chạy được trên MỌI stack — chạy `pulumi up` trên stack nào khác
 * `staging` là khai tài nguyên Cloudflare sai environment (hazard thật trước
 * lane guard — cùng hình #368/#453). Guard phân loại stack TRƯỚC KHI nạp thân:
 *
 * - `staging` — lane staging continuous: nạp `staging-program.ts` khai D1
 *   `stg-mail-job` (#355);
 * - `staging-candidate` — từ chối tường minh: tên tài nguyên slot `-cand`
 *   thuộc #381, và D1 là tài nguyên account-unique;
 * - `local-*` và còn lại — fail-closed: local runtime của worker thuộc WIC
 *   container của `transactional-mail-deploy`, project này không khai Docker
 *   resource nào.
 *
 * Stack outputs là `{ mailJobDatabaseId }` của `staging-program.ts` — nguồn
 * định danh wiring `env.staging.d1_databases` của
 * `apps/transactional-mailer-job/wrangler.jsonc` (§9.1: id do Pulumi cung
 * cấp, Wrangler KHÔNG tạo resource). Pulumi language host (`cmd/run/run.js`)
 * import entry, unwrap `.default` của ENTRY đúng MỘT lần rồi lấy từng property
 * của kết quả làm stack output — `staging-program.ts` có default export, nên
 * entry unwrap thêm tầng `.default` của lane module: forwarding cả namespace
 * sẽ sinh output `default` thay vì `mailJobDatabaseId`. Entry vì thế chỉ
 * được phép có ĐÚNG MỘT export: `default`.
 */

import * as pulumi from '@pulumi/pulumi';

import { classifyTransactionalMailerJobDeployStack } from './staging-run.js';

const currentStackRef = pulumi.getStack();
const mailerJobDeployStackLane = classifyTransactionalMailerJobDeployStack(currentStackRef);
if (mailerJobDeployStackLane !== 'staging') {
  throw new Error(
    `refused stack "${currentStackRef}" for transactional-mailer-job-deploy — the only allowed ` +
      'stack is the continuous staging slot staging (D1 stg-mail-job provisioning, #355). ' +
      'The staging-candidate slot is owned by #381 (its resource names are not defined yet and ' +
      'D1 names are account-unique); the local lane has no program here — the worker runs in the ' +
      'WIC container of transactional-mail-deploy',
  );
}
// Nạp thân theo lane — specifier `.js` resolvable qua ts-node/esm hooks như
// mọi import nội bộ của package (`type: "module"`). Host unwrap `.default`
// của entry ĐÚNG MỘT LẦN (cmd/run/run.js) rồi lấy từng property của kết quả
// làm stack output — `staging-program.ts` có default export, nên entry phải
// unwrap thêm một tầng: forwarding cả namespace sẽ sinh output `default`,
// không phải `mailJobDatabaseId` mà `readDatabaseId` đọc sau `up`.
export default (await import('./staging-program.js')).default;
