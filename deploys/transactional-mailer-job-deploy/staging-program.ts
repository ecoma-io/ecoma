/**
 * Chương trình Pulumi của lane staging `transactional-mailer-job-deploy` —
 * khai D1 `stg-mail-job` của delivery plane trên slot continuous (#355).
 * Lần đầu project này khai resource thật: trước đó chỉ là scaffold marker
 * trống (`pulumi.log.info`) — thoát scaffold đúng kịch bản `02-delivery.md`
 * (job D1 được khai khi project exits scaffold).
 *
 * Ownership đúng bảng §9.1: Pulumi tạo/cập nhật/xoá D1 và cung cấp
 * `database_id`; Wrangler KHÔNG tự tạo resource nào — nó deploy Worker với
 * binding khai trong `env.staging` của app, và migration D1 là việc của
 * `tools/dx d1-migrate` (cutover #382). Chuỗi Queue của bounded context được
 * provision bởi `transactional-mail-deploy` (ĐÚNG MỘT chỗ cho cả chuỗi) —
 * program này KHÔNG khai Queue nào.
 *
 * Slot candidate `staging-candidate` KHÔNG được chạy qua chương trình này —
 * guard `index.ts` từ chối trước khi nạp (tên tài nguyên slot `-cand` thuộc
 * #381; D1 trùng tên trên một account là collision thật).
 *
 * Được guard `index.ts` nạp cho stack `staging` (lane DUY NHẤT của project —
 * không có lane local: worker chạy trong WIC container của
 * `transactional-mail-deploy`). Việc chạy thật còn bị chặn bởi bootstrap
 * backend state (một lần, NGOÀI mọi stack — §7.4.1) và credential vận hành;
 * cả hai là điều kiện tiên quyết fail-closed ở inventory của
 * `staging-run.ts`, không phải của program này.
 *
 * Identity account KHÔNG đòi thêm biến môi trường: account id được rút từ
 * state URL contract qua `r2AccountIdFromStateUrl` (`04` R22 — endpoint
 * path-style mang account id trên host) và set tường minh trên resource
 * (ProviderArgs của `@pulumi/cloudflare` v6 không có config account — account
 * là tham số per-resource). `CLOUDFLARE_API_TOKEN` đi qua ENV của process
 * Pulumi và cố ý KHÔNG được truyền vào provider config: Pulumi ghi config của
 * provider vào state, còn token là material truy cập phải đứng hoàn toàn
 * ngoài state (§7.4.1) — default provider đọc thẳng biến môi trường khi config
 * bỏ trống; inventory của engine bắt buộc biến này TRƯỚC khi đụng Pulumi.
 *
 * Stack outputs (default export — hợp đồng language host): `mailJobDatabaseId`
 * — UUID của D1 `stg-mail-job` (output `uuid` của provider v6), nguồn định
 * danh cho wiring `env.staging.d1_databases` của
 * `apps/transactional-mailer-job/wrangler.jsonc` về sau (id thật đọc bằng
 * `pulumi stack output mailJobDatabaseId` sau một lần `up` xanh — entry
 * `staging.ts` surface id; §9.1).
 */

import * as cloudflare from '@pulumi/cloudflare';

import { resolveStagingStateUrl, validateStackBackendPairing } from '@ecoma-io/deployment';

import { STAGING_MAIL_JOB_DATABASE_NAME, r2AccountIdFromStateUrl } from './staging-run.js';

const stagingStateUrl = resolveStagingStateUrl();
// Tổ hợp stack↔backend sai là từ chối ngay tại program (lần kiểm thứ hai:
// engine đã kiểm trước khi spawn — hai lớp độc lập, chạy tay ngoài engine
// vẫn an toàn).
validateStackBackendPairing('staging', stagingStateUrl);
const stagingAccountId = r2AccountIdFromStateUrl(stagingStateUrl);

// Token cố ý không set vào provider nào (nhận xét ở header): default provider
// đọc CLOUDFLARE_API_TOKEN từ env; accountId không phải secret nên được set
// tường minh trên resource.

const stagingMailJobDatabase = new cloudflare.D1Database(STAGING_MAIL_JOB_DATABASE_NAME, {
  accountId: stagingAccountId,
  name: STAGING_MAIL_JOB_DATABASE_NAME,
});

export default { mailJobDatabaseId: stagingMailJobDatabase.uuid };
