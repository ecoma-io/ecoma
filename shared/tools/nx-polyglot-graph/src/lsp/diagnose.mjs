/**
 * One document in, the diagnostics an editor should show for it out.
 *
 * ## The single invariant this module exists to hold
 *
 * **An empty diagnostic list must mean "no violation", and nothing else.**
 *
 * An editor draws no marker for a file whose diagnostics are `[]`, and a
 * developer reads no marker as "checked, clean". So every way this pipeline can
 * fail to reach a verdict has to end in a diagnostic instead of in an empty
 * list: a config that will not load, a workspace index that cannot be built, a
 * language whose analyzer does not exist yet, an analyzer that threw, a rule
 * engine that threw, a parse failure the analyzer recorded as data.
 *
 * The return type is what makes that checkable rather than merely intended.
 * `analyzed` is `true` on exactly ONE path — the one where the analyzer
 * returned and the rule engine returned — and the caller is expected to refuse
 * to publish an empty list unless it is `true`. Two guards for one invariant is
 * deliberate: this module makes the promise, and `./server.mjs` verifies it
 * before the bytes leave the process.
 *
 * ## The one empty-and-clean case, stated so it is not mistaken for a hole
 *
 * A file whose extension no analyzer claims — `README.md`, `project.json`, an
 * `.svg` — returns `analyzed: true` with no diagnostics. That is the analysis
 * contract's own answer ("an unknown extension is a no-op, not an error"), and
 * it is a real verdict: a file with no imports this tool can see crosses no
 * boundary. The same is true of a file inside no project, which the rule engine
 * places outside the boundary system entirely.
 */
import { analyzeFile } from "../analysis/analyze.mjs";
import { evaluate } from "../rules/index.mjs";

import {
  analysisFailedDiagnostic,
  documentLines,
  failureDiagnostic,
  violationDiagnostic,
} from "./diagnostics.mjs";

/**
 * The diagnostics for one document, and whether a verdict was actually reached.
 *
 * @param {object} request
 * @param {string} request.sourceFile Workspace-relative path of the document.
 * @param {string} request.text Its current contents — the editor's buffer, not
 *   what is on disk. Diagnosing the saved file would answer a question nobody
 *   asked while the developer is looking at their unsaved edit.
 * @param {{workspace: object, graph: object}} request.index From
 *   `./workspace-index.mjs`.
 * @param {{depConstraints: object[], options: object}} request.config
 * @returns {{analyzed: boolean, diagnostics: object[]}} `analyzed: false`
 *   always comes with at least one diagnostic.
 */
export function diagnoseDocument({ sourceFile, text, index, config }) {
  const lines = documentLines(text);

  let analysis;
  try {
    analysis = analyzeFile({ sourceFile, text, workspace: index.workspace });
  } catch (cause) {
    // The dispatcher throws for a language its extension table claims and no
    // analyzer implements. That is the scaffold staying loud, and it must stay
    // loud here too rather than becoming a green file.
    return { analyzed: false, diagnostics: [analysisFailedDiagnostic(reasonOf(cause), lines)] };
  }

  // Recorded failures come first, and they are published whether or not the
  // rule pass below succeeds: they are the part of the file that was NOT
  // judged, and a reader needs that before they read what was.
  const diagnostics = analysis.failures.map((failure) => failureDiagnostic(failure, lines));

  let violations;
  try {
    violations = evaluate(analysis.imports, index.graph, config);
  } catch (cause) {
    diagnostics.push(analysisFailedDiagnostic(reasonOf(cause), lines));
    return { analyzed: false, diagnostics };
  }

  for (const violation of violations) {
    // The engine is handed only this document's import sites, so every
    // violation it returns is already about this document. Filtering again
    // would hide a bug rather than prevent one, so the assertion is the shape:
    // anything else here means the engine and this caller disagree about which
    // file they are discussing.
    if (violation.sourceFile !== sourceFile) {
      diagnostics.push(
        analysisFailedDiagnostic(
          `the rule engine returned a violation for '${violation.sourceFile}' while judging ` +
            `'${sourceFile}'; the verdict for this file cannot be trusted`,
          lines,
        ),
      );
      return { analyzed: false, diagnostics };
    }
    diagnostics.push(violationDiagnostic(violation, lines));
  }

  return { analyzed: true, diagnostics };
}

/** An Error's message, or whatever was thrown, as text a reader can act on. */
const reasonOf = (cause) => cause?.message ?? String(cause);
