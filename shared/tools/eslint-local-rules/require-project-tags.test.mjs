import { RuleTester } from "eslint";
import * as jsoncParser from "jsonc-eslint-parser";

import rule from "./require-project-tags.mjs";

const ruleTester = new RuleTester({
  languageOptions: { parser: jsoncParser },
});

const project = (tags) => JSON.stringify({ name: "x", tags });

ruleTester.run("require-project-tags", rule, {
  valid: [
    project(["type:app", "scope:shared", "license:sul"]),
    project(["type:lib", "scope:shared", "license:sul", "layer:view"]),
    project(["scope:shared", "license:sul", "type:app"]), // order-independent
    project(["type:e2e", "scope:shared", "license:sul"]), // e2e project drives a built app
    project(["type:lib", "scope:platform", "license:sul", "layer:domain"]),
    // A suite carries a `gate:` tag, which this rule does not inspect — only the
    // conformance executor reads that axis. What matters here is that the extra
    // tag does not make an otherwise well-tagged project fail.
    project(["type:lib", "scope:platform", "license:sul", "gate:G0"]),
    project(["type:lib", "scope:shared", "license:sul", "layer:domain"]),
    project(["type:lib", "scope:shared", "license:sul", "layer:port"]),
    project(["type:lib", "scope:shared", "license:sul", "layer:adapter"]),
    project(["type:lib", "scope:shared", "license:sul", "layer:app"]), // application-service
    // The other three licence values are legal vocabulary before any project
    // carries them: `check-project-conventions` derives the required tag from a
    // project's directory, so a carve-out directory's first project must be able
    // to declare the tag that gate demands.
    project(["type:lib", "scope:shared", "license:apache"]),
    project(["type:lib", "scope:shared", "license:ee"]),
    project(["type:app", "scope:shared", "license:proprietary"]),
  ],
  invalid: [
    { code: JSON.stringify({ name: "x" }), errors: [{ messageId: "noTags" }] },
    {
      code: project([]),
      errors: [
        { messageId: "typeCount" },
        { messageId: "scopeCount" },
        { messageId: "licenseCount" },
      ],
    },
    { code: project(["scope:shared", "license:sul"]), errors: [{ messageId: "typeCount" }] },
    { code: project(["type:lib", "license:sul"]), errors: [{ messageId: "scopeCount" }] },
    {
      code: project(["type:app", "type:lib", "scope:shared", "license:sul"]),
      errors: [{ messageId: "typeCount" }],
    },
    {
      code: project(["type:widget", "scope:shared", "license:sul"]),
      errors: [{ messageId: "badType" }],
    },
    // A scope outside the vocabulary matches no depConstraint — the
    // silent-escape this rule closes.
    {
      code: project(["type:app", "scope:acme", "license:sul"]),
      errors: [{ messageId: "badScope" }],
    },
    {
      // Same silent-escape, on the layer axis: a misspelled layer matches no depConstraint.
      code: project(["type:lib", "scope:shared", "license:sul", "layer:domian"]),
      errors: [{ messageId: "badLayer" }],
    },
    {
      code: project(["type:lib", "scope:shared", "license:sul", "layer:domain", "layer:view"]),
      errors: [{ messageId: "layerCount" }],
    },
    {
      // The surface axis is empty, so every surface tag is unknown — including
      // the one it used to hold. This case is what keeps an emptied axis honest:
      // were a value re-added without a depConstraint naming it, this stops failing.
      code: project(["type:lib", "scope:shared", "license:sul", "surface:sdk"]),
      errors: [{ messageId: "badSurface" }],
    },
    {
      code: project(["type:lib", "scope:shared", "license:sul", "surface:sdk", "surface:sdk"]),
      errors: [{ messageId: "surfaceCount" }],
    },
    {
      // A scope outside the vocabulary is rejected whether or not the workspace
      // one day grows that area — the vocabulary describes what exists now, and
      // `rpa` is named by the doctrine as a future area with no project yet.
      code: project(["type:lib", "scope:rpa", "license:sul"]),
      errors: [{ messageId: "badScope" }],
    },
    {
      // An untagged licence is how a file ends up shipping under terms nobody
      // chose: the tag is what `check-project-conventions` compares against the
      // directory, so its absence disables that comparison silently.
      code: project(["type:lib", "scope:shared"]),
      errors: [{ messageId: "licenseCount" }],
    },
    {
      code: project(["type:lib", "scope:shared", "license:sul", "license:ee"]),
      errors: [{ messageId: "licenseCount" }],
    },
    {
      // A misspelled licence matches no depConstraint, so `license:sul` code
      // could import it with the one-way EE boundary never firing.
      code: project(["type:lib", "scope:shared", "license:enterprise"]),
      errors: [{ messageId: "badLicense" }],
    },
  ],
});

console.log("require-project-tags: all cases passed");
