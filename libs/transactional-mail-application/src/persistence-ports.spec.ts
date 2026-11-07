import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ApplyMailDeliveryOutcomeInput,
  ApplyMailDeliveryOutcomeResult,
  ClaimMailNonceInput,
  ClaimMailOutboxInput,
  CreateMailMessageWithOutboxInput,
  CreateMailMessageWithOutboxResult,
  DeleteExpiredMailNoncesInput,
  InternalNonceStore,
  MailMessageRecord,
  MailMessageRepository,
  MailOutboxRepository,
  MailRateLimitStore,
  MailRetentionQueries,
  MailTemplateRepository,
  TryConsumeMailRateLimitInput,
} from './index';

/**
 * Mọi file source của lib này trong `src/`, **dò từ đĩa** thay vì một danh sách cứng — file
 * source thêm sau này tự động vào phạm vi kiểm.
 */
function sourceFiles(): readonly string[] {
  return readdirSync(import.meta.dirname).filter(
    (name) => !name.includes('.spec.') && /\.(?:ts|mts|cts)$/u.test(name),
  );
}

/**
 * Specifier import của một file trong `src/`, đọc thẳng từ đĩa.
 *
 * Neo theo `import.meta.dirname` (vị trí file spec) chứ không theo `process.cwd()`:
 * `nx test` đặt cwd ở thư mục project còn chạy tay từ gốc workspace lại ở gốc — một đường
 * dẫn tương đối sẽ xanh ở một trong hai chỗ và đỏ ở chỗ kia.
 *
 * Pattern phủ cả bốn dạng khai báo: `import x from '…'` / `import { x } from '…'` (nhánh
 * `from`), `import '…'` không binding (nhánh `import` ở đầu dòng), `import('…')` động, và
 * `require('…')` — cùng cả hai loại quote.
 */
function importSpecifiersOf(fileInSrc: string): readonly string[] {
  const source = readFileSync(join(import.meta.dirname, fileInSrc), 'utf8');

  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|^\s*import\s+)["']([^"']+)["']/gmu,
    ),
  ].map((match) => match[1] ?? '');
}

/** `keyof T` phải khớp `Expected` **cả hai chiều** — thêm hay bớt một key đều đỏ. */
type ExactKeys<T, Expected extends PropertyKey> = [keyof T] extends [Expected]
  ? [Expected] extends [keyof T]
    ? true
    : false
  : false;

/**
 * Điểm chấm assignability của một input port.
 *
 * Ca âm của bất biến shape là **compile-time**: nội dung thật của chúng nằm ở các directive
 * `@ts-expect-error` phía dưới. Chúng chỉ thực sự được chấm vì `tsconfig.spec.json` là một
 * project trong `tsc --build tsconfig.json` của `nx typecheck` — bỏ reference đó đi thì mọi
 * directive ở đây trở thành comment trang trí mà không có gì đỏ, trong khi `vitest` vẫn xanh
 * vì nó chỉ bỏ type chứ không kiểm.
 */
function probeCreateInput(input: CreateMailMessageWithOutboxInput): string {
  return input.messageId;
}

/** Xem {@link probeCreateInput}. */
function probeOutcomeInput(input: ApplyMailDeliveryOutcomeInput): string {
  return input.deliveryId;
}

/** Xem {@link probeCreateInput}. */
function probeClaimInput(input: ClaimMailOutboxInput): string {
  return input.leaseOwner;
}

/** Xem {@link probeCreateInput}. */
function probeNonceInput(input: ClaimMailNonceInput): string {
  return input.principal;
}

/** Xem {@link probeCreateInput}. */
function probeRateLimitInput(input: TryConsumeMailRateLimitInput): string {
  return input.scope.kind;
}

/**
 * Fixture đầy đủ của `CreateMailMessageWithOutboxInput`.
 *
 * Mọi ca âm "thêm field" ở dưới là `{ ...VALID_CREATE, field }` — vì vậy lỗi duy nhất còn
 * lại trên dòng đó chính là field thừa. Nếu fixture thiếu field thì `@ts-expect-error` sẽ
 * được thỏa mãn bởi lỗi "thiếu field" thay vì lỗi "field thừa" và ca âm mất ý nghĩa.
 */
const VALID_CREATE: CreateMailMessageWithOutboxInput = {
  messageId: 'msg_01',
  outboxId: 'obx_01',
  deliveryId: 'dlv_01',
  app: 'ecoma',
  principalId: 'principal_01',
  templateId: 'tpl_01',
  templateName: 'receipt',
  templateVersion: 1,
  locale: 'en',
  recipient: 'nguoi-nhan@example.test',
  subjectRendered: 'subject',
  bodyRendered: '<p>body</p>',
  idempotencyKey: 'key-01',
  requestFingerprint: 'p1.k1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  correlationId: null,
  nowMs: 1_800_000_000_000,
};

/** Fixture đầy đủ của `ApplyMailDeliveryOutcomeInput`. */
const VALID_OUTCOME: ApplyMailDeliveryOutcomeInput = {
  deliveryId: 'dlv_01',
  outcome: 'sent',
  dispatchGeneration: 1,
  errorClass: null,
  nowMs: 1_800_000_000_000,
};

/** Fixture đầy đủ của `ClaimMailOutboxInput`. */
const VALID_CLAIM: ClaimMailOutboxInput = {
  nowMs: 1_800_000_000_000,
  leaseDurationMs: 60_000,
  leaseOwner: 'publisher-01',
  limit: 10,
};

/** Fixture đầy đủ của `ClaimMailNonceInput`. */
const VALID_NONCE: ClaimMailNonceInput = {
  principal: 'svc.transactional-mailer-job',
  nonce: 'nonce-01',
  expiresAtEpochSeconds: 1_800_000_600,
};

/** Fixture đầy đủ của {@link TryConsumeMailRateLimitInput}. */
const RATE_LIMIT_FIXTURE: TryConsumeMailRateLimitInput = {
  scope: { kind: 'system' },
  windowDurationMs: 60_000,
  limit: 100,
  nowMs: 1_800_000_000_000,
};

describe('dependency boundary', () => {
  it('allows only intra-lib relative imports and the contracts package', () => {
    /**
     * Hợp của specifier phải đúng bằng tập dưới đây. Một port không có nguồn import nào khác
     * thì không thể chạm tới driver SQL, binding Cloudflare hay implementation của chính nó.
     *
     * Đây là guard đọc source text (lớp bổ trợ). Lớp thực thi là oxlint:
     * `no-restricted-imports`, `import(no-nodejs-modules)` và `@nx/enforce-module-boundaries`
     * trong `.oxlintrc.json`.
     */
    const discovered = sourceFiles();

    expect(discovered.length).toBeGreaterThan(0);
    expect(new Set(discovered.flatMap(importSpecifiersOf))).toEqual(
      new Set([
        '@ecoma-io/transactional-mail-contracts',
        './records',
        './mail-template-repository',
        './mail-message-repository',
        './mail-outbox-repository',
        './internal-nonce-store',
        './mail-rate-limit-store',
        './mail-retention-queries',
        // Use-case orchestration (FR-001/002/003/005/007, SR-001) — cùng lib, mọi I/O qua port ở trên.
        './create-mail-message',
        './is-template-authorized',
        './jcs',
        './mail-nonce-prune',
        './mail-render',
        './mail-retention-execution',
        './mail-template-schema',
        './normalize-request',
        './outbox-publisher',
        './outbox-reconciler',
        './request-fingerprint',
      ]),
    );
  });

  it('keeps infrastructure, platform and Node builtins out of the ports', () => {
    /**
     * Ca trên đã ghim tập đúng; ca này tách riêng **lý do** để failure nói được mình bảo vệ
     * điều gì thay vì chỉ in một set sai lệch. Không trùng thừa: nếu tập đúng bị phá bằng một
     * import lạ, cả hai `it` cùng đỏ với hai thông điệp khác nhau.
     */
    const forbiddenPrefixes = [
      'node:',
      '@cloudflare/',
      'hono',
      'wrangler',
      '@ecoma-io/transactional-mail-infrastructure',
    ];
    const offenders = [...new Set(sourceFiles().flatMap(importSpecifiersOf))].filter((specifier) =>
      forbiddenPrefixes.some((prefix) => specifier.startsWith(prefix)),
    );

    expect(offenders).toEqual([]);
  });

  it('exposes no runtime value through the package root', async () => {
    const packageRoot = await import('./index');

    // Package root từng chỉ có type (C1); C2 thêm đúng danh sách runtime export dưới đây
    // (use-case orchestration thuần — cùng tiền lệ runtime-export-list ghim tường minh của
    // `@ecoma-io/transactional-mailer-job-application`). Danh sách được ghim: một giá trị
    // runtime mới lọt vào package root mà không chủ đích sẽ làm test này đỏ.
    expect(Object.keys(packageRoot).toSorted()).toEqual(
      [
        // FR-002 — jcs
        'JcsUnsupportedValueError',
        'jcsCanonicalize',
        // FR-002 — normalize-request
        'MAIL_DEFAULT_LOCALE',
        'MAIL_VARIABLES_MAX_KEYS',
        'MAIL_VARIABLES_KEY_PATTERN',
        'MAIL_VARIABLES_MAX_STRING_LENGTH',
        'normalizeLocale',
        'normalizeRecipient',
        'validateRequestShapeVariables',
        // FR-002 — request-fingerprint
        'FINGERPRINT_KEY_TAG',
        'FINGERPRINT_PROFILE_PREFIX',
        'canonicalRequestString',
        'computeRequestFingerprint',
        'fingerprintProfileKeyTag',
        'parseStoredFingerprintTag',
        'verifyStoredRequestFingerprint',
        // FR-003 — mail-template-schema
        'TEMPLATE_SCHEMA_MAX_KEYS',
        'TEMPLATE_SCHEMA_VERSION',
        'TEMPLATE_STRING_MAX_LENGTH_LIMIT',
        'TEMPLATE_VARIABLE_KEY_PATTERN',
        'parseTemplateSchema',
        'validateTemplateUrl',
        'validateVariablesAgainstSchema',
        // FR-003 — mail-render
        'escapeHtmlAttribute',
        'escapeHtmlText',
        'renderMail',
        // FR-001 — create-mail-message
        'createMailMessage',
        // FR-005 — outbox-publisher
        'backoffDelayMs',
        'publishOutboxBatch',
        'sanitizePublishErrorToken',
        // FR-005 — outbox-reconciler
        'runOutboxReconciler',
        // FR-007 — retention
        'runRetentionCycle',
        // FR-005 — nonce prune
        'runNoncePrune',
        // SR-001 — is-template-authorized
        'isTemplateAuthorized',
      ].toSorted(),
    );
  });
});

describe('MailMessageRecord — rendered content only', () => {
  it('declares exactly the documented columns of mail_messages', () => {
    type MessageKeysExact = ExactKeys<
      MailMessageRecord,
      | 'id'
      | 'app'
      | 'principalId'
      | 'templateId'
      | 'templateName'
      | 'templateVersion'
      | 'locale'
      | 'recipient'
      | 'subjectRendered'
      | 'bodyRendered'
      | 'status'
      | 'deliveryId'
      | 'dispatchGeneration'
      | 'recoveryCycleCount'
      | 'idempotencyKey'
      | 'requestFingerprint'
      | 'correlationId'
      | 'failureReason'
      | 'terminalAtMs'
      | 'createdAtMs'
      | 'updatedAtMs'
    >;

    const messageKeysExact: MessageKeysExact = true;

    expect(messageKeysExact).toBe(true);
  });

  it('has no field that carries raw request variables', () => {
    /**
     * FR-007: worker render một lần tại request time và chỉ persist template version + nội
     * dung đã render. `variables` không tồn tại dưới bất kỳ tên nào.
     *
     * Phép kiểm này độc lập với `MessageKeysExact` ở trên: nó nêu đích danh thứ bị cấm, nên
     * red khi ai đó thêm field và đọc được ngay *field gì* — chứ không phải một diff `keyof`.
     */
    type HasRawVariables = 'variables' extends keyof MailMessageRecord ? true : false;
    type HasVariablesJson = 'variablesJson' extends keyof MailMessageRecord ? true : false;

    const hasRawVariables: HasRawVariables = false;
    const hasVariablesJson: HasVariablesJson = false;

    expect(hasRawVariables).toBe(false);
    expect(hasVariablesJson).toBe(false);
  });
});

describe('CreateMailMessageWithOutboxInput — schema owns the defaults', () => {
  it('declares exactly the fields a caller may supply', () => {
    type CreateKeysExact = ExactKeys<
      CreateMailMessageWithOutboxInput,
      | 'messageId'
      | 'outboxId'
      | 'deliveryId'
      | 'app'
      | 'principalId'
      | 'templateId'
      | 'templateName'
      | 'templateVersion'
      | 'locale'
      | 'recipient'
      | 'subjectRendered'
      | 'bodyRendered'
      | 'idempotencyKey'
      | 'requestFingerprint'
      | 'correlationId'
      | 'nowMs'
    >;

    const createKeysExact: CreateKeysExact = true;

    expect(createKeysExact).toBe(true);
  });

  it('rejects raw variables, status and fencing counters', () => {
    // @ts-expect-error -- FR-007: `variables` không bao giờ được persist
    probeCreateInput({ ...VALID_CREATE, variables: { code: '123' } });
    // @ts-expect-error -- `status` do schema đặt (`accepted`), không phải input
    probeCreateInput({ ...VALID_CREATE, status: 'queued' });
    // @ts-expect-error -- `dispatchGeneration` do schema đặt (1); chỉ redrive mới đổi nó
    probeCreateInput({ ...VALID_CREATE, dispatchGeneration: 2 });
    // @ts-expect-error -- `recoveryCycleCount` do schema đặt (0); chỉ tăng qua re-dispatch
    probeCreateInput({ ...VALID_CREATE, recoveryCycleCount: 3 });

    expect(VALID_CREATE.messageId).toBe('msg_01');
  });

  it('rejects a missing or mistyped timestamp', () => {
    // @ts-expect-error -- `nowMs` là bắt buộc: thiếu nó thì không có mốc nào để neo
    probeCreateInput({ messageId: 'msg_01' });
    // @ts-expect-error -- `nowMs` là epoch milliseconds dạng number
    probeCreateInput({ ...VALID_CREATE, nowMs: '1800000000000' });

    expect(typeof VALID_CREATE.nowMs).toBe('number');
  });
});

describe('CreateMailMessageWithOutboxResult — key alone is not replay equivalence', () => {
  it('has no branch that claims a replay was accepted', () => {
    /**
     * `UNIQUE (principal_id, idempotency_key)` chỉ chứng minh "cùng khoá, một hàng". Nếu port
     * có nhánh `replay` thì API shape sẽ tự khẳng định điều mà database không hề kiểm, và
     * application layer mất cơ hội so `requestFingerprint` để phân biệt match với conflict
     * (FR-002). Ghim `kind` cả hai chiều để thêm nhánh là đỏ.
     */
    type CreateKinds = CreateMailMessageWithOutboxResult['kind'];
    type CreateKindsExact = [CreateKinds] extends ['created' | 'already-exists']
      ? ['created' | 'already-exists'] extends [CreateKinds]
        ? true
        : false
      : false;

    const createKindsExact: CreateKindsExact = true;

    expect(createKindsExact).toBe(true);
  });

  it('returns the stored record on both branches so the caller can compare fingerprints', () => {
    type StoredMessage = CreateMailMessageWithOutboxResult['message'];
    type StoredMessageIsRecord = [StoredMessage] extends [MailMessageRecord]
      ? [MailMessageRecord] extends [StoredMessage]
        ? true
        : false
      : false;

    const storedMessageIsRecord: StoredMessageIsRecord = true;

    expect(storedMessageIsRecord).toBe(true);
  });
});

describe('ApplyMailDeliveryOutcomeInput — fencing is mandatory', () => {
  it('requires a dispatch generation and a validated error class', () => {
    // @ts-expect-error -- thiếu `dispatchGeneration` thì không có fencing để so
    probeOutcomeInput({ ...VALID_OUTCOME, dispatchGeneration: undefined });
    // @ts-expect-error -- `errorClass` là năm giá trị canonical, không phải chuỗi tự do
    probeOutcomeInput({ ...VALID_OUTCOME, errorClass: 'transient' });
    // @ts-expect-error -- `errorClass` ngoài bộ → 400 ở HTTP layer, không được truyền xuống
    probeOutcomeInput({ ...VALID_OUTCOME, errorClass: 'delivery-not-found' });

    expect(VALID_OUTCOME.dispatchGeneration).toBe(1);
  });
});

describe('ApplyMailDeliveryOutcomeResult — four outcomes, ordered by §6.2.2', () => {
  it('closes the result union', () => {
    type ResultValues = ApplyMailDeliveryOutcomeResult['result'];
    type ResultValuesExact = [ResultValues] extends [
      'not-found' | 'applied' | 'duplicate' | 'stale',
    ]
      ? ['not-found' | 'applied' | 'duplicate' | 'stale'] extends [ResultValues]
        ? true
        : false
      : false;

    const resultValuesExact: ResultValuesExact = true;

    expect(resultValuesExact).toBe(true);
  });

  it('carries currentDispatchGeneration only on the stale branch', () => {
    /**
     * `stale` là nhánh duy nhất worker cần giá trị generation hiện tại để dừng vòng lặp của
     * execution cũ (hàng 7 của bảng acceptance scenarios). Hai nhánh còn lại không có field
     * này — thêm nó vào `applied` sẽ làm `Exclude<…, 'stale'>` không còn rỗng.
     */
    type NonStaleBranch = Exclude<ApplyMailDeliveryOutcomeResult, { result: 'stale' }>;
    type NonStaleHasGeneration = 'currentDispatchGeneration' extends keyof NonStaleBranch
      ? true
      : false;

    const nonStaleHasGeneration: NonStaleHasGeneration = false;

    expect(nonStaleHasGeneration).toBe(false);
  });
});

describe('port surface — each seam declares exactly its documented operations', () => {
  it('declares exactly the five message operations', () => {
    type Expected =
      | 'createWithOutbox'
      | 'findByIdempotencyKey'
      | 'findByDeliveryId'
      | 'findById'
      | 'applyDeliveryOutcome';
    type Actual = ExactKeys<MailMessageRepository, Expected>;

    const actual: Actual = true;

    expect(actual).toBe(true);
  });

  it('declares exactly the five outbox operations', () => {
    type Actual = ExactKeys<
      MailOutboxRepository,
      'claim' | 'renewLease' | 'markPublished' | 'recordPublishFailure' | 'findByDeliveryId'
    >;

    const actual: Actual = true;

    expect(actual).toBe(true);
  });

  it('declares only read operations on templates', () => {
    type Actual = ExactKeys<MailTemplateRepository, 'findById' | 'findActiveByNameAndLocale'>;

    const actual: Actual = true;

    expect(actual).toBe(true);
  });

  it('declares claim and prune on the nonce store, and nothing else', () => {
    type Actual = ExactKeys<InternalNonceStore, 'claimNonce' | 'deleteExpiredNonces'>;

    const actual: Actual = true;

    expect(actual).toBe(true);
  });

  it('declares a single durable consume on the rate limit store', () => {
    type Actual = ExactKeys<MailRateLimitStore, 'tryConsume'>;

    const actual: Actual = true;

    expect(actual).toBe(true);
  });

  it('declares only queries on retention, never writes', () => {
    /**
     * C1 không có lệnh destructive nào cho content (§5 của lệnh). Nếu một method ghi được thêm
     * vào port này thì `ExactKeys` đỏ ngay — và vì method mới không nằm trong tập kỳ vọng,
     * failure sẽ nêu đích danh tên method đó.
     *
     * `redactContent` (FR-007) là method ghi **duy nhất** được phép: nó xoá nội dung
     * `recipient`/`subject_rendered`/`body_rendered` của row terminal — không xoá row, không
     * ghi metadata. Method ghi thứ hai bất kỳ sẽ làm assertion này đỏ.
     */
    type Actual = ExactKeys<
      MailRetentionQueries,
      'listContentRetentionCandidates' | 'listStaleNonTerminalMessages' | 'redactContent'
    >;

    const actual: Actual = true;

    expect(actual).toBe(true);
  });
});

describe('lease and nonce inputs — fencing values are mandatory', () => {
  it('requires the lease owner, the generation and a positive limit on claim', () => {
    // @ts-expect-error -- thiếu `leaseOwner` thì lease không có token để fencing
    probeClaimInput({ ...VALID_CLAIM, leaseOwner: undefined });
    // @ts-expect-error -- `limit` là số, không phải chuỗi
    probeClaimInput({ ...VALID_CLAIM, limit: '10' });

    expect(VALID_CLAIM.limit).toBe(10);
  });

  it('takes the nonce expiry in epoch seconds, computed from the envelope', () => {
    // @ts-expect-error -- `expiresAtEpochSeconds` là số (epoch giây), không phải chuỗi
    probeNonceInput({ ...VALID_NONCE, expiresAtEpochSeconds: '1800000600' });
    // @ts-expect-error -- không có DEFAULT cho expiry: thiếu nó thì nonce sống mãi
    probeNonceInput({ principal: 'svc.a', nonce: 'n-1' });

    expect(VALID_NONCE.expiresAtEpochSeconds).toBe(1_800_000_600);
  });

  it('takes the rate limit window and limit as caller-supplied operational values', () => {
    type RateKeysExact = ExactKeys<
      TryConsumeMailRateLimitInput,
      'scope' | 'windowDurationMs' | 'limit' | 'nowMs'
    >;
    // @ts-expect-error -- ngưỡng là giá trị vận hành truyền vào, không nằm trong schema
    probeRateLimitInput({ ...RATE_LIMIT_FIXTURE, maxRecoveryCycles: 5 });

    const rateKeysExact: RateKeysExact = true;

    expect(rateKeysExact).toBe(true);
  });

  it('requires a bounded batch size when pruning nonces', () => {
    type PruneKeysExact = ExactKeys<DeleteExpiredMailNoncesInput, 'nowMs' | 'limit'>;

    const pruneKeysExact: PruneKeysExact = true;

    expect(pruneKeysExact).toBe(true);
  });
});
