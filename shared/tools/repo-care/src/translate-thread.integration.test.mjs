import { describe, expect, it } from "vitest";

import { buildClaNoticeComment, CLA_NOTICE_MARKER } from "./cla-notice.mjs";
import { buildReviewComment, REVIEW_MARKER } from "./review-pr.mjs";
import { buildTranslationComment, TRANSLATE_MARKER } from "./translate-thread.mjs";
import { buildNeedsInfoComment, TRIAGE_MARKER } from "./triage-issue.mjs";

/**
 * Four repo-care commands now comment on the same thread, each editing its
 * own comment in place across re-runs. That only holds while the real
 * markers stay mutually unmistakable — a property of the modules TOGETHER, so
 * it is pinned here with the real collaborators rather than in any one
 * module's unit test. A collision does not fail a build: it silently
 * overwrites another job's comment on a live issue.
 */
const MARKERS = {
  triage: TRIAGE_MARKER,
  review: REVIEW_MARKER,
  translate: TRANSLATE_MARKER,
  claNotice: CLA_NOTICE_MARKER,
};

describe("repo-care thread comment markers", () => {
  it("are pairwise distinct", () => {
    const values = Object.values(MARKERS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("never contain one another, so a substring match cannot cross jobs", () => {
    for (const [aName, a] of Object.entries(MARKERS)) {
      for (const [bName, b] of Object.entries(MARKERS)) {
        if (aName === bName) continue;
        expect(`${aName} contains ${bName}: ${a.includes(b)}`).toBe(
          `${aName} contains ${bName}: false`,
        );
      }
    }
  });

  it("each open their own comment body, which is what makes a startsWith lookup exact", () => {
    const bodies = {
      triage: buildNeedsInfoComment(["repro steps"]),
      review: buildReviewComment([], ["model-a"], { truncated: false }),
      translate: buildTranslationComment("en", [
        { lang: "vi", title: "Tiêu đề", body: "Nội dung" },
      ]),
      claNotice: buildClaNoticeComment({
        author: "someone",
        repo: "owner/repo",
        gateOutput: "contributors/someone.md: missing",
      }),
    };
    for (const [name, body] of Object.entries(bodies)) {
      expect(body.startsWith(MARKERS[name])).toBe(true);
      // And no other job's lookup can claim it.
      for (const [other, marker] of Object.entries(MARKERS)) {
        if (other !== name) expect(body.startsWith(marker)).toBe(false);
      }
    }
  });
});
