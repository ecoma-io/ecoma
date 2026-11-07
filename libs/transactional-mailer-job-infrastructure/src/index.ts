export {
  FAKE_PROVIDER_MESSAGE_ID,
  FAKE_RETRY_AFTER_MS,
  FakeMailProvider,
  type FakeMailProviderOptions,
} from './fake-mail-provider';

export type {
  D1DatabaseLike,
  D1BoundStatement,
  D1PreparedStatement,
  D1ResultMeta,
  D1RunResult,
} from './d1-database-like';
export { readChanges } from './d1-database-like';
export { D1MailJobRepository, type D1MailJobRepositoryOptions } from './d1-mail-job-repository';
export {
  D1QuarantineRepository,
  type D1QuarantineRepositoryOptions,
} from './d1-quarantine-repository';
export {
  decodeMailJobRow,
  decodeQuarantineRow,
  MAIL_JOB_COLUMNS,
  QUARANTINE_COLUMNS,
} from './mail-job-row';

/**
 * Provider adapter Cloudflare Email Sending (binding `send_email`) — cài
 * `MailProviderPort` của application. Provider thật mặc định: composition root chọn
 * theo `provider.kind` của config; `cloudflare` → `createCloudflareMailProvider`.
 */
export {
  type CloudflareMailProviderDeps,
  type CloudflareProviderConfig,
  type SendEmailBindingLike,
  createCloudflareMailProvider,
} from './cloudflare-mail-provider';

/**
 * Provider adapter Resend — cài `MailProviderPort` của application.
 *
 * Composition root (`apps/transactional-mailer-job/src/main.ts`) chọn adapter theo
 * `provider.kind` của config: `resend` → `createResendMailProvider`, `fake` →
 * `FakeMailProvider` (chỉ test/dev, không bao giờ production — 03-operations.md §3).
 */
export {
  type ProviderAbortController,
  type ProviderFetch,
  type ProviderRequestInit,
  type ProviderResponse,
  type ProviderResponseHeaders,
  type ResendMailProviderDeps,
  type ResendProviderConfig,
  createResendMailProvider,
} from './resend-mail-provider';

/**
 * Store D1 cho lifecycle event (`mail_lifecycle_events`, migration 0004) — cài seam
 * `store` của `ingestLifecycleEventMessage`; dedupe ở PRIMARY KEY, correlation best-effort.
 */
export {
  D1LifecycleEventStore,
  type D1LifecycleEventStoreOptions,
} from './d1-lifecycle-event-store';

/**
 * Client HTTP ký HMAC gọi private delivery interface của `transactional-mail` qua Service
 * Binding, và adapter bọc client thành port `MailDeliveryGateway` của application.
 *
 * Composition root (`apps/transactional-mailer-job/src/main.ts`) dựng client từ env
 * (`resolveInternalAuthSecret` + binding) rồi `createGateway(client)` — wiring ở entry
 * module chỉ là gọi hai factory này, không biết chi tiết ký hay phân loại response.
 */
export {
  INTERNAL_AUTH_SECRET_ENV,
  InternalDeliveryClient,
  InternalDeliveryConfigError,
  InternalDeliveryRequestError,
  type InternalDeliveryBinding,
  type InternalDeliveryClientOptions,
  resolveInternalAuthSecret,
} from './internal-delivery-client';
export { createGateway } from './internal-delivery-gateway';
