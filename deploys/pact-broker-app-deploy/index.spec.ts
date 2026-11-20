/**
 * Hợp đồng export surface của entry guard `index.ts` — nguồn stack outputs
 * của language host. Language host (`cmd/run/run.js`) unwrap default export
 * DUY NHẤT của entry thành stack outputs top-level, nên entry phải forward
 * đúng surface phẳng của thân lane: default của `staging-program.ts`
 * (`{ hyperdriveConfigId }`) cho lane staging, namespace các `export const`
 * của `local-program.ts` cho lane local. Forward nguyên module namespace là
 * lồng outputs dưới khoá `default` — `pulumi stack output hyperdriveConfigId`
 * không đọc được (wiring contract #539: id surface phẳng sau lần `up` xanh).
 * Cả hai thân lane và `@pulumi/pulumi` đều mock: không chạy Pulumi, không khai
 * resource nào.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => ({ stackRef: '' }));

vi.mock('@pulumi/pulumi', () => ({ getStack: () => guard.stackRef }));
vi.mock('./staging-program.js', () => ({
  default: { hyperdriveConfigId: '0af52597-051b-4cba-90c9-e0f6ff6cd5d5' },
}));
vi.mock('./local-program.js', () => ({
  imageDigest: 'sha256:test-image',
  containerName: 'test-container',
}));

describe('index lane guard export surface', () => {
  beforeEach(() => {
    guard.stackRef = '';
    vi.resetModules();
  });

  it('the staging lane forwards the flat `{ hyperdriveConfigId }` default, not the module namespace', async () => {
    guard.stackRef = 'organization/pact-broker-app-deploy/staging';
    const entry = await import('./index.js');
    const surface = entry.default as Record<string, unknown>;
    expect(surface).toEqual({ hyperdriveConfigId: '0af52597-051b-4cba-90c9-e0f6ff6cd5d5' });
    // Surface phẳng đúng wiring contract #539: duy nhất một top-level output,
    // KHÔNG lồng dưới khoá `default` (đó là hình của nguyên module namespace).
    expect(Object.keys(surface)).toEqual(['hyperdriveConfigId']);
    expect('default' in surface).toBe(false);
  });

  it('the local lane forwards the flat named-consts namespace unchanged', async () => {
    guard.stackRef = 'organization/pact-broker-app-deploy/local-john';
    const entry = await import('./index.js');
    const surface = entry.default as Record<string, unknown>;
    expect(surface).toEqual({ imageDigest: 'sha256:test-image', containerName: 'test-container' });
  });

  it('an unknown stack is refused before any lane surface is forwarded', async () => {
    guard.stackRef = 'organization/pact-broker-app-deploy/prod';
    await expect(import('./index.js')).rejects.toThrow(/unknown stack.*pact-broker-app-deploy/su);
  });
});
