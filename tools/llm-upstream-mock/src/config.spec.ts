/**
 * Unit test parse config — inject env-like record, không đụng process.env thật.
 * Mỗi biến: default khi thiếu/rỗng, giá trị hợp lệ parse đúng, giá trị sai
 * ném `ConfigError` với message tiếng Anh (runtime output).
 */

import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_CONTENT,
  DEFAULT_HOST,
  DEFAULT_MODELS,
  DEFAULT_PORT,
  DEFAULT_SCENARIO,
  DEFAULT_TIMEOUT_MS,
  SCENARIO_HEADER,
  parseConfig,
  parseScenario,
  type Scenario,
} from './config.js';

/**
 * Chạy `parseConfig` và bắt lỗi nếu có — trả `undefined` khi parse thành công.
 * Assertion nằm trong thân test (rule `vitest/expect-expect`), helper chỉ thu
 * giá trị để test expect trực tiếp trên nó.
 */
function caughtFromParse(env: Record<string, string | undefined>): unknown {
  try {
    parseConfig(env);
  } catch (caught) {
    return caught;
  }
  return undefined;
}

describe('parseConfig defaults', () => {
  it('falls back to every default when the environment is empty', () => {
    expect(parseConfig({})).toEqual({
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      defaultScenario: DEFAULT_SCENARIO,
      models: DEFAULT_MODELS,
      content: DEFAULT_CONTENT,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  it('treats empty-string variables the same as unset variables', () => {
    expect(
      parseConfig({
        MOCK_UPSTREAM_PORT: '',
        MOCK_UPSTREAM_HOST: '',
        MOCK_UPSTREAM_SCENARIO: '',
        MOCK_UPSTREAM_MODELS: '',
        MOCK_UPSTREAM_CONTENT: '',
        MOCK_UPSTREAM_TIMEOUT_MS: '',
      }),
    ).toEqual(parseConfig({}));
  });
});

describe('parseConfig valid values', () => {
  it('accepts port 0 for an ephemeral listen socket', () => {
    expect(parseConfig({ MOCK_UPSTREAM_PORT: '0' }).port).toBe(0);
  });

  it('accepts the boundary port 65535', () => {
    expect(parseConfig({ MOCK_UPSTREAM_PORT: '65535' }).port).toBe(65_535);
  });

  it('accepts every scenario name in the matrix', () => {
    const scenarios: readonly Scenario[] = [
      'ok',
      'unauthorized',
      'rate_limited',
      'server_error',
      'timeout',
      'malformed',
    ];
    for (const scenario of scenarios) {
      expect(parseConfig({ MOCK_UPSTREAM_SCENARIO: scenario }).defaultScenario).toBe(scenario);
    }
  });

  it('parses the model list JSON preserving order', () => {
    expect(parseConfig({ MOCK_UPSTREAM_MODELS: '["mock-b","mock-a"]' }).models).toEqual([
      'mock-b',
      'mock-a',
    ]);
  });

  it('accepts custom content and timeout values', () => {
    const config = parseConfig({
      MOCK_UPSTREAM_CONTENT: 'pong',
      MOCK_UPSTREAM_TIMEOUT_MS: '1500',
    });
    expect(config.content).toBe('pong');
    expect(config.timeoutMs).toBe(1_500);
  });

  it('parses a plain string as a single accepted authorization value', () => {
    expect(
      parseConfig({ MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: 'Bearer sk-a' }).expectedAuthorization,
    ).toEqual(['Bearer sk-a']);
  });

  it('parses a JSON array of accepted authorization values for rotation groups', () => {
    expect(
      parseConfig({ MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: '["Bearer sk-a","Bearer sk-b"]' })
        .expectedAuthorization,
    ).toEqual(['Bearer sk-a', 'Bearer sk-b']);
  });

  it('leaves the authorization check disabled when the variable is unset or empty', () => {
    expect(parseConfig({}).expectedAuthorization).toBeUndefined();
    expect(
      parseConfig({ MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: '' }).expectedAuthorization,
    ).toBeUndefined();
  });

  it('keeps the host-only default binding when MOCK_UPSTREAM_HOST is unset or empty', () => {
    expect(parseConfig({}).host).toBe(DEFAULT_HOST);
    expect(parseConfig({ MOCK_UPSTREAM_HOST: '' }).host).toBe(DEFAULT_HOST);
    expect(parseConfig({ MOCK_UPSTREAM_HOST: '   ' }).host).toBe(DEFAULT_HOST);
  });

  it('accepts hostname and IP literal bind addresses for the container mode', () => {
    expect(parseConfig({ MOCK_UPSTREAM_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(parseConfig({ MOCK_UPSTREAM_HOST: 'localhost' }).host).toBe('localhost');
    expect(parseConfig({ MOCK_UPSTREAM_HOST: '::' }).host).toBe('::');
    expect(parseConfig({ MOCK_UPSTREAM_HOST: '[::1]' }).host).toBe('[::1]');
    expect(parseConfig({ MOCK_UPSTREAM_HOST: ' ecoma-mock ' }).host).toBe('ecoma-mock');
  });
});

describe('parseConfig rejects an invalid authorization expectation', () => {
  it('rejects a JSON-array-looking value that does not parse', () => {
    const broken = caughtFromParse({ MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: '["Bearer sk-a",]' });
    expect(broken).toBeInstanceOf(ConfigError);
    expect((broken as ConfigError).message).toContain('MOCK_UPSTREAM_EXPECTED_AUTHORIZATION');
  });

  it('rejects an array that is empty or contains non-string/empty items', () => {
    const empty = caughtFromParse({ MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: '[]' });
    expect(empty).toBeInstanceOf(ConfigError);
    const nonString = caughtFromParse({ MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: '["Bearer a",5]' });
    expect(nonString).toBeInstanceOf(ConfigError);
    const emptyItem = caughtFromParse({ MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: '["Bearer a",""]' });
    expect(emptyItem).toBeInstanceOf(ConfigError);
  });
});

describe('parseConfig rejects invalid values', () => {
  it('rejects a non-numeric port', () => {
    const error = caughtFromParse({ MOCK_UPSTREAM_PORT: 'not-a-port' });
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('MOCK_UPSTREAM_PORT');
  });

  it('rejects a port above 65535 and a negative port', () => {
    const tooHigh = caughtFromParse({ MOCK_UPSTREAM_PORT: '65536' });
    expect(tooHigh).toBeInstanceOf(ConfigError);
    expect((tooHigh as ConfigError).message).toContain('MOCK_UPSTREAM_PORT');
    const negative = caughtFromParse({ MOCK_UPSTREAM_PORT: '-1' });
    expect(negative).toBeInstanceOf(ConfigError);
    expect((negative as ConfigError).message).toContain('MOCK_UPSTREAM_PORT');
  });

  it('rejects a scenario outside the matrix', () => {
    const error = caughtFromParse({ MOCK_UPSTREAM_SCENARIO: 'network_partition' });
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('MOCK_UPSTREAM_SCENARIO');
  });

  it('rejects malformed model list JSON', () => {
    const error = caughtFromParse({ MOCK_UPSTREAM_MODELS: '["a",],{' });
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('MOCK_UPSTREAM_MODELS');
  });

  it('rejects a model list that is not an array of non-empty strings', () => {
    const nonStringItem = caughtFromParse({ MOCK_UPSTREAM_MODELS: '["a",42]' });
    expect(nonStringItem).toBeInstanceOf(ConfigError);
    const emptyList = caughtFromParse({ MOCK_UPSTREAM_MODELS: '[]' });
    expect(emptyList).toBeInstanceOf(ConfigError);
    const notAnArray = caughtFromParse({ MOCK_UPSTREAM_MODELS: '"solo"' });
    expect(notAnArray).toBeInstanceOf(ConfigError);
  });

  it('rejects a negative or non-integer timeout', () => {
    const negative = caughtFromParse({ MOCK_UPSTREAM_TIMEOUT_MS: '-5' });
    expect(negative).toBeInstanceOf(ConfigError);
    expect((negative as ConfigError).message).toContain('MOCK_UPSTREAM_TIMEOUT_MS');
    const fractional = caughtFromParse({ MOCK_UPSTREAM_TIMEOUT_MS: '1.5' });
    expect(fractional).toBeInstanceOf(ConfigError);
    expect((fractional as ConfigError).message).toContain('MOCK_UPSTREAM_TIMEOUT_MS');
  });

  it('rejects a bind address that is not a hostname or IP literal', () => {
    const spaced = caughtFromParse({ MOCK_UPSTREAM_HOST: 'not a host' });
    expect(spaced).toBeInstanceOf(ConfigError);
    expect((spaced as ConfigError).message).toContain('MOCK_UPSTREAM_HOST');
    const url = caughtFromParse({ MOCK_UPSTREAM_HOST: 'http://127.0.0.1:8787' });
    expect(url).toBeInstanceOf(ConfigError);
    expect((url as ConfigError).message).toContain('MOCK_UPSTREAM_HOST');
  });
});

describe('parseScenario', () => {
  it('returns undefined for unknown names so callers can fail fast', () => {
    expect(parseScenario('bogus')).toBeUndefined();
  });

  it('is the same parser used for the per-request override header contract', () => {
    expect(SCENARIO_HEADER).toBe('x-mock-scenario');
    expect(parseScenario('rate_limited')).toBe('rate_limited');
  });
});
