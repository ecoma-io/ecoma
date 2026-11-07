import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  MailProviderPort,
  MailProviderSendRequest,
  MailProviderSendResult,
} from '@ecoma-io/transactional-mailer-job-application';
import { sanitizeErrorToken } from '@ecoma-io/transactional-mailer-job-application';

import {
  createCloudflareMailProvider,
  type CloudflareProviderConfig,
  type SendEmailBindingLike,
} from './cloudflare-mail-provider';

/* -------------------------------------------------------------------------------------------- */
/* Fixture                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const NOW_MS = 1_800_000_000_000;
const SENDER = 'no-reply@ecoma.io';
const RECIPIENT = 'sentinel-3cf8a1-recipient@example.invalid';
const SUBJECT = 'sentinel-3cf8a1-subject';
const BODY = '<p>sentinel-3cf8a1-body</p>';
const DELIVERY_ID = 'sentinel-3cf8a1-delivery';
const MESSAGE_ID = '0101018f7d0c4d9a-msg-sentinel';

const appDir = join(dirname(import.meta.dirname), 'src');
const ADAPTER_FILE = join(appDir, 'cloudflare-mail-provider.ts');
const COMPOSITION_ROOT_CONFIG = join(
  dirname(dirname(dirname(appDir))),
  'apps',
  'transactional-mailer-job',
  'src',
  'config.ts',
);

function config(overrides: Partial<CloudflareProviderConfig> = {}): CloudflareProviderConfig {
  return {
    binding: okBinding(MESSAGE_ID),
    sender: SENDER,
    timeoutMs: 10_000,
    ...overrides,
  };
}

function request(overrides: Partial<MailProviderSendRequest> = {}): MailProviderSendRequest {
  return {
    deliveryId: DELIVERY_ID,
    recipient: RECIPIENT,
    subject: SUBJECT,
    body: BODY,
    contentType: 'text/html',
    deadlineMs: NOW_MS + 60_000,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Fake binding                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** Kết quả một lần `send` đã ghi lại — để assert trên message thật sự đưa vào binding. */
type RecordedSend = {
  readonly message: {
    readonly to: string;
    readonly from: string;
    readonly subject: string;
    readonly html: string;
  };
};

type BindingBehaviour =
  | { readonly kind: 'resolve'; readonly messageId: unknown }
  | { readonly kind: 'reject'; readonly code: string }
  | { readonly kind: 'reject-plain'; readonly message: string }
  | { readonly kind: 'hang' }
  /** Ném exception KHÔNG mang `code` — mô phỏng bug nội bộ của adapter/binding. */
  | { readonly kind: 'throw-foreign' };

function okBinding(messageId: unknown): SendEmailBindingLike & { readonly sends: RecordedSend[] } {
  const { binding } = stubBinding({ kind: 'resolve', messageId });
  return binding;
}

function stubBinding(behaviour: BindingBehaviour): {
  readonly binding: SendEmailBindingLike & { readonly sends: RecordedSend[] };
  readonly resolveAfterMs: (ms: number) => void;
} {
  const sends: RecordedSend[] = [];
  let hangResolve: (() => void) | null = null;

  const binding = {
    sends,
    send: (message: RecordedSend['message']): Promise<{ messageId: string }> => {
      sends.push({ message });
      if (behaviour.kind === 'hang') {
        return new Promise<{ messageId: string }>((resolve) => {
          hangResolve = () => resolve({ messageId: MESSAGE_ID });
        });
      }
      if (behaviour.kind === 'reject') {
        // Exception giữ nguyên hình một lỗi binding thật: `code` + `message` — message
        // chứa dữ liệu request để ca assert bắt được cả đường rò rỉ qua errorCode.
        const error = new Error(
          `send failed for ${message.to} subject ${message.subject}: secret-detail`,
        );
        (error as { code?: string }).code = behaviour.code;
        return Promise.reject(error);
      }
      if (behaviour.kind === 'reject-plain') {
        const error = new Error(behaviour.message);
        return Promise.reject(error);
      }
      if (behaviour.kind === 'throw-foreign') {
        // `throw` giá trị không phải Error — nhánh bug nội bộ của adapter.
        throw 'foreign-throw';
      }
      return Promise.resolve({
        messageId: typeof behaviour.messageId === 'string' ? behaviour.messageId : '',
      });
    },
  };

  return {
    binding,
    resolveAfterMs: (ms: number) => {
      hangResolve?.();
      void ms;
    },
  };
}

function providerWith(
  behaviour: BindingBehaviour,
  overrides: Partial<CloudflareProviderConfig> = {},
  nowMs: () => number = () => NOW_MS,
): { readonly port: MailProviderPort; readonly stub: ReturnType<typeof stubBinding> } {
  const stub = stubBinding(behaviour);

  return {
    port: createCloudflareMailProvider({ ...config(overrides), binding: stub.binding }, { nowMs }),
    stub,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Deadline                                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('deadline', () => {
  it('rejects an expired deadline without calling the binding', async () => {
    const { port, stub } = providerWith({ kind: 'resolve', messageId: MESSAGE_ID });

    const result = await port.send(request({ deadlineMs: NOW_MS - 1 }));

    expect(result).toEqual({
      kind: 'rejected',
      errorClass: 'retryable',
      retryAfterMs: null,
      errorCode: 'timeout',
    });
    expect(stub.binding.sends).toHaveLength(0);
  });

  it('rejects a deadline one ms in the past', async () => {
    const { port, stub } = providerWith({ kind: 'resolve', messageId: MESSAGE_ID });

    const result = await port.send(request({ deadlineMs: NOW_MS }));

    expect(result).toMatchObject({ kind: 'rejected', errorCode: 'timeout' });
    expect(stub.binding.sends).toHaveLength(0);
  });

  it('fails closed when either side of the comparison is not finite', async () => {
    const { port, stub } = providerWith({ kind: 'resolve', messageId: MESSAGE_ID });

    const nanDeadline = await port.send(request({ deadlineMs: Number.NaN }));
    const infiniteDeadline = await port.send(request({ deadlineMs: Number.POSITIVE_INFINITY }));
    // Đồng hồ NaN: `deadlineMs <= now` luôn false — nếu adapter chỉ kiểm deadline thì
    // request đã quá hạn rơi xuống accepted và trần cứng bị vô hiệu hoá im lặng.
    const nanClockPort = createCloudflareMailProvider(config(), { nowMs: () => Number.NaN });
    const nanClock = await nanClockPort.send(request());

    expect(nanDeadline).toMatchObject({ kind: 'rejected', errorCode: 'timeout' });
    expect(infiniteDeadline).toMatchObject({ kind: 'rejected', errorCode: 'timeout' });
    expect(nanClock).toMatchObject({ kind: 'rejected', errorCode: 'timeout' });
    expect(stub.binding.sends).toHaveLength(0);
  });

  it('times out a hung binding call at the configured budget and reports retryable', async () => {
    vi.useFakeTimers();
    try {
      const { port, stub } = providerWith({ kind: 'hang' });

      const pending = port.send(request());
      // Chạy qua mọi timer đến hạn — timer của adapter phải report `timeout`.
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result).toEqual({
        kind: 'rejected',
        errorClass: 'retryable',
        retryAfterMs: null,
        errorCode: 'timeout',
      });
      // Request ĐÃ rời khỏi worker (binding đã được gọi) — mơ hồ §9.1, không rút lại được.
      expect(stub.binding.sends).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lets the configured timeout outlive the remaining deadline', async () => {
    vi.useFakeTimers();
    try {
      // timeoutMs 10s nhưng deadline chỉ còn 100ms — trần thực tế phải là 100ms.
      const { port } = providerWith({ kind: 'hang' }, { timeoutMs: 10_000 });

      const pending = port.send(request({ deadlineMs: NOW_MS + 100 }));
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(result).toMatchObject({ kind: 'rejected', errorCode: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Accepted                                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('accepted sends', () => {
  it('returns the provider message id from the binding result', async () => {
    const { port } = providerWith({ kind: 'resolve', messageId: MESSAGE_ID });

    const result = await port.send(request());

    expect(result).toEqual({
      kind: 'accepted',
      providerMessageId: MESSAGE_ID,
      warningCode: null,
    });
  });

  it('never fabricates an id from the request', async () => {
    const { port } = providerWith({ kind: 'resolve', messageId: '' });

    const result = await port.send(request());

    // Binding trả id rỗng — `null`, không suy từ `deliveryId`/recipient (§11.1).
    expect(result).toEqual({
      kind: 'accepted',
      providerMessageId: null,
      warningCode: 'provider-id-unparseable',
    });
  });

  it('treats a whitespace-only id as absent', async () => {
    const { port } = providerWith({ kind: 'resolve', messageId: '   ' });

    const result = await port.send(request());

    expect(result).toMatchObject({ kind: 'accepted', providerMessageId: null });
  });

  it('sends the configured sender, one recipient, the subject and the html body', async () => {
    const { port, stub } = providerWith({ kind: 'resolve', messageId: MESSAGE_ID });

    await port.send(request());

    expect(stub.binding.sends[0]?.message).toEqual({
      to: RECIPIENT,
      from: SENDER,
      subject: SUBJECT,
      html: BODY,
    });
  });

  it('does not retry inside one call', async () => {
    const { port, stub } = providerWith({ kind: 'resolve', messageId: MESSAGE_ID });

    await port.send(request());
    await port.send(request());

    expect(stub.binding.sends).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Error code mapping                                                                             */
/* -------------------------------------------------------------------------------------------- */

describe('error code mapping', () => {
  const cases: readonly {
    readonly code: string;
    readonly errorClass: 'retryable' | 'permanent' | 'credential';
    readonly errorCode: string;
  }[] = [
    { code: 'E_RATE_LIMIT_EXCEEDED', errorClass: 'retryable', errorCode: 'provider-rate-limited' },
    {
      code: 'E_DAILY_LIMIT_EXCEEDED',
      errorClass: 'retryable',
      errorCode: 'provider-rate-limited',
    },
    {
      code: 'E_INTERNAL_SERVER_ERROR',
      errorClass: 'retryable',
      errorCode: 'provider-transport-error',
    },
    { code: 'E_VALIDATION_ERROR', errorClass: 'permanent', errorCode: 'provider-request-rejected' },
    { code: 'E_FIELD_MISSING', errorClass: 'permanent', errorCode: 'provider-request-rejected' },
    {
      code: 'E_CONTENT_TOO_LARGE',
      errorClass: 'permanent',
      errorCode: 'provider-request-rejected',
    },
    {
      code: 'E_RECIPIENT_SUPPRESSED',
      errorClass: 'permanent',
      errorCode: 'provider-recipient-rejected',
    },
    {
      code: 'E_SENDER_NOT_VERIFIED',
      errorClass: 'credential',
      errorCode: 'provider-sender-unverified',
    },
    {
      code: 'E_ACCOUNT_SUSPENDED',
      errorClass: 'credential',
      errorCode: 'provider-account-suspended',
    },
    // SMTP delivery failure ĐÃ xử lý xong phía provider: permanent, không retry — retry
    // từ worker sẽ gửi thư thứ hai; lifecycle event mới là tín hiệu chuẩn.
    { code: 'E_DELIVERY_FAILED', errorClass: 'permanent', errorCode: 'provider-delivery-failed' },
  ];

  for (const mapped of cases) {
    it(`maps ${mapped.code} to ${mapped.errorClass}/${mapped.errorCode}`, async () => {
      const { port } = providerWith({ kind: 'reject', code: mapped.code });

      const result = await port.send(request());

      expect(result).toEqual({
        kind: 'rejected',
        errorClass: mapped.errorClass,
        retryAfterMs: null,
        errorCode: mapped.errorCode,
      });
    });
  }

  it('fails closed to retryable for an unknown provider error code', async () => {
    const { port } = providerWith({ kind: 'reject', code: 'E_SOMETHING_NEW' });

    const result = await port.send(request());

    // Mã provider thêm mới sau khi adapter viết: không có bằng chứng request sai nên
    // KHÔNG được chốt permanent — retry một lần qua Queue rẻ hơn misclassify.
    expect(result).toEqual({
      kind: 'rejected',
      errorClass: 'retryable',
      retryAfterMs: null,
      errorCode: 'provider-unknown-error',
    });
  });

  it('rethrows a foreign exception as an adapter bug', async () => {
    const { port } = providerWith({ kind: 'throw-foreign' });

    await expect(port.send(request())).rejects.toBe('foreign-throw');
  });

  it('returns retryAfterMs null for every rejection — the binding has no Retry-After', async () => {
    const { port } = providerWith({ kind: 'reject', code: 'E_RATE_LIMIT_EXCEEDED' });

    const result = (await port.send(request())) as Extract<
      MailProviderSendResult,
      { kind: 'rejected' }
    >;

    expect(result.retryAfterMs).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Sanitization và data leak                                                                      */
/* -------------------------------------------------------------------------------------------- */

describe('sanitization and data leak', () => {
  it('never echoes the recipient, subject or body into the result', async () => {
    const { port } = providerWith({ kind: 'reject', code: 'E_VALIDATION_ERROR' });

    const result = JSON.stringify(await port.send(request()));

    expect(result).not.toContain(RECIPIENT);
    expect(result).not.toContain(SUBJECT);
    expect(result).not.toContain(BODY);
    expect(result).not.toContain(SENDER);
  });

  it('does not leak the exception message of the binding through the errorCode', async () => {
    // Message của exception chứa dữ liệu request + chi tiết "secret" — không được chạm
    // kết quả dưới bất kỳ hình dạng nào (§11.2).
    const { port } = providerWith({ kind: 'reject', code: 'E_INTERNAL_SERVER_ERROR' });

    const result = JSON.stringify(await port.send(request()));

    expect(result).not.toContain('secret-detail');
    expect(result).not.toContain('send failed for');
  });

  it('emits error tokens that pass the persisted-token pattern', async () => {
    const codes = [
      'timeout',
      'provider-unknown-error',
      'provider-id-unparseable',
      'provider-rate-limited',
      'provider-transport-error',
      'provider-sender-unverified',
      'provider-account-suspended',
      'provider-request-rejected',
      'provider-recipient-rejected',
      'provider-delivery-failed',
    ];

    for (const token of codes) {
      // Đi qua sanitizer của model — cùng chốt mà `last_error` sẽ gặp ở storage.
      expect(sanitizeErrorToken(token, 'errorCode')).toBe(token);
    }
  });

  it('does not log anything', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { port } = providerWith({ kind: 'reject', code: 'E_VALIDATION_ERROR' });
      await port.send(request());
      const accepted = providerWith({ kind: 'resolve', messageId: MESSAGE_ID });
      await accepted.port.send(request());

      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Dependency boundary                                                                            */
/* -------------------------------------------------------------------------------------------- */

describe('dependency boundary', () => {
  it('reads the composition-root config from disk', () => {
    expect(readFileSync(COMPOSITION_ROOT_CONFIG, 'utf8')).toContain(
      'export type CloudflareProviderConfig',
    );
  });

  it('mirrors the composition-root config field for field', () => {
    // Adapter khai trùng `CloudflareProviderConfig` thay vì import: import chéo deploy
    // unit bị chặn. Lệch tên field ở một phía là hỏng im lặng — ca này biến nó thành đỏ.
    //
    // Adapter CÓ THÊM `binding` so với composition root: binding là dependency được
    // composition root truyền thẳng vào (đã fail-closed ở loader), không phải giá trị
    // cấu hình — nên phép so là "field của root là tập con đúng của adapter".
    const source = readFileSync(COMPOSITION_ROOT_CONFIG, 'utf8');
    const adapter = readFileSync(ADAPTER_FILE, 'utf8');

    const rootFields = fieldNamesOf(source, 'CloudflareProviderConfig');
    const adapterFields = fieldNamesOf(adapter, 'CloudflareProviderConfig');

    expect(new Set(adapterFields)).toEqual(new Set(['binding', 'sender', 'timeoutMs']));
    for (const field of rootFields) {
      expect(adapterFields).toContain(field);
    }
    expect(rootFields).toEqual(['sender', 'timeoutMs']);
  });

  it('uses the pinned sender constant in the composition root config', () => {
    const source = readFileSync(COMPOSITION_ROOT_CONFIG, 'utf8');

    // Sender bị ghim bằng hằng — hai lớp chặn (binding allowlist + loader) phải nói cùng
    // một địa chỉ; ca này bắt việc một phía đổi mà phía kia không đổi.
    expect(source).toContain("CLOUDFLARE_SENDER_ADDRESS = 'no-reply@ecoma.io'");
  });

  it('declares no global scope mutation', () => {
    // Khác Resend adapter (cần AbortSignal merging), adapter này KHÔNG cần `declare
    // global` nào: chỉ dùng setTimeout module-scope. Ca này ghim rằng không ai thêm
    // global mutation vào sau — một `declare global` trần là ghi đè bề mặt consumer.
    const adapter = readFileSync(ADAPTER_FILE, 'utf8');
    expect(adapter).not.toMatch(/declare\s+global/u);
  });
});

/** Trích tên field của một `type`/`interface` khai trong source — helper của mirror test. */
function fieldNamesOf(source: string, typeName: string): string[] {
  // Hai hình khai báo: `interface X { ... }` (không `;` cuối) và `type X = { ... };`.
  // `typeName` là literal của chính test này (identifier TS, không có ký tự regex đặc biệt)
  // — không escape, tránh một đường sanitize không đầy đủ mà CodeQL cảnh báo.
  const declaration =
    source.match(new RegExp(`export interface ${typeName} \\{([^}]*)\\}`, 'u')) ??
    source.match(new RegExp(`export type ${typeName} = \\{([^}]*)\\}`, 'u'));
  if (declaration === null) {
    return [];
  }
  const body = declaration[1] ?? '';
  return [...body.matchAll(/readonly\s+([A-Za-z][A-Za-z0-9]*)\s*[?]?:/gu)].map(
    (match) => match[1] ?? '',
  );
}
