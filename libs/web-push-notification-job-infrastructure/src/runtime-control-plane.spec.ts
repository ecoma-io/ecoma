// Kiểm chứng client của private delivery runtime API trên `Request`/`Response` thật của
// runtime (Node 24 có sẵn), không mock: phần lớn giá trị của suite nằm ở việc `Request`
// **thực sự** canonical hoá URL và `Headers` **thực sự** gộp/tách header — một fake tay
// không bắt được dot-segment hay header trùng tên.
// Nguồn canonical: docs/applications/push-notification/01-architecture.md §8.1 (bốn operation,
// `200`/`409` của claim, fenced write), §11 (contract violation → bounded retry → DLQ).

import { describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_API_SHARED_SECRET_ENV,
  RUNTIME_AUTH_HEADERS,
  RUNTIME_CALLER_PRINCIPAL,
  RUNTIME_PRINCIPAL_HEADER,
  RuntimeControlPlaneClient,
  resolveRuntimeSharedSecret,
  type RuntimeServiceBinding,
} from './runtime-control-plane';
import {
  RuntimeAuthResolutionError,
  RuntimeContractError,
  RuntimeTransportError,
} from '@ecoma-io/web-push-notification-job-application';

const SECRET = 'shared-secret-voi-dau-cau-hai-ben-phai-giong-nhau';
const DELIVERY_ID = 'del_01HQ0000000000000000000001';
const SUBSCRIPTION_ID = 'sub_01HQ0000000000000000000002';
const PROVIDER_ID = 'prov-webpush-eu';
const DISPATCH_GENERATION = 7;

const EXPIRES_AT = '2026-03-01T12:00:00.000Z';
const LEASE_EXPIRES_AT = '2026-03-01T11:05:00.000Z';

/** Body `200` của claim — đúng tập field của contracts, dựng tay để kiểm soát từng field. */
function claimBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    delivery_id: DELIVERY_ID,
    notification_id: 'ntf_01HQ0000000000000000000003',
    app: 'ecoma-web',
    status: 'processing',
    expires_at: EXPIRES_AT,
    dispatch_generation: DISPATCH_GENERATION,
    lease_expires_at: LEASE_EXPIRES_AT,
    transport: 'web',
    provider_id: PROVIDER_ID,
    subscription_id: SUBSCRIPTION_ID,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      p256dh: 'p256dh-public-key',
      auth: 'auth-secret',
      vapid_key_id: 'vapid-key-2026-01',
    },
    provider: {
      type: 'web-push',
      configuration: { vapidSubject: 'mailto:ops@ecoma.io' },
      credential: { privateKey: 'private', publicKey: 'public' },
    },
    ...overrides,
  };
}

type FetchCall = {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
};

/**
 * Binding giả — chỉ gom lại request để assert trên **đường dây thật**.
 *
 * ⚠️ `request.clone()` trước khi đọc body: `Response` thật sẽ không đọc lại được body đã
 * consume, và một test dùng chung handler cho nhiều lần gọi sẽ đọc body rỗng ở lần thứ hai —
 * đó là lỗi của test, không phải của client.
 */
function fakeBinding(
  handler: (request: Request, call: FetchCall) => Response | Promise<Response>,
): { binding: RuntimeServiceBinding; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const binding: RuntimeServiceBinding = {
    fetch: async (input: Request): Promise<Response> => {
      const clone = input.clone();
      const call: FetchCall = {
        url: clone.url,
        method: clone.method,
        headers: new Headers(clone.headers),
        body: clone.body === null ? null : await clone.text(),
      };
      calls.push(call);
      return handler(input, call);
    },
  };
  return { binding, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(
  handler: (request: Request, call: FetchCall) => Response | Promise<Response>,
  env: Record<string, unknown> = { [RUNTIME_API_SHARED_SECRET_ENV]: SECRET },
) {
  const { binding, calls } = fakeBinding(handler);
  return {
    client: new RuntimeControlPlaneClient({ binding, env }),
    calls,
  };
}

const okClaim = (): Response => jsonResponse(200, claimBody());

describe('resolveRuntimeSharedSecret', () => {
  it('returns the secret verbatim, without trimming a leading or trailing space', () => {
    const padded = `  ${SECRET} `;
    expect(resolveRuntimeSharedSecret({ [RUNTIME_API_SHARED_SECRET_ENV]: padded })).toBe(padded);
  });

  it.each([
    ['missing', {}],
    ['undefined', { [RUNTIME_API_SHARED_SECRET_ENV]: undefined }],
    ['empty', { [RUNTIME_API_SHARED_SECRET_ENV]: '' }],
    ['whitespace only', { [RUNTIME_API_SHARED_SECRET_ENV]: '   \n\t ' }],
    ['not a string', { [RUNTIME_API_SHARED_SECRET_ENV]: 12345 }],
    ['null', { [RUNTIME_API_SHARED_SECRET_ENV]: null }],
    ['object', { [RUNTIME_API_SHARED_SECRET_ENV]: { value: SECRET } }],
  ])('fails closed when the secret is %s', (_name, env) => {
    // Fail-closed là điều kiện: KHÔNG có đường nào trả `undefined` để call site tự quyết
    // định, vì chính quyết định "chưa cấu hình thì gửi không xác thực" là lỗ hổng.
    expect(() => resolveRuntimeSharedSecret(env)).toThrow(RuntimeAuthResolutionError);
  });

  it('names the variable so an operator can see which secret is missing, and never its value', () => {
    let message = '';
    try {
      resolveRuntimeSharedSecret({});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(RUNTIME_API_SHARED_SECRET_ENV);
    expect(message).not.toContain('undefined');
  });
});

describe('RuntimeControlPlaneClient request shape', () => {
  it('sends an empty body with no content-type on claim and invalidate', async () => {
    for (const invoke of [
      (client: RuntimeControlPlaneClient) => client.claim(DELIVERY_ID),
      (client: RuntimeControlPlaneClient) => client.invalidateSubscription(SUBSCRIPTION_ID),
    ]) {
      const { client, calls } = clientWith((request) =>
        request.url.endsWith('/claim')
          ? okClaim()
          : jsonResponse(200, { subscription_id: SUBSCRIPTION_ID, status: 'disabled' }),
      );
      await invoke(client);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body).toBeNull();
      expect(calls[0]?.headers.get('content-type')).toBeNull();
      expect(calls[0]?.method).toBe('POST');
    }
  });

  it('sends exactly dispatch_generation on release and dispatch_generation plus outcome on outcome', async () => {
    const { client, calls } = clientWith((request) =>
      request.url.endsWith('/release')
        ? jsonResponse(200, {
            delivery_id: DELIVERY_ID,
            status: 'queued',
            dispatch_generation: DISPATCH_GENERATION,
          })
        : jsonResponse(200, {
            delivery_id: DELIVERY_ID,
            status: 'delivered',
            dispatch_generation: DISPATCH_GENERATION,
          }),
    );

    await client.release(DELIVERY_ID, DISPATCH_GENERATION);
    await client.writeOutcome(DELIVERY_ID, DISPATCH_GENERATION, 'delivered');

    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({
      dispatch_generation: DISPATCH_GENERATION,
    });
    expect(JSON.parse(calls[1]?.body ?? 'null')).toEqual({
      dispatch_generation: DISPATCH_GENERATION,
      outcome: 'delivered',
    });
    for (const call of calls) {
      expect(call.headers.get('content-type')).toBe('application/json');
    }
  });

  // ⚠️ Docs §8.1 và control plane (`requireRuntime` trong `main.ts`) cùng đọc `authorization`
  // (giá trị nguyên văn, không `Bearer`). Từng có giai đoạn gửi thêm `x-ecoma-shared-secret`,
  // nhưng control plane không bao giờ đọc header đó — nó chỉ mở rộng bề mặt thu thập secret
  // nên đã bỏ. Test ghim **đúng một** header: một header thứ hai xuất hiện lại là đỏ tại đây.
  it('carries the shared secret under the authorization header and never a Bearer prefix', async () => {
    const { client, calls } = clientWith(() => okClaim());
    await client.claim(DELIVERY_ID);

    const call = calls[0];
    expect(RUNTIME_AUTH_HEADERS).toEqual(['authorization']);
    expect(call?.headers.get('authorization')).toBe(SECRET);
    // Header HTTP là case-insensitive: `Headers.get` phải đọc được dù gửi lowercase.
    expect(call?.headers.get('Authorization')).toBe(SECRET);
    expect(call?.headers.get('X-ECOMA-SHARED-SECRET')).toBeNull();
    expect(call?.headers.get(RUNTIME_PRINCIPAL_HEADER)).toBe(RUNTIME_CALLER_PRINCIPAL);
    expect(call?.headers.get('X-ECOMA-PRINCIPAL')).toBe(RUNTIME_CALLER_PRINCIPAL);
  });

  it('never sends the app identity as a header: claim is keyed by delivery_id', async () => {
    const { client, calls } = clientWith(() => okClaim());
    await client.claim(DELIVERY_ID);
    expect(calls[0]?.headers.get('x-ecoma-app')).toBeNull();
    expect(calls[0]?.headers.get('X-ECOMA-APP')).toBeNull();
  });

  it('builds the four routes from the identifier', async () => {
    const { client, calls } = clientWith((request) => {
      if (request.url.endsWith('/claim')) {
        return okClaim();
      }
      if (request.url.endsWith('/release')) {
        return jsonResponse(200, {
          delivery_id: DELIVERY_ID,
          status: 'queued',
          dispatch_generation: DISPATCH_GENERATION,
        });
      }
      if (request.url.endsWith('/outcome')) {
        return jsonResponse(200, {
          delivery_id: DELIVERY_ID,
          status: 'failed',
          dispatch_generation: DISPATCH_GENERATION,
        });
      }
      return jsonResponse(200, { subscription_id: SUBSCRIPTION_ID, status: 'disabled' });
    });

    await client.claim(DELIVERY_ID);
    await client.release(DELIVERY_ID, 1);
    await client.writeOutcome(DELIVERY_ID, 1, 'failed');
    await client.invalidateSubscription(SUBSCRIPTION_ID);

    const paths = calls.map((call) => new URL(call.url).pathname);
    expect(paths).toEqual([
      `/internal/deliveries/${DELIVERY_ID}/claim`,
      `/internal/deliveries/${DELIVERY_ID}/release`,
      `/internal/deliveries/${DELIVERY_ID}/outcome`,
      `/internal/subscriptions/${SUBSCRIPTION_ID}/invalidate`,
    ]);
  });

  it('encodes an identifier that would otherwise inject a path segment or query', async () => {
    const hostileId = '../../admin?x=1#frag';
    const { client, calls } = clientWith(() =>
      jsonResponse(200, { subscription_id: hostileId, status: 'disabled' }),
    );
    await client.invalidateSubscription(hostileId).catch(() => {
      // Ack mang subscription_id khác là contract error — không phải thứ suite này kiểm.
    });

    const call = calls[0];
    const url = call === undefined ? new URL('about:blank') : new URL(call.url);
    expect(url.pathname).not.toContain('/admin');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    // Dot-segment phải bị encode thành %2E%2E để URL parser không bỏ nó.
    expect(url.pathname.startsWith('/internal/subscriptions/')).toBe(true);
    expect(decodeURIComponent(url.pathname)).toBe(
      `/internal/subscriptions/${hostileId}/invalidate`,
    );
  });

  // `..` là điểm mà `encodeURIComponent` KHÔNG mã hoá nhưng URL parser lại bỏ — route trên
  // dây sẽ khác route dự kiến. Client phải fail-closed thay vì gửi tới route lạ.
  it('refuses to send when the identifier would change the canonical route of the request', async () => {
    const { client, calls } = clientWith(() =>
      jsonResponse(200, { subscription_id: 'sub_x', status: 'disabled' }),
    );
    await expect(client.invalidateSubscription('..')).rejects.toThrow(RuntimeContractError);
    expect(calls).toHaveLength(0);
  });

  it('never reaches the binding when the secret is missing', async () => {
    const binding = {
      fetch: vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(async () =>
        okClaim(),
      ),
    };
    const client = new RuntimeControlPlaneClient({ binding, env: {} });

    await expect(client.claim(DELIVERY_ID)).rejects.toThrow(RuntimeAuthResolutionError);
    await expect(client.release(DELIVERY_ID, 1)).rejects.toThrow(RuntimeAuthResolutionError);
    await expect(client.writeOutcome(DELIVERY_ID, 1, 'delivered')).rejects.toThrow(
      RuntimeAuthResolutionError,
    );
    await expect(client.invalidateSubscription(SUBSCRIPTION_ID)).rejects.toThrow(
      RuntimeAuthResolutionError,
    );
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it('re-resolves the secret per request so a secret added later starts working', async () => {
    const env: Record<string, unknown> = {};
    const { binding, calls } = fakeBinding(() => okClaim());
    const client = new RuntimeControlPlaneClient({ binding, env });

    await expect(client.claim(DELIVERY_ID)).rejects.toThrow(RuntimeAuthResolutionError);
    env[RUNTIME_API_SHARED_SECRET_ENV] = SECRET;
    await expect(client.claim(DELIVERY_ID)).resolves.toMatchObject({ kind: 'won' });
    expect(calls).toHaveLength(1);
  });

  it('wraps a binding that throws as a transport error, not a contract error', async () => {
    const client = new RuntimeControlPlaneClient({
      binding: {
        fetch: async (): Promise<Response> => {
          throw new Error('service binding unavailable');
        },
      },
      env: { [RUNTIME_API_SHARED_SECRET_ENV]: SECRET },
    });

    await expect(client.claim(DELIVERY_ID)).rejects.toThrow(RuntimeTransportError);
  });
});

describe('RuntimeControlPlaneClient claim', () => {
  it('returns the claim on 200 without losing a single field', async () => {
    const { client } = clientWith(() => jsonResponse(200, claimBody()));
    const result = await client.claim(DELIVERY_ID);

    expect(result.kind).toBe('won');
    if (result.kind !== 'won') {
      return;
    }
    expect(result.claim).toEqual(claimBody());
    expect(result.claim.subscription.auth).toBe('auth-secret');
    expect(result.claim.provider.credential).toEqual({
      privateKey: 'private',
      publicKey: 'public',
    });
  });

  // Gửi payload của delivery A tới endpoint của delivery B là vi phạm SR-002 (recipient
  // sai) — nên một `200` cho delivery_id khác là contract violation, không phải một claim hợp lệ.
  it('rejects a 200 that carries a different delivery_id than the one claimed', async () => {
    const { client } = clientWith(() =>
      jsonResponse(200, claimBody({ delivery_id: 'del_something_else' })),
    );
    const error = await client.claim(DELIVERY_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeContractError);
    expect((error as RuntimeContractError).reason).toBe('identity_mismatch');
  });

  it.each([
    'pending',
    'lease_held',
    'expired',
    'ineligible_subscription',
    'ineligible_provider_hold',
  ])('maps a 409 %s rejection to the port shape with no state field', async (reason) => {
    const { client } = clientWith(() => jsonResponse(409, { reason }));
    await expect(client.claim(DELIVERY_ID)).resolves.toEqual({
      kind: 'lost',
      rejection: { reason },
    });
  });

  it('maps a 409 terminal rejection and keeps its state', async () => {
    const { client } = clientWith(() =>
      jsonResponse(409, { reason: 'terminal', state: 'delivered' }),
    );
    await expect(client.claim(DELIVERY_ID)).resolves.toEqual({
      kind: 'lost',
      rejection: { reason: 'terminal', state: 'delivered' },
    });
  });

  it.each(['cancelled', 'unknown_reason', '', 'DELIVERED'])(
    'treats a 409 with reason %o as a contract violation instead of a safe no-op',
    async (reason) => {
      const { client } = clientWith(() => jsonResponse(409, { reason }));
      const error = await client.claim(DELIVERY_ID).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RuntimeContractError);
    },
  );

  it('rejects a 409 that leaks runtime material', async () => {
    const { client } = clientWith(() =>
      jsonResponse(409, { reason: 'lease_held', subscription: { endpoint: 'https://x' } }),
    );
    const error = await client.claim(DELIVERY_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeContractError);
  });

  it.each([
    ['401', 401, RuntimeAuthResolutionError],
    ['403', 403, RuntimeAuthResolutionError],
    ['500', 500, RuntimeTransportError],
    ['503', 503, RuntimeTransportError],
    ['400', 400, RuntimeContractError],
    ['404', 404, RuntimeContractError],
    ['429', 429, RuntimeContractError],
    ['302', 302, RuntimeContractError],
    // `204` không mang body được theo chuẩn nên `new Response('', {status:204})` tự ném ở
    // chính `Response` — đo bằng `200` với body rỗng, đúng cái mà claim 200 rỗng trông ra.
    ['200 empty', 200, RuntimeContractError],
  ])('classifies a %s claim response without a resolved kind', async (_name, status, expected) => {
    const { client } = clientWith(() =>
      status === 200 ? new Response('') : new Response('', { status }),
    );
    await expect(client.claim(DELIVERY_ID)).rejects.toThrow(expected);
  });

  it('treats an empty body as a contract violation, not a transport error', async () => {
    const { client } = clientWith(() => new Response('', { status: 200 }));
    const error = await client.claim(DELIVERY_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeContractError);
    expect((error as RuntimeContractError).reason).toBe('invalid_payload');
  });

  it('treats a non-JSON body as a contract violation', async () => {
    const { client } = clientWith(
      () => new Response('<html>502 Bad Gateway</html>', { status: 200 }),
    );
    const error = await client.claim(DELIVERY_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeContractError);
    expect((error as RuntimeContractError).reason).toBe('invalid_payload');
  });

  it('rejects a 200 that leaks the payload key, because envelope is the only payload source', async () => {
    const { client } = clientWith(() =>
      jsonResponse(200, { ...claimBody(), payload: { title: 'x' } }),
    );
    const error = await client.claim(DELIVERY_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeContractError);
    expect((error as RuntimeContractError).reason).toBe('runtime_material_leak');
  });

  it('rejects a 200 with an out-of-enum transport instead of sending to an unknown transport', async () => {
    const { client } = clientWith(() => jsonResponse(200, claimBody({ transport: 'sms' })));
    await expect(client.claim(DELIVERY_ID)).rejects.toThrow(RuntimeContractError);
  });

  it('never puts the endpoint or a secret from the response into an error message', async () => {
    const { client } = clientWith(() => jsonResponse(200, claimBody({ status: 'queued' })));
    const error = await client.claim(DELIVERY_ID).catch((caught: unknown) => caught);
    const message = (error as Error).message;
    expect(message).not.toContain('fcm.googleapis.com');
    expect(message).not.toContain('auth-secret');
    expect(message).not.toContain('p256dh-public-key');
    expect(message).not.toContain(SECRET);
  });
});

describe('RuntimeControlPlaneClient release and outcome', () => {
  it.each([
    [
      'release',
      (client: RuntimeControlPlaneClient) => client.release(DELIVERY_ID, DISPATCH_GENERATION),
    ],
    [
      'outcome',
      (client: RuntimeControlPlaneClient) =>
        client.writeOutcome(DELIVERY_ID, DISPATCH_GENERATION, 'delivered'),
    ],
  ])('accepts a valid %s 200 ack', async (_name, invoke) => {
    const status = _name === 'release' ? 'queued' : 'delivered';
    const { client } = clientWith(() =>
      jsonResponse(200, {
        delivery_id: DELIVERY_ID,
        status,
        dispatch_generation: DISPATCH_GENERATION,
      }),
    );
    await expect(invoke(client)).resolves.toEqual({ kind: 'applied' });
  });

  // ⚠️ `OutcomeAck` mang `status`, không phải `outcome` (docs §8.1). Đọc `ack.outcome` là
  // `undefined`, và mọi outcome `delivered` sẽ bị từ chối oan — nên identity check phải dùng
  // `status`.
  it('accepts an outcome 200 whose ack.status echoes the requested outcome', async () => {
    const { client } = clientWith(() =>
      jsonResponse(200, {
        delivery_id: DELIVERY_ID,
        status: 'failed',
        dispatch_generation: DISPATCH_GENERATION,
      }),
    );
    await expect(client.writeOutcome(DELIVERY_ID, DISPATCH_GENERATION, 'failed')).resolves.toEqual({
      kind: 'applied',
    });
  });

  it.each([
    [
      'a different delivery_id',
      { delivery_id: 'del_other', status: 'delivered', dispatch_generation: DISPATCH_GENERATION },
    ],
    [
      'a different outcome',
      { delivery_id: DELIVERY_ID, status: 'failed', dispatch_generation: DISPATCH_GENERATION },
    ],
  ])('rejects an outcome 200 echoing %s', async (_name, body) => {
    const { client } = clientWith(() => jsonResponse(200, body));
    const error = await client
      .writeOutcome(DELIVERY_ID, DISPATCH_GENERATION, 'delivered')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeContractError);
    expect((error as RuntimeContractError).reason).toBe('identity_mismatch');
  });

  it('maps a 409 stale_write to a safe rejection the pipeline can ack on', async () => {
    const { client } = clientWith(() => jsonResponse(409, { reason: 'stale_write' }));
    await expect(client.release(DELIVERY_ID, 1)).resolves.toEqual({
      kind: 'rejected',
      reason: 'stale_write',
    });
  });

  // ⚠️ `validateLeaseFencedRejection` **yêu cầu** `state` khi `reason = 'terminal'`, còn
  // control plane hiện trả `409 {reason}` không kèm `state`. Test ghim hành vi fail-closed:
  // nuốt thiếu `state` sẽ tạo một dialect thứ hai che mất một sai lệch đang tồn tại.
  it('treats a 409 terminal without state as a contract violation instead of a safe rejection', async () => {
    const { client } = clientWith(() => jsonResponse(409, { reason: 'terminal' }));
    const error = await client.release(DELIVERY_ID, 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeContractError);
  });

  it('accepts a 409 terminal that carries the required state', async () => {
    const { client } = clientWith(() => jsonResponse(409, { reason: 'terminal', state: 'failed' }));
    await expect(client.writeOutcome(DELIVERY_ID, 1, 'delivered')).resolves.toEqual({
      kind: 'rejected',
      reason: 'terminal',
    });
  });

  it.each(['pending', 'lease_held', 'expired'])(
    'treats a 409 %s on a fenced write as a contract violation',
    async (reason) => {
      const { client } = clientWith(() => jsonResponse(409, { reason }));
      await expect(client.release(DELIVERY_ID, 1)).rejects.toThrow(RuntimeContractError);
    },
  );

  it.each([
    [401, RuntimeAuthResolutionError],
    [403, RuntimeAuthResolutionError],
    [500, RuntimeTransportError],
    [418, RuntimeContractError],
  ])('classifies a %i release response', async (status, expected) => {
    const { client } = clientWith(() => new Response('', { status }));
    await expect(client.release(DELIVERY_ID, 1)).rejects.toThrow(expected);
  });
});

describe('RuntimeControlPlaneClient invalidate', () => {
  it('returns disabled on a valid 200 ack', async () => {
    const { client } = clientWith(() =>
      jsonResponse(200, { subscription_id: SUBSCRIPTION_ID, status: 'disabled' }),
    );
    await expect(client.invalidateSubscription(SUBSCRIPTION_ID)).resolves.toBe('disabled');
  });

  // Control plane trả `401` ở guard TRƯỚC lookup, nên một `404` tới đây đã là caller đã xác
  // thực mà subscription không tồn tại — tức `no_op`, không phải lỗi credential. Đọc sai hai
  // thứ đó là một lỗi phân loại khiến operator đi tìm secret sai.
  it('maps 404 to no_op rather than to an auth failure', async () => {
    const { client } = clientWith(() => new Response('', { status: 404 }));
    await expect(client.invalidateSubscription(SUBSCRIPTION_ID)).resolves.toBe('no_op');
  });

  it('maps 401 and 403 to auth_rejected so the metric separates credential from outage', async () => {
    for (const status of [401, 403]) {
      const { client } = clientWith(() => new Response('', { status }));
      await expect(client.invalidateSubscription(SUBSCRIPTION_ID)).resolves.toBe('auth_rejected');
    }
  });

  it('rejects a 200 ack whose subscription_id differs from the requested one', async () => {
    const { client } = clientWith(() =>
      jsonResponse(200, { subscription_id: 'sub_other', status: 'disabled' }),
    );
    const error = await client
      .invalidateSubscription(SUBSCRIPTION_ID)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeContractError);
    expect((error as RuntimeContractError).reason).toBe('identity_mismatch');
  });

  it('rejects a 200 ack whose status is not the canonical subscription status', async () => {
    const { client } = clientWith(() =>
      jsonResponse(200, { subscription_id: SUBSCRIPTION_ID, status: 'invalidated' }),
    );
    await expect(client.invalidateSubscription(SUBSCRIPTION_ID)).rejects.toThrow(
      RuntimeContractError,
    );
  });

  it('still throws a transport error for 5xx so the caller can log a transient fault', async () => {
    const { client } = clientWith(() => new Response('', { status: 502 }));
    await expect(client.invalidateSubscription(SUBSCRIPTION_ID)).rejects.toThrow(
      RuntimeTransportError,
    );
  });
});
