import { describe, expect, it, vi } from "vitest";

import {
  callModel,
  collectTrajectories,
  collectVerdicts,
  FREE_MODEL_POOL,
  validateContent,
  ZEN_BASE_URL,
} from "./zen.mjs";

const completion = (content, finish = "stop") => ({
  ok: true,
  json: async () => ({ choices: [{ finish_reason: finish, message: { content } }] }),
});

describe("callModel", () => {
  it("posts a json_object-mode completion and returns the content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('{"a":1}'));
    const res = await callModel("m1", "the prompt", { fetchImpl });

    expect(res).toEqual({ ok: true, content: '{"a":1}' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ZEN_BASE_URL}/chat/completions`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe("m1");
    expect(body.messages).toEqual([{ role: "user", content: "the prompt" }]);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("passes a messages array through verbatim for multi-turn dialogues", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('{"a":1}'));
    const messages = [
      { role: "user", content: "opening" },
      { role: "assistant", content: '{"action":"read","paths":["x"]}' },
      { role: "user", content: "FILE x: ..." },
    ];
    await callModel("m1", messages, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).messages).toEqual(messages);
  });

  it("reports provider errors that arrive as 200 + error body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: { code: "provider_rate_limit_exceeded" } }),
    });
    const res = await callModel("m1", "p", { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("provider_rate_limit_exceeded");
  });

  it("reports HTTP failures, network throws, and unparseable bodies", async () => {
    expect(
      await callModel("m", "p", { fetchImpl: async () => ({ ok: false, status: 403 }) }),
    ).toEqual({ ok: false, error: "http 403" });
    const thrown = await callModel("m", "p", {
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(thrown.ok).toBe(false);
    expect(thrown.error).toContain("socket hang up");
    const garbled = await callModel("m", "p", {
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new Error("bad json");
        },
      }),
    });
    expect(garbled).toEqual({ ok: false, error: "non-json response body" });
  });

  it("bounds every call with an abort signal so a hung provider rotates instead of stalling", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('{"a":1}'));
    await callModel("m1", "p", { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    const timedOut = await callModel("m1", "p", {
      fetchImpl: async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toContain("timeout");
  });

  it("treats empty content (reasoning budget exhausted) as a failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion("", "length"));
    const res = await callModel("m1", "p", { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("length");
  });
});

describe("collectVerdicts", () => {
  const validate = (raw) => (raw.v === "ok" ? raw : null);

  it("returns the primaries' verdicts without consulting fallbacks", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('{"v":"ok"}'));
    const { verdicts, failures } = await collectVerdicts("p", validate, {
      models: ["a", "b", "c", "backup"],
      fetchImpl,
    });
    expect(verdicts.map((v) => v.model)).toEqual(["a", "b", "c"]);
    expect(failures).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fills a failed primary slot from the fallback list, one at a time", async () => {
    const byModel = {
      a: completion('{"v":"ok"}'),
      b: { ok: true, json: async () => ({ error: { code: "rate_limit" } }) },
      c: completion("not json at all"),
      d: completion('{"v":"nope"}'),
      e: completion('{"v":"ok"}'),
    };
    const fetchImpl = vi.fn(async (_url, init) => byModel[JSON.parse(init.body).model]);
    const { verdicts, failures } = await collectVerdicts("p", validate, {
      models: ["a", "b", "c", "d", "e"],
      fetchImpl,
    });

    expect(verdicts.map((v) => v.model)).toEqual(["a", "e"]);
    expect(failures.map((f) => f.model)).toEqual(["b", "c", "d"]);
    expect(failures[1].error).toBe("content is not valid JSON");
    expect(failures[2].error).toBe("JSON does not match the verdict schema");
  });

  it("returns whatever it got when the whole pool fails — quorum is the caller's call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const { verdicts, failures } = await collectVerdicts("p", validate, {
      models: ["a", "b"],
      need: 2,
      fetchImpl,
    });
    expect(verdicts).toEqual([]);
    expect(failures).toHaveLength(2);
  });

  it("ships a real pool whose tail is the least reliable model", () => {
    expect(FREE_MODEL_POOL.length).toBeGreaterThanOrEqual(4);
    expect(FREE_MODEL_POOL.at(-1)).toBe("laguna-s-2.1-free");
    expect(new Set(FREE_MODEL_POOL).size).toBe(FREE_MODEL_POOL.length);
  });
});

describe("collectTrajectories", () => {
  it("runs the primaries' trajectories without consulting fallbacks", async () => {
    const runTrajectory = vi.fn(async (model) => ({ ok: true, verdict: `v-${model}` }));
    const { verdicts, failures } = await collectTrajectories(runTrajectory, {
      models: ["a", "b", "c", "backup"],
    });
    expect(verdicts.map((v) => v.model)).toEqual(["a", "b", "c"]);
    expect(verdicts[0].verdict).toBe("v-a");
    expect(failures).toEqual([]);
    expect(runTrajectory).toHaveBeenCalledTimes(3);
  });

  it("fills a failed trajectory slot from the fallback list, one at a time", async () => {
    const outcomes = {
      a: { ok: true, verdict: "va" },
      b: { ok: false, error: "provider: rate_limit" },
      c: { ok: false, error: "no verdict within the turn budget" },
      d: { ok: false, error: "http 500" },
      e: { ok: true, verdict: "ve" },
    };
    const runTrajectory = vi.fn(async (model) => outcomes[model]);
    const { verdicts, failures } = await collectTrajectories(runTrajectory, {
      models: ["a", "b", "c", "d", "e"],
    });
    expect(verdicts.map((v) => v.model)).toEqual(["a", "e"]);
    expect(failures.map((f) => f.model)).toEqual(["b", "c", "d"]);
  });
});

describe("validateContent", () => {
  const validate = (raw) => (raw.v === "ok" ? raw : null);

  it("gates a completion through JSON parse then the caller's schema", () => {
    expect(validateContent('{"v":"ok"}', validate)).toEqual({ ok: true, verdict: { v: "ok" } });
    expect(validateContent("not json", validate)).toEqual({
      ok: false,
      error: "content is not valid JSON",
    });
    expect(validateContent('{"v":"nope"}', validate)).toEqual({
      ok: false,
      error: "JSON does not match the verdict schema",
    });
  });
});
