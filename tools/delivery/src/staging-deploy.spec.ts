import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildStagingManifest,
  deployEligibilityPath,
  isFullCommitSha,
  readEligibilityDecision,
  resolveStagingWorkerIdentity,
  runStagingDeploy,
  verifyBuildManifest,
  type StagingDeployDeps,
} from './staging-deploy.ts';
import type { DeployStagingWorkerOptions } from './wrangler-deploy.ts';

/** Config wrangler giả với identity staging khai tường minh. */
const CONFIG_TEXT =
  '{\n  "name": "ecoma-home",\n  "env": {\n    "staging": { "name": "stg-ecoma-home" }\n  }\n}\n';
const SHA = 'a'.repeat(40);
const ELIGIBILITY_RELEASEABLE =
  '{ "projects": { "@ecoma-io/home": { "staging": "releaseable" } } }\n';
const ELIGIBILITY_BLOCKED = '{ "projects": { "@ecoma-io/home": { "staging": "excluded" } } }\n';

/** Deps giả: phân phối nội dung file theo path, ghi lại lời gọi deploy. */
function fakeDeps(files: Record<string, string>): {
  deps: StagingDeployDeps;
  deployCalls: DeployStagingWorkerOptions[];
  lines: string[];
} {
  const deployCalls: DeployStagingWorkerOptions[] = [];
  const lines: string[] = [];
  const deps: StagingDeployDeps = {
    readTextFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: no such file: ${path}`);
      return text;
    },
    deployStaging: (options) => {
      deployCalls.push(options);
      return Promise.resolve({ attempts: 1, stdoutTail: '' });
    },
    out: { write: (text) => (lines.push(text), lines.length) },
  };
  return { deps, deployCalls, lines };
}

const HOME_CONFIG = '/repo/apps/home/wrangler.jsonc';
const HOME_MANIFEST = '/repo/build-manifest.json';

describe('isFullCommitSha', () => {
  it('accepts exactly 40 lowercase hex characters', () => {
    expect(isFullCommitSha('a'.repeat(40))).toBe(true);
    expect(isFullCommitSha('0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });

  it('rejects short SHAs, tags and uppercase hex', () => {
    expect(isFullCommitSha('abc123')).toBe(false);
    expect(isFullCommitSha('A'.repeat(40))).toBe(false);
    expect(isFullCommitSha('main')).toBe(false);
    expect(isFullCommitSha(`${'a'.repeat(39)}g`)).toBe(false);
  });
});

describe('readEligibilityDecision', () => {
  it('classifies @ecoma-io/home releaseable in the real inventory file', () => {
    // Chạy trên file thật (pattern §5.2: test trên chính config của repo) —
    // spec fail đúng lúc classification của home bị kéo lùi.
    expect(
      readEligibilityDecision('@ecoma-io/home', { readTextFile: (p) => readFileSync(p, 'utf8') }),
    ).toBe('releaseable');
  });

  it('blocks an explicitly excluded project with the file path in the error', () => {
    const path = deployEligibilityPath();
    const { deps } = fakeDeps({ [path]: ELIGIBILITY_BLOCKED });
    expect(() => readEligibilityDecision('@ecoma-io/home', deps)).toThrowError(
      /not staging-releaseable .*status: excluded/u,
    );
  });

  it('blocks an unclassified project — never infer from config presence', () => {
    const path = deployEligibilityPath();
    const { deps } = fakeDeps({ [path]: '{ "projects": {} }' });
    expect(() => readEligibilityDecision('@ecoma-io/account', deps)).toThrowError(
      /has no entry .*§7\.5 item 2/u,
    );
  });

  it('fails closed on an unreadable config with the exact path to fix', () => {
    const { deps } = fakeDeps({});
    expect(() => readEligibilityDecision('@ecoma-io/home', deps)).toThrowError(
      /deploy eligibility config is unreadable at /u,
    );
  });
});

describe('resolveStagingWorkerIdentity', () => {
  it('resolves stg-ecoma-home from the real apps/home/wrangler.jsonc', () => {
    const configPath = fileURLToPath(new URL('../../../apps/home/wrangler.jsonc', import.meta.url));
    expect(resolveStagingWorkerIdentity(readFileSync(configPath, 'utf8'), 'home', configPath)).toBe(
      'stg-ecoma-home',
    );
  });

  it('refuses a caller slug that does not name the deploy unit', () => {
    expect(() => resolveStagingWorkerIdentity(CONFIG_TEXT, 'account', HOME_CONFIG)).toThrowError(
      /caller slug "account" does not name this deploy unit .*"-account"/u,
    );
  });

  it('refuses a staging name that does not derive from the production unit', () => {
    const text = '{ "name": "ecoma-home", "env": { "staging": { "name": "stg-ecoma-other" } } }';
    expect(() => resolveStagingWorkerIdentity(text, 'home', HOME_CONFIG)).toThrowError(
      /must be "stg-<unit>" exactly \(§6\.12\)/u,
    );
  });

  it('refuses a config without a top-level production name', () => {
    const text = '{ "env": { "staging": { "name": "stg-ecoma-home" } } }';
    expect(() => resolveStagingWorkerIdentity(text, 'home', HOME_CONFIG)).toThrowError(
      /declares no top-level "name"/u,
    );
  });

  it('refuses a production identity — never deploy outside the stg- scope', () => {
    const text = '{ "name": "ecoma-home", "env": { "staging": { "name": "ecoma-home" } } }';
    expect(() => resolveStagingWorkerIdentity(text, 'home', HOME_CONFIG)).toThrowError(
      /is not a staging identity/u,
    );
  });

  it('propagates the missing env.staging.name error', () => {
    expect(() =>
      resolveStagingWorkerIdentity('{ "name": "ecoma-home" }', 'home', HOME_CONFIG),
    ).toThrowError(/declares no env\.staging\.name/u);
  });
});

describe('buildStagingManifest', () => {
  it('records the worker name and the exact sha', () => {
    expect(buildStagingManifest(CONFIG_TEXT, SHA)).toEqual({ sha: SHA, worker: 'stg-ecoma-home' });
  });

  it('refuses anything that is not a full 40-hex sha', () => {
    expect(() => buildStagingManifest(CONFIG_TEXT, 'abc123')).toThrowError(/40-hex commit SHA/u);
  });
});

describe('verifyBuildManifest', () => {
  it('accepts a manifest that matches the run sha and worker', () => {
    expect(() =>
      verifyBuildManifest(
        JSON.stringify({ sha: SHA, worker: 'stg-ecoma-home' }),
        'm.json',
        SHA,
        'stg-ecoma-home',
      ),
    ).not.toThrow();
  });

  it('refuses an artifact from another revision (§7.4)', () => {
    expect(() =>
      verifyBuildManifest(
        JSON.stringify({ sha: 'b'.repeat(40), worker: 'stg-ecoma-home' }),
        'm.json',
        SHA,
        'stg-ecoma-home',
      ),
    ).toThrowError(/records sha .*refusing to deploy an artifact/u);
  });

  it('refuses an artifact built for another deploy unit', () => {
    expect(() =>
      verifyBuildManifest(
        JSON.stringify({ sha: SHA, worker: 'stg-ecoma-account' }),
        'm.json',
        SHA,
        'stg-ecoma-home',
      ),
    ).toThrowError(/records worker .*another deploy unit/u);
  });

  it('fails closed on a corrupt manifest', () => {
    expect(() => verifyBuildManifest('not json', 'm.json', SHA, 'stg-ecoma-home')).toThrowError(
      /is not valid JSON/u,
    );
  });
});

describe('runStagingDeploy', () => {
  const params = {
    configPath: HOME_CONFIG,
    project: '@ecoma-io/home',
    slug: 'home',
    manifestPath: HOME_MANIFEST,
    expectSha: SHA,
  };

  function happyFiles(): Record<string, string> {
    return {
      [HOME_CONFIG]: CONFIG_TEXT,
      [HOME_MANIFEST]: JSON.stringify({ sha: SHA, worker: 'stg-ecoma-home' }),
      [deployEligibilityPath()]: ELIGIBILITY_RELEASEABLE,
    };
  }

  it('runs the full preflight in order and then deploys once with the resolved env', async () => {
    const { deps, deployCalls, lines } = fakeDeps(happyFiles());
    const sourceEnv = { ECOMA_CLOUDFLARE_API_TOKEN: 'cf-token-value', PATH: '/usr/bin' };
    await runStagingDeploy(params, sourceEnv, deps);
    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]?.configPath).toBe(HOME_CONFIG);
    expect(deployCalls[0]?.env.CLOUDFLARE_API_TOKEN).toBe('cf-token-value');
    expect(lines.join('')).toContain('worker identity resolved (stg-ecoma-home)');
    expect(lines.join('')).toContain('is staging-releaseable');
    expect(lines.join('')).toContain(`build manifest matches run sha ${SHA}`);
    expect(lines.join('')).toContain('after 1 attempt(s)');
  });

  it('deploys nothing on an unsafe slug', async () => {
    const { deps, deployCalls } = fakeDeps(happyFiles());
    await expect(
      runStagingDeploy({ ...params, slug: 'Home_2' }, { ECOMA_CLOUDFLARE_API_TOKEN: 't' }, deps),
    ).rejects.toThrowError(/unsafe slug/u);
    expect(deployCalls).toHaveLength(0);
  });

  it('deploys nothing when expect-sha is not a full 40-hex sha', async () => {
    const { deps, deployCalls } = fakeDeps(happyFiles());
    await expect(
      runStagingDeploy({ ...params, expectSha: 'HEAD' }, { ECOMA_CLOUDFLARE_API_TOKEN: 't' }, deps),
    ).rejects.toThrowError(/40-hex commit SHA/u);
    expect(deployCalls).toHaveLength(0);
  });

  it('deploys nothing when the wrangler config cannot be read', async () => {
    const { deps, deployCalls } = fakeDeps({});
    await expect(
      runStagingDeploy(params, { ECOMA_CLOUDFLARE_API_TOKEN: 't' }, deps),
    ).rejects.toThrowError(/cannot read wrangler config/u);
    expect(deployCalls).toHaveLength(0);
  });

  it('deploys nothing when the artifact manifest does not match the run sha', async () => {
    const files = happyFiles();
    files[HOME_MANIFEST] = JSON.stringify({ sha: 'b'.repeat(40), worker: 'stg-ecoma-home' });
    const { deps, deployCalls } = fakeDeps(files);
    await expect(
      runStagingDeploy(params, { ECOMA_CLOUDFLARE_API_TOKEN: 't' }, deps),
    ).rejects.toThrowError(/refusing to deploy an artifact/u);
    expect(deployCalls).toHaveLength(0);
  });

  it('fails closed before any command when the control-plane token is missing', async () => {
    const { deps, deployCalls } = fakeDeps(happyFiles());
    await expect(runStagingDeploy(params, {}, deps)).rejects.toThrowError(
      /ECOMA_CLOUDFLARE_API_TOKEN is not set/u,
    );
    expect(deployCalls).toHaveLength(0);
  });
});
