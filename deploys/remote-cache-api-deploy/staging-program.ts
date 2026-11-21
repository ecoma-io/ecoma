/**
 * Chương trình Pulumi của lane staging `remote-cache-api-deploy` — khai HAI
 * resource theo inventory §7.4.1/§9.1:
 *
 * 1. **R2 bucket object storage của remote-cache** cho staging (scope #350,
 *    slice #514 — tên `ecoma-remote-cache-staging` đã duyệt trong PR của
 *    #514). Owner tạo/cập nhật/xoá bucket là Pulumi (§9.1 dòng R2 bucket);
 *    Wrangler tiêu thụ tên bucket qua `S3_BUCKET` của `env.staging` trong
 *    `apps/remote-cache-api/wrangler.jsonc` (app đọc storage qua bộ env
 *    `S3_*`, không qua binding `r2_buckets` native).
 *
 * 2. **HyperdriveConfig của `db-remote-cache`** cho staging (inventory §9.1:
 *    Hyperdrive config **per-database**, per-lane — §7.4.1; scope #350, pattern
 *    pilot #539). Owner tạo/cập nhật/xoá config là Pulumi (§9.1 dòng Hyperdrive
 *    config); Wrangler chỉ tiêu thụ `id` vào `env.staging.hyperdrive` của
 *    `apps/remote-cache-api/wrangler.jsonc` sau một lần `up` xanh — program
 *    này KHÔNG deploy Worker nào và không khai binding nào.
 *
 * Query cache của config Hyperdrive PHẢI OFF (`caching.disabled = true`) —
 * contract của app (`apps/remote-cache-api/wrangler.jsonc`, cùng lý do
 * ADR-0031 §3): cache không invalidate khi ghi, một API key đã revoke trả về
 * từ cache là lần cấp quyền thứ hai. Khai tường minh KHÔNG phải omit: omit là
 * server-side default (cache bật, HD3) — sai contract cho database này.
 *
 * Origin FAIL CLOSED khi chưa tồn tại: đường tới origin private là
 * Tunnel/VPC Service của #349, chưa provision lần nào — origin đọc từ stack
 * config (`namespace:originHost`/`originPort`/`originPassword`) qua
 * `resolveStagingHyperdriveOrigin` (`staging-run.ts`), thiếu khóa là throw
 * với lỗi nêu rõ #349 tại lúc đánh giá program. Đó là trạng thái ĐÚNG của
 * hiện tại: `pulumi preview` trên stack này sẽ đỏ cho tới khi #349 cấp
 * origin — không có đường "chạy tạm với origin giả".
 *
 * Được guard `index.ts` nạp cho stack `staging`/`staging-candidate` (cùng một
 * thân chương trình cho cả hai slot; passphrase per-stack nên slot nào cũng
 * có state riêng). Việc chạy thật còn bị chặn bởi bootstrap backend state
 * (một lần, NGOÀI mọi stack — §7.4.1) và credential vận hành; cả hai là
 * điều kiện tiên quyết fail-closed ở inventory của `staging-run.ts`, không
 * phải của program này.
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
 * Stack outputs (default export — hợp đồng language host): `bucketName` (nguồn
 * định danh cho wiring `S3_BUCKET` của `env.staging`) và `hyperdriveConfigId`
 * (nguồn định danh cho wiring `env.staging.hyperdrive` — id thật đọc bằng
 * `pulumi stack output hyperdriveConfigId` sau một lần `up` xanh; entry
 * `staging.ts` surface id này; Wrangler không bao giờ tự tạo config).
 */

import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';

import { resolveStagingStateUrl, validateStackBackendPairing } from '@ecoma-io/deployment';

import {
  STAGING_ORIGIN_HOST_CONFIG_KEY,
  STAGING_ORIGIN_PASSWORD_CONFIG_KEY,
  STAGING_ORIGIN_PORT_CONFIG_KEY,
  STAGING_REMOTE_CACHE_BUCKET_NAME,
  STAGING_REMOTE_CACHE_HYPERDRIVE_CONFIG_NAME,
  r2AccountIdFromStateUrl,
  resolveStagingHyperdriveOrigin,
} from './staging-run.js';

const stagingStateUrl = resolveStagingStateUrl();
// Tổ hợp stack↔backend sai là từ chối ngay tại program (lần kiểm thứ hai:
// engine đã kiểm trước khi spawn — hai lớp độc lập, chạy tay ngoài engine
// vẫn an toàn).
validateStackBackendPairing('staging', stagingStateUrl);
const stagingAccountId = r2AccountIdFromStateUrl(stagingStateUrl);

const conf = new pulumi.Config('namespace');

// Token cố ý không set vào provider nào (nhận xét ở header): default provider
// đọc CLOUDFLARE_API_TOKEN từ env; accountId không phải secret nên được set
// tường minh trên resource, còn password origin là secret đi qua
// `conf.getSecret` (encrypted trong state, redact trong log).
const stagingHyperdriveOrigin = resolveStagingHyperdriveOrigin({
  originHost: conf.get(STAGING_ORIGIN_HOST_CONFIG_KEY),
  originPort: conf.get(STAGING_ORIGIN_PORT_CONFIG_KEY),
  originPassword: conf.getSecret(STAGING_ORIGIN_PASSWORD_CONFIG_KEY),
});

const stagingRemoteCacheBucket = new cloudflare.R2Bucket('remote-cache-object-storage', {
  accountId: stagingAccountId,
  name: STAGING_REMOTE_CACHE_BUCKET_NAME,
});

const stagingHyperdriveConfig = new cloudflare.HyperdriveConfig(
  STAGING_REMOTE_CACHE_HYPERDRIVE_CONFIG_NAME,
  {
    accountId: stagingAccountId,
    name: STAGING_REMOTE_CACHE_HYPERDRIVE_CONFIG_NAME,
    origin: stagingHyperdriveOrigin,
    // Query cache OFF tường minh — contract của app (nhận xét ở header);
    // KHÔNG omit vì omit là default server-side "cache bật" (HD3).
    caching: { disabled: true },
  },
);

export default {
  bucketName: stagingRemoteCacheBucket.name,
  hyperdriveConfigId: stagingHyperdriveConfig.id,
};
