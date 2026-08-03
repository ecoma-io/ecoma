import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runGoTests } from "./run-go-tests.mjs";

const FLOOR = { statements: 80 };

/** Writes a throwaway Go module and returns its directory. */
function goModule(files) {
  const dir = mkdtempSync(join(tmpdir(), "run-go-tests-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const GO_MOD = "module fixture.local/m\n\ngo 1.26.5\n";

describe("runGoTests against real go modules", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it("passes a fully covered module", () => {
    process.chdir(
      goModule({
        "go.mod": GO_MOD,
        "lib.go": "package m\n\nfunc Double(x int) int { return x * 2 }\n",
        "lib_test.go":
          'package m\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif Double(2) != 4 {\n\t\tt.Fatal("wrong")\n\t}\n}\n',
      }),
    );
    expect(runGoTests([], { thresholds: FLOOR })).toBe(0);
  });

  it("fails a module whose coverage sits below the floor", () => {
    process.chdir(
      goModule({
        "go.mod": GO_MOD,
        "lib.go":
          "package m\n\nfunc Covered() int { return 1 }\n\nfunc Uncovered() int { return 2 }\n\nfunc AlsoUncovered() int { return 3 }\n",
        "lib_test.go":
          'package m\n\nimport "testing"\n\nfunc TestCovered(t *testing.T) {\n\tif Covered() != 1 {\n\t\tt.Fatal("wrong")\n\t}\n}\n',
      }),
    );
    expect(runGoTests([], { thresholds: FLOOR })).toBe(1);
  });

  it("propagates a failing test as a red run", () => {
    process.chdir(
      goModule({
        "go.mod": GO_MOD,
        "lib.go": "package m\n\nfunc One() int { return 1 }\n",
        "lib_test.go":
          'package m\n\nimport "testing"\n\nfunc TestOne(t *testing.T) {\n\tif One() != 2 {\n\t\tt.Fatal("pinned to fail")\n\t}\n}\n',
      }),
    );
    expect(runGoTests([], { thresholds: FLOOR })).toBe(1);
  });

  it("passes a skeleton with test files but no statements — the workspace's ◆G0 state", () => {
    process.chdir(
      goModule({
        "go.mod": GO_MOD,
        "doc.go": "package m\n",
        "contract_test.go": "// TODO: cases land with the frozen schema.\npackage m\n",
      }),
    );
    expect(runGoTests([], { thresholds: FLOOR })).toBe(0);
  });
});
