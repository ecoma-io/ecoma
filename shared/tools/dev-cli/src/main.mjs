#!/usr/bin/env node
/**
 * dev-cli — local developer commands for this workspace. Register a subcommand
 * in COMMANDS below; each is a thin wrapper over a module in this directory
 * that returns a process exit code. Keep argument parsing here minimal — reach
 * for a CLI framework only once several commands genuinely need one.
 */
import { checkClaudeMd } from "./check-claude-md.mjs";
import { checkCommitScope } from "./check-commit-scope.mjs";
import { checkDocLinks } from "./check-doc-links.mjs";
import { checkDoctrine } from "./check-doctrine.mjs";
import { checkDoctrineIndex } from "./check-doctrine-index.mjs";
import { checkE2eStoryCoverage } from "./check-e2e-story-coverage.mjs";
import { checkGofmt } from "./check-gofmt.mjs";
import { checkJourneyMarkers, checkWorkspaceDocs } from "./check-journey-markers.mjs";
import { checkPrimitiveArtifacts } from "./check-primitive-artifacts.mjs";
import { checkProjectConventions } from "./check-project-conventions.mjs";
import { checkSubprojectReadmes } from "./check-subproject-readmes.mjs";
import { checkSubsystemReadmes } from "./check-subsystem-readmes.mjs";
import { ensureCommitIdentity } from "./ensure-commit-identity.mjs";
import { listScopes } from "./list-scopes.mjs";
import { prFacts } from "./pr-facts.mjs";
import { runE2e } from "./run-e2e.mjs";
import { scaffoldLib } from "./scaffold-lib.mjs";
import { stripClaudeTrailers } from "./strip-claude-trailers.mjs";

const COMMANDS = {
  "check-journey-markers": (args) => checkJourneyMarkers(args[0] ?? "."),
  "check-journey-markers-workspace": () => checkWorkspaceDocs(),
  "check-claude-md": () => checkClaudeMd(),
  "check-commit-scope": (args) => checkCommitScope(args),
  "check-doc-links": () => checkDocLinks(),
  "check-doctrine": () => checkDoctrine(),
  "check-doctrine-index": () => checkDoctrineIndex(),
  "check-e2e-story-coverage": (args) => checkE2eStoryCoverage(args),
  "check-gofmt": () => checkGofmt(),
  "check-primitive-artifacts": () => checkPrimitiveArtifacts(),
  "check-project-conventions": () => checkProjectConventions(),
  "check-subproject-readmes": () => checkSubprojectReadmes(),
  "check-subsystem-readmes": () => checkSubsystemReadmes(),
  "ensure-commit-identity": (args) => ensureCommitIdentity(args),
  "list-scopes": (args) => listScopes(args),
  "pr-facts": (args) => prFacts(args),
  "run-e2e": (args) => runE2e(args),
  "scaffold-lib": (args) => scaffoldLib(args),
  "strip-claude-trailers": (args) => stripClaudeTrailers(args[0]),
};

const [command, ...args] = process.argv.slice(2);
const run = COMMANDS[command];

if (!run) {
  const known = Object.keys(COMMANDS).join(", ");
  console.error(`dev-cli: unknown command '${command ?? ""}'. Available: ${known}`);
  process.exit(2);
}

process.exit(run(args) ?? 0);
