/**
 * Thân chương trình lane staging của `platform-deploy` — DNS skeleton của
 * staging infra (#349, spec mod-350 đã duyệt qua orchestrator).
 *
 * Làn staging từ #453 đến nay là marker-only (0 resource); từ #349 stack
 * staging khai resource thật, khởi đầu với DNS zone `ecoma.io.vn` theo A13
 * (zone non-production — staging public hostname là subdomain của zone này,
 * Router non-production sở hữu route `ecoma.io.vn/*` khi #350 nối). Các unit
 * hạ tầng sau (`staging-pg-host`, Hyperdrive config...) tái sử dụng provider
 * Cloudflare mà module này giới thiệu.
 *
 * Credential ranh giới giữ nguyên hợp đồng #453: control-plane token đi qua
 * env (`CLOUDFLARE_API_TOKEN`, §6.12) — provider đọc env, không qua argv,
 * không vào Git. `accountId` là `config.require` — fail-closed khi chưa được
 * khai báo (`#350` bootstrap; không đoán, không fallback).
 *
 * TODO(349/blocking): quyết định zone adoption — zone `ecoma.io.vn` tạo mới
 * trên account Cloudflare hay adopt zone đã tồn tại (chỉ có thể chốt sau khi
 * account id được khai qua GitHub Environment #350). Cho tới khi đó,
 * `pulumi preview` trên stack staging fail-closed vì thiếu config.
 */

import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';

// Provider control-plane duy nhất của lane staging (một account — A12, §6.12).
// Token KHÔNG được khai qua config: env là kênh duy nhất (ranh giới #453).
export const provider = new cloudflare.Provider('staging-control-plane', {});

// TODO(349/blocking): `cloudflare:accountId` chưa có ở bất kỳ kênh secrets
// nào — `config.require` làm preview fail-closed cho tới khi #350 khai báo.
const accountId = new pulumi.Config('cloudflare').require('accountId');

/**
 * Zone non-production theo A13 — `ecoma.io.vn`.
 *
 * TODO(349/blocking): adoption decision — nếu zone đã tồn tại trên account
 * (được quản lý ngoài Pulumi), resource này phải đổi thành `getZone` data
 * source (adopt, không own) để Pulumi không claim zone có owner khác. Cho tới
 * khi chốt, khai báo là create-own: skeleton này CHƯA được `up` lần nào
 * (backend staging chưa bootstrap) nên chưa có mutation thật nào xảy ra.
 */
export const stagingRootZone = new cloudflare.Zone(
  'staging-root',
  // Provider v6 gói account vào object `account: { id }` (không phải
  // `accountId` phẳng như v5).
  { name: 'ecoma.io.vn', account: { id: accountId } },
  { provider },
);

export const stagingRootZoneId = stagingRootZone.id;
export const stagingRootZoneName = stagingRootZone.name;
