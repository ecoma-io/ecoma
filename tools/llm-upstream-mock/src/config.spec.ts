/**
 * Unit test parse config — inject env-like record, không đụng process.env thật.
 * Mỗi biến: default khi thiếu/rỗng, giá trị hợp lệ parse đúng, giá trị sai
 * ném `ConfigError` với message tiếng Anh (runtime output).
 */

import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_CONTENT,
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
