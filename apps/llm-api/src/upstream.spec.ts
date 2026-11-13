/**
 * Unit test bảng quyết định dispatch (`upstream.ts`): classify outcome →
 * evidence/completion/usage (bảng của invariant 6 + F5), parse usage không bao
 * giờ ngầm 0, và shape body response/payload upstream. Hàm thuần — dispatch
 * thật (fetch) được integration suite với mock upstream phủ.
 */
import { describe, expect, it } from 'vitest';

import {
  buildChatCompletionResponseBody,
  buildUpstreamPayload,
  classifyUpstreamOutcome,
  evidenceCanTransition,
  type RawUpstreamOutcome,
} from './upstream';

/** Outcome raw helper — body 200 OpenAI hoàn chỉnh dùng chung. */
const OK_BODY = JSON.stringify({
  id: 'chatcmpl-upstream-1',
  object: 'chat.completion',
  created: 1_760_000_000,
  model: 'upstream/dronie-flash-raw',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
});

function raw(input: Partial<RawUpstreamOutcome>): RawUpstreamOutcome {
  return {
    failureKind: null,
    httpStatus: 200,
    bodyText: OK_BODY,
    retryAfterHeader: null,
    ...input,
  };
}

describe('classifyUpstreamOutcome', () => {
  it('classifies a timeout as may_have_executed (fail-safe, F5)', () => {
    const outcome = classifyUpstreamOutcome(
      raw({ failureKind: 'timeout', httpStatus: null, bodyText: null }),
    );
    expect(outcome.evidence).toBe('may_have_executed');
    expect(outcome.completion).toBeNull();
    expect(outcome.usage.status).toBe('missing');
  });

  it('classifies a network failure as may_have_executed', () => {
    const outcome = classifyUpstreamOutcome(
      raw({ failureKind: 'network', httpStatus: null, bodyText: null }),
    );
    expect(outcome.evidence).toBe('may_have_executed');
  });

  it('classifies 429 as confirmed_not_executed and forwards a valid Retry-After', () => {
    const outcome = classifyUpstreamOutcome(
      raw({ httpStatus: 429, bodyText: null, retryAfterHeader: '45' }),
    );
    expect(outcome.evidence).toBe('confirmed_not_executed');
    expect(outcome.retryAfterSeconds).toBe(45);
  });

  it('drops an out-of-range Retry-After from 429', () => {
    const outcome = classifyUpstreamOutcome(
      raw({ httpStatus: 429, bodyText: null, retryAfterHeader: '999999' }),
    );
    expect(outcome.evidence).toBe('confirmed_not_executed');
    expect(outcome.retryAfterSeconds).toBeNull();
  });

  it('classifies a well-formed 200 as confirmed_completed with completion and known usage', () => {
    const outcome = classifyUpstreamOutcome(raw({}));
    expect(outcome.evidence).toBe('confirmed_completed');
    expect(outcome.completion).not.toBeNull();
    expect(outcome.completion?.content).toBe('hi there');
    expect(outcome.completion?.finishReason).toBe('stop');
    expect(outcome.completion?.upstreamModel).toBe('upstream/dronie-flash-raw');
    expect(outcome.usage.status).toBe('known');
  });

  it('classifies a 200 with unparseable body as confirmed_completed but malformed usage', () => {
    const outcome = classifyUpstreamOutcome(raw({ bodyText: '<html>boom</html>' }));
    expect(outcome.evidence).toBe('confirmed_completed');
    expect(outcome.completion).toBeNull();
    expect(outcome.usage.status).toBe('malformed');
  });

  it('classifies a 200 without choices as completion-null but still confirmed_completed', () => {
    const outcome = classifyUpstreamOutcome(raw({ bodyText: '{"usage":{}}' }));
    expect(outcome.evidence).toBe('confirmed_completed');
    expect(outcome.completion).toBeNull();
    expect(outcome.usage.status).toBe('missing');
  });

  it('classifies a structured refusal envelope (400/401/403/404/422) as confirmed_not_executed', () => {
    const refusalBody = JSON.stringify({ error: { message: 'bad request', type: 'x' } });
    for (const status of [400, 401, 403, 404, 422]) {
      const outcome = classifyUpstreamOutcome(raw({ httpStatus: status, bodyText: refusalBody }));
      expect(outcome.evidence, `status ${status}`).toBe('confirmed_not_executed');
    }
  });

  it('treats a non-JSON refusal body as may_have_executed (nothing proven)', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const outcome = classifyUpstreamOutcome(raw({ httpStatus: status, bodyText: 'oops' }));
      expect(outcome.evidence, `status ${status}`).toBe('may_have_executed');
    }
  });

  it('treats 5xx as may_have_executed regardless of body shape', () => {
    for (const status of [500, 502, 503, 504]) {
      const outcome = classifyUpstreamOutcome(
        raw({ httpStatus: status, bodyText: '{"error":{}}' }),
      );
      expect(outcome.evidence, `status ${status}`).toBe('may_have_executed');
    }
  });

  it('treats a null status with no failure kind as may_have_executed', () => {
    const outcome = classifyUpstreamOutcome(raw({ httpStatus: null, bodyText: null }));
    expect(outcome.evidence).toBe('may_have_executed');
  });

  it('never reports not_sent after dispatch', () => {
    // classifyUpstreamOutcome chỉ chạy SAU dispatch — evidence type của nó
    // không chứa 'not_sent' ở mức type; test này ghim phía giá trị.
    const outcomes = [
      classifyUpstreamOutcome(raw({ failureKind: 'timeout', httpStatus: null, bodyText: null })),
      classifyUpstreamOutcome(raw({ httpStatus: 429, bodyText: null })),
      classifyUpstreamOutcome(raw({})),
      classifyUpstreamOutcome(raw({ httpStatus: 500, bodyText: null })),
    ];
    for (const outcome of outcomes) {
      expect(outcome.evidence).not.toBe('not_sent');
    }
  });
});

/** Status usage của một body 200 — module scope (consistent-function-scoping). */
function usageOf(bodyText: string): string {
  return classifyUpstreamOutcome(raw({ bodyText })).usage.status;
}

describe('usage resolution through classify (200 bodies)', () => {
  it('accepts prompt_tokens + completion_tokens as known', () => {
    expect(usageOf(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }))).toBe(
      'known',
    );
  });

  it('treats a missing or partial usage as missing, never silently zero', () => {
    // Invariant 6: thiếu một phía là usage không đủ để charge — không là 0.
    expect(usageOf('{}')).toBe('missing');
    expect(usageOf(JSON.stringify({ usage: {} }))).toBe('missing');
    expect(usageOf(JSON.stringify({ usage: { prompt_tokens: 3 } }))).toBe('missing');
    expect(usageOf(JSON.stringify({ usage: { completion_tokens: 3 } }))).toBe('missing');
  });

  it('treats negative, fractional or non-numeric counts as malformed', () => {
    expect(usageOf(JSON.stringify({ usage: { prompt_tokens: -1, completion_tokens: 2 } }))).toBe(
      'malformed',
    );
    expect(usageOf(JSON.stringify({ usage: { prompt_tokens: 1.5, completion_tokens: 2 } }))).toBe(
      'malformed',
    );
    expect(usageOf(JSON.stringify({ usage: { prompt_tokens: '3', completion_tokens: 2 } }))).toBe(
      'malformed',
    );
  });

  it('keeps detail counts optional (cached/reasoning absent is still known)', () => {
    const outcome = classifyUpstreamOutcome(
      raw({
        bodyText: JSON.stringify({
          usage: {
            prompt_tokens: 3,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 1 },
          },
        }),
      }),
    );
    expect(outcome.usage.status).toBe('known');
  });
});

describe('buildUpstreamPayload', () => {
  it('sends only model, messages and max_tokens', () => {
    const payload = buildUpstreamPayload({
      upstreamModel: 'upstream/dronie-flash-raw',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 32,
    });
    expect(JSON.parse(payload)).toEqual({
      model: 'upstream/dronie-flash-raw',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
    });
  });

  it('keeps the offer raw upstream model identity (invariant 9)', () => {
    const payload = buildUpstreamPayload({
      upstreamModel: 'org.internal/model-raw@v2',
      messages: [],
      maxTokens: 1,
    });
    expect((JSON.parse(payload) as { model: string }).model).toBe('org.internal/model-raw@v2');
  });
});

describe('buildChatCompletionResponseBody', () => {
  const COMPLETION = {
    content: 'hi there',
    finishReason: 'stop',
    upstreamModel: 'upstream/dronie-flash-raw',
  };

  it('renders the OpenAI chat.completion shape with known usage mirrored raw', () => {
    const usage = {
      status: 'known' as const,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cached_tokens: null,
        reasoning_tokens: null,
        request_count: null,
      },
      rawUsage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    };
    const body = JSON.parse(
      buildChatCompletionResponseBody({
        completionId: 'chatcmpl-req-1',
        createdSeconds: 1_760_000_000,
        model: 'dronie-flash',
        completion: COMPLETION,
        usage,
      }),
    ) as {
      id: string;
      object: string;
      created: number;
      model: string;
      choices: {
        index: number;
        message: { role: string; content: string };
        finish_reason: string;
      }[];
      usage: unknown;
    };
    expect(body.id).toBe('chatcmpl-req-1');
    expect(body.object).toBe('chat.completion');
    expect(body.created).toBe(1_760_000_000);
    // Model identity trả client là alias công khai, không phải model upstream raw.
    expect(body.model).toBe('dronie-flash');
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]?.index).toBe(0);
    expect(body.choices[0]?.message).toEqual({ role: 'assistant', content: 'hi there' });
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  });

  it('renders usage:null when usage is unknown instead of inventing zeros', () => {
    const body = JSON.parse(
      buildChatCompletionResponseBody({
        completionId: 'chatcmpl-req-2',
        createdSeconds: 1,
        model: 'dronie-flash',
        completion: COMPLETION,
        usage: { status: 'missing' },
      }),
    ) as { usage: unknown };
    expect(body.usage).toBeNull();
  });

  it('renders finish_reason:null and escapes content through JSON', () => {
    const body = JSON.parse(
      buildChatCompletionResponseBody({
        completionId: 'chatcmpl-req-3',
        createdSeconds: 1,
        model: 'm',
        completion: { content: 'line\n"quoted"', finishReason: null, upstreamModel: null },
        usage: { status: 'malformed' },
      }),
    ) as { choices: { message: { content: string }; finish_reason: string | null }[] };
    expect(body.choices[0]?.message.content).toBe('line\n"quoted"');
    expect(body.choices[0]?.finish_reason).toBeNull();
  });
});

describe('evidenceCanTransition', () => {
  it('allows evidence to strengthen only', () => {
    expect(evidenceCanTransition('not_sent', 'may_have_executed')).toBe(true);
    expect(evidenceCanTransition('not_sent', 'confirmed_not_executed')).toBe(true);
    expect(evidenceCanTransition('may_have_executed', 'confirmed_completed')).toBe(true);
    expect(evidenceCanTransition('confirmed_completed', 'may_have_executed')).toBe(false);
    expect(evidenceCanTransition('confirmed_completed', 'not_sent')).toBe(false);
  });
});
