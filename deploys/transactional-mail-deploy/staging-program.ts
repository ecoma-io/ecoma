/**
 * Chương trình Pulumi của lane staging `transactional-mail-deploy` — khai tài
 * nguyên Cloudflare của bounded context `transactional-mail` trên slot
 * continuous (#355): D1 `stg-mail` của control plane và chuỗi bốn Queue theo
 * registry §9.1 (delivery pair + lifecycle pair, DLQ độc lập vòng đời).
 *
 * Ownership đúng bảng §9.1: Pulumi tạo/cập nhật/xoá D1 + Queue và cung cấp
 * `database_id`; Wrangler KHÔNG tự tạo resource nào — nó deploy Worker với
 * binding khai trong `env.staging` của hai app, và migration D1 là việc của
 * `tools/dx d1-migrate` (cutover #382). Tên tài nguyên là hằng per-lane của
 * `staging-run.ts` (prefix `stg-` — tài nguyên account-unique, production giữ
 * tên không tiền tố); Queue provision ở ĐÚNG MỘT chỗ này cho cả chuỗi, dù
 * consumer khai ở app `transactional-mailer-job`.
 *
 * Slot candidate `staging-candidate` KHÔNG được chạy qua chương trình này —
 * guard `index.ts` từ chối trước khi nạp (tên tài nguyên slot `-cand` thuộc
 * #381; D1/Queue trùng tên trên một account là collision thật).
 *
 * Được guard `index.ts` nạp cho stack `staging`. Việc chạy thật còn bị chặn
 * bởi bootstrap backend state (một lần, NGOÀI mọi stack — §7.4.1) và
 * credential vận hành; cả hai là điều kiện tiên quyết fail-closed ở inventory
 * của `staging-run.ts`, không phải của program này.
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
 * Stack outputs (default export — hợp đồng language host): `mailDatabaseId` —
 * UUID của D1 `stg-mail` (output `uuid` của provider v6), nguồn định danh cho
 * wiring `env.staging.d1_databases` của `apps/transactional-mail/wrangler.jsonc`
 * về sau (id thật đọc bằng `pulumi stack output mailDatabaseId` sau một lần
 * `up` xanh — entry `staging.ts` surface id; §9.1). Tên Queue là hằng đã khai
 * ở `staging-run.ts` — wrangler tham chiếu Queue theo TÊN, không cần output id.
 */

import * as cloudflare from '@pulumi/cloudflare';

import { resolveStagingStateUrl, validateStackBackendPairing } from '@ecoma-io/deployment';

import {
  STAGING_MAIL_DATABASE_NAME,
  STAGING_QUEUE_NAMES,
  r2AccountIdFromStateUrl,
} from './staging-run.js';

const stagingStateUrl = resolveStagingStateUrl();
// Tổ hợp stack↔backend sai là từ chối ngay tại program (lần kiểm thứ hai:
// engine đã kiểm trước khi spawn — hai lớp độc lập, chạy tay ngoài engine
// vẫn an toàn).
validateStackBackendPairing('staging', stagingStateUrl);
const stagingAccountId = r2AccountIdFromStateUrl(stagingStateUrl);

// Token cố ý không set vào provider nào (nhận xét ở header): default provider
// đọc CLOUDFLARE_API_TOKEN từ env; accountId không phải secret nên được set
// tường minh trên resource.

const stagingMailDatabase = new cloudflare.D1Database(STAGING_MAIL_DATABASE_NAME, {
  accountId: stagingAccountId,
  name: STAGING_MAIL_DATABASE_NAME,
});

// Chuỗi bốn Queue §9.1 — delivery pair và lifecycle pair, mỗi DLQ một tài
// nguyên độc lập. Consumer declaration nằm ở wrangler.jsonc của
// `transactional-mailer-job` (side wiring), provisioning tập trung ở đây.
// Wrangler tham chiếu Queue theo TÊN nên id không cần output; biến chỉ để
// tuân thủ `no-new` — resource đã được đăng ký với Pulumi lúc `new` chạy.
for (const queueName of STAGING_QUEUE_NAMES) {
  const queue = new cloudflare.Queue(queueName, {
    accountId: stagingAccountId,
    queueName,
  });
  void queue;
}

export default { mailDatabaseId: stagingMailDatabase.uuid };
