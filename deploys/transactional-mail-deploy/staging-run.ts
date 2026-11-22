/**
 * Thân mỏng per-unit của engine staging dùng chung (issue #543) — unit
 * `transactional-mail` (#355: D1 + chuỗi bốn Queue staging). Engine sống ở
 * `@ecoma-io/deployment` (`staging-run`); module này chỉ giữ phần PER-UNIT:
 * hằng tên tài nguyên staging, classify lane của project (slot candidate
 * nhận diện RIÊNG để guard từ chối — tên tài nguyên slot `-cand` thuộc #381),
 * và wrapper `readDatabaseId` gắn sẵn tên stack output `mailDatabaseId`.
 * Engine cần tên project cho inventory/selection — entry truyền thẳng
 * `'transactional-mail-deploy'` khi gọi `runStagingPhase`/`resolveStagingRunEnv`
 * (xem `staging.ts`).
 */

import {
  classifyDeployStackRef,
  exec,
  readStackOutputId,
  type StagingExecDeps,
  type StackSelection,
} from '@ecoma-io/deployment';

export {
  appendStagingRecord,
  backendBucket,
  ensureStagingStack,
  isProvisionedResourceId as isProvisionedDatabaseId,
  parseResourceChanges,
  parseStagingPhaseArg,
  r2AccountIdFromStateUrl,
  readGitHeadSha,
  readStagingRevision,
  RESOURCE_PLACEHOLDER_ID as DATABASE_PLACEHOLDER_ID,
  resolveStagingRunEnv,
  runStagingPhase,
  stagingEvidencePath,
  type StagingExecDeps,
  type StagingPhase,
  type StagingProvisioningRecord,
  type StagingResourceChanges,
} from '@ecoma-io/deployment';

/**
 * Tên D1 database staging của control plane (`mail`) — per-lane (§4.1: tài
 * nguyên account-unique, staging không dùng chung tên production `mail`).
 * Provision là việc của `staging-program.ts`; Wrangler chỉ tiêu thụ `id` vào
 * `env.staging.d1_databases` của `apps/transactional-mail/wrangler.jsonc`
 * sau một lần `up` xanh (§9.1).
 */
export const STAGING_MAIL_DATABASE_NAME = 'stg-mail';

/**
 * Chuỗi bốn Queue staging theo registry §9.1: delivery pair (producer control
 * plane ↔ consumer `transactional-mailer-job`) và lifecycle pair (Event
 * Subscriptions của provider Email Service, §11.3). Tên per-lane với prefix
 * `stg-` — production giữ tên không tiền tố cho M3; DLQ là tài nguyên độc lập
 * với vòng đời riêng (§9.1). Consumer + DLQ tham chiếu ĐỒNG BỘ ở
 * `apps/transactional-mailer-job/wrangler.jsonc` — spec hợp đồng
 * `staging-config.spec.ts` đối chiếu chéo hai file wrangler với hằng này.
 */
export const STAGING_QUEUE_NAMES = [
  'stg-ecoma-mail-delivery',
  'stg-ecoma-mail-delivery-dlq',
  'stg-ecoma-mail-lifecycle-events',
  'stg-ecoma-mail-lifecycle-events-dlq',
] as const;

/**
 * Phân loại stack ref đầy đủ của transactional-mail-deploy theo lane —
 * `local-*` là lane local; `staging` — slot staging continuous;
 * `staging-candidate` được nhận diện RIÊNG để guard từ chối tường minh (tên
 * tài nguyên slot `-cand` thuộc #381, chạy chương trình continuous trên đó là
 * collision tên D1/Queue account-unique); còn lại — KHÔNG ĐƯỢC chạy (cùng
 * hình #368).
 */
export function classifyTransactionalMailDeployStack(
  rawStackRef: string,
): 'local' | 'staging' | 'staging-candidate' | 'unknown' {
  return classifyDeployStackRef(rawStackRef);
}

/**
 * Id D1 database từ stack output `mailDatabaseId` — wrapper của engine
 * (`readStackOutputId`) gắn sẵn tên output của unit; đọc lỗi/placeholder →
 * `undefined` (chi tiết hợp đồng ở engine).
 */
export function readDatabaseId(
  projectDir: string,
  selection: StackSelection,
  env: NodeJS.ProcessEnv,
  deps: StagingExecDeps = { execFn: exec },
): string | undefined {
  return readStackOutputId('mailDatabaseId', projectDir, selection, env, deps);
}
