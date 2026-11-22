/**
 * Unit tests PER-UNIT của `staging-run.ts` — phần riêng của unit
 * `platform-deploy`: classify lane của project (executor ĐẦU TIÊN của hợp đồng
 * provisioning/reconciliation staging, #368). Các test dùng chung của engine
 * (inventory env, ensureStack, parsers, evidence, runStagingPhase…) đã dồn về
 * `libs/deployment/src/staging-run.spec.ts` (#543).
 */

import { describe, expect, it } from 'vitest';

import { classifyPlatformStack } from './staging-run.js';

describe('classifyPlatformStack', () => {
  it('local namespace slug routes to the local lane', () => {
    expect(classifyPlatformStack('organization/platform-deploy/local-john')).toBe('local');
  });

  it('staging and staging-candidate slugs route to the staging lane', () => {
    expect(classifyPlatformStack('organization/platform-deploy/staging')).toBe('staging');
    expect(classifyPlatformStack('organization/platform-deploy/staging-candidate')).toBe('staging');
  });

  it('a bare local word without the local- prefix is unknown', () => {
    expect(classifyPlatformStack('organization/platform-deploy/local')).toBe('unknown');
  });

  it('any other slug is unknown and must fail closed', () => {
    expect(classifyPlatformStack('organization/platform-deploy/prod')).toBe('unknown');
    expect(classifyPlatformStack('johndoe')).toBe('unknown');
  });
});
