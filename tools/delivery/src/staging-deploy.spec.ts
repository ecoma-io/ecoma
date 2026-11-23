import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildStagingManifest,
  deployEligibilityPath,
  injectStagingNoIndexHeaders,
  isFullCommitSha,
  readEligibilityDecision,
  resolveStagingWorkerIdentity,
  runStagingDeploy,
  STAGING_NO_INDEX_HEADER_RULE,
  verifyBuildManifest,
  withStagingNoIndexHeaderRule,
  type StagingDeployDeps,
} from './staging-deploy.ts';
import { GuardAbortError, type RunListQueryResult } from './staging-guard.ts';
import type { DeployStagingWorkerOptions } from './wrangler-deploy.ts';
import {
  CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS,
  CONTROL_PLANE_TOKEN_ENV_KEYS,
} from './worker-secrets.ts';

/** Config wrangler giả với identity staging khai tường minh. */
const CONFIG_TEXT =
  '{\n  "name": "ecoma-home",\n  "env": {\n    "staging": { "name": "stg-ecoma-home" }\n  }\n}\n';
const SHA = 'a'.repeat(40);
const ELIGIBILITY_RELEASEABLE =
  '{ "projects": { "@ecoma-io/home": { "staging": "releaseable" } } }\n';
const ELIGIBILITY_BLOCKED = '{ "projects": { "@ecoma-io/home": { "staging": "excluded" } } }\n';

/** Default queryRuns NÉM ngay — guard tắt thì KHÔNG được có lượt tra cứu nào. */
function neverQueryRuns(): RunListQueryResult {
  throw new Error('queryRuns must not be called without guard inputs');
}

/** Deps giả: phân phối nội dung file theo path, ghi lại lời gọi deploy. */
function fakeDeps(files: Record<string, string>): {
  deps: StagingDeployDeps;
  deployCalls: DeployStagingWorkerOptions[];
  lines: string[];
  /** Gán kết quả lượt tra cứu run MỚI cho guard — chỉ test có guard mới dùng. */
  setQueryRuns: (result: RunListQueryResult) => void;
} {
  const deployCalls: DeployStagingWorkerOptions[] = [];
  const lines: string[] = [];
  const written: string[] = [];
  // Ném ngay: test KHÔNG bật guard mà chạm truy cứu run là lỗi wiring —
  // mọi test cũ (guard tắt) xác nhận đường cũ không tra cứu gì.
  let queryRunsImpl: () => RunListQueryResult = neverQueryRuns;
  const deps: StagingDeployDeps = {
    readTextFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: no such file: ${path}`);
      return text;
    },
    writeTextFile: (path, text) => {
      if (!(path in files)) throw new Error(`ENOENT: no such file: ${path}`);
      files[path] = text;
      written.push(path);
    },
    deployStaging: (options) => {
      deployCalls.push(options);
      return Promise.resolve({ attempts: 1, stdoutTail: '' });
    },
    queryRuns: () => queryRunsImpl(),
    out: { write: (text) => (lines.push(text), lines.length) },
  };
  return {
    deps,
    deployCalls,
    lines,
    written,
    setQueryRuns: (result) => {
      queryRunsImpl = () => result;
    },
  };
}

const HOME_CONFIG = '/repo/apps/home/wrangler.jsonc';
const HOME_MANIFEST = '/repo/build-manifest.json';
const HOME_HEADERS = '/repo/apps/home/.output/public/_headers';

/** Bộ file "mọi preflight pass" — dùng chung cho test deploy và test guard. */
function happyFiles(): Record<string, string> {
  return {
    [HOME_CONFIG]: CONFIG_TEXT,
    [HOME_MANIFEST]: JSON.stringify({ sha: SHA, worker: 'stg-ecoma-home' }),
    [deployEligibilityPath()]: ELIGIBILITY_RELEASEABLE,
    [HOME_HEADERS]: '/_nuxt/*\n  cache-control: public, max-age=31536000, immutable\n',
  };
}

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

  it('propagates the canonical invalid-JSON error with a single parse', () => {
    expect(() => resolveStagingWorkerIdentity('not json', 'home', HOME_CONFIG)).toThrowError(
      /wrangler config is not valid JSON\(C\)/u,
    );
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

describe('withStagingNoIndexHeaderRule', () => {
  it('appends the catch-all noindex rule to cache rules', () => {
    const out = withStagingNoIndexHeaderRule('/_nuxt/*\n  cache-control: max-age=31536000\n');
    expect(out).toBe(
      `/_nuxt/*\n  cache-control: max-age=31536000\n${STAGING_NO_INDEX_HEADER_RULE}\n`,
    );
  });

  it('leaves a file that already carries a bare /* rule untouched', () => {
    const text = '/*\n  X-Robots-Tag: noindex\n';
    expect(withStagingNoIndexHeaderRule(text)).toBe(text);
  });

  it('ignores wildcard rules other than a bare /*', () => {
    const text = '/_nuxt/*\n  cache-control: max-age=31536000\n';
    expect(withStagingNoIndexHeaderRule(text)).not.toBe(text);
  });
});

describe('injectStagingNoIndexHeaders', () => {
  it('writes the noindex rule into the artifact _headers next to the config', () => {
    const { deps } = fakeDeps(happyFiles());
    injectStagingNoIndexHeaders(HOME_CONFIG, deps);
    expect(deps.readTextFile(HOME_HEADERS)).toContain(STAGING_NO_INDEX_HEADER_RULE);
  });

  it('is idempotent — a second run writes nothing', () => {
    const { deps, written } = fakeDeps(happyFiles());
    injectStagingNoIndexHeaders(HOME_CONFIG, deps);
    injectStagingNoIndexHeaders(HOME_CONFIG, deps);
    expect(written.filter((path) => path === HOME_HEADERS)).toHaveLength(1);
  });

  it('fails closed naming the missing _headers path', () => {
    const { deps } = fakeDeps({});
    expect(() => injectStagingNoIndexHeaders(HOME_CONFIG, deps)).toThrowError(
      /cannot read the static-asset _headers file at .*_headers.*§7\.5 item 9/su,
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

  it('runs the full preflight in order and then deploys once with the resolved env', async () => {
    const { deps, deployCalls, lines } = fakeDeps(happyFiles());
    const sourceEnv = {
      [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 'cf-token-value',
      [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'cf-account-id-value',
      PATH: '/usr/bin',
    };
    await runStagingDeploy(params, sourceEnv, deps);
    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]?.configPath).toBe(HOME_CONFIG);
    expect(deployCalls[0]?.env.CLOUDFLARE_API_TOKEN).toBe('cf-token-value');
    expect(deployCalls[0]?.env.CLOUDFLARE_ACCOUNT_ID).toBe('cf-account-id-value');
    expect(lines.join('')).toContain('worker identity resolved (stg-ecoma-home)');
    expect(lines.join('')).toContain('is staging-releaseable');
    expect(lines.join('')).toContain(`build manifest matches run sha ${SHA}`);
    expect(lines.join('')).toContain('static-asset _headers noindex rule ensured');
    expect(lines.join('')).toContain('after 1 attempt(s)');
  });

  it('deploys nothing on an unsafe slug', async () => {
    const { deps, deployCalls } = fakeDeps(happyFiles());
    await expect(
      runStagingDeploy(
        { ...params, slug: 'Home_2' },
        {
          [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 't',
          [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'a',
        },
        deps,
      ),
    ).rejects.toThrowError(/unsafe slug/u);
    expect(deployCalls).toHaveLength(0);
  });

  it('deploys nothing when expect-sha is not a full 40-hex sha', async () => {
    const { deps, deployCalls } = fakeDeps(happyFiles());
    await expect(
      runStagingDeploy(
        { ...params, expectSha: 'HEAD' },
        {
          [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 't',
          [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'a',
        },
        deps,
      ),
    ).rejects.toThrowError(/40-hex commit SHA/u);
    expect(deployCalls).toHaveLength(0);
  });

  it('deploys nothing when the wrangler config cannot be read', async () => {
    const { deps, deployCalls } = fakeDeps({});
    await expect(
      runStagingDeploy(
        params,
        {
          [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 't',
          [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'a',
        },
        deps,
      ),
    ).rejects.toThrowError(/cannot read wrangler config/u);
    expect(deployCalls).toHaveLength(0);
  });

  it('deploys nothing when the artifact manifest does not match the run sha', async () => {
    const files = happyFiles();
    files[HOME_MANIFEST] = JSON.stringify({ sha: 'b'.repeat(40), worker: 'stg-ecoma-home' });
    const { deps, deployCalls } = fakeDeps(files);
    await expect(
      runStagingDeploy(
        params,
        {
          [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 't',
          [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'a',
        },
        deps,
      ),
    ).rejects.toThrowError(/refusing to deploy an artifact/u);
    expect(deployCalls).toHaveLength(0);
  });

  it('fails closed before any command when the control-plane token is missing', async () => {
    const { deps, deployCalls } = fakeDeps(happyFiles());
    await expect(runStagingDeploy(params, {}, deps)).rejects.toThrowError(
      /ECOMA_CLOUDFLARE_STAGING_API_TOKEN is not set/u,
    );
    expect(deployCalls).toHaveLength(0);
  });
});

describe('runStagingDeploy guard before-deploy (§7.4)', () => {
  const params = {
    configPath: HOME_CONFIG,
    project: '@ecoma-io/home',
    slug: 'home',
    manifestPath: HOME_MANIFEST,
    expectSha: SHA,
    guard: { runId: 7, contextSha: SHA },
  };

  function freshRunState(): RunListQueryResult {
    return { ok: true, mainSha: SHA, runs: [{ id: 7, status: 'completed' }] };
  }

  it('deploys once when the run is still the newest and main has not advanced', async () => {
    const { deps, deployCalls, lines, setQueryRuns } = fakeDeps(happyFiles());
    setQueryRuns(freshRunState());
    const result = await runStagingDeploy(
      params,
      {
        [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 't',
        [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'a',
      },
      deps,
    );
    expect(result).toEqual({ deployed: true, guardAction: 'proceed' });
    expect(deployCalls).toHaveLength(1);
    expect(lines.join('')).toContain('proceed-newest-run');
  });

  it('skips WITHOUT deploying when a newer run already completed', async () => {
    const { deps, deployCalls, lines, setQueryRuns } = fakeDeps(happyFiles());
    setQueryRuns({
      ok: true,
      mainSha: SHA,
      runs: [
        { id: 7, status: 'completed' },
        { id: 9, status: 'completed' },
      ],
    });
    const result = await runStagingDeploy(
      params,
      {
        [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 't',
        [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'a',
      },
      deps,
    );
    expect(result).toEqual({ deployed: false, guardAction: 'skip' });
    expect(deployCalls).toHaveLength(0);
    expect(lines.join('')).toContain('superseded-by-newer-completed-run');
  });

  it('aborts WITHOUT deploying and without touching evidence when the query fails', async () => {
    const { deps, deployCalls, setQueryRuns } = fakeDeps(happyFiles());
    setQueryRuns({ ok: false, error: 'gh api exploded' });
    const error = await runStagingDeploy(
      params,
      {
        [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 't',
        [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'a',
      },
      deps,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GuardAbortError);
    expect((error as GuardAbortError).action).toBe('abort-query-failed');
    expect((error as GuardAbortError).message).toContain('gh api exploded');
    expect(deployCalls).toHaveLength(0);
  });

  it('aborts WITH a failure status when main has advanced past the run SHA', async () => {
    const { deps, deployCalls, setQueryRuns } = fakeDeps(happyFiles());
    setQueryRuns({ ok: true, mainSha: 'b'.repeat(40), runs: [{ id: 7, status: 'completed' }] });
    const error = await runStagingDeploy(
      params,
      {
        [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 't',
        [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'a',
      },
      deps,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GuardAbortError);
    expect((error as GuardAbortError).action).toBe('abort-main-advanced');
    expect(deployCalls).toHaveLength(0);
  });

  it('never queries runs when the guard is disabled (old contract unchanged)', async () => {
    const { deps, deployCalls } = fakeDeps(happyFiles());
    // queryRuns giả NÉM nếu bị gọi — giữ nguyên contract cũ cho caller không bật guard.
    const result = await runStagingDeploy(
      { ...params, guard: undefined },
      {
        [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 't',
        [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'a',
      },
      deps,
    );
    expect(result).toEqual({ deployed: true, guardAction: 'proceed' });
    expect(deployCalls).toHaveLength(1);
  });

  it('runs the guard AFTER the full preflight — a bad manifest means no query at all', async () => {
    const files = happyFiles();
    files[HOME_MANIFEST] = JSON.stringify({ sha: 'b'.repeat(40), worker: 'stg-ecoma-home' });
    const { deps, setQueryRuns } = fakeDeps(files);
    // Ném nếu bị gọi — preflight fail phải dừng TRƯỚC guard.
    setQueryRuns(freshRunState());
    await expect(
      runStagingDeploy(
        params,
        {
          [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 't',
          [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'a',
        },
        deps,
      ),
    ).rejects.toThrowError(/refusing to deploy an artifact/u);
  });
});
