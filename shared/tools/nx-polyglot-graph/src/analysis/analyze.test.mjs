import { describe, expect, it } from "vitest";

import { analyzeFile, LANGUAGE_BY_EXTENSION, languageOf } from "./analyze.mjs";

const request = (sourceFile) => ({ sourceFile, text: "", workspace: {} });

describe("languageOf", () => {
  it("claims an extension only through the registry, so one map decides every dispatch", () => {
    for (const [extension, language] of Object.entries(LANGUAGE_BY_EXTENSION)) {
      expect(languageOf(`shared/libs/thing/src/file${extension}`)).toBe(language);
    }
  });

  it("reads the last extension of a dotted filename, not the first", () => {
    expect(languageOf("vitest.config.mjs")).toBe("typescript");
    expect(languageOf("shared/tools/thing/foo.test.mjs")).toBe("typescript");
  });

  it("claims nothing for a file no analyzer can read", () => {
    expect(languageOf("shared/tools/thing/README.md")).toBeNull();
    expect(languageOf("shared/tools/thing/project.json")).toBeNull();
    expect(languageOf("Makefile")).toBeNull();
  });

  it("treats a dotfile as having no extension rather than as its own extension", () => {
    expect(languageOf(".gitignore")).toBeNull();
    expect(languageOf("shared/libs/thing/.npmrc")).toBeNull();
  });
});

describe("analyzeFile", () => {
  // The distinction this pins is the one that decides whether a run is
  // trustworthy: a file nothing can read has no imports to find, while a file
  // whose language IS in scope and reports nothing would be indistinguishable
  // from a clean file. The first is a no-op; the second must be impossible.
  it("returns an empty result for a file no analyzer claims", () => {
    expect(analyzeFile(request("shared/tools/thing/README.md"))).toEqual({
      imports: [],
      failures: [],
    });
  });

  it("refuses to report a claimed language as importing nothing while its analyzer is missing", () => {
    for (const extension of Object.keys(LANGUAGE_BY_EXTENSION)) {
      expect(() => analyzeFile(request(`platform/libs/engine/file${extension}`))).toThrow(
        /no \w+ import analyzer is implemented yet/,
      );
    }
  });

  it("names the language and the file it could not analyze", () => {
    expect(() => analyzeFile(request("platform/libs/engine-domain/task.go"))).toThrow(
      /no go import analyzer.*'platform\/libs\/engine-domain\/task\.go'/s,
    );
  });
});
