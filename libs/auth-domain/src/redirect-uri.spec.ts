import { describe, expect, it } from 'vitest';

import { assertWellFormedRedirectUri, redirectUriMatches } from './redirect-uri';
import { assertRegisteredRedirectUri } from './authorize-request';
import { OAuthProtocolError } from './errors';

describe('redirectUriMatches (exact)', () => {
  it('matches when the strings are equal', () => {
    expect(redirectUriMatches('https://app.example/cb', 'https://app.example/cb')).toBe(true);
  });

  it('REJECTS a prefix — the path boundary is the leading /, not the next character (T-04)', () => {
    // Dang ky `https://app.example/cb` thi KHONG duoc khop
    // `https://app.example/cb-attacker.example/`. Day la cach redirect URI
    // attack chuan khai thac.
    expect(
      redirectUriMatches('https://app.example/cb-attacker.example/', 'https://app.example/cb'),
    ).toBe(false);
  });

  it('REJECTS ignoring the query string', () => {
    expect(
      redirectUriMatches(
        'https://app.example/cb?next=https://evil.example',
        'https://app.example/cb',
      ),
    ).toBe(false);
  });

  it('REJECTS ignoring a trailing slash', () => {
    expect(redirectUriMatches('https://app.example/cb/', 'https://app.example/cb')).toBe(false);
  });

  it('REJECTS a letter-case difference', () => {
    expect(redirectUriMatches('https://app.example/CB', 'https://app.example/cb')).toBe(false);
    expect(redirectUriMatches('https://APP.example/cb', 'https://app.example/cb')).toBe(false);
  });

  it('REJECTS a scheme difference', () => {
    expect(redirectUriMatches('http://app.example/cb', 'https://app.example/cb')).toBe(false);
  });

  it('REJECTS protocol-relative `//evil.example` — a high-severity attack form', () => {
    expect(redirectUriMatches('//evil.example/cb', 'https://app.example/cb')).toBe(false);
  });

  it('REJECTS a subdomain — wildcards are not allowed', () => {
    expect(redirectUriMatches('https://evil.app.example/cb', 'https://app.example/cb')).toBe(false);
  });

  it('REJECTS userinfo: `https://app.example@evil.example` resolves to evil', () => {
    expect(
      redirectUriMatches('https://app.example@evil.example/cb', 'https://app.example/cb'),
    ).toBe(false);
  });

  it('REJECTS a different port', () => {
    expect(redirectUriMatches('https://app.example:8443/cb', 'https://app.example/cb')).toBe(false);
  });
});

describe('redirectUriMatches (loopback, client native)', () => {
  const policy = {
    kind: 'loopback-port-variable' as const,
    allowedHosts: new Set(['127.0.0.1', '::1']),
  };

  it('allows a PORT change', () => {
    expect(
      redirectUriMatches('http://127.0.0.1:55555/cb', 'http://127.0.0.1:12345/cb', policy),
    ).toBe(true);
  });

  it('REJECTS a HOST change', () => {
    // Chi cong duoc doi. Host la ranh gioi duyet may.
    expect(
      redirectUriMatches('http://evil.example:12345/cb', 'http://127.0.0.1:12345/cb', policy),
    ).toBe(false);
  });

  it('REJECTS a PATH change', () => {
    expect(
      redirectUriMatches('http://127.0.0.1:12345/other', 'http://127.0.0.1:12345/cb', policy),
    ).toBe(false);
  });

  it('REJECTS a SCHEME change', () => {
    expect(
      redirectUriMatches('https://127.0.0.1:12345/cb', 'http://127.0.0.1:12345/cb', policy),
    ).toBe(false);
  });

  it('REJECTS a host not in the allowlist', () => {
    expect(
      redirectUriMatches('http://localhost:12345/cb', 'http://127.0.0.1:12345/cb', policy),
    ).toBe(false);
  });
});

describe('assertWellFormedRedirectUri', () => {
  it('accepts https', () => {
    expect(() => assertWellFormedRedirectUri('https://app.example/cb')).not.toThrow();
  });

  it('REJECTS a fragment — browsers strip it on redirect, so it never reaches the server', () => {
    expect(() => assertWellFormedRedirectUri('https://app.example/cb#frag')).toThrow(/fragment/u);
  });

  it('REJECTS http outside loopback', () => {
    expect(() => assertWellFormedRedirectUri('http://app.example/cb')).toThrow(/loopback/u);
  });

  it('accepts http loopback', () => {
    expect(() => assertWellFormedRedirectUri('http://127.0.0.1:12345/cb')).not.toThrow();
    expect(() => assertWellFormedRedirectUri('http://localhost:12345/cb')).not.toThrow();
  });

  it('REJECTS a non-http(s) scheme — javascript:, data: are XSS/open redirect', () => {
    // Hai chuoi nay VAN parse duoc thanh URL hop le (protocol `javascript:` /
    // `data:`), nen bo qua kiem tra protocol se cho chung qua.
    expect(() => assertWellFormedRedirectUri('javascript:alert(1)')).toThrow(/http hoac https/u);
    expect(() => assertWellFormedRedirectUri('data:text/html,<script>alert(1)</script>')).toThrow(
      /http hoac https/u,
    );
  });

  it('REJECTS a string that is not a URL', () => {
    expect(() => assertWellFormedRedirectUri('khong-phai-url')).toThrow(/URL hop le/u);
  });
});

describe('assertRegisteredRedirectUri', () => {
  it('passes when the URI is in the registered list', () => {
    expect(() =>
      assertRegisteredRedirectUri('https://app.example/cb', ['https://app.example/cb'], {
        kind: 'exact',
      }),
    ).not.toThrow();
  });

  it('REJECTS an unregistered URI', () => {
    expect(() =>
      assertRegisteredRedirectUri('https://evil.example/cb', ['https://app.example/cb'], {
        kind: 'exact',
      }),
    ).toThrow(OAuthProtocolError);
  });

  it('REJECTS when the list is empty', () => {
    expect(() =>
      assertRegisteredRedirectUri('https://app.example/cb', [], { kind: 'exact' }),
    ).toThrow(OAuthProtocolError);
  });

  it('never redirects on an invalid URI — redirectable must be false', () => {
    // Loi sai kinh dien: handler nao do bat loi roi redirect toi redirect_uri
    // chua duoc xac minh => open redirect. Loi phai ra `redirectable=false`.
    let thrown: unknown;
    try {
      assertRegisteredRedirectUri('https://evil.example/cb', ['https://app.example/cb'], {
        kind: 'exact',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OAuthProtocolError);
    expect((thrown as OAuthProtocolError).redirectable).toBe(false);
  });

  it('only one of several registered URIs needs to match', () => {
    const registered = ['https://a.example/cb', 'https://b.example/cb'];
    expect(() =>
      assertRegisteredRedirectUri('https://b.example/cb', registered, { kind: 'exact' }),
    ).not.toThrow();
  });
});
