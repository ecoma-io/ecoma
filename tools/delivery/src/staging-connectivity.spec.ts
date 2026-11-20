import { describe, expect, it } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import {
  buildVpcServiceCreateArgs,
  createStagingVpcService,
  parseServiceId,
  validateHostname,
  validateTcpPort,
  validateTunnelId,
  type VpcServiceDeps,
  type VpcServiceInput,
} from './staging-connectivity.ts';
import {
  CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS,
  CONTROL_PLANE_TOKEN_ENV_KEYS,
} from './worker-secrets.ts';

const TUNNEL_ID = '5301ca9d-9f0e-4b3c-8f2a-1d6e7b9c0a41';
const SERVICE_ID = 'b2f4c6a8-1234-4fef-9abc-deadbeef01ab';

/** Stdout thật của `wrangler vpc service create` trên pin 4.165.0 (VP4). */
const WRANGLER_CREATE_STDOUT =
  `🚧 Creating VPC service 'stg-pg-staging'\n` +
  `✅ Created VPC service: ${SERVICE_ID}\n` +
  `name: stg-pg-staging\n`;

const validInput = (overrides: Partial<VpcServiceInput> = {}): VpcServiceInput => ({
  name: 'stg-pg-staging',
  tunnelId: TUNNEL_ID,
  hostname: 'pg-staging.ecoma.io.vn',
  tcpPort: 5432,
  appProtocol: 'postgresql',
  ...overrides,
});

const okDeps = (
  stdout = WRANGLER_CREATE_STDOUT,
): VpcServiceDeps & {
  calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>;
} => {
  const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  return {
    calls,
    execFn: (command, args, cwd, env) => {
      calls.push({ command, args, cwd, env });
      const result: ExecResult = { status: 0, stdout, stderr: '' };
      return result;
    },
  };
};

const envSource = {
  PATH: '/usr/bin',
  HOME: '/home/op',
  [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 'cf-token',
  [CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging]: 'cf-account-id',
};

describe('validateTunnelId', () => {
  it('accepts a UUID and rejects typos', () => {
    expect(validateTunnelId(TUNNEL_ID)).toBe(TUNNEL_ID);
    expect(() => validateTunnelId('not-a-uuid')).toThrowError(/invalid tunnel id/u);
    expect(() => validateTunnelId('')).toThrowError(/invalid tunnel id/u);
  });
});

describe('validateHostname', () => {
  it('accepts a bare DNS hostname and rejects schemes, paths and whitespace', () => {
    expect(validateHostname('pg-staging.ecoma.io.vn')).toBe('pg-staging.ecoma.io.vn');
    // Lane này chỉ nhận hostname dạng DNS CNAME — IP đi qua cờ --ipv4/--ipv6
    // của wrangler, không phải shape input của lane.
    expect(() => validateHostname('10.0.0.8')).toThrowError(/invalid origin hostname/u);
    expect(() => validateHostname('https://pg-staging.ecoma.io.vn')).toThrowError(
      /invalid origin hostname/u,
    );
    expect(() => validateHostname('pg-staging.ecoma.io.vn:5432')).toThrowError(
      /invalid origin hostname/u,
    );
    expect(() => validateHostname('pg staging')).toThrowError(/invalid origin hostname/u);
    expect(() => validateHostname('')).toThrowError(/invalid origin hostname/u);
  });
});

describe('validateTcpPort', () => {
  it('accepts integers in 1..65535 and rejects the rest', () => {
    expect(validateTcpPort(5432)).toBe(5432);
    expect(() => validateTcpPort(0)).toThrowError(/invalid TCP port/u);
    expect(() => validateTcpPort(65536)).toThrowError(/invalid TCP port/u);
    expect(() => validateTcpPort(5432.5)).toThrowError(/invalid TCP port/u);
  });
});

describe('buildVpcServiceCreateArgs', () => {
  it('builds the explicit tcp argv with tunnel, hostname, port and app protocol', () => {
    expect(buildVpcServiceCreateArgs(validInput())).toEqual([
      'vpc',
      'service',
      'create',
      'stg-pg-staging',
      '--type',
      'tcp',
      '--tunnel-id',
      TUNNEL_ID,
      '--hostname',
      'pg-staging.ecoma.io.vn',
      '--tcp-port',
      '5432',
      '--app-protocol',
      'postgresql',
    ]);
  });

  it('rejects an invalid tunnel id, hostname or port before any argv is used', () => {
    expect(() => buildVpcServiceCreateArgs(validInput({ tunnelId: 'junk' }))).toThrowError(
      /invalid tunnel id/u,
    );
    expect(() => buildVpcServiceCreateArgs(validInput({ hostname: 'bad host' }))).toThrowError(
      /invalid origin hostname/u,
    );
    expect(() => buildVpcServiceCreateArgs(validInput({ tcpPort: 0 }))).toThrowError(
      /invalid TCP port/u,
    );
  });
});

describe('parseServiceId', () => {
  it('parses the service id from the real wrangler create output line', () => {
    expect(parseServiceId(WRANGLER_CREATE_STDOUT)).toBe(SERVICE_ID);
  });

  it('fails closed when wrangler output no longer contains the created line', () => {
    expect(() => parseServiceId('something changed in a future wrangler version\n')).toThrowError(
      /did not report a service_id/u,
    );
    expect(() => parseServiceId('')).toThrowError(/did not report a service_id/u);
  });
});

describe('createStagingVpcService', () => {
  it('runs wrangler with the shared token only in the subprocess env and never in argv', () => {
    const deps = okDeps();
    const { serviceId } = createStagingVpcService(validInput(), envSource, deps);
    expect(serviceId).toBe(SERVICE_ID);
    const call = deps.calls[0] as (typeof deps.calls)[number];
    expect(call.command).toBe('npx');
    expect(call.args[0]).toBe('wrangler');
    expect(call.args.slice(1)).toEqual(buildVpcServiceCreateArgs(validInput()));
    expect(call.env.CLOUDFLARE_API_TOKEN).toBe('cf-token');
    expect(call.env.CLOUDFLARE_ACCOUNT_ID).toBe('cf-account-id');
    expect(call.env.CI).toBe('1');
    // Token KHÔNG BAO GIỜ nằm trong argv (/proc/<pid>/cmdline đọc được).
    expect(call.args.join(' ')).not.toContain('cf-token');
  });

  it('refuses a service name outside the staging identity before wrangler runs', () => {
    const deps = okDeps();
    expect(() =>
      createStagingVpcService(validInput({ name: 'pg-staging' }), envSource, deps),
    ).toThrowError(/not a staging identity/u);
    expect(deps.calls).toEqual([]);
  });

  it('refuses missing control-plane credential before wrangler runs', () => {
    const deps = okDeps();
    expect(() => createStagingVpcService(validInput(), {}, deps)).toThrowError(
      new RegExp(CONTROL_PLANE_TOKEN_ENV_KEYS.staging, 'u'),
    );
    // Cặp bất khả tách: thiếu account id cũng là từ chối với đúng tên secret.
    expect(() =>
      createStagingVpcService(validInput(), { [CONTROL_PLANE_TOKEN_ENV_KEYS.staging]: 't' }, deps),
    ).toThrowError(new RegExp(CONTROL_PLANE_ACCOUNT_ID_ENV_KEYS.staging, 'u'));
    expect(deps.calls).toEqual([]);
  });

  it('refuses an invalid tunnel id before wrangler runs', () => {
    const deps = okDeps();
    expect(() =>
      createStagingVpcService(validInput({ tunnelId: 'host-not-provisioned' }), envSource, deps),
    ).toThrowError(/invalid tunnel id/u);
    expect(deps.calls).toEqual([]);
  });

  it('surfaces wrangler failures instead of reporting success', () => {
    const deps: VpcServiceDeps = {
      execFn: () => ({
        status: 1,
        stdout: '',
        stderr: '[ERROR] A request to the Cloudflare API failed',
      }),
    };
    expect(() => createStagingVpcService(validInput(), envSource, deps)).toThrowError(
      /Cloudflare API/u,
    );
  });

  it('fails closed when a successful run carries no parseable service id', () => {
    const deps = okDeps('output format changed\n');
    expect(() => createStagingVpcService(validInput(), envSource, deps)).toThrowError(
      /did not report a service_id/u,
    );
  });
});
