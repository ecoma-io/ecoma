/**
 * The language server itself: lifecycle, document store, and the one place
 * diagnostics are allowed to leave the process.
 *
 * Transport-free on purpose. It is handed a `send` and an `exit` and never
 * touches a stream, so the whole protocol conversation can be driven in a test
 * without a subprocess — while `../../lsp.mjs`, which owns the stdio wiring,
 * stays small enough to read in one screen.
 *
 * ## Why a language server and not an ESLint plugin
 *
 * An ESLint plugin reaches what ESLint can parse, and in this workspace that is
 * JS, TS and `.vue` — the root `eslint.config.mjs` hands the last one
 * `vue-eslint-parser` and states the boundary rule in a block with no `files`
 * filter, so `@nx/enforce-module-boundaries` judges a single-file component
 * too. Measured: both engines report the same crossing for the same `.vue`
 * import, differing only in the column they point at.
 *
 * Go, Rust and Python have no ESLint parser at all — `eslint` answers "File
 * ignored because no matching configuration was supplied" and the project's
 * `lint` target exits 0 over a violating import (project CLAUDE.md). So this
 * server is the ONLY enforcement those three have, and for JS, TS and Vue it
 * is a second opinion that `../conformance/` holds to the same verdict. One
 * protocol every editor speaks serves all of them at once.
 *
 * ## The rule that governs every path through this file
 *
 * A published empty diagnostic list is a statement: "this file is clean". It is
 * made in exactly two places, and both are named — `publishDiagnostics` after
 * `diagnoseDocument` reported `analyzed: true`, and `clearDiagnostics` when a
 * document closes and its markers must go. Nothing else may publish an empty
 * list, and `publishDiagnostics` re-checks the invariant rather than trusting
 * the caller of `diagnoseDocument` to have honoured it.
 */
import { isAbsolute, posix, relative, sep } from "node:path";

import { MODULE_BOUNDARIES_CONFIG_FILE } from "../config.mjs";

import { readBoundaryConfig } from "./boundary-config.mjs";
import { analysisFailedDiagnostic, documentLines } from "./diagnostics.mjs";
import { diagnoseDocument } from "./diagnose.mjs";
import { ERROR_CODES, SERVER_INFO, TEXT_DOCUMENT_SYNC_KIND, uriToPath } from "./protocol.mjs";
import { buildWorkspaceIndex, PROJECT_CONFIG_FILE } from "./workspace-index.mjs";

/**
 * The files whose content changes the verdict for files that did not change.
 * Both are read straight from the modules that own them, so a rename there
 * cannot leave a watcher pointed at a filename that no longer exists.
 */
export const WATCHED_FILES = Object.freeze([MODULE_BOUNDARIES_CONFIG_FILE, PROJECT_CONFIG_FILE]);

/** The glob patterns those files are watched under, for dynamic registration. */
const WATCHER_GLOBS = WATCHED_FILES.map((file) => `**/${file}`);

/**
 * What `initialize` promises. Every entry is something the server answers.
 *
 * `change` is `full`: the client re-sends the whole document and the server
 * re-analyzes it. Incremental sync is not advertised because it is not
 * implemented, and a server that advertised it and then mis-applied one ranged
 * edit would put every later diagnostic on the wrong line — see
 * `./protocol.mjs`.
 *
 * `save.includeText` is `false`: the server already holds the buffer the editor
 * is showing, and re-reading the saved bytes would answer about a different
 * text than the one on screen.
 */
export const SERVER_CAPABILITIES = Object.freeze({
  textDocumentSync: Object.freeze({
    openClose: true,
    change: TEXT_DOCUMENT_SYNC_KIND.full,
    save: Object.freeze({ includeText: false }),
  }),
});

/** POSIX-relative path of `absolutePath` inside `root`, or `null` when outside. */
function workspaceRelative(root, absolutePath) {
  const rel = relative(root, absolutePath).split(sep).join(posix.sep);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Creates a server instance.
 *
 * @param {object} options
 * @param {(message: object) => void} options.send Writes one JSON-RPC message
 *   to the client.
 * @param {(code: number) => void} options.exit Ends the process. Injected so a
 *   test can observe the exit code instead of losing its own runner to it.
 * @param {(text: string) => void} [options.log] Diagnostics about the server
 *   itself. Never stdout: stdout carries the protocol, and one stray line there
 *   desynchronises the stream for the rest of the session.
 * @param {(options: object) => object} [options.buildIndex] Injected for tests.
 * @param {(root: string, revision: number) => Promise<object>} [options.readConfig] Injected for tests.
 * @returns {{handle: (message: object) => Promise<void>}}
 */
export function createServer({
  send,
  exit,
  log = () => {},
  buildIndex = buildWorkspaceIndex,
  readConfig = readBoundaryConfig,
}) {
  /** `starting` → `running` → `shuttingDown`. `exit` ends it from any of them. */
  let phase = "starting";
  let root = null;
  let shutdownRequested = false;
  /** Bumped whenever something the verdict depends on changed on disk. */
  let revision = 0;
  /** `{revision, promise}`; the promise always RESOLVES, to an ok/error record. */
  let resources = null;
  /** Outgoing request ids, kept apart from the client's id space. */
  let outgoingId = 0;
  /** Whether the client can be asked to watch files, learned at `initialize`. */
  let clientSupportsFileWatching = false;
  const documents = new Map();

  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  /**
   * The index and config for the current revision, as an ok/error record rather
   * than a rejected promise: a rejection cached across every open document
   * would surface as an unhandled rejection long after the message that caused
   * it, and the reason would be published to the developer anyway.
   */
  function currentResources() {
    if (resources?.revision === revision) return resources.promise;
    const at = revision;
    const promise = (async () => {
      const [index, config] = await Promise.all([
        Promise.resolve().then(() => buildIndex({ root })),
        readConfig(root, at),
      ]);
      return { ok: true, index, config };
    })().catch((cause) => ({ ok: false, reason: cause?.message ?? String(cause) }));
    resources = { revision: at, promise };
    return promise;
  }

  /**
   * Publishes the verdict for one open document.
   *
   * The invariant check below is not defensive programming for its own sake. It
   * is the second of the two guards described in this file's header: if any
   * future edit to `diagnoseDocument` ever returns `analyzed: false` with
   * nothing to show, this turns that bug into a visible diagnostic instead of
   * into a file the editor paints clean.
   */
  async function publishDiagnostics(uri) {
    const document = documents.get(uri);
    if (!document) return;
    const lines = documentLines(document.text);

    const outcome = await diagnoseFor(document, lines);
    let diagnostics = outcome.diagnostics;
    if (!outcome.analyzed && diagnostics.length === 0) {
      diagnostics = [
        analysisFailedDiagnostic(
          "the analysis reported that it did not complete, but produced nothing to show. " +
            "Publishing this rather than an empty list, which would read as a clean file",
          lines,
        ),
      ];
    }
    notify("textDocument/publishDiagnostics", { uri, diagnostics, version: document.version });
  }

  /** The diagnosis for one document, with every failure turned into something to show. */
  async function diagnoseFor(document, lines) {
    if (document.unavailable !== null) {
      return {
        analyzed: false,
        diagnostics: [analysisFailedDiagnostic(document.unavailable, lines)],
      };
    }
    const loaded = await currentResources();
    if (!loaded.ok) {
      return { analyzed: false, diagnostics: [analysisFailedDiagnostic(loaded.reason, lines)] };
    }
    return diagnoseDocument({
      sourceFile: document.sourceFile,
      text: document.text,
      index: loaded.index,
      config: loaded.config,
    });
  }

  /**
   * Removes the markers for a document that is no longer open.
   *
   * The one deliberate empty publish. It is a different statement from "this
   * file is clean" — it says "I no longer speak for this file" — and it is
   * spelled as its own function so it can never be reached by falling through
   * the diagnosis path.
   */
  function clearDiagnostics(uri) {
    notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
  }

  /**
   * Drops the cached index and config and re-diagnoses every open document.
   *
   * Reached whenever the constraint table or the project list moved: every open
   * file's verdict was computed against a tree that no longer exists, and
   * leaving those markers up shows a verdict from a config that has been
   * deleted — which is the same lie as showing no marker at all, told the other
   * way round.
   */
  async function invalidateAndRepublish() {
    revision += 1;
    resources = null;
    log(`nx-polyglot-graph: ${WATCHED_FILES.join("/")} changed; re-diagnosing open documents`);
    for (const uri of documents.keys()) await publishDiagnostics(uri);
  }

  /**
   * Records an open document, and — where it cannot be judged at all — WHY.
   *
   * `unavailable` is a sentence rather than a flag because it is published
   * verbatim. A URI naming no file on disk and a file outside the workspace are
   * different mistakes with different fixes, and telling a developer only that
   * "something is wrong" costs them the diagnosis this server just made.
   */
  function openDocument({ uri, text, version }) {
    const path = uriToPath(uri);
    const sourceFile = path === null ? null : workspaceRelative(root, path);
    documents.set(uri, {
      uri,
      text: typeof text === "string" ? text : "",
      version: version ?? null,
      sourceFile,
      unavailable:
        path === null
          ? `'${uri}' names no file on disk — an untitled buffer or a virtual document — ` +
            `so no project owns it and no boundary rule can be applied to it`
          : sourceFile === null
            ? `this file is outside the workspace root the server was initialized with (${root}), ` +
              `so no project owns it and no constraint applies to it`
            : null,
    });
  }

  async function handleInitialize(id, params) {
    if (phase !== "starting") {
      return fail(id, ERROR_CODES.invalidRequest, "nx-polyglot-graph: already initialized");
    }
    // Precedence is the protocol's own, newest field first, with an explicit
    // override ahead of all of them: an editor rooted at a subdirectory of the
    // workspace would otherwise find no `module-boundaries.config.mjs` and no
    // projects, and report every file clean for the best of reasons.
    const optionRoot = params?.initializationOptions?.workspaceRoot;
    root =
      (typeof optionRoot === "string" && optionRoot !== "" ? optionRoot : null) ??
      uriToPath(params?.workspaceFolders?.[0]?.uri) ??
      uriToPath(params?.rootUri) ??
      (typeof params?.rootPath === "string" ? params.rootPath : null) ??
      process.cwd();
    phase = "running";
    clientSupportsFileWatching =
      params?.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    log(`nx-polyglot-graph: language server initialized for ${root}`);
    reply(id, { capabilities: SERVER_CAPABILITIES, serverInfo: SERVER_INFO });
  }

  /**
   * Asks the client to watch the two files a verdict depends on.
   *
   * Only sent when the client said it supports dynamic registration, because
   * that is the only way to ask: a client that watches nothing simply never
   * sends `workspace/didChangeWatchedFiles`, and the server keeps answering
   * from the config it read at startup until a document is saved. That is a
   * real limitation of such a client, not a fallback this server can implement.
   */
  function registerFileWatchers() {
    if (!clientSupportsFileWatching) {
      log(
        "nx-polyglot-graph: the client does not support dynamic file watching, so a change to " +
          `${WATCHED_FILES.join(" or ")} will not re-diagnose open files on its own`,
      );
      return;
    }
    send({
      jsonrpc: "2.0",
      id: `nx-polyglot-graph/${++outgoingId}`,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: "nx-polyglot-graph/watched-files",
            method: "workspace/didChangeWatchedFiles",
            registerOptions: {
              watchers: WATCHER_GLOBS.map((globPattern) => ({ globPattern })),
            },
          },
        ],
      },
    });
  }

  /** Did any of these changes touch a file the verdict depends on? */
  function touchesWatchedFile(changes) {
    return (changes ?? []).some((change) => {
      const path = uriToPath(change?.uri);
      if (path === null) return false;
      const name = path.split(/[\\/]/).pop();
      return WATCHED_FILES.includes(name);
    });
  }

  async function dispatch(message) {
    const { id, method, params } = message ?? {};
    const isRequest = id !== undefined && id !== null;

    // A response to one of this server's own requests — `client/registerCapability`
    // is the only one it sends. Nothing is owed, and answering it would put a
    // reply to a reply on the wire.
    if (method === undefined && isRequest) return;

    if (method === "exit") {
      exit(shutdownRequested ? 0 : 1);
      return;
    }

    if (phase === "shuttingDown") {
      // The specification is explicit: after `shutdown`, a request errors and a
      // notification is ignored. Answering normally would let a client keep
      // using a server that has already released its state.
      if (isRequest) {
        fail(
          id,
          ERROR_CODES.invalidRequest,
          `nx-polyglot-graph: '${method}' arrived after shutdown; the server is no longer serving requests`,
        );
      }
      return;
    }

    if (method === "initialize") {
      if (isRequest) await handleInitialize(id, params);
      return;
    }

    if (phase === "starting") {
      if (isRequest) {
        fail(
          id,
          ERROR_CODES.serverNotInitialized,
          `nx-polyglot-graph: '${method}' arrived before 'initialize'`,
        );
      }
      return;
    }

    switch (method) {
      case "initialized":
        registerFileWatchers();
        return;

      case "shutdown":
        phase = "shuttingDown";
        shutdownRequested = true;
        documents.clear();
        resources = null;
        if (isRequest) reply(id, null);
        return;

      case "textDocument/didOpen": {
        const doc = params?.textDocument;
        openDocument({ uri: doc?.uri, text: doc?.text, version: doc?.version });
        await publishDiagnostics(doc?.uri);
        return;
      }

      case "textDocument/didChange": {
        const uri = params?.textDocument?.uri;
        const document = documents.get(uri);
        if (!document) return;
        const changes = params?.contentChanges ?? [];
        // Full sync is what this server advertised, so the last change with no
        // `range` is the whole document. A ranged change means the client
        // ignored the advertised sync kind; the stored text would then be a
        // fiction and every position computed from it would be wrong, so the
        // document is marked unanalyzable rather than analyzed from a text the
        // server only thinks it has.
        const full = [...changes].reverse().find((change) => change?.range === undefined);
        if (full === undefined) {
          document.unavailable =
            `this buffer arrived as an incremental change, but the server advertised full ` +
            `text synchronisation — its contents are unknown here, so every position this ` +
            `server could report about it would be a guess`;
          log(
            `nx-polyglot-graph: ${uri} arrived as an incremental change, but the server ` +
              `advertised full text synchronisation; its contents are now unknown`,
          );
        } else {
          document.text = typeof full.text === "string" ? full.text : "";
        }
        document.version = params?.textDocument?.version ?? document.version;
        await publishDiagnostics(uri);
        return;
      }

      case "textDocument/didSave":
        // Saving one of the two files a verdict depends on invalidates every
        // OTHER file's verdict too. A client that watches files reports the
        // same change through `didChangeWatchedFiles`, and re-diagnosing twice
        // costs one index build; a client that cannot watch gets the reload it
        // would otherwise never get, as long as the change was made in the
        // editor rather than beside it.
        if (touchesWatchedFile([{ uri: params?.textDocument?.uri }])) {
          await invalidateAndRepublish();
          return;
        }
        await publishDiagnostics(params?.textDocument?.uri);
        return;

      case "textDocument/didClose": {
        const uri = params?.textDocument?.uri;
        if (documents.delete(uri)) clearDiagnostics(uri);
        return;
      }

      case "workspace/didChangeWatchedFiles":
        if (!touchesWatchedFile(params?.changes)) return;
        await invalidateAndRepublish();
        return;

      default:
        if (isRequest) {
          fail(
            id,
            ERROR_CODES.methodNotFound,
            `nx-polyglot-graph: '${method}' is not implemented. This server publishes boundary ` +
              `diagnostics over ${Object.keys(SERVER_CAPABILITIES).join(", ")} and answers nothing else.`,
          );
        }
    }
  }

  // One message at a time, in arrival order. Diagnosing is asynchronous, and
  // two overlapping runs would race to publish for the same URI — the editor
  // would then show whichever finished last, which is not necessarily the one
  // computed from the newest text.
  let queue = Promise.resolve();

  return {
    handle(message) {
      queue = queue
        .then(() => dispatch(message))
        .catch((cause) => {
          log(`nx-polyglot-graph: ${cause?.stack ?? cause}`);
        });
      return queue;
    },
  };
}
