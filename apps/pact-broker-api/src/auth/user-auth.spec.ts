/**
 * Unit test của phần THUẦN trên đường user identity (ADR-0031): hình dạng
 * JWT, bậc thang vai trò, phân lớp memberships và phân lớp lỗi verify; cấu
 * hình issuer/audience tuỳ chọn của `loadPactBrokerConfig`. Không DB, không
 * HTTP — các nhánh quyết định 401/403/503 được ghim ở đây trước khi middleware
 * dựng response (integration suite đo trên request thật).
 */
import { describe, expect, it } from 'vitest';

import { loadPactBrokerConfig, PactBrokerConfigurationError } from '../config';
import {
  classifyMemberships,
  classifyVerifyError,
  isJwtShape,
  roleSatisfies,
  type MembershipRow,
} from './user-auth';

const HYPERDRIVE = { connectionString: 'postgres://user:pw@h/db' };

const row = (overrides: Partial<MembershipRow> = {}): MembershipRow => ({
  tenantId: 't-1',
  tenantName: 'tenant-a',
  status: 'active',
  role: 'member',
  ownerSub: 'someone-else',
  ...overrides,
});

describe('isJwtShape', () => {
  it('accepts three base64url JWT segments and nothing else', () => {
    expect(isJwtShape('eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.sig')).toBe(true);
    expect(isJwtShape('a.b.c')).toBe(true);
  });

  it('rejects machine-token and malformed shapes', () => {
    // Machine token: 32-byte base64url, không dấu chấm.
    expect(isJwtShape('3Nc3x9Qw2vJhT5rLm8sK1yB4nD7fG0aZc')).toBe(false);
    expect(isJwtShape('')).toBe(false);
    expect(isJwtShape('a.b')).toBe(false);
    expect(isJwtShape('a..c')).toBe(false);
    expect(isJwtShape('a.b.c.d')).toBe(false);
    // Ký tự ngoài base64url (+, /, =) — chuỗi không phải JWT hai chấm.
    expect(isJwtShape('a+b/c=.d.e')).toBe(false);
  });
});

describe('roleSatisfies', () => {
  it('ladders viewer < member < admin', () => {
    expect(roleSatisfies('viewer', 'viewer')).toBe(true);
    expect(roleSatisfies('member', 'viewer')).toBe(true);
    expect(roleSatisfies('admin', 'viewer')).toBe(true);
    expect(roleSatisfies('viewer', 'member')).toBe(false);
    expect(roleSatisfies('member', 'member')).toBe(true);
    expect(roleSatisfies('admin', 'admin')).toBe(true);
    expect(roleSatisfies('viewer', 'admin')).toBe(false);
  });

  it('fails closed on an unknown role', () => {
    expect(roleSatisfies('superuser', 'viewer')).toBe(false);
    expect(roleSatisfies('', 'viewer')).toBe(false);
  });
});

describe('classifyMemberships', () => {
  it('grants the single active membership', () => {
    const result = classifyMemberships('sub-1', [row()]);
    expect(result).toEqual({
      outcome: 'granted',
      tenantId: 't-1',
      tenantName: 'tenant-a',
      role: 'member',
    });
  });

  it('floors the owner to admin regardless of the stored role', () => {
    const owner = classifyMemberships('sub-owner', [
      row({ ownerSub: 'sub-owner', role: 'viewer' }),
    ]);
    expect(owner).toMatchObject({ outcome: 'granted', role: 'admin' });
  });

  it('answers no-membership when the sub has no rows at all', () => {
    expect(classifyMemberships('sub-x', [])).toEqual({ outcome: 'no-membership' });
  });

  it('answers tenant-unavailable when only suspended or deleted tenants remain', () => {
    expect(
      classifyMemberships('sub-s', [row({ status: 'suspended' }), row({ status: 'deleted' })]),
    ).toEqual({ outcome: 'tenant-unavailable' });
  });

  it('prefers the active tenant when one active row exists among suspended ones', () => {
    const result = classifyMemberships('sub-m', [row({ status: 'suspended' }), row()]);
    expect(result).toMatchObject({ outcome: 'granted', tenantId: 't-1' });
  });

  it('answers ambiguous when more than one tenant is active', () => {
    const result = classifyMemberships('sub-2', [
      row({ tenantId: 't-1' }),
      row({ tenantId: 't-2' }),
    ]);
    expect(result).toEqual({ outcome: 'ambiguous' });
  });

  it('fails closed on an unknown role in the DB row', () => {
    expect(classifyMemberships('sub-3', [row({ role: 'superuser' })])).toEqual({
      outcome: 'no-membership',
    });
  });
});

describe('classifyVerifyError', () => {
  it('classifies JWKS and network failures as unavailable', () => {
    // jose không export lớp JWKSInvalid ở root — lỗi được phân lớp theo NAME,
    // nên test dựng lỗi cùng name (đúng hình dạng runtime mà verifier gặp).
    expect(
      classifyVerifyError(Object.assign(new Error('no key match'), { name: 'JWKSInvalid' })),
    ).toBe('unavailable');
    expect(classifyVerifyError(new TypeError('fetch failed'))).toBe('unavailable');
    expect(classifyVerifyError(Object.assign(new Error('x'), { name: 'FetchError' }))).toBe(
      'unavailable',
    );
  });

  it('classifies everything else as invalid', () => {
    expect(classifyVerifyError(new Error('signature verification failed'))).toBe('invalid');
    expect(classifyVerifyError('string error')).toBe('invalid');
  });
});

describe('loadPactBrokerConfig — user auth pair', () => {
  it('defaults to null pair when both vars are absent', () => {
    const config = loadPactBrokerConfig({ HYPERDRIVE });
    expect(config.authIssuer).toBeNull();
    expect(config.authAudience).toBeNull();
  });

  it('normalizes the issuer origin and keeps the audience verbatim', () => {
    const config = loadPactBrokerConfig({
      HYPERDRIVE,
      PACT_BROKER_AUTH_ISSUER: 'https://auth.example.com/',
      PACT_BROKER_AUTH_AUDIENCE: 'pact-aud',
    });
    expect(config.authIssuer).toBe('https://auth.example.com');
    expect(config.authAudience).toBe('pact-aud');
  });

  it('rejects a half-configured pair', () => {
    expect(() =>
      loadPactBrokerConfig({ HYPERDRIVE, PACT_BROKER_AUTH_ISSUER: 'https://auth.example.com' }),
    ).toThrow(PactBrokerConfigurationError);
    expect(() =>
      loadPactBrokerConfig({ HYPERDRIVE, PACT_BROKER_AUTH_AUDIENCE: 'pact-aud' }),
    ).toThrow(PactBrokerConfigurationError);
  });

  it('rejects an issuer with path, query or fragment', () => {
    expect(() =>
      loadPactBrokerConfig({
        HYPERDRIVE,
        PACT_BROKER_AUTH_ISSUER: 'https://auth.example.com/realms/x',
        PACT_BROKER_AUTH_AUDIENCE: 'pact-aud',
      }),
    ).toThrow(PactBrokerConfigurationError);
    expect(() =>
      loadPactBrokerConfig({
        HYPERDRIVE,
        PACT_BROKER_AUTH_ISSUER: 'https://auth.example.com?x=1',
        PACT_BROKER_AUTH_AUDIENCE: 'pact-aud',
      }),
    ).toThrow(PactBrokerConfigurationError);
  });
});
