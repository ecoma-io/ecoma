import type {
  MailMessageRecord,
  MailOutboxRecord,
  MailTemplateRecord,
} from '@ecoma-io/transactional-mail-application';
import type { MailMessageStatus } from '@ecoma-io/transactional-mail-contracts';

/**
 * Hình dạng hàng do driver trả về (snake_case, đúng tên cột trong migration) và hàm dựng bản ghi
 * port từ nó.
 *
 * Đổi tên cột → camelCase và ép kiểu `INTEGER`/`TEXT` xảy ra **tại đây, một chỗ duy nhất**.
 * Không repository nào tự map, nên một cột đổi tên đỏ ở một nơi thay vì âm thầm thành `undefined`
 * ở nhiều nơi — đúng kiểu lỗi mà `not.toMatch` không bao giờ bắt được.
 *
 * Cột được liệt kê bằng **hằng cố định**, không nối từ input: danh sách này là identifier của
 * schema, và việc duy nhất nó được dùng là `SELECT`/`RETURNING` (không có giá trị nào của caller
 * lọt vào). Mọi giá trị không tin cậy đều đi qua `bind`.
 */

/** Danh sách cột của `mail_messages` — dùng cho `SELECT` và `RETURNING`. */
export const MAIL_MESSAGE_COLUMNS =
  'id, app, principal_id, template_id, template_name, template_version, locale, recipient, ' +
  'subject_rendered, body_rendered, status, delivery_id, dispatch_generation, ' +
  'recovery_cycle_count, idempotency_key, request_fingerprint, correlation_id, failure_reason, ' +
  'terminal_at, created_at, updated_at';

/** Danh sách cột của `mail_outbox`. */
export const MAIL_OUTBOX_COLUMNS =
  'id, delivery_id, dispatch_generation, status, publish_attempts, available_at, claimed_at, ' +
  'claimed_by, published_at, last_error, created_at, updated_at';

/** Danh sách cột của `mail_templates`. */
export const MAIL_TEMPLATE_COLUMNS =
  'id, name, locale, version, subject_template, body_template, variables_schema_json, status, ' +
  'created_at, updated_at';

/** Hàng `mail_messages` như driver trả về. */
export interface MailMessageRow {
  readonly id: string;
  readonly app: string;
  readonly principal_id: string;
  readonly template_id: string;
  readonly template_name: string;
  readonly template_version: number;
  readonly locale: string;
  readonly recipient: string;
  readonly subject_rendered: string;
  readonly body_rendered: string;
  readonly status: MailMessageStatus;
  readonly delivery_id: string;
  readonly dispatch_generation: number;
  readonly recovery_cycle_count: number;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly correlation_id: string | null;
  readonly failure_reason: string | null;
  readonly terminal_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Hàng `mail_outbox` như driver trả về. */
export interface MailOutboxRow {
  readonly id: string;
  readonly delivery_id: string;
  readonly dispatch_generation: number;
  readonly status: MailOutboxRecord['status'];
  readonly publish_attempts: number;
  readonly available_at: number;
  readonly claimed_at: number | null;
  readonly claimed_by: string | null;
  readonly published_at: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Hàng `mail_templates` như driver trả về. */
export interface MailTemplateRow {
  readonly id: string;
  readonly name: string;
  readonly locale: string;
  readonly version: number;
  readonly subject_template: string;
  readonly body_template: string;
  readonly variables_schema_json: string;
  readonly status: MailTemplateRecord['status'];
  readonly created_at: number;
  readonly updated_at: number;
}

/** Dựng {@link MailMessageRecord} từ hàng đã đọc. */
export function toMailMessageRecord(row: MailMessageRow): MailMessageRecord {
  return {
    id: row.id,
    app: row.app,
    principalId: row.principal_id,
    templateId: row.template_id,
    templateName: row.template_name,
    templateVersion: row.template_version,
    locale: row.locale,
    recipient: row.recipient,
    subjectRendered: row.subject_rendered,
    bodyRendered: row.body_rendered,
    status: row.status,
    deliveryId: row.delivery_id,
    dispatchGeneration: row.dispatch_generation,
    recoveryCycleCount: row.recovery_cycle_count,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    correlationId: row.correlation_id ?? null,
    failureReason: row.failure_reason ?? null,
    terminalAtMs: row.terminal_at ?? null,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
}

/** Dựng {@link MailOutboxRecord} từ hàng đã đọc. */
export function toMailOutboxRecord(row: MailOutboxRow): MailOutboxRecord {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    dispatchGeneration: row.dispatch_generation,
    status: row.status,
    publishAttempts: row.publish_attempts,
    availableAtMs: row.available_at,
    claimedAtMs: row.claimed_at ?? null,
    claimedBy: row.claimed_by ?? null,
    publishedAtMs: row.published_at ?? null,
    lastError: row.last_error ?? null,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
}

/** Dựng {@link MailTemplateRecord} từ hàng đã đọc. */
export function toMailTemplateRecord(row: MailTemplateRow): MailTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    locale: row.locale,
    version: row.version,
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
    variablesSchemaJson: row.variables_schema_json,
    status: row.status,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
}
