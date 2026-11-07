/**
 * `@ecoma-io/deployment` — deployment primitives và contracts dùng chung thật
 * của mọi deploy project (`deploys/*`) và tooling lifecycle của DX.
 *
 * ⚠️ **Chỉ chứa primitive có ÍT NHẤT HAI consumer thật.** Logic single-consumer
 * sống ở deploy project sở hữu nó (vd teardown volume PostgreSQL nằm ở
 * `deploys/platform-deploy/platform-down.ts`, quản lý `.env` ở
 * `deploys/platform-deploy/platform-env.ts`), không ở đây. Đưa code vào lib chỉ
 * để import compile được là sai ranh giới — `pnpm dx arch-check` và contract
 * test của lib chặn hướng phụ thuộc ngược (lib không được import `tools/dx`
 * hay project deploy nào).
 *
 * Module xuất khẩu (mỗi module một trách nhiệm, spec cạnh module):
 * - `deploy-namespace` — namespace worktree ổn định (xxHash64) + tên resource.
 * - `shell-quote` — hai biên escaping độc lập (POSIX shell, SQL literal).
 * - `deploy-labels` — Docker ownership labels cho `dx local-cleanup`.
 * - `local-auth-contract` — `client_id` OAuth share giữa auth/backoffice.
 * - `platform-outputs-contract` — hình dạng outputs platform stack + key `.env`.
 * - `pulumi-context` — CLI/backend context Pulumi cô lập theo worktree.
 * - `local-entry` — nền tảng entry lifecycle colocated (`up`/`down` mỗi unit).
 * - `local-env` — secret primitives dùng chung + đọc `ROOT_HOST` từ `.env`.
 */

export {
  type DeployResourceKind,
  NAMESPACE_LENGTH,
  RESOURCE_PREFIX,
  dockerResourceName,
  normalizeWorktreeRoot,
  namespaceFromCanonicalPath,
  pulumiStackName,
  worktreeNamespace,
} from './deploy-namespace.js';

export { shellQuote, sqlQuote } from './shell-quote.js';

export {
  LABEL_MANAGED_BY,
  LABEL_MANAGED_BY_LEGACY_VALUES,
  LABEL_MANAGED_BY_VALUE,
  LABEL_PREFIX,
  OWNERSHIP_LABELS,
  classifyOwnership,
  labelsFromInspect,
  ownershipLabels,
  type OwnershipCheck,
  type OwnershipLabel,
} from './deploy-labels.js';

export { LOCAL_BACKOFFICE_CLIENT_ID } from './local-auth-contract.js';

export {
  LOCAL_ENV_OWNED_KEYS,
  LOCAL_ROOT_HOSTNAME,
  POSTGRES_PASSWORD_ENV_KEY,
  ROOT_DOMAIN_ENV_KEY,
  ROOT_HOST_ENV_KEY,
  TRAEFIK_INTERNAL_PORT,
  buildRootHost,
  extractTraefikHostPort,
  type PlatformOutputs,
} from './platform-outputs-contract.js';

export {
  LOCAL_PASSPHRASE_FILE,
  type ExecOptions,
  type ExecResult,
  type LocalDeployContext,
  type LocalPassphrase,
  chmodFilePrivate,
  describeSpawnFailure,
  exec,
  execStreaming,
  ensureStack,
  fullStackRef,
  hasPulumiState,
  localPassphrasePath,
  localStateDir,
  pulumiEnv,
  pulumiRun,
  resolveContext,
  resolveLocalPassphrase,
  writeWorktreePassphrase,
} from './pulumi-context.js';

export {
  type EntryFoundation,
  deployProjectDir,
  ensureStackForEntry,
  pulumiDestroyForEntry,
  pulumiUpForEntry,
  resolveEntryFoundation,
  setStackConfig,
} from './local-entry.js';

export {
  generateAppSecret,
  generateInternalHmacSecret,
  generatePostgresPassword,
  isConfigKeyMissing,
  readRootHostFromEnv,
} from './local-env.js';
