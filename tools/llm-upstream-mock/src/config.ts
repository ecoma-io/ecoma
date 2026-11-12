/**
 * Cấu hình của mock upstream — đọc từ biến môi trường, parse một lần lúc boot.
 *
 * Toàn bộ biến đều tùy chọn: không set nào cũng chạy được với default. Parse
 * lỗi (giá trị sai kiểu, sai miền giá trị, JSON hỏng) phải fail-fast ngay lúc
 * boot bằng `ConfigError` thay vì âm thầm dùng default — một mock chạy sai
 * scenario còn nguy hơn mock không chạy, vì consumer test sẽ xanh giả.
 */

/** Tên các scenario hợp lệ của ma trận lỗi (đồng bộ với README). */
export const SCENARIOS = [
  'ok',
  'unauthorized',
  'rate_limited',
  'server_error',
  'timeout',
  'malformed',
] as const;

export type Scenario = (typeof SCENARIOS)[number];

/** Header per-request override scenario mặc định — hợp đồng ghi ở README. */
export const SCENARIO_HEADER = 'x-mock-scenario';

/** Cấu hình đã parse của server. Tất cả field read-only để handler không mutate. */
export interface MockConfig {
  readonly port: number;
  readonly defaultScenario: Scenario;
  readonly models: readonly string[];
  readonly content: string;
  readonly timeoutMs: number;
  /**
   * Giá trị `Authorization` header được chấp nhận (test-only, mặc định tắt).
   * Nhiều giá trị phục vụ nhóm kịch bản rotation: endpoint URL của consumer
   * là immutable nên một mock instance phải chấp nhận cả credential cũ và mới.
   */
  readonly expectedAuthorization?: readonly string[];
}

/** Lỗi cấu hình — ném lúc boot, message tiếng Anh vì là runtime output. */
export class ConfigError extends Error {}

export const DEFAULT_PORT = 8787;
export const DEFAULT_SCENARIO: Scenario = 'ok';
export const DEFAULT_MODELS: readonly string[] = ['mock-chat-model'];
export const DEFAULT_CONTENT = 'Hello from llm-upstream-mock.';
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Parse tên scenario từ chuỗi tự do (env hoặc header). Trả `undefined` khi
 * giá trị không thuộc ma trận — caller quyết định fail-fast hay dùng default.
 */
export function parseScenario(value: string): Scenario | undefined {
  return (SCENARIOS as readonly string[]).includes(value) ? (value as Scenario) : undefined;
}

/** Parse một biến env số nguyên không âm; `undefined`/rỗng → default. */
function parsePositiveInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ConfigError(`${key} must be an integer between 0 and ${max}, got: ${raw}`);
  }
  return parsed;
}

/** Parse `MOCK_UPSTREAM_MODELS`: mảng JSON các chuỗi, không rỗng. */
function parseModels(env: Record<string, string | undefined>): readonly string[] {
  const raw = env['MOCK_UPSTREAM_MODELS'];
  if (raw === undefined || raw === '') {
    return DEFAULT_MODELS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ConfigError(`MOCK_UPSTREAM_MODELS must be a JSON array of model id strings`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((item): item is string => typeof item === 'string' && item.length > 0)
  ) {
    throw new ConfigError(`MOCK_UPSTREAM_MODELS must be a non-empty JSON array of strings`);
  }
  return parsed;
}

/**
 * Parse `MOCK_UPSTREAM_EXPECTED_AUTHORIZATION`: unset/rỗng → tắt kiểm (hợp đồng
 * PR #137 giữ nguyên); giá trị thường → một giá trị được chấp nhận; JSON array
 * mở đầu bằng `[` → nhiều giá trị (rotation). Parse lỗi là ConfigError vì một
 * mock kiểm auth bằng giá trị sai cho test xanh giả.
 */
function parseExpectedAuthorization(
  env: Record<string, string | undefined>,
): readonly string[] | undefined {
  const raw = env['MOCK_UPSTREAM_EXPECTED_AUTHORIZATION'];
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!raw.startsWith('[')) {
    return [raw];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ConfigError(
      'MOCK_UPSTREAM_EXPECTED_AUTHORIZATION looks like a JSON array but does not parse',
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((item): item is string => typeof item === 'string' && item.length > 0)
  ) {
    throw new ConfigError(
      'MOCK_UPSTREAM_EXPECTED_AUTHORIZATION must be a non-empty JSON array of strings',
    );
  }
  return parsed;
}

/** Parse toàn bộ config từ một map env-like (inject được để unit test). */
export function parseConfig(env: Record<string, string | undefined>): MockConfig {
  const rawScenario = env['MOCK_UPSTREAM_SCENARIO'];
  let defaultScenario = DEFAULT_SCENARIO;
  if (rawScenario !== undefined && rawScenario !== '') {
    const parsed = parseScenario(rawScenario);
    if (parsed === undefined) {
      throw new ConfigError(
        `MOCK_UPSTREAM_SCENARIO must be one of: ${SCENARIOS.join(', ')}. Got: ${rawScenario}`,
      );
    }
    defaultScenario = parsed;
  }

  return {
    port: parsePositiveInt(env, 'MOCK_UPSTREAM_PORT', DEFAULT_PORT, 65_535),
    defaultScenario,
    models: parseModels(env),
    content:
      env['MOCK_UPSTREAM_CONTENT'] === undefined || env['MOCK_UPSTREAM_CONTENT'] === ''
        ? DEFAULT_CONTENT
        : env['MOCK_UPSTREAM_CONTENT'],
    timeoutMs: parsePositiveInt(env, 'MOCK_UPSTREAM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 600_000),
    expectedAuthorization: parseExpectedAuthorization(env),
  };
}
