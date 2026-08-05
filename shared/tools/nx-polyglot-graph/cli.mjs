#!/usr/bin/env node
/**
 * Command-line entry for the module-boundary enforcer — the surface that turns
 * a verdict into a failed build.
 *
 * `check` reads the Nx project graph, analyzes every tracked source file a
 * project owns, judges the import sites against the workspace's boundary law,
 * and exits 1 if anything violates it. That closes a measured hole: a
 * layer-violating import in a Go file left `nx run <project>:lint` at exit 0,
 * because that target runs ESLint and ESLint answers "File ignored because no
 * matching configuration was supplied" for a `.go` file — the tags were a
 * declaration with no mechanism behind them.
 *
 * The three layers below it stay unaware of this one, which is what lets an
 * editor reuse them: `src/analysis/` never decides which files to visit,
 * `src/rules/` never reads a file, and `src/report/` never decides whether
 * something is a violation. This file owns the two decisions nobody else may
 * make — which tree to judge, and what the exit code means.
 *
 * Exit codes are part of the contract; a script calling this has to tell "your
 * tree is dirty" from "you typed it wrong" from "the checker itself broke":
 *   0  no violations
 *   1  boundary violations found
 *   2  usage error — unknown command, missing argument, path outside the tree
 *   3  the run could not complete — no workspace, malformed config, `nx graph`
 *      or `git` failed. Distinct from 1 on purpose: a checker that could not
 *      look must never be mistaken for one that looked and found nothing.
 *
 * Argument parsing stays hand-rolled while there is one command, matching
 * `dev-cli`'s entry point next door; reach for a framework when several
 * commands genuinely need one.
 */
import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadBoundaryConfig,
  loadBoundaryConfigFile,
  MODULE_BOUNDARIES_CONFIG_FILE,
} from "./src/config.mjs";
import { formatSarif } from "./src/report/sarif.mjs";
import { formatReport } from "./src/report/text.mjs";
import { evaluate } from "./src/rules/index.mjs";
import {
  analyzeWorkspace,
  createWorkspace,
  findWorkspaceRoot,
  listTrackedFiles,
  readProjectGraph,
  selectFiles,
} from "./src/workspace.mjs";

export const EXIT = Object.freeze({
  ok: 0,
  violations: 1,
  usage: 2,
  error: 3,
});

const FORMATS = Object.freeze({ text: formatReport, sarif: formatSarif });

const USAGE = `nx-polyglot-graph — module-boundary enforcement across every language in the workspace

Usage:
  nx-polyglot-graph check [<path>...]   Check imports against the boundary rules
  nx-polyglot-graph --help              Show this message

Options:
  --format text|sarif   Terminal report (default), or SARIF 2.1.0 for GitHub code scanning
  --output <file>       Write the report to a file instead of stdout
  --config <file>       Read the boundary law from here instead of
                        <workspace root>/${MODULE_BOUNDARIES_CONFIG_FILE}

Projects and tags come from the Nx project graph; the rules come from
${MODULE_BOUNDARIES_CONFIG_FILE} at the workspace root — the same table ESLint
reads, so both enforcers answer from one source.

Naming paths scopes the run to those files. That is a fast local pre-check and
not the gate: the cycle and lazy-load rules judge the file graph as a whole, so
a scoped run can miss what a whole-workspace run would find.

Exit codes: ${EXIT.ok} clean · ${EXIT.violations} violations found · ${EXIT.usage} usage error · ${EXIT.error} the run could not complete`;

/**
 * Splits `check`'s arguments into options and paths.
 *
 * Rejects an unknown `--flag` rather than treating it as a path: a typo like
 * `--fromat sarif` would otherwise be read as two paths, select no files, and
 * report a clean tree — the exact false green this tool exists to remove.
 *
 * @param {string[]} argv Arguments after `check`.
 * @returns {{format: string, output: string|null, config: string|null, paths: string[]}}
 * @throws {Error} on an unknown flag, a missing value, or an unknown format.
 */
export function parseCheckArgs(argv) {
  const parsed = { format: "text", output: null, config: null, paths: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed.paths.push(arg);
      continue;
    }
    const [flag, inlineValue] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const key = { "--format": "format", "--output": "output", "--config": "config" }[flag];
    if (!key) throw new Error(`unknown option '${flag}'`);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`'${flag}' needs a value`);
    parsed[key] = value;
  }
  if (!(parsed.format in FORMATS)) {
    throw new Error(
      `unknown format '${parsed.format}' — expected one of ${Object.keys(FORMATS).join(", ")}`,
    );
  }
  return parsed;
}

/**
 * Runs one `check`: graph, analysis, rules, report.
 *
 * Returns the report and the counts rather than printing, so the caller owns
 * both the destination and the exit code — and so a test can read the verdict
 * without a subprocess.
 *
 * `readGraph` and `listFiles` are the two seams that reach outside this process
 * — Nx and git. Injectable for the same reason every resolver in this project
 * takes its readers: a test drives the real analysis, the real rules and the
 * real report over a fixture tree, and pins the exact `file:line:column` a
 * developer would act on, without an Nx installation or a git repository.
 *
 * @param {{format: string, config: string|null, paths: string[]}} options
 * @param {{cwd: string, readGraph?: Function, listFiles?: Function}} context
 * @returns {Promise<{report: string, violations: number, analyzed: number}>}
 */
export async function check(
  options,
  { cwd, readGraph = readProjectGraph, listFiles = listTrackedFiles },
) {
  const root = findWorkspaceRoot(cwd);
  if (root === null) {
    throw new Error(
      `nx-polyglot-graph: no Nx workspace above ${cwd} — looked for an nx.json in every parent. ` +
        `The tree to judge is found from the working directory, never from this tool's own ` +
        `location, because under a pinned harness clone the two are different trees.`,
    );
  }

  // The config's location is a separate fact from the workspace root, which is
  // why `--config` does not move the root: under a harness clone the tool and
  // the law it enforces are in different trees, and the tree being judged is
  // still the consumer's.
  const config = options.config
    ? await loadBoundaryConfigFile(
        isAbsolute(options.config) ? options.config : resolve(cwd, options.config),
      )
    : await loadBoundaryConfig(root);

  const graph = readGraph(root);
  const tracked = listFiles(root);
  const { workspace, owned } = createWorkspace({ root, graph, files: tracked });
  const selected = selectFiles(
    owned.map(({ file }) => file),
    options.paths,
    { root, cwd },
  );

  const { imports, failures, analyzed } = analyzeWorkspace(workspace, selected);
  const violations = evaluate(imports, graph, config);
  return {
    report: FORMATS[options.format]({
      violations,
      failures,
      analyzed,
      imports: imports.length,
      projects: Object.keys(graph.nodes).length,
    }),
    violations: violations.length,
    analyzed,
  };
}

/**
 * Runs the CLI and returns its exit code.
 *
 * `env` is everything the command touches outside itself: its two streams, the
 * working directory that decides which tree is judged, and the Nx and git seams
 * `check` reaches through. A test supplies all four and reads the verdict
 * without capturing a process or standing up a workspace.
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {{out: (text: string) => void, err: (text: string) => void, cwd?: string,
 *   readGraph?: Function, listFiles?: Function}} env
 * @returns {Promise<number>} one of `EXIT`.
 */
export async function runCli(argv, env) {
  const [command, ...rest] = argv;

  if (command === "--help" || command === "-h") {
    env.out(USAGE);
    return EXIT.ok;
  }

  if (command !== "check") {
    env.err(
      command === undefined
        ? "nx-polyglot-graph: no command given."
        : `nx-polyglot-graph: unknown command '${command}'.`,
    );
    env.err(USAGE);
    return EXIT.usage;
  }

  let options;
  try {
    options = parseCheckArgs(rest);
  } catch (error) {
    env.err(`nx-polyglot-graph: ${error.message}`);
    env.err(USAGE);
    return EXIT.usage;
  }

  let result;
  try {
    result = await check(options, {
      cwd: env.cwd ?? process.cwd(),
      readGraph: env.readGraph,
      listFiles: env.listFiles,
    });
  } catch (error) {
    // A path outside the tree is the user's typo, everything else is the run
    // failing; the two get different codes because only one is worth retrying
    // with different arguments.
    const usage = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usage ? EXIT.usage : EXIT.error;
  }

  if (options.output) {
    writeFileSync(
      options.output,
      result.report.endsWith("\n") ? result.report : `${result.report}\n`,
    );
    // The report went to a file, so the log would otherwise say nothing at all
    // about a run that just failed the build.
    env.err(
      `nx-polyglot-graph: ${result.violations} violation${result.violations === 1 ? "" : "s"} ` +
        `over ${result.analyzed} analyzed file${result.analyzed === 1 ? "" : "s"} → ${options.output}`,
    );
  } else {
    env.out(result.report);
  }
  return result.violations > 0 ? EXIT.violations : EXIT.ok;
}

// Run only when invoked as a program, so importing this module for its exit
// codes or `runCli` does not execute a command as a side effect.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(
    await runCli(process.argv.slice(2), {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
    }),
  );
}
