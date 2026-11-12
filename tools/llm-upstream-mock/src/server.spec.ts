/**
 * Unit test hành vi của server qua HTTP thật (listen ephemeral trên loopback,
 * gọi bằng `fetch` của Node).
 *
 * Mỗi scenario lỗi của ma trận được bắn vào đúng endpoint thật — đây là tầng
 * `test` của project này (mock tự test chính nó), KHÔNG phải unit test của
 * project consumer khác (Issue #132: mock chỉ phục vụ integration/system test
 * cho consumer; tự test của nó là `test` target hợp lệ).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MockConfig } from './config.js';
import { startMockServer, type RunningMockServer } from './server.js';

/** Config base cho suite — port 0 (ephemeral), hai model, content cố định. */
function baseConfig(overrides: Partial<MockConfig> = {}): MockConfig {
  return {
    port: 0,
    defaultScenario: 'ok',
    models: ['mock-a', 'mock-b'],
    content: 'Hello from llm-upstream-mock.',
    timeoutMs: 5_000,
    ...overrides,
  };
}

const servers: RunningMockServer[] = [];

/** Bổ sung server vào danh sách dọn dẹp TRƯỚC khi await — setup hỏng giữa chừng vẫn được close. */
async function startTracked(config: MockConfig): Promise<RunningMockServer> {
  const running = await startMockServer(config);
  servers.push(running);
  return running;
}

let server: RunningMockServer;
let timeoutServer: RunningMockServer;
let authServer: RunningMockServer;

/** Giá trị Bearer giả chỉ dùng trong test — không phải credential thật của bất kỳ ai. */
const EXPECTED_BEARER = 'Bearer sk-test-expected-auth-value';

beforeAll(async () => {
  server = await startTracked(baseConfig());
  // Server riêng cho scenario `timeout`: timeoutMs lớn hơn hẳn abort của client
  // — nếu server phản hồi (bug) thì fetch sẽ resolve trước khi client abort.
  timeoutServer = await startTracked(baseConfig({ timeoutMs: 60_000 }));
  // Server bật kiểm `Authorization` (mặc định tắt trên hai server trên).
  authServer = await startTracked(
    baseConfig({ expectedAuthorization: [EXPECTED_BEARER, 'Bearer sk-test-rotated-auth-value'] }),
  );
});

afterAll(async () => {
  for (const running of servers) {
    await running.close();
  }
});

/** POST một body JSON lên completions, trả status + content-type + text body. */
async function postCompletion(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  contentType: string;
  allow: string;
  retryAfter: string;
  text: string;
}> {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    allow: response.headers.get('allow') ?? '',
    retryAfter: response.headers.get('retry-after') ?? '',
    text: await response.text(),
  };
}

describe('happy path (default scenario ok)', () => {
  it('answers non-streaming completions with the configured content in OpenAI shape', async () => {
    const response = await postCompletion(
      server.url,
      JSON.stringify({ model: 'mock-a', messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toBe('application/json');
    const body = JSON.parse(response.text) as Record<string, unknown>;
    expect(body['object']).toBe('chat.completion');
    expect(body['model']).toBe('mock-a');
    const choices = body['choices'] as {
      message: { role: string; content: string };
      finish_reason: string;
    }[];
    expect(choices).toHaveLength(1);
    expect(choices[0]?.message).toEqual({
      role: 'assistant',
      content: 'Hello from llm-upstream-mock.',
    });
    expect(choices[0]?.finish_reason).toBe('stop');
  });

  it('falls back to the first configured model when the request omits one', async () => {
    const response = await postCompletion(server.url, JSON.stringify({ messages: [] }));
    expect((JSON.parse(response.text) as Record<string, unknown>)['model']).toBe('mock-a');
  });

  it('detects "stream": true and serves a distinguishable SSE stream', async () => {
    const response = await postCompletion(
      server.url,
      JSON.stringify({ model: 'mock-a', stream: true, messages: [] }),
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toBe('text/event-stream');
    expect(response.text).toContain('"object":"chat.completion.chunk"');
    expect(response.text).toContain('"content":"Hello from llm-upstream-mock."');
    expect(response.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('treats explicit "stream": false as non-streaming JSON', async () => {
    const response = await postCompletion(
      server.url,
      JSON.stringify({ model: 'mock-a', stream: false, messages: [] }),
    );
    expect(response.contentType).toBe('application/json');
    expect((JSON.parse(response.text) as Record<string, unknown>)['object']).toBe(
      'chat.completion',
    );
  });

  it('serves the configured model list on GET /v1/models', async () => {
    const response = await fetch(`${server.url}/v1/models`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(await response.text()) as {
      object: string;
      data: { id: string; object: string; owned_by: string }[];
    };
    expect(body.object).toBe('list');
    expect(body.data.map((model) => model.id)).toEqual(['mock-a', 'mock-b']);
    for (const model of body.data) {
      expect(model.object).toBe('model');
      expect(model.owned_by).toBe('ecoma-io-mock');
    }
  });
});

describe('per-request scenario override via header', () => {
  it('lets the x-mock-scenario header win over the configured default', async () => {
    const response = await postCompletion(server.url, JSON.stringify({ messages: [] }), {
      'x-mock-scenario': 'rate_limited',
    });
    expect(response.status).toBe(429);
  });

  it('rejects an unknown scenario value with 400 instead of silently falling back', async () => {
    const response = await postCompletion(server.url, JSON.stringify({ messages: [] }), {
      'x-mock-scenario': 'bogus_scenario',
    });
    expect(response.status).toBe(400);
    const envelope = JSON.parse(response.text) as { error: { type: string } };
    expect(envelope.error.type).toBe('invalid_request_error');
  });
});

describe('error scenario matrix', () => {
  it('injects 401 invalid api key in the OpenAI error envelope', async () => {
    const response = await postCompletion(server.url, JSON.stringify({ messages: [] }), {
      'x-mock-scenario': 'unauthorized',
    });

    expect(response.status).toBe(401);
    expect(response.contentType).toBe('application/json');
    const envelope = JSON.parse(response.text) as {
      error: { message: string; type: string; code: string | null; param: string | null };
    };
    expect(envelope.error.type).toBe('invalid_request_error');
    expect(envelope.error.code).toBe('invalid_api_key');
    expect(envelope.error.param).toBeNull();
  });

  it('injects 429 rate limit with a Retry-After header', async () => {
    const response = await postCompletion(server.url, JSON.stringify({ messages: [] }), {
      'x-mock-scenario': 'rate_limited',
    });

    expect(response.status).toBe(429);
    expect(response.retryAfter).toBe('1');
    const envelope = JSON.parse(response.text) as { error: { type: string; code: string | null } };
    expect(envelope.error.type).toBe('rate_limit_error');
    expect(envelope.error.code).toBe('rate_limit_exceeded');
  });

  it('injects a 5xx upstream failure as api_error', async () => {
    const response = await postCompletion(server.url, JSON.stringify({ messages: [] }), {
      'x-mock-scenario': 'server_error',
    });

    expect(response.status).toBe(500);
    const envelope = JSON.parse(response.text) as { error: { type: string; code: string | null } };
    expect(envelope.error.type).toBe('api_error');
    expect(envelope.error.code).toBeNull();
  });

  it('injects a malformed body that parses as JSON but violates the OpenAI shape', async () => {
    const response = await postCompletion(server.url, JSON.stringify({ messages: [] }), {
      'x-mock-scenario': 'malformed',
    });

    expect(response.status).toBe(200);
    expect(response.contentType).toBe('application/json');
    const body = JSON.parse(response.text) as Record<string, unknown>;
    expect(body).toEqual({
      detail: 'llm-upstream-mock served a deliberately malformed response body',
    });
    expect(body['choices']).toBeUndefined();
    expect(body['usage']).toBeUndefined();
  });

  it('applies the scenario matrix to GET /v1/models as well', async () => {
    const response = await fetch(`${server.url}/v1/models`, {
      headers: { 'x-mock-scenario': 'unauthorized' },
    });
    expect(response.status).toBe(401);
  });
});

describe('timeout scenario sends no response at all', () => {
  it('lets the client give up while the socket is still hanging', async () => {
    // Client abort sau 300ms; server timeoutMs 60s — fetch chỉ có thể kết thúc
    // bằng abort, chứng minh server KHÔNG gửi bất kỳ byte response nào.
    // Bắt lỗi thủ công thay vì `rejects.toThrow()`: assert đúng loại lỗi
    // TimeoutError của client (rule `require-to-throw-message` cấm toThrow
    // không message; assert name chặt hơn nữa).
    let abortError: unknown;
    const startedAt = Date.now();
    try {
      await fetch(`${timeoutServer.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mock-scenario': 'timeout' },
        body: JSON.stringify({ messages: [] }),
        signal: AbortSignal.timeout(300),
      });
    } catch (caught) {
      abortError = caught;
    }
    const elapsed = Date.now() - startedAt;
    expect(abortError).toBeInstanceOf(Error);
    expect((abortError as Error).name).toBe('TimeoutError');
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(60_000);
  });

  it('still serves other clients while one socket is hanging', async () => {
    const response = await fetch(`${timeoutServer.url}/v1/models`);
    expect(response.status).toBe(200);
  });
});

describe('optional authorization gate (MOCK_UPSTREAM_EXPECTED_AUTHORIZATION)', () => {
  it('serves requests whose Authorization header matches any accepted value', async () => {
    const first = await fetch(`${authServer.url}/v1/models`, {
      headers: { authorization: EXPECTED_BEARER },
    });
    expect(first.status).toBe(200);
    const rotated = await fetch(`${authServer.url}/v1/models`, {
      headers: { authorization: 'Bearer sk-test-rotated-auth-value' },
    });
    expect(rotated.status).toBe(200);
  });

  it('rejects a wrong or absent Authorization header with 401 invalid_api_key', async () => {
    const wrong = await fetch(`${authServer.url}/v1/models`, {
      headers: { authorization: 'Bearer sk-test-wrong-value' },
    });
    expect(wrong.status).toBe(401);
    const envelope = JSON.parse(await wrong.text()) as { error: { code: string | null } };
    expect(envelope.error.code).toBe('invalid_api_key');

    const absent = await fetch(`${authServer.url}/v1/models`);
    expect(absent.status).toBe(401);
  });

  it('keeps the gate off by default: a garbage Authorization header still gets served', async () => {
    // Pin hợp đồng PR #137: không cấu hình → không kiểm auth, kể cả header rác.
    const response = await fetch(`${server.url}/v1/models`, {
      headers: { authorization: 'Bearer definitely-not-checked' },
    });
    expect(response.status).toBe(200);
  });

  it('logs only the one-bit auth verdict, never the header value', async () => {
    const loggedLines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      loggedLines.push(args.map((arg) => String(arg)).join(' '));
    });
    try {
      await fetch(`${authServer.url}/v1/models`, { headers: { authorization: EXPECTED_BEARER } });
      await fetch(`${authServer.url}/v1/models`, {
        headers: { authorization: 'Bearer sk-test-wrong-value' },
      });
    } finally {
      logSpy.mockRestore();
    }
    const logged = loggedLines.join('\n');
    expect(logged).toContain('GET /v1/models scenario=ok status=200 duration_ms=');
    expect(logged).toContain(' auth=ok\n');
    expect(logged).toContain(' auth=rejected');
    expect(logged).not.toContain('sk-test-expected-auth-value');
    expect(logged).not.toContain('sk-test-wrong-value');
  });
});

describe('control paths stay structural regardless of scenario', () => {
  it('answers unknown routes with a 404 envelope', async () => {
    const response = await fetch(`${server.url}/definitely-not-a-route`);
    expect(response.status).toBe(404);
    const envelope = JSON.parse(await response.text()) as { error: { type: string } };
    expect(envelope.error.type).toBe('invalid_request_error');
  });

  it('answers POST /v1/models with 405 and Allow: GET', async () => {
    const response = await fetch(`${server.url}/v1/models`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('answers GET /v1/chat/completions with 405 and Allow: POST', async () => {
    const response = await fetch(`${server.url}/v1/chat/completions`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('answers an invalid JSON body with 400 without dispatching the scenario', async () => {
    const response = await postCompletion(server.url, 'this is not json', {
      'x-mock-scenario': 'ok',
    });
    expect(response.status).toBe(400);
    const envelope = JSON.parse(response.text) as { error: { type: string } };
    expect(envelope.error.type).toBe('invalid_request_error');
  });
});

describe('logging exposes metadata only', () => {
  it('never writes prompt or response bodies into the log lines', async () => {
    const PROMPT_MARKER = 'SECRET-PROMPT-BODY-MARKER';
    // Thu trực tiếp vào mảng riêng (không dùng mock rỗng — rule `no-empty-function`)
    // và vẫn nuốt log để stdout test không nhiễu.
    const loggedLines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      loggedLines.push(args.map((arg) => String(arg)).join(' '));
    });

    try {
      await postCompletion(
        server.url,
        JSON.stringify({ messages: [{ role: 'user', content: PROMPT_MARKER }] }),
      );
      await fetch(`${server.url}/v1/models`);
    } finally {
      logSpy.mockRestore();
    }

    const logged = loggedLines.join('\n');
    expect(logged).not.toContain(PROMPT_MARKER);
    expect(logged).not.toContain('Hello from llm-upstream-mock.');
    expect(logged).toContain('POST /v1/chat/completions scenario=ok status=200');
    expect(logged).toContain('GET /v1/models scenario=ok status=200');
  });
});
