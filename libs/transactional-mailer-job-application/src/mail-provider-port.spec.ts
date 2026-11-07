import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  MailProviderPort,
  MailProviderSendRequest,
  MailProviderSendResult,
} from './mail-provider-port';

/**
 * Request hợp lệ theo contract §11.1, dùng làm nền cho các ca âm.
 *
 * Sáu field, không hơn: mọi ca âm dưới đây là `{ ...CANONICAL_REQUEST, field }`
 * để phần thừa là thứ duy nhất khác bản canonical.
 */
const CANONICAL_REQUEST: MailProviderSendRequest = {
  deliveryId: 'delivery-1',
  recipient: 'nguoi-nhan@example.test',
  subject: 'subject-1',
  body: '<p>body-1</p>',
  contentType: 'text/html',
  deadlineMs: 1_800_000_000_000,
};

/** Nền cho ca âm của nhánh `rejected`, đủ bốn field của nhánh đó. */
const REJECTED_RESULT = {
  kind: 'rejected',
  errorClass: 'retryable',
  retryAfterMs: null,
  errorCode: 'http-400',
} as const;

/** Nền cho ca âm của nhánh `accepted`, đủ ba field của nhánh đó. */
const ACCEPTED_RESULT = {
  kind: 'accepted',
  providerMessageId: null,
  warningCode: null,
} as const;

/**
 * Điểm chấm assignability của request contract.
 *
 * Ca âm của bất biến shape là **compile-time**: nội dung thật của chúng nằm ở các
 * directive `@ts-expect-error` phía dưới. Chúng chỉ thực sự được chấm vì
 * `tsconfig.spec.json` là một project trong `tsc --build tsconfig.json` của
 * `nx typecheck` — bỏ reference đó đi thì mọi directive ở file này trở thành
 * comment trang trí mà không có gì đỏ, trong khi `vitest` vẫn xanh vì nó chỉ bỏ
 * type chứ không kiểm.
 */
function probeRequestShape(request: MailProviderSendRequest): string {
  return request.deliveryId;
}

/** Điểm chấm assignability của result contract. Xem {@link probeRequestShape}. */
function probeResultShape(result: MailProviderSendResult): string {
  return result.kind;
}

/**
 * Specifier import của một file trong `src/`, đọc thẳng từ đĩa.
 *
 * Neo theo `import.meta.dirname` (vị trí file spec) chứ không theo `process.cwd()`:
 * `nx test` đặt cwd ở thư mục project còn chạy tay từ gốc workspace lại ở gốc —
 * một đường dẫn tương đối sẽ xanh ở một trong hai chỗ và đỏ ở chỗ kia.
 *
 * Pattern phủ cả bốn dạng khai báo: `import x from '…'` / `import { x } from '…'`
 * (nhánh `from`), `import '…'` không binding (nhánh `import` ở đầu dòng),
 * `import('…')` động, và `require('…')` — cùng cả hai loại quote.
 */
function importSpecifiersOf(fileInSrc: string): readonly string[] {
  const source = readFileSync(join(import.meta.dirname, fileInSrc), 'utf8');

  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|^\s*import\s+)["']([^"']+)["']/gmu,
    ),
  ].map((match) => match[1] ?? '');
}

/**
 * Mọi file source của lib này trong `src/`, **dò từ đĩa** thay vì một danh sách
 * cứng — file source thêm sau này tự động vào phạm vi kiểm.
 */
function sourceFiles(): readonly string[] {
  return readdirSync(import.meta.dirname).filter(
    (name) => !name.includes('.spec.') && /\.(?:ts|mts|cts)$/u.test(name),
  );
}

describe('MailProviderSendRequest — six canonical fields', () => {
  it('carries exactly the six canonical fields', () => {
    // So theo `Set` thay vì mảng đã sort: thứ tự key không phải một phần của
    // contract, còn tập key thì đúng là phần phải ghim.
    expect(new Set(Object.keys(CANONICAL_REQUEST))).toEqual(
      new Set(['deliveryId', 'recipient', 'subject', 'body', 'contentType', 'deadlineMs']),
    );

    // Fixture tự kiểm: một field bị bỏ quên (giá trị `undefined`) vẫn qua được
    // phép so tập key ở trên, nên phải kiểm cả value.
    expect(Object.values(CANONICAL_REQUEST).every((value) => value !== undefined)).toBe(true);
  });

  it('declares exactly the six canonical fields at the type level', () => {
    /**
     * Ca âm "thêm field" ở các `it` dưới chỉ bắt được field lạ trên một object
     * literal; chúng **không** bắt được việc chính type bị mở rộng. Hai kiểm tra
     * dưới đây bắt đúng điều đó:
     *
     * - `RequestKeysExact`: `keyof` phải khớp **cả hai chiều**. Thêm một field
     *   (kể cả optional, kể cả selector field) làm `keyof` lớn hơn ⇒ `false`.
     * - `OptionalRequestKeys`: không field nào được thành optional. Một field
     *   required bị nới thành optional vẫn giữ nguyên `keyof` nên chỉ phép kiểm
     *   này bắt được.
     */
    type CanonicalKeys =
      | 'deliveryId'
      | 'recipient'
      | 'subject'
      | 'body'
      | 'contentType'
      | 'deadlineMs';
    type RequestKeys = keyof MailProviderSendRequest;
    type RequestKeysExact = [RequestKeys] extends [CanonicalKeys]
      ? [CanonicalKeys] extends [RequestKeys]
        ? true
        : false
      : false;
    type OptionalRequestKeys = {
      [K in RequestKeys]-?: undefined extends MailProviderSendRequest[K] ? K : never;
    }[RequestKeys];

    const requestKeysExact: RequestKeysExact = true;
    const noOptionalKeys: OptionalRequestKeys extends never ? true : false = true;

    expect(requestKeysExact).toBe(true);
    expect(noOptionalKeys).toBe(true);
  });

  it('pins contentType to the v1 value', () => {
    /**
     * Ghim **thật** của giá trị v1 nằm ở cặp `@ts-expect-error` trong `it` kế
     * tiếp: nới type thành `string` làm cả hai directive thành "unused"
     * (TS2578) và đỏ ở `nx typecheck` — đã kiểm bằng mutation.
     *
     * Assertion runtime dưới đây chỉ ghi lại literal của chính fixture, nên nó
     * **không** tự phát hiện được thay đổi ở phía type (hai vế là cùng một
     * literal). Đừng đọc nó như một phép ghim type.
     */
    expect(CANONICAL_REQUEST.contentType).toBe('text/html');
  });

  it('rejects fields that the control plane keeps on its own side', () => {
    // @ts-expect-error -- `app` không thuộc request contract (§11.1)
    probeRequestShape({ ...CANONICAL_REQUEST, app: 'ecoma' });
    // @ts-expect-error -- `messageId` là định danh nội bộ của control plane (§11.1)
    probeRequestShape({ ...CANONICAL_REQUEST, messageId: 'message-1' });
    // @ts-expect-error -- `dispatchGeneration` là fencing state của control plane
    probeRequestShape({ ...CANONICAL_REQUEST, dispatchGeneration: 1 });
    // @ts-expect-error -- sender/`from` thuộc trusted config của adapter (§11.1)
    probeRequestShape({ ...CANONICAL_REQUEST, from: 'mailer@example.test' });
    // @ts-expect-error -- endpoint thuộc trusted config, không phải caller-controlled
    probeRequestShape({ ...CANONICAL_REQUEST, endpoint: 'https://relay.test' });
    // @ts-expect-error -- credential không bao giờ đi qua port (§13)
    probeRequestShape({ ...CANONICAL_REQUEST, credential: 'token' });

    // Assertion thật là compile-time; dòng này chỉ để file có ít nhất một assert
    // runtime cho nhánh này thay vì một `it` rỗng.
    expect(CANONICAL_REQUEST.deliveryId).toBe('delivery-1');
  });

  it('rejects a contentType other than the v1 value', () => {
    // @ts-expect-error -- `contentType` v1 là literal `text/html`, không phải string tự do
    probeRequestShape({ ...CANONICAL_REQUEST, contentType: 'text/plain' });
    // @ts-expect-error -- `contentType` v1 là literal `text/html`, không phải string tự do
    probeRequestShape({ ...CANONICAL_REQUEST, contentType: 'application/json' });

    expect(CANONICAL_REQUEST.contentType).toBe('text/html');
  });

  it('rejects a missing field', () => {
    // @ts-expect-error -- `body` là field bắt buộc của request contract
    probeRequestShape({
      deliveryId: 'delivery-1',
      recipient: 'nguoi-nhan@example.test',
      subject: 'subject-1',
      contentType: 'text/html',
      deadlineMs: 1_800_000_000_000,
    });

    expect(Object.keys(CANONICAL_REQUEST)).toHaveLength(6);
  });

  it('rejects a deadlineMs that is not a number', () => {
    // @ts-expect-error -- `deadlineMs` là epoch milliseconds, không phải chuỗi
    probeRequestShape({ ...CANONICAL_REQUEST, deadlineMs: '1800000000000' });
    // @ts-expect-error -- `deadlineMs` là epoch milliseconds, không phải null
    probeRequestShape({ ...CANONICAL_REQUEST, deadlineMs: null });

    expect(typeof CANONICAL_REQUEST.deadlineMs).toBe('number');
  });
});

describe('MailProviderSendResult — union closed at accepted and rejected', () => {
  it('has no branch other than accepted and rejected', () => {
    // @ts-expect-error -- không có nhánh `queued` trong contract (§11.1)
    probeResultShape({ kind: 'queued' });
    // @ts-expect-error -- không có nhánh `sent` trong contract (§11.1)
    probeResultShape({ kind: 'sent' });
    // @ts-expect-error -- không có nhánh `blocked` trong contract (§11.1)
    probeResultShape({ kind: 'blocked' });

    expect(probeResultShape(ACCEPTED_RESULT)).toBe('accepted');
    expect(probeResultShape(REJECTED_RESULT)).toBe('rejected');
  });

  it('accepts only the three canonical error classes', () => {
    // @ts-expect-error -- `contract` là class của command bị từ chối, không phải provider
    probeResultShape({ ...REJECTED_RESULT, errorClass: 'contract' });
    // @ts-expect-error -- `internal-auth` là lỗi authn/authz của chính worker
    probeResultShape({ ...REJECTED_RESULT, errorClass: 'internal-auth' });
    // @ts-expect-error -- `transient` không phải value canonical (`retryable` mới là)
    probeResultShape({ ...REJECTED_RESULT, errorClass: 'transient' });

    expect(probeResultShape({ ...REJECTED_RESULT, errorClass: 'retryable' })).toBe('rejected');
    expect(probeResultShape({ ...REJECTED_RESULT, errorClass: 'permanent' })).toBe('rejected');
    expect(probeResultShape({ ...REJECTED_RESULT, errorClass: 'credential' })).toBe('rejected');
  });

  it('requires every field of the branch it belongs to', () => {
    // @ts-expect-error -- nhánh `accepted` phải mang `warningCode` (nullable, không optional)
    probeResultShape({ kind: 'accepted', providerMessageId: null });
    // @ts-expect-error -- nhánh `rejected` phải mang `errorCode`
    probeResultShape({ kind: 'rejected', errorClass: 'retryable', retryAfterMs: null });
    // @ts-expect-error -- `providerMessageId` là string hoặc null, không phải số
    probeResultShape({ ...ACCEPTED_RESULT, providerMessageId: 7 });
    // @ts-expect-error -- `retryAfterMs` là epoch-ms deltas hoặc null, không phải chuỗi
    probeResultShape({ ...REJECTED_RESULT, retryAfterMs: 'soon' });

    expect(probeResultShape(ACCEPTED_RESULT)).toBe('accepted');
    expect(probeResultShape(REJECTED_RESULT)).toBe('rejected');
  });

  it('closes the discriminant at exactly accepted and rejected', () => {
    /**
     * Thêm một nhánh thứ ba (vd `deferred`) giữ nguyên các ca âm ở trên — chúng
     * chỉ chặn các tên nhánh đã biết — nên phải ghim `kind` cả hai chiều.
     */
    type ResultKinds = MailProviderSendResult['kind'];
    type ResultKindsExact = [ResultKinds] extends ['accepted' | 'rejected']
      ? ['accepted' | 'rejected'] extends [ResultKinds]
        ? true
        : false
      : false;

    const resultKindsExact: ResultKindsExact = true;

    expect(resultKindsExact).toBe(true);
  });

  it('declares exactly the canonical fields on each branch', () => {
    /**
     * Ca âm "thêm field" ở trên chỉ chặn field lạ trên một object literal; chúng
     * **không** bắt được việc chính type của một nhánh bị mở rộng — cùng khoảng
     * trống mà `RequestKeysExact` đã bịt cho request, nhưng chưa từng được bịt
     * cho result. Đã kiểm bằng mutation: thêm `readonly extraJunk?: string` vào
     * một trong hai nhánh chỉ đỏ khi nào có hai phép kiểm dưới đây.
     *
     * - `…KeysExact`: `keyof` của nhánh phải khớp **cả hai chiều**. Thêm một field
     *   (kể cả optional, kể cả một selector) làm `keyof` lớn hơn ⇒ `false`.
     * - `Optional…Keys`: không field nào được thành optional. Một field required
     *   bị nới thành optional giữ nguyên `keyof` nên chỉ phép kiểm này bắt được.
     */
    type AcceptedBranch = Extract<MailProviderSendResult, { kind: 'accepted' }>;
    type RejectedBranch = Extract<MailProviderSendResult, { kind: 'rejected' }>;

    type AcceptedKeys = keyof AcceptedBranch;
    type RejectedKeys = keyof RejectedBranch;

    type AcceptedKeysExact = [AcceptedKeys] extends ['kind' | 'providerMessageId' | 'warningCode']
      ? ['kind' | 'providerMessageId' | 'warningCode'] extends [AcceptedKeys]
        ? true
        : false
      : false;
    type RejectedKeysExact = [RejectedKeys] extends [
      'kind' | 'errorClass' | 'retryAfterMs' | 'errorCode',
    ]
      ? ['kind' | 'errorClass' | 'retryAfterMs' | 'errorCode'] extends [RejectedKeys]
        ? true
        : false
      : false;

    type OptionalAcceptedKeys = {
      [K in AcceptedKeys]-?: undefined extends AcceptedBranch[K] ? K : never;
    }[AcceptedKeys];
    type OptionalRejectedKeys = {
      [K in RejectedKeys]-?: undefined extends RejectedBranch[K] ? K : never;
    }[RejectedKeys];

    const acceptedKeysExact: AcceptedKeysExact = true;
    const rejectedKeysExact: RejectedKeysExact = true;
    const noOptionalAcceptedKeys: OptionalAcceptedKeys extends never ? true : false = true;
    const noOptionalRejectedKeys: OptionalRejectedKeys extends never ? true : false = true;

    expect(acceptedKeysExact).toBe(true);
    expect(rejectedKeysExact).toBe(true);
    expect(noOptionalAcceptedKeys).toBe(true);
    expect(noOptionalRejectedKeys).toBe(true);
  });

  it('accepts a null providerMessageId and a null warningCode', () => {
    expect(probeResultShape({ ...ACCEPTED_RESULT })).toBe('accepted');
    expect(
      probeResultShape({
        kind: 'accepted',
        providerMessageId: 'provider-message-1',
        warningCode: 'malformed-response',
      }),
    ).toBe('accepted');
  });
});

describe('MailProviderPort — the only seam out to a provider', () => {
  it('declares only send', () => {
    /**
     * `Exclude<…>` rỗng ⟺ port không có member nào ngoài `send`. Thêm một member
     * thứ hai vào port làm `PortHasOnlySend` thành `false`, và dòng `= true` dưới
     * đây đỏ ngay ở compile — điều mà một assert runtime không bắt được.
     */
    type PortHasOnlySend = Exclude<keyof MailProviderPort, 'send'> extends never ? true : false;

    const portHasOnlySend: PortHasOnlySend = true;

    expect(portHasOnlySend).toBe(true);
  });

  it('exposes the canonical API through the package root', async () => {
    const packageRoot = await import('./index');

    // Package root từng chỉ có type; J1 thêm đúng danh sách runtime export dưới
    // đây (constants + pure rules mà infrastructure dùng để phân loại affected
    // rows = 0). J2/J3 bổ sung use-case orchestration (processMailCommand,
    // sweeps, quarantine digest). Danh sách được ghim tường minh: giá trị runtime
    // mới lọt vào package root mà không chủ đích sẽ làm test này đỏ.
    expect(Object.keys(packageRoot)).toEqual([
      'MAIL_JOB_STATUS_VALUES',
      'OUTCOME_REPORT_STATE_VALUES',
      'QUARANTINE_REASON_VALUES',
      'MAIL_JOB_PERSISTABLE_STATUS_VALUES',
      'MAIL_JOB_REPORTABLE_STATE_VALUES',
      'MAIL_JOB_BUDGET_EXHAUSTED_ERROR_CLASS',
      'MAIL_JOB_DELIVERY_NOT_FOUND_ERROR_CLASS',
      'MAIL_JOB_PROVIDER_AMBIGUOUS_ERROR_CLASS',
      'MalformedMailJobStateError',
      'MailJobValidationError',
      'sanitizeErrorToken',
      'QUARANTINE_FIELD_NAME_PATTERN',
      'QUARANTINE_FIELD_NAME_MAX_LENGTH',
      'sanitizeFieldName',
      'assertSafeInteger',
      'assertPositiveInteger',
      'assertClosedValue',
      'assertNonEmptyString',
      'assertBoundedString',
      'assertBoundedOptionalString',
      'MAIL_JOB_IDENTIFIER_MAX_LENGTH',
      'assertLeaseOwner',
      'isExecutionLeaseActive',
      'isReportLeaseActive',
      'isTerminalStatus',
      'isMailJobStatus',
      'isOutcomeReportState',
      'classifySameGenerationClaimDenial',
      'classifyGenerationAdvanceDenial',
      'classifyBudgetExhaustedDenial',
      'classifyLeaseOwnershipDenial',
      'classifyAmbiguityBlockedDenial',
      'classifyProviderCallBoundaryDenial',
      'classifyReportLeaseDenial',
      'classifyReportCompletionDenial',
      'dispositionForControlPlaneOutcome',
      'isEligibleForReportSweep',
      'isEligibleForStaleLeaseSweep',
      'isEligibleForBlockedBacklogSweep',
      'canPersistExecutionResultFor',
      'isWithinProviderSafeWindow',
      // §3.1 — quarantine digest
      'QUARANTINE_ID_PATTERN',
      'QUARANTINE_ID_PREFIX',
      'QUARANTINE_UNKNOWN_FIELD_NAME',
      'computeQuarantineId',
      'encodeUtf8',
      'optionalSanitizedFieldName',
      'quarantineReasonFor',
      // §9.2 — queue command orchestration
      'processMailCommand',
      'reportOwnerToken',
      // §9.5 — report sweeps
      'REPORT_SWEEP_ALERT_KINDS',
      'runBlockedBacklogSweep',
      'runReportSweep',
      'runStaleLeaseSweep',
      // (§11.3) — lifecycle event ingest (model trung tính, chu vi of lifecycle path)
      'ingestLifecycleEventMessage',
      'MAIL_LIFECYCLE_EVENT_TYPE_VALUES',
      'MAIL_LIFECYCLE_REASON_TOKEN_VALUES',
      'normalizeLifecycleEventMessage',
    ]);
  });
});

describe('dependency boundary', () => {
  it('keeps the port module free of any import', () => {
    // Port không import gì — kể cả infrastructure, app, Node builtin hay config.
    // Một port không có nguồn import nào thì không thể chạm tới chúng.
    expect(importSpecifiersOf('mail-provider-port.ts')).toEqual([]);
  });

  it('re-exports the package root from the port module only', () => {
    const specifiers = importSpecifiersOf('index.ts');
    expect(specifiers).toContain('./mail-provider-port');
  });

  it('scans every source file in src, not a fixed list', () => {
    /**
     * Hai ca trên chỉ đọc hai tên file cố định, nên một file source thứ ba thêm
     * sau này sẽ nằm ngoài phạm vi kiểm mà không có gì đỏ. Ca này dò **mọi** file
     * `src/*.ts` từ đĩa, nên file mới tự động vào phạm vi.
     *
     * Hợp của các specifier phải đúng bằng `./mail-provider-port`: nguồn duy nhất
     * được phép import là `index.ts` trỏ vào port, còn port phải trắng.
     *
     * Đây là guard đọc source text (lớp bổ trợ). Lớp thực thi là oxlint:
     * `no-restricted-imports`, `import(no-nodejs-modules)` và
     * `@nx/enforce-module-boundaries` trong `.oxlintrc.json`.
     */
    const discovered = sourceFiles();

    expect(discovered.length).toBeGreaterThan(0);
    expect(new Set(discovered.flatMap(importSpecifiersOf))).toEqual(
      new Set([
        './lifecycle-events',
        './mail-job-model',
        './mail-job-repository-port',
        './mail-job-rules',
        './mail-provider-port',
        // Use-case orchestration (§9.2/§9.5/§3.1) — mọi I/O qua port ở trên; contracts chỉ
        // là validateMailSendCommand của command wire (không phải implementation).
        './mail-delivery-gateway',
        './process-mail-command',
        './quarantine-digest',
        './report-sweeps',
        '@ecoma-io/transactional-mail-contracts',
      ]),
    );
  });
});
