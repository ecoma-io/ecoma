import { describe, expect, it } from "vitest";
import { findComponentsWithoutStories } from "./check-e2e-story-coverage.mjs";

const componentFiles = (dir, name, extras = []) => [
  `${dir}/${name}/${name}.vue`,
  ...extras.map((file) => `${dir}/${name}/${file}`),
];

describe("findComponentsWithoutStories", () => {
  it("flags a component whose directory ships no story", () => {
    const violations = findComponentsWithoutStories(
      componentFiles("shared/libs/core-ui/src/blocks", "EmptyState", ["EmptyStateDemo.vue"]),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("shared/libs/core-ui/src/blocks/EmptyState");
    expect(violations[0]).toContain("EmptyState.stories.ts");
  });

  it("accepts a component that ships a story", () => {
    expect(
      findComponentsWithoutStories(
        componentFiles("shared/libs/core-ui/src/primitives", "Button", ["Button.stories.ts"]),
      ),
    ).toEqual([]);
  });

  it("holds blocks to the same rule as primitives", () => {
    const violations = findComponentsWithoutStories([
      ...componentFiles("shared/libs/core-ui/src/primitives", "Badge", ["Badge.stories.ts"]),
      ...componentFiles("shared/libs/core-ui/src/blocks", "PageHeader"),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("blocks/PageHeader");
  });

  it("covers a component category the repo has not invented yet", () => {
    // The rule reads the tree, so it must not depend on a `primitives`/`blocks`
    // list — a third category is held the day someone adds it.
    const violations = findComponentsWithoutStories(
      componentFiles("shared/libs/core-ui/src/patterns", "Wizard"),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("src/patterns/Wizard");
  });

  it("ignores a demo or gallery SFC that is not the directory's own component", () => {
    // MotionGallery.vue lives in `_demo/`, so its name never matches its
    // directory — it is demo scaffolding, not a component the library ships.
    expect(
      findComponentsWithoutStories([
        "shared/libs/core-ui/docs/design/_demo/MotionGallery.vue",
        "shared/libs/core-ui/docs/design/_demo/SignatureGallery.vue",
        "shared/apps/design-system/.storybook/PreviewSurface.vue",
      ]),
    ).toEqual([]);
  });

  it("ignores a directory holding no component of its own name", () => {
    expect(
      findComponentsWithoutStories([
        "shared/libs/core-ui/src/lib/cn.ts",
        "shared/libs/core-ui/src/lib/a11y-scope.ts",
      ]),
    ).toEqual([]);
  });

  it("reports every uncovered component, not just the first", () => {
    const violations = findComponentsWithoutStories([
      ...componentFiles("shared/libs/core-ui/src/primitives", "Toast"),
      ...componentFiles("shared/libs/core-ui/src/blocks", "ToastStack"),
    ]);

    expect(violations).toHaveLength(2);
  });
});
