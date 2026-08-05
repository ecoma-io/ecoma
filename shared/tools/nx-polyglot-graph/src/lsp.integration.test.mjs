import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { encodeMessage, frameMessages } from "../lsp.mjs";

const SERVER = fileURLToPath(new URL("../lsp.mjs", import.meta.url));

/**
 * Drives the real server over stdio with real base-protocol framing, and
 * resolves with every response plus the process exit code. Reaching it as a
 * subprocess is the point: a handler called in-process would never prove that
 * the framing, the stream wiring, and the exit contract hold together.
 */
function session(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
    let buffer = Buffer.alloc(0);
    const responses = [];
    child.stdout.on("data", (chunk) => {
      const framed = frameMessages(Buffer.concat([buffer, chunk]));
      buffer = framed.rest;
      responses.push(...framed.messages);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ responses, code }));
    for (const request of requests) child.stdin.write(encodeMessage(request));
  });
}

describe("nx-polyglot-graph language server", () => {
  it("completes the lifecycle and promises no capability it cannot answer", async () => {
    const { responses, code } = await session([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "shutdown" },
      { jsonrpc: "2.0", method: "exit" },
    ]);

    expect(code).toBe(0);
    expect(responses).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { capabilities: {}, serverInfo: { name: "nx-polyglot-graph" } },
      },
      { jsonrpc: "2.0", id: 2, result: null },
    ]);
  });

  // An empty capability set is what keeps an editor from asking for
  // diagnostics. Answering `textDocument/didOpen` with an empty diagnostic
  // array instead would paint every file green while no rule had run — the
  // failure that is worse than the server being visibly absent.
  it("refuses a request it cannot serve instead of answering it emptily", async () => {
    const { responses } = await session([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 7, method: "textDocument/diagnostic", params: {} },
      { jsonrpc: "2.0", id: 8, method: "shutdown" },
      { jsonrpc: "2.0", method: "exit" },
    ]);

    const refusal = responses.find((r) => r.id === 7);
    expect(refusal.error.code).toBe(-32601);
    expect(refusal.error.message).toContain("'textDocument/diagnostic' is not implemented");
    expect(refusal.result).toBeUndefined();
  });

  it("answers no notification, and reports an exit without shutdown as a failure", async () => {
    const { responses, code } = await session([
      { jsonrpc: "2.0", method: "initialized", params: {} },
      { jsonrpc: "2.0", method: "exit" },
    ]);

    expect(responses).toEqual([]);
    expect(code).toBe(1);
  });
});
