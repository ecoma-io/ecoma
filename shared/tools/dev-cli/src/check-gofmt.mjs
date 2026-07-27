/**
 * Enforces `gofmt` formatting on a Go project — golangci-lint v2's default
 * linter set does not include `gofmt`, so this closes that gap. Runs
 * `gofmt -l .` (list-only, never `-w`) and fails loud naming every
 * unformatted file; used in place of the POSIX-only
 * `test -z "$(gofmt -l .)"` snippet so the Go scaffold's `lint` target stays
 * portable to `cmd.exe`/PowerShell (native Windows dev support).
 */
import { execFileSync } from "node:child_process";

/** CLI entry — scans the current directory recursively. Returns a process exit code. */
export function checkGofmt() {
  const unformatted = execFileSync("gofmt", ["-l", "."], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const file of unformatted) {
    console.error(`${file}: not gofmt-formatted — run 'gofmt -w .'`);
  }
  return unformatted.length > 0 ? 1 : 0;
}
