import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import type {
  MailProviderPort,
  MailProviderSendRequest,
  MailProviderSendResult,
} from '@ecoma-io/transactional-mailer-job-application';

import {
  FAKE_PROVIDER_MESSAGE_ID,
  FAKE_RETRY_AFTER_MS,
  FakeMailProvider,
} from './fake-mail-provider';

/**
 * Request sạch: không chứa token nào, deadline xa.
 *
 * `deadlineMs` tính từ mốc cố định nên test không phụ thuộc đồng hồ thật.
 */
const NOW_MS = 1_800_000_000_000;
const FAR_FUTURE_MS = NOW_MS + 60_000;

/** Đồng hồ inject cố định — mọi ca deadline đều xác định. */
const fixedClock = (): number => NOW_MS;

/** Sentinel nhận dạng được, phải không bao giờ xuất hiện trong output. */
const RECIPIENT_SENTINEL = 'sentinel-9f3c1a-recipient';
const SUBJECT_SENTINEL = 'sentinel-9f3c1a-subject';
const BODY_SENTINEL = 'sentinel-9f3c1a-body';

function request(overrides: Partial<MailProviderSendRequest> = {}): MailProviderSendRequest {
  return {
    deliveryId: 'delivery-1',
    recipient: `${RECIPIENT_SENTINEL}@example.test`,
    subject: `subject ${SUBJECT_SENTINEL}`,
    body: `<p>${BODY_SENTINEL}</p>`,
    contentType: 'text/html',
    deadlineMs: FAR_FUTURE_MS,
    ...overrides,
  };
}

/** Request mang token: token nằm ở `recipient` trừ khi chỉ định chỗ khác. */
function requestWithToken(token: string, overrides: Partial<MailProviderSendRequest> = {}) {
  return request({ recipient: `${token}-${RECIPIENT_SENTINEL}@example.test`, ...overrides });
}

function serialized(result: MailProviderSendResult): string {
  return JSON.stringify(result);
}

/** Adapter mặc định với đồng hồ cố định. */
function adapter(): FakeMailProvider {
  return new FakeMailProvider({ now: fixedClock });
}

async function sendWithToken(
  token: string,
  overrides: Partial<MailProviderSendRequest> = {},
): Promise<MailProviderSendResult> {
  return adapter().send(requestWithToken(token, overrides));
}

/**
 * Specifier import của một file trong `src/`, đọc thẳng từ đĩa.
 *
 * Neo theo `import.meta.dirname` (vị trí file spec) chứ không theo `process.cwd()`,
 * vì `nx test` và chạy tay từ gốc workspace đặt cwd khác nhau.
 *
 * Pattern phủ cả bốn dạng khai báo: `import x from '…'` / `import { x } from '…'`
 * (nhánh `from`), `import '…'` không binding (nhánh `import` ở đầu dòng),
 * `import('…')` động, và `require('…')` — cùng cả hai loại quote. Bản cũ chỉ khớp
 * quote đơn nên một import viết bằng `"` lọt qua, và bản cũ không khớp `import(`.
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
 * cứng.
 *
 * Danh sách cứng chỉ quét đúng những file đã biết, nên file source thêm sau này
 * sẽ nằm ngoài phạm vi kiểm mà không có gì đỏ. Dò từ thư mục thì file mới tự
 * động vào phạm vi. File test bị loại vì chúng được phép import Node builtin.
 */
function sourceFiles(): readonly string[] {
  return readdirSync(import.meta.dirname).filter(
    (name) => !name.includes('.spec.') && /\.(?:ts|mts|cts)$/u.test(name),
  );
}

/**
 * `lib` hiệu lực của một config: mảng của chính nó, nếu không thì thừa hưởng
 * qua `extends` (đệ quy). Chỉ đi theo đường dẫn tương đối — đủ cho repo này.
 */
function effectiveLibs(configPath: string): readonly string[] {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    extends?: string | readonly string[];
    compilerOptions?: { lib?: readonly string[] };
  };

  if (config.compilerOptions?.lib) {
    return config.compilerOptions.lib;
  }

  const parents = typeof config.extends === 'string' ? [config.extends] : (config.extends ?? []);

  return parents.flatMap((parent) => effectiveLibs(resolve(dirname(configPath), parent)));
}

/** Toàn bộ specifier mà source của lib này được phép có (quét từ đĩa ở trên). */
const ALLOWED_SOURCE_SPECIFIERS = new Set([
  '@ecoma-io/transactional-mailer-job-application',
  // §7.4 — signed client gọi private delivery interface của `transactional-mail`:
  // contract canonical của giao thức ký + validator body của wire contract.
  '@ecoma-io/internal-auth-contracts',
  '@ecoma-io/transactional-mail-contracts',
  './fake-mail-provider',
  './d1-database-like',
  './d1-lifecycle-event-store',
  './d1-mail-job-repository',
  './d1-quarantine-repository',
  './mail-job-row',
  // §10.2 — provider thật (Resend) nằm cạnh fake provider, chung boundary guard.
  './resend-mail-provider',
  // §11 — provider thật mặc định (Cloudflare send_email binding), chung boundary guard.
  './cloudflare-mail-provider',
  // §7.4 — signed client và adapter `MailDeliveryGateway` bọc client đó
  // (chuyển từ composition root `apps/transactional-mailer-job/src/main.ts` về đây).
  './internal-delivery-client',
  './internal-delivery-gateway',
]);

describe('deterministic scenarios', () => {
  it('is a MailProviderPort', () => {
    const port: MailProviderPort = adapter();

    expect(typeof port.send).toBe('function');
  });

  it('returns the fixed synthetic providerMessageId for a clean request', async () => {
    const result = await adapter().send(request());

    // Hằng literal, không so với chính hằng export của module: nếu giá trị bị
    // đổi thì test này phải đỏ, chứ không tự đồng thuận với implementation.
    expect(result).toStrictEqual({
      kind: 'accepted',
      providerMessageId: 'fake-provider-message-id',
      warningCode: null,
    });
    expect(FAKE_PROVIDER_MESSAGE_ID).toBe('fake-provider-message-id');
  });

  it.each([
    [
      'fake:credential',
      {
        kind: 'rejected',
        errorClass: 'credential',
        retryAfterMs: null,
        errorCode: 'http-401',
      },
    ],
    [
      'fake:permanent',
      {
        kind: 'rejected',
        errorClass: 'permanent',
        retryAfterMs: null,
        errorCode: 'http-400',
      },
    ],
    [
      'fake:retryable',
      {
        kind: 'rejected',
        errorClass: 'retryable',
        retryAfterMs: null,
        errorCode: 'network',
      },
    ],
    [
      'fake:retryable-after',
      {
        kind: 'rejected',
        errorClass: 'retryable',
        retryAfterMs: 30_000,
        errorCode: 'http-429',
      },
    ],
    [
      'fake:malformed-response',
      { kind: 'accepted', providerMessageId: null, warningCode: 'malformed-response' },
    ],
    ['fake:no-message-id', { kind: 'accepted', providerMessageId: null, warningCode: null }],
  ])('maps token %s to its documented outcome', async (token, expected) => {
    expect(await sendWithToken(token)).toStrictEqual(expected);
  });

  it('drives the same outcome from subject as from recipient', async () => {
    const viaRecipient = await sendWithToken('fake:permanent');
    const viaSubject = await adapter().send(
      request({ subject: 'fake:permanent', recipient: 'clean@example.test' }),
    );

    expect(viaSubject).toStrictEqual(viaRecipient);
  });

  it('resolves a deterministic outcome when a token field is not a string', async () => {
    /**
     * Guard `typeof` trong `matchesToken` là thứ duy nhất giữ cho ca này resolve
     * thay vì ném `TypeError`; bỏ guard đi thì test này đỏ. Giá trị kỳ dị vẫn có
     * thể tới từ ranh giới (store rồi Queue) dù type nói `string`.
     *
     * Đây là **ghi nhận hành vi**, không phải một bảo đảm validate shape: field
     * không phải string không khớp token nào, nên outcome là bản canonical
     * `accepted` — nhánh dễ dãi nhất. Adapter không fail closed cho shape request.
     *
     * `['fake:permanent']` cố ý có mặt: mảng *có* method `includes`, nên nếu guard
     * bị bỏ thì ca đó không ném lỗi mà khớp token luôn — tức nó bắt được cả kiểu
     * hỏng im lặng, không chỉ kiểu ném lỗi.
     */
    const nonStrings = [undefined, null, 42, {}, ['fake:permanent']] as const;

    for (const value of nonStrings) {
      const result = await adapter().send(
        request({
          recipient: value as unknown as string,
          subject: value as unknown as string,
        }),
      );

      expect(result).toStrictEqual({
        kind: 'accepted',
        providerMessageId: 'fake-provider-message-id',
        warningCode: null,
      });
    }
  });

  it('is repeatable: same request, same result', async () => {
    for (const token of ['fake:retryable-after', 'fake:malformed-response', 'none']) {
      const instance = adapter();
      const first = await instance.send(requestWithToken(token));
      const second = await instance.send(requestWithToken(token));
      const third = await instance.send(requestWithToken(token));

      expect(second).toStrictEqual(first);
      expect(third).toStrictEqual(first);
    }
  });

  it('is not derived from deliveryId or recipient', async () => {
    const instance = adapter();
    const a = await instance.send(
      request({ deliveryId: 'delivery-a', recipient: 'a@example.test' }),
    );
    const b = await instance.send(
      request({ deliveryId: 'delivery-b', recipient: 'b@example.test' }),
    );

    expect(a).toStrictEqual(b);
    expect(serialized(a)).not.toContain('delivery-a');
    expect(serialized(b)).not.toContain('delivery-b');
  });

  it('ignores tokens that appear only in body', async () => {
    // `body` không phải nguồn token: cùng một body, hai kết quả khác nhau khi
    // recipient/subject khác nhau — ngược lại body phải vô can.
    const withTokenBody = await adapter().send(
      request({ body: '<p>fake:permanent fake:credential fake:retryable</p>' }),
    );
    const withoutTokenBody = await adapter().send(request({ body: '<p>clean</p>' }));

    expect(withTokenBody).toStrictEqual(withoutTokenBody);
    expect(withTokenBody.kind).toBe('accepted');
  });
});

describe('token precedence', () => {
  /**
   * Thứ tự canonical của bảng scenario. Test dưới đây ghim **mọi cặp** theo
   * thứ tự này, nên đổi thứ tự bảng là đỏ ngay.
   */
  const ORDERED_TOKENS = [
    'fake:credential',
    'fake:permanent',
    'fake:retryable-after',
    'fake:retryable',
    'fake:malformed-response',
    'fake:no-message-id',
  ] as const;

  it('resolves the earlier token when both are in recipient', async () => {
    const pairs = ORDERED_TOKENS.flatMap((first, index) =>
      ORDERED_TOKENS.slice(index + 1).map((second) => [first, second] as const),
    );

    for (const [winner, loser] of pairs) {
      const both = await sendWithToken(`${winner} ${loser}`);
      const only = await sendWithToken(winner);

      expect(both).toStrictEqual(only);
    }
  });

  it('keeps table order above field order', async () => {
    // Token xếp trước nằm ở `subject`, token xếp sau nằm ở `recipient`: thứ tự
    // bảng phải thắng thứ tự field.
    const cases = [
      ['fake:credential', 'fake:retryable'],
      ['fake:permanent', 'fake:malformed-response'],
      ['fake:retryable-after', 'fake:retryable'],
    ] as const;

    for (const [winner, loser] of cases) {
      const result = await adapter().send(
        request({ recipient: `${loser}@example.test`, subject: winner }),
      );

      expect(result).toStrictEqual(await sendWithToken(winner));
    }
  });

  it('never lets fake:retryable shadow fake:retryable-after', async () => {
    // Cặp nguy hiểm nhất: `fake:retryable` là substring của token dài hơn, nên
    // đọc bảng theo thứ tự ngược lại sẽ trả retryAfterMs = null.
    const result = await sendWithToken('fake:retryable-after');

    expect(result).toStrictEqual({
      kind: 'rejected',
      errorClass: 'retryable',
      retryAfterMs: FAKE_RETRY_AFTER_MS,
      errorCode: 'http-429',
    });
  });
});

describe('deadline', () => {
  it('rejects an expired deadline without calling the provider', async () => {
    const result = await adapter().send(request({ deadlineMs: NOW_MS }));

    expect(result).toStrictEqual({
      kind: 'rejected',
      errorClass: 'retryable',
      retryAfterMs: null,
      errorCode: 'timeout',
    });
  });

  it('rejects a deadline exactly one ms in the past', async () => {
    const result = await adapter().send(request({ deadlineMs: NOW_MS - 1 }));

    expect(result).toMatchObject({ kind: 'rejected', errorCode: 'timeout' });
  });

  it('does not sleep or schedule a timer for an expired deadline', async () => {
    vi.useFakeTimers();

    try {
      // Với fake timer, một `await sleep()` bên trong `send` sẽ treo test này
      // (timeout) vì không ai advance đồng hồ — nên phép thử này bắt đúng
      // "không sleep", không chỉ "không log".
      const pending = adapter().send(request({ deadlineMs: NOW_MS - 10_000 }));

      expect(vi.getTimerCount()).toBe(0);

      const result = await pending;

      expect(vi.getTimerCount()).toBe(0);
      expect(result).toMatchObject({ errorCode: 'timeout', retryAfterMs: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never touches the network for any outcome', async () => {
    // Adapter không được có đường network nào: nếu một provider thật lọt vào
    // sau này qua import, ca này đỏ vì `fetch` bị gọi.
    //
    // Phạm vi: ca này chỉ chặn đường `fetch`. Một client khác (`node:http`,
    // `node:net`, `XMLHttpRequest`) sẽ không bị nó bắt — nhưng để dùng được thì
    // phải import, và chính import đó bị `no-restricted-imports` /
    // `import(no-nodejs-modules)` của oxlint chặn trước (xem `dependency
    // boundary`). Đây là guard bổ trợ, không phải bảo đảm duy nhất.
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    try {
      for (const token of [
        'none',
        'fake:credential',
        'fake:permanent',
        'fake:retryable',
        'fake:retryable-after',
        'fake:malformed-response',
        'fake:no-message-id',
      ]) {
        await sendWithToken(token);
        await adapter().send(request({ deadlineMs: NOW_MS - 1 }));
      }

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed for a non-finite deadline', async () => {
    for (const deadlineMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = await adapter().send(request({ deadlineMs }));

      expect(result).toStrictEqual({
        kind: 'rejected',
        errorClass: 'permanent',
        retryAfterMs: null,
        errorCode: 'invalid-deadline',
      });
    }
  });

  it('fails closed when the clock itself is non-finite', async () => {
    // Cả hai phía của phép so sánh đều phải hữu hạn. Nếu chỉ kiểm `deadlineMs`,
    // một `nowMs` là `NaN` làm `deadlineMs <= nowMs` luôn `false`, và request đã
    // quá hạn rơi xuống outcome canonical `accepted` — trần cứng deadline bị vô
    // hiệu hoá im lặng. Ca này ghim đúng đường đó.
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const instance = new FakeMailProvider({ now: () => nowMs });
      const expired = await instance.send(request({ deadlineMs: NOW_MS - 1 }));

      expect(expired).toStrictEqual({
        kind: 'rejected',
        errorClass: 'permanent',
        retryAfterMs: null,
        errorCode: 'invalid-deadline',
      });

      // Cùng clock hỏng, deadline còn xa: vẫn không được `accepted`, vì adapter
      // không thể kết luận deadline còn hiệu lực.
      const future = await instance.send(request({ deadlineMs: NOW_MS + 60_000 }));

      expect(future).toMatchObject({ kind: 'rejected', errorCode: 'invalid-deadline' });
    }
  });

  it('checks the deadline before the token table', async () => {
    // Request vừa hết hạn vừa mang token credential: deadline phải thắng.
    const result = await sendWithToken('fake:credential', { deadlineMs: NOW_MS - 1 });

    expect(result).toMatchObject({ kind: 'rejected', errorCode: 'timeout' });
    expect(result).not.toMatchObject({ errorClass: 'credential' });
  });

  it('checks a non-finite deadline before the token table', async () => {
    const result = await sendWithToken('fake:permanent', { deadlineMs: Number.NaN });

    expect(result).toMatchObject({ errorCode: 'invalid-deadline' });
  });

  it('accepts a deadline one ms in the future', async () => {
    const result = await adapter().send(request({ deadlineMs: NOW_MS + 1 }));

    expect(result.kind).toBe('accepted');
  });

  it('reads the clock per call rather than caching it', async () => {
    let nowMs = NOW_MS;
    const instance = new FakeMailProvider({ now: () => nowMs });
    const req = request({ deadlineMs: NOW_MS + 5 });

    expect((await instance.send(req)).kind).toBe('accepted');

    nowMs = NOW_MS + 1_000; // đồng hồ trôi qua deadline

    expect(await instance.send(req)).toMatchObject({ errorCode: 'timeout' });
  });
});

describe('sanitization and data leak', () => {
  const ALL_TOKENS = [
    'none',
    'fake:credential',
    'fake:permanent',
    'fake:retryable',
    'fake:retryable-after',
    'fake:malformed-response',
    'fake:no-message-id',
  ] as const;

  it('never echoes recipient, subject or body into the result', async () => {
    for (const token of ALL_TOKENS) {
      const result = await sendWithToken(token);
      const raw = serialized(result);

      expect(raw).not.toContain(RECIPIENT_SENTINEL);
      expect(raw).not.toContain(SUBJECT_SENTINEL);
      expect(raw).not.toContain(BODY_SENTINEL);
      expect(raw).not.toContain('@example.test');
    }
  });

  it('emits only error codes from the documented token vocabulary', async () => {
    /**
     * Vocabulary của fake, và nguồn của từng token:
     *
     * - `http-429`, `network`, `timeout`, `malformed-response`: §11.1 nêu trực
     *   tiếp trong bảng chiếu error matrix.
     * - `http-401`, `http-400`: suy từ hàng 3 và hàng 2 của bảng đó (`4xx` authn
     *   → `credential`, `4xx` khác → `permanent`), không được §11.1 viết nguyên văn.
     * - `invalid-deadline`: **do fake này đặt** cho nhánh deadline không hữu hạn,
     *   không có trong §11.1. Nhánh đó được mô tả ở docblock `checkDeadline` và
     *   trong `01-architecture.md` §11.2.
     *
     * Bất biến được kiểm ở đây là "token sanitize, không chứa dữ liệu request",
     * không phải "mọi token đều xuất hiện trong §11.1".
     */
    const allowedErrorCodes = new Set([
      'http-401',
      'http-400',
      'http-429',
      'network',
      'timeout',
      'invalid-deadline',
    ]);
    const allowedWarningCodes = new Set(['malformed-response']);

    const errorCodes: string[] = [];
    const warningCodes: string[] = [];

    for (const token of ALL_TOKENS) {
      const result = await sendWithToken(token);

      if (result.kind === 'rejected') {
        errorCodes.push(result.errorCode);
      }
      if (result.kind === 'accepted' && result.warningCode !== null) {
        warningCodes.push(result.warningCode);
      }
    }

    // Lọc rồi so rỗng sẽ xanh vô nghĩa nếu vòng lặp không thu được gì, nên phải
    // khẳng định hai mảng không rỗng trước.
    expect(errorCodes.length).toBeGreaterThan(0);
    expect(warningCodes.length).toBeGreaterThan(0);
    expect(errorCodes.filter((code) => !allowedErrorCodes.has(code))).toEqual([]);
    expect(warningCodes.filter((code) => !allowedWarningCodes.has(code))).toEqual([]);
  });

  it('does not log anything', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );

    try {
      for (const token of ALL_TOKENS) {
        await sendWithToken(token);
      }

      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  it('exposes no own property on the instance', async () => {
    const instance = adapter();

    await instance.send(requestWithToken('fake:permanent'));
    await instance.send(request());

    // Không field public nào giữ token, và không state nào serialize ra được:
    // adapter này stateless ngoài đồng hồ inject.
    //
    // Giới hạn phải nói rõ: `#` field (private thật) vô hình với cả hai phép
    // kiểm dưới đây, nên ca này **không** chứng minh được adapter không giữ state
    // private — nó chỉ chứng minh không có field own nào. `#now` hiện là field
    // private duy nhất và nó giữ đồng hồ, không giữ dữ liệu request.
    expect(Object.getOwnPropertyNames(instance)).toEqual([]);
    expect(Object.keys(instance)).toEqual([]);
    expect(JSON.stringify(instance)).toBe('{}');
  });

  it('redacts the failure path: no token text in the returned errorCode', async () => {
    const result = await sendWithToken('fake:permanent');

    expect(result).toStrictEqual({
      kind: 'rejected',
      errorClass: 'permanent',
      retryAfterMs: null,
      errorCode: 'http-400',
    });
    expect(result.kind === 'rejected' ? result.errorCode : '').not.toContain('sentinel');
  });
});

describe('dependency boundary', () => {
  it('imports the port by package name only', () => {
    const discovered = sourceFiles();
    const workspaceImports = discovered
      .flatMap(importSpecifiersOf)
      .filter((specifier) => specifier.startsWith('@ecoma-io/'));

    // Assertion không được rỗng: nếu scan không tìm thấy gì thì test này không
    // kiểm gì cả.
    expect(discovered.length).toBeGreaterThan(0);
    expect(workspaceImports.length).toBeGreaterThan(0);
    expect(new Set(workspaceImports)).toEqual(
      new Set([
        '@ecoma-io/transactional-mailer-job-application',
        // §7.4 — signed client: hai gói contract của giao thức ký và wire contract.
        '@ecoma-io/internal-auth-contracts',
        '@ecoma-io/transactional-mail-contracts',
      ]),
    );
  });

  it('imports nothing but the port package and its own module', () => {
    // Quét **mọi** file source trong `src/` (dò từ đĩa), không phải một danh sách
    // cứng: thêm file mới là nó tự vào phạm vi, nên không còn chỗ nào để lách.
    // Đó cũng là cách bảo đảm adapter không import app/Queue: chúng sẽ phải có
    // mặt trong danh sách này để được phép.
    //
    // Đây là guard đọc source text, tức lớp bổ trợ. Lớp **thực thi** là oxlint:
    // `no-restricted-imports`, `import(no-nodejs-modules)` và
    // `@nx/enforce-module-boundaries` trong `.oxlintrc.json` chặn vendor SDK,
    // Node builtin và lib ngoài allowlist ngay ở `nx lint`. Một guard đọc text
    // không thể thay chúng, và không chạy trước khi lint chạy.
    const specifiers = sourceFiles().flatMap(importSpecifiersOf);

    expect(new Set(specifiers)).toEqual(new Set(ALLOWED_SOURCE_SPECIFIERS));
  });

  it('never reaches outside its own src directory', () => {
    const escaping = sourceFiles()
      .flatMap(importSpecifiersOf)
      .filter((specifier) => specifier.startsWith('../'));

    expect(escaping).toEqual([]);
  });

  it('exposes exactly send on the adapter prototype', () => {
    // Adapter chỉ được có `send`; thêm method khác là mở rộng seam ngoài port.
    expect(Object.getOwnPropertyNames(FakeMailProvider.prototype)).toEqual(['constructor', 'send']);
  });

  it('exposes the documented runtime surface through the package root', async () => {
    const packageRoot = await import('./index');

    // Chỉ liệt kê **value** export: type export không xuất hiện trong
    // `Object.keys`, nên danh sách này là đúng bề mặt runtime mà consumer thấy.
    // `createResendMailProvider` và `createCloudflareMailProvider` là hai provider
    // thật (§10.2, §11) nằm cạnh fake trong cùng package root; signed client
    // (`InternalDeliveryClient`) và adapter gateway của nó (`createGateway`) cùng
    // nằm ở đây từ khi wiring rời composition root (issue #333).
    expect(new Set(Object.keys(packageRoot))).toEqual(
      new Set([
        'FakeMailProvider',
        'FAKE_PROVIDER_MESSAGE_ID',
        'FAKE_RETRY_AFTER_MS',
        'readChanges',
        'D1MailJobRepository',
        'D1QuarantineRepository',
        'D1LifecycleEventStore',
        'decodeMailJobRow',
        'decodeQuarantineRow',
        'MAIL_JOB_COLUMNS',
        'QUARANTINE_COLUMNS',
        'createResendMailProvider',
        'createCloudflareMailProvider',
        'INTERNAL_AUTH_SECRET_ENV',
        'InternalDeliveryClient',
        'InternalDeliveryConfigError',
        'InternalDeliveryRequestError',
        'createGateway',
        'resolveInternalAuthSecret',
      ]),
    );
  });
});

/**
 * Mọi config TypeScript của một project: solution, lib và spec.
 */
function configFiles(dir: string): readonly string[] {
  return readdirSync(dir)
    .filter((name) => /^tsconfig(?:\.[a-z]+)?\.json$/u.test(name))
    .map((name) => join(dir, name));
}

describe('runtime surface', () => {
  // Cả hai lib tag `runtime:edge` (Worker), nơi `document`, `window`,
  // `localStorage` không tồn tại. Khai `dom` trong `lib` làm các API đó
  // typecheck được rồi `ReferenceError` lúc chạy trên Worker.
  //
  // Guard này quét thư mục anh em thay vì liệt kê tay từng lib, để một lib thứ
  // ba thêm sau vẫn được phủ; và kiểm hai cơ chế đưa `dom` vào: `compilerOptions.lib`
  // (kể cả thừa hưởng qua `extends`) và `/// <reference lib="dom" />` trong source.
  //
  // Áp cho MỌI config TypeScript của hai lib — `tsconfig.lib.json` lẫn
  // `tsconfig.spec.json` — vì `tsconfig.spec.json` cũng được `tsc --build` biên
  // dịch (nằm trong `references` của solution `tsconfig.json`), nên `dom` ở đó
  // cũng là đường typecheck-xanh-chết-lúc-chạy. Spec chạy `environment: 'node'`
  // trong `vitest.config.mts` và không cần DOM API nào.
  const libsRoot = join(import.meta.dirname, '..', '..');
  const projectDirs = readdirSync(libsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('transactional-mailer-job-'))
    .map((entry) => join(libsRoot, entry.name));

  it('discovers both transactional-mailer-job libs', () => {
    // Chốt chống test rỗng: nếu bước quét thư mục hỏng, `projectDirs` rỗng và
    // mọi assertion bên dưới tự động xanh.
    expect(new Set(projectDirs.map((dir) => basename(dir)))).toEqual(
      new Set(['transactional-mailer-job-application', 'transactional-mailer-job-infrastructure']),
    );
  });

  it('scans the lib and spec config of both libs', () => {
    // Cùng lý do: đổi tên file config phải làm đỏ ở đây, chứ không âm thầm bỏ
    // project khỏi phạm vi guard. `Map` để không phụ thuộc thứ tự đọc thư mục.
    const scanned = new Map(
      projectDirs.map((dir) => [basename(dir), new Set(configFiles(dir).map((f) => basename(f)))]),
    );

    expect(scanned).toEqual(
      new Map([
        [
          'transactional-mailer-job-application',
          new Set(['tsconfig.json', 'tsconfig.lib.json', 'tsconfig.spec.json']),
        ],
        [
          'transactional-mailer-job-infrastructure',
          new Set(['tsconfig.json', 'tsconfig.lib.json', 'tsconfig.spec.json']),
        ],
      ]),
    );
  });

  it('resolves the effective lib set through the extends chain', () => {
    // Cùng lý do: nếu bước đi theo `extends` hỏng, nó trả mảng rỗng và phép
    // kiểm `dom` bên dưới pass vô nghĩa. Ghim giá trị thật đã phân giải.
    const config = join(libsRoot, 'transactional-mailer-job-infrastructure', 'tsconfig.lib.json');

    expect(effectiveLibs(config)).toEqual(['es2022']);
  });

  it('never declares the dom lib in any config, directly or via extends', () => {
    const offenders = projectDirs.flatMap((dir) =>
      configFiles(dir).flatMap((configPath) => {
        const libs = effectiveLibs(configPath);
        const dom = libs.filter((lib) => lib === 'dom' || lib.startsWith('dom.'));

        return dom.length > 0
          ? [`${basename(dir)}/${basename(configPath)} -> [${libs.join(', ')}]`]
          : [];
      }),
    );

    expect(offenders).toEqual([]);
  });

  it('never pulls the dom lib in through a reference directive in source', () => {
    const offenders = projectDirs.flatMap((dir) =>
      readdirSync(join(dir, 'src'))
        .filter((name) => /\.(?:ts|mts|cts)$/u.test(name) && !name.includes('.spec.'))
        .filter((name) =>
          /reference\s+lib=["']dom(?:\.iterable)?["']/u.test(
            readFileSync(join(dir, 'src', name), 'utf8'),
          ),
        )
        .map((name) => `${basename(dir)}/src/${name}`),
    );

    expect(offenders).toEqual([]);
  });
});
