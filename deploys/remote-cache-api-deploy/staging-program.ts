/**
 * Chương trình Pulumi của lane staging `remote-cache-api-deploy` — khai R2
 * bucket object storage của remote-cache cho staging (inventory §7.4.1:
 * "`remote-cache-api-deploy` thêm R2 bucket object storage staging"; scope
 * #350). Owner tạo/cập nhật/xoá bucket là Pulumi (§9.1 dòng R2 bucket);
 * Wrangler chỉ tiêu thụ `bucket_name` vào `wrangler.jsonc` của app sau này —
 * program này KHÔNG deploy Worker nào và không khai binding nào.
 *
 * Được guard `index.ts` nạp cho stack `staging`/`staging-candidate` (cùng một
 * thân chương trình cho cả hai slot; passphrase per-stack nên slot nào cũng
 * có state riêng). Việc chạy thật còn bị chặn bởi bootstrap backend state
 * (một lần, NGOÀI mọi stack — §7.4.1) và credential vận hành; cả hai là
 * điều kiện tiên quyết fail-closed ở inventory của `staging-run.ts`, không
 * phải của program này.
 *
 * Tên bucket là ĐỀ XUẤT chờ duyệt (lập luận đầy đủ trong PR của slice #350):
 * đổi tên lúc chưa provision là sửa đúng một hằng số
 * (`STAGING_REMOTE_CACHE_BUCKET_NAME` ở `staging-run.ts`); sau khi bucket đã
 * tồn tại thật, đổi tên phải đi qua tạo-mới + sao chép + xoá-củ, không phải
 * một lần `up` bất kỳ.
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
 * Stack outputs (default export — hợp đồng language host): `bucketName`, là
 * nguồn định danh cho wiring `r2_buckets` của `wrangler.jsonc` về sau.
 */

import * as cloudflare from '@pulumi/cloudflare';

import { resolveStagingStateUrl, validateStackBackendPairing } from '@ecoma-io/deployment';

import { STAGING_REMOTE_CACHE_BUCKET_NAME, r2AccountIdFromStateUrl } from './staging-run.js';

const stagingStateUrl = resolveStagingStateUrl();
// Tổ hợp stack↔backend sai là từ chối ngay tại program (lần kiểm thứ hai:
// engine đã kiểm trước khi spawn — hai lớp độc lập, chạy tay ngoài engine
// vẫn an toàn).
validateStackBackendPairing('staging', stagingStateUrl);
const stagingAccountId = r2AccountIdFromStateUrl(stagingStateUrl);

// Token cố ý không set vào provider nào (nhận xét ở header): default provider
// đọc CLOUDFLARE_API_TOKEN từ env; accountId không phải secret nên được set
// tường minh trên resource.
const stagingRemoteCacheBucket = new cloudflare.R2Bucket('remote-cache-object-storage', {
  accountId: stagingAccountId,
  name: STAGING_REMOTE_CACHE_BUCKET_NAME,
});

export default { bucketName: stagingRemoteCacheBucket.name };
