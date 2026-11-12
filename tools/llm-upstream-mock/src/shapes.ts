/**
 * Builder cho các response shape OpenAI-compatible mà mock upstream trả ra.
 *
 * Hợp đồng shape ghim ở `contract.spec.ts` — nguồn chân lý là tài liệu
 * `docs/applications/llm-api/README.md` (data plane OpenAI-compatible) và chuẩn
 * OpenAI Chat Completions. Full fidelity toàn bộ tiêu chuẩn OpenAI là non-goal
 * (Issue #132): chỉ dựng đúng những field consumer thực tế đọc — `llm-api`
 * normalize usage (`prompt_tokens`/`completion_tokens`) và đọc `choices`.
 */

/** ID completion tăng dần, prefix nhận diện được là mock. */
let completionCounter = 0;

/** Sinh `id` dạng `chatcmpl-mock-<n>` — test ghim prefix để phân biệt với upstream thật. */
export function nextCompletionId(): string {
  completionCounter += 1;
  return `chatcmpl-mock-${String(completionCounter).padStart(6, '0')}`;
}

/** Suy số token từ độ dài content — deterministic, đủ dùng cho usage normalization test. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Response `POST /v1/chat/completions` non-streaming (chuẩn OpenAI chat.completion). */
export interface ChatCompletionResponse {
  readonly id: string;
  readonly object: 'chat.completion';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly message: { readonly role: 'assistant'; readonly content: string };
    readonly finish_reason: 'stop';
  }[];
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

/** Một SSE chunk dạng `chat.completion.chunk` — minimal, đủ để client phân biệt stream. */
export interface ChatCompletionChunk {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly delta: { readonly role?: 'assistant'; readonly content?: string };
    readonly finish_reason: 'stop' | null;
  }[];
}

/** Response `GET /v1/models` (chuẩn OpenAI list). */
export interface ModelListResponse {
  readonly object: 'list';
  readonly data: readonly {
    readonly id: string;
    readonly object: 'model';
    readonly created: number;
    readonly owned_by: string;
  }[];
}

/** Phong bì lỗi chuẩn OpenAI — mọi status lỗi đi qua shape này. */
export interface ErrorEnvelope {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly param: string | null;
    readonly code: string | null;
  };
}

/** Body malformed cố ý — JSON hợp lệ nhưng VI PHẠM shape OpenAI (thiếu choices/object). */
export const MALFORMED_BODY = {
  detail: 'llm-upstream-mock served a deliberately malformed response body',
} as const;

/** Dựng response chat completion non-streaming. `promptTokens` truyền vào để test kiểm tổng. */
export function buildChatCompletion(model: string, content: string): ChatCompletionResponse {
  const completionTokens = estimateTokens(content);
  const promptTokens = estimateTokens(JSON.stringify(model));
  return {
    id: nextCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/** Ba SSE event minimal: chunk role đầu, chunk content, chunk kết thúc — rồi sentinel `[DONE]`. */
export function buildSseEvents(
  id: string,
  created: number,
  model: string,
  content: string,
): string {
  const chunk = (
    delta: ChatCompletionChunk['choices'][number]['delta'],
    finish: 'stop' | null,
  ): string =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    } satisfies ChatCompletionChunk)}\n\n`;

  return (
    chunk({ role: 'assistant', content: '' }, null) +
    chunk({ content }, null) +
    chunk({}, 'stop') +
    'data: [DONE]\n\n'
  );
}

/** Dựng response model list từ danh sách id cấu hình — `owned_by` đánh dấu mock. */
export function buildModelList(
  models: readonly string[],
  ownedBy = 'ecoma-io-mock',
): ModelListResponse {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: models.map((id) => ({ id, object: 'model', created, owned_by: ownedBy })),
  };
}

/** Dựng phong bì lỗi OpenAI từ message/type/code. */
export function buildErrorEnvelope(
  message: string,
  type: string,
  code: string | null,
): ErrorEnvelope {
  return { error: { message, type, param: null, code } };
}
