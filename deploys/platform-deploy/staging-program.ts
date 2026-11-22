/**
 * Thân chương trình lane staging của `platform-deploy` — DNS của staging infra
 * (#350; skeleton #349 đã khai zone theo A13, slice này nối record set theo
 * scheme hostname MOD1).
 *
 * Lane staging từ #453 đến #349 là marker-only; từ #349 stack staging khai
 * resource thật: zone `ecoma.io.vn` theo A13 (zone non-production — staging
 * public hostname là subdomain của zone này, Router non-production sở hữu
 * route `ecoma.io.vn/*` khi Router được hiện thực) cộng record set suy từ
 * inventory eligibility staging (`staging-dns.ts` — nguồn sự thật
 * `deploy-eligibility.jsonc`, một nguồn với GitHub Environments). Các unit
 * hạ tầng sau (`staging-pg-host`, Hyperdrive config...) tái sử dụng provider
 * Cloudflare mà module này giới thiệu.
 *
 * Credential ranh giới giữ nguyên hợp đồng #453: control-plane token đi qua
 * env (`CLOUDFLARE_API_TOKEN`, §6.12) — provider đọc env, không qua argv,
 * không vào Git. `accountId` là `config.require` — fail-closed khi chưa được
 * khai báo; operator đặt qua `pulumi config set-cloudflare:accountId` (hoặc
 * GitHub Environment của stack khi CI nối vào — #350; xem README của project
 * cho inventory đầy đủ).
 *
 * Zone adoption đã chốt thành công tắc (TODO #349/blocking cũ): config
 * `platform-deploy:stagingZoneAdoption` là quyết định TƯỜNG MINH của
 * operator — `true` = adopt zone đã tồn tại trên account (data source
 * `getZone`, Pulumi KHÔNG own zone, không claim zone có owner khác), `false`
 * = create-own (`cloudflare.Zone`). Không khai là preview fail-closed
 * (`requireBoolean`) — không đoán, không auto-adopt; cả hai config bắt buộc
 * phải có trước khi preview chạy được.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';

import {
  STAGING_RECORD_PLACEHOLDER_IPV4,
  STAGING_ROOT_ZONE_NAME,
  parseStagingEligibilityConfig,
  stagingDnsRecordSpecs,
  stripEligibilityJsonc,
} from './staging-dns.js';

// Provider control-plane duy nhất của lane staging (một account — A12, §6.12).
// Token KHÔNG được khai qua config: env là kênh duy nhất (ranh giới #453).
export const provider = new cloudflare.Provider('staging-control-plane', {});

// `cloudflare:accountId` bắt buộc qua config (secrets/config ngoài Git theo
// ops model §6.12) — thiếu là fail-closed, không đoán, không fallback.
const accountId = new pulumi.Config('cloudflare').require('accountId');

/**
 * Quyết định zone create-own vs adopt-existing — bắt buộc khai tường minh:
 * thiếu config là preview fail-closed khi trạng thái zone trên account chưa
 * biết (zone đã tồn tại mà create-own là claim sai owner; adopt khi chưa tồn
 * tại là lỗi config). Không có giá trị mặc định và không có auto-adopt.
 */
const zoneAdoptExisting = new pulumi.Config('platform-deploy').requireBoolean(
  'stagingZoneAdoption',
);

export const stagingRootZoneName = STAGING_ROOT_ZONE_NAME;

/**
 * Zone id — adopt thì đến từ data source `getZone` (filter đúng account A12
 * + name A13; zone không tìm thấy là lỗi invoke = fail-closed), create-own
 * thì đến từ resource `Zone` mới.
 */
export const stagingRootZoneId: pulumi.Output<string> = zoneAdoptExisting
  ? cloudflare.getZoneOutput({
      filter: { name: STAGING_ROOT_ZONE_NAME, account: { id: accountId } },
    }).zoneId
  : new cloudflare.Zone(
      'staging-root',
      // Provider v6 gói account vào object `account: { id }` (không phải
      // `accountId` phẳng như v5).
      { name: STAGING_ROOT_ZONE_NAME, account: { id: accountId } },
      { provider },
    ).id;

/**
 * Record set theo scheme MOD1 — suy từ inventory eligibility staging đọc
 * TRONG repo tại thời điểm provision: record luôn khớp phân loại
 * `deploy-eligibility.jsonc` của cùng revision Git (gitSha được ghi trong
 * evidence record của lần chạy). File thiếu là lỗi chặn — không provision
 * record nào theo giả định.
 */
const eligibilityPath = join(
  import.meta.dirname,
  '../../tools/delivery/config/deploy-eligibility.jsonc',
);
const eligibility = parseStagingEligibilityConfig(
  JSON.parse(stripEligibilityJsonc(readFileSync(eligibilityPath, 'utf8'))),
);

// Placeholder originless proxied theo docs Cloudflare ("Create DNS records
// → Originless setups", fetch 2026-11-20): request bị Cloudflare chặn ở
// edge trước origin, nên record sẵn sàng cho route của Router non-production
// mà không đòi origin thật. Record là của Pulumi (create + update + delete
// theo state) — unit gắn Wrangler Custom Domain (home, `02-delivery.md`
// §4.2) bị loại khỏi record set vì Wrangler own record + certificate của
// attachment; Pulumi không bao giờ cùng own một hostname với Wrangler (§9.1).
export const stagingDnsRecords = stagingDnsRecordSpecs(eligibility).map(
  (record) =>
    new cloudflare.DnsRecord(
      `staging-dns-${record.urnSlug}`,
      {
        zoneId: stagingRootZoneId,
        name: record.hostname,
        type: 'A',
        content: STAGING_RECORD_PLACEHOLDER_IPV4,
        proxied: true,
        ttl: record.ttl,
        comment: record.comment,
      },
      { provider },
    ),
);
