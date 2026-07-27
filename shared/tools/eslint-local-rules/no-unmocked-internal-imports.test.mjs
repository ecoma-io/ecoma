import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import rule from "./no-unmocked-internal-imports.mjs";

// TypeScript parser: the test cases use TS-only syntax (`import type`), and the
// rule reads `importKind`, which only the TS parser sets.
const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: "module" },
});

const unit = (code) => ({ code, filename: "Widget.test.ts" });

ruleTester.run("no-unmocked-internal-imports", rule, {
  valid: [
    // SUT, test infra, node builtins, third-party — all fine.
    unit('import Widget from "./Widget.vue";\nimport { it } from "vitest";'),
    unit('import Widget from "./Widget";\nimport { mount } from "@vue/test-utils";'),
    unit('import { readFile } from "node:fs";\nimport Widget from "./Widget";'),
    unit('import _ from "lodash";\nimport Widget from "./Widget";'), // third-party not enforced
    // Internal collaborator, but mocked.
    unit(
      'import { helper } from "./helper";\nvi.mock("./helper");\nimport Widget from "./Widget";',
    ),
    unit('import { api } from "@ecoma-io/core-app";\nvi.mock("@ecoma-io/core-app");'),
    // Type-only and asset imports carry no runtime behaviour.
    unit('import type { Foo } from "./foo";'),
    unit('import "./styles.css";'),
    unit('import data from "./fixtures/sample.json";'),
    unit('import { render } from "./__mocks__/render";'),
  ],
  invalid: [
    {
      ...unit('import { helper } from "./helper";'),
      errors: [{ messageId: "unmockedImport" }],
    },
    {
      ...unit('import { TitleBar } from "@ecoma-io/ui";\nimport Widget from "./Widget.vue";'),
      errors: [{ messageId: "unmockedImport" }],
    },
    {
      // A sibling module that happens to share no name with the SUT.
      ...unit('import { other } from "../other/Thing";'),
      errors: [{ messageId: "unmockedImport" }],
    },
  ],
});

console.log("no-unmocked-internal-imports: all cases passed");
