import type { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_DATABASE_URL_ENV,
  STAFF_ACCESS_DATABASE_URL_ENV,
  createSpawnStageRunner,
} from './stage-process.js';

type SpawnArgs = Parameters<typeof spawnSync>;

/** Kết quả giả của `spawnSync` — chỉ các trường runner đọc. */
function fakeRun(
  stdout: string,
  stderr = '',
  status: number | null = 0,
): ReturnType<typeof spawnSync> {
  return { stdout, stderr, status, error: undefined } as ReturnType<typeof spawnSync>;
}

/** Dựng runner với `spawnSync` giả, ghi lại mọi lần gọi. */
function withSpawn(result: ReturnType<typeof spawnSync>) {
  const calls: SpawnArgs[] = [];
  const spawn = ((...args: SpawnArgs) => {
    calls.push(args);
    return result;
  }) as unknown as typeof spawnSync;
  return { run: createSpawnStageRunner({ env: {}, spawn }), calls };
}

describe('createSpawnStageRunner', () => {
  it('passes the request over stdin and keeps every credential out of argv', () => {
    const calls: SpawnArgs[] = [];
    const secretUrl = 'postgresql://user:password@host:5432/db-account';
    const run = createSpawnStageRunner({
      env: { [ACCOUNT_DATABASE_URL_ENV]: secretUrl },
      spawn: ((...args: SpawnArgs) => {
        calls.push(args);
        return fakeRun('{"stage":"account.provision","status":"created","sub":"sub_x"}\n');
      }) as unknown as typeof spawnSync,
    });

    run({ service: 'account', action: 'provision', input: { correlation_id: 'c1' } });

    const [command, argv, options] = calls[0] as SpawnArgs;
    const argvText = (argv ?? []).join(' ');
    expect(command).toBe('npx');
    expect(argvText).not.toContain(secretUrl);
    expect(argvText).not.toContain('password');
    expect(argvText).not.toContain('correlation');
    expect(options).toMatchObject({ shell: false, cwd: expect.stringContaining('apps/account') });
    expect((options as { input: string }).input).toBe('{"correlation_id":"c1"}\n');
  });

  it('sends each service its own database URL under DATABASE_URL', () => {
    const calls: SpawnArgs[] = [];
    const accountUrl = 'postgresql://a@host/db-account';
    const staffUrl = 'postgresql://b@host/db-staff-access';
    const runner = createSpawnStageRunner({
      env: { [ACCOUNT_DATABASE_URL_ENV]: accountUrl, [STAFF_ACCESS_DATABASE_URL_ENV]: staffUrl },
      spawn: ((...args: SpawnArgs) => {
        calls.push(args);
        return fakeRun('{"stage":"x","status":"created"}\n');
      }) as unknown as typeof spawnSync,
    });

    runner({ service: 'account', action: 'provision', input: {} });
    runner({ service: 'staff-access', action: 'staff-provision', input: {} });

    const first = calls[0]?.[2] as { env: NodeJS.ProcessEnv; cwd: string };
    const second = calls[1]?.[2] as { env: NodeJS.ProcessEnv; cwd: string };
    expect(first.env['DATABASE_URL']).toBe(accountUrl);
    expect(second.env['DATABASE_URL']).toBe(staffUrl);
    expect(first.cwd).toContain('apps/account');
    expect(second.cwd).toContain('apps/staff-access');
  });

  it('never lets a child see the other service credential', () => {
    // Mỗi tiến trình con chỉ thấy chuỗi kết nối của database nó sở hữu: một
    // bước `account` cầm được credential của `db-staff-access` là vượt ranh giới
    // sở hữu dữ liệu, kể cả khi nó không dùng tới.
    const calls: SpawnArgs[] = [];
    const accountUrl = 'postgresql://a@host/db-account';
    const staffUrl = 'postgresql://b@host/db-staff-access';
    const runner = createSpawnStageRunner({
      env: { [ACCOUNT_DATABASE_URL_ENV]: accountUrl, [STAFF_ACCESS_DATABASE_URL_ENV]: staffUrl },
      spawn: ((...args: SpawnArgs) => {
        calls.push(args);
        return fakeRun('{"stage":"x","status":"created"}\n');
      }) as unknown as typeof spawnSync,
    });

    runner({ service: 'account', action: 'provision', input: {} });
    runner({ service: 'staff-access', action: 'staff-provision', input: {} });

    const accountCall = calls[0] as SpawnArgs;
    const staffCall = calls[1] as SpawnArgs;
    const accountEnv = (accountCall[2] as { env: NodeJS.ProcessEnv }).env;
    const staffEnv = (staffCall[2] as { env: NodeJS.ProcessEnv }).env;
    expect(Object.values(accountEnv)).not.toContain(staffUrl);
    expect(Object.values(staffEnv)).not.toContain(accountUrl);
    expect(accountEnv[STAFF_ACCESS_DATABASE_URL_ENV]).toBeUndefined();
    expect(staffEnv[ACCOUNT_DATABASE_URL_ENV]).toBeUndefined();
  });

  it('passes only the runtime allowlist, never the rest of the orchestrator environment', () => {
    // Env của người vận hành có thể mang token CI, credential của dịch vụ khác
    // hay biến của shell tương tác. Chỉ allowlist tối thiểu của `npx`/`tsx` và
    // đúng `DATABASE_URL` của service được đi qua.
    const calls: SpawnArgs[] = [];
    const runner = createSpawnStageRunner({
      env: {
        [ACCOUNT_DATABASE_URL_ENV]: 'postgresql://a@host/db-account',
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/home/operator',
        NODE_OPTIONS: '--max-old-space-size=512',
        npm_config_registry: 'https://registry.example.test',
        GITHUB_TOKEN: 'ghs_secret_token',
        CLOUDFLARE_API_TOKEN: 'cf_secret_token',
        AWS_SECRET_ACCESS_KEY: 'aws_secret',
        SOME_FUTURE_SECRET: 'future_secret',
      },
      spawn: ((...args: SpawnArgs) => {
        calls.push(args);
        return fakeRun('{"stage":"account.provision","status":"created"}\n');
      }) as unknown as typeof spawnSync,
    });

    runner({ service: 'account', action: 'provision', input: {} });

    const firstCall = calls[0] as SpawnArgs;
    const env = (firstCall[2] as { env: NodeJS.ProcessEnv }).env;
    expect(env['PATH']).toBe('/usr/local/bin:/usr/bin');
    expect(env['HOME']).toBe('/home/operator');
    expect(env['NODE_OPTIONS']).toBe('--max-old-space-size=512');
    expect(env['npm_config_registry']).toBe('https://registry.example.test');
    expect(env['DATABASE_URL']).toBe('postgresql://a@host/db-account');
    for (const leaked of ['ghs_secret_token', 'cf_secret_token', 'aws_secret', 'future_secret']) {
      expect(Object.values(env)).not.toContain(leaked);
    }
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['SOME_FUTURE_SECRET']).toBeUndefined();
    // `NODE_OPTIONS` được phép, nhưng một biến `ECOMA_*` không nằm trong
    // allowlist thì không.
    expect(env[STAFF_ACCESS_DATABASE_URL_ENV]).toBeUndefined();
  });

  it('returns the parsed payload and separates the stage/status envelope', () => {
    const { run } = withSpawn(
      fakeRun('{"stage":"account.verify","status":"verified","sub":"sub_x"}\n'),
    );

    const result = run({ service: 'account', action: 'verify', input: {} });

    expect(result).toEqual({
      ok: true,
      stage: 'account.verify',
      status: 'verified',
      payload: { sub: 'sub_x' },
    });
  });

  it('reads the denial reason from stderr and never surfaces stderr text', () => {
    const { run } = withSpawn(
      fakeRun('', '{"stage":"staff.provision","status":"denied","reason":"mode_mismatch"}\n', 1),
    );

    const result = run({ service: 'staff-access', action: 'staff-provision', input: {} });

    expect(result).toEqual({
      ok: false,
      stage: 'staff.provision',
      reason: 'mode_mismatch',
    });
  });

  it('fails closed when the child exits non-zero without a reason code', () => {
    const { run } = withSpawn(fakeRun('', 'Error: connection refused\n', 1));

    const result = run({ service: 'account', action: 'provision', input: {} });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('service_failed');
  });

  it('fails closed on exit 0 with no JSON line', () => {
    const { run } = withSpawn(fakeRun('done\n'));

    const result = run({ service: 'account', action: 'provision', input: {} });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('missing_json_response');
  });

  it('fails closed on a JSON response that is not the stage envelope', () => {
    const { run } = withSpawn(fakeRun('{"sub":"sub_x"}\n'));

    const result = run({ service: 'account', action: 'verify', input: {} });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('malformed_json_response');
  });

  it('fails closed when the child reports a different stage than the one requested', () => {
    const { run } = withSpawn(
      fakeRun('{"stage":"staff.verify","status":"verified","staff_id":"s"}\n'),
    );

    const result = run({ service: 'staff-access', action: 'staff-assign', input: {} });

    expect(result).toEqual({
      ok: false,
      stage: 'staff.assign',
      reason: 'malformed_json_response',
    });
  });

  it('does not read a previous JSON line when the last line is truncated', () => {
    // Dòng cuối bị cắt cụt không được phép biến dòng JSON của một lần chạy khác
    // thành kết quả của lần này.
    const { run } = withSpawn(
      fakeRun('{"stage":"account.provision","status":"created","sub":"sub_a"}\n{"stage":"acc'),
    );

    const result = run({ service: 'account', action: 'provision', input: {} });

    expect(result).toEqual({
      ok: false,
      stage: 'account.provision',
      reason: 'missing_json_response',
    });
  });

  it('rejects a denial reason that is not a machine-readable code', () => {
    // Con lỗi không được chèn text tuỳ ý (địa chỉ, DSN) vào nhật ký vận hành.
    const { run } = withSpawn(
      fakeRun(
        '',
        '{"stage":"staff.assign","status":"denied","reason":"password=hunter2 host=db"}\n',
        1,
      ),
    );

    const result = run({ service: 'staff-access', action: 'staff-assign', input: {} });

    expect(result).toEqual({
      ok: false,
      stage: 'staff.assign',
      reason: 'service_failed',
    });
  });

  it('separates an output-buffer overflow from a spawn failure', () => {
    // `ENOBUFS` nghĩa là con đã chạy và in quá `maxBuffer`; không phải nó không
    // spawn được. Mã lý do phải phân biệt hai trường hợp.
    const spawn = (() => ({
      stdout: '',
      stderr: '',
      status: null,
      error: Object.assign(new Error('spawnSync npx ENOBUFS'), { code: 'ENOBUFS' }),
    })) as unknown as typeof spawnSync;
    const run = createSpawnStageRunner({ env: {}, spawn });

    const result = run({ service: 'account', action: 'provision', input: {} });

    expect(result).toEqual({
      ok: false,
      stage: 'account.provision',
      reason: 'output_limit_exceeded',
    });
  });

  it('reports a spawn failure by error code only', () => {
    const spawn = (() => ({
      stdout: '',
      stderr: '',
      status: null,
      error: Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }),
    })) as unknown as typeof spawnSync;
    const run = createSpawnStageRunner({ env: {}, spawn });

    const result = run({ service: 'account', action: 'provision', input: {} });

    expect(result).toEqual({
      ok: false,
      stage: 'account.provision',
      reason: 'spawn_failed:ENOENT',
    });
  });
});
