/**
 * Thân mỏng per-unit của engine staging dùng chung (issue #543) — unit
 * `llm-api` (#359: BA database trên MỘT unit). Engine sống ở
 * `@ecoma-io/deployment` (`staging-run`); module này chỉ giữ phần PER-UNIT:
 * tên config/output Hyperdrive là HÀM của target (`gateway`/`tenant`/
 * `marketplace`, hằng naming ở `scripts.ts`), wrapper origin gắn sẵn identity
 * per-target, và classify lane của project. Engine cần tên project cho
 * inventory/selection — entry truyền thẳng `'llm-api-deploy'` khi gọi
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

import { dbName, runtimeRole, type Database } from './scripts.js';

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
 * Slot duy nhất executor này chạy: continuous lane. Candidate slot là #381.
 * Re-export của engine (`STAGING_SLOT`) — giữ lại tên per-unit cho call site
 * `staging.ts`.
 */
export { STAGING_SLOT } from '@ecoma-io/deployment';

/**
 * Tên HyperdriveConfig của MỘT database trên staging — per-database (§4.2) và
 * per-lane (§7.4.1: stack `staging` và `staging-candidate` không bao giờ trỏ
 * chung một config; tên trùng trên MỘT account Cloudflare là collision). Tên
 * candidate slot có đuôi `-cand` theo §4.2 — khi #381 wire slot đó, hậu tố
 * lane là tham số của chương trình, không phải hằng ở đây.
 */
export function stagingHyperdriveConfigName(target: Database): string {
  return `${dbName(target)}-staging`;
}

/**
 * Tên stack output mang id của HyperdriveConfig một target — hợp đồng giữa
 * `staging-program.ts` (export default) và entry `staging.ts` (đọc sau lần
 * `up` xanh). Tên suy từ target nên hai phía không thể lệch.
 */
export function stagingHyperdriveOutputName(target: Database): string {
  return `${target}HyperdriveConfigId`;
}

/**
 * Phân loại stack ref đầy đủ của llm-api-deploy theo lane — mapping chung của
 * engine: `staging-candidate` vào cùng lane `staging` (chạy chương trình khai
 * BA HyperdriveConfig, `staging-program.ts` #359); `local-*` là lane local;
 * còn lại — KHÔNG ĐƯỢC chạy (cùng hình #368).
 */
export function classifyLlmApiDeployStack(rawStackRef: string): 'local' | 'staging' | 'unknown' {
  const lane = classifyDeployStackRef(rawStackRef);
  return lane === 'staging-candidate' ? 'staging' : lane;
}

/**
 * Resolve origin của HyperdriveConfig MỘT target từ stack config — wrapper của
 * engine gắn sẵn identity per-target của `scripts.ts` (`db-llm-<target>`,
 * `ecoma_llm_<target>_runtime`). FAIL CLOSED khi origin chưa tồn tại (#349);
 * chi tiết hợp đồng ở engine.
 */
export function resolveStagingHyperdriveOrigin(
  config: StagingHyperdriveOriginConfig,
  target: Database,
): StagingHyperdriveOrigin {
  return resolveStagingHyperdriveOriginBase(
    config,
    dbName(target),
    runtimeRole(target),
    'llm-api-deploy',
  );
}

/**
 * Id HyperdriveConfig của MỘT target từ stack output
 * `<target>HyperdriveConfigId` — wrapper của engine (`readStackOutputId`)
 * gắn sẵn tên output suy từ target; đọc lỗi/placeholder → `undefined` (chi
 * tiết hợp đồng ở engine).
 */
export function readHyperdriveConfigId(
  projectDir: string,
  selection: StackSelection,
  env: NodeJS.ProcessEnv,
  target: Database,
  deps: StagingExecDeps = { execFn: exec },
): string | undefined {
  return readStackOutputId(stagingHyperdriveOutputName(target), projectDir, selection, env, deps);
}
