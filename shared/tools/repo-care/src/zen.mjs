/**
 * Client for the opencode zen OpenAI-compatible endpoint using only the
 * keyless `-free` models. Free models are weak individually and flaky
 * operationally (provider rate limits arrive as HTTP 200 + `error` body, some
 * models vanish without notice), so nothing here trusts a single call:
 * `collectVerdicts` gathers N independent, schema-validated answers and the
 * caller applies a quorum over them.
 *
 * `response_format: json_object` is the deliberate common denominator — every
 * model in the pool accepts it, whereas `json_schema` is rejected by
 * `deepseek-v4-flash-free`. It guarantees parseable JSON, not our schema, so
 * a `validate` function stays mandatory (validation is code's job, Rule 5).
 */

export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

/**
 * Ordered pool: the first `need` entries are the primaries (most reliable in
 * probing — 9/9 responses each); the rest are fallbacks consulted only when a
 * primary fails. `laguna-s-2.1-free` sits last: it rate-limits roughly half
 * its calls even when idle.
 */
export const FREE_MODEL_POOL = [
  "nemotron-3-ultra-free",
  "north-mini-code-free",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "big-pickle",
  "laguna-s-2.1-free",
];

/**
 * One chat completion against one model. `prompt` is either a plain string
 * (wrapped as a single user message) or a full `messages` array for
 * multi-turn dialogues. Never throws for provider trouble — returns
 * `{ ok: true, content }` or `{ ok: false, error }` so callers can rotate
 * models. `maxTokens` stays generous because reasoning models (deepseek)
 * burn budget in `reasoning_content` before emitting any content.
 */
export async function callModel(model, prompt, opts = {}) {
  const { fetchImpl = fetch, baseUrl = ZEN_BASE_URL, maxTokens = 3000, timeoutMs = 120000 } = opts;
  const messages = Array.isArray(prompt) ? prompt : [{ role: "user", content: prompt }];
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A hung provider must become a rotate-able failure, never a stalled
      // workflow run — the whole call is bounded, not just the connect.
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      }),
    });
  } catch (cause) {
    return { ok: false, error: `network: ${cause.message ?? cause}` };
  }
  if (!res.ok) return { ok: false, error: `http ${res.status}` };

  let payload;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, error: "non-json response body" };
  }
  // Provider failures (rate limit, provider down) arrive as 200 + error body.
  if (payload.error) {
    return { ok: false, error: `provider: ${payload.error.code ?? payload.error.message}` };
  }
  const choice = payload.choices?.[0];
  const content = choice?.message?.content ?? "";
  if (!content) {
    return { ok: false, error: `empty content (finish_reason: ${choice?.finish_reason})` };
  }
  return { ok: true, content };
}

/**
 * Pool rotation shared by every quorum caller: the first `need` models run
 * their trajectory in parallel, then fallbacks are consulted one at a time
 * for the slots that failed (a failed model is never retried — its provider
 * limit won't clear within one run). `runTrajectory(model)` owns everything
 * between "model chosen" and "verdict or failure" — a single completion for
 * classification, a multi-turn investigation for review — and resolves to
 * `{ ok: true, verdict }` or `{ ok: false, error }`.
 *
 * Returns `{ verdicts: [{ model, verdict }], failures: [{ model, error }] }`;
 * quorum policy over the verdicts is the caller's decision.
 */
export async function collectTrajectories(runTrajectory, opts = {}) {
  const { need = 3, models = FREE_MODEL_POOL } = opts;
  const verdicts = [];
  const failures = [];

  const attempt = async (model) => {
    const res = await runTrajectory(model);
    if (res.ok) verdicts.push({ model, verdict: res.verdict });
    else failures.push({ model, error: res.error });
  };

  const primaries = models.slice(0, need);
  const fallbacks = models.slice(need);
  await Promise.all(primaries.map(attempt));
  for (const model of fallbacks) {
    if (verdicts.length >= need) break;
    await attempt(model);
  }
  return { verdicts, failures };
}

/**
 * Parse-and-validate gate over one completion: JSON-parse the content, run
 * the caller's `validate` (schema stays code's job, Rule 5), normalize both
 * failure modes into rotate-able errors.
 */
export function validateContent(content, validate) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: "content is not valid JSON" };
  }
  const verdict = validate(parsed);
  if (!verdict) return { ok: false, error: "JSON does not match the verdict schema" };
  return { ok: true, verdict };
}

/**
 * Gather up to `need` validated single-completion verdicts from the pool.
 * `validate` receives the parsed JSON and returns a normalized verdict or
 * null. The one-call trajectory: ask once, validate, done.
 */
export async function collectVerdicts(prompt, validate, opts = {}) {
  const { need, models, ...callOpts } = opts;
  return collectTrajectories(
    async (model) => {
      const res = await callModel(model, prompt, callOpts);
      if (!res.ok) return res;
      return validateContent(res.content, validate);
    },
    { need, models },
  );
}
