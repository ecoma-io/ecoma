#!/usr/bin/env node
/**
 * dev-cli — local developer commands for this workspace. Register a subcommand
 * in COMMANDS below; each is a thin wrapper over a module in this directory
 * that returns a process exit code. Keep argument parsing here minimal — reach
 * for a CLI framework only once several commands genuinely need one.
 */
import { checkClaudeMd } from "./check-claude-md.mjs";
import { checkCommandRefs } from "./check-command-refs.mjs";
import { checkCommitScope } from "./check-commit-scope.mjs";
import { checkContributorRecord } from "./check-contributor-record.mjs";
import { checkDocLinks } from "./check-doc-links.mjs";
import { checkDoctrine } from "./check-doctrine.mjs";
import { checkPracticeIndex } from "./check-practice-index.mjs";
import { checkE2eStoryCoverage } from "./check-e2e-story-coverage.mjs";
import { checkGofmt } from "./check-gofmt.mjs";
import { checkJourneyMarkers, checkWorkspaceDocs } from "./check-journey-markers.mjs";
import { checkPrimitiveArtifacts } from "./check-primitive-artifacts.mjs";
import { checkProjectConventions } from "./check-project-conventions.mjs";
import { checkRoadmapIds } from "./check-roadmap-ids.mjs";
import { checkSubprojectReadmes } from "./check-subproject-readmes.mjs";
import { checkSubsystemReadmes } from "./check-subsystem-readmes.mjs";
import { conformance } from "./conformance.mjs";
import { doctrineSync } from "./doctrine-sync.mjs";
import { ensureCommitIdentity } from "./ensure-commit-identity.mjs";
import { listRoadmapIds } from "./list-roadmap-ids.mjs";
import { listScopes } from "./list-scopes.mjs";
import { prFacts } from "./pr-facts.mjs";
import { runE2e } from "./run-e2e.mjs";
import { RUN_GO_TESTS_COMMAND, runGoTests } from "./run-go-tests.mjs";
import { RUN_NODE_TESTS_COMMAND, runNodeTests } from "./run-node-tests.mjs";
import { scaffoldLib } from "./scaffold-lib.mjs";
import { stripClaudeTrailers } from "./strip-claude-trailers.mjs";
import { workspaceGates } from "./workspace-gates.mjs";

const COMMANDS = {
  "check-journey-markers": (args) => checkJourneyMarkers(args[0] ?? "."),
  "check-journey-markers-workspace": () => checkWorkspaceDocs(),
  "check-claude-md": () => checkClaudeMd(),
  "check-command-refs": () => checkCommandRefs(),
  "check-commit-scope": (args) => checkCommitScope(args),
  "check-contributor-record": (args) => checkContributorRecord(args),
  "check-doc-links": () => checkDocLinks(),
  "check-doctrine": (args) => checkDoctrine(args),
  "check-practice-index": () => checkPracticeIndex(),
  "check-e2e-story-coverage": (args) => checkE2eStoryCoverage(args),
  "check-gofmt": () => checkGofmt(),
  "check-primitive-artifacts": () => checkPrimitiveArtifacts(),
  "check-project-conventions": () => checkProjectConventions(),
  "check-roadmap-ids": () => checkRoadmapIds(),
  "check-subproject-readmes": () => checkSubprojectReadmes(),
  "check-subsystem-readmes": () => checkSubsystemReadmes(),
  conformance: (args) => conformance(args),
  "doctrine-sync": (args) => doctrineSync(args),
  "ensure-commit-identity": (args) => ensureCommitIdentity(args),
  "list-roadmap-ids": (args) => listRoadmapIds(args),
  "list-scopes": (args) => listScopes(args),
  "pr-facts": (args) => prFacts(args),
  "run-e2e": (args) => runE2e(args),
  // Computed key, not a literal: `check-project-conventions` requires a
  // `node --test` project's target to name this command, so the two must read
  // one spelling (Rule 14) — a drifted literal would demand a command that does
  // not exist, and no gate scans this registry for that.
  [RUN_NODE_TESTS_COMMAND]: (args) => runNodeTests(args),
  // Same contract for the Go runner: the gate requires a Go project's test
  // target to name this command, off this same exported spelling.
  [RUN_GO_TESTS_COMMAND]: (args) => runGoTests(args),
  "scaffold-lib": (args) => scaffoldLib(args),
  "strip-claude-trailers": (args) => stripClaudeTrailers(args[0]),
  "workspace-gates": () => workspaceGates(),
};

const [command, ...args] = process.argv.slice(2);
const run = COMMANDS[command];

if (!run) {
  const known = Object.keys(COMMANDS).join(", ");
  console.error(`dev-cli: unknown command '${command ?? ""}'. Available: ${known}`);
  process.exit(2);
}

process.exit(run(args) ?? 0);
