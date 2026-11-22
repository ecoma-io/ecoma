/**
 * Thân mỏng per-unit của engine staging dùng chung (issue #543) — unit `staff-access`, một phần của wiring identity stack lên staging (#354).
 * Engine sống ở `@ecoma-io/deployment` (`staging-run`); module này chỉ giữ
 * phần PER-UNIT: hằng naming, classify lane của project, wrapper
 * `resolveStagingHyperdriveOrigin` gắn sẵn identity database/role, và wrapper
 * `readHyperdriveConfigId` gắn sẵn tên stack output. Engine cần tên project
 * cho inventory/selection — entry truyền thẳng `'staff-access-deploy'` khi gọi
 * `runStagingPhase`/`resolveStagingRunEnv` (xem `staging.ts`).
 */

import {
  classifyDeployStackRef,
  exec,
  readStackOutputId,
  resolveStagingHyperdriveOrigin as resolveStagingHyperdriveOriginBase,
  type StagingExecDeps,
  type StagingHyperdriveOrigin,
  type StagingHyperdriveOriginConfig,
  type StackSelection,
} from '@ecoma-io/deployment';

export {
  appendStagingRecord,
  backendBucket,
  ensureStagingStack,
  isProvisionedResourceId as isProvisionedHyperdriveConfigId,
  parseResourceChanges,
  parseStagingPhaseArg,
  r2AccountIdFromStateUrl,
  readGitHeadSha,
  readStagingRevision,
  RESOURCE_PLACEHOLDER_ID as HYPERDRIVE_PLACEHOLDER_ID,
  resolveStagingRunEnv,
  runStagingPhase,
  stagingEvidencePath,
  STAGING_ORIGIN_HOST_CONFIG_KEY,
  STAGING_ORIGIN_PASSWORD_CONFIG_KEY,
  STAGING_ORIGIN_PORT_CONFIG_KEY,
  type StagingExecDeps,
  type StagingPhase,
  type StagingProvisioningRecord,
  type StagingResourceChanges,
} from '@ecoma-io/deployment';

/**
 * Tên HyperdriveConfig của `db-staff-access` trên staging — per-database
 * (`db-staff-access`, §4.2) và per-lane (§7.4.1: stack `staging` và
 * `staging-candidate` không bao giờ trỏ chung một config; tên trùng trên MỘT
 * account Cloudflare là collision). Tên candidate slot có đuôi `-cand` theo
 * §4.2 — khi #381 wire slot đó, tên là tham số của chương trình, không phải
 * hằng ở đây.
 */
export const STAGING_STAFF_ACCESS_HYPERDRIVE_CONFIG_NAME = 'db-staff-access-staging';

/** Logical database staging của unit `staff-access` trên shared host (§4.2). */
export const STAGING_STAFF_ACCESS_DATABASE = 'db-staff-access';

/**
 * Role runtime của `db-staff-access` — Hyperdrive kết nối origin bằng role
 * này, KHÔNG bao giờ bằng migrator/owner (§4.2: cặp role `_migrator`/
 * `_runtime`; serving path dùng đúng role hẹp của nó).
 */
export const STAGING_STAFF_ACCESS_RUNTIME_ROLE = 'ecoma_staff_access_runtime';

/**
 * Phân loại stack ref đầy đủ của staff-access-deploy theo lane — mapping chung của
 * engine: `staging-candidate` vào cùng lane `staging` (chạy chương trình
 * staging của unit này, `staging-program.ts`); `local-*` là lane local; còn
 * lại — KHÔNG ĐƯỢC chạy (cùng hình #368).
 */
export function classifyStaffAccessDeployStack(
  rawStackRef: string,
): 'local' | 'staging' | 'unknown' {
  const lane = classifyDeployStackRef(rawStackRef);
  return lane === 'staging-candidate' ? 'staging' : lane;
}

/**
 * Resolve origin của HyperdriveConfig từ stack config — wrapper của engine
 * gắn sẵn identity database/role của unit này. FAIL CLOSED khi origin chưa
 * tồn tại (#349); chi tiết hợp đồng ở engine.
 */
export function resolveStagingHyperdriveOrigin(
  config: StagingHyperdriveOriginConfig,
): StagingHyperdriveOrigin {
  return resolveStagingHyperdriveOriginBase(
    config,
    STAGING_STAFF_ACCESS_DATABASE,
    STAGING_STAFF_ACCESS_RUNTIME_ROLE,
    'staff-access-deploy',
  );
}

/**
 * Id HyperdriveConfig từ stack output `hyperdriveConfigId` — wrapper của
 * engine (`readStackOutputId`) gắn sẵn tên output của unit; đọc lỗi/
 * placeholder → `undefined` (chi tiết hợp đồng ở engine).
 */
export function readHyperdriveConfigId(
  projectDir: string,
  selection: StackSelection,
  env: NodeJS.ProcessEnv,
  deps: StagingExecDeps = { execFn: exec },
): string | undefined {
  return readStackOutputId('hyperdriveConfigId', projectDir, selection, env, deps);
}
