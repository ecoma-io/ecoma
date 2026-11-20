import { describe, expect, it } from 'vitest';

import { stagingMarkerRefusal } from './staging-run.js';

describe('stagingMarkerRefusal', () => {
  it('refuses with exit code 1 while the staging prerequisites of #350 are open', () => {
    const refusal = stagingMarkerRefusal();
    expect(refusal.exitCode).toBe(1);
  });

  it('names the exact missing prerequisites: #349, the unbootstrapped state backend env key, and the unmerged #453 lane pattern', () => {
    const refusal = stagingMarkerRefusal();
    expect(refusal.message).toContain('#350');
    expect(refusal.message).toContain('#349');
    expect(refusal.message).toContain('ECOMA_PULUMI_STATE_URL_STAGING');
    expect(refusal.message).toContain('#453');
  });

  it('warns that the local program must never run on a staging stack', () => {
    const refusal = stagingMarkerRefusal();
    expect(refusal.message).toContain('must NEVER run on a staging stack');
  });
});
