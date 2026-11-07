/**
 * Unit test cho lớp đọc principal của `apps/backoffice` — principal chỉ đến
 * từ **server-side context**, và context vắng thì fail closed với `401`
 * (ADR-0011 §3 — middleware authn là nguồn principal; 503 dành cho JWKS/DB
 * outage, không cho "credential vắng").
 *
 * ⚠️ Test này ghim đúng ranh giới T-10 (confused deputy): route **không** được
 * đọc danh tính từ header/query/body do client kiểm soát. Ở đây chỉ chứng
 * minh là context vắng thì không có đường nào lấy được danh tính từ đâu khác.
 */

import type { H3Event } from 'h3';
import { describe, expect, it } from 'vitest';

import { BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS } from '@ecoma-io/backoffice-domain';

import { PRINCIPAL_CONTEXT_KEY, readPrincipal, requirePrincipal } from './principal';

/**
 * Account ID hợp lệ theo `isBackofficeAccountId`: prefix `sub_` + phần entropy
 * đúng độ dài mà producer (`account`) phát hành.
 *
 * ⚠️ Độ dài lấy từ hằng `BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS` chứ không viết
 * literal: `isBackofficeAccountId` từ chối mọi `sub` khác độ dài, nên một
 * literal lệch (52 ký tự — format local cũ đã bị gỡ ở F1, issue #101) làm
 * `readPrincipal` trả `null` ⇒ `requirePrincipal` ném `401` ⇒ mọi test ở đây
 * đỏ **vì lý do sai**.
 */
const VALID_SUB = `sub_${'a'.repeat(BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS)}`;

/** Event giả — chỉ cần `context`, đúng phần mà module này đọc. */
function fakeEvent(context: Record<string, unknown>): H3Event {
  return { context } as unknown as H3Event;
}

describe('readPrincipal', () => {
  it('reads a well-formed principal from the server-side context', () => {
    expect(readPrincipal(fakeEvent({ [PRINCIPAL_CONTEXT_KEY]: { actorSub: VALID_SUB } }))).toEqual({
      actorSub: VALID_SUB,
    });
  });

  it('returns null when the context carries no principal', () => {
    expect(readPrincipal(fakeEvent({}))).toBeNull();
    expect(readPrincipal(fakeEvent({ [PRINCIPAL_CONTEXT_KEY]: null }))).toBeNull();
    expect(readPrincipal(fakeEvent({ [PRINCIPAL_CONTEXT_KEY]: 'not-an-object' }))).toBeNull();
  });

  it('returns null when the principal sub is malformed', () => {
    // `requirePermission` kiểm lại lần nữa, nhưng lớp này không được đưa một
    // `sub` sai định dạng đi xa hơn.
    expect(
      readPrincipal(fakeEvent({ [PRINCIPAL_CONTEXT_KEY]: { actorSub: 'not-a-sub' } })),
    ).toBeNull();
    expect(readPrincipal(fakeEvent({ [PRINCIPAL_CONTEXT_KEY]: { actorSub: 42 } }))).toBeNull();
  });
});

describe('requirePrincipal', () => {
  it('fails closed with 401 when the context carries no principal (ADR-0011 §3)', () => {
    // ADR-0011 §3: middleware authn là nguồn principal duy nhất; context vắng
    // nghĩa là request không có credential hợp lệ ⇒ **401** (credential
    // missing/invalid), không phải 503 — 503 chỉ cho "không verify được lúc
    // này" (JWKS/DB outage) và đã được middleware xử lý trước khi tới route.
    expect(() => requirePrincipal(fakeEvent({}))).toThrowError(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it('does not read the identity from client-controlled input', () => {
    // Không có đường nào trong module này đọc header/query/body: context vắng
    // là fail closed, không phải "đọc sub ở đâu đó rồi đi tiếp".
    const event = fakeEvent({});
    expect(() => requirePrincipal(event)).toThrowError(
      expect.objectContaining({ statusCode: 401 }),
    );
  });
});
