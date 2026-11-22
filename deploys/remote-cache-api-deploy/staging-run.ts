/**
 * Thân mỏng per-unit của engine staging dùng chung (issue #543) — unit `remote-cache-api` (#350).
 * Engine sống ở `@ecoma-io/deployment` (`staging-run`); module này chỉ giữ
 * phần PER-UNIT: hằng naming, classify lane của project, wrapper
 * `resolveStagingHyperdriveOrigin` gắn sẵn identity database/role, và wrapper
 * `readHyperdriveConfigId` gắn sẵn tên stack output. Engine cần tên project
 * cho inventory/selection — entry truyền thẳng `'remote-cache-api-deploy'` khi gọi
 * `runStagingPhase`/`resolveStagingRunEnv` (xem `staging.ts`).
 */

import {
  classifyDeployStackRef,
  exec,
  readStackOutputId,
  resolveStagingHyperdriveOrigin as resolveStagingHyperdriveOriginBase,
  stagingHyperdriveWiringExit as stagingHyperdriveWiringExitBase,
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
 * Tên R2 bucket object storage của remote-cache trên staging — tên đã duyệt
 * qua #514. Chưa provision lần nào nên đổi tên không đụng state thật; khi
 * bucket đã tồn tại thật thì đổi tên là tạo-mới + sao chép + xoá-củ, không
 * phải một lần `up`.
 */
export const STAGING_REMOTE_CACHE_BUCKET_NAME = 'ecoma-remote-cache-staging';

/**
 * Tên HyperdriveConfig của `db-remote-cache` trên staging — per-database
 * (`db-remote-cache`, §4.2) và per-lane (§7.4.1: stack `staging` và
 * `staging-candidate` không bao giờ trỏ chung một config). Tên candidate slot
 * có đuôi `-cand` theo §4.2 — khi #381 wire slot đó, tên là tham số của
 * chương trình, không phải hằng ở đây.
 */
export const STAGING_REMOTE_CACHE_HYPERDRIVE_CONFIG_NAME = 'db-remote-cache-staging';

/** Logical database staging của unit `remote-cache-api` trên shared host (§4.2). */
export const STAGING_REMOTE_CACHE_DATABASE = 'db-remote-cache';

/**
 * Role runtime của `db-remote-cache` — Hyperdrive kết nối origin bằng role
 * này, KHÔNG bao giờ bằng migrator/owner (§4.2: cặp role `_migrator`/
 * `_runtime`; serving path dùng đúng role hẹp của nó).
 */
export const STAGING_REMOTE_CACHE_RUNTIME_ROLE = 'ecoma_remote_cache_runtime';

/**
 * Phân loại stack ref đầy đủ của remote-cache-api-deploy theo lane — mapping chung của
 * engine: `staging-candidate` vào cùng lane `staging` (chạy chương trình
 * staging của unit này, `staging-program.ts`); `local-*` là lane local; còn
 * lại — KHÔNG ĐƯỢC chạy (cùng hình #368).
 */
export function classifyRemoteCacheApiStack(rawStackRef: string): 'local' | 'staging' | 'unknown' {
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
    STAGING_REMOTE_CACHE_DATABASE,
    STAGING_REMOTE_CACHE_RUNTIME_ROLE,
    'remote-cache-api-deploy',
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

/**
 * Bước wiring sau một lần `up` xanh — wrapper của engine
 * `stagingHyperdriveWiringExit` gắn sẵn binding name và đường wrangler.jsonc
 * của unit này (#350/#357); trả exit code cho entry, chi tiết hợp đồng ở
 * engine.
 */
export function stagingHyperdriveWiringExit(
  project: string,
  selection: StackSelection,
  env: NodeJS.ProcessEnv,
  deps: StagingExecDeps = { execFn: exec },
): number {
  return stagingHyperdriveWiringExitBase(
    project,
    selection,
    env,
    {
      binding: 'DB_REMOTE_CACHE',
      wranglerPath: 'apps/remote-cache-api/wrangler.jsonc',
    },
    deps,
  );
}
