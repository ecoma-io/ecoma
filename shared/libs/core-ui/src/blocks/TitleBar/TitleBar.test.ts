import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import TitleBar from "./TitleBar.vue";

// Unit tier: every project-internal collaborator is isolated
// (local/no-unmocked-internal-imports). Each stub keeps only the seam this
// file's own behavior is defined against — the events TitleBar re-emits.
vi.mock("../../primitives/Menubar/Menubar.vue", () => ({
  default: { name: "Menubar", props: ["menus"], emits: ["select"], template: "<div />" },
}));
vi.mock("../../primitives/WindowControls/WindowControls.vue", () => ({
  default: {
    name: "WindowControls",
    props: ["isMaximized", "labels"],
    emits: ["minimize", "maximize", "close"],
    template: "<div />",
  },
}));
vi.mock("../../icons/BrandMark", () => ({ default: { name: "BrandMark", template: "<svg />" } }));

/**
 * NOT pinned here, deliberately and with the reason recorded: the window drag
 * region. Vue applies a static `style` attribute through `el.style.cssText`,
 * and jsdom's CSS parser drops `-webkit-app-region` outright — verified, the
 * style attribute comes back as the empty string. So an assertion about which
 * clusters are `drag` and which are `no-drag` would not be weak here, it would
 * be vacuous: `not.toContain("no-drag")` passes against markup that never had
 * a style at all. Pinning it needs an engine that keeps the property, and the
 * option that would make it testable at this tier — moving the declaration
 * into a utility class — trades a guarantee for it, since a host that has not
 * wired the stylesheet would then lose its drag region silently. That is a
 * call for the desktop host's own review, not a side effect of this file.
 */
describe("TitleBar", () => {
  it("renders the host's brand name, since the block carries no identity of its own", () => {
    const wrapper = mount(TitleBar, { props: { appName: "MyApp" } });
    const brand = wrapper.get("header").element.firstElementChild as HTMLElement;
    expect(brand.textContent).toContain("MyApp");
  });

  it("renders the menu bar only when the host supplies menus, so a menu-less app gets no empty cluster", () => {
    const without = mount(TitleBar, { props: { appName: "MyApp" } });
    expect(without.findComponent({ name: "Menubar" }).exists()).toBe(false);

    const withMenus = mount(TitleBar, {
      props: { appName: "MyApp", menus: [{ id: "file", label: "File", items: [] }] },
    });
    expect(withMenus.findComponent({ name: "Menubar" }).exists()).toBe(true);
  });

  it("re-emits window intents and menu commands without acting on them — the host owns IPC", async () => {
    const wrapper = mount(TitleBar, {
      props: { appName: "MyApp", menus: [{ id: "file", label: "File", items: [] }] },
    });

    await wrapper.findComponent({ name: "Menubar" }).vm.$emit("select", "file.open");
    const controls = wrapper.findComponent({ name: "WindowControls" });
    await controls.vm.$emit("minimize");
    await controls.vm.$emit("close");

    expect(wrapper.emitted("select")).toEqual([["file.open"]]);
    expect(wrapper.emitted("minimize")).toHaveLength(1);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
