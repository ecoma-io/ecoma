import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import rule from "./no-journey-marker-names.mjs";

// TypeScript parser: exported names are also coined by TS-only declarations
// (interface, type alias, enum), which espree cannot parse.
const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: "module" },
});

ruleTester.run("no-journey-marker-names", rule, {
  valid: [
    // Word-boundary discipline: token substrings inside a longer word never match.
    'export const renewal = "subscription renewal";',
    'export const stepId = "s1";',
    "export function assignStepIds() {}",
    "export const uuidv4 = () => {};",
    'export const template = "tray";',
    // Leading new/temp describe end-state behavior (creates a new X, holds temp files).
    "export class NewWorkflowModal {}",
    'export const newValue = "the value after the change";',
    "export function createTempDir() {}",
    // step/phase without an ordinal are domain vocabulary, not journey markers.
    "export interface StepConfig { id: string }",
    "export type ProcessStep = { kind: string };",
    "export const CHECKPOINT_STEP_OUTCOMES = [];",
    "export enum PhaseKind {}",
    // Only declarations are checked, never usages or non-exported locals.
    "const fooV2 = 1;\nexport const foo = fooV2;",
    "export function run() { const tmpV2 = 1; return tmpV2; }",
    // A year alone is not a date marker (es2022-style names stay legal).
    "export const es2022 = true;",
    // Anonymous default exports coin no durable name.
    "export default function () {}",
    'export * from "./mod";',
  ],
  invalid: [
    // Version suffix — the canonical conflict-averaging smell (createWorkflowV2).
    { code: "export const handleAuthV2 = 1;", errors: [{ messageId: "journeyName" }] },
    { code: "export function createWorkflowV2() {}", errors: [{ messageId: "journeyName" }] },
    { code: "export interface WorkflowV2 {}", errors: [{ messageId: "journeyName" }] },
    { code: "export type RenderJobV3 = {};", errors: [{ messageId: "journeyName" }] },
    // wip anywhere in the name.
    { code: "export class WipParser {}", errors: [{ messageId: "journeyName" }] },
    { code: "export const WIP_NOTES = [];", errors: [{ messageId: "journeyName" }] },
    // Trailing new/old/temp qualifiers (the utils-new sibling pattern).
    { code: "export const utilsNew = {};", errors: [{ messageId: "journeyName" }] },
    { code: "export function migrateConfigOld() {}", errors: [{ messageId: "journeyName" }] },
    { code: "export const parserTemp = {};", errors: [{ messageId: "journeyName" }] },
    // Phase/sprint/step ordinals.
    { code: "export const phase2Rollout = 1;", errors: [{ messageId: "journeyName" }] },
    { code: "export function step1() {}", errors: [{ messageId: "journeyName" }] },
    { code: "export const SPRINT_3_BACKLOG = [];", errors: [{ messageId: "journeyName" }] },
    // Ticket IDs and dates.
    { code: "export const fixIssue52 = () => {};", errors: [{ messageId: "journeyName" }] },
    { code: "export const snapshot_2025_01_31 = [];", errors: [{ messageId: "journeyName" }] },
    // Named default export, re-export specifiers, namespace re-exports,
    // destructured exports — every way a durable public name is coined.
    { code: "export default function buildV2() {}", errors: [{ messageId: "journeyName" }] },
    {
      code: 'export { legalName as reportV2 } from "./mod";',
      errors: [{ messageId: "journeyName" }],
    },
    { code: 'export * as v2 from "./mod";', errors: [{ messageId: "journeyName" }] },
    { code: "export const { parserV2 } = pack;", errors: [{ messageId: "journeyName" }] },
    { code: "export const [first, restV2] = pair;", errors: [{ messageId: "journeyName" }] },
  ],
});

console.log("no-journey-marker-names: all cases passed");
