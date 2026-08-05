#!/usr/bin/env node
/**
 * Command-line entry for the module-boundary enforcer.
 *
 * **No rule is implemented yet, and this file says so out loud.** `check`
 * exits non-zero with a message naming what is missing, because the failure
 * mode a boundary checker has to avoid above every other is exiting 0 while
 * checking nothing — that is precisely the state this tool exists to end
 * (`@nx/enforce-module-boundaries` already exits 0 over a Go file that
 * violates the layer axis). A stub that returned success would reproduce the
 * bug at a new address.
 *
 * `--help` is real: it prints the surface as it will be, marking what does not
 * work yet, so a reader can tell a missing feature from a wrong invocation.
 *
 * Exit codes are part of the contract — a script calling this needs to tell
 * "your tree is dirty" from "you typed it wrong":
 *   0  nothing to report
 *   1  boundary violations found (reserved; no rule can produce it yet)
 *   2  usage error — unknown command, missing argument
 *   3  not implemented — the command exists, its machinery does not
 *
 * Argument parsing stays hand-rolled while there is one command, matching
 * `dev-cli`'s entry point next door; reach for a framework when several
 * commands genuinely need one.
 */
import { pathToFileURL } from "node:url";

import { MODULE_BOUNDARIES_CONFIG_FILE } from "./src/config.mjs";

export const EXIT = Object.freeze({
  ok: 0,
  violations: 1,
  usage: 2,
  notImplemented: 3,
});

const USAGE = `nx-polyglot-graph — module-boundary enforcement across every language in the workspace

Usage:
  nx-polyglot-graph check [<path>...]   Check imports against the boundary rules
  nx-polyglot-graph --help              Show this message

The rules come from ${MODULE_BOUNDARIES_CONFIG_FILE} at the workspace root — the
same table ESLint reads, so both enforcers answer from one source.

Status: NO RULE IS IMPLEMENTED YET. 'check' exits ${EXIT.notImplemented} rather than
reporting a clean tree it never inspected. See src/analysis/contract.md for the
analysis contract the rules will be built on.

Exit codes: ${EXIT.ok} nothing to report · ${EXIT.violations} violations found · ${EXIT.usage} usage error · ${EXIT.notImplemented} not implemented`;

/**
 * Runs the CLI and returns its exit code. Takes its streams so a test can read
 * what it wrote instead of capturing a process.
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {{ out: (text: string) => void, err: (text: string) => void }} io
 * @returns {number} one of `EXIT`.
 */
export function runCli(argv, io) {
  const [command] = argv;

  if (command === "--help" || command === "-h") {
    io.out(USAGE);
    return EXIT.ok;
  }

  if (command === "check") {
    io.err(
      `nx-polyglot-graph: 'check' is not implemented — no boundary rule exists yet, so this ` +
        `command has nothing to check with. Exiting ${EXIT.notImplemented} rather than ${EXIT.ok}: ` +
        `a checker that reports success without inspecting anything is the defect this tool ` +
        `was written to fix.`,
    );
    return EXIT.notImplemented;
  }

  io.err(
    command === undefined
      ? "nx-polyglot-graph: no command given."
      : `nx-polyglot-graph: unknown command '${command}'.`,
  );
  io.err(USAGE);
  return EXIT.usage;
}

// Run only when invoked as a program, so importing this module for its exit
// codes or `runCli` does not execute a command as a side effect.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(
    runCli(process.argv.slice(2), {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
    }),
  );
}
