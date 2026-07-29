import { RuleTester } from "eslint";
import * as jsoncParser from "jsonc-eslint-parser";

import rule from "./require-project-tags.mjs";

const ruleTester = new RuleTester({
  languageOptions: { parser: jsoncParser },
});

const project = (tags) => JSON.stringify({ name: "x", tags });

ruleTester.run("require-project-tags", rule, {
  valid: [
    project(["type:app", "scope:shared"]),
    project(["type:lib", "scope:shared", "layer:view"]),
    project(["scope:shared", "type:app"]), // order-independent
    project(["type:e2e", "scope:shared"]), // e2e project drives a built app
    project(["type:lib", "scope:shared", "layer:domain"]),
    project(["type:lib", "scope:shared", "layer:port"]),
    project(["type:lib", "scope:shared", "layer:adapter"]),
    project(["type:lib", "scope:shared", "layer:app"]), // application-service
  ],
  invalid: [
    { code: JSON.stringify({ name: "x" }), errors: [{ messageId: "noTags" }] },
    { code: project([]), errors: [{ messageId: "typeCount" }, { messageId: "scopeCount" }] },
    { code: project(["scope:shared"]), errors: [{ messageId: "typeCount" }] },
    { code: project(["type:lib"]), errors: [{ messageId: "scopeCount" }] },
    {
      code: project(["type:app", "type:lib", "scope:shared"]),
      errors: [{ messageId: "typeCount" }],
    },
    { code: project(["type:widget", "scope:shared"]), errors: [{ messageId: "badType" }] },
    // A scope outside the vocabulary matches no depConstraint — the
    // silent-escape this rule closes.
    { code: project(["type:app", "scope:acme"]), errors: [{ messageId: "badScope" }] },
    {
      // Same silent-escape, on the layer axis: a misspelled layer matches no depConstraint.
      code: project(["type:lib", "scope:shared", "layer:domian"]),
      errors: [{ messageId: "badLayer" }],
    },
    {
      code: project(["type:lib", "scope:shared", "layer:domain", "layer:view"]),
      errors: [{ messageId: "layerCount" }],
    },
    {
      // The surface axis is empty, so every surface tag is unknown — including
      // the one it used to hold. This case is what keeps an emptied axis honest:
      // were a value re-added without a depConstraint naming it, this stops failing.
      code: project(["type:lib", "scope:shared", "surface:sdk"]),
      errors: [{ messageId: "badSurface" }],
    },
    {
      code: project(["type:lib", "scope:shared", "surface:sdk", "surface:sdk"]),
      errors: [{ messageId: "surfaceCount" }],
    },
    {
      // A scope outside the vocabulary is rejected whether or not the workspace
      // one day grows that area — the vocabulary describes what exists now.
      code: project(["type:lib", "scope:platform"]),
      errors: [{ messageId: "badScope" }],
    },
  ],
});

console.log("require-project-tags: all cases passed");
