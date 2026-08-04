import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, globSync } from "node:fs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  globSync: vi.fn(),
}));

const NX_GRAPH_FIXTURE = JSON.stringify({
  graph: {
    nodes: {
      "shared-libs-core-ui": {
        data: {
          root: "shared/libs/core-ui",
          tags: ["scope:shared", "type:lib", "layer:view"],
        },
      },
      "shared-tools-dev-cli": {
        data: {
          root: "shared/tools/dev-cli",
          tags: ["scope:shared", "type:lib", "layer:util"],
        },
      },
      "docs-site": {
        data: {
          root: "apps/docs-site",
          tags: ["scope:shared", "type:app"],
        },
      },
    },
    dependencies: {
      "shared-tools-dev-cli": [
        { source: "shared-tools-dev-cli", target: "npm:chalk", type: "static" },
        { source: "shared-tools-dev-cli", target: "npm:vitest", type: "static" },
        { source: "shared-tools-dev-cli", target: "shared-libs-core-ui", type: "static" },
      ],
    },
  },
});

describe("readNxGraph", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a valid Nx graph and extracts nodes with tags", async () => {
    const { readNxGraph } = await import("./nx-reader.mjs");

    vi.mocked(execFileSync).mockReturnValue("");
    vi.mocked(readFileSync).mockReturnValue(NX_GRAPH_FIXTURE);

    const result = readNxGraph();

    expect(result.source).toBe("nx-graph");
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(1);

    const coreUi = result.nodes.find((n) => n.name === "shared-libs-core-ui");
    expect(coreUi.scope).toBe("shared");
    expect(coreUi.type).toBe("lib");
    expect(coreUi.layer).toBe("view");

    const docsSite = result.nodes.find((n) => n.name === "docs-site");
    expect(docsSite.scope).toBe("shared");
    expect(docsSite.type).toBe("app");
    expect(docsSite.layer).toBeNull();

    expect(result.edges[0].from).toBe("shared-tools-dev-cli");
    expect(result.edges[0].to).toBe("shared-libs-core-ui");
    expect(result.edges[0].type).toBe("static");
  });

  it("filters out npm: dependency edges", async () => {
    const { readNxGraph } = await import("./nx-reader.mjs");

    vi.mocked(execFileSync).mockReturnValue("");
    vi.mocked(readFileSync).mockReturnValue(NX_GRAPH_FIXTURE);

    const result = readNxGraph();
    expect(result.edges.every((e) => !e.to.startsWith("npm:"))).toBe(true);
  });

  it("returns null when execFileSync throws", async () => {
    const { readNxGraph } = await import("./nx-reader.mjs");

    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("pnpm not found");
    });

    const result = readNxGraph();
    expect(result).toBeNull();
  });

  it("returns null when the graph file is invalid JSON", async () => {
    const { readNxGraph } = await import("./nx-reader.mjs");

    vi.mocked(execFileSync).mockReturnValue("");
    vi.mocked(readFileSync).mockReturnValue("not json");

    const result = readNxGraph();
    expect(result).toBeNull();
  });

  it("extracts license tag when present", async () => {
    const { readNxGraph } = await import("./nx-reader.mjs");

    const fixture = JSON.stringify({
      graph: {
        nodes: {
          "runtime-protocol": {
            data: {
              root: "shared/packages/runtime-protocol",
              tags: ["scope:shared", "type:lib", "license:apache"],
            },
          },
        },
        dependencies: {},
      },
    });

    vi.mocked(execFileSync).mockReturnValue("");
    vi.mocked(readFileSync).mockReturnValue(fixture);

    const result = readNxGraph();
    expect(result.nodes[0].license).toBe("apache");
  });

  it("defaults license to ? when absent", async () => {
    const { readNxGraph } = await import("./nx-reader.mjs");

    vi.mocked(execFileSync).mockReturnValue("");
    vi.mocked(readFileSync).mockReturnValue(NX_GRAPH_FIXTURE);

    const result = readNxGraph();
    const docsSite = result.nodes.find((n) => n.name === "docs-site");
    expect(docsSite.license).toBe("?");
  });

  it("handles nodes with no tags array", async () => {
    const { readNxGraph } = await import("./nx-reader.mjs");

    const fixture = JSON.stringify({
      graph: {
        nodes: {
          untagged: {
            data: { root: "libs/untagged" },
          },
        },
        dependencies: {},
      },
    });

    vi.mocked(execFileSync).mockReturnValue("");
    vi.mocked(readFileSync).mockReturnValue(fixture);

    const result = readNxGraph();
    expect(result.nodes[0].scope).toBe("?");
    expect(result.nodes[0].type).toBe("?");
    expect(result.nodes[0].layer).toBeNull();
  });
});

describe("readProjectJsonFallback", () => {
  beforeEach(() => {
    vi.mocked(globSync).mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads project.json files and extracts nodes with tags", async () => {
    const { readProjectJsonFallback } = await import("./nx-reader.mjs");

    vi.mocked(globSync).mockReturnValue([
      "/repo/shared/libs/core-ui/project.json",
      "/repo/shared/tools/dev-cli/project.json",
    ]);
    vi.mocked(readFileSync)
      .mockReturnValueOnce(
        JSON.stringify({
          name: "core-ui",
          tags: ["scope:shared", "type:lib", "layer:view"],
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          name: "dev-cli",
          tags: ["scope:shared", "type:lib", "layer:util"],
        }),
      );

    const result = readProjectJsonFallback();

    expect(result.source).toBe("project-json-fallback");
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toEqual([]);

    expect(result.nodes[0].name).toBe("core-ui");
    expect(result.nodes[0].scope).toBe("shared");
    expect(result.nodes[0].type).toBe("lib");
    expect(result.nodes[0].layer).toBe("view");
    expect(result.nodes[0].root).toBe("/repo/shared/libs/core-ui");

    expect(result.nodes[1].name).toBe("dev-cli");
    expect(result.nodes[1].layer).toBe("util");
  });

  it("skips project.json files without a name field", async () => {
    const { readProjectJsonFallback } = await import("./nx-reader.mjs");

    vi.mocked(globSync).mockReturnValue(["/repo/shared/libs/empty/project.json"]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({}));

    const result = readProjectJsonFallback();

    expect(result.nodes).toEqual([]);
  });

  it("skips invalid JSON files silently", async () => {
    const { readProjectJsonFallback } = await import("./nx-reader.mjs");

    vi.mocked(globSync).mockReturnValue(["/repo/shared/libs/bad/project.json"]);
    vi.mocked(readFileSync).mockReturnValue("not valid json");

    const result = readProjectJsonFallback();

    expect(result.nodes).toEqual([]);
  });

  it("skips files with non-object JSON", async () => {
    const { readProjectJsonFallback } = await import("./nx-reader.mjs");

    vi.mocked(globSync).mockReturnValue(["/repo/shared/libs/array/project.json"]);
    vi.mocked(readFileSync).mockReturnValue("[]");

    const result = readProjectJsonFallback();

    expect(result.nodes).toEqual([]);
  });

  it("returns empty result when no project.json files found", async () => {
    const { readProjectJsonFallback } = await import("./nx-reader.mjs");

    vi.mocked(globSync).mockReturnValue([]);

    const result = readProjectJsonFallback();

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});
