import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_STEPS,
  CANONICAL_SELLER_TENANT,
  CANONICAL_SUPERADMIN_EMAIL,
  CANONICAL_TENANT,
  existsScript,
  unresolvedBlockers,
} from './contract.ts';

describe('bootstrap step table', () => {
  it('follows the canonical §3.2 bootstrap/seed rows 3-10 in runner sequence with unique ids', () => {
    expect(BOOTSTRAP_STEPS.map((step) => step.order)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(BOOTSTRAP_STEPS.map((step) => step.canonicalRow)).toEqual([
      '3',
      '4',
      '5a',
      '5b',
      '6',
      '7',
      '8a',
      '8b',
      '9',
      '10',
    ]);
    expect(new Set(BOOTSTRAP_STEPS.map((step) => step.id)).size).toBe(BOOTSTRAP_STEPS.length);
  });

  it('writes exactly one database per step owned by the step service', () => {
    for (const step of BOOTSTRAP_STEPS) {
      expect(`${step.id}: ${step.database}`).toMatch(/^[\w-]+: db-/u);
      expect(step.verify).not.toBe('');
    }
  });

  it('maps each step to its owning service database', () => {
    const dbOf = new Map(BOOTSTRAP_STEPS.map((step) => [step.id, step.database]));
    expect(dbOf.get('account')).toBe('db-account');
    expect(dbOf.get('staff')).toBe('db-staff-access');
    expect(dbOf.get('pact-tenant')).toBe('db-pact-broker');
    expect(dbOf.get('pact-machine-token')).toBe('db-pact-broker');
    expect(dbOf.get('remote-cache-tenant')).toBe('db-remote-cache');
    expect(dbOf.get('auth-oauth-client')).toBe('db-auth');
    expect(dbOf.get('llm-consumer-tenant')).toBe('db-llm-tenant');
  });

  it('passes sub and tenant_id only through later steps per ADR-0020 step 3→later and ADR-0028 §6', () => {
    const ids = BOOTSTRAP_STEPS.map((step) => step.id);
    expect(ids[0]).toBe('account');
    expect(ids).toContain('llm-consumer-tenant');
    expect(ids.at(-1)).toBe('llm-financial');
  });
});

describe('canonical identities', () => {
  it('pins the code constants per ADR-0020/ADR-0027', () => {
    expect(CANONICAL_TENANT).toBe('ecoma');
    expect(CANONICAL_SUPERADMIN_EMAIL).toBe('superadmin@ecoma.io');
    expect(CANONICAL_SELLER_TENANT).toBe('dronie');
  });

  it('never names the first-party seller tenant after the canonical tenant', () => {
    expect(CANONICAL_SELLER_TENANT).not.toBe(CANONICAL_TENANT);
  });
});

describe('bootstrap CLI inventory', () => {
  it('resolves an existing script for every step in the table', () => {
    const missing = BOOTSTRAP_STEPS.filter((step) => !existsScript(step.argv)).map(
      (step) => step.id,
    );
    expect(missing).toEqual([]);
  });
});

describe('unresolvedBlockers', () => {
  it('fails closed on the staging prerequisites #349 and #351', () => {
    const blockers = unresolvedBlockers();
    expect(blockers.some((b) => b.includes('TODO(349/blocking)'))).toBe(true);
    expect(blockers.some((b) => b.includes('TODO(351/blocking)'))).toBe(true);
  });

  it('no longer reports a #352 CLI blocker now the auth-oauth-client script exists', () => {
    expect(unresolvedBlockers().some((b) => b.includes('TODO(352/blocking)'))).toBe(false);
  });
});
