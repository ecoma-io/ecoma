import { expect, test } from '@playwright/test';

import {
  authOrigin,
  localRedirectUri,
  LOCAL_CLIENT_ID,
  makePkceChallenge,
  makePkceVerifier,
  stackGet,
  stackPostForm,
} from './support/local-origin';

/**
 * Các nhánh lỗi của glue `/authorize` — ranh giới redirectable/non-redirectable
 * là đối tượng kiểm chính, vì nó là biện pháp chống open redirect thật của
 * service (`libs/auth-domain/src/authorize-request.ts`,
 * `libs/auth-application/src/authorization-service.ts`).
 *
 * Thứ tự cố định của `beginAuthorization` quyết định thứ tự test:
 *   1. Parse request       → mọi lỗi là `directInvalidRequest` (JSON 400, KHÔNG redirect).
 *   2. Nạp client          → `invalid_client` (JSON 400/401, KHÔNG redirect).
 *   3. Client usable       → JSON, KHÔNG redirect.
 *   4. redirect_uri EXACT  → JSON, KHÔNG redirect (chính bước này là ranh giới).
 *   5. Từ đây trở đi       → redirectable: 302 `redirect_uri?error=…&state=…`.
 *
 * Lưu ý hạ tầng: mọi response 302/303 của test này đều trỏ tới
 * `redirect_uri` đã đăng ký (`office.<root>:<port>/api/auth/callback`) — test
 * dùng `stackGet` không theo redirect nên không bao giờ chạm backoffice thật.
 */

test.describe('authorize glue — non-redirectable errors (JSON direct)', () => {
  test('missing response_type is a JSON invalid_request without redirect', async () => {
    const origin = authOrigin();
    const verifier = makePkceVerifier();
    const response = await stackGet(
      `${origin}/authorize?client_id=${LOCAL_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(localRedirectUri())}` +
        `&scope=openid&code_challenge=${makePkceChallenge(verifier)}&code_challenge_method=S256`,
    );
    expect(response.status).toBe(400);
    expect(response.contentType).toContain('application/json');
    const body = JSON.parse(response.body) as { error?: string };
    expect(body['error']).toBe('invalid_request');
    // KHÔNG redirect: trước khi `redirect_uri` được xác minh, mọi đường redirect
    // là open redirect.
    expect(response.location).toBeUndefined();
  });

  test('unsupported response_type is a JSON invalid_request without redirect', async () => {
    const origin = authOrigin();
    const verifier = makePkceVerifier();
    const response = await stackGet(
      `${origin}/authorize?client_id=${LOCAL_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(localRedirectUri())}` +
        `&response_type=token&scope=openid` +
        `&code_challenge=${makePkceChallenge(verifier)}&code_challenge_method=S256`,
    );
    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error?: string };
    expect(body['error']).toBe('invalid_request');
    expect(response.location).toBeUndefined();
  });

  test('unknown client_id is a JSON invalid_client without redirect', async () => {
    const origin = authOrigin();
    const verifier = makePkceVerifier();
    const response = await stackGet(
      `${origin}/authorize?client_id=no-such-client` +
        `&redirect_uri=${encodeURIComponent(localRedirectUri())}` +
        `&response_type=code&scope=openid` +
        `&code_challenge=${makePkceChallenge(verifier)}&code_challenge_method=S256`,
    );
    // `invalid_client` của store (errors.ts) mang 401 — pin cả hai mã 400/401
    // để không giòn với tinh chỉnh status, nhưng BẮT BUỘC JSON + error code.
    expect([400, 401]).toContain(response.status);
    expect(response.contentType).toContain('application/json');
    const body = JSON.parse(response.body) as { error?: string };
    expect(body['error']).toBe('invalid_client');
    expect(response.location).toBeUndefined();
  });

  test('redirect_uri not exactly registered is a JSON invalid_request without redirect', async () => {
    const origin = authOrigin();
    const verifier = makePkceVerifier();
    // Client hợp lệ nhưng redirect_uri KHÁC exact string đã seed — chính hàm
    // assertRegisteredRedirectUri là ranh giới, lỗi của nó KHÔNG redirect được.
    const response = await stackGet(
      `${origin}/authorize?client_id=${LOCAL_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}` +
        `&response_type=code&scope=openid` +
        `&code_challenge=${makePkceChallenge(verifier)}&code_challenge_method=S256`,
    );
    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error?: string };
    expect(body['error']).toBe('invalid_request');
    expect(response.location).toBeUndefined();
  });

  test('missing code_challenge is a JSON invalid_request without redirect', async () => {
    const origin = authOrigin();
    const response = await stackGet(
      `${origin}/authorize?client_id=${LOCAL_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(localRedirectUri())}` +
        `&response_type=code&scope=openid&code_challenge_method=S256`,
    );
    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error?: string };
    expect(body['error']).toBe('invalid_request');
    expect(response.location).toBeUndefined();
  });

  test('missing code_challenge_method is a JSON invalid_request without redirect', async () => {
    const origin = authOrigin();
    const verifier = makePkceVerifier();
    // challenge CÓ nhưng method thiếu: `parseCodeChallenge` chạy với
    // `redirectable: false` trong parseAuthorizationRequest — lỗi PKCE ở giai
    // đoạn parse không bao giờ redirect. Pin đúng hợp đồng đó để chống hồi quy.
    const response = await stackGet(
      `${origin}/authorize?client_id=${LOCAL_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(localRedirectUri())}` +
        `&response_type=code&scope=openid&code_challenge=${makePkceChallenge(verifier)}`,
    );
    expect(response.status).toBe(400);
    expect(response.contentType).toContain('application/json');
    const body = JSON.parse(response.body) as { error?: string };
    expect(body['error']).toBe('invalid_request');
    expect(response.location).toBeUndefined();
  });

  test('empty scope is a JSON invalid_request without redirect', async () => {
    const origin = authOrigin();
    const verifier = makePkceVerifier();
    const response = await stackGet(
      `${origin}/authorize?client_id=${LOCAL_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(localRedirectUri())}` +
        `&response_type=code&scope=&state=st-neg-2` +
        `&code_challenge=${makePkceChallenge(verifier)}&code_challenge_method=S256`,
    );
    // parseScope từ chối scope rỗng TRONG parseAuthorizationRequest — trước
    // ranh giới, nên JSON trực tiếp chứ không phải redirect.
    expect(response.status).toBe(400);
    expect(response.contentType).toContain('application/json');
    const body = JSON.parse(response.body) as { error?: string };
    expect(body['error']).toBe('invalid_request');
    expect(response.location).toBeUndefined();
  });
});

test.describe('authorize glue — redirectable errors (after the boundary)', () => {
  test('disallowed scope redirects back with error=invalid_scope and echoes state', async () => {
    const origin = authOrigin();
    const verifier = makePkceVerifier();
    const redirectUri = localRedirectUri();
    const response = await stackGet(
      `${origin}/authorize?client_id=${LOCAL_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code&scope=${encodeURIComponent('openid admin')}&state=st-neg-1` +
        `&code_challenge=${makePkceChallenge(verifier)}&code_challenge_method=S256`,
    );
    // `filterAllowedScopes` với `redirectable: true` — đã qua ranh giới.
    expect(response.status).toBe(302);
    expect(response.location).toBeDefined();
    const target = new URL(response.location as string, origin);
    expect(target.origin + target.pathname).toBe(redirectUri);
    expect(target.searchParams.get('error')).toBe('invalid_scope');
    expect(target.searchParams.get('state')).toBe('st-neg-1');
  });
});

test.describe('token endpoint — negative paths', () => {
  test('rejects a token request with an unknown code as invalid_grant', async () => {
    const origin = authOrigin();
    const verifier = makePkceVerifier();
    const response = await stackPostForm(`${origin}/token`, {
      grant_type: 'authorization_code',
      code: 'not-a-real-code',
      redirect_uri: localRedirectUri(),
      client_id: LOCAL_CLIENT_ID,
      code_verifier: verifier,
    });
    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error?: string };
    expect(body['error']).toBe('invalid_grant');
  });

  test('rejects the client_credentials grant type as unsupported', async () => {
    const origin = authOrigin();
    const response = await stackPostForm(`${origin}/token`, {
      grant_type: 'client_credentials',
      client_id: LOCAL_CLIENT_ID,
    });
    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error?: string };
    expect(body['error']).toBe('unsupported_grant_type');
  });

  test('rejects a malformed PKCE verifier on code exchange', async () => {
    const origin = authOrigin();
    // Code giả + verifier sai hình dạng (quá ngắn) — provider từ chối ở validation
    // verifier trước khi lookup code; kết quả vẫn là 4xx protocol error.
    const response = await stackPostForm(`${origin}/token`, {
      grant_type: 'authorization_code',
      code: 'not-a-real-code',
      redirect_uri: localRedirectUri(),
      client_id: LOCAL_CLIENT_ID,
      code_verifier: 'short',
    });
    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error?: string };
    expect(['invalid_grant', 'invalid_request']).toContain(body['error']);
  });
});

test.describe('revocation endpoint — negative paths', () => {
  test('rejects a revocation request without client identification', async () => {
    const origin = authOrigin();
    const response = await stackPostForm(`${origin}/revocation`, {
      token: 'not-a-real-token',
    });
    // Public clients phải mang client_id; thiếu là 400/401 của provider.
    expect([400, 401]).toContain(response.status);
  });

  test('returns 200 for a well-formed revocation of an unknown token', async () => {
    const origin = authOrigin();
    // RFC 7009: revocation của token không tồn tại vẫn trả 200 — không lộ token
    // nào là thật. client_id của public client phải có.
    const response = await stackPostForm(`${origin}/revocation`, {
      token: 'not-a-real-token',
      client_id: LOCAL_CLIENT_ID,
    });
    expect(response.status).toBe(200);
  });
});
