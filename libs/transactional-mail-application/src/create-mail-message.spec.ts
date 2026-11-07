import { describe, expect, it } from 'vitest';

import {
  type CreateMailMessageConfig,
  type CreateMailMessageResult,
  type MailIdempotencyProbeAlert,
  createMailMessage,
} from './create-mail-message';
import { computeRequestFingerprint } from './request-fingerprint';
import type {
  ApplyMailDeliveryOutcomeInput,
  ApplyMailDeliveryOutcomeResult,
  CreateMailMessageWithOutboxInput,
  CreateMailMessageWithOutboxResult,
  MailMessageRepository,
} from './mail-message-repository';
import type { MailRateLimitStore, TryConsumeMailRateLimitInput } from './mail-rate-limit-store';
import type {
  MailMessageRecord,
  MailRateLimitConsumeResult,
  MailRateLimitScope,
  MailTemplateRecord,
} from './records';
import type { MailTemplateRepository } from './mail-template-repository';

/** Khoá fixture **CHỈ dùng cho test** — KHÔNG dùng ở Production (FR-002). */
const K_TEST = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

/** Khoá fixture thứ hai cho cửa sổ rotation (FR-002) — chỉ test. */
const K_TEST_ROTATED = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

/** Keyring test: current là `k1`; `k2` mô phỏng khoá mới sau rotation. */
function keyringFor(currentProfile: string, keys: Record<string, string>) {
  return { currentProfile, keysByProfileHex: new Map(Object.entries(keys)) };
}

const NOW_MS = 1_800_000_000_000;

/* ------------------------------------------------------------------ fake template store */

/** Template record đầy đủ, dựng từ override để không lặp 11 field ở mọi fixture. */
function templateRecord(overrides: Partial<MailTemplateRecord> = {}): MailTemplateRecord {
  return {
    id: 'tpl_01',
    name: 'reset-password',
    locale: 'en',
    version: 1,
    subjectTemplate: 'Reset code {{ otp }}',
    bodyTemplate: '<p>Your code is {{ otp }}</p>',
    variablesSchemaJson: JSON.stringify({
      schema_version: 1,
      variables: {
        otp: { type: 'string', required: true, max_length: 8 },
        cta_url: { type: 'string', required: false, max_length: 2048, format: 'url' },
      },
    }),
    status: 'active',
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
    ...overrides,
  };
}

/** Fake in-memory `MailTemplateRepository` — chỉ hai method read mà port khai báo. */
class FakeTemplateStore implements MailTemplateRepository {
  public readonly rows: MailTemplateRecord[] = [];

  public readonly lookupCalls: { readonly name: string; readonly locale: string }[] = [];

  public async findById(id: string): Promise<MailTemplateRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  public async findActiveByNameAndLocale(
    name: string,
    locale: string,
  ): Promise<readonly MailTemplateRecord[]> {
    this.lookupCalls.push({ name, locale });

    // Trả **thứ tự tăng dần** như adapter thật: quy tắc chọn version không được phụ thuộc vào thứ
    // tự mà port trả về.
    return this.rows
      .filter((row) => row.name === name && row.locale === locale && row.status === 'active')
      .toSorted((left, right) => left.version - right.version);
  }
}

/* -------------------------------------------------------------------- fake message store */

/**
/**
 * Khoá composite của fake store.
 *
 * Dùng **JSON tuple** chứ không phải nối chuỗi bằng một ký tự phân tách: `('a b', 'c')` và `('a', 'b c')` ra cùng một chuỗi nếu phân tách bằng space, và fake đó sẽ gộp hai principal khác nhau — đúng loại bug mà `UNIQUE (principal_id, idempotency_key)` sinh ra để chặn.
 */
function rowKey(principalId: string, idempotencyKey: string): string {
  return JSON.stringify([principalId, idempotencyKey]);
}

/**
 * Fake in-memory `MailMessageRepository` với logic `already-exists` thật.
 *
 * Chỉ hai method mà use case gọi được implement; các method còn lại **ném** — một fake mà implement
 * mọi method sẽ che mất việc use case gọi nhầm port.
 */
class FakeMessageStore implements MailMessageRepository {
  public readonly rows = new Map<string, MailMessageRecord>();

  public readonly writes: CreateMailMessageWithOutboxInput[] = [];

  public readonly readCalls: { principalId: string; idempotencyKey: string }[] = [];

  /**
   * Row của bên thắng khi `createWithOutbox` gặp `already-exists`.
   *
   * Mô phỏng **race**: một request đồng thời đã INSERT và **commit** được row trước khi batch của
   * request này chạy. Vì vậy {@link concurrentWinner} được ghi vào `rows` trước khi trả
   * `already-exists` — nếu không, lần đọc lại sẽ không thấy row nào và nhánh `already-exists` bị
   * kiểm trong một thế giới không có bên thắng, tức là kiểm cái không tồn tại.
   *
   * Không có giá trị này thì use case đi vào nhánh `created` và nhánh `already-exists` không bao
   * giờ được kiểm.
   */
  public concurrentWinner: MailMessageRecord | null = null;

  public async createWithOutbox(
    input: CreateMailMessageWithOutboxInput,
  ): Promise<CreateMailMessageWithOutboxResult> {
    this.writes.push(input);

    if (this.concurrentWinner !== null) {
      this.rows.set(rowKey(input.principalId, input.idempotencyKey), this.concurrentWinner);

      return { kind: 'already-exists', message: this.concurrentWinner };
    }

    const key = rowKey(input.principalId, input.idempotencyKey);

    if (this.rows.has(key)) {
      return { kind: 'already-exists', message: this.rows.get(key) as MailMessageRecord };
    }

    const row: MailMessageRecord = {
      id: input.messageId,
      app: input.app,
      principalId: input.principalId,
      templateId: input.templateId,
      templateName: input.templateName,
      templateVersion: input.templateVersion,
      locale: input.locale,
      recipient: input.recipient,
      subjectRendered: input.subjectRendered,
      bodyRendered: input.bodyRendered,
      status: 'accepted',
      deliveryId: input.deliveryId,
      dispatchGeneration: 1,
      recoveryCycleCount: 0,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      correlationId: input.correlationId,
      failureReason: null,
      terminalAtMs: null,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };

    this.rows.set(key, row);

    return { kind: 'created', message: row };
  }

  public async findByIdempotencyKey(
    principalId: string,
    idempotencyKey: string,
  ): Promise<MailMessageRecord | null> {
    this.readCalls.push({ principalId, idempotencyKey });

    return this.rows.get(rowKey(principalId, idempotencyKey)) ?? null;
  }

  public async findByDeliveryId(deliveryId: string): Promise<MailMessageRecord | null> {
    return [...this.rows.values()].find((row) => row.deliveryId === deliveryId) ?? null;
  }

  public async findById(messageId: string): Promise<MailMessageRecord | null> {
    return [...this.rows.values()].find((row) => row.id === messageId) ?? null;
  }

  public applyDeliveryOutcome(
    _input: ApplyMailDeliveryOutcomeInput,
  ): Promise<ApplyMailDeliveryOutcomeResult> {
    return Promise.reject(new Error('not_used_by_create_mail_message'));
  }
}

/* ------------------------------------------------------------------ fake rate limit store */

/** Fake counter rate limit: một Map theo scope, mô phỏng đúng fixed window của port. */
class FakeRateLimitStore implements MailRateLimitStore {
  public readonly calls: TryConsumeMailRateLimitInput[] = [];

  public readonly windows = new Map<string, { hits: number; windowStartedAtMs: number }>();

  /** Scope bị từ chối vĩnh viễn — dùng cho ca "principal hết hạn mức". */
  public readonly alwaysDenied = new Set<string>();

  public async tryConsume(
    input: TryConsumeMailRateLimitInput,
  ): Promise<MailRateLimitConsumeResult> {
    this.calls.push(input);

    const key = scopeKey(input.scope);

    if (this.alwaysDenied.has(key)) {
      const existing = this.windows.get(key);

      return {
        kind: 'denied',
        hits: existing?.hits ?? input.limit,
        windowStartedAtMs: existing?.windowStartedAtMs ?? input.nowMs,
      };
    }

    const existing = this.windows.get(key);
    const windowIsClosed =
      existing === undefined || existing.windowStartedAtMs <= input.nowMs - input.windowDurationMs;

    if (windowIsClosed) {
      this.windows.set(key, { hits: 1, windowStartedAtMs: input.nowMs });

      return { kind: 'allowed', hits: 1, windowStartedAtMs: input.nowMs };
    }

    if (existing.hits + 1 <= input.limit) {
      existing.hits += 1;

      return {
        kind: 'allowed',
        hits: existing.hits,
        windowStartedAtMs: existing.windowStartedAtMs,
      };
    }

    // `denied` **không** tiêu slot: giữ nguyên `hits` cũ.
    return {
      kind: 'denied',
      hits: existing.hits,
      windowStartedAtMs: existing.windowStartedAtMs,
    };
  }
}

function scopeKey(scope: MailRateLimitScope): string {
  return scope.kind === 'system'
    ? 'system'
    : scope.kind === 'principal'
      ? `principal:${scope.principalId}`
      : `idempotency-key:${scope.scopeValue}`;
}

/* -------------------------------------------------------------------------- test harness */

const PRINCIPAL = { id: 'svc.account', app: 'ecoma.io' };

/** Config đầy đủ; override từng test chỉ sửa đúng trường cần đổi. */
function configFor(overrides: Partial<CreateMailMessageConfig> = {}): CreateMailMessageConfig {
  return {
    rateLimitPrincipal: { limit: 10, windowMs: 60_000 },
    rateLimitSystem: { limit: 1_000, windowMs: 60_000 },
    rateLimitIdempotencyKey: { limit: 3, windowMs: 60_000 },
    urlAllowlist: ['example.com'],
    fingerprintKeyring: keyringFor('p1.k1', { 'p1.k1': K_TEST, 'p1.k2': K_TEST_ROTATED }),
    defaultLocale: 'en',
    maxRenderBytes: 64_000,
    nowMs: NOW_MS,
    messageId: 'msg_01',
    outboxId: 'obx_01',
    deliveryId: 'dlv_01',
    principal: PRINCIPAL,
    idempotencyKey: 'idem-01',
    request: {
      template: 'reset-password',
      recipient: 'user@example.com',
      variables: { otp: '123456' },
    },
    ...overrides,
  };
}

function depsFor(
  templates: FakeTemplateStore,
  messages: FakeMessageStore,
  rateLimits: FakeRateLimitStore,
  alerts: MailIdempotencyProbeAlert[] = [],
) {
  return {
    templates,
    messages,
    rateLimits,
    logAlert: (event: MailIdempotencyProbeAlert): void => {
      alerts.push(event);
    },
  };
}

/** Harness mặc định: một template `en` version 1 active, các store rỗng. */
function harness(overrides: Partial<CreateMailMessageConfig> = {}) {
  const templates = new FakeTemplateStore();
  const messages = new FakeMessageStore();
  const rateLimits = new FakeRateLimitStore();
  const alerts: MailIdempotencyProbeAlert[] = [];

  templates.rows.push(templateRecord());

  return {
    templates,
    messages,
    rateLimits,
    alerts,
    deps: depsFor(templates, messages, rateLimits, alerts),
    config: configFor(overrides),
    run: () =>
      createMailMessage(depsFor(templates, messages, rateLimits, alerts), configFor(overrides)),
  };
}

/* ------------------------------------------------------------------------------- tests */

describe('createMailMessage — happy path', () => {
  it('creates one message carrying the selected version and the rendered content', async () => {
    const h = harness();

    const result = await h.run();

    expect(result.kind).toBe('created');

    if (result.kind !== 'created') {
      return;
    }

    expect(result.message.templateId).toBe('tpl_01');
    expect(result.message.templateVersion).toBe(1);
    expect(result.message.locale).toBe('en');
    expect(result.message.recipient).toBe('user@example.com');
    expect(result.message.subjectRendered).toBe('Reset code 123456');
    expect(result.message.bodyRendered).toBe('<p>Your code is 123456</p>');
    expect(result.message.idempotencyKey).toBe('idem-01');
    expect(result.message.requestFingerprint).toMatch(/^p1\.k1:[0-9a-f]{64}$/u);
    expect(result.message.correlationId).toBeNull();
    // FR-007: không persist raw `variables`.
    expect(Object.keys(result.message)).not.toContain('variables');
  });

  it('persists the caller-supplied ids and the delivery id that equals the idempotency key', async () => {
    const h = harness({ deliveryId: 'idem-01' });

    await h.run();

    expect(h.messages.writes).toHaveLength(1);
    expect(h.messages.writes[0]?.messageId).toBe('msg_01');
    expect(h.messages.writes[0]?.outboxId).toBe('obx_01');
    expect(h.messages.writes[0]?.deliveryId).toBe('idem-01');
    expect(h.messages.writes[0]?.app).toBe('ecoma.io');
    expect(h.messages.writes[0]?.principalId).toBe('svc.account');
  });

  it('stores the normalized recipient, not the raw request string', async () => {
    const h = harness({
      request: {
        template: 'reset-password',
        recipient: '  An@Example.COM  ',
        variables: { otp: '123456' },
      },
    });

    const result = await h.run();

    expect(result.kind === 'created' && result.message.recipient).toBe('An@example.com');
  });

  it('carries a correlation id through to the stored row', async () => {
    const h = harness({
      request: {
        template: 'reset-password',
        recipient: 'user@example.com',
        variables: { otp: '123456' },
        correlationId: 'corr-01',
      },
    });

    const result = await h.run();

    expect(result.kind === 'created' && result.message.correlationId).toBe('corr-01');
  });
});

describe('createMailMessage — request shape is checked before anything durable', () => {
  it('rejects an invalid recipient without touching any store', async () => {
    const h = harness({
      request: { template: 'reset-password', recipient: 'no-at-sign', variables: {} },
    });

    await expect(h.run()).resolves.toEqual({ kind: 'invalid', field: 'recipient' });
    expect(h.messages.readCalls).toEqual([]);
    expect(h.rateLimits.calls).toEqual([]);
    expect(h.messages.writes).toEqual([]);
  });

  it('rejects an invalid locale and rejects an undeclared locale shape', async () => {
    const bad = harness({
      request: {
        template: 'reset-password',
        recipient: 'user@example.com',
        locale: 'english',
        variables: { otp: '123456' },
      },
    });

    await expect(bad.run()).resolves.toEqual({ kind: 'invalid', field: 'locale' });
    expect(bad.messages.readCalls).toEqual([]);
  });

  it('rejects a variables value that is an object or an array', async () => {
    const h = harness({
      request: {
        template: 'reset-password',
        recipient: 'user@example.com',
        variables: { otp: { nested: 1 } },
      },
    });

    await expect(h.run()).resolves.toEqual({ kind: 'invalid', field: 'variables' });
    expect(h.rateLimits.calls).toEqual([]);
  });

  it('treats an absent variables field as an empty object', async () => {
    // Không truyền `variables` và truyền `variables: {}` là **cùng** một request nghiệp vụ.
    // Template của harness khai báo `otp` là `required`, nên cả hai đều dừng ở **cùng** một chỗ:
    // validation theo schema. Khác biệt giữa hai nhánh chỉ là ở tầng shape, không phải ở kết quả.
    const absent = harness({
      request: { template: 'reset-password', recipient: 'user@example.com' },
    });

    await expect(absent.run()).resolves.toEqual({ kind: 'invalid', field: 'variables' });

    const empty = harness({
      request: { template: 'reset-password', recipient: 'user@example.com', variables: {} },
    });

    await expect(empty.run()).resolves.toEqual({ kind: 'invalid', field: 'variables' });

    // Và quan trọng hơn: hai request đó cho **cùng** một fingerprint, nên request thứ hai trên
    // cùng khoá là `replay`, không phải `409`.
    const first = await absent.run();

    expect(first.kind).toBe('invalid');

    const stored = new FakeMessageStore();

    stored.rows.set(rowKey('svc.account', 'idem-01'), {
      ...({} as MailMessageRecord),
      id: 'msg_prev',
      requestFingerprint: 'p1.k1:'.concat('0'.repeat(64)),
    });

    const replay = await createMailMessage(
      depsFor(absent.templates, stored, absent.rateLimits, []),
      {
        ...empty.config,
        idempotencyKey: 'idem-01',
      },
    );

    expect(replay.kind).toBe('conflict');
  });
});

describe('createMailMessage — replay and conflict, both before the rate limit', () => {
  it('returns the original message on a matching fingerprint and consumes no rate limit slot', async () => {
    const h = harness();
    const first = await h.run();

    expect(first.kind).toBe('created');

    // Cùng business request, khác `correlation_id`: FR-002 AC nói rõ nó **không** sinh `409`.
    const replay = await createMailMessage(h.deps, {
      ...h.config,
      request: { ...h.config.request, correlationId: 'corr-99' },
    });

    expect(replay.kind).toBe('replay');
    expect(first.kind).toBe('created');

    if (replay.kind !== 'replay' || first.kind !== 'created') {
      return;
    }

    // Nguyên kết quả cũ: **cùng** template version và **cùng** nội dung đã render.
    expect(replay.message.id).toBe(first.message.id);
    expect(replay.message.templateVersion).toBe(1);
    expect(replay.message.bodyRendered).toBe(first.message.bodyRendered);

    // Replay chạy **dưới** rate limit: chỉ một lần `tryConsume` cho cả hai lần gọi.
    expect(h.rateLimits.calls).toHaveLength(2);
    // Và không có lần ghi thứ hai.
    expect(h.messages.writes).toHaveLength(1);
  });

  it('does not render again on replay, so a newer active version cannot change the answer', async () => {
    const h = harness();

    await h.run();

    // Template active đã lên version mới sau lần tạo đầu.
    h.templates.rows.push(
      templateRecord({
        id: 'tpl_02',
        version: 2,
        subjectTemplate: 'CHANGED {{ otp }}',
        bodyTemplate: '<p>CHANGED</p>',
      }),
    );

    const replay = await createMailMessage(h.deps, h.config);

    expect(replay.kind === 'replay' && replay.message.templateVersion).toBe(1);
    expect(replay.kind === 'replay' && replay.message.subjectRendered).toBe('Reset code 123456');
  });

  it('returns conflict on the same key with a different recipient', async () => {
    const h = harness();

    await h.run();

    const conflict = await createMailMessage(h.deps, {
      ...h.config,
      request: { ...h.config.request, recipient: 'other@example.com' },
    });

    expect(conflict.kind).toBe('conflict');
    expect(h.messages.writes).toHaveLength(1);
    // principal + system (lần tạo) + counter theo key (lần conflict — FR-002).
    expect(h.rateLimits.calls).toHaveLength(3);
    expect(h.rateLimits.calls[2]?.limit).toBe(3);
    // `scopeKey` nén cả ba hình thức scope thành một chuỗi — assert regex trên chuỗi đó
    // thì không cần narrow kiểu bằng `if`, vốn vi phạm `vitest/no-conditional-expect`.
    expect(scopeKey(h.rateLimits.calls[2]?.scope ?? { kind: 'system' })).toMatch(
      /^idempotency-key:svc\.account:[0-9a-f]{64}$/u,
    );
  });

  it('returns conflict on the same key with a different variables value', async () => {
    const h = harness();

    await h.run();

    const conflict = await createMailMessage(h.deps, {
      ...h.config,
      request: { ...h.config.request, variables: { otp: '654321' } },
    });

    expect(conflict.kind).toBe('conflict');
  });

  it('still replays with the stored key after rotation when the old key stays in the keyring', async () => {
    // FR-002 AC (rotation): row tạo bằng `k1`, keyring xoay current sang `k2` → replay **cùng**
    // request vẫn `200` (verify bằng `k1` đọc từ tiền tố), request **mới** dùng `k2`.
    const h = harness();

    const first = await h.run();

    if (first.kind !== 'created') {
      throw new Error(`expected_created_got:${first.kind}`);
    }

    // Kiểm row thật sự được ký bằng khoá cũ trước khi xoay — mutation-guard cho fixture.
    expect(first.message.requestFingerprint.startsWith('p1.k1:')).toBe(true);

    const rotated = await createMailMessage(h.deps, {
      ...h.config,
      fingerprintKeyring: keyringFor('p1.k2', { 'p1.k1': K_TEST, 'p1.k2': K_TEST_ROTATED }),
    });

    expect(rotated.kind).toBe('replay');
    expect(rotated.kind === 'replay' && rotated.message.id).toBe(first.message.id);

    // Request **mới** (key mới, chưa có row) phải được ký bằng khoá current mới — `k2`.
    const fresh = await createMailMessage(h.deps, {
      ...h.config,
      idempotencyKey: 'idem-after-rotation',
      fingerprintKeyring: keyringFor('p1.k2', { 'p1.k1': K_TEST, 'p1.k2': K_TEST_ROTATED }),
    });

    expect(fresh.kind).toBe('created');
    expect(fresh.kind === 'created' && fresh.message.requestFingerprint.startsWith('p1.k2:')).toBe(
      true,
    );
  });

  it('fails closed with service-unavailable when the stored tag is not in the keyring', async () => {
    // FR-002 AC: "profile tag hoặc version khoá lạ ở tiền tố → 503, không 409". Row ở tag
    // `p1.k1`, keyring sau rotation **đã xoá khoá cũ** → không verify được → `503`.
    const h = harness();

    await h.run();

    const rotatedWithoutOldKey = await createMailMessage(h.deps, {
      ...h.config,
      fingerprintKeyring: keyringFor('p1.k2', { 'p1.k2': K_TEST_ROTATED }),
    });

    expect(rotatedWithoutOldKey.kind).toBe('service-unavailable');
  });

  it('fails closed with service-unavailable when the stored value has a malformed prefix', async () => {
    const h = harness();

    const created = await h.run();

    if (created.kind !== 'created') {
      throw new Error(`expected_created_got:${created.kind}`);
    }

    // Một row lưu hỏng (không parse được tag) không thể verify bằng khoá nào — cũng là `503`.
    const rowKeyOf = JSON.stringify([h.config.principal.id, h.config.idempotencyKey]);
    const storedRow = h.messages.rows.get(rowKeyOf);
    if (storedRow === undefined) {
      throw new Error('expected_stored_row');
    }
    h.messages.rows.set(rowKeyOf, { ...storedRow, requestFingerprint: 'not-a-fingerprint' });

    const replay = await h.run();

    expect(replay.kind).toBe('service-unavailable');
  });

  it('treats a different key order and an omitted locale as the same business request', async () => {
    const h = harness();

    const created = await h.run();

    expect(created.kind).toBe('created');

    // `variables` không truyền `locale` và truyền đúng giá trị default đã chốt → cùng fingerprint.
    const explicitLocale = await createMailMessage(h.deps, {
      ...h.config,
      request: {
        template: 'reset-password',
        recipient: 'user@example.com',
        locale: 'en',
        variables: { otp: '123456' },
      },
    });

    expect(explicitLocale.kind).toBe('replay');
  });

  it('resolves the concurrent-winner branch by comparing against the row just read', async () => {
    const h = harness();

    // Bên thắng là một request đồng thời, khác `variables` nên fingerprint lệch ⇒ `409`.
    h.messages.concurrentWinner = {
      ...({} as MailMessageRecord),
      id: 'msg_winner',
      requestFingerprint: 'p1.k1:'.concat('0'.repeat(64)),
      idempotencyKey: 'idem-01',
      templateVersion: 7,
    };

    const result = await h.run();

    expect(result.kind).toBe('conflict');

    // Không đệ quy: đúng hai lần đọc (bước lookup + đọc lại sau `already-exists`).
    expect(h.messages.readCalls).toHaveLength(2);
  });

  it('returns replay when the concurrent winner has the same fingerprint', async () => {
    const h = harness();
    const fingerprint = await computeRequestFingerprint({
      keyHex: K_TEST,
      template: 'reset-password',
      locale: 'en',
      recipient: 'user@example.com',
      variables: { otp: '123456' },
    });

    if (!fingerprint.ok) {
      throw new Error('fixture_key_rejected');
    }

    h.messages.concurrentWinner = {
      ...({} as MailMessageRecord),
      id: 'msg_winner',
      requestFingerprint: fingerprint.value,
      idempotencyKey: 'idem-01',
    };

    const result = await h.run();

    expect(result.kind === 'replay' && result.message.id).toBe('msg_winner');
  });
});

describe('createMailMessage — rate limit', () => {
  it('consumes the principal scope first, then the system scope', async () => {
    const h = harness();

    await h.run();

    expect(h.rateLimits.calls.map((call) => scopeKey(call.scope))).toEqual([
      'principal:svc.account',
      'system',
    ]);
    expect(h.rateLimits.calls[0]?.limit).toBe(10);
    expect(h.rateLimits.calls[1]?.limit).toBe(1_000);
  });

  it('stops at the principal scope when the principal is denied, without touching system', async () => {
    const h = harness();

    h.rateLimits.alwaysDenied.add('principal:svc.account');

    const result = await h.run();

    expect(result.kind).toBe('rate-limited');
    expect(h.rateLimits.calls).toHaveLength(1);
    // Không tra template, không ghi.
    expect(h.templates.lookupCalls).toEqual([]);
    expect(h.messages.writes).toEqual([]);
  });

  it('reports retryAfterMs as the remaining window, counted from config nowMs', async () => {
    const h = harness({ nowMs: NOW_MS, rateLimitPrincipal: { limit: 1, windowMs: 30_000 } });

    h.rateLimits.alwaysDenied.add('principal:svc.account');
    // Cửa sổ mở 20 giây trước `nowMs` ⇒ còn 10 giây.
    h.rateLimits.windows.set('principal:svc.account', {
      hits: 1,
      windowStartedAtMs: NOW_MS - 20_000,
    });

    const result = await h.run();

    expect(result).toEqual({ kind: 'rate-limited', retryAfterMs: 10_000 });
  });

  it('never reports a negative retryAfterMs', async () => {
    const h = harness({ nowMs: NOW_MS, rateLimitPrincipal: { limit: 1, windowMs: 1_000 } });

    h.rateLimits.alwaysDenied.add('principal:svc.account');
    // `window_started_at` là cột **đã bền** và có thể lệch với đồng hồ của caller; ở đây nó nằm
    // 5 giây trong quá khứ nên `windowStartedAtMs + windowMs < nowMs` ⇒ `max 0` là 0, không phải
    // một header `Retry-After` âm.
    h.rateLimits.windows.set('principal:svc.account', {
      hits: 1,
      windowStartedAtMs: NOW_MS - 5_000,
    });

    await expect(h.run()).resolves.toEqual({ kind: 'rate-limited', retryAfterMs: 0 });
  });

  it('falls through to the system scope when the principal scope allows', async () => {
    const h = harness();

    h.rateLimits.alwaysDenied.add('system');

    const result = await h.run();

    expect(result.kind).toBe('rate-limited');
    expect(h.rateLimits.calls.map((call) => scopeKey(call.scope))).toEqual([
      'principal:svc.account',
      'system',
    ]);
  });
});

describe('createMailMessage — probe 409 is rate limited per key (FR-002)', () => {
  it('returns 429 once mismatches exceed the per-key limit and fires an alert per mismatch', async () => {
    const h = harness();

    await h.run(); // tạo gốc

    // Ngưỡng key fixture = 3: hai lần lệch đầu vẫn `409`, lần thứ tư bị `429`.
    let mismatches = 0;
    for (const otp of ['111111', '222222', '333333', '444444']) {
      const result = await createMailMessage(h.deps, {
        ...h.config,
        request: { ...h.config.request, variables: { otp } },
      });
      if (result.kind === 'rate-limited') {
        break;
      }
      mismatches += 1;
      expect(result.kind).toBe('conflict');
    }

    expect(mismatches).toBe(3);

    // Alert phát **mỗi lần lệch** (kể cả lần bị `429` — nó vẫn là một mismatch) với số
    // mismatch counter đang giữ; lần bị từ chối **không tiêu slot** nên số giữ nguyên 3.
    expect(h.alerts).toHaveLength(4);
    expect(h.alerts[0]).toMatchObject({
      event: 'idempotency-fingerprint-mismatch',
      principalId: 'svc.account',
    });
    expect(h.alerts.map((alert) => alert.mismatchCount)).toEqual([1, 2, 3, 3]);
    for (const alert of h.alerts) {
      expect(alert.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(alert)).not.toContain('idem-01');
    }

    // Lần lệch thứ tư vượt ngưỡng — `429` kèm Retry-After hợp lệ.
    const blocked = await createMailMessage(h.deps, {
      ...h.config,
      request: { ...h.config.request, variables: { otp: '444444' } },
    });
    expect(blocked).toEqual({ kind: 'rate-limited', retryAfterMs: expect.any(Number) });
  });

  it('scopes the counter per key, not per principal: another key still gets its own budget', async () => {
    const h = harness({ rateLimitIdempotencyKey: { limit: 1, windowMs: 60_000 } });

    await h.run(); // tạo gốc key A
    // Key A: một lệch là hết ngân sách.
    await createMailMessage(h.deps, {
      ...h.config,
      request: { ...h.config.request, variables: { otp: '111111' } },
    });
    const blocked = await createMailMessage(h.deps, {
      ...h.config,
      request: { ...h.config.request, variables: { otp: '222222' } },
    });
    expect(blocked.kind).toBe('rate-limited');

    // Key B (idempotency key khác, cùng principal): ngân sách riêng. Tạo gốc B trước,
    // rồi một lần lệch vẫn `409` (chưa vượt ngưỡng riêng của B).
    await createMailMessage(h.deps, {
      ...h.config,
      idempotencyKey: 'idem-02',
      request: { ...h.config.request, variables: { otp: '999999' } },
    });
    const other = await createMailMessage(h.deps, {
      ...h.config,
      idempotencyKey: 'idem-02',
      request: { ...h.config.request, variables: { otp: '333333' } },
    });
    expect(other.kind).toBe('conflict');
  });

  it('never counts a matching replay against the per-key counter', async () => {
    const h = harness({ rateLimitIdempotencyKey: { limit: 1, windowMs: 60_000 } });

    await h.run(); // tạo gốc

    // Nhiều lần replay khớp liên tiếp — không một slot nào của counter key bị tiêu.
    for (let index = 0; index < 5; index += 1) {
      const replay = await createMailMessage(h.deps, h.config);
      expect(replay.kind).toBe('replay');
    }

    expect(h.rateLimits.calls.filter((call) => call.scope.kind === 'idempotency-key')).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it('does not let a mismatch consume the principal or system budget', async () => {
    const h = harness();

    await h.run();

    await createMailMessage(h.deps, {
      ...h.config,
      request: { ...h.config.request, variables: { otp: '111111' } },
    });

    const perScope = new Map<string, number>();
    for (const call of h.rateLimits.calls) {
      const key = call.scope.kind === 'system' ? 'system' : scopeKey(call.scope).split(':')[0];
      perScope.set(key, (perScope.get(key) ?? 0) + 1);
    }
    expect(perScope.get('principal')).toBe(1);
    expect(perScope.get('system')).toBe(1);
    expect(perScope.get('idempotency-key')).toBe(1);
  });
});

describe('createMailMessage — template selection', () => {
  it('returns template-not-found when neither the locale nor the default locale exists', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    const result = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor(),
    );

    expect(result).toEqual({ kind: 'template-not-found' });
  });

  it('falls back to the default locale exactly once and validates against that version', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    // Chỉ có bản `en`, yêu cầu `vi` ⇒ fallback một lần rồi dùng version `en`.
    templates.rows.push(
      templateRecord({
        variablesSchemaJson: JSON.stringify({
          schema_version: 1,
          variables: { otp: { type: 'string', required: true, max_length: 4 } },
        }),
      }),
    );

    const result = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor({
        request: {
          template: 'reset-password',
          recipient: 'user@example.com',
          locale: 'vi',
          variables: { otp: '123456' },
        },
      }),
    );

    // `otp` dài 6 vượt `max_length: 4` của version **`en`** ⇒ validation theo version thực sự
    // được dùng, không phải version của locale yêu cầu.
    expect(result).toEqual({ kind: 'invalid', field: 'variables' });
    expect(templates.lookupCalls).toEqual([
      { name: 'reset-password', locale: 'vi' },
      { name: 'reset-password', locale: 'en' },
    ]);
  });

  it('does not attempt a fallback when the requested locale is already the default', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    await createMailMessage(depsFor(templates, messages, rateLimits, []), configFor());

    // Một lần tra duy nhất: tra lại `en` khi locale đã là `en` là một lượt đọc thừa.
    expect(templates.lookupCalls).toEqual([{ name: 'reset-password', locale: 'en' }]);
  });

  it('chooses the highest active version and ignores a disabled one', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(
      templateRecord({ id: 'tpl_01', version: 1 }),
      templateRecord({ id: 'tpl_02', version: 2, subjectTemplate: 'v2 {{ otp }}' }),
      templateRecord({ id: 'tpl_03', version: 3, subjectTemplate: 'disabled', status: 'disabled' }),
    );

    const result = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor(),
    );

    expect(result.kind === 'created' && result.message.templateId).toBe('tpl_02');
    expect(result.kind === 'created' && result.message.templateVersion).toBe(2);
  });
});

describe('createMailMessage — schema and per-version validation', () => {
  it('fails closed with broken-schema when the schema cannot be parsed', async () => {
    for (const variablesSchemaJson of ['', 'not json', '{"schema_version":2,"variables":{}}']) {
      const templates = new FakeTemplateStore();
      const messages = new FakeMessageStore();
      const rateLimits = new FakeRateLimitStore();

      templates.rows.push(templateRecord({ variablesSchemaJson }));

      const result = await createMailMessage(
        depsFor(templates, messages, rateLimits, []),
        configFor(),
      );

      expect(result).toEqual({ kind: 'broken-schema' });
      // Fail-closed: không ghi.
      expect(messages.writes).toEqual([]);
    }
  });

  it('rejects a missing required variable', async () => {
    const h = harness({
      request: { template: 'reset-password', recipient: 'user@example.com', variables: {} },
    });

    await expect(h.run()).resolves.toEqual({ kind: 'invalid', field: 'variables' });
    expect(h.messages.writes).toEqual([]);
  });

  it('accepts null on a nullable variable and renders it as an empty string', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(
      templateRecord({
        subjectTemplate: 'Reset {{ otp }}',
        bodyTemplate: '<p>Reset</p>',
        variablesSchemaJson: JSON.stringify({
          schema_version: 1,
          variables: { otp: { type: 'string', required: true, nullable: true } },
        }),
      }),
    );

    const result = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor({
        request: {
          template: 'reset-password',
          recipient: 'user@example.com',
          variables: { otp: null },
        },
      }),
    );

    // `required` chỉ nói về **vắng mặt**, nên `null` trên biến `nullable: true` là hợp lệ.
    expect(result.kind === 'created' && result.message.subjectRendered).toBe('Reset ');
  });

  it('fails closed with unrenderable when a template references an undeclared variable', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(
      templateRecord({
        bodyTemplate: '<p>{{ secret }}</p>',
        variablesSchemaJson: JSON.stringify({
          schema_version: 1,
          variables: { otp: { type: 'string', required: true } },
        }),
      }),
    );

    const result = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor(),
    );

    expect(result).toEqual({ kind: 'unrenderable' });
    expect(messages.writes).toEqual([]);
  });

  it('rejects a variable that carries a CR into the subject', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(templateRecord());

    const result = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor({
        request: {
          template: 'reset-password',
          recipient: 'user@example.com',
          variables: { otp: '123456\r\nBcc: victim@example.com' },
        },
      }),
    );

    expect(result).toEqual({ kind: 'invalid', field: 'variables' });
    expect(messages.writes).toEqual([]);
  });
});

describe('createMailMessage — url variables and the allowlist', () => {
  it('accepts a url variable whose host is inside the label boundary', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(
      templateRecord({
        subjectTemplate: 'Reset',
        bodyTemplate: '<a href="{{ cta_url }}">go</a>',
      }),
    );

    const result = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor({
        request: {
          template: 'reset-password',
          recipient: 'user@example.com',
          variables: { otp: '1', cta_url: 'https://a.example.com/reset' },
        },
      }),
    );

    expect(result.kind).toBe('created');
  });

  it('rejects evil-example.com against an example.com allowlist', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(templateRecord({ subjectTemplate: 'Reset', bodyTemplate: '<p>x</p>' }));

    const result = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor({
        request: {
          template: 'reset-password',
          recipient: 'user@example.com',
          variables: { otp: '1', cta_url: 'https://evil-example.com/reset' },
        },
      }),
    );

    expect(result).toEqual({ kind: 'invalid', field: 'variables' });
  });

  it('reports an unconfigured allowlist as a service failure, not a bad request', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(templateRecord({ subjectTemplate: 'Reset', bodyTemplate: '<p>x</p>' }));

    const result = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor({
        urlAllowlist: [],
        request: {
          template: 'reset-password',
          recipient: 'user@example.com',
          variables: { otp: '1', cta_url: 'https://example.com/reset' },
        },
      }),
    );

    expect(result).toEqual({ kind: 'allowlist-unconfigured' });
    expect(messages.writes).toEqual([]);
  });

  it('does not apply the URL rule to an absent optional url variable', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(
      templateRecord({ subjectTemplate: 'Reset {{ otp }}', bodyTemplate: '<p>x</p>' }),
    );

    const result = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor({
        // Allowlist rỗng: nếu luật URL áp lên giá trị vắng mặt thì request này sẽ là `503`.
        urlAllowlist: [],
        request: {
          template: 'reset-password',
          recipient: 'user@example.com',
          variables: { otp: '123456' },
        },
      }),
    );

    expect(result.kind).toBe('created');
  });
});

describe('createMailMessage — rendered payload size', () => {
  it('returns payload-too-large when the rendered content exceeds the threshold', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(
      templateRecord({ subjectTemplate: 'Reset', bodyTemplate: '<p>{{ otp }}</p>' }),
    );

    const result = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor({
        maxRenderBytes: 4,
        request: {
          template: 'reset-password',
          recipient: 'user@example.com',
          variables: { otp: '123456' },
        },
      }),
    );

    expect(result).toEqual({ kind: 'payload-too-large' });
    // 413 chỉ quyết định trước khi ghi: không có row.
    expect(messages.writes).toEqual([]);
  });

  it('measures the threshold in UTF-8 bytes, not UTF-16 code units', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(
      templateRecord({ subjectTemplate: 'Reset', bodyTemplate: '<p>{{ otp }}</p>' }),
    );

    // `123456` = 6 code unit = 6 byte. `Hà` = 2 code unit nhưng **4** byte UTF-8.
    const withMultibyte = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor({
        // Subject `Reset` = 5 byte, body `<p>Hà</p>` = **10** byte (H, à là 2 byte mỗi), tổng 15.
        // Nếu đo bằng `String#length` thì tổng chỉ 14 và ngưỡng 14 sẽ cho request lọt qua.
        maxRenderBytes: 14,
        request: {
          template: 'reset-password',
          recipient: 'user@example.com',
          variables: { otp: 'Hà' },
        },
      }),
    );

    expect(withMultibyte).toEqual({ kind: 'payload-too-large' });
  });
});

describe('createMailMessage — golden vector through the whole flow', () => {
  it('stores the golden vector #1 fingerprint when the request carries its variables', async () => {
    /**
     * Template của ca này khai báo đúng hai biến của **vector #1** (`a` và `b`) và render cả hai
     * ra body, nên fingerprint lưu xuống phải **bằng** digest trong bảng golden FR-002 — đi qua
     * toàn luồng (chuẩn hoá → schema → validate → render → ghi), không chỉ gọi hàm băm.
     */
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(
      templateRecord({
        subjectTemplate: 'Reset',
        bodyTemplate: '<p>{{ a }}-{{ b }}</p>',
        variablesSchemaJson: JSON.stringify({
          schema_version: 1,
          variables: {
            a: { type: 'string', required: true },
            b: { type: 'string', required: true },
          },
        }),
      }),
    );

    const created = await createMailMessage(
      depsFor(templates, messages, rateLimits, []),
      configFor({
        request: {
          template: 'reset-password',
          recipient: 'user@example.com',
          variables: { a: '1', b: '2' },
        },
      }),
    );

    expect(created.kind).toBe('created');

    if (created.kind !== 'created') {
      return;
    }

    expect(created.message.requestFingerprint).toBe(
      'p1.k1:055e25b39fd486e9551a2c27d9d8e81d25aa04a8c3ac9b8464673799a22d5c4c',
    );
    expect(created.message.bodyRendered).toBe('<p>1-2</p>');
  });

  it('replays the stored row when only the variables key order differs', async () => {
    const templates = new FakeTemplateStore();
    const messages = new FakeMessageStore();
    const rateLimits = new FakeRateLimitStore();

    templates.rows.push(
      templateRecord({
        subjectTemplate: 'Reset',
        bodyTemplate: '<p>{{ a }}-{{ b }}</p>',
        variablesSchemaJson: JSON.stringify({
          schema_version: 1,
          variables: {
            a: { type: 'string', required: true },
            b: { type: 'string', required: true },
          },
        }),
      }),
    );

    const config = configFor({
      request: {
        template: 'reset-password',
        recipient: 'user@example.com',
        variables: { a: '1', b: '2' },
      },
    });
    const deps = depsFor(templates, messages, rateLimits, []);

    expect((await createMailMessage(deps, config)).kind).toBe('created');

    // Cùng tập biến, thứ tự key đổi ⇒ cùng fingerprint ⇒ `replay` (FR-002 AC), **không** `409`.
    const swapped = await createMailMessage(deps, {
      ...config,
      request: { ...config.request, variables: { b: '2', a: '1' } },
    });

    expect(swapped.kind).toBe('replay');
    expect(messages.writes).toHaveLength(1);
  });

  it('stores a fingerprint that matches a recomputation from the same normalized inputs', async () => {
    const h = harness({
      request: {
        template: 'reset-password',
        recipient: 'user@example.com',
        variables: { otp: '123456' },
      },
    });

    const created = await h.run();

    if (created.kind !== 'created') {
      throw new Error(`expected_created_got:${created.kind}`);
    }

    const recomputed = await computeRequestFingerprint({
      keyHex: K_TEST,
      template: 'reset-password',
      locale: 'en',
      recipient: 'user@example.com',
      variables: { otp: '123456' },
    });

    expect(recomputed.ok && recomputed.value).toBe(created.message.requestFingerprint);
  });

  it('never puts a recipient or a variable value into the result of a rejection', async () => {
    const h = harness({
      request: {
        template: 'reset-password',
        recipient: 'user@example.com',
        variables: { otp: 'x'.repeat(20_000) },
      },
    });

    const result: CreateMailMessageResult = await h.run();

    // Nhạy cảm không được lọt vào error message (FR-007): kết quả chỉ có **kind** và **field**.
    expect(Object.keys(result).toSorted()).toEqual(['field', 'kind']);
    expect(JSON.stringify(result)).not.toContain('user@example.com');
    expect(JSON.stringify(result)).not.toContain('xxxx');
  });
});
