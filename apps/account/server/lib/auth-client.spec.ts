/**
 * Unit test cho `server/lib/auth-client.ts` — signing, phân loại lỗi fail-closed
 * và shape-check response trước khi coi là thành công.
 *
 * Binding được stub bằng một object `fetch` đúng chữ ký — cùng cách `apps/auth`
 * test phía `AccountClient`: Service Binding là biên transport, biên đáng tin
 * duy nhất là HTTP fetch. Chữ ký được kiểm bằng `verifyRequest` **thật** của
 * `@ecoma-io/auth-contracts` với cùng secret — một test chỉ kiểm "có ba
 * header nào đó" là không chứng minh được gì.
 */

import { describe, expect, it } from 'vitest';

import {
  createNonce,
  DEFAULT_SKEW_SECONDS,
  signRequest,
  verifyRequest,
} from '@ecoma-io/internal-auth-contracts';

import {
  announceSessionVerified,
  AUTH_SERVICE_BINDING_NAME,
  authServiceBinding,
  AUTH_TIMEOUT_MS,
  fetchConnectedApplications,
  fetchConsentContext,
  revokeConnectedApplication,
  submitConsentDecision,
} from './auth-client';

const SECRET = 'test-internal-hmac-secret-0123456789abcdef';
const NOW_MS = 1_700_000_000_000;

/** Capture binding — ghi lại request, trả response do test chỉ định. */
function stubBinding(respond: (request: Request) => Response | Promise<Response>): {
  binding: { fetch: (input: Request, init?: RequestInit) => Promise<Response> };
  requests: Request[];
} {
  const requests: Request[] = [];
  return {
    requests,
    binding: {
      fetch: async (input: Request, init?: RequestInit) => {
        requests.push(input);
        void init;
        return respond(input);
      },
    },
  };
}

const BASE_REQUEST = {
  handle: 'X-handle',
  sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  acr: 'urn:ecoma:acr:email-otp' as const,
  authn_at: NOW_MS,
  account_session_ref: 'ref-x',
  event_id: 'session_verified:ref-x',
} as const;

function sessionVerifiedBody(): Record<string, unknown> {
  return {
    outcome: 'consent_required',
    continue_url: 'https://account.test/consent?handle=handle-Y',
  };
}

describe('authServiceBinding', () => {
  it('returns null when the runtime config has no binding', () => {
    expect(authServiceBinding({})).toBeNull();
    expect(authServiceBinding(undefined)).toBeNull();
    expect(authServiceBinding({ cloudflare: { env: {} } })).toBeNull();
  });

  it('returns null when the binding shape is wrong (no fetch function)', () => {
    expect(authServiceBinding({ cloudflare: { env: { AUTH_SERVICE: {} } } })).toBeNull();
    expect(
      authServiceBinding({
        cloudflare: { env: { AUTH_SERVICE: { fetch: 'no' } } },
      }),
    ).toBeNull();
  });

  it('resolves a well-shaped binding under the contract binding name', () => {
    const binding = { fetch: async () => new Response(null, { status: 204 }) };
    expect(authServiceBinding({ cloudflare: { env: { AUTH_SERVICE: binding } } })).toBe(binding);
    // Tên binding là contract với hạ tầng (Workstream E khai trong wrangler.jsonc).
    // Khoá tên ở đây để một sự đổi tên lệch nhìn thấy được ở code review thay vì
    // ở production (mọi caller fail-closed `binding_missing` lúc runtime).
    expect(AUTH_SERVICE_BINDING_NAME).toBe('AUTH_SERVICE');
    expect(AUTH_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('announceSessionVerified', () => {
  it('classifies 503 as auth_unavailable (auth is failing closed itself)', async () => {
    const binding = { fetch: async () => new Response('{}', { status: 503 }) };
    const result = await announceSessionVerified({
      binding,
      signingKey: SECRET,
      request: BASE_REQUEST,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'auth_unavailable',
      detail: '503',
    });
  });

  it('classifies 4xx as rejected (invalid_grant / invalid_payload / forbidden)', async () => {
    for (const status of [400, 401, 404, 422] as const) {
      const binding = { fetch: async () => new Response('{}', { status }) };
      const result = await announceSessionVerified({
        binding,
        signingKey: SECRET,
        request: BASE_REQUEST,
        nowMs: NOW_MS,
      });
      expect(result).toEqual({
        ok: false,
        reason: 'rejected',
        detail: String(status),
      });
    }
  });

  it('fails closed with binding_missing and never calls fetch', async () => {
    const { requests } = stubBinding(() => new Response('{}'));
    const result = await announceSessionVerified({
      binding: null,
      signingKey: SECRET,
      request: BASE_REQUEST,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'binding_missing' });
    expect(requests).toHaveLength(0);
  });

  it('sends a properly signed envelope that the real verifier accepts', async () => {
    let capturedRequest: Request | undefined;
    let capturedInit: RequestInit | undefined;
    const binding = {
      fetch: async (input: Request, init?: RequestInit) => {
        capturedRequest = input;
        capturedInit = init;
        return new Response(JSON.stringify(sessionVerifiedBody()), {
          status: 200,
        });
      },
    };
    const result = await announceSessionVerified({
      binding,
      signingKey: SECRET,
      request: BASE_REQUEST,
      nowMs: NOW_MS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || capturedRequest === undefined) {
      throw new Error('expected an ok result and the fetch to be recorded');
    }

    // Path là route nội bộ của auth; method POST; JSON; có timeout signal.
    expect(new URL(capturedRequest.url).pathname).toBe('/internal/session/verified');
    expect(capturedRequest.method).toBe('POST');
    expect(capturedRequest.headers.get('content-type')).toBe('application/json');
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);

    // Verify bằng chính lib: cùng secret, cùng timestamp, đúng byte body.
    const bodyBytes = new Uint8Array(await capturedRequest.clone().arrayBuffer());
    const verification = await verifyRequest({
      method: 'POST',
      path: '/internal/session/verified',
      body: bodyBytes,
      // Truyền Headers trực tiếp — `readHeader` nhận `Headers` của Workers.
      headers: capturedRequest.headers,
      secret: SECRET,
      now: String(Math.floor(NOW_MS / 1000)),
      skewSeconds: DEFAULT_SKEW_SECONDS,
      claimNonce: async () => false,
    });
    expect(verification.ok).toBe(true);
  });

  it('classifies transport failure as unreachable', async () => {
    const binding = {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    };
    const result = await announceSessionVerified({
      binding,
      signingKey: SECRET,
      request: BASE_REQUEST,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects a 200 with a foreign shape instead of treating it as success', async () => {
    const binding = {
      fetch: async () => new Response(JSON.stringify({ status: 'all good' }), { status: 200 }),
    };
    const result = await announceSessionVerified({
      binding,
      signingKey: SECRET,
      request: BASE_REQUEST,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_response',
      detail: 'session_verified_shape',
    });
  });

  it('classifies a 200 with a non-JSON body as invalid_response, not unreachable', async () => {
    // postSignedJson chia nhánh hai lần trên đường 200: parse JSON hỏng phải
    // là `non_json_body`, không được rơi cùng nhóm với lỗi network (`unreachable`
    // — auth không trả lời) lẫn nhóm auth từ chối (`rejected`): route map 502
    // cho lý do đầu, 502 khác cho thứ hai, và một HTML error page của proxy
    // giữa là "auth trả rác" chứ không phải "auth chết".
    const binding = {
      fetch: async () => new Response('<html>gateway error</html>', { status: 200 }),
    };
    const result = await announceSessionVerified({
      binding,
      signingKey: SECRET,
      request: BASE_REQUEST,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_response',
      detail: 'non_json_body',
    });
  });

  it('classifies an empty 200 body the same way (invalid_response, non_json_body)', async () => {
    // Response 200 với body rỗng (204-style do proxy dựng lại) đi qua nhánh
    // parse-JSON: `response.json()` ném trên chuỗi rỗng, cùng `non_json_body`.
    const binding = {
      fetch: async () => new Response('', { status: 200 }),
    };
    const result = await announceSessionVerified({
      binding,
      signingKey: SECRET,
      request: BASE_REQUEST,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_response',
      detail: 'non_json_body',
    });
  });

  it('rejects a 200 with a relative continue_url (contract is absolute)', async () => {
    const body = { outcome: 'granted', continue_url: '/login/continue' };
    const binding = {
      fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
    };
    const result = await announceSessionVerified({
      binding,
      signingKey: SECRET,
      request: BASE_REQUEST,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_response',
      detail: 'session_verified_shape',
    });
  });

  it('accepts already_processed without continue_url (caller decides retry semantics)', async () => {
    const binding = {
      fetch: async () => new Response('{"outcome":"already_processed"}', { status: 200 }),
    };
    const result = await announceSessionVerified({
      binding,
      signingKey: SECRET,
      request: BASE_REQUEST,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      ok: true,
      value: { outcome: 'already_processed' },
    });
  });

  it('rejects granted/consent_required without an absolute continue_url (fail-closed)', async () => {
    // Không có `continue_url` thì account không có gì để 302 browser tới — một
    // body không có URL không được coi là thành công (`ok` không đường đi).
    const bodies = [
      { outcome: 'granted' },
      { outcome: 'consent_required' },
      { outcome: 'granted', continue_url: null },
    ] as const;
    for (const body of bodies) {
      const binding = {
        fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
      };
      const result = await announceSessionVerified({
        binding,
        signingKey: SECRET,
        request: BASE_REQUEST,
        nowMs: NOW_MS,
      });
      expect(result).toEqual({
        ok: false,
        reason: 'invalid_response',
        detail: 'session_verified_shape',
      });
    }
  });

  it('rejects already_processed that carries a continue_url (no continuation to give)', async () => {
    // Contract §5.1.1: `already_processed` không có continuation — auth trả
    // `transaction_state`, không trả URL. Có URL là shape lạ; xếp
    // `invalid_response` thay vì relay URL không có định nghĩa.
    const bodies = [
      {
        outcome: 'already_processed',
        continue_url: 'https://account.test/consent',
      },
      { outcome: 'already_processed', continue_url: '/relative' },
    ] as const;
    for (const body of bodies) {
      const binding = {
        fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
      };
      const result = await announceSessionVerified({
        binding,
        signingKey: SECRET,
        request: BASE_REQUEST,
        nowMs: NOW_MS,
      });
      expect(result).toEqual({
        ok: false,
        reason: 'invalid_response',
        detail: 'session_verified_shape',
      });
    }
  });
});

describe('fetchConsentContext', () => {
  it('maps a valid 200 to the contract response', async () => {
    const binding = {
      fetch: async () =>
        new Response(
          JSON.stringify({
            client_name: 'Ecoma Docs',
            scope: ['profile:read'],
            risk_level: 'low',
          }),
          { status: 200 },
        ),
    };
    const result = await fetchConsentContext({
      binding,
      signingKey: SECRET,
      request: { handle: 'Y', account_session_ref: 'ref-9' },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        client_name: 'Ecoma Docs',
        scope: ['profile:read'],
        risk_level: 'low',
      },
    });
  });

  it('returns binding_missing without fetch when the config has no binding', async () => {
    const result = await fetchConsentContext({
      binding: null,
      signingKey: SECRET,
      request: { handle: 'Y', account_session_ref: 'ref-10' },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'binding_missing' });
  });

  it('rejects a 404 (invalid_grant, unknown handle) with a dedicated reason', async () => {
    const binding = { fetch: async () => new Response('{}', { status: 404 }) };
    const result = await fetchConsentContext({
      binding,
      signingKey: SECRET,
      request: { handle: 'Y', account_session_ref: 'ref-11' },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'rejected', detail: '404' });
  });

  it('rejects a foreign 200 shape', async () => {
    const binding = {
      fetch: async () => new Response('{"yes":true}', { status: 200 }),
    };
    const result = await fetchConsentContext({
      binding,
      signingKey: SECRET,
      request: { handle: 'Y', account_session_ref: 'ref-12' },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_response',
      detail: 'consent_context_shape',
    });
  });
});

describe('submitConsentDecision', () => {
  it('maps both approved and denied outcomes as success with a continue_url', async () => {
    for (const outcome of ['approved', 'denied'] as const) {
      const binding = {
        fetch: async () =>
          new Response(
            JSON.stringify({
              outcome,
              continue_url: 'https://rp.test/callback',
            }),
            {
              status: 200,
            },
          ),
      };
      const result = await submitConsentDecision({
        binding,
        signingKey: SECRET,
        request: {
          handle: 'Y',
          decision: 'approve',
          account_session_ref: 'ref-13',
        },
        nowMs: NOW_MS,
      });
      expect(result).toEqual({
        ok: true,
        value: { outcome, continue_url: 'https://rp.test/callback' },
      });
    }
  });

  it('returns binding_missing without fetch when the config has no binding', async () => {
    const result = await submitConsentDecision({
      binding: null,
      signingKey: SECRET,
      request: { handle: 'Y', decision: 'deny', account_session_ref: 'ref-14' },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'binding_missing' });
  });

  it('rejects a decide response without continue_url', async () => {
    const binding = {
      fetch: async () => new Response('{"outcome":"approved"}', { status: 200 }),
    };
    const result = await submitConsentDecision({
      binding,
      signingKey: SECRET,
      request: {
        handle: 'Y',
        decision: 'approve',
        account_session_ref: 'ref-15',
      },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_response',
      detail: 'consent_decide_shape',
    });
  });
});

describe('fetchConnectedApplications', () => {
  const validBody = {
    applications: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        client_id: 'client-abc',
        client_name: 'Ecoma Docs',
        granted_at: 1_700_000_000_000,
        scopes: ['profile:read'],
      },
    ],
  };

  it('maps a valid 200 to the contract response with every grant checked', async () => {
    const binding = {
      fetch: async () => new Response(JSON.stringify(validBody), { status: 200 }),
    };
    const result = await fetchConnectedApplications({
      binding,
      signingKey: SECRET,
      request: { sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true, value: validBody });
  });

  it('returns binding_missing without fetch when the config has no binding', async () => {
    const { requests } = stubBinding(() => new Response('{}'));
    const result = await fetchConnectedApplications({
      binding: null,
      signingKey: SECRET,
      request: { sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'binding_missing' });
    expect(requests).toHaveLength(0);
  });

  it('signs the envelope for the connected-applications path', async () => {
    let capturedRequest: Request | undefined;
    const binding = {
      fetch: async (input: Request) => {
        capturedRequest = input;
        return new Response(JSON.stringify({ applications: [] }), { status: 200 });
      },
    };
    const result = await fetchConnectedApplications({
      binding,
      signingKey: SECRET,
      request: { sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true, value: { applications: [] } });
    expect(new URL(capturedRequest?.url ?? 'https://x/').pathname).toBe(
      '/internal/connected-applications',
    );
  });

  it('classifies 4xx and 503 like every other internal call', async () => {
    for (const [status, expected] of [
      [400, 'rejected'],
      [404, 'rejected'],
      [503, 'auth_unavailable'],
    ] as const) {
      const binding = { fetch: async () => new Response('{}', { status }) };
      const result = await fetchConnectedApplications({
        binding,
        signingKey: SECRET,
        request: { sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        nowMs: NOW_MS,
      });
      expect(result).toEqual({ ok: false, reason: expected, detail: String(status) });
    }
  });

  it('rejects a 200 whose grant entries miss required fields (fail-closed)', async () => {
    const bodies = [
      { applications: 'not-an-array' },
      { applications: [{ id: 'only-id' }] },
      {
        applications: [
          {
            id: 'g1',
            client_id: 'c1',
            client_name: 'n',
            granted_at: 'not-a-number',
            scopes: [],
          },
        ],
      },
      {
        applications: [
          { id: 'g1', client_id: 'c1', client_name: 'n', granted_at: 1, scopes: [42] },
        ],
      },
      {},
    ] as const;
    for (const body of bodies) {
      const binding = {
        fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
      };
      const result = await fetchConnectedApplications({
        binding,
        signingKey: SECRET,
        request: { sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        nowMs: NOW_MS,
      });
      expect(result).toEqual({
        ok: false,
        reason: 'invalid_response',
        detail: 'connected_applications_shape',
      });
    }
  });
});

describe('revokeConnectedApplication', () => {
  it('maps a valid 200 revoked outcome as success', async () => {
    const binding = {
      fetch: async () => new Response(JSON.stringify({ outcome: 'revoked' }), { status: 200 }),
    };
    const result = await revokeConnectedApplication({
      binding,
      signingKey: SECRET,
      request: {
        sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        grant_id: '11111111-1111-4111-8111-111111111111',
      },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true, value: { outcome: 'revoked' } });
  });

  it('returns binding_missing without fetch when the config has no binding', async () => {
    const result = await revokeConnectedApplication({
      binding: null,
      signingKey: SECRET,
      request: {
        sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        grant_id: '11111111-1111-4111-8111-111111111111',
      },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'binding_missing' });
  });

  it('surfaces 404 invalid_grant as a rejected business result (caller maps idempotency)', async () => {
    const binding = { fetch: async () => new Response('{}', { status: 404 }) };
    const result = await revokeConnectedApplication({
      binding,
      signingKey: SECRET,
      request: {
        sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        grant_id: '11111111-1111-4111-8111-111111111111',
      },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'rejected', detail: '404' });
  });

  it('rejects a 200 without the revoked outcome', async () => {
    const binding = { fetch: async () => new Response('{"outcome":"nope"}', { status: 200 }) };
    const result = await revokeConnectedApplication({
      binding,
      signingKey: SECRET,
      request: {
        sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        grant_id: '11111111-1111-4111-8111-111111111111',
      },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_response',
      detail: 'connected_application_revoke_shape',
    });
  });
});

// sanity: một envelope đúng secret verify ngoài một envelope sai secret là lệch —
// dùng đúng cặp sign/verify của lib làm đối chứng (không so chuỗi signature thủ công).
describe('envelope cross-check with the real signer', () => {
  it('verifies a hand-signed envelope and keeps a different-secret one invalid', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ probe: true }));
    const good = await signRequest({
      method: 'POST',
      path: '/internal/session/verified',
      body,
      secret: SECRET,
      timestamp: String(Math.floor(NOW_MS / 1000)),
      nonce: createNonce(),
    });
    const goodVerify = await verifyRequest({
      method: 'POST',
      path: '/internal/session/verified',
      body,
      headers: good,
      secret: SECRET,
      now: String(Math.floor(NOW_MS / 1000)),
      claimNonce: async () => false,
    });
    expect(goodVerify.ok).toBe(true);

    const wrongSecret = await signRequest({
      method: 'POST',
      path: '/internal/session/verified',
      body,
      secret: 'another-secret-0123456789abcdef012345678',
      timestamp: String(Math.floor(NOW_MS / 1000)),
      nonce: createNonce(),
    });
    const wrongVerify = await verifyRequest({
      method: 'POST',
      path: '/internal/session/verified',
      body,
      headers: wrongSecret,
      secret: SECRET,
      now: String(Math.floor(NOW_MS / 1000)),
      claimNonce: async () => false,
    });
    expect(wrongVerify).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
