/**
 * Contract tests — hàng rào chống drift giữa mock và API thật.
 *
 * Nguồn chân lý (đọc-only, không sửa trong project này):
 * - `docs/applications/llm-api/README.md` — data plane OpenAI-compatible
 *   (`/v1/chat/completions`, `/v1/models`), usage normalization đọc
 *   `prompt_tokens`/`completion_tokens`, missing/malformed provider usage
 *   phải đánh dấu `usage_status = malformed` chứ không coi là 0.
 * - `apps/llm-api/tests/integrations/http-contract.spec.ts` — hợp đồng list
 *   `{ object: 'list', data: [...] }` mà llm-api phục vụ.
 *
 * Các test ghim **đúng tập key** (không chỉ presence): mock thêm/bớt field nào
 * so với shape OpenAI mà consumer đọc là đỏ ngay tại đây.
 */

import { describe, expect, it } from 'vitest';

import {
  MALFORMED_BODY,
  buildChatCompletion,
  buildErrorEnvelope,
  buildModelList,
  buildSseEvents,
} from './shapes.js';

/** Lấy phần tử tại index với guard tường minh — repo cấm non-null assertion (oxlint). */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Expected an item at index ${index}.`);
  }
  return item;
}

/** Shape lỏng của một SSE chunk sau khi parse — đủ cho assertion key/delta. */
interface LooseChunk {
  readonly choices: readonly {
    readonly delta: Record<string, unknown>;
    readonly finish_reason: string | null;
  }[];
  readonly [key: string]: unknown;
}

/** Parse một dòng SSE thành chunk, assert prefix `data: ` ngay tại đây. */
function parseChunkEvent(event: string): LooseChunk {
  expect(event.startsWith('data: ')).toBe(true);
  return JSON.parse(event.slice('data: '.length)) as LooseChunk;
}

describe('chat completion response contract (OpenAI chat.completion)', () => {
  it('pins the exact top-level key set', () => {
    const response = buildChatCompletion('mock-chat-model', 'Hello.');
    expect(Object.keys(response).toSorted()).toEqual([
      'choices',
      'created',
      'id',
      'model',
      'object',
      'usage',
    ]);
  });

  it('pins object type, id prefix and echoed model', () => {
    const response = buildChatCompletion('mock-chat-model', 'Hello.');
    expect(response.object).toBe('chat.completion');
    expect(response.id).toMatch(/^chatcmpl-mock-/u);
    expect(response.model).toBe('mock-chat-model');
    expect(response.created).toEqual(expect.any(Number));
  });

  it('pins the exact choice key set with assistant message and stop finish reason', () => {
    const response = buildChatCompletion('mock-chat-model', 'Hello.');
    expect(response.choices).toHaveLength(1);
    const choice = at(response.choices, 0);
    expect(Object.keys(choice).toSorted()).toEqual(['finish_reason', 'index', 'message']);
    expect(choice.index).toBe(0);
    expect(choice.finish_reason).toBe('stop');
    expect(Object.keys(choice.message).toSorted()).toEqual(['content', 'role']);
    expect(choice.message.role).toBe('assistant');
    expect(choice.message.content).toBe('Hello.');
  });

  it('pins the exact usage key set with a consistent token total', () => {
    const response = buildChatCompletion('mock-chat-model', 'Hello.');
    expect(Object.keys(response.usage).toSorted()).toEqual([
      'completion_tokens',
      'prompt_tokens',
      'total_tokens',
    ]);
    // Consumer (llm-api usage normalization) đọc `prompt_tokens`/`completion_tokens`
    // — tổng phải khớp để test settlement không tính nhầm số liệu giả.
    expect(response.usage.total_tokens).toBe(
      response.usage.prompt_tokens + response.usage.completion_tokens,
    );
    expect(response.usage.prompt_tokens).toBeGreaterThan(0);
    expect(response.usage.completion_tokens).toBeGreaterThan(0);
  });

  it('is deterministic for the same content', () => {
    expect(buildChatCompletion('m', 'abc').usage).toEqual(buildChatCompletion('m', 'abc').usage);
  });
});

describe('SSE stream contract (minimal, distinguishable — full fidelity is a non-goal)', () => {
  it('emits role chunk, content chunk, stop chunk, then the [DONE] sentinel', () => {
    const body = buildSseEvents('chatcmpl-mock-000001', 1_700_000_000, 'mock-chat-model', 'Hi.');
    const events = body.split('\n\n').filter((line) => line.length > 0);
    expect(events).toHaveLength(4);
    expect(at(events, 3)).toBe('data: [DONE]');

    const chunks = [0, 1, 2].map((index) => parseChunkEvent(at(events, index)));
    expect(chunks.map((chunk) => chunk['object'])).toEqual([
      'chat.completion.chunk',
      'chat.completion.chunk',
      'chat.completion.chunk',
    ]);
    expect(Object.keys(at(chunks, 0)).toSorted()).toEqual([
      'choices',
      'created',
      'id',
      'model',
      'object',
    ]);
    expect(at(at(chunks, 0).choices, 0).delta).toEqual({ role: 'assistant', content: '' });
    expect(at(at(chunks, 0).choices, 0).finish_reason).toBeNull();
    expect(at(at(chunks, 1).choices, 0).delta).toEqual({ content: 'Hi.' });
    expect(at(at(chunks, 1).choices, 0).finish_reason).toBeNull();
    expect(at(at(chunks, 2).choices, 0).delta).toEqual({});
    expect(at(at(chunks, 2).choices, 0).finish_reason).toBe('stop');
  });

  it('shares id and model across every chunk so clients can correlate the stream', () => {
    const body = buildSseEvents('chatcmpl-mock-000002', 1_700_000_000, 'mock-chat-model', 'Hi.');
    const ids = [...body.matchAll(/"id":"([^"]+)"/gu)].map((match) => match[1] ?? '');
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(1);
    expect(body).toContain('"model":"mock-chat-model"');
  });
});

describe('model list contract (OpenAI list shape)', () => {
  it('pins the exact list and model key sets in config order', () => {
    const list = buildModelList(['mock-a', 'mock-b']);
    expect(Object.keys(list).toSorted()).toEqual(['data', 'object']);
    expect(list.object).toBe('list');
    expect(list.data.map((model) => model.id)).toEqual(['mock-a', 'mock-b']);
    for (const model of list.data) {
      expect(Object.keys(model).toSorted()).toEqual(['created', 'id', 'object', 'owned_by']);
      expect(model.object).toBe('model');
    }
  });
});

describe('error envelope contract (OpenAI error shape)', () => {
  it('pins the exact envelope key set for every injected failure', () => {
    for (const envelope of [
      buildErrorEnvelope('msg', 'invalid_request_error', 'invalid_api_key'),
      buildErrorEnvelope('msg', 'rate_limit_error', 'rate_limit_exceeded'),
      buildErrorEnvelope('msg', 'api_error', null),
    ]) {
      expect(Object.keys(envelope).toSorted()).toEqual(['error']);
      expect(Object.keys(envelope.error).toSorted()).toEqual(['code', 'message', 'param', 'type']);
      expect(envelope.error.param).toBeNull();
    }
  });

  it('keeps the deliberate malformed body away from any OpenAI shape', () => {
    // Body malformed phải JSON hợp lệ nhưng THIẾU các field bắt buộc của shape
    // — đây là input cho nhánh `usage_status = malformed` của consumer.
    expect(Object.keys(MALFORMED_BODY).toSorted()).toEqual(['detail']);
    expect(JSON.stringify(MALFORMED_BODY)).not.toContain('choices');
    expect(JSON.stringify(MALFORMED_BODY)).not.toContain('usage');
  });
});
