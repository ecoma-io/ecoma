#!/usr/bin/env node
// SessionStart hook — remote (cloud) sessions only: provision the sandbox so
// the definition-of-done targets (`pnpm nx affected -t lint test typecheck
// build`) can run across the polyglot toolchains. All logic lives in
// ../../setup.mjs — the same script contributors run locally — so there is
// exactly one setup path to maintain; this wrapper only supplies the
// non-interactive flag and skips local sessions, where the contributor runs
// setup.mjs themselves. Synchronous on purpose: the session must not start
// racing a half-installed node_modules. This hook only ever runs inside the
// Linux cloud sandbox (gated by CLAUDE_CODE_REMOTE), so shelling out to
// Linux-only tools (sh, id, sudo) below is safe.
import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.env.CLAUDE_CODE_REMOTE !== "true") {
  process.exit(0);
}

function commandExists(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

function dockerReady() {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The remote sandbox ships dockerd but doesn't start it
// (github.com/anthropics/claude-code/issues/53430) — start it here so
// docker-dependent nx targets have a daemon to talk to.
if (commandExists("dockerd") && !dockerReady()) {
  const log = openSync("/tmp/dockerd.log", "a");
  const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
  if (uid === "0") {
    spawn("dockerd", [], { detached: true, stdio: ["ignore", log, log] }).unref();
  } else if (commandExists("sudo")) {
    spawn("sudo", ["dockerd"], { detached: true, stdio: ["ignore", log, log] }).unref();
  }
  let ready = false;
  for (let i = 0; i < 30; i++) {
    if (dockerReady()) {
      ready = true;
      break;
    }
    sleepSync(1000);
  }
  if (!ready) {
    console.error("WARNING: dockerd did not become ready within 30s; see /tmp/dockerd.log");
  }
}

const projectDir = process.env.CLAUDE_PROJECT_DIR;
if (!projectDir) throw new Error("CLAUDE_PROJECT_DIR is not set");
const { runSetup } = await import(pathToFileURL(join(projectDir, "setup.mjs")).href);
process.exit(runSetup(["--yes"]));
