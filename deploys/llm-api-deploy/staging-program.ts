/**
 * Chương trình Pulumi của lane staging `llm-api-deploy` — khai BA
 * HyperdriveConfig của `db-llm-gateway`/`db-llm-tenant`/`db-llm-marketplace`
 * cho staging (inventory §9.1: Hyperdrive config **per-database**, per-lane —
 * §4.2/#345; issue #359; pattern `auth-deploy` #539). Ba database của MỘT unit
 * vẫn là BA config RỜI nhau: §4.2 cấm config dùng chung giữa các database, và
 * mỗi config là một pool connection rời (HD9: origin connections mỗi config
 * ~20 Free/~100 Paid — soft limit; HD13: pool tối thiểu 5 connection mỗi
 * config) — tổng BA pool trên cùng staging PostgreSQL host nằm trong budget
 * soft limit của một account, vượt là đường Limit Increase Request. Owner
 * tạo/cập nhật/xoá config là Pulumi (§9.1 dòng Hyperdrive config); Wrangler
 * chỉ tiêu thụ `id` vào `env.staging.hyperdrive[].id` của
 * `apps/llm-api/wrangler.jsonc` về sau — program này KHÔNG deploy Worker nào
 * và không khai binding nào.
 *
 * Origin FAIL CLOSED khi chưa tồn tại: đường tới origin private là
 * Tunnel/VPC Service của #349, chưa provision lần nào — origin đọc từ stack
 * config (`namespace:originHost`/`originPort`/`originPassword` dùng chung cho
 * cả BA database — một staging PostgreSQL host, §4.1 điều 2) qua
 * `resolveStagingHyperdriveOrigin` (`staging-run.ts`), thiếu khóa là throw
 * với lỗi nêu rõ #349 tại lúc đánh giá program. Đó là trạng thái ĐÚNG của
 * hiện tại: `pulumi preview` trên stack này sẽ đỏ cho tới khi #349 cấp
 * origin — không có đường "chạy tạm với origin giả". Database và role runtime
 * của từng config lấy từ hằng naming của `scripts.ts`
 * (`db-llm-<target>`, `ecoma_llm_<target>_runtime`): Hyperdrive kết nối
 * origin bằng role runtime, KHÔNG bao giờ bằng migrator/owner (§4.2).
 *
 * Caching TẮT TƯỜNG MINH (`caching: { disabled: true }`): khác `auth-deploy`
 * #539 (omit = mặc định server-side HD3 — cache bật), ba database của unit
 * này nằm trên đường correctness — invariant 14 của `01-architecture.md`
 * ("Hyperdrive query cache OFF trên mọi đường correctness (ledger, quota,
 * settlement)") và ghi chú cùng yêu cầu của `apps/llm-api/wrangler.jsonc`
 * ("Query cache PHẢI OFF khi provision"): cache không invalidate khi ghi, một
 * lượt ghi trừ quota mà cache trả về trạng thái cũ là sai số tiền. Provider
 * 6.24.0 (HD17) nhận `caching.disabled` — bật lại cache là thay đổi chủ đích
 * qua invariant này, không phải quay về mặc định platform.
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
 * Stack outputs (default export — hợp đồng language host): BA id
 * `gatewayHyperdriveConfigId`/`tenantHyperdriveConfigId`/
 * `marketplaceHyperdriveConfigId`, nguồn định danh cho wiring
 * `env.staging.hyperdrive[].id` của `apps/llm-api/wrangler.jsonc` về sau (id
 * thật đọc bằng `pulumi stack output <target>HyperdriveConfigId` sau một lần
 * `up` xanh — entry `staging.ts` surface cả ba id; Wrangler không bao giờ tự
 * tạo config).
 */

import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';

import { resolveStagingStateUrl, validateStackBackendPairing } from '@ecoma-io/deployment';

import { DATABASES, type Database } from './scripts.js';
import {
  STAGING_ORIGIN_HOST_CONFIG_KEY,
  STAGING_ORIGIN_PASSWORD_CONFIG_KEY,
  STAGING_ORIGIN_PORT_CONFIG_KEY,
  r2AccountIdFromStateUrl,
  resolveStagingHyperdriveOrigin,
  stagingHyperdriveConfigName,
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
const stagingOriginConfig = {
  originHost: conf.get(STAGING_ORIGIN_HOST_CONFIG_KEY),
  originPort: conf.get(STAGING_ORIGIN_PORT_CONFIG_KEY),
  originPassword: conf.getSecret(STAGING_ORIGIN_PASSWORD_CONFIG_KEY),
};

/**
 * BA config per-database, KHÔNG phụ thuộc nhau (cùng origin host/port/
 * password nhưng database/user riêng — MỘT lần resolve origin config, BA lần
 * dựng origin per-target qua hàm thuần có spec). Tên resource Pulumi trùng
 * tên config Hyperdrive — một tên, một resource, trên stack `staging`.
 */
const stagingHyperdriveConfigs: Record<Database, cloudflare.HyperdriveConfig> = {
  gateway: undefined as never,
  tenant: undefined as never,
  marketplace: undefined as never,
};

for (const target of DATABASES) {
  stagingHyperdriveConfigs[target] = new cloudflare.HyperdriveConfig(
    stagingHyperdriveConfigName(target),
    {
      accountId: stagingAccountId,
      name: stagingHyperdriveConfigName(target),
      origin: resolveStagingHyperdriveOrigin(stagingOriginConfig, target),
      // Invariant 14 (đường correctness) — tắt tường minh, không dùng mặc định
      // server-side HD3 (nhận xét ở header).
      caching: { disabled: true },
    },
  );
}

export default {
  gatewayHyperdriveConfigId: stagingHyperdriveConfigs.gateway.id,
  tenantHyperdriveConfigId: stagingHyperdriveConfigs.tenant.id,
  marketplaceHyperdriveConfigId: stagingHyperdriveConfigs.marketplace.id,
};
