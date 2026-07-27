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
    project(["type:lib", "scope:connectors", "layer:domain"]),
    project(["type:lib", "scope:connectors", "layer:port", "surface:sdk"]), // cross-scope contract lib
    project(["type:lib", "scope:connectors", "layer:adapter"]), // a connector
    project(["type:lib", "scope:connectors", "layer:app"]), // application-service
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
      // A misspelled surface tag matches no depConstraint — same silent escape.
      code: project(["type:lib", "scope:connectors", "surface:skd"]),
      errors: [{ messageId: "badSurface" }],
    },
    {
      code: project(["type:lib", "scope:connectors", "surface:sdk", "surface:sdk"]),
      errors: [{ messageId: "surfaceCount" }],
    },
  ],
});

console.log("require-project-tags: all cases passed");
