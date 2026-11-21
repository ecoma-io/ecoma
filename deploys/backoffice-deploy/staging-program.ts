/**
 * Chương trình Pulumi của lane staging `backoffice-deploy` — khai HyperdriveConfig
 * của `db-backoffice` cho staging (inventory §9.1: Hyperdrive config
 * **per-database**, per-lane — §7.4.1; scope #354 theo pattern pilot #350/#539
 * của unit `auth`). Owner tạo/cập nhật/xoá config là Pulumi (§9.1 dòng
 * Hyperdrive config); Wrangler chỉ tiêu thụ `id` vào `env.staging.hyperdrive`
 * của `apps/backoffice/wrangler.jsonc` về sau — program này KHÔNG deploy Worker
 * nào và không khai binding nào.
 *
 * Origin FAIL CLOSED khi chưa tồn tại: đường tới origin private là
 * Tunnel/VPC Service của #349, chưa provision lần nào — origin đọc từ stack
 * config (`namespace:originHost`/`originPort`/`originPassword`) qua
 * `resolveStagingHyperdriveOrigin` (`staging-run.ts`), thiếu khóa là throw
 * với lỗi nêu rõ #349 tại lúc đánh giá program. Đó là trạng thái ĐÚNG của
 * hiện tại: `pulumi preview` trên stack này sẽ đỏ cho tới khi #349 cấp
 * origin — không có đường "chạy tạm với origin giả".
 *
 * Caching OFF tường minh (`caching.disabled: true`) — khác có chủ đích so với
 * pilot `auth` (bỏ trống `caching` = default server-side ON theo HD3):
 * `db-backoffice` có yêu cầu documented riêng "cache OFF, không ngoại lệ" (comment
 * `apps/backoffice/wrangler.jsonc` — HD4 cache không invalidate khi ghi, còn
 * `GET /internal/account/status` là chốt chặn correctness lúc `auth` phát hành
 * token). Provision config với cache mặc định là tạo sẵn một config vi phạm
 * yêu cầu đó rồi đợi tay sửa sau — yêu cầu được enforce ngay tại nơi config
 * được tạo.
 *
 * Được guard `index.ts` nạp cho stack `staging`/`staging-candidate`. Việc chạy
 * thật còn bị chặn bởi bootstrap backend state (một lần, NGOÀI mọi stack —
 * §7.4.1) và credential vận hành; cả hai là điều kiện tiên quyết fail-closed
 * ở inventory của `staging-run.ts`, không phải của program này.
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
 * Stack outputs (default export — hợp đồng language host): `hyperdriveConfigId`,
 * nguồn định danh cho wiring `env.staging.hyperdrive` của
 * `apps/backoffice/wrangler.jsonc` về sau (id thật đọc bằng
 * `pulumi stack output hyperdriveConfigId` sau một lần `up` xanh — entry
 * `staging.ts` surface id này; Wrangler không bao giờ tự tạo config).
 */

import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';

import { resolveStagingStateUrl, validateStackBackendPairing } from '@ecoma-io/deployment';

import {
  STAGING_BACKOFFICE_HYPERDRIVE_CONFIG_NAME,
  STAGING_ORIGIN_HOST_CONFIG_KEY,
  STAGING_ORIGIN_PASSWORD_CONFIG_KEY,
  STAGING_ORIGIN_PORT_CONFIG_KEY,
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

const stagingHyperdriveConfig = new cloudflare.HyperdriveConfig(
  STAGING_BACKOFFICE_HYPERDRIVE_CONFIG_NAME,
  {
    accountId: stagingAccountId,
    name: STAGING_BACKOFFICE_HYPERDRIVE_CONFIG_NAME,
    origin: stagingHyperdriveOrigin,
    // Cache OFF tường minh — khác có chủ đích so với pilot `auth` (bỏ trống
    // `caching` = mặc định server-side ON theo HD3). `db-backoffice` có yêu cầu
    // documented riêng (comment `apps/backoffice/wrangler.jsonc`: HD3 + HD4 —
    // cache không invalidate khi ghi, còn `GET /internal/account/status` là
    // chốt chặn correctness lúc `auth` phát hành token): provision config với
    // cache mặc định là tạo sẵn một config vi phạm yêu cầu đó, đợi tay sửa
    // sau. Khai `disabled: true` tại đây cho cả hai lane cùng một nguồn sự
    // thật; giá trị `0` ghim hai tham số còn lại khỏi mặc định 60s/15s.
    caching: { disabled: true, maxAge: 0, staleWhileRevalidate: 0 },
  },
);

export default { hyperdriveConfigId: stagingHyperdriveConfig.id };
