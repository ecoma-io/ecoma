import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import NumberField from "./NumberField.vue";

function mountField(props: Partial<InstanceType<typeof NumberField>["$props"]> = {}) {
  return mount(NumberField, { props: { modelValue: 10, ...props } });
}

// Real dispatched events, not test-utils' `.trigger()`: trigger() re-assigns
// init keys onto a synthetic event and trips over getter-only props like
// `button` (same technique/reasoning as apps/desktop EditorView.test.ts's
// `firePointer` — PointerEvent's `button` has no setter, and NumberField's
// own pointerdown handler branches on `event.button !== 0`).
function firePointer(el: Element, type: string, init: PointerEventInit) {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
}
function fireWindow(type: string, init: PointerEventInit) {
  window.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
}
function fireWindowKey(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
}

const ROOT = '[role="group"]';

describe("NumberField scrub-drag gesture (I2/I9: transient ticks, one commit per gesture)", () => {
  it("does not start a drag below the pixel threshold — a plain click still lets typing happen", () => {
    const wrapper = mountField();
    const root = wrapper.get(ROOT).element;
    firePointer(root, "pointerdown", { clientX: 100, clientY: 0 });
    fireWindow("pointermove", { clientX: 101, clientY: 0 }); // 1px, under DRAG_THRESHOLD_PX=3
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    fireWindow("pointerup", { clientX: 101, clientY: 0 });
    expect(wrapper.emitted("commit")).toBeUndefined();
  });

  it("streams update:modelValue on every drag tick past the threshold, and commits exactly once on release", () => {
    const wrapper = mountField({ modelValue: 10, step: 1 });
    const root = wrapper.get(ROOT).element;
    firePointer(root, "pointerdown", { clientX: 100, clientY: 0 });
    // PIXELS_PER_STEP=4: +20px -> +5 steps
    fireWindow("pointermove", { clientX: 112, clientY: 0 }); // past threshold, +3 steps
    fireWindow("pointermove", { clientX: 120, clientY: 0 }); // +5 steps
    const updates = wrapper.emitted("update:modelValue") as number[][];
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[updates.length - 1][0]).toBe(15);
    expect(wrapper.emitted("commit")).toBeUndefined(); // nothing committed mid-drag

    fireWindow("pointerup", { clientX: 120, clientY: 0 });
    expect(wrapper.emitted("commit")).toEqual([[15]]); // exactly one commit for the whole gesture
  });

  it("Escape mid-drag discards the gesture: restores the start value transiently and commits nothing", () => {
    const wrapper = mountField({ modelValue: 10, step: 1 });
    const root = wrapper.get(ROOT).element;
    firePointer(root, "pointerdown", { clientX: 100, clientY: 0 });
    fireWindow("pointermove", { clientX: 140, clientY: 0 }); // dragging, value changed
    expect((wrapper.emitted("update:modelValue") as number[][]).at(-1)?.[0]).not.toBe(10);

    fireWindowKey("Escape");
    expect((wrapper.emitted("update:modelValue") as number[][]).at(-1)?.[0]).toBe(10);
    expect(wrapper.emitted("commit")).toBeUndefined();

    // The pointerup that follows must not resurrect a commit.
    fireWindow("pointerup", { clientX: 140, clientY: 0 });
    expect(wrapper.emitted("commit")).toBeUndefined();
  });

  it("pointercancel mid-drag discards the gesture like Escape — no partial commit", () => {
    const wrapper = mountField({ modelValue: 10, step: 1 });
    const root = wrapper.get(ROOT).element;
    firePointer(root, "pointerdown", { clientX: 100, clientY: 0 });
    fireWindow("pointermove", { clientX: 140, clientY: 0 });
    fireWindow("pointercancel", { clientX: 140, clientY: 0 });
    expect((wrapper.emitted("update:modelValue") as number[][]).at(-1)?.[0]).toBe(10);
    expect(wrapper.emitted("commit")).toBeUndefined();
  });

  it("clamps dragged values to min/max", () => {
    const wrapper = mountField({ modelValue: 10, min: 0, max: 12, step: 1 });
    const root = wrapper.get(ROOT).element;
    firePointer(root, "pointerdown", { clientX: 100, clientY: 0 });
    fireWindow("pointermove", { clientX: 1000, clientY: 0 }); // huge drag, way past max
    expect((wrapper.emitted("update:modelValue") as number[][]).at(-1)?.[0]).toBe(12);
    fireWindow("pointerup", { clientX: 1000, clientY: 0 });
    expect(wrapper.emitted("commit")).toEqual([[12]]);
  });

  it("a disabled field ignores pointerdown entirely — no drag starts", () => {
    const wrapper = mountField({ modelValue: 10, disabled: true });
    const root = wrapper.get(ROOT).element;
    firePointer(root, "pointerdown", { clientX: 100, clientY: 0 });
    fireWindow("pointermove", { clientX: 140, clientY: 0 });
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });
});

describe("NumberField keyboard gesture (I2/I9: held key = one gesture, Shift = x10)", () => {
  // Plain (non-Shift) ArrowUp/Down ticking is Reka's own NumberFieldRoot
  // behavior, not ours — not re-tested here (see declined-gaps in the audit
  // report). What IS ours: the Shift x10 override (`onKeydownCapture`) and the
  // keyup -> commit wiring (`onKeyupCommit`), exercised via Shift below.
  it("a single Shift+ArrowUp tap (keydown+keyup) ticks by step x10 and commits once", async () => {
    const wrapper = mountField({ modelValue: 10, step: 1 });
    const root = wrapper.get(ROOT);
    await root.trigger("keydown", { key: "ArrowUp", shiftKey: true });
    expect(wrapper.emitted("update:modelValue")).toEqual([[20]]); // step(1)*10
    expect(wrapper.emitted("commit")).toBeUndefined();
    await root.trigger("keyup", { key: "ArrowUp" });
    expect(wrapper.emitted("commit")).toEqual([[20]]);
  });

  it("a held Shift+ArrowUp (repeated keydown before keyup) accumulates ticks and commits exactly once on keyup", async () => {
    const wrapper = mountField({ modelValue: 10, step: 1 });
    const root = wrapper.get(ROOT);
    await root.trigger("keydown", { key: "ArrowUp", shiftKey: true }); // 10 -> 20
    await root.trigger("keydown", { key: "ArrowUp", shiftKey: true }); // 20 -> 30 (OS auto-repeat)
    await root.trigger("keydown", { key: "ArrowUp", shiftKey: true }); // 30 -> 40
    expect(wrapper.emitted("commit")).toBeUndefined();
    await root.trigger("keyup", { key: "ArrowUp" });
    expect(wrapper.emitted("commit")).toEqual([[40]]); // ONE transaction for the whole hold
  });

  it("Shift+ArrowDown ticks negative and clamps at min", async () => {
    const wrapper = mountField({ modelValue: 10, min: 5, step: 1 });
    const root = wrapper.get(ROOT);
    await root.trigger("keydown", { key: "ArrowDown", shiftKey: true }); // clamps to 5
    expect(wrapper.emitted("update:modelValue")).toEqual([[5]]);
    await root.trigger("keyup", { key: "ArrowDown" });
    expect(wrapper.emitted("commit")).toEqual([[5]]);
  });

  it("Enter commits the current value without waiting for blur", async () => {
    const wrapper = mountField({ modelValue: 10, step: 1 });
    const root = wrapper.get(ROOT);
    await root.trigger("keydown", { key: "ArrowUp", shiftKey: true }); // 10 -> 20, transient only
    await root.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("commit")).toEqual([[20]]);
  });

  it("Tab in and out with no edit commits nothing (no-op focus pass)", async () => {
    const wrapper = mountField({ modelValue: 10 });
    const root = wrapper.get(ROOT);
    await root.trigger("focusout", { relatedTarget: null });
    expect(wrapper.emitted("commit")).toBeUndefined();
  });
});

describe("NumberField external value sync", () => {
  it("reflects a host-driven modelValue change when no edit is pending", async () => {
    const wrapper = mountField({ modelValue: 10 });
    await wrapper.setProps({ modelValue: 42 });
    expect(wrapper.get("input").element.value).toBe("42");
  });

  it("an in-flight drag is not clobbered by the host echoing the same transient value back down", async () => {
    const wrapper = mountField({ modelValue: 10, step: 1 });
    const root = wrapper.get(ROOT).element;
    firePointer(root, "pointerdown", { clientX: 100, clientY: 0 });
    fireWindow("pointermove", { clientX: 120, clientY: 0 }); // -> 15, transient
    // Host round-trips the transient echo back as a prop (still mid-gesture).
    await wrapper.setProps({ modelValue: 15 });
    fireWindow("pointerup", { clientX: 120, clientY: 0 });
    // Still exactly one commit, not swallowed by the prop echo re-baselining lastCommittedValue.
    expect(wrapper.emitted("commit")).toEqual([[15]]);
  });
});

describe("NumberField unmount cleanliness", () => {
  it("unmounting mid-drag detaches the window pointermove/up/cancel listeners (no leak)", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const wrapper = mountField({ modelValue: 10, step: 1 });
    const root = wrapper.get(ROOT).element;
    firePointer(root, "pointerdown", { clientX: 100, clientY: 0 });
    fireWindow("pointermove", { clientX: 120, clientY: 0 }); // enters dragging, attaches window listeners
    removeSpy.mockClear();
    wrapper.unmount();
    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointercancel", expect.any(Function));

    // A stray event after unmount must not resurrect a commit/update.
    fireWindow("pointerup", { clientX: 200, clientY: 0 });
    expect(wrapper.emitted("commit")).toBeUndefined();
    removeSpy.mockRestore();
  });

  it("invalid paints the destructive border on the wrapper and sets aria-invalid on the spinbutton — same error language as TextField", () => {
    const wrapper = mountField({ invalid: true });
    expect(wrapper.get(ROOT).classes()).toContain("border-destructive");
    expect(wrapper.get("input").attributes("aria-invalid")).toBe("true");

    const quiet = mountField();
    expect(quiet.get(ROOT).classes()).not.toContain("border-destructive");
    expect(quiet.get("input").attributes("aria-invalid")).toBeUndefined();
  });

  // Iconography's ≤12px rule: the stepper chevrons sit at 12px, where the
  // inherited 1.5 stroke halves to 0.75 device px and all but disappears on
  // the hover-revealed steppers. Both directions declare 2.5.
  it("draws both 12px stepper chevrons at the small-glyph stroke width", () => {
    const glyphs = mountField().findAll("svg");
    expect(glyphs).toHaveLength(2); // increment + decrement
    for (const glyph of glyphs) {
      expect(glyph.classes()).toContain("h-3"); // still the 12px box the rule applies to
      expect(glyph.attributes("stroke-width")).toBe("2.5");
    }
  });
});
