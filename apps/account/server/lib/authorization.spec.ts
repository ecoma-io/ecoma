/**
 * Unit test cho `server/lib/authorization.ts` — cổng hỏi verdict của
 * `staff-access` (ADR-0030 Quyết định 3, ADR-0033 Quyết định 3).
 *
 * Neo ba thứ là **hợp đồng**:
 * 1. literal permission (ADR-0010),
 * 2. hình dạng request thật sự đi trên dây — envelope HMAC verify được bằng
 *    đúng secret của path này, `actorSub` nằm **trong** chuỗi ký (không phải
 *    body), và `correlation_id` của caller đi nguyên văn xuống cho audit,
 * 3. fail-closed: mọi nhánh không phải verdict `200` đều là `unavailable`.
 */

import { describe, expect, it } from 'vitest';
import { verifyRequest } from '@ecoma-io/internal-auth-contracts';

import { authorizeInvitationIssuance, INVITATION_CREATE_PERMISSION } from './authorization';
import { STAFF_ACCESS_VERDICT_PATH, type StaffAccessServiceBinding } from './staff-access-client';

const SECRET = 'test-staff-access-internal-secret-0123456789';
const CORRELATION_ID = '7d0f0e0a-4b0c-4b6e-9a3e-1e6c1f2b3c4d';
const ACTOR_SUB = `sub_${'o'.repeat(32)}`;
const STAFF_ID = 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b';

/** `runtimeConfig` tối thiểu: binding giả + secret của path này. */
function configWith(binding: StaffAccessServiceBinding | null): unknown {
  return {
    staffAccessInternalAuthSecret: SECRET,
    cloudflare: { env: binding === null ? {} : { STAFF_ACCESS_SERVICE: binding } },
  };
}

interface ObservedRequest {
  readonly actorSub: string | null;
  readonly permission: string;
  readonly correlation_id: string;
}

/** Binding giả: verify envelope thật rồi mới trả response của handler. */
function verifyingBinding(handler: (observed: ObservedRequest) => Response | Promise<Response>): {
  binding: StaffAccessServiceBinding;
  observed: () => ObservedRequest | null;
} {
  let observed: ObservedRequest | null = null;
  const binding: StaffAccessServiceBinding = {
    fetch: async (request) => {
      const text = await request.text();
      const verified = await verifyRequest({
        method: request.method,
        path: new URL(request.url).pathname,
        body: new TextEncoder().encode(text),
        headers: request.headers,
        secret: SECRET,
        now: String(Math.floor(Date.now() / 1000)),
        // Nonce store của fake: luôn "chưa bị chiếm". Phần chống replay của
        // envelope là hợp đồng của `@ecoma-io/internal-auth-contracts` (đã có
        // test riêng); ở đây chỉ cần verify chữ ký và đọc `actorSub`.
        claimNonce: async () => false,
      });
      if (!verified.ok) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      }
      const parsed = JSON.parse(text) as { permission?: string; correlation_id?: string };
      observed = {
        actorSub: verified.actorSub,
        permission: parsed.permission ?? '',
        correlation_id: parsed.correlation_id ?? '',
      };
      return handler(observed);
    },
  };
  return { binding, observed: () => observed };
}

describe('invitation.create permission literal', () => {
  it('follows the domain.action naming rule of ADR-0010', () => {
    // Nửa domain là resource noun (`invitation`), nửa action là verb (`create`).
    expect(INVITATION_CREATE_PERMISSION).toBe('invitation.create');
    const dotCount = (INVITATION_CREATE_PERMISSION.match(/\./gu) ?? []).length;
    expect(dotCount).toBe(1);
    expect(INVITATION_CREATE_PERMISSION).not.toMatch(/[*]/u);
  });
});

describe('authorizeInvitationIssuance', () => {
  it('fails closed with not_configured when the binding is missing', async () => {
    const verdict = await authorizeInvitationIssuance({
      runtimeConfig: configWith(null),
      actorSub: ACTOR_SUB,
      correlationId: CORRELATION_ID,
    });
    expect(verdict).toEqual({
      verdict: 'unavailable',
      reason: 'authorization_surface_not_configured',
    });
  });

  it('fails closed with not_configured when the path secret is missing', async () => {
    const { binding } = verifyingBinding(
      () => new Response(JSON.stringify({ verdict: 'allowed', actor_staff_id: STAFF_ID })),
    );
    const verdict = await authorizeInvitationIssuance({
      runtimeConfig: {
        cloudflare: { env: { STAFF_ACCESS_SERVICE: binding } },
        staffAccessInternalAuthSecret: '',
      },
      actorSub: ACTOR_SUB,
      correlationId: CORRELATION_ID,
    });
    expect(verdict).toEqual({
      verdict: 'unavailable',
      reason: 'authorization_surface_not_configured',
    });
  });

  it('sends a verifiable envelope carrying actorSub in the signature and returns allowed', async () => {
    const { binding, observed } = verifyingBinding(
      () =>
        new Response(JSON.stringify({ verdict: 'allowed', actor_staff_id: STAFF_ID }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const verdict = await authorizeInvitationIssuance({
      runtimeConfig: configWith(binding),
      actorSub: ACTOR_SUB,
      correlationId: CORRELATION_ID,
    });
    expect(verdict).toEqual({ verdict: 'allowed', actorStaffId: STAFF_ID });
    // Ba thứ route phát lời mời dựa vào: đúng permission, đúng correlation_id do
    // account sinh (để hàng audit ở staff-access truy được), actorSub trong chữ ký.
    expect(observed()).toEqual({
      actorSub: ACTOR_SUB,
      permission: INVITATION_CREATE_PERMISSION,
      correlation_id: CORRELATION_ID,
    });
  });

  it('maps a denied verdict to denied without inventing an actor identity', async () => {
    const { binding } = verifyingBinding(
      () =>
        new Response(JSON.stringify({ verdict: 'denied', actor_staff_id: STAFF_ID }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const verdict = await authorizeInvitationIssuance({
      runtimeConfig: configWith(binding),
      actorSub: ACTOR_SUB,
      correlationId: CORRELATION_ID,
    });
    expect(verdict).toEqual({ verdict: 'denied' });
  });

  it('treats a transport failure as unreachable — never as a verdict', async () => {
    const binding: StaffAccessServiceBinding = {
      fetch: () => Promise.reject(new Error('connection refused')),
    };
    const verdict = await authorizeInvitationIssuance({
      runtimeConfig: configWith(binding),
      actorSub: ACTOR_SUB,
      correlationId: CORRELATION_ID,
    });
    expect(verdict).toEqual({
      verdict: 'unavailable',
      reason: 'authorization_surface_unreachable',
    });
  });

  it('treats a 503 from staff-access as unreachable', async () => {
    const binding: StaffAccessServiceBinding = {
      fetch: () => Promise.resolve(new Response('{}', { status: 503 })),
    };
    const verdict = await authorizeInvitationIssuance({
      runtimeConfig: configWith(binding),
      actorSub: ACTOR_SUB,
      correlationId: CORRELATION_ID,
    });
    expect(verdict).toEqual({
      verdict: 'unavailable',
      reason: 'authorization_surface_unreachable',
    });
  });

  it('does not turn the 403 "actor is not an active staff member" into a denied verdict', async () => {
    // Một `denied` phải có hàng audit ở staff-access (ADR-0023 Quyết định 6);
    // `403` của middleware không có hàng đó, nên nó là "không hỏi được verdict".
    const binding: StaffAccessServiceBinding = {
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })),
    };
    const verdict = await authorizeInvitationIssuance({
      runtimeConfig: configWith(binding),
      actorSub: ACTOR_SUB,
      correlationId: CORRELATION_ID,
    });
    expect(verdict).toEqual({
      verdict: 'unavailable',
      reason: 'authorization_surface_rejected',
    });
  });

  it('treats a 200 with a body outside the contract as invalid_response', async () => {
    for (const body of [
      { verdict: 'maybe', actor_staff_id: STAFF_ID },
      { verdict: 'allowed' },
      { verdict: 'allowed', actor_staff_id: '' },
      { verdict: 'allowed', actor_staff_id: STAFF_ID, extra: true },
      'not-an-object',
    ]) {
      const binding: StaffAccessServiceBinding = {
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          ),
      };
      const verdict = await authorizeInvitationIssuance({
        runtimeConfig: configWith(binding),
        actorSub: ACTOR_SUB,
        correlationId: CORRELATION_ID,
      });
      expect(verdict).toEqual({
        verdict: 'unavailable',
        reason: 'authorization_surface_invalid_response',
      });
    }
  });

  it('never returns allowed when the wire body is unreadable', async () => {
    const binding: StaffAccessServiceBinding = {
      fetch: () => Promise.resolve(new Response('not json', { status: 200 })),
    };
    const verdict = await authorizeInvitationIssuance({
      runtimeConfig: configWith(binding),
      actorSub: ACTOR_SUB,
      correlationId: CORRELATION_ID,
    });
    expect(verdict.verdict).toBe('unavailable');
  });

  it('posts to the contract path', () => {
    // Path là một phần của chuỗi ký; một hằng sai làm mọi envelope lệch.
    expect(STAFF_ACCESS_VERDICT_PATH).toBe('/authorization/verdict');
  });
});
