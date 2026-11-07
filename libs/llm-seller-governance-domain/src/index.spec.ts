import { describe, expect, it } from 'vitest';

import * as surface from './index';
import { LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES, isLlmGovernanceDomainError } from './index';

describe('public surface', () => {
  it('exports the documented governance operations', () => {
    const required = [
      'createRestrictionRecord',
      'isRestrictionEffective',
      'evaluateRestrictions',
      'liftRestriction',
      'toPublicRestriction',
      'submitAppeal',
      'startAppealReview',
      'decideAppeal',
      'withdrawAppeal',
      'toPublicAppeal',
      'createVerificationCase',
      'submitVerificationCase',
      'startVerificationReview',
      'decideVerification',
      'expireVerificationCase',
      'deriveOnboardingState',
      'deriveOperationalEligibility',
      'appendLegalProfileVersion',
      'legalProfileVersionAt',
      'appendTaxProfileVersion',
      'taxProfileVersionAt',
      'createEvidenceReference',
      'assertEvidenceInTenant',
      'llmGovernanceOk',
      'llmGovernanceFailure',
      'llmGovernanceDomainError',
      'isLlmGovernanceDomainError',
    ];
    for (const name of required) {
      expect(typeof (surface as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('does not expose tenant authorization or aggregate operations', () => {
    const names = Object.keys(surface);
    // `MembershipId`/`isMembershipId` là identity primitive được phép tái xuất
    // từ tenant (ADR-0018); aggregate và thang authorization thì không.
    const primitives = new Set(['MembershipId', 'isMembershipId']);
    expect(
      names.filter((name) => /authorize|membership|grant/iu.test(name) && !primitives.has(name)),
    ).toEqual([]);
  });

  it('exposes profile data but no tax calculation or lifecycle deletion', () => {
    const names = Object.keys(surface);
    expect(names.filter((name) => /withhold|rate|calculate/iu.test(name))).toEqual([]);
    expect(names.filter((name) => /^delete|^archive|^terminate/iu.test(name))).toEqual([]);
  });

  it('keeps every error message in English and frozen', () => {
    expect(Object.isFrozen(LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES)).toBe(true);
    for (const [code, message] of Object.entries(LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES)) {
      expect(message.endsWith('.')).toBe(true);
      // Không có dấu tiếng Việt: message là runtime string.
      expect(/[àáảãạăâđêôơư]/iu.test(message)).toBe(false);
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
  });

  it('rejects error objects outside the taxonomy', () => {
    expect(isLlmGovernanceDomainError({ code: 'unknown_code', message: 'x' })).toBe(false);
    // Message phải đúng nguyên văn bảng chuẩn: không phải chỗ mang dữ liệu call site.
    expect(isLlmGovernanceDomainError({ code: 'invalid_actor', message: 'x' })).toBe(false);
    expect(isLlmGovernanceDomainError(surface.llmGovernanceDomainError('invalid_actor'))).toBe(
      true,
    );
    expect(() => surface.llmGovernanceDomainError('unknown_code' as never)).toThrow(TypeError);
  });

  it('freezes result and error objects', () => {
    const failure = surface.llmGovernanceFailure('invalid_actor');
    expect(failure.ok).toBe(false);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(failure.ok === false && Object.isFrozen(failure.error)).toBe(true);
    expect(Object.isFrozen(surface.llmGovernanceOk('value'))).toBe(true);
  });
});
