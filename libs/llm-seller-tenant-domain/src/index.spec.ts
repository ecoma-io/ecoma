import { describe, expect, it } from 'vitest';

import * as surface from './index';
import {
  LLM_SELLER_AUTHORIZATION_SCOPE,
  LLM_SELLER_DOMAIN_ERROR_MESSAGES,
  LLM_SELLER_PAYOUT_PERMISSION,
  isLlmSellerDomainError,
  isPermissionId,
} from './index';

describe('public surface', () => {
  it('exports the documented tenant operations', () => {
    const required = [
      'createSellerTenant',
      'isSellerOwner',
      'transferSellerOwnership',
      'provisionMembership',
      'revokeMembership',
      'createGrant',
      'revokeGrant',
      'isGrantActiveForMembership',
      'authorizeSellerAction',
      'authorizeSellerPayout',
      'llmSellerOk',
      'llmSellerFailure',
      'llmSellerDomainError',
      'isLlmSellerDomainError',
    ];
    for (const name of required) {
      expect(typeof (surface as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('does not expose governance operations', () => {
    const names = Object.keys(surface);
    // Chỉ các helper của verdict khai báo tại biên (`restriction-verdict`) là
    // được phép mang chữ "restriction"; record/evaluation thì thuộc governance.
    const boundary = new Set([
      'isSellerRestrictionTarget',
      'isSellerRestrictionVerdict',
      'isSameRestrictionTarget',
    ]);
    expect(
      names.filter(
        (name) => /restriction|appeal|verification|eligibility/iu.test(name) && !boundary.has(name),
      ),
    ).toEqual([]);
  });

  it('exposes one Seller-side payout permission identifier', () => {
    expect(LLM_SELLER_PAYOUT_PERMISSION).toBe('payout.manage');
    expect(isPermissionId(LLM_SELLER_PAYOUT_PERMISSION)).toBe(true);
    expect(LLM_SELLER_AUTHORIZATION_SCOPE).toBe('seller_tenant');
  });

  it('keeps every error message in English and frozen', () => {
    expect(Object.isFrozen(LLM_SELLER_DOMAIN_ERROR_MESSAGES)).toBe(true);
    for (const [code, message] of Object.entries(LLM_SELLER_DOMAIN_ERROR_MESSAGES)) {
      expect(message.endsWith('.')).toBe(true);
      // Không có dấu tiếng Việt: message là runtime string.
      expect(/[àáảãạăâđêôơư]/iu.test(message)).toBe(false);
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
  });

  it('rejects error objects outside the taxonomy', () => {
    expect(isLlmSellerDomainError({ code: 'unknown_code', message: 'x' })).toBe(false);
    // Message phải đúng nguyên văn bảng chuẩn: không phải chỗ mang dữ liệu call site.
    expect(isLlmSellerDomainError({ code: 'invalid_actor', message: 'x' })).toBe(false);
    expect(isLlmSellerDomainError(surface.llmSellerDomainError('invalid_actor'))).toBe(true);
    expect(() => surface.llmSellerDomainError('unknown_code' as never)).toThrow(TypeError);
  });

  it('freezes result and error objects', () => {
    const failure = surface.llmSellerFailure('invalid_actor');
    expect(failure.ok).toBe(false);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(failure.ok === false && Object.isFrozen(failure.error)).toBe(true);
    expect(Object.isFrozen(surface.llmSellerOk('value'))).toBe(true);
  });
});
