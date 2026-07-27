/**
 * Emits the deterministic facts a PR description is built from (JSON on
 * stdout), so prose-writing tooling never re-derives or guesses them:
 * parsed branch commits, touched projects/subsystems, which
 * `.github/PULL_REQUEST_TEMPLATE.md` "Type of Change" boxes the commit types
 * justify, and whether the diff touches tests or the view layer.
 *
 * Facts only — no judgment, no formatting: the Description and Test Steps
 * prose stays with whoever consumes this (`.claude/skills/create-pr`).
 * Default base is `origin/main`; override with `--base <ref>`.
 */
import { execFileSync } from "node:child_process";

import {
  deriveSubsystems,
  discoverProjects,
  isIgnoredMessage,
  messageHeader,
  ownerOf,
  parseHeader,
} from "./check-commit-scope.mjs";

const git = (args) => execFileSync("git", args, { encoding: "utf8" });

/** `type(scope)!: …` header or a `BREAKING CHANGE:` footer. */
const isBreaking = (header, body) =>
  /^[a-z]+(\([^)]*\))?!: /.test(header) || /^BREAKING[ -]CHANGE:/m.test(body);

/** The template's "Type of Change" labels justified by the branch commits. */
export function typeOfChange(commits, viewLayerTouched) {
  const labels = [];
  const types = new Set(commits.map((c) => c.type));
  if (commits.some((c) => c.breaking))
    labels.push("Breaking change (fix or feature causing existing functionality to change)");
  if (types.has("fix")) labels.push("Bug fix (non-breaking change fixing an issue)");
  if (types.has("feat")) labels.push("New feature (non-breaking change adding functionality)");
  if (types.has("docs")) labels.push("Documentation update");
  if (types.has("refactor") || types.has("perf")) labels.push("Refactor / performance improvement");
  if (viewLayerTouched) labels.push("Design system / component update");
  return labels;
}

/** Collects every fact for the branch `base..HEAD`. Pure given its git data. */
export function collectPrFacts(base) {
  const shas = git(["rev-list", "--no-merges", `${base}..HEAD`])
    .split("\n")
    .filter(Boolean);
  const commits = [];
  for (const sha of shas) {
    const body = git(["log", "-1", "--format=%B", sha]);
    const header = messageHeader(body);
    if (header === "" || isIgnoredMessage(header)) continue;
    const parsed = parseHeader(header);
    commits.push({
      sha,
      type: parsed?.type ?? null,
      scope: parsed?.scope ?? null,
      header, // the full `type(scope): subject` line, not the subject alone
      breaking: isBreaking(header, body),
    });
  }

  const changedPaths = git(["diff", "--name-only", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean);
  const projects = discoverProjects();
  const subsystems = deriveSubsystems(projects);
  const byName = new Map(projects.map((p) => [p.name, p]));

  const touchedProjects = new Set();
  const touchedSubsystems = new Set();
  let workspaceTouched = false;
  for (const path of changedPaths) {
    const owner = ownerOf(path, projects, subsystems);
    if (owner.kind === "project") touchedProjects.add(owner.name);
    else if (owner.kind === "subsystem") touchedSubsystems.add(owner.name);
    else workspaceTouched = true;
  }

  // Only project-owned `layer:view` changes count; a subsystem- or workspace-
  // owned view edit (a shell app, a root asset) won't flip this — the
  // consuming skill is expected to correct the Design-system box when it
  // knows better.
  const viewLayerTouched = [...touchedProjects].some((name) =>
    byName.get(name)?.tags.includes("layer:view"),
  );
  const testsChanged = changedPaths.some((p) => /\.(test|spec)\.[^/]+$/.test(p));

  return {
    base,
    commits,
    changedPaths,
    touchedProjects: [...touchedProjects].sort(),
    touchedSubsystems: [...touchedSubsystems].sort(),
    workspaceTouched,
    testsChanged,
    viewLayerTouched,
    typeOfChange: typeOfChange(commits, viewLayerTouched),
  };
}

/** CLI entry — prints the facts as JSON. Returns a process exit code. */
export function prFacts(args = []) {
  const baseFlag = args.indexOf("--base");
  const base = baseFlag !== -1 && args[baseFlag + 1] ? args[baseFlag + 1] : "origin/main";
  console.log(JSON.stringify(collectPrFacts(base), null, 2));
  return 0;
}
