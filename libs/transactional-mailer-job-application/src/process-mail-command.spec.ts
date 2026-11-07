/**
 * Spec cho orchestration của một Queue command.
 *
 * Fake ở đây là **in-memory implementation của port**, không phải một API test riêng: nó giữ
 * `Map<deliveryId, MailJobRecord>` và áp dụng đúng điều kiện của từng statement canonical
 * (`01-architecture.md` §9.2.1). Nhờ vậy orchestration được kiểm ở đúng hình dạng state machine mà
 * D1 implementation thật sẽ áp — khác với một mock chỉ trả kết quả định sẵn, vốn không bắt được
 * lỗi "gọi statement (b) khi row đang ở generation mới".
 *
 * Mọi transition của fake dùng classifier thật của `mail-job-rules`, nên affected rows = 0
 * được phân loại y như D1 (đó là điểm mấu chốt: phần lớn hành vi của orchestration nằm ở chỗ
 * **nghĩa** của denial, không nằm ở chỗ denial xuất hiện).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  DeliveryLookupResult,
  DeliveryMaterial,
  MailDeliveryGateway,
  OutcomeReportRequest,
  OutcomeReportResult,
} from './mail-delivery-gateway';
import type { MailJobRecord, QuarantineRecord } from './mail-job-model';
import { MAIL_JOB_PROVIDER_AMBIGUOUS_ERROR_CLASS } from './mail-job-model';
import {
  classifyAmbiguityBlockedDenial,
  classifyBudgetExhaustedDenial,
  classifyGenerationAdvanceDenial,
  classifyLeaseOwnershipDenial,
  classifyProviderCallBoundaryDenial,
  classifyReportCompletionDenial,
  classifyReportLeaseDenial,
  classifySameGenerationClaimDenial,
  isEligibleForReportSweep,
} from './mail-job-rules';
import type {
  AcquireReportLeaseParams,
  AcquireReportLeaseResult,
  BlockedBacklogSweepItem,
  ClaimGenerationAdvanceParams,
  ClaimGenerationAdvanceResult,
  ClaimSameGenerationParams,
  ClaimSameGenerationResult,
  CompleteReportParams,
  CompleteReportResult,
  CreatePendingJobParams,
  CreatePendingJobResult,
  FindBlockedBacklogCandidatesParams,
  FindReportSweepCandidatesParams,
  FindStaleLeaseCandidatesParams,
  KeepReportPendingParams,
  KeepReportPendingResult,
  MailJobRepository,
  MarkBlockedBudgetExhaustedParams,
  MarkBlockedBudgetExhaustedResult,
  MarkProviderCallBoundaryParams,
  MarkProviderCallBoundaryResult,
  MarkProviderAmbiguityBlockedParams,
  MarkProviderAmbiguityBlockedResult,
  PersistExecutionResultParams,
  PersistExecutionResultResult,
  QuarantineRepository,
  RecordLookupErrorParams,
  RecordLookupErrorResult,
  ReleaseExecutionLeaseParams,
  ReleaseExecutionLeaseResult,
  RenewExecutionLeaseParams,
  RenewExecutionLeaseResult,
  ReportSweepItem,
  StaleLeaseSweepItem,
  UpsertQuarantineRecordParams,
  UpsertQuarantineRecordResult,
} from './mail-job-repository-port';
import type {
  MailProviderPort,
  MailProviderSendRequest,
  MailProviderSendResult,
} from './mail-provider-port';
import {
  processMailCommand,
  reportOwnerToken,
  type MailCommandOutcome,
  type ProcessMailCommandConfig,
  type ProcessMailCommandDeps,
} from './process-mail-command';
import { QUARANTINE_ID_PATTERN } from './quarantine-digest';

/** Mốc thời gian tường minh — mọi biên được tính trên hằng, không đọc đồng hồ. */
const NOW = 1_800_000_000_000;

/** Lease dài hơn `providerTimeoutMs`, đúng điều kiện vận hành mà §9.2.1 đòi. */
const LEASE_MS = 30_000;
const REPORT_LEASE_MS = 10_000;
const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 4;
/** Cửa sổ an toàn idempotency — hằng của test, đuôi hơn 0 để test biên inclusive. */
const PROVIDER_CALL_SAFE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Owner của execution trong spec. */
const OWNER = 'owner-exec-1';

/** Khoá HMAC 32 byte — hằng của test, không phải secret thật. */
const KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

/** `delivery_id` chuẩn dùng trong spec. */
const DELIVERY_ID = 'dlv_fixture_1';

/** Command hợp lệ — chỉ hai field, đúng contract §5. */
const CANONICAL_COMMAND = JSON.stringify({ version: 1, delivery_id: DELIVERY_ID });

function config(overrides: Partial<ProcessMailCommandConfig> = {}): ProcessMailCommandConfig {
  return {
    executionLeaseMs: LEASE_MS,
    maxExecutionAttempts: MAX_ATTEMPTS,
    providerTimeoutMs: PROVIDER_TIMEOUT_MS,
    providerCallSafeWindowMs: PROVIDER_CALL_SAFE_WINDOW_MS,
    reportLeaseMs: REPORT_LEASE_MS,
    owner: OWNER,
    quarantineKeyHex: KEY_HEX,
    nowMs: NOW,
    ...overrides,
  };
}

/** Runtime material từ control plane — không phải dữ liệu thật của bất kỳ ai. */
function material(overrides: Partial<DeliveryMaterial> = {}): DeliveryMaterial {
  return {
    deliveryId: DELIVERY_ID,
    messageId: 'msg-1',
    app: 'account',
    status: 'queued',
    recipient: 'nguoi-nhan@example.test',
    subject: 'chu-de',
    body: '<p>noi-dung</p>',
    contentType: 'text/html',
    dispatchGeneration: 1,
    ...overrides,
  };
}

/** Row `processing` hợp lệ, chưa giữ lease, chưa tiêu ngân sách B. */
function processingRow(overrides: Partial<MailJobRecord> = {}): MailJobRecord {
  return {
    deliveryId: DELIVERY_ID,
    messageId: 'msg-1',
    dispatchGeneration: 1,
    executionGeneration: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    status: 'processing',
    attempts: 0,
    lastError: null,
    lastErrorClass: null,
    providerMessageId: null,
    outcomeReportState: 'none',
    reportLeaseOwner: null,
    reportLeaseExpiresAt: null,
    reportAttempts: 0,
    blockedAt: null,
    providerCallAt: null,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

/**
 * Repository in-memory áp đúng điều kiện của các statement canonical.
 *
 * Không có I/O, không đọc đồng hồ: mọi guard so sánh với `nowMs` trong tham số, đúng như SQL
 * bind.
 */
class FakeJobs implements MailJobRepository {
  readonly rows = new Map<string, MailJobRecord>();
  readonly calls: string[] = [];

  seed(record: MailJobRecord): void {
    this.rows.set(record.deliveryId, record);
  }

  row(deliveryId = DELIVERY_ID): MailJobRecord {
    const found = this.rows.get(deliveryId);
    if (found === undefined) {
      throw new Error(`fake has no row for ${deliveryId}`);
    }
    return found;
  }

  async loadJobByDeliveryId(deliveryId: string): Promise<MailJobRecord | null> {
    return this.rows.get(deliveryId) ?? null;
  }

  async createPendingJob(params: CreatePendingJobParams): Promise<CreatePendingJobResult> {
    this.calls.push('createPendingJob');
    if (this.rows.has(params.deliveryId)) {
      return { kind: 'duplicate' };
    }
    this.rows.set(
      params.deliveryId,
      processingRow({
        deliveryId: params.deliveryId,
        messageId: params.messageId ?? null,
        dispatchGeneration: params.dispatchGeneration,
        executionGeneration: 0,
        attempts: 0,
        createdAt: params.createdAt,
        updatedAt: params.updatedAt,
      }),
    );
    return { kind: 'created' };
  }

  async claimSameGeneration(params: ClaimSameGenerationParams): Promise<ClaimSameGenerationResult> {
    this.calls.push('claimSameGeneration');
    const record = this.rows.get(params.deliveryId) ?? null;
    const applicable =
      record !== null &&
      record.dispatchGeneration === params.dispatchGeneration &&
      record.attempts < params.maxExecutionAttempts &&
      !isLeaseActive(record, params.nowMs) &&
      record.status !== 'sent' &&
      record.status !== 'failed' &&
      record.status !== 'blocked';

    if (!applicable || record === null) {
      return {
        kind: 'denied',
        reason: classifySameGenerationClaimDenial(record, params),
      };
    }

    const claimed = processingRow({
      ...record,
      executionGeneration: record.executionGeneration + 1,
      attempts: record.attempts + 1,
      leaseOwner: params.owner,
      leaseExpiresAt: params.nowMs + params.leaseMs,
      status: 'processing',
      outcomeReportState: 'none',
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, claimed);
    return { kind: 'claimed', record: claimed };
  }

  async claimGenerationAdvance(
    params: ClaimGenerationAdvanceParams,
  ): Promise<ClaimGenerationAdvanceResult> {
    this.calls.push('claimGenerationAdvance');
    const record = this.rows.get(params.deliveryId) ?? null;
    const applicable =
      record !== null &&
      record.dispatchGeneration < params.newDispatchGeneration &&
      !isLeaseActive(record, params.nowMs) &&
      record.status !== 'sent' &&
      record.status !== 'failed';

    if (!applicable || record === null) {
      return {
        kind: 'denied',
        reason: classifyGenerationAdvanceDenial(record, params),
      };
    }

    // §9.2.1 đường (b): ngân sách B **reset** cho generation mới (`attempts = 1`), report
    // state về `none`, và cả hai cột report-lease bị clear trong cùng statement.
    const claimed = processingRow({
      ...record,
      dispatchGeneration: params.newDispatchGeneration,
      executionGeneration: record.executionGeneration + 1,
      attempts: 1,
      leaseOwner: params.owner,
      leaseExpiresAt: params.nowMs + params.leaseMs,
      status: 'processing',
      outcomeReportState: 'none',
      blockedAt: null,
      reportLeaseOwner: null,
      reportLeaseExpiresAt: null,
      reportAttempts: 0,
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, claimed);
    return { kind: 'claimed', record: claimed };
  }

  async markBlockedBudgetExhausted(
    params: MarkBlockedBudgetExhaustedParams,
  ): Promise<MarkBlockedBudgetExhaustedResult> {
    this.calls.push('markBlockedBudgetExhausted');
    const record = this.rows.get(params.deliveryId) ?? null;
    const applicable =
      record !== null &&
      record.dispatchGeneration === params.dispatchGeneration &&
      record.attempts >= params.maxExecutionAttempts &&
      !isLeaseActive(record, params.nowMs) &&
      record.status !== 'sent' &&
      record.status !== 'failed' &&
      record.status !== 'blocked';

    if (!applicable || record === null) {
      return {
        kind: 'denied',
        reason: classifyBudgetExhaustedDenial(record, params),
      };
    }

    const blocked = processingRow({
      ...record,
      status: 'blocked',
      blockedAt: params.nowMs,
      lastErrorClass: 'execution-budget-exhausted',
      outcomeReportState: 'pending',
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, blocked);
    return { kind: 'applied', record: blocked };
  }

  async markProviderCallBoundary(
    params: MarkProviderCallBoundaryParams,
  ): Promise<MarkProviderCallBoundaryResult> {
    this.calls.push('markProviderCallBoundary');
    const record = this.rows.get(params.deliveryId) ?? null;
    if (
      record === null ||
      !ownsLease(record, params.owner, params.executionGeneration, params.dispatchGeneration) ||
      record.status !== 'processing' ||
      record.outcomeReportState !== 'none'
    ) {
      return {
        kind: 'denied',
        reason: classifyProviderCallBoundaryDenial(record, {
          owner: params.owner,
          executionGeneration: params.executionGeneration,
          dispatchGeneration: params.dispatchGeneration,
        }),
        record,
      };
    }
    if (record.providerCallAt !== null) {
      // Guard first-write-only của statement (e) — denial bình thường, không mất claim.
      return { kind: 'denied', reason: 'already-marked', record };
    }

    const marked = processingRow({
      ...record,
      providerCallAt: params.nowMs,
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, marked);
    return { kind: 'applied', record: marked };
  }

  async markProviderAmbiguityBlocked(
    params: MarkProviderAmbiguityBlockedParams,
  ): Promise<MarkProviderAmbiguityBlockedResult> {
    this.calls.push('markProviderAmbiguityBlocked');
    const record = this.rows.get(params.deliveryId) ?? null;
    const applicable =
      record !== null &&
      record.dispatchGeneration === params.dispatchGeneration &&
      record.providerCallAt !== null &&
      !isLeaseActive(record, params.nowMs) &&
      record.status !== 'sent' &&
      record.status !== 'failed' &&
      record.status !== 'blocked';

    if (!applicable || record === null) {
      return {
        kind: 'denied',
        reason: classifyAmbiguityBlockedDenial(record, {
          dispatchGeneration: params.dispatchGeneration,
          nowMs: params.nowMs,
        }),
        record,
      };
    }

    const blocked = processingRow({
      ...record,
      status: 'blocked',
      blockedAt: params.nowMs,
      lastErrorClass: MAIL_JOB_PROVIDER_AMBIGUOUS_ERROR_CLASS,
      outcomeReportState: 'pending',
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, blocked);
    return { kind: 'applied', record: blocked };
  }

  async renewExecutionLease(params: RenewExecutionLeaseParams): Promise<RenewExecutionLeaseResult> {
    this.calls.push('renewExecutionLease');
    const record = this.rows.get(params.deliveryId) ?? null;
    // `RenewExecutionLeaseParams` cố ý **không** có `dispatchGeneration`: guard của renew chỉ
    // là cặp `lease_owner` + `execution_generation` (§9.2.1), và generation được suy ra từ
    // chính row. Fake bám đúng điều kiện đó, không cộng thêm một guard mà port không có.
    if (
      record === null ||
      record.leaseOwner !== params.owner ||
      record.executionGeneration !== params.executionGeneration
    ) {
      return { kind: 'denied', reason: classifyLeaseOwnershipDenial(record) };
    }
    const renewed = processingRow({
      ...record,
      leaseExpiresAt: params.nowMs + params.leaseMs,
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, renewed);
    return { kind: 'applied', record: renewed };
  }

  async persistExecutionResult(
    params: PersistExecutionResultParams,
  ): Promise<PersistExecutionResultResult> {
    this.calls.push('persistExecutionResult');
    const record = this.rows.get(params.deliveryId) ?? null;
    if (
      !ownsLease(record, params.owner, params.executionGeneration, params.dispatchGeneration) ||
      record?.outcomeReportState !== 'none' ||
      record?.status !== 'processing'
    ) {
      return { kind: 'denied', reason: classifyLeaseOwnershipDenial(record) };
    }

    // Persist result **release lease trong cùng UPDATE** và đưa report về `pending`.
    const persisted = processingRow({
      ...record,
      status: params.outcome,
      blockedAt: params.outcome === 'blocked' ? params.nowMs : null,
      leaseOwner: null,
      leaseExpiresAt: null,
      outcomeReportState: 'pending',
      providerMessageId: params.providerMessageId ?? null,
      lastError: params.lastError ?? null,
      lastErrorClass: params.lastErrorClass ?? null,
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, persisted);
    return { kind: 'applied', record: persisted };
  }

  async releaseExecutionLease(
    params: ReleaseExecutionLeaseParams,
  ): Promise<ReleaseExecutionLeaseResult> {
    this.calls.push('releaseExecutionLease');
    const record = this.rows.get(params.deliveryId) ?? null;
    if (!ownsLease(record, params.owner, params.executionGeneration, params.dispatchGeneration)) {
      return { kind: 'denied', reason: classifyLeaseOwnershipDenial(record) };
    }

    const released = processingRow({
      ...record,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: params.lastError ?? null,
      lastErrorClass: params.lastErrorClass ?? null,
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, released);
    return { kind: 'applied', record: released };
  }

  async recordLookupError(params: RecordLookupErrorParams): Promise<RecordLookupErrorResult> {
    this.calls.push('recordLookupError');
    const record = this.rows.get(params.deliveryId) ?? null;
    if (
      record === null ||
      record.status !== 'processing' ||
      record.outcomeReportState !== 'none' ||
      record.dispatchGeneration !== params.dispatchGeneration
    ) {
      return { kind: 'skipped' };
    }

    const updated = processingRow({
      ...record,
      lastError: null,
      lastErrorClass: params.lastErrorClass,
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, updated);
    return { kind: 'applied', record: updated };
  }

  async acquireReportLease(params: AcquireReportLeaseParams): Promise<AcquireReportLeaseResult> {
    this.calls.push('acquireReportLease');
    const record = this.rows.get(params.deliveryId) ?? null;
    const applicable =
      record !== null &&
      record.dispatchGeneration === params.dispatchGeneration &&
      record.outcomeReportState === 'pending' &&
      !isReportLeaseActive(record, params.nowMs);

    if (!applicable || record === null) {
      return { kind: 'denied', reason: classifyReportLeaseDenial(record, params) };
    }

    const acquired = processingRow({
      ...record,
      reportLeaseOwner: params.owner,
      reportLeaseExpiresAt: params.nowMs + params.reportLeaseMs,
      reportAttempts: record.reportAttempts + 1,
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, acquired);
    return { kind: 'acquired', record: acquired };
  }

  async completeReport(params: CompleteReportParams): Promise<CompleteReportResult> {
    this.calls.push('completeReport');
    const record = this.rows.get(params.deliveryId) ?? null;
    const applicable =
      record !== null &&
      record.dispatchGeneration === params.dispatchGeneration &&
      record.outcomeReportState === 'pending' &&
      record.reportLeaseOwner === params.owner;

    if (!applicable || record === null) {
      return { kind: 'denied', reason: classifyReportCompletionDenial(record, params) };
    }

    const completed = processingRow({
      ...record,
      outcomeReportState: params.disposition,
      reportLeaseOwner: null,
      reportLeaseExpiresAt: null,
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, completed);
    return { kind: 'applied', record: completed };
  }

  async keepReportPending(params: KeepReportPendingParams): Promise<KeepReportPendingResult> {
    this.calls.push('keepReportPending');
    const record = this.rows.get(params.deliveryId) ?? null;
    const applicable =
      record !== null &&
      record.dispatchGeneration === params.dispatchGeneration &&
      record.outcomeReportState === 'pending' &&
      record.reportLeaseOwner === params.owner;

    if (!applicable || record === null) {
      return { kind: 'denied', reason: classifyReportCompletionDenial(record, params) };
    }

    // Giữ `pending` nhưng **release report-lease** để lần sweep sau claim lại được ngay.
    const kept = processingRow({
      ...record,
      reportLeaseOwner: null,
      reportLeaseExpiresAt: null,
      updatedAt: params.nowMs,
    });
    this.rows.set(params.deliveryId, kept);
    return { kind: 'applied', record: kept };
  }

  async findStaleLeaseCandidates(
    _params: FindStaleLeaseCandidatesParams,
  ): Promise<readonly StaleLeaseSweepItem[]> {
    return [];
  }

  async findReportSweepCandidates(
    _params: FindReportSweepCandidatesParams,
  ): Promise<readonly ReportSweepItem[]> {
    return [];
  }

  async findBlockedBacklogCandidates(
    _params: FindBlockedBacklogCandidatesParams,
  ): Promise<readonly BlockedBacklogSweepItem[]> {
    return [];
  }
}

/** Lease execution còn hiệu lực — cùng biên `lease_expires_at > now` của `mail-job-rules`. */
function isLeaseActive(record: MailJobRecord, nowMs: number): boolean {
  return (
    record.leaseOwner !== null && record.leaseExpiresAt !== null && record.leaseExpiresAt > nowMs
  );
}

/** Report-lease còn hiệu lực — cùng biên với statement (d). */
function isReportLeaseActive(record: MailJobRecord, nowMs: number): boolean {
  return (
    record.reportLeaseOwner !== null &&
    record.reportLeaseExpiresAt !== null &&
    record.reportLeaseExpiresAt > nowMs
  );
}

/** Điều kiện owner của ba statement persist/release/renew. */
function ownsLease(
  record: MailJobRecord | null,
  owner: string,
  executionGeneration: number,
  dispatchGeneration: number,
): boolean {
  return (
    record !== null &&
    record.leaseOwner === owner &&
    record.executionGeneration === executionGeneration &&
    record.dispatchGeneration === dispatchGeneration
  );
}

/** Quarantine in-memory — khoá chính tổ hợp `(quarantine_id, queue_message_id)`. */
class FakeQuarantine implements QuarantineRepository {
  readonly rows = new Map<string, QuarantineRecord>();
  readonly upserts: UpsertQuarantineRecordParams[] = [];

  async upsertQuarantineRecord(
    params: UpsertQuarantineRecordParams,
  ): Promise<UpsertQuarantineRecordResult> {
    this.upserts.push(params);
    const key = `${params.quarantineId}|${params.queueMessageId}`;
    const existing = this.rows.get(key);

    // `ON CONFLICT DO UPDATE` chỉ chạm `attempts`/`updated_at` — `reason`/`field_name` của lần
    // ghi đầu là nguồn phân loại (xem `d1-quarantine-repository.ts`).
    const record: QuarantineRecord = {
      quarantineId: params.quarantineId,
      queueMessageId: params.queueMessageId,
      reason: existing?.reason ?? params.reason,
      fieldName: existing?.fieldName ?? params.fieldName ?? null,
      attempts: (existing?.attempts ?? 0) + 1,
      createdAt: existing?.createdAt ?? params.nowMs,
      updatedAt: params.nowMs,
    };
    this.rows.set(key, record);
    return existing === undefined ? { kind: 'created', record } : { kind: 'updated', record };
  }

  async getQuarantineRecord(params: {
    readonly quarantineId: string;
    readonly queueMessageId: string;
  }): Promise<QuarantineRecord | null> {
    return this.rows.get(`${params.quarantineId}|${params.queueMessageId}`) ?? null;
  }
}

/** Gateway in-memory: trả lookup/report theo kịch bản test đặt sẵn. */
class FakeGateway implements MailDeliveryGateway {
  lookup: DeliveryLookupResult = { kind: 'found', delivery: material() };
  lookupThrows = false;
  report: OutcomeReportResult = { kind: 'applied', status: 'sent' };
  reportThrows = false;
  readonly getDeliveryCalls: string[] = [];
  readonly reportCalls: OutcomeReportRequest[] = [];

  async getDelivery(deliveryId: string): Promise<DeliveryLookupResult> {
    this.getDeliveryCalls.push(deliveryId);
    if (this.lookupThrows) {
      throw new Error('gateway is down');
    }
    return this.lookup;
  }

  async reportOutcome(
    _deliveryId: string,
    report: OutcomeReportRequest,
  ): Promise<OutcomeReportResult> {
    this.reportCalls.push(report);
    if (this.reportThrows) {
      throw new Error('control plane unreachable');
    }
    return this.report;
  }
}

/** Provider in-memory: trả kết quả theo kịch bản test đặt sẵn, ghi lại request đã nhận. */
class FakeProvider implements MailProviderPort {
  result: MailProviderSendResult = {
    kind: 'accepted',
    providerMessageId: 'pm-1',
    warningCode: null,
  };
  throws = false;
  readonly requests: MailProviderSendRequest[] = [];

  async send(request: MailProviderSendRequest): Promise<MailProviderSendResult> {
    this.requests.push(request);
    if (this.throws) {
      throw new Error('adapter bug');
    }
    return this.result;
  }
}

/** Bộ fake + config của một ca test. */
class Harness {
  readonly jobs = new FakeJobs();
  readonly quarantine = new FakeQuarantine();
  readonly gateway = new FakeGateway();
  readonly provider = new FakeProvider();

  deps(): ProcessMailCommandDeps {
    return {
      jobs: this.jobs,
      quarantine: this.quarantine,
      gateway: this.gateway,
      provider: this.provider,
    };
  }

  run(
    rawBody = CANONICAL_COMMAND,
    overrides: Partial<ProcessMailCommandConfig> = {},
  ): Promise<MailCommandOutcome> {
    return processMailCommand(rawBody, 'qmsg-1', this.deps(), config(overrides));
  }
}

let harness: Harness;

beforeEach(() => {
  harness = new Harness();
});

describe('rejected command is quarantined without touching provider or jobs', () => {
  it('quarantines unparseable JSON and never reaches the gateway or the provider', async () => {
    const outcome = await harness.run('{"version": 1, "delivery_id":');

    expect(outcome).toEqual({ kind: 'quarantined', reason: 'unparseable-body' });
    expect(harness.quarantine.upserts).toHaveLength(1);
    expect(harness.quarantine.upserts[0]).toMatchObject({
      queueMessageId: 'qmsg-1',
      reason: 'unparseable-body',
      nowMs: NOW,
    });
    expect(harness.gateway.getDeliveryCalls).toEqual([]);
    expect(harness.provider.requests).toEqual([]);
    expect(harness.jobs.calls).toEqual([]);
  });

  it('stores a digest shaped quarantine_id rather than the raw body', async () => {
    const rawBody = 'not json at all';
    await harness.run(rawBody);

    const [written] = harness.quarantine.upserts;
    expect(written).toBeDefined();
    expect(QUARANTINE_ID_PATTERN.test(written?.quarantineId ?? '')).toBe(true);
    // Raw payload không được xuất hiện ở bất kỳ tham số nào của bản ghi.
    expect(JSON.stringify(written)).not.toContain(rawBody);
  });

  it('quarantines a forbidden field and records only its name', async () => {
    const rawBody = JSON.stringify({
      version: 1,
      delivery_id: DELIVERY_ID,
      api_key: 'khong-duoc-luu',
    });

    const outcome = await harness.run(rawBody);

    expect(outcome).toEqual({ kind: 'quarantined', reason: 'forbidden-field' });
    expect(harness.quarantine.upserts[0]?.fieldName).toBe('api_key');
    // `03-operations.md` §3.1 hàng 5: record chỉ ghi TÊN key, không ghi value.
    expect(JSON.stringify(harness.quarantine.upserts[0])).not.toContain('khong-duoc-luu');
  });

  it('records a worker constant instead of a key the sanitizer rejects', async () => {
    const rawBody = JSON.stringify({ version: 1, delivery_id: DELIVERY_ID, 'a b': 'x' });

    const outcome = await harness.run(rawBody);

    expect(outcome).toEqual({ kind: 'quarantined', reason: 'forbidden-field' });
    // CHECK của schema bắt buộc `field_name IS NOT NULL` cho lý do này, nên phải có tên.
    expect(harness.quarantine.upserts[0]?.fieldName).toBe('unknown');
  });

  it('quarantines an unsupported version', async () => {
    const outcome = await harness.run(JSON.stringify({ version: 2, delivery_id: DELIVERY_ID }));

    expect(outcome).toEqual({ kind: 'quarantined', reason: 'unsupported-version' });
    expect(harness.gateway.getDeliveryCalls).toEqual([]);
  });

  it('quarantines a missing delivery_id as missing-delivery-id', async () => {
    const outcome = await harness.run(JSON.stringify({ version: 1 }));

    expect(outcome).toEqual({ kind: 'quarantined', reason: 'missing-delivery-id' });
    expect(harness.quarantine.upserts[0]?.fieldName).toBe('delivery_id');
  });

  it('quarantines a delivery_id of the wrong type as missing-delivery-id', async () => {
    const outcome = await harness.run(JSON.stringify({ version: 1, delivery_id: 42 }));

    expect(outcome).toEqual({ kind: 'quarantined', reason: 'missing-delivery-id' });
  });

  it('quarantines an empty delivery_id rather than treating it as an id', async () => {
    const outcome = await harness.run(JSON.stringify({ version: 1, delivery_id: '   ' }));

    expect(outcome).toEqual({ kind: 'quarantined', reason: 'missing-delivery-id' });
    expect(harness.gateway.getDeliveryCalls).toEqual([]);
  });

  it('upserts one record when the same bad body is rejected twice', async () => {
    const rawBody = '{"version":1,"delivery_id":"dlv_a","extra":1}';

    await harness.run(rawBody);
    await harness.run(rawBody);

    expect(harness.quarantine.upserts).toHaveLength(2);
    const [first, second] = harness.quarantine.upserts;
    expect(second?.quarantineId).toBe(first?.quarantineId);
    expect(harness.quarantine.rows.size).toBe(1);
  });
});

describe('authority resolution', () => {
  it('acks a delivery that does not exist without creating a job row', async () => {
    harness.gateway.lookup = { kind: 'not-found' };

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.jobs.rows.size).toBe(0);
    expect(harness.jobs.calls).toEqual([]);
    expect(harness.provider.requests).toEqual([]);
  });

  it('acks a not-found delivery that already has a job row without rewriting its report state', async () => {
    harness.gateway.lookup = { kind: 'not-found' };
    harness.jobs.seed(processingRow({ outcomeReportState: 'pending' }));

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    // Không tự ý đổi report state: report sweep là đường duy nhất còn execution lease hợp lệ.
    expect(harness.jobs.row().outcomeReportState).toBe('pending');
    expect(harness.jobs.calls).toEqual([]);
  });

  it('retries an auth-rejected lookup without creating a job row', async () => {
    harness.gateway.lookup = { kind: 'auth-rejected' };

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'retry' });
    // Không tạo row: credential hỏng là điều kiện hệ thống, tạo row sẽ đốt ngân sách B.
    expect(harness.jobs.rows.size).toBe(0);
    expect(harness.jobs.calls).toEqual([]);
  });

  it('retries a contract-rejected lookup without creating a job row', async () => {
    harness.gateway.lookup = { kind: 'contract-rejected' };

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'retry' });
    expect(harness.jobs.rows.size).toBe(0);
  });

  it('retries a transient lookup without creating a job row', async () => {
    harness.gateway.lookup = { kind: 'transient' };

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'retry' });
    expect(harness.jobs.rows.size).toBe(0);
  });

  it('records internal-auth and releases the lease when the lookup is auth-rejected', async () => {
    harness.gateway.lookup = { kind: 'auth-rejected' };
    harness.jobs.seed(
      processingRow({ leaseOwner: OWNER, leaseExpiresAt: NOW + LEASE_MS, executionGeneration: 3 }),
    );

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'retry' });
    const released = harness.jobs.row();
    expect(released.lastErrorClass).toBe('internal-auth');
  });

  it('records the error class on a row whose lease belongs to another invocation', async () => {
    // Đường lookup chạy TRƯỚC claim nên execution này chưa giữ lease nào; row có thể đang
    // giữ lease của một invocation trước. Bằng chứng phải vẫn được ghi (hàng 19 §9.2.2) qua
    // conditional update không đụng lease.
    harness.gateway.lookup = { kind: 'auth-rejected' };
    harness.jobs.seed(
      processingRow({
        leaseOwner: 'owner-invocation-trước',
        leaseExpiresAt: NOW + LEASE_MS,
        executionGeneration: 7,
      }),
    );

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'retry' });
    expect(harness.jobs.calls).toContain('recordLookupError');
    expect(harness.jobs.row().lastErrorClass).toBe('internal-auth');
    // Lease của invocation khác nguyên vẹn — không đụng owner token.
    expect(harness.jobs.row().leaseOwner).toBe('owner-invocation-trước');
  });

  it('records contract as the error class of a contract-rejected lookup', async () => {
    harness.gateway.lookup = { kind: 'contract-rejected' };
    harness.jobs.seed(
      processingRow({ leaseOwner: OWNER, leaseExpiresAt: NOW + LEASE_MS, executionGeneration: 3 }),
    );

    await harness.run();

    expect(harness.jobs.row().lastErrorClass).toBe('contract');
  });

  it('does not overwrite the lease of another execution when the lookup fails', async () => {
    harness.gateway.lookup = { kind: 'auth-rejected' };
    harness.jobs.seed(
      processingRow({
        leaseOwner: 'owner-khác',
        leaseExpiresAt: NOW + LEASE_MS,
        executionGeneration: 7,
      }),
    );

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'retry' });
    // Conditional update không đụng lease: owner token giữ nguyên; lỗi được ghi qua
    // `recordLookupError` (predicate chỉ là trạng thái row) chứ không qua release.
    expect(harness.jobs.row().leaseOwner).toBe('owner-khác');
    expect(harness.jobs.calls).not.toContain('releaseExecutionLease');
    expect(harness.jobs.calls).toContain('recordLookupError');
  });

  it('retries when the gateway throws instead of resolving', async () => {
    harness.gateway.lookupThrows = true;

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'retry' });
    expect(harness.jobs.rows.size).toBe(0);
  });
});

describe('claim paths', () => {
  it('creates the job, claims it and sends on a first-time command', async () => {
    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.jobs.calls).toEqual([
      'createPendingJob',
      'claimSameGeneration',
      'markProviderCallBoundary',
      'persistExecutionResult',
      'acquireReportLease',
      'completeReport',
    ]);
    expect(harness.provider.requests).toHaveLength(1);
    expect(harness.provider.requests[0]?.deliveryId).toBe(DELIVERY_ID);
  });

  it('leaves the job sent with the outcome reported', async () => {
    await harness.run();

    const record = harness.jobs.row();
    expect(record.status).toBe('sent');
    expect(record.outcomeReportState).toBe('reported');
    expect(record.providerMessageId).toBe('pm-1');
    expect(record.attempts).toBe(1);
    expect(record.executionGeneration).toBe(1);
  });

  it('sends the runtime material from the control plane, not from the job row', async () => {
    await harness.run();

    expect(harness.provider.requests[0]).toEqual({
      deliveryId: DELIVERY_ID,
      recipient: 'nguoi-nhan@example.test',
      subject: 'chu-de',
      body: '<p>noi-dung</p>',
      contentType: 'text/html',
      deadlineMs: NOW + PROVIDER_TIMEOUT_MS,
    });
  });

  it('caps the provider deadline at the provider timeout when the lease outlives it', async () => {
    // §9.2.1 đòi `executionLeaseMs > providerTimeoutMs`, nên ở cấu hình vận hành nhánh thắng
    // của `min()` **luôn** là timeout. Test này ghim đúng nhánh đó thay vì suy từ tên.
    await harness.run();

    expect(harness.provider.requests[0]?.deadlineMs).toBe(NOW + PROVIDER_TIMEOUT_MS);
  });

  it('caps the provider deadline at the lease expiry when the lease is the tighter bound', async () => {
    // Biên trái chiều của §9.2.1: lease ngắn hơn timeout. Công thức `min` vẫn phải cắt ở lease
    // — đây là nhánh mà cấu hình vận hành không bao giờ chạm tới, nên phải có test riêng, không
    // thể suy ra từ test của nhánh kia.
    await harness.run(CANONICAL_COMMAND, {
      executionLeaseMs: 1_000,
      providerTimeoutMs: PROVIDER_TIMEOUT_MS,
    });

    expect(harness.provider.requests[0]?.deadlineMs).toBe(NOW + 1_000);
  });

  it('reports the outcome to the control plane with the same generation', async () => {
    await harness.run();

    expect(harness.gateway.reportCalls).toEqual([{ outcome: 'sent', dispatchGeneration: 1 }]);
  });

  it('acks a duplicate command once the job is already sent, without calling the provider', async () => {
    harness.jobs.seed(
      processingRow({ status: 'sent', outcomeReportState: 'reported', executionGeneration: 1 }),
    );

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.provider.requests).toEqual([]);
    expect(harness.jobs.calls).not.toContain('createPendingJob');
  });

  it('acks while another execution holds the lease, without calling the provider', async () => {
    harness.jobs.seed(
      processingRow({
        leaseOwner: 'owner-khác',
        leaseExpiresAt: NOW + LEASE_MS,
        executionGeneration: 4,
        attempts: 1,
      }),
    );

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.provider.requests).toEqual([]);
  });

  it('acks a blocked job of the same generation instead of self-healing it', async () => {
    harness.jobs.seed(
      processingRow({
        status: 'blocked',
        outcomeReportState: 'pending',
        executionGeneration: 2,
        attempts: MAX_ATTEMPTS,
      }),
    );

    const outcome = await harness.run();

    // §9.4: `blocked` cùng generation chỉ được mở bằng redrive có authorize ở control plane.
    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.provider.requests).toEqual([]);
    expect(harness.jobs.row().status).toBe('blocked');
  });

  it('marks the job blocked when the execution budget is exhausted', async () => {
    harness.jobs.seed(processingRow({ attempts: MAX_ATTEMPTS, executionGeneration: 4 }));

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'internal-blocked' });
    const record = harness.jobs.row();
    expect(record.status).toBe('blocked');
    expect(record.lastErrorClass).toBe('execution-budget-exhausted');
    expect(record.blockedAt).toBe(NOW);
    expect(record.outcomeReportState).toBe('pending');
    // §9.2.2 hàng 5: ngân sách kiệt thì KHÔNG gọi provider, và ack chứ không retry.
    expect(harness.provider.requests).toEqual([]);
  });

  it('acks when the budget is exhausted but the job is already blocked', async () => {
    harness.jobs.seed(
      processingRow({ status: 'blocked', attempts: MAX_ATTEMPTS, outcomeReportState: 'pending' }),
    );

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
  });

  it('claims into a new generation and resets the budget when the authority advanced', async () => {
    harness.gateway.lookup = { kind: 'found', delivery: material({ dispatchGeneration: 2 }) };
    harness.jobs.seed(
      processingRow({
        dispatchGeneration: 1,
        status: 'blocked',
        attempts: MAX_ATTEMPTS,
        executionGeneration: 4,
        outcomeReportState: 'pending',
      }),
    );

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.jobs.calls).toContain('claimGenerationAdvance');
    const record = harness.jobs.row();
    expect(record.dispatchGeneration).toBe(2);
    // Đường (b): generation mới ⇒ ngân sách B mới, `attempts = 1`.
    expect(record.attempts).toBe(1);
    expect(record.status).toBe('sent');
    expect(harness.gateway.reportCalls).toEqual([{ outcome: 'sent', dispatchGeneration: 2 }]);
  });

  it('acks a command that arrives after the job already moved to a newer generation', async () => {
    harness.gateway.lookup = { kind: 'found', delivery: material({ dispatchGeneration: 1 }) };
    harness.jobs.seed(processingRow({ dispatchGeneration: 2, executionGeneration: 1 }));

    const outcome = await harness.run();

    // Command không mang generation nên không thể hồi sinh row về generation cũ (§9.4).
    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.provider.requests).toEqual([]);
    expect(harness.jobs.row().dispatchGeneration).toBe(2);
  });

  it('acks a generation-advance that loses to a live lease', async () => {
    harness.gateway.lookup = { kind: 'found', delivery: material({ dispatchGeneration: 2 }) };
    harness.jobs.seed(
      processingRow({
        dispatchGeneration: 1,
        leaseOwner: 'owner-cũ',
        leaseExpiresAt: NOW + LEASE_MS,
        executionGeneration: 5,
      }),
    );

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.provider.requests).toEqual([]);
    expect(harness.jobs.row().dispatchGeneration).toBe(1);
  });

  it('retries when the job row vanishes between create and read-back', async () => {
    // Repository vi phạm hợp đồng (`createPendingJob` báo `created` mà không có row), nhưng
    // orchestration vẫn phải có một hành động để consumer làm.
    const orphaning: ProcessMailCommandDeps = {
      jobs: {
        ...harness.jobs,
        createPendingJob: async () => ({ kind: 'created' as const }),
        loadJobByDeliveryId: async () => null,
      } as unknown as MailJobRepository,
      quarantine: harness.quarantine,
      gateway: harness.gateway,
      provider: harness.provider,
    };

    const outcome = await processMailCommand(CANONICAL_COMMAND, 'qmsg-1', orphaning, config());

    expect(outcome).toEqual({ kind: 'retry' });
  });
});

describe('provider outcomes', () => {
  it('releases the lease and retries on a retryable rejection', async () => {
    harness.provider.result = {
      kind: 'rejected',
      errorClass: 'retryable',
      retryAfterMs: 1_000,
      errorCode: 'http-429',
    };

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'retry' });
    const record = harness.jobs.row();
    expect(record.status).toBe('processing');
    expect(record.leaseOwner).toBeNull();
    expect(record.lastError).toBe('http-429');
    expect(record.lastErrorClass).toBe('retryable');
    // `attempts` tăng ở claim, **không** tăng ở bước persist lỗi (§9.2.2 hàng 6).
    expect(record.attempts).toBe(1);
    expect(harness.gateway.reportCalls).toEqual([]);
  });

  it('persists a permanent rejection as failed and reports it', async () => {
    harness.provider.result = {
      kind: 'rejected',
      errorClass: 'permanent',
      retryAfterMs: null,
      errorCode: 'http-422',
    };

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.jobs.row().status).toBe('failed');
    expect(harness.gateway.reportCalls).toEqual([
      { outcome: 'failed', dispatchGeneration: 1, errorClass: 'permanent' },
    ]);
  });

  it('persists a credential rejection as blocked, which is not a per-message failure', async () => {
    harness.provider.result = {
      kind: 'rejected',
      errorClass: 'credential',
      retryAfterMs: null,
      errorCode: 'http-401',
    };

    const outcome = await harness.run();

    // §9.4: credential fail là điều kiện system-level ⇒ `blocked`, không `failed`, ack.
    expect(outcome).toEqual({ kind: 'ack-processed' });
    const record = harness.jobs.row();
    expect(record.status).toBe('blocked');
    expect(record.blockedAt).toBe(NOW);
    expect(harness.gateway.reportCalls).toEqual([
      { outcome: 'blocked', dispatchGeneration: 1, errorClass: 'credential' },
    ]);
  });

  it('downgrades a throwing provider to a retryable rejection', async () => {
    // Contract của provider port là resolve; throw là bug adapter, và nó không được phép làm
    // hỏng consumer.
    harness.provider.throws = true;

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'retry' });
    expect(harness.provider.requests).toHaveLength(1);
    expect(harness.jobs.row().lastError).toBe('provider-exception');
  });

  it('never calls the provider twice for one command', async () => {
    harness.provider.result = {
      kind: 'rejected',
      errorClass: 'retryable',
      retryAfterMs: null,
      errorCode: 'network',
    };

    await harness.run();

    expect(harness.provider.requests).toHaveLength(1);
  });

  it('stores no provider_message_id when the adapter did not provide one', async () => {
    harness.provider.result = { kind: 'accepted', providerMessageId: null, warningCode: null };

    await harness.run();

    expect(harness.jobs.row().providerMessageId).toBeNull();
  });

  it('treats an empty provider message id as absent', async () => {
    harness.provider.result = { kind: 'accepted', providerMessageId: '   ', warningCode: null };

    await harness.run();

    expect(harness.jobs.row().providerMessageId).toBeNull();
  });

  it('clears the error columns of a previous attempt when the provider accepts', async () => {
    harness.jobs.seed(
      processingRow({ lastError: 'network', lastErrorClass: 'retryable', executionGeneration: 1 }),
    );

    await harness.run();

    const record = harness.jobs.row();
    expect(record.status).toBe('sent');
    expect(record.lastError).toBeNull();
    expect(record.lastErrorClass).toBeNull();
  });
});

describe('outcome reporting', () => {
  it('reports sent in the same call as the persist', async () => {
    await harness.run();

    expect(harness.jobs.calls.indexOf('acquireReportLease')).toBeGreaterThan(
      harness.jobs.calls.indexOf('persistExecutionResult'),
    );
  });

  it('uses a report lease owner distinct from the execution lease owner', async () => {
    await harness.run();

    const reportOwner = harness.jobs.row().reportLeaseOwner;
    expect(reportOwner).toBeNull();
    expect(reportOwnerToken(OWNER)).toBe(`report:${OWNER}`);
    expect(reportOwnerToken(OWNER)).not.toBe(OWNER);
  });

  it('keeps the report pending when the control plane is transient', async () => {
    harness.gateway.report = { kind: 'transient' };

    const outcome = await harness.run();

    // Mail đã được chấp nhận; report sweep sẽ báo nốt phần còn lại.
    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.jobs.calls).toContain('keepReportPending');
    const record = harness.jobs.row();
    expect(record.status).toBe('sent');
    expect(record.outcomeReportState).toBe('pending');
    // Report-lease phải được release để lần sweep sau claim lại được ngay.
    expect(record.reportLeaseOwner).toBeNull();
    expect(record.reportAttempts).toBe(1);
  });

  it('keeps the report pending when the report call throws', async () => {
    harness.gateway.reportThrows = true;

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.jobs.row().outcomeReportState).toBe('pending');
  });

  it('marks the report superseded when the control plane says stale', async () => {
    harness.gateway.report = { kind: 'stale', status: 'queued', currentDispatchGeneration: 2 };

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    // `stale` KHÔNG phải success: HTTP 200 + body stale vẫn là `superseded` (§9.5).
    expect(harness.jobs.row().outcomeReportState).toBe('superseded');
  });

  it('marks the report orphaned when the control plane no longer has the delivery', async () => {
    harness.gateway.report = { kind: 'not-found' };

    await harness.run();

    expect(harness.jobs.row().outcomeReportState).toBe('orphaned');
  });

  it('treats a duplicate report as reported', async () => {
    harness.gateway.report = { kind: 'duplicate', status: 'sent' };

    await harness.run();

    expect(harness.jobs.row().outcomeReportState).toBe('reported');
  });

  it('keeps the report pending on an auth-rejected report without failing the job', async () => {
    harness.gateway.report = { kind: 'auth-rejected' };

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.jobs.row().outcomeReportState).toBe('pending');
    expect(harness.jobs.row().status).toBe('sent');
  });

  it('does not report again while a sweeper holds the report lease', async () => {
    // Mô phỏng một sweeper đã claim report trước khi lần gọi này tới `acquireReportLease`:
    // giữa lúc persist và lúc acquire, một sweeper ghi `report_lease_owner` còn hạn.
    const acquire = harness.jobs.acquireReportLease.bind(harness.jobs);
    harness.jobs.acquireReportLease = async (params) => {
      const current = harness.jobs.rows.get(params.deliveryId);
      if (current !== undefined) {
        harness.jobs.rows.set(
          params.deliveryId,
          processingRow({
            ...current,
            reportLeaseOwner: 'sweeper-1',
            reportLeaseExpiresAt: NOW + REPORT_LEASE_MS,
          }),
        );
      }
      return acquire(params);
    };

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.gateway.reportCalls).toEqual([]);
    // Job đã terminal; việc còn lại là report, và nó phải chờ sweeper — không phải chờ message này.
    expect(harness.jobs.row().status).toBe('sent');
    expect(harness.jobs.row().outcomeReportState).toBe('pending');
    // Còn khoá thì sweep chưa được nhặt; hết hạn thì nhặt được. Đó là đúng vai trò của lease.
    expect(isEligibleForReportSweep(harness.jobs.row(), { nowMs: NOW, maxReportAttempts: 4 })).toBe(
      false,
    );
    expect(
      isEligibleForReportSweep(harness.jobs.row(), {
        nowMs: NOW + REPORT_LEASE_MS + 1,
        maxReportAttempts: 4,
      }),
    ).toBe(true);
  });

  it('sweeps a pending report that this call left behind', async () => {
    harness.gateway.report = { kind: 'transient' };

    await harness.run();

    // Bằng chứng rằng trạng thái còn lại là một việc mà đường sweep thật sự nhặt được.
    expect(isEligibleForReportSweep(harness.jobs.row(), { nowMs: NOW, maxReportAttempts: 4 })).toBe(
      true,
    );
  });
});

/**
 * Bọc fake của `harness` hiện tại bằng `Object.create` thay vì spread, để override đúng một
 * method của `MailJobRepository`.
 *
 * Method của class nằm trên prototype nên `{...fake}` **không** copy chúng — object thu được
 * thiếu hẳn `loadJobByDeliveryId` và mọi method khác, và lỗi đó hiện ra dưới dạng `TypeError`
 * chứ không phải assertion đỏ, dễ dẫn tới sửa nhầm vào production code. `Object.create` giữ
 * nguyên prototype chain (nên vẫn ghi vào `Map` và `calls` của fake), còn override được ghi đè
 * đúng một method.
 *
 * Ghi log `persistExecutionResult` thủ công để `calls` phản ánh đúng những gì orchestration
 * thực sự gọi — nếu không, một lần gọi bị ghi đè sẽ biến mất khỏi trace.
 */
function jobsLosingClaim(
  jobs: FakeJobs,
  persist: (params: PersistExecutionResultParams) => Promise<PersistExecutionResultResult>,
): MailJobRepository {
  const wrapped = Object.create(jobs) as MailJobRepository;
  wrapped.persistExecutionResult = (params) => {
    jobs.calls.push('persistExecutionResult');
    return persist(params);
  };
  return wrapped;
}

/** Dựng deps của một ca test với `jobs` thay thế, còn lại thì dùng chung fake. */
function depsWithJobs(over: Harness, jobs: MailJobRepository): ProcessMailCommandDeps {
  return {
    jobs,
    quarantine: over.quarantine,
    gateway: over.gateway,
    provider: over.provider,
  };
}

/**
 * Bọc fake của một harness bằng `Object.create` (giữ prototype như `jobsLosingClaim`) rồi
 * override `markProviderCallBoundary` — các method khác vẫn ghi vào Map/calls của fake gốc.
 */
function jobsWithBoundaryDenial(
  jobs: FakeJobs,
  reason: 'missing-job' | 'lease-lost' | 'inconsistent',
): MailJobRepository {
  const wrapped = Object.create(jobs) as MailJobRepository;
  wrapped.markProviderCallBoundary = async () => ({
    kind: 'denied',
    reason,
    record: jobs.rows.get(DELIVERY_ID) ?? null,
  });
  return wrapped;
}

/**
 * Seed row chưa claim (lease rỗng, attempts để claim dư budget) — claim sẽ bình thường
 * vào được `executeClaimedDelivery`, nơi `markProviderCallBoundary` bị override.
 */
function seedClaimedRow(jobs: FakeJobs): void {
  jobs.seed(processingRow({ attempts: 0 }));
}

describe('provider call boundary — statement (e)', () => {
  it('never calls the provider when the boundary is denied for a lost claim', async () => {
    // Claim thành công rồi boundary báo denial — nghĩa là mất claim giữa hai bước.
    // Provider KHÔNG được chạm: một lần gọi sau khi mất lease là đường double-send đầu tiên
    // mà fencing phải chặn.
    for (const reason of ['missing-job', 'lease-lost', 'inconsistent'] as const) {
      const fresh = new Harness();
      seedClaimedRow(fresh.jobs);

      const outcome = await processMailCommand(
        CANONICAL_COMMAND,
        'qmsg-1',
        depsWithJobs(fresh, jobsWithBoundaryDenial(fresh.jobs, reason)),
        config(),
      );

      expect(outcome).toEqual({ kind: 'retry' });
      expect(fresh.provider.requests).toEqual([]);
      expect(fresh.gateway.reportCalls).toEqual([]);
    }
  });

  it('proceeds to call the provider once on already-marked — replay across a crash', async () => {
    // `already-marked` không phải mất claim: marker của cùng attempt-chain đã ghi trước
    // (đoạn sau marker crash), caller vẫn được gọi provider — cùng Idempotency-Key nên
    // provider dedupe, và marker giữ nguyên mốc gốc (first-write-only).
    harness.jobs.seed(processingRow({ providerCallAt: NOW - 50 }));

    const outcome = await harness.run();

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.provider.requests).toHaveLength(1);
    // Marker phải giữ nguyên — KHÔNG overwrite mốc cửa sổ mơ hồ.
    expect(harness.jobs.row().providerCallAt).toBe(NOW - 50);
  });
});

describe('lost claim after the provider was already called', () => {
  it('does not send again and retries when nothing else persisted the result', async () => {
    // Mất claim vì một execution khác đã cầm lease, và **chưa** execution nào persist được:
    // row vẫn `processing`, report vẫn `none` ⇒ không có kết luận nào để ack.
    const losing = jobsLosingClaim(harness.jobs, async () => {
      const current = harness.jobs.rows.get(DELIVERY_ID);
      if (current !== undefined) {
        harness.jobs.rows.set(
          DELIVERY_ID,
          processingRow({ ...current, leaseOwner: 'owner-khác', leaseExpiresAt: NOW + LEASE_MS }),
        );
      }
      return { kind: 'denied', reason: 'lease-lost' };
    });

    const outcome = await processMailCommand(
      CANONICAL_COMMAND,
      'qmsg-1',
      depsWithJobs(harness, losing),
      config(),
    );

    expect(outcome).toEqual({ kind: 'retry' });
    // Bằng chứng quan trọng nhất: provider **đã** được gọi đúng một lần, và message này không
    // gọi lần nữa — mọi lần gọi sau đó là Queue redelivery, không phải loop nội bộ.
    expect(harness.provider.requests).toHaveLength(1);
    expect(harness.gateway.reportCalls).toEqual([]);
    expect(harness.jobs.row().outcomeReportState).toBe('none');
  });

  it('acks when another execution already persisted the result', async () => {
    // Cùng tình huống mất claim, nhưng lần này execution khác **đã** persist thành công: row
    // đã terminal và report đã `pending` ⇒ việc của message này xong, report sweep lo nốt.
    const losing = jobsLosingClaim(harness.jobs, async () => {
      const current = harness.jobs.rows.get(DELIVERY_ID);
      if (current !== undefined) {
        harness.jobs.rows.set(
          DELIVERY_ID,
          processingRow({
            ...current,
            status: 'sent',
            leaseOwner: null,
            leaseExpiresAt: null,
            outcomeReportState: 'pending',
          }),
        );
      }
      return { kind: 'denied', reason: 'lease-lost' };
    });

    const outcome = await processMailCommand(
      CANONICAL_COMMAND,
      'qmsg-1',
      depsWithJobs(harness, losing),
      config(),
    );

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.provider.requests).toHaveLength(1);
    // Ack **không** có nghĩa là đã báo outcome: message này không giữ report lease nên không
    // được tự ý báo, và việc đó để lại cho sweeper.
    expect(harness.gateway.reportCalls).toEqual([]);
    expect(harness.jobs.calls).not.toContain('acquireReportLease');
  });

  it('acks when the row moved to a newer generation under it', async () => {
    const losing = jobsLosingClaim(harness.jobs, async () => {
      const current = harness.jobs.rows.get(DELIVERY_ID);
      if (current !== undefined) {
        harness.jobs.rows.set(
          DELIVERY_ID,
          processingRow({ ...current, dispatchGeneration: 2, outcomeReportState: 'none' }),
        );
      }
      return { kind: 'denied', reason: 'lease-lost' };
    });

    const outcome = await processMailCommand(
      CANONICAL_COMMAND,
      'qmsg-1',
      depsWithJobs(harness, losing),
      config(),
    );

    // Generation mới thuộc về authority khác; retry message này sẽ chỉ đi lại đường claim và
    // tự ack, nên trả `retry` ở đây chỉ là một vòng Queue thừa.
    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.provider.requests).toHaveLength(1);
  });

  it('acks when the result is already pending report', async () => {
    // Phần trên của lớp-1 determinism: `outcome_report_state = 'pending'` nghĩa là đã có kết
    // luận bền vững (không nhất thiết terminal — nhưng intent đã được persist). Ack.
    const losing = jobsLosingClaim(harness.jobs, async () => {
      const current = harness.jobs.rows.get(DELIVERY_ID);
      if (current !== undefined) {
        harness.jobs.rows.set(
          DELIVERY_ID,
          processingRow({ ...current, outcomeReportState: 'pending' }),
        );
      }
      return { kind: 'denied', reason: 'lease-lost' };
    });

    const outcome = await processMailCommand(
      CANONICAL_COMMAND,
      'qmsg-1',
      depsWithJobs(harness, losing),
      config(),
    );

    expect(outcome).toEqual({ kind: 'ack-processed' });
    expect(harness.jobs.calls).not.toContain('markProviderAmbiguityBlocked');
  });

  it('retries inside the provider idempotency safety window — no operator block yet', async () => {
    // Auto-resend trong cửa sổ (marker cách đây 100ms, cửa sổ 24h): Queue redelivery với
    // CÙNG Idempotency-Key sẽ replay kết quả provider — KHÔNG tự gọi lại tại đây, KHÔNG
    // block operator bên trong cửa sổ.
    const losing = jobsLosingClaim(harness.jobs, async () => {
      const current = harness.jobs.rows.get(DELIVERY_ID);
      if (current !== undefined) {
        harness.jobs.rows.set(
          DELIVERY_ID,
          processingRow({ ...current, providerCallAt: NOW - 100 }),
        );
      }
      return { kind: 'denied', reason: 'lease-lost' };
    });

    const outcome = await processMailCommand(
      CANONICAL_COMMAND,
      'qmsg-1',
      depsWithJobs(harness, losing),
      config(),
    );

    expect(outcome).toEqual({ kind: 'retry' });
    expect(harness.jobs.calls).not.toContain('markProviderAmbiguityBlocked');
    expect(harness.provider.requests).toHaveLength(1);
  });

  it('marks operator-needed blocked when the ambiguity persists past the safety window', async () => {
    // Marker đã hơn 24h ⇒ không thể tra idempotency key một cách đáng tin cậy; tự gọi lại
    // là double-send tiềm tàng. Dừng redelivery, chốt `blocked` + `provider-ambiguous-outcome`
    // bền vững cho operator (Session 4 redrive có authorize).
    const losing = jobsLosingClaim(harness.jobs, async () => {
      const current = harness.jobs.rows.get(DELIVERY_ID);
      if (current !== undefined) {
        harness.jobs.rows.set(
          DELIVERY_ID,
          processingRow({
            ...current,
            attempts: MAX_ATTEMPTS,
            leaseOwner: null,
            leaseExpiresAt: null,
            providerCallAt: NOW - 24 * 60 * 60 * 1000 - 1,
          }),
        );
      }
      return { kind: 'denied', reason: 'lease-lost' };
    });

    const outcome = await processMailCommand(
      CANONICAL_COMMAND,
      'qmsg-1',
      depsWithJobs(harness, losing),
      config(),
    );

    expect(outcome).toEqual({ kind: 'internal-blocked' });
    expect(harness.jobs.calls).toContain('markProviderAmbiguityBlocked');
    const record = harness.jobs.row();
    expect(record.status).toBe('blocked');
    expect(record.lastErrorClass).toBe(MAIL_JOB_PROVIDER_AMBIGUOUS_ERROR_CLASS);
    expect(record.blockedAt).toBe(NOW);
    expect(record.outcomeReportState).toBe('pending');
    // KHÔNG reset marker khi reddrive tăng `dispatch_generation` — bền vững xuyên re-drive.
    expect(record.providerCallAt).toBe(NOW - 24 * 60 * 60 * 1000 - 1);
  });

  it('acks when the ambiguity block cannot apply because the row already has a conclusion', async () => {
    // Đang ngoài cửa sổ nhưng hàng có kết luận rồi (status='sent' + report pending): block
    // bị denial ⇒ re-read thấy kết luận ⇒ ack, không kéo sent về blocked.
    const losing = jobsLosingClaim(harness.jobs, async () => {
      const current = harness.jobs.rows.get(DELIVERY_ID);
      if (current !== undefined) {
        harness.jobs.rows.set(
          DELIVERY_ID,
          processingRow({
            ...current,
            status: 'sent',
            leaseOwner: null,
            leaseExpiresAt: null,
            outcomeReportState: 'pending',
            providerCallAt: NOW - 24 * 60 * 60 * 1000 - 1,
          }),
        );
      }
      return { kind: 'denied', reason: 'lease-lost' };
    });

    const outcome = await processMailCommand(
      CANONICAL_COMMAND,
      'qmsg-1',
      depsWithJobs(harness, losing),
      config(),
    );

    expect(outcome).toEqual({ kind: 'ack-processed' });
  });
});

describe('already-marked outside the safe window — statement (g) from the executor', () => {
  it('releases its own lease and marks operator-needed instead of resending', async () => {
    // Redelivery claim lại được lease (sau khi lease cũ hết hạn, marker còn) với marker ĐÃ
    // HƠN cửa sổ an toàn. Cũ: nhánh already-marked resend vô điều kiện ⇒ auto-resend ngoài
    // cửa sổ. Mới: fail-closed — release không-kết-quả rồi statement (g) chốt
    // operator-needed; provider KHÔNG được chạm lần hai.
    const fresh = new Harness();
    fresh.jobs.seed(
      processingRow({
        leaseOwner: null,
        leaseExpiresAt: null,
        executionGeneration: 1,
        attempts: 0,
        providerCallAt: NOW - 24 * 60 * 60 * 1000 - 1,
      }),
    );

    const outcome = await processMailCommand(CANONICAL_COMMAND, 'qmsg-1', fresh.deps(), config());

    expect(outcome).toEqual({ kind: 'internal-blocked' });
    expect(fresh.provider.requests).toEqual([]);
    expect(fresh.jobs.calls).toContain('claimSameGeneration');
    expect(fresh.jobs.calls).toContain('releaseExecutionLease');
    expect(fresh.jobs.calls).toContain('markProviderAmbiguityBlocked');
    const record = fresh.jobs.row();
    expect(record.status).toBe('blocked');
    expect(record.lastErrorClass).toBe(MAIL_JOB_PROVIDER_AMBIGUOUS_ERROR_CLASS);
    expect(record.blockedAt).toBe(NOW);
    expect(record.outcomeReportState).toBe('pending');
    expect(record.leaseOwner).toBeNull();
    expect(record.providerCallAt).toBe(NOW - 24 * 60 * 60 * 1000 - 1);
  });

  it('retries when the release is denied because the row changed under it', async () => {
    // Row đổi dưới chân (execution khác đã cầm lease): release denial ⇒ statement (g) cũng
    // denial ⇒ RETRY — không tự quyết trên state cũ.
    const fresh = new Harness();
    fresh.jobs.seed(
      processingRow({
        leaseOwner: null,
        leaseExpiresAt: null,
        executionGeneration: 1,
        providerCallAt: NOW - 24 * 60 * 60 * 1000 - 1,
      }),
    );
    const wrapped = Object.create(fresh.jobs) as MailJobRepository;
    wrapped.releaseExecutionLease = async () => ({
      kind: 'denied',
      reason: 'lease-lost',
    });

    const outcome = await processMailCommand(
      CANONICAL_COMMAND,
      'qmsg-1',
      depsWithJobs(fresh, wrapped),
      config(),
    );

    expect(outcome).toEqual({ kind: 'retry' });
    expect(fresh.provider.requests).toEqual([]);
    expect(fresh.jobs.calls).not.toContain('markProviderAmbiguityBlocked');
    expect(fresh.jobs.row().status).toBe('processing');
  });
});

describe('reportOwnerToken', () => {
  it('prefixes the execution owner so the two leases are distinguishable', () => {
    expect(reportOwnerToken('exec-1')).toBe('report:exec-1');
  });

  it('never exceeds the 128 code point bound of report_lease_owner', () => {
    // `assertLeaseOwner` chặn ở 128; nối prefix vào một owner dài hợp lệ sẽ vi phạm — và lỗi đó
    // chỉ lộ ra khi report lease **thực sự** được acquire.
    const long = 'a'.repeat(128);

    expect([...reportOwnerToken(long)].length).toBeLessThanOrEqual(128);
    expect([...reportOwnerToken(`${long}b`)].length).toBeLessThanOrEqual(128);
  });
});
