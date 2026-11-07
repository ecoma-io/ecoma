import {
  MAIL_JOB_STATUS_VALUES,
  MalformedMailJobStateError,
  OUTCOME_REPORT_STATE_VALUES,
  QUARANTINE_REASON_VALUES,
  type MailJobRecord,
  type MailJobStatus,
  type OutcomeReportState,
  type QuarantineReason,
  type QuarantineRecord,
} from '@ecoma-io/transactional-mailer-job-application';

/**
 * Giải mã một hàng `mail_jobs` thô thành {@link MailJobRecord}.
 *
 * ## Vì sao decode phải **fail** thay vì default
 *
 * Ràng buộc §6: *"malformed persisted state là một failure tường minh, không bao giờ
 * trở thành một trạng thái executable mặc định"*. Schema đã có CHECK cho `status`,
 * `outcome_report_state`, parity của `blocked_at`, parity của report state và parity
 * của cặp lease — nhưng schema **không** validate được giá trị đọc lên từ một database
 * bị sửa ngoài (restore cũ, script thủ công, bug writer khác).
 *
 * Vì vậy decoder **không** có đường "không hiểu thì cho qua": mọi sai lệch đều ném
 * {@link MalformedMailJobStateError}. Caller bắt buộc xử lý như một lỗi hạ tầng
 * (`retry()`, không ack — ma trận §9.2.2 hàng 8), **không** được coi row hỏng là
 * "chưa tồn tại" (sẽ tạo job mới) hay là "chưa claim" (sẽ báo lại mail).
 */

/** Số nguyên epoch ms đọc từ D1; NULL hợp lệ → `null`. */
function readNullableTimestamp(value: unknown, field: string, deliveryId: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MalformedMailJobStateError(
      deliveryId,
      `timestamp-${field}`,
      `Malformed mail_jobs row for delivery ${deliveryId}: column ${field} is not a safe integer (${typeof value})`,
    );
  }
  return value;
}

/** Số nguyên (bắt buộc, không null) đọc từ D1. */
function readRequiredCounter(value: unknown, field: string, deliveryId: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MalformedMailJobStateError(
      deliveryId,
      `counter-${field}`,
      `Malformed mail_jobs row for delivery ${deliveryId}: column ${field} is not a safe integer (${typeof value})`,
    );
  }
  return value;
}

/** Chuỗi (bắt buộc, không null). */
function readRequiredString(value: unknown, field: string, deliveryId: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MalformedMailJobStateError(
      deliveryId,
      `string-${field}`,
      `Malformed mail_jobs row for delivery ${deliveryId}: column ${field} is not a non-empty string`,
    );
  }
  return value;
}

/**
 * Chuỗi nullable — `null` là giá trị vắng mặt, nhưng `''` trong cột đã nullable là
 * dấu hiệu writer viết sai (mọi writer hợp lệ ghi `null` khi không có giá trị) nên
 * cũng fail closed như mọi sai lệch khác.
 */
function readNullableString(value: unknown, field: string, deliveryId: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new MalformedMailJobStateError(
      deliveryId,
      `string-${field}`,
      `Malformed mail_jobs row for delivery ${deliveryId}: column ${field} is neither null nor a non-empty string`,
    );
  }
  return value;
}

function readStatus(value: unknown, deliveryId: string): MailJobStatus {
  if (typeof value === 'string' && (MAIL_JOB_STATUS_VALUES as readonly string[]).includes(value)) {
    return value as MailJobStatus;
  }
  throw new MalformedMailJobStateError(
    deliveryId,
    'status-enum',
    `Malformed mail_jobs row for delivery ${deliveryId}: status is not a canonical value (${typeof value})`,
  );
}

function readOutcomeReportState(value: unknown, deliveryId: string): OutcomeReportState {
  if (
    typeof value === 'string' &&
    (OUTCOME_REPORT_STATE_VALUES as readonly string[]).includes(value)
  ) {
    return value as OutcomeReportState;
  }
  throw new MalformedMailJobStateError(
    deliveryId,
    'outcome-report-state-enum',
    `Malformed mail_jobs row for delivery ${deliveryId}: outcome_report_state is not a canonical value (${typeof value})`,
  );
}

/**
 * Kiểm tra các bất biến parity mà schema đã encode.
 *
 * Lặp lại ở tầng decode là **cố ý**: CHECK constraint của SQLite **không** chạy khi
 * row được ghi bởi một con đường khác (restore, `PRAGMA ignore_check_constraints`,
 * phiên bản schema cũ chưa có constraint này). Decode là ranh giới tin cậy cuối cùng
 * trước khi state đi vào quyết định.
 */
function assertParity(record: MailJobRecord): void {
  const isProcessing = record.status === 'processing';
  const reportIsNone = record.outcomeReportState === 'none';

  if (isProcessing !== reportIsNone) {
    throw new MalformedMailJobStateError(
      record.deliveryId,
      'report-state-parity',
      `Malformed mail_jobs row for delivery ${record.deliveryId}: outcome_report_state='${record.outcomeReportState}' contradicts status='${record.status}'`,
    );
  }

  const isBlocked = record.status === 'blocked';
  if (isBlocked !== (record.blockedAt !== null)) {
    throw new MalformedMailJobStateError(
      record.deliveryId,
      'blocked-at-parity',
      `Malformed mail_jobs row for delivery ${record.deliveryId}: status='${record.status}' contradicts blocked_at=${String(record.blockedAt)}`,
    );
  }

  if ((record.leaseOwner === null) !== (record.leaseExpiresAt === null)) {
    throw new MalformedMailJobStateError(
      record.deliveryId,
      'lease-pair-parity',
      `Malformed mail_jobs row for delivery ${record.deliveryId}: lease_owner and lease_expires_at disagree on null`,
    );
  }

  if ((record.reportLeaseOwner === null) !== (record.reportLeaseExpiresAt === null)) {
    throw new MalformedMailJobStateError(
      record.deliveryId,
      'report-lease-pair-parity',
      `Malformed mail_jobs row for delivery ${record.deliveryId}: report_lease_owner and report_lease_expires_at disagree on null`,
    );
  }

  if (record.dispatchGeneration < 1) {
    throw new MalformedMailJobStateError(
      record.deliveryId,
      'dispatch-generation-floor',
      `Malformed mail_jobs row for delivery ${record.deliveryId}: dispatch_generation must be >= 1 (${record.dispatchGeneration})`,
    );
  }

  if (record.executionGeneration < 0 || record.attempts < 0 || record.reportAttempts < 0) {
    throw new MalformedMailJobStateError(
      record.deliveryId,
      'counter-negative',
      `Malformed mail_jobs row for delivery ${record.deliveryId}: a counter is negative`,
    );
  }
}

/**
 * Decode một hàng `mail_jobs` đọc từ D1.
 *
 * @param row Hàng thô (`Record<string, unknown>`) từ `SELECT ... WHERE delivery_id = ?`.
 * @throws {@link MalformedMailJobStateError} khi bất kỳ trường nào không hợp lệ.
 */
export function decodeMailJobRow(row: Record<string, unknown>): MailJobRecord {
  const deliveryId = readRequiredString(row['delivery_id'], 'delivery_id', '<unknown>');
  const record: MailJobRecord = {
    deliveryId,
    messageId: readNullableString(row['message_id'], 'message_id', deliveryId),
    dispatchGeneration: readRequiredCounter(
      row['dispatch_generation'],
      'dispatch_generation',
      deliveryId,
    ),
    executionGeneration: readRequiredCounter(
      row['execution_generation'],
      'execution_generation',
      deliveryId,
    ),
    leaseOwner: readNullableString(row['lease_owner'], 'lease_owner', deliveryId),
    leaseExpiresAt: readNullableTimestamp(row['lease_expires_at'], 'lease_expires_at', deliveryId),
    status: readStatus(row['status'], deliveryId),
    attempts: readRequiredCounter(row['attempts'], 'attempts', deliveryId),
    lastError: readNullableString(row['last_error'], 'last_error', deliveryId),
    lastErrorClass: readNullableString(row['last_error_class'], 'last_error_class', deliveryId),
    providerMessageId: readNullableString(
      row['provider_message_id'],
      'provider_message_id',
      deliveryId,
    ),
    outcomeReportState: readOutcomeReportState(row['outcome_report_state'], deliveryId),
    reportLeaseOwner: readNullableString(
      row['report_lease_owner'],
      'report_lease_owner',
      deliveryId,
    ),
    reportLeaseExpiresAt: readNullableTimestamp(
      row['report_lease_expires_at'],
      'report_lease_expires_at',
      deliveryId,
    ),
    reportAttempts: readRequiredCounter(row['report_attempts'], 'report_attempts', deliveryId),
    blockedAt: readNullableTimestamp(row['blocked_at'], 'blocked_at', deliveryId),
    providerCallAt: readNullableTimestamp(row['provider_call_at'], 'provider_call_at', deliveryId),
    createdAt: readRequiredCounter(row['created_at'], 'created_at', deliveryId),
    updatedAt: readRequiredCounter(row['updated_at'], 'updated_at', deliveryId),
  };

  assertParity(record);
  return record;
}

/**
 * Decode một hàng `quarantine` đọc từ D1.
 *
 * Bản ghi quarantine theo data policy (`03-operations.md` §3.1) là **sanitized tối
 * thiểu**: digest, id message, reason, **tên** key vi phạm, counter, timestamps.
 * Không có raw payload, không có value của key vi phạm — decoder cũng không thêm
 * gì, nên không thể vô tình persist hay log nội dung lệnh.
 */
export function decodeQuarantineRow(row: Record<string, unknown>): QuarantineRecord {
  const quarantineId = readRequiredString(row['quarantine_id'], 'quarantine_id', '<unknown>');
  const reason = row['reason'];
  if (
    typeof reason !== 'string' ||
    !(QUARANTINE_REASON_VALUES as readonly string[]).includes(reason)
  ) {
    throw new MalformedMailJobStateError(
      quarantineId,
      'quarantine-reason-enum',
      `Malformed quarantine row for ${quarantineId}: reason is not a canonical value (${String(reason)})`,
    );
  }

  const record: QuarantineRecord = {
    quarantineId,
    queueMessageId: readRequiredString(row['queue_message_id'], 'queue_message_id', quarantineId),
    reason: reason as QuarantineReason,
    fieldName: readNullableString(row['field_name'], 'field_name', quarantineId),
    attempts: readRequiredCounter(row['attempts'], 'attempts', quarantineId),
    createdAt: readRequiredCounter(row['created_at'], 'created_at', quarantineId),
    updatedAt: readRequiredCounter(row['updated_at'], 'updated_at', quarantineId),
  };

  if (record.reason === 'forbidden-field' && record.fieldName === null) {
    throw new MalformedMailJobStateError(
      quarantineId,
      'quarantine-forbidden-field-name',
      `Malformed quarantine row for ${quarantineId}: reason='forbidden-field' requires field_name`,
    );
  }

  if (record.attempts < 1) {
    throw new MalformedMailJobStateError(
      quarantineId,
      'quarantine-attempts-floor',
      `Malformed quarantine row for ${quarantineId}: attempts must be >= 1 (${record.attempts})`,
    );
  }

  return record;
}

/**
 * Cột của `mail_jobs`; mọi SELECT đều chọn danh sách này và decode theo tên key.
 *
 * Thứ tự dưới đây là thứ tự **logical của decoder**, không phải thứ tự vật lý sau
 * migration `0003`: `ALTER TABLE ADD COLUMN` của SQLite append `provider_call_at` vào
 * **cuối** bảng (DDL thực tế: `..., blocked_at, created_at, updated_at, provider_call_at`).
 * Về hoạt động vô hại vì không SELECT nào đọc theo vị trí — nhưng đừng dựa vào thứ tự này
 * khi so `pragma_table_info` hay đọc `SELECT *`.
 */
export const MAIL_JOB_COLUMNS = [
  'delivery_id',
  'message_id',
  'dispatch_generation',
  'execution_generation',
  'lease_owner',
  'lease_expires_at',
  'status',
  'attempts',
  'last_error',
  'last_error_class',
  'provider_message_id',
  'outcome_report_state',
  'report_lease_owner',
  'report_lease_expires_at',
  'report_attempts',
  'blocked_at',
  'provider_call_at',
  'created_at',
  'updated_at',
] as const;

/** Cột của `quarantine` theo đúng thứ tự DDL. */
export const QUARANTINE_COLUMNS = [
  'quarantine_id',
  'queue_message_id',
  'reason',
  'field_name',
  'attempts',
  'created_at',
  'updated_at',
] as const;
