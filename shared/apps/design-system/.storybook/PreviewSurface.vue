<script lang="ts">
/**
 * Query flag that tells this decorator NOT to wrap — the story renders bare.
 * `preview.ts` reads it, and the preset iframe below sets it, which is what
 * keeps the nested frame from wrapping itself again forever.
 */
export const BARE_PARAM = "loomBare";

/** Widths the picker offers; `null` = unconstrained, the real browser window. */
export const VIEWPORT_WIDTHS = {
  full: null,
  "1280": 1280,
  "768": 768,
  "480": 480,
} as const;

export type ViewportKey = keyof typeof VIEWPORT_WIDTHS;
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
// Cross-project import through core-ui's public alias (resolved by the derived
// alias entries in main.ts's viteFinal) — a relative path into another project
// is banned by @nx/enforce-module-boundaries.
import { SegmentedControl } from "@ecoma-io/ui";

/**
 * Wraps every story with an inline viewport preview surface — replaces the
 * removed toolbar chrome (manager.ts hides showToolbar entirely). Loom ships
 * a single default theme (no runtime light/dark switch), so this only needs to
 * control preview width — from a narrow window up to ultrawide.
 *
 * **A preset renders the story in a nested iframe, and it has to.** The
 * obvious implementation — put a `max-width` on the demo container — only
 * narrows a BOX. Tailwind's `sm:`/`lg:`/`3xl:` utilities compile to
 * `@media (width >= …)`, which the browser answers from the window, so a
 * narrowed ancestor changes nothing about which of them apply. Measured on
 * this Storybook before the frame existed: picking 480 gave a 430px-wide
 * AppHeader that was still 56px tall with its search field inline — the
 * desktop layout, drawn small. A picker that shows the wrong layout is worse
 * than no picker, because it is believed.
 *
 * An iframe is a real viewport, so `matchMedia` inside it answers from the
 * frame's own width and every breakpoint resolves the way it will for a user
 * on that screen. `full` stays inline — no frame, no cost, and it is what the
 * a11y run sees, since that run never touches the picker.
 *
 * Container queries are NOT the alternative here: they would require every
 * component in the library to be authored against `@container` instead of
 * viewport breakpoints. The breakpoint vocabulary is spec'd in Design System ›
 * Principles §4; the preview tool bends to it, not the other way round.
 */
const props = defineProps<{ storyId: string }>();

const viewport = ref<ViewportKey>("full");
const width = computed(() => VIEWPORT_WIDTHS[viewport.value]);

/**
 * Resolved against the current document, which IS `iframe.html` in both the
 * story view and the docs view — so this works under a subpath deploy without
 * knowing the base href.
 */
const frameSrc = computed(() => {
  if (!width.value) return "";
  const url = new URL("iframe.html", window.location.href);
  url.searchParams.set("id", props.storyId);
  url.searchParams.set("viewMode", "story");
  url.searchParams.set(BARE_PARAM, "1");
  return url.toString();
});

/**
 * Floor, because measuring content height cannot see everything a story shows.
 * `ToastStack`'s demo measures 32px — a row of buttons — while what it is
 * demonstrating is `position: fixed` to the viewport's bottom edge and
 * contributes no height at all. A frame sized to the measurement would clip
 * the toasts out of existence. 280px is the shortest frame that still shows a
 * two-toast stack above its bottom inset.
 */
const MIN_FRAME_HEIGHT = 280;
const frameHeight = ref(MIN_FRAME_HEIGHT);
const frame = ref<HTMLIFrameElement | null>(null);
let observer: ResizeObserver | null = null;

/**
 * Height follows the story's own content. Measured on `#storybook-root`, never
 * on `documentElement`: the document's scroll height is floored at the frame's
 * own height, so measuring it would feed this element's output back into its
 * input and the frame could only ever grow. The root element measures the
 * story alone, so shrinking works too.
 */
function syncHeight() {
  const root = frame.value?.contentDocument?.getElementById("storybook-root");
  if (root) frameHeight.value = Math.max(root.scrollHeight, MIN_FRAME_HEIGHT);
}

function onFrameLoad() {
  const root = frame.value?.contentDocument?.getElementById("storybook-root");
  observer?.disconnect();
  if (!root) return;
  syncHeight();
  observer = new ResizeObserver(syncHeight);
  observer.observe(root);
}

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="preview-surface">
    <div class="control-bar">
      <SegmentedControl
        aria-label="Viewport width"
        size="sm"
        :model-value="viewport"
        :options="[
          { value: 'full', label: 'Full' },
          { value: '1280', label: '1280' },
          { value: '768', label: '768' },
          { value: '480', label: '480' },
        ]"
        @update:model-value="viewport = $event as ViewportKey"
      />
    </div>

    <!-- `full`: inline, exactly as before — and the only path the a11y run takes. -->
    <div v-if="!width" class="demo-area">
      <slot />
    </div>

    <!-- A preset: a real viewport of that width (see the doc header). `key` on
         the width so switching presets reloads rather than resizing a frame
         whose story already resolved its media queries at the old width. -->
    <div v-else class="frame-shell" :style="{ maxWidth: `${width}px` }">
      <iframe
        ref="frame"
        :key="width"
        class="frame"
        :src="frameSrc"
        :style="{ height: `${frameHeight}px` }"
        :title="`Xem trước ở bề rộng ${width}px`"
        @load="onFrameLoad"
      />
    </div>
  </div>
</template>

<style scoped>
/*
 * Plain scoped CSS by choice, not by constraint. `tailwind.config.js` does scan
 * this folder's .vue and .ts files, and utilities written here do compile —
 * checked directly by putting an arbitrary-value class in this template and
 * finding it in the built stylesheet. The reason to stay off Tailwind is that
 * this file is preview scaffolding, not a product surface: it should not be
 * able to drift the design system by using it. Do not "fix" this by converting
 * to utilities, and do not repeat the older note that claimed the scan misses
 * this folder.
 *
 * Keep glob patterns out of this comment: a `**` followed by `/` closes the CSS
 * comment early, and the prose after it then parses as CSS and fails the build.
 */
.preview-surface {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/*
 * There's a single default theme now, so this bar can read the same shared
 * tokens as .demo-area below it — no need for a hardcoded static fallback.
 * addon-a11y still runs axe against every story through this wrapper, so
 * its contrast stays a hard gate.
 */
.control-bar {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: hsl(var(--muted));
  border-bottom: 1px solid hsl(var(--border));
}

.demo-area {
  background: hsl(var(--background));
  color: hsl(var(--foreground));
  padding: 1.5rem;
  border-radius: 0.75rem;
}

/* Centered so the narrowed viewport reads as a device on a desk, not as a
 * column that fell to the left. Hairline, no shadow (Design System › Elevation). */
.frame-shell {
  margin-inline: auto;
  width: 100%;
  overflow: hidden;
  border: 1px solid hsl(var(--border));
  border-radius: 0.75rem;
  background: hsl(var(--background));
}

.frame {
  display: block;
  width: 100%;
  border: 0;
}
</style>
