import { expect, test } from '@playwright/test';

import { authOrigin, stackGet } from './support/local-origin';

/**
 * Bề mặt giao thức công khai của `auth` — discovery document, JWKS và
 * RP-initiated logout — qua stack thật (DNS → TLS → Traefik → WIC → provider).
 *
 * Nguồn chân lý của mọi assertion:
 * - `apps/auth/src/main.ts` — `discoveryDocument()` (shadow Hono trả TRƯỚC
 *   bridge của provider, nên document là contract kiểm soát được, không phải
 *   mặc định của oidc-provider).
 * - `apps/auth/src/oidc/provider.ts` — `PROVIDER_ROUTES` (đường route thật),
 *   keystore ES256 (P-256) và `features.rpInitiatedLogout`.
 * - `apps/auth/src/oidc-end-session.spec.ts` — hợp đồng HTML của `/session/end`
 *   (confirm form với `xsrf`, action trỏ `/session/end/confirm`).
 */

test.describe('discovery document', () => {
  test('serves the exact ECOMA discovery document under the dynamic issuer', async () => {
    const origin = authOrigin();
    const response = await stackGet(`${origin}/.well-known/openid-configuration`, {
      Accept: 'application/json',
    });

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('application/json');

    const doc = JSON.parse(response.body) as Record<string, unknown>;

    // Issuer là origin-based với port động — giá trị phải bằng đúng origin vừa gọi.
    expect(doc['issuer']).toBe(origin);

    // Entrypoint: authorization là route glue công khai (/authorize), còn
    // token/revocation/jwks/end-session là route của provider (`PROVIDER_ROUTES`).
    expect(doc['authorization_endpoint']).toBe(`${origin}/authorize`);
    expect(doc['token_endpoint']).toBe(`${origin}/token`);
    expect(doc['revocation_endpoint']).toBe(`${origin}/revocation`);
    expect(doc['jwks_uri']).toBe(`${origin}/jwks.json`);
    expect(doc['end_session_endpoint']).toBe(`${origin}/session/end`);

    // Protocol capabilities theo cấu hình ECOMA (provider.ts + main.ts).
    expect(doc['response_types_supported']).toEqual(['code']);
    expect(doc['grant_types_supported']).toEqual(['authorization_code', 'refresh_token']);
    expect(doc['subject_types_supported']).toEqual(['public']);
    expect(doc['id_token_signing_alg_values_supported']).toEqual(['ES256']);
    expect(doc['scopes_supported']).toEqual(['openid', 'offline_access', 'profile']);
    expect(doc['token_endpoint_auth_methods_supported']).toEqual(['none']);
    expect(doc['code_challenge_methods_supported']).toEqual(['S256']);
    expect(doc['claims_supported']).toEqual(['sub', 'acr', 'auth_time']);

    // Các field provider thật render mà shadow phải khớp — mỗi lệch là client
    // đọc sai contract.
    expect(doc['claims_parameter_supported']).toBe(false);
    expect(doc['authorization_response_iss_parameter_supported']).toBe(true);
    expect(doc['request_uri_parameter_supported']).toBe(false);
    expect(doc['claim_types_supported']).toEqual(['normal']);
    // CHỈ `query`: glue không forward `response_mode` (`AUTHORIZED_FORWARD_PARAMS`
    // trong browser-handlers.ts), nên quảng bá form_post/fragment là hứa sai.
    expect(doc['response_modes_supported']).toEqual(['query']);

    // Không quảng bá endpoint bị tắt — claimsParameter/userinfo/introspection
    // đều disabled trong provider.ts.
    expect(doc).not.toHaveProperty('userinfo_endpoint');
    expect(doc).not.toHaveProperty('introspection_endpoint');
    expect(doc['claims_parameter_supported']).toBe(false);
  });

  test('serves the same document at the RFC 8414 well-known path', async () => {
    const origin = authOrigin();
    const openid = await stackGet(`${origin}/.well-known/openid-configuration`, {
      Accept: 'application/json',
    });
    const oauth = await stackGet(`${origin}/.well-known/oauth-authorization-server`, {
      Accept: 'application/json',
    });
    expect(oauth.status).toBe(200);
    // Cùng một document — provider mount cả hai well-known, shadow shadow cả hai.
    expect(JSON.parse(oauth.body)).toEqual(JSON.parse(openid.body));
  });
});

test.describe('JWKS', () => {
  test('publishes the ES256 signing key without any private material', async () => {
    const origin = authOrigin();
    const response = await stackGet(`${origin}/jwks.json`, { Accept: 'application/json' });
    expect(response.status).toBe(200);

    const jwks = JSON.parse(response.body) as { keys: Array<Record<string, unknown>> };
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);

    for (const key of jwks.keys) {
      // Keystore của auth CHỈ có ES256 trên EC P-256 (provider.ts ném sớm nếu
      // khác) — public JWKS phải phản chiếu đúng alg/crv/use.
      expect(key['kty']).toBe('EC');
      expect(key['crv']).toBe('P-256');
      expect(key['alg'] ?? 'ES256').toBe('ES256');
      // use có thể vắng (provider không set thì verifier tự suy từ alg) — nhưng
      // nếu có thì phải là sig.
      if (key['use'] !== undefined) {
        expect(key['use']).toBe('sig');
      }
      // Không bao giờ có private scalar (`d` của EC) trong key công bố.
      expect(key).not.toHaveProperty('d');
      // Toạ độ công khai là base64url không padding — hình dạng JWK hợp lệ.
      expect(typeof key['x']).toBe('string');
      expect(typeof key['y']).toBe('string');
    }

    // kid duy nhất (keystore một khoá): hai key với cùng kid là cấu hình sai.
    const kids = jwks.keys.map((key) => key['kid']);
    expect(new Set(kids).size).toBe(kids.length);
  });
});

test.describe('RP-initiated logout endpoint', () => {
  test('mounts GET /session/end and serves the confirm form with xsrf', async () => {
    const origin = authOrigin();
    // Anonymous GET: KHÔNG 404/405 — endpoint được bridge chuyển tiếp và trả
    // HTML confirm kể cả khi không có session (hợp đồng của
    // oidc-end-session.spec.ts bước 2).
    const response = await stackGet(`${origin}/session/end`);
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/html');

    // Form confirm thật: input xsrf + action trỏ /session/end/confirm.
    expect(response.body).toContain('name="xsrf"');
    const action = new URL(response.body.match(/action="([^"]+)"/u)?.[1] ?? '', origin).pathname;
    expect(action).toBe('/session/end/confirm');

    // Set-Cookie (nếu có) là cookie session của provider — không assert giá trị.
    // Không token/handle nào được in.
  });

  test('keeps the anonymous end-session flow off the 4xx error boundary', async () => {
    const origin = authOrigin();
    const response = await stackGet(`${origin}/session/end`);
    // 200 + HTML (đã assert ở test trên); ở đây chốt lại: mọi response khác
    // 200-2xx cho GET cơ bản là hợp đồng mount bị vỡ.
    expect([200, 302, 303]).toContain(response.status);
  });
});
