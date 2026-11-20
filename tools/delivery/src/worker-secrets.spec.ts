import { dirname, resolve } from 'node:path';

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
  type SecretAction,
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
  calls: Array<{
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string;
  }>;
} => {
  const calls: Array<{
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string;
  }> = [];
  return {
    calls,
    readTextFile: () => configText,
    execFn: (command, args, cwd, env, options = {}) => {
      calls.push({ command, args, cwd, env, input: options.input });
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
    // Bare prefix `stg-` không có suffix — nhất quán với trim của stagingWorkerNameFromConfig.
    expect(classifyWorkerName('stg-')).toBe('refused');
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

  it('fails closed on an unterminated string literal instead of returning broken JSON', () => {
    expect(() => stripJsoncComments('{"a": "unclosed}')).toThrowError(
      /unterminated string literal/u,
    );
    expect(() => stripJsoncComments('{"a": "line"}')).not.toThrow();
  });

  it('strips block comments and fails closed on an unterminated one', () => {
    const stripped = stripJsoncComments('{ /* khoi comment */ "a": 1 }');
    expect(JSON.parse(stripped)).toEqual({ a: 1 });
    expect(() => stripJsoncComments('{ "a": /* chua dong 1')).toThrowError(
      /unterminated block comment/u,
    );
    // `*/` bên trong string literal của value KHÔNG nằm trong block comment —
    // quét string-aware không nhầm nó là terminator của comment.
    const tricky = stripJsoncComments('{ "a": "x */ y" /* comment */ }');
    expect(JSON.parse(tricky)).toEqual({ a: 'x */ y' });
  });

  it('keeps a legitimate comma inside a string literal', () => {
    const stripped = stripJsoncComments('{"a": "x, y", "b": 1,}');
    expect(() => JSON.parse(stripped)).not.toThrow();
    expect(JSON.parse(stripped)).toEqual({ a: 'x, y', b: 1 });
  });

  // Hình dạng thật của apps/account/wrangler.jsonc (#546): comment nằm giữa
  // dấu phẩy cuối và `}`/`]` — lookahead của trailing comma phải bỏ qua được
  // comment, nếu không reader dùng chung từ chối file ("not valid JSON(C)").
  it('drops a trailing comma followed by a line comment before the closing bracket', () => {
    const stripped = stripJsoncComments('{ "a": [1, 2, // line comment\n]}');
    expect(JSON.parse(stripped)).toEqual({ a: [1, 2] });
  });

  it('drops a trailing comma followed by a block comment before the closing bracket', () => {
    const stripped = stripJsoncComments('{ "a": [1, 2, /* block */], "b": { "c": 1, /* x */ } }');
    expect(JSON.parse(stripped)).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  it('does not treat a } inside an interposed comment as the closing bracket', () => {
    // Nhảy comment nguyên khối: `}` nằm trong comment không kết thúc lookahead.
    const stripped = stripJsoncComments('{ "a": [1, /* } brace */ 2, // }\n]}');
    expect(JSON.parse(stripped)).toEqual({ a: [1, 2] });
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

  it('falls back to the current process PATH/HOME when the source env lacks them', () => {
    const { env } = resolveSecretRunEnv({ [CONTROL_PLANE_TOKEN_ENV_KEY]: TOKEN });
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.CLOUDFLARE_API_TOKEN).toBe(TOKEN);
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
    // Nhiều newline cuối: chỉ cắt ĐÚNG MỘT — hành vi thiết kế, operator pipe
    // `printf 'x\n\n' |` vẫn giữ một newline trong secret.
    expect(trimTrailingNewline('a\n\n')).toBe('a\n');
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
    // --config và cwd của wrangler đều là đường tuyệt đối khớp nhau —
    // relative config path hoạt động từ mọi thư mục gọi CLI.
    expect(call.args).toContain(resolve('apps/home/wrangler.jsonc'));
    expect(call.cwd).toBe(dirname(resolve('apps/home/wrangler.jsonc')));
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
    // Type đã giới hạn 'put'|'stage'; guard runtime vẫn phải chặn giá trị lạ
    // từ caller không qua TS (argv, JS) — cast có chủ ý để chạm đúng guard đó.
    expect(() =>
      putWorkerSecret(
        'deploy' as SecretAction,
        'AXIOM_TOKEN',
        'c.jsonc',
        'value',
        envSource,
        okDeps(),
      ),
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

  it('redacts the secret value if third-party error output echoes it', () => {
    // stderr là text third-party (wrangler/Cloudflare) — nếu giá trị stdin bị
    // echo vào error text, giá trị gốc không được lọt ra log.
    const deps: WorkerSecretDeps = {
      readTextFile: () => SAMPLE_CONFIG,
      execFn: () => ({
        status: 1,
        stdout: '',
        stderr: '[ERROR] Cloudflare API rejected value s3cr3t-t0ken for secret',
      }),
    };
    // Capture để các expect chạy vô điều kiện sau try/catch (vitest
    // no-conditional-expect) — nếu hàm không throw, `thrown` giữ undefined
    // và các expect dưới đây đỏ.
    let thrown: unknown;
    try {
      putWorkerSecret(
        'put',
        'AXIOM_TOKEN',
        'apps/home/wrangler.jsonc',
        's3cr3t-t0ken\n',
        envSource,
        deps,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Message phải còn chẩn đoán Cloudflare, đã redact giá trị gốc.
    expect((thrown as Error).message).toContain('Cloudflare API');
    expect((thrown as Error).message).not.toContain('s3cr3t-t0ken');
    expect((thrown as Error).message).toContain('[redacted]');
  });

  it('redacts a value with leading or trailing whitespace in both stdin and raw form', () => {
    // Gap thật của redaction: key phải là payload ĐÚNG cái vào stdin
    // (trimTrailingNewline giữ lại leading/trailing whitespace), không phải
    // bản trim. stderr KẾT THÚC bằng payload — rawReason trim stderr nên mất
    // whitespace biên của payload, đúng biến thể khó khớp nhất.
    const deps: WorkerSecretDeps = {
      readTextFile: () => SAMPLE_CONFIG,
      execFn: () => ({
        status: 1,
        stdout: '',
        stderr: '[ERROR] Cloudflare API rejected payload s p a c e y \n',
      }),
    };
    let thrown: unknown;
    try {
      putWorkerSecret(
        'put',
        'AXIOM_TOKEN',
        'apps/home/wrangler.jsonc',
        ' s p a c e y \n\n',
        envSource,
        deps,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('Cloudflare API');
    // Không form nào của giá trị gốc (payload ' s p a c e y \n' lẫn value thô
    // ' s p a c e y \n\n' lẫn bản trim) được xuất hiện trong message.
    expect(message).not.toContain('s p a c e y');
    expect(message).toContain('[redacted]');
  });

  it('names the config path when the config file cannot be read', () => {
    const deps: WorkerSecretDeps = {
      readTextFile: () => {
        throw new Error('ENOENT: no such file or directory');
      },
      execFn: () => ({ status: 0, stdout: '', stderr: '' }),
    };
    expect(() =>
      putWorkerSecret('put', 'AXIOM_TOKEN', 'missing/wrangler.jsonc', 'value', envSource, deps),
    ).toThrowError(/cannot read wrangler config at .*missing\/wrangler\.jsonc/u);
  });
});
