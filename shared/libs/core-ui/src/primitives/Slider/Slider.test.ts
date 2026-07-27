import { mount } from "@vue/test-utils";
import { SliderRoot } from "reka-ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Slider from "./Slider.vue";

// jsdom has no ResizeObserver — Reka's SliderThumb (`useSize`) instantiates
// one on mount (same jsdom gap CanvasStage.test.ts stubs around).
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function mountSlider(props: Partial<InstanceType<typeof Slider>["$props"]> = {}) {
  return mount(Slider, { props: { modelValue: 0.5, min: 0, max: 1, step: 0.01, ...props } });
}

// Reka's `SliderRoot` drives pointer capture (`setPointerCapture`/
// `hasPointerCapture`) and layout (`getBoundingClientRect`-based scale math)
// that jsdom doesn't implement/faithfully lay out — a true pointerdown/move/up
// simulation is infeasible here (same jsdom gap NumberField's own scrub-drag
// test file works around by hand-rolling pointer math instead of relying on a
// library). Per the task's sanctioned fallback, these drive the SliderRoot
// boundary directly: `update:modelValue` ticks (what Reka emits on every drag
// tick) then `valueCommit` (what Reka emits at release, IF it sees the value
// actually changed — see the root-cause comment in Slider.vue).
function findRoot(wrapper: ReturnType<typeof mountSlider>) {
  return wrapper.getComponent(SliderRoot);
}

describe("Slider drag gesture (I2/I9: transient ticks, one commit per gesture, no snap-back)", () => {
  it("streams update:modelValue on every drag tick and feeds the buffered value back into SliderRoot (no snap-back)", async () => {
    const wrapper = mountSlider({ modelValue: 0.5 });
    const root = findRoot(wrapper);

    // Reka emits `update:modelValue` on every pointermove tick during a drag.
    await root.vm.$emit("update:modelValue", [0.6]);
    await root.vm.$emit("update:modelValue", [0.7]);

    expect(wrapper.emitted("update:modelValue")).toEqual([[0.6], [0.7]]);
    // The host never echoes a transient value back down (I2) — `props.modelValue`
    // is still 0.5 here — but SliderRoot must see the drag's real position, not
    // the frozen prop, or it can never detect a change at release.
    expect(root.props("modelValue")).toEqual([0.7]);
    expect(wrapper.emitted("commit")).toBeUndefined();
  });

  it("commits exactly once on release, with the final dragged value", async () => {
    const wrapper = mountSlider({ modelValue: 0.5 });
    const root = findRoot(wrapper);

    await root.vm.$emit("update:modelValue", [0.6]);
    await root.vm.$emit("update:modelValue", [0.82]);
    // What Reka's `handleSlideEnd` emits once it observes `currentModelValue`
    // (now backed by our buffered feed-back) differs from the pre-drag snapshot.
    await root.vm.$emit("valueCommit", [0.82]);

    expect(wrapper.emitted("commit")).toEqual([[0.82]]);
  });

  it("a drag that ends back at its start value: Reka sees no change, so no valueCommit — and this wrapper commits nothing either", async () => {
    const wrapper = mountSlider({ modelValue: 0.5 });
    const root = findRoot(wrapper);

    await root.vm.$emit("update:modelValue", [0.6]);
    await root.vm.$emit("update:modelValue", [0.5]); // back to start
    // Reka's own hasChanged gate would not fire valueCommit here — nothing to forward.

    expect(wrapper.emitted("commit")).toBeUndefined();
  });

  // The abort path needs the wrapper to see a real pointerdown (that's what
  // arms its window listeners). Target the thumb: Reka's own pointerdown
  // handler only focuses a thumb (no slideStart → no layout math jsdom can't
  // do), and the event still bubbles to the root where the wrapper listens.
  async function startDrag(wrapper: ReturnType<typeof mountSlider>) {
    const thumb = wrapper.get('[role="slider"]');
    (thumb.element as HTMLElement).setPointerCapture = () => {};
    await thumb.trigger("pointerdown");
  }

  it("Escape mid-drag aborts: one reset tick with the committed value, Reka's release commit swallowed", async () => {
    const wrapper = mountSlider({ modelValue: 0.5 });
    const root = findRoot(wrapper);
    await startDrag(wrapper);

    await root.vm.$emit("update:modelValue", [0.6]);
    await root.vm.$emit("update:modelValue", [0.7]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await wrapper.vm.$nextTick();

    // The reset tick restores the host's transient preview (I2) and feeds the
    // committed value back into SliderRoot, so its hasChanged gate closes.
    expect(wrapper.emitted("update:modelValue")).toEqual([[0.6], [0.7], [0.5]]);
    expect(root.props("modelValue")).toEqual([0.5]);

    // Post-Escape move ticks must not resurrect the gesture, and even a
    // valueCommit (belt-and-suspenders) is swallowed until release.
    await root.vm.$emit("update:modelValue", [0.8]);
    await root.vm.$emit("valueCommit", [0.8]);
    expect(wrapper.emitted("update:modelValue")).toHaveLength(3);
    expect(wrapper.emitted("commit")).toBeUndefined();

    // Release re-arms: the next keyboard step commits normally again.
    window.dispatchEvent(new Event("pointerup"));
    await root.vm.$emit("update:modelValue", [0.51]);
    await root.vm.$emit("valueCommit", [0.51]);
    expect(wrapper.emitted("commit")).toEqual([[0.51]]);
  });

  it("pointercancel mid-drag aborts: reset tick, no commit ever fires for the cancelled gesture", async () => {
    const wrapper = mountSlider({ modelValue: 0.5 });
    const root = findRoot(wrapper);
    await startDrag(wrapper);

    await root.vm.$emit("update:modelValue", [0.6]);
    window.dispatchEvent(new Event("pointercancel"));
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("update:modelValue")).toEqual([[0.6], [0.5]]);
    expect(root.props("modelValue")).toEqual([0.5]);
    expect(wrapper.emitted("commit")).toBeUndefined();
  });

  it("keyboard step commit (Reka's own updateValues({commit:true}) path) is forwarded unchanged", async () => {
    const wrapper = mountSlider({ modelValue: 0.5 });
    const root = findRoot(wrapper);

    // A single arrow-key tick: Reka updates its model and commits in one
    // synchronous call, with no preceding transient `update:modelValue`.
    await root.vm.$emit("update:modelValue", [0.51]);
    await root.vm.$emit("valueCommit", [0.51]);

    expect(wrapper.emitted("update:modelValue")).toEqual([[0.51]]);
    expect(wrapper.emitted("commit")).toEqual([[0.51]]);
  });
});

describe("Slider external value sync", () => {
  it("reflects a host-driven modelValue change when idle (element re-selection, external commit)", async () => {
    const wrapper = mountSlider({ modelValue: 0.5 });
    await wrapper.setProps({ modelValue: 0.9 });
    expect(findRoot(wrapper).props("modelValue")).toEqual([0.9]);
  });
});
