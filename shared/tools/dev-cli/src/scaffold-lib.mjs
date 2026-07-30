/**
 * Scaffolds a buildless internal library the way this workspace requires one
 * to look (root CLAUDE.md → Workspace Execution; enforced after the fact by
 * `check-project-conventions` and `local/require-project-tags`):
 *
 *   scaffold-lib <name> --subsystem <shared> [--lang <ts|go|rust|python>] [--layer <l>]
 *
 * Writes `<subsystem>/libs/<name>/` — `project.json` with hand-written
 * `nx:run-commands` targets (never inferred ones; the nx-polyglot-graph
 * plugin only adds EDGES), a loud `CLAUDE.md` stub, the 3 README language
 * variants every subproject must carry (`check-subproject-readmes`), and the
 * language's own manifest and source stub:
 *   ts     — deps-free `package.json`, `tsconfig.json`, `vitest.config.ts`,
 *            `src/index.ts`, plus the `@ecoma-io/<name>` alias in
 *            `tsconfig.base.json`.
 *   go     — `go.mod` (module `ecoma.io/<subsystem>/<name>`), `doc.go`, plus a
 *            `use` entry in the repo-root `go.work`.
 *   rust   — `Cargo.toml`, `src/lib.rs`, plus a member entry in the
 *            repo-root workspace `Cargo.toml` and `target/` in .gitignore.
 *   python — uv-flavored `pyproject.toml` (src layout), a `conftest.py`
 *            keeping an empty suite green, plus a member entry in the
 *            repo-root `pyproject.toml` `[tool.uv.workspace]` and `.venv/`
 *            in .gitignore.
 *
 * Mechanical half only (Rule 5): choosing the subsystem/lang/layer and writing
 * the real CLAUDE.md content are judgment calls that stay with the caller
 * (`.claude/skills/scaffold-lib`). Apps are out of scope — an app shell is
 * rare enough to copy by hand from a living one.
 *
 * The `--subsystem` vocabulary is derived, never hardcoded here: it reuses
 * `deriveSubsystemRoots` (`check-subsystem-readmes.mjs`) against the tracked
 * file tree — a top-level directory only counts once it actually holds
 * tracked files, so a deleted subsystem drops out on its own and a typo'd
 * one is rejected loudly. Two other vocabularies still hardcode the same set
 * and must be kept in sync by hand — `require-project-tags.mjs`'s `SCOPES`
 * and the `depConstraints` in the root `eslint.config.mjs` — because ESLint
 * rule config loads statically, not per-execution `git`-shelling.
 */
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";

import { deriveSubsystemRoots } from "./check-subsystem-readmes.mjs";
import { cwdGitEnv } from "./git-env.mjs";
import { licenseForPath, MANIFEST_LICENSE } from "./license-scope.mjs";
// `LANGS` here means programming languages; the README contract's are human
// languages, hence the alias.
import {
  expectedNavLine,
  LANGS as README_LANGS,
  readmeFilename,
  SUBPROJECT_SECTIONS,
} from "./readme-schema.mjs";

const LAYERS = new Set(["util", "domain", "port", "adapter", "view"]);
const LANGS = new Set(["ts", "go", "rust", "python"]);

/** Real tracked-paths source for `scaffoldLib`; overridden in tests. */
function listTrackedPaths() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8", env: cwdGitEnv() })
    .split("\n")
    .filter(Boolean);
}

// Only reachable when the repo has no go.work yet — it already does, so this
// branch is dormant in practice; kept so scaffolding a Go lib still works the
// day someone bootstraps go.work fresh. Once go.work exists, `deriveGoVersion`
// reads its own `go X.Y.Z` line instead, so the version stamped into a new
// go.mod can never drift from the pin CI and CONTRIBUTING.md already point to
// (Rule 14).
const FALLBACK_GO_VERSION = "1.26.5";
const DEV_CLI = "node ../../../shared/tools/dev-cli/src/main.mjs";
// Non-TS projects never run `eslint .`, so their lint command lints
// project.json explicitly or `local/require-project-tags` never fires.
const PROJECT_JSON_LINT = "eslint project.json --max-warnings 0";

const projectJson = (name, root, subsystem, layer, targets) =>
  JSON.stringify(
    {
      name,
      $schema: "../../../node_modules/nx/schemas/project-schema.json",
      projectType: "library",
      sourceRoot: `${root}/src`,
      tags: [
        "type:lib",
        `scope:${subsystem}`,
        `license:${licenseForPath(root)}`,
        ...(layer ? [`layer:${layer}`] : []),
      ],
      targets: Object.fromEntries(
        Object.entries(targets).map(([target, command]) => [
          target,
          { executor: "nx:run-commands", options: { cwd: "{projectRoot}", command } },
        ]),
      ),
    },
    null,
    2,
  );

const packageJson = (name, root) =>
  JSON.stringify(
    {
      name: `@ecoma-io/${name}`,
      version: "0.0.1",
      private: true,
      description: `TODO: one line on what @ecoma-io/${name} is`,
      license: MANIFEST_LICENSE[licenseForPath(root)],
      type: "module",
      main: "./src/index.ts",
      types: "./src/index.ts",
      exports: { ".": "./src/index.ts" },
    },
    null,
    2,
  );

const tsconfigJson = JSON.stringify(
  {
    extends: "../../../tsconfig.base.json",
    compilerOptions: { outDir: "./dist", noEmit: true },
    include: ["src/**/*.ts"],
  },
  null,
  2,
);

// The two halves of the vitest reserved seam, and the one place each is
// spelled. `check-project-conventions` requires both closed the moment a
// project has test files, so the gate and the template must agree on the flag's
// name and on where the floor is read from (Rule 14) — the same contract
// `PYTEST_EMPTY_SUITE_MASK` below carries for pytest.
export const VITEST_EMPTY_SUITE_FLAG = "passWithNoTests";
export const COVERAGE_CONFIG_FILE = "coverage.config.json";

const vitestConfig = `import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

// The floor is a workspace value, not this project's — the repo-root
// \`${COVERAGE_CONFIG_FILE}\` says why it lives there and who else reads it.
// \`createRequire\` rather than a static relative import: the file sits outside
// this Nx project, so a relative import is an edge the project graph cannot see.
const { thresholds } = createRequire(import.meta.url)("../../../${COVERAGE_CONFIG_FILE}");

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Reserved seam, both halves: a fresh scaffold ships no tests, so the
    // affected gate must stay green against none, and a floor measured against
    // none would fail on the first commit. Delete the empty-suite flag and turn
    // coverage on once real tests land — \`check-project-conventions\` requires
    // exactly that from the first test file, so neither half can be forgotten.
    ${VITEST_EMPTY_SUITE_FLAG}: true,
    coverage: {
      provider: "v8",
      enabled: false,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds,
    },
  },
});
`;

// pytest exits 5 ("no tests collected") where vitest has `passWithNoTests` and
// `go test`/`cargo test` simply exit 0 — so without this hook a fresh Python
// scaffold's `test` target is red from its first commit. Same reserved seam as
// the vitest flag above, expressed the only portable way pytest offers (there
// is no equivalent CLI flag or ini option); it maps ONLY the empty-collection
// code, so a real failure still fails. Exported because
// `check-project-conventions` greps for this sentinel to enforce the mask's
// removal once real tests land — one spelling, two consumers (Rule 14).
export const PYTEST_EMPTY_SUITE_MASK = "pytest.ExitCode.NO_TESTS_COLLECTED";

const PYTEST_CONFTEST = `"""Pytest session hooks for this project."""

import pytest


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Keep an empty suite green; remove once real tests land."""
    if exitstatus == ${PYTEST_EMPTY_SUITE_MASK}:
        session.exitstatus = pytest.ExitCode.OK
`;

/**
 * Per-language prose for the README stubs. Only the words live here — the nav
 * line, the variant filenames, and the section markers are imported from
 * `readme-schema.mjs`, the same module `check-subproject-readmes` audits
 * against, so a stub can never be born failing its own gate (Rule 14). The
 * headings are keyed BY MARKER rather than positionally: add a marker to the
 * shared schema and this throws loudly instead of silently mis-titling.
 */
const README_PROSE = {
  en: {
    description: (name) => `TODO: replace with one line on what ${name} is and why it exists.`,
    headings: {
      "<!-- readme:why -->": "Why it exists",
      "<!-- readme:consumers -->": "Who consumes it",
      "<!-- readme:ecosystem -->": "Where it sits",
      "<!-- readme:boundary -->": "What it deliberately does not do",
      "<!-- readme:status -->": "Status",
    },
    body: "TODO: replace this section before calling the scaffold done.",
    status: (name) =>
      `TODO: state whether ${name} is live, scaffolded, or a reserved seam. Directory-scoped mechanics live in [\`./CLAUDE.md\`](./CLAUDE.md).`,
  },
  vi: {
    description: (name) => `TODO: thay bằng một dòng mô tả ${name} là gì và vì sao nó tồn tại.`,
    headings: {
      "<!-- readme:why -->": "Tại sao nó tồn tại",
      "<!-- readme:consumers -->": "Ai đang consume nó",
      "<!-- readme:ecosystem -->": "Vị trí trong hệ sinh thái",
      "<!-- readme:boundary -->": "Nó cố ý không làm gì",
      "<!-- readme:status -->": "Trạng thái",
    },
    body: "TODO: thay phần này trước khi coi là scaffold xong.",
    status: (name) =>
      `TODO: nêu rõ ${name} đang hoạt động, mới scaffold, hay là một seam để dành. Cơ chế theo thư mục nằm ở [\`./CLAUDE.md\`](./CLAUDE.md).`,
  },
  zh: {
    description: (name) => `TODO: 替换为一句话说明 ${name} 是什么以及为何存在。`,
    headings: {
      "<!-- readme:why -->": "为什么存在",
      "<!-- readme:consumers -->": "谁在使用它",
      "<!-- readme:ecosystem -->": "它在生态中的位置",
      "<!-- readme:boundary -->": "它刻意不做的事",
      "<!-- readme:status -->": "状态",
    },
    body: "TODO: 在认为脚手架完成之前替换本节。",
    status: (name) =>
      `TODO: 说明 ${name} 是已投入使用、刚脚手架生成，还是预留的接缝。目录级机制见 [\`./CLAUDE.md\`](./CLAUDE.md)。`,
  },
};

const readmeStub = (name, subsystem, lang) => {
  const prose = README_PROSE[lang];
  const sections = SUBPROJECT_SECTIONS.map((marker) => {
    const heading = prose.headings[marker];
    if (!heading) {
      throw new Error(
        `scaffold-lib: no ${lang} heading for section marker ${marker} — add one to README_PROSE`,
      );
    }
    const body = marker === "<!-- readme:status -->" ? prose.status(name) : prose.body;
    return `${marker}\n\n## ${heading}\n\n${body}\n`;
  }).join("\n");

  return `---
name: ${name}
subsystem: ${subsystem}
lang: ${lang}
description: ${prose.description(name)}
---

${expectedNavLine(lang)}

# ${name}

${sections}`;
};

const claudeMdStub = (name, root, subsystem, layer, identityLine) => {
  const tags = ["`type:lib`", `\`scope:${subsystem}\``, ...(layer ? [`\`layer:${layer}\``] : [])];
  return `# ${name} (\`${root}\`)

Directory-scoped mechanics only — principles live in the root \`CLAUDE.md\`. Nx project name \`${name}\`; ${identityLine} (tags ${tags.join(", ")}).

- Role: TODO — one line on what this lib is and why it is its own project.
- TODO: record only the invariants/footguns reading the code does not reveal (root \`CLAUDE.md\` → Documentation); replace this stub before calling the scaffold done.
`;
};

/**
 * Per-language emitters. Each returns { identityLine, targets, files } where
 * `files` maps project-relative path → content. Workspace-level bootstrap
 * (go.work, root manifests, .gitignore) is handled separately.
 */
const EMITTERS = {
  ts(name, _subsystem, root) {
    return {
      identityLine: `import alias \`@ecoma-io/${name}\``,
      targets: {
        typecheck: "tsc --noEmit",
        lint: `eslint . --max-warnings 0 && ${DEV_CLI} check-journey-markers .`,
        test: "vitest run",
      },
      files: {
        "package.json": `${packageJson(name, root)}\n`,
        "tsconfig.json": `${tsconfigJson}\n`,
        "vitest.config.ts": vitestConfig,
        "src/index.ts": "export {};\n",
      },
    };
  },
  go(name, subsystem, _root, goVersion) {
    const modulePath = `ecoma.io/${subsystem}/${name}`;
    const pkg = name.replace(/-/g, "");
    return {
      identityLine: `Go module \`${modulePath}\``,
      targets: {
        typecheck: "go vet ./...",
        lint: `${DEV_CLI} check-gofmt && golangci-lint run && ${PROJECT_JSON_LINT} && ${DEV_CLI} check-journey-markers .`,
        test: "go test ./...",
        build: "go build ./...",
      },
      files: {
        "go.mod": `module ${modulePath}\n\ngo ${goVersion}\n`,
        "doc.go": `// Package ${pkg} is a TODO: replace with what this package is.\npackage ${pkg}\n`,
      },
    };
  },
  rust(name) {
    return {
      identityLine: `crate \`${name}\``,
      targets: {
        typecheck: "cargo check --all-targets",
        lint: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && ${PROJECT_JSON_LINT} && ${DEV_CLI} check-journey-markers .`,
        test: "cargo test",
        build: "cargo build",
      },
      files: {
        "Cargo.toml": `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2024"\n`,
        "src/lib.rs": `//! TODO: one line on what ${name} is.\n`,
      },
    };
  },
  python(name) {
    const moduleDir = name.replace(/-/g, "_");
    return {
      identityLine: `package \`${name}\``,
      targets: {
        typecheck: "uv run pyright",
        lint: `uv run ruff check . && uv run ruff format --check . && ${PROJECT_JSON_LINT} && ${DEV_CLI} check-journey-markers .`,
        test: "uv run pytest",
      },
      files: {
        "pyproject.toml": [
          "[project]",
          `name = "${name}"`,
          'version = "0.1.0"',
          'requires-python = ">=3.12"',
          "dependencies = []",
          "",
          "[dependency-groups]",
          'dev = ["pytest>=8", "ruff>=0.15", "pyright>=1.1"]',
          "",
          "# Tests are co-located inside src/ (root CLAUDE.md test taxonomy), and",
          "# uv_build otherwise ships every file under the module root — verified:",
          "# without these two, `uv build` puts *_test.py in both the wheel and the",
          "# sdist. The pairing belongs with the convention that creates it, not with",
          "# whichever future commit first adds a packaging target.",
          "[tool.uv.build-backend]",
          'source-exclude = ["**/*_test.py"]',
          'wheel-exclude = ["**/*_test.py"]',
          "",
          "[build-system]",
          'requires = ["uv_build>=0.8,<0.9"]',
          'build-backend = "uv_build"',
          "",
        ].join("\n"),
        [`src/${moduleDir}/__init__.py`]: `"""TODO: one line on what ${name} is."""\n`,
        "conftest.py": PYTEST_CONFTEST,
      },
    };
  },
};

/** Adds the alias to the parsed tsconfig text; throws if it already exists. */
export function withAlias(tsconfigText, alias, target) {
  const config = JSON.parse(tsconfigText);
  const paths = (config.compilerOptions ??= {}).paths ?? {};
  if (alias in paths) throw new Error(`alias '${alias}' already exists in tsconfig.base.json`);
  config.compilerOptions.paths = { ...paths, [alias]: [target] };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Go version to stamp into a scaffolded go.mod, derived from the repo-root
 * go.work's own `go X.Y.Z` line so it can never drift from the pin CI and
 * CONTRIBUTING.md already read (Rule 14) — `text` is `null` only on the day
 * go.work does not exist yet, which falls back to `FALLBACK_GO_VERSION`.
 */
export function deriveGoVersion(text) {
  if (text === null) return FALLBACK_GO_VERSION;
  const match = text.match(/^go (\d+\.\d+(?:\.\d+)?)/m);
  if (!match) throw new Error("go.work has no `go X.Y.Z` line to derive the Go version from");
  return match[1];
}

/** go.work with `root` added to the use block (created when text is null). */
export function withGoWorkUse(text, root, goVersion = FALLBACK_GO_VERSION) {
  if (text === null) return `go ${goVersion}\n\nuse (\n\t./${root}\n)\n`;
  if (new RegExp(`\\./${root}\\r?\\n`).test(text) || text.includes(`./${root})`)) return text;
  const block = text.match(/use\s*\(([\s\S]*?)\)/);
  if (block) return text.replace(block[0], `use (${block[1]}\t./${root}\n)`);
  return `${text.trimEnd()}\n\nuse (\n\t./${root}\n)\n`;
}

/**
 * Root workspace `Cargo.toml` with `root` in `[workspace].members` (created
 * when text is null). Throws when a root Cargo.toml exists without a
 * `[workspace]` table — that layout decision is the caller's to resolve.
 */
export function withCargoMember(text, root) {
  if (text === null) return `[workspace]\nresolver = "3"\nmembers = ["${root}"]\n`;
  if (text.includes(`"${root}"`)) return text;
  if (!/^\s*\[workspace\]/m.test(text)) {
    throw new Error("root Cargo.toml exists but has no [workspace] table — add one, then rerun");
  }
  const members = text.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!members)
    throw new Error("root Cargo.toml [workspace] has no members array — add one, then rerun");
  const list = members[1].trim();
  const rewritten = list === "" ? `["${root}"]` : `[${members[1].trimEnd()}, "${root}"]`;
  return text.replace(members[0], `members = ${rewritten}`);
}

/**
 * Root `pyproject.toml` with `root` in `[tool.uv.workspace].members`
 * (created when text is null). Throws when it exists without that table.
 */
export function withUvMember(text, root) {
  if (text === null) return `[tool.uv.workspace]\nmembers = ["${root}"]\n`;
  if (text.includes(`"${root}"`)) return text;
  if (!/^\s*\[tool\.uv\.workspace\]/m.test(text)) {
    throw new Error(
      "root pyproject.toml exists but has no [tool.uv.workspace] table — add one, then rerun",
    );
  }
  const members = text.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!members) {
    throw new Error(
      "root pyproject.toml [tool.uv.workspace] has no members array — add one, then rerun",
    );
  }
  const list = members[1].trim();
  const rewritten = list === "" ? `["${root}"]` : `[${members[1].trimEnd()}, "${root}"]`;
  return text.replace(members[0], `members = ${rewritten}`);
}

/** .gitignore text with each missing line appended (idempotent). */
export function withGitignoreLines(text, lines) {
  const present = new Set((text ?? "").split(/\r?\n/));
  const missing = lines.filter((l) => !present.has(l));
  if (missing.length === 0) return text ?? "";
  return `${(text ?? "").trimEnd()}\n${missing.join("\n")}\n`;
}

/**
 * Workspace-level bootstrap edits per language: [path, transform(text|null)].
 * Read-modify-write happens in `scaffoldLib` so everything stays fs-injectable.
 */
const BOOTSTRAPS = {
  ts: () => [],
  go: (root, goVersion) => [["go.work", (text) => withGoWorkUse(text, root, goVersion)]],
  rust: (root) => [
    ["Cargo.toml", (text) => withCargoMember(text, root)],
    [".gitignore", (text) => withGitignoreLines(text, ["target/"])],
  ],
  python: (root) => [
    ["pyproject.toml", (text) => withUvMember(text, root)],
    [".gitignore", (text) => withGitignoreLines(text, [".venv/"])],
  ],
};

/**
 * CLI entry. Returns a process exit code; `fs` is injectable for tests.
 * `listPaths` overrides the tracked-paths source `--subsystem` is checked
 * against — real callers never pass it; tests inject a fixed file list.
 */
export function scaffoldLib(args = [], fs = nodeFs, listPaths = listTrackedPaths) {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flag = (f) => {
    const i = args.indexOf(f);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const [name] = positional;
  const subsystem = flag("--subsystem");
  const layer = flag("--layer");
  const lang = flag("--lang") ?? "ts";

  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(
      `usage: scaffold-lib <name> --subsystem <subsystem> [--lang <${[...LANGS].join("|")}>] [--layer <l>]\n  name must be kebab-case ('${name ?? ""}' is not)`,
    );
    return 2;
  }
  const subsystems = deriveSubsystemRoots(listPaths());
  const usage = `usage: scaffold-lib <name> --subsystem <${subsystems.join("|")}> [--lang <${[...LANGS].join("|")}>] [--layer <l>]`;
  if (!subsystem || !subsystems.includes(subsystem)) {
    console.error(
      `${usage}\n  --subsystem must be an existing top-level subsystem: ${subsystems.join(", ")} (got "${subsystem ?? ""}")`,
    );
    return 2;
  }
  if (!LANGS.has(lang)) {
    console.error(`${usage}\n  --lang must be one of: ${[...LANGS].join(", ")}`);
    return 2;
  }
  if (layer !== undefined && !LAYERS.has(layer)) {
    console.error(`${usage}\n  --layer must be one of: ${[...LAYERS].join(", ")}`);
    return 2;
  }

  const root = `${subsystem}/libs/${name}`;
  if (fs.existsSync(root)) {
    console.error(`${root} already exists — scaffold-lib never overwrites`);
    return 1;
  }

  const readOrNull = (path) => (fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null);

  // Compute every write before performing any (all-or-nothing on validation).
  const rootWrites = [];
  let goVersion;
  try {
    if (lang === "ts") {
      rootWrites.push([
        "tsconfig.base.json",
        withAlias(
          fs.readFileSync("tsconfig.base.json", "utf8"),
          `@ecoma-io/${name}`,
          `${root}/src/index.ts`,
        ),
      ]);
    }
    if (lang === "go") {
      goVersion = deriveGoVersion(readOrNull("go.work"));
    }
    for (const [path, transform] of BOOTSTRAPS[lang](root, goVersion)) {
      rootWrites.push([path, transform(readOrNull(path))]);
    }
  } catch (error) {
    console.error(String(error.message ?? error));
    return 1;
  }

  const { identityLine, targets, files } = EMITTERS[lang](name, subsystem, root, goVersion);
  fs.mkdirSync(`${root}/src`, { recursive: true });
  fs.writeFileSync(
    `${root}/project.json`,
    `${projectJson(name, root, subsystem, layer, targets)}\n`,
  );
  fs.writeFileSync(`${root}/CLAUDE.md`, claudeMdStub(name, root, subsystem, layer, identityLine));
  for (const lang of README_LANGS) {
    fs.writeFileSync(`${root}/${readmeFilename(lang)}`, readmeStub(name, subsystem, lang));
  }
  for (const [rel, content] of Object.entries(files)) {
    const dir = `${root}/${rel}`.split("/").slice(0, -1).join("/");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, content);
  }
  for (const [path, content] of rootWrites) {
    fs.writeFileSync(path, content);
  }

  console.log(`scaffolded ${root} (${lang}${lang === "ts" ? `, alias @ecoma-io/${name}` : ""})`);
  console.log("next: replace the CLAUDE.md TODOs, then stage the scaffold and verify with");
  // check-project-conventions discovers projects from TRACKED project.json
  // files (git ls-files), so an unstaged scaffold reports its own alias as
  // pointing outside every project — staging first is what makes this
  // sequence actually pass when followed verbatim, not a nice-to-have.
  console.log(`  git add ${root}`);
  console.log("  node shared/tools/dev-cli/src/main.mjs check-project-conventions");
  console.log(`  pnpm nx run ${name}:lint`);
  return 0;
}
