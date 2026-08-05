#!/usr/bin/env node
/**
 * Language-server entry — a lifecycle shell and nothing more.
 *
 * It speaks exactly three messages of the Language Server Protocol:
 * `initialize`, `shutdown`, and the `exit` notification. Every other request
 * gets the standard `MethodNotFound` (-32601) error. That is the honest shape
 * of a server with no diagnostics behind it: an editor learns the server is
 * alive, reads a capability set that promises nothing, and asks for nothing.
 *
 * The alternative — advertising `textDocumentSync` and answering every
 * `textDocument/didOpen` with an empty diagnostic array — would paint every
 * file in the editor green while no rule had run. A boundary tool that shows
 * "no problems" without looking is worse than one that is visibly absent, so
 * the capability set stays empty until a rule can fill it.
 *
 * Framing is the LSP base protocol: `Content-Length: <n>\r\n\r\n<utf8 json>`.
 * Implemented here rather than pulled from a dependency because it is a fixed
 * external contract of about thirty lines, and because this tool stays on Node
 * built-ins so extracting it later costs nothing (root CLAUDE.md, Rule 2).
 */
import { pathToFileURL } from "node:url";

/** JSON-RPC error codes this server can return, from the LSP specification. */
const METHOD_NOT_FOUND = -32601;

/**
 * The capability set: empty, on purpose. A capability advertised here is a
 * promise the server answers that request, and it cannot answer any of them
 * yet. Filling this in is what a rule engine landing looks like.
 */
export const SERVER_CAPABILITIES = Object.freeze({});

/**
 * The response to one incoming message, or `null` when none is owed — a
 * notification (no `id`) is never answered, per the JSON-RPC base protocol.
 *
 * @param {object} message A parsed JSON-RPC message.
 * @returns {object|null}
 */
export function handleMessage(message) {
  const { id, method } = message ?? {};
  const isRequest = id !== undefined && id !== null;

  if (method === "initialize" && isRequest) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        capabilities: SERVER_CAPABILITIES,
        serverInfo: { name: "nx-polyglot-graph" },
      },
    };
  }
  if (method === "shutdown" && isRequest) {
    return { jsonrpc: "2.0", id, result: null };
  }
  if (!isRequest) return null; // a notification, including `exit`

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: METHOD_NOT_FOUND,
      message:
        `nx-polyglot-graph: '${method}' is not implemented. This server handles initialize ` +
        `and shutdown only — it publishes no diagnostics, because no boundary rule exists ` +
        `yet and an empty diagnostic list would read as a clean file.`,
    },
  };
}

/**
 * Splits a byte stream into LSP messages. Returns the messages it could frame
 * plus whatever tail is not yet a whole message, which the caller feeds back
 * in with the next chunk.
 *
 * `Content-Length` counts BYTES, not characters, so the buffer is sliced
 * before it is decoded — measuring a decoded string would mis-split any
 * message containing a non-ASCII path.
 *
 * @param {Buffer} buffer
 * @returns {{ messages: object[], rest: Buffer }}
 */
export function frameMessages(buffer) {
  const messages = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const headers = rest.subarray(0, headerEnd).toString("ascii");
    const length = Number(/content-length:\s*(\d+)/i.exec(headers)?.[1]);
    if (!Number.isInteger(length)) {
      // A frame with no usable Content-Length cannot be skipped safely — the
      // stream position of the next one is unknowable. Drop the header and
      // resynchronise on the next boundary rather than guess a length.
      rest = rest.subarray(headerEnd + 4);
      continue;
    }
    const bodyStart = headerEnd + 4;
    if (rest.length < bodyStart + length) break; // body still arriving
    const body = rest.subarray(bodyStart, bodyStart + length).toString("utf8");
    rest = rest.subarray(bodyStart + length);
    try {
      messages.push(JSON.parse(body));
    } catch {
      // Unparsable body, correctly framed: the stream stays in sync, so the
      // session continues. Nothing is owed in reply — the id is unknown.
    }
  }
  return { messages, rest };
}

/** Encodes a response with its base-protocol header. */
export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Wires the handler to stdio and blocks until the client sends `exit`. */
function serve(input = process.stdin, output = process.stdout) {
  let pending = Buffer.alloc(0);
  let shutdownRequested = false;

  input.on("data", (chunk) => {
    const { messages, rest } = frameMessages(Buffer.concat([pending, chunk]));
    pending = rest;
    for (const message of messages) {
      if (message?.method === "shutdown") shutdownRequested = true;
      if (message?.method === "exit") {
        // The specification is explicit: exit after a shutdown request is a
        // success, exit without one is an error. Reporting both as 0 would
        // hide a client that killed the session mid-conversation.
        process.exit(shutdownRequested ? 0 : 1);
      }
      const response = handleMessage(message);
      if (response) output.write(encodeMessage(response));
    }
  });
  input.on("end", () => process.exit(shutdownRequested ? 0 : 1));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  serve();
}
