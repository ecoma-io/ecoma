/**
 * Thân mỏng per-unit của engine staging dùng chung (issue #543) — unit
 * `platform-deploy`, executor ĐẦU TIÊN của hợp đồng provisioning/
 * reconciliation staging (#368). Engine sống ở `@ecoma-io/deployment`
 * (`staging-run`); module này chỉ giữ phần PER-UNIT: classify lane của
 * project. Engine cần tên project cho inventory/selection — entry truyền
 * thẳng `'platform-deploy'` (hoặc tên unit khác qua cờ `--project` của
 * `staging.ts`) khi gọi `runStagingPhase`/`resolveStagingRunEnv`.
 */

import { classifyDeployStackRef } from '@ecoma-io/deployment';

export {
  appendStagingRecord,
  backendBucket,
  ensureStagingStack,
  parseResourceChanges,
  parseStagingPhaseArg,
  readGitHeadSha,
  readStagingRevision,
  resolveStagingRunEnv,
  runStagingPhase,
  stagingEvidencePath,
  type StagingExecDeps,
  type StagingPhase,
  type StagingProvisioningRecord,
  type StagingResourceChanges,
} from '@ecoma-io/deployment';

/**
 * Phân loại stack ref đầy đủ của platform-deploy theo lane — mapping chung của
 * engine: `staging-candidate` vào cùng lane `staging` (chạy chương trình khai
 * DNS zone `ecoma.io.vn`, `staging-program.ts` #349); `local-*` là lane local;
 * còn lại — KHÔNG ĐƯỢC chạy (lane local khai Docker resource dùng config
 * namespace, chạy trên stack lạ là khai resource sai environment — hazard thật
 * trước lane guard, cùng hình #368).
 */
export function classifyPlatformStack(rawStackRef: string): 'local' | 'staging' | 'unknown' {
  const lane = classifyDeployStackRef(rawStackRef);
  return lane === 'staging-candidate' ? 'staging' : lane;
}
