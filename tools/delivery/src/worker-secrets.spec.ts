import { describe, expect, it } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import {
  buildWranglerSecretArgs,
  classifyWorkerName,
  putWorkerSecret,
  resolveSecretRunEnv,
  stagingWorkerNameFromConfig,
  stripJsoncComments,
  trimTrailingNewline,
  validateSecretName,
  CONTROL_PLANE_TOKEN_ENV_KEY,
  type WorkerSecretDeps,
} from './worker-secrets.ts';

/** Config wrangler mẫu — comment JSONC thật như `apps/home/wrangler.jsonc`. */
const SAMPLE_CONFIG = `{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  // --- Staging: https://ecoma.io.vn — Worker \`stg-ecoma-home\` ---
  "name": "ecoma-home",
  "routes": [{ "pattern": "ecoma.io/*", "comment_url": "https://example.com/a//b" }],
  "env": {
    "staging": {
      // Worker identity staging — pipeline secret chỉ được nhắm vào tên này.
      "name": "stg-ecoma-home",
    },
  },
}`;

const TOKEN = 'cf-token-value';

const okDeps = (
  configText = SAMPLE_CONFIG,
): WorkerSecretDeps & {
  calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; input?: string }>;
} => {
  const calls: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    input?: string;
  }> = [];
  return {
    calls,
    readTextFile: () => configText,
    execFn: (command, args, _cwd, env, options = {}) => {
      calls.push({ command, args, env, input: options.input });
      const result: ExecResult = { status: 0, stdout: '', stderr: '' };
      return result;
    },
  };
};

describe('classifyWorkerName', () => {
  it('accepts staging identities and refuses anything else', () => {
    expect(classifyWorkerName('stg-ecoma-home')).toBe('staging');
    expect(classifyWorkerName('ecoma-home')).toBe('refused');
    expect(classifyWorkerName('')).toBe('refused');
  });
});

describe('validateSecretName', () => {
  it('accepts ASCII identifiers and rejects the rest', () => {
    expect(validateSecretName('AXIOM_INGEST_TOKEN')).toBe('AXIOM_INGEST_TOKEN');
    expect(() => validateSecretName('9BAD')).toThrowError(/invalid secret name/u);
    expect(() => validateSecretName('has-dash')).toThrowError(/invalid secret name/u);
    expect(() => validateSecretName('')).toThrowError(/invalid secret name/u);
  });
});

describe('stripJsoncComments', () => {
  it('strips comments and trailing commas but keeps // inside string literals', () => {
    const stripped = stripJsoncComments(SAMPLE_CONFIG);
    expect(() => JSON.parse(stripped)).not.toThrow();
    const parsed = JSON.parse(stripped) as { routes: Array<{ comment_url: string }> };
    expect(parsed.routes[0]?.comment_url).toBe('https://example.com/a//b');
    expect(stripped).not.toContain('Staging');
  });
});

describe('stagingWorkerNameFromConfig', () => {
  it('reads env.staging.name from a real-shaped config', () => {
    expect(stagingWorkerNameFromConfig(SAMPLE_CONFIG)).toBe('stg-ecoma-home');
  });

  it('refuses a config without env.staging.name instead of falling back to the top-level name', () => {
    const noStagingName = JSON.stringify({ name: 'ecoma-home', env: { staging: {} } });
    expect(() => stagingWorkerNameFromConfig(noStagingName)).toThrowError(/no env\.staging\.name/u);
    expect(() => stagingWorkerNameFromConfig('{"name": "ecoma-home"}')).toThrowError(
      /no env\.staging\.name/u,
    );
    expect(() => stagingWorkerNameFromConfig('not json')).toThrowError(/not valid JSON/u);
  });
});

describe('resolveSecretRunEnv', () => {
  it('fails closed with the variable name when the shared token is missing', () => {
    expect(() => resolveSecretRunEnv({})).toThrowError(
      new RegExp(CONTROL_PLANE_TOKEN_ENV_KEY, 'u'),
    );
    expect(() => resolveSecretRunEnv({ [CONTROL_PLANE_TOKEN_ENV_KEY]: '   ' })).toThrowError(
      new RegExp(CONTROL_PLANE_TOKEN_ENV_KEY, 'u'),
    );
  });

  it('maps the token to CLOUDFLARE_API_TOKEN in a minimal env only', () => {
    const { env } = resolveSecretRunEnv({
      PATH: '/usr/bin',
      HOME: '/home/op',
      [CONTROL_PLANE_TOKEN_ENV_KEY]: TOKEN,
    });
    expect(env.CLOUDFLARE_API_TOKEN).toBe(TOKEN);
    expect(env.CI).toBe('1');
    expect(Object.keys(env).toSorted()).toEqual(['CI', 'CLOUDFLARE_API_TOKEN', 'HOME', 'PATH']);
  });
});

describe('buildWranglerSecretArgs', () => {
  it('builds the put and stage command shapes with explicit env and config', () => {
    expect(buildWranglerSecretArgs('put', 'AXIOM_TOKEN', 'apps/home/wrangler.jsonc')).toEqual([
      'secret',
      'put',
      'AXIOM_TOKEN',
      '--env',
      'staging',
      '--config',
      'apps/home/wrangler.jsonc',
    ]);
    expect(buildWranglerSecretArgs('stage', 'AXIOM_TOKEN', 'c.jsonc')).toEqual([
      'versions',
      'secret',
      'put',
      'AXIOM_TOKEN',
      '--env',
      'staging',
      '--config',
      'c.jsonc',
    ]);
  });
});

describe('trimTrailingNewline', () => {
  it('strips exactly one trailing newline and keeps inner content', () => {
    expect(trimTrailingNewline('value\n')).toBe('value');
    expect(trimTrailingNewline('a\nb\n')).toBe('a\nb');
    expect(trimTrailingNewline('a\r\n')).toBe('a');
    expect(trimTrailingNewline('')).toBe('');
  });
});

describe('putWorkerSecret', () => {
  const envSource = { PATH: '/usr/bin', HOME: '/home/op', [CONTROL_PLANE_TOKEN_ENV_KEY]: TOKEN };

  it('runs wrangler with the value on stdin and the token only in the subprocess env', () => {
    const deps = okDeps();
    const { worker } = putWorkerSecret(
      'put',
      'AXIOM_TOKEN',
      'apps/home/wrangler.jsonc',
      'value\n',
      envSource,
      deps,
    );
    expect(worker).toBe('stg-ecoma-home');
    const call = deps.calls[0] as (typeof deps.calls)[number];
    expect(call.command).toBe('npx');
    expect(call.args[0]).toBe('wrangler');
    expect(call.args).toContain('--env');
    expect(call.input).toBe('value');
    expect(call.env.CLOUDFLARE_API_TOKEN).toBe(TOKEN);
    // Token KHÔNG BAO GIỜ nằm trong argv (/proc/<pid>/cmdline đọc được).
    expect(call.args.join(' ')).not.toContain(TOKEN);
  });

  it('stages a rotation through versions secret put without deploying', () => {
    const deps = okDeps();
    putWorkerSecret('stage', 'AXIOM_TOKEN', 'apps/home/wrangler.jsonc', 'rotated', envSource, deps);
    expect(deps.calls[0]?.args.slice(1, 4)).toEqual(['versions', 'secret', 'put']);
  });

  it('refuses a production worker identity before wrangler runs', () => {
    const prodConfig = JSON.stringify({
      name: 'ecoma-home',
      env: { staging: { name: 'ecoma-home' } },
    });
    const deps = okDeps(prodConfig);
    expect(() =>
      putWorkerSecret('put', 'AXIOM_TOKEN', 'apps/home/wrangler.jsonc', 'value', envSource, deps),
    ).toThrowError(/not a staging identity/u);
    expect(deps.calls).toEqual([]);
  });

  it('refuses an empty value and an unknown action before wrangler runs', () => {
    expect(() =>
      putWorkerSecret('put', 'AXIOM_TOKEN', 'c.jsonc', '\n', envSource, okDeps()),
    ).toThrowError(/value is empty/u);
    expect(() =>
      putWorkerSecret('deploy', 'AXIOM_TOKEN', 'c.jsonc', 'value', envSource, okDeps()),
    ).toThrowError(/unknown secret action/u);
  });

  it('surfaces wrangler failures instead of reporting success', () => {
    const deps: WorkerSecretDeps = {
      readTextFile: () => SAMPLE_CONFIG,
      execFn: () => ({
        status: 1,
        stdout: '',
        stderr: '[ERROR] A request to the Cloudflare API failed',
      }),
    };
    expect(() =>
      putWorkerSecret('put', 'AXIOM_TOKEN', 'apps/home/wrangler.jsonc', 'value', envSource, deps),
    ).toThrowError(/Cloudflare API/u);
  });
});
