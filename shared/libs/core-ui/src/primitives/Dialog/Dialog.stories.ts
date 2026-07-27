import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Dialog from "./Dialog.vue";
import Button from "../Button/Button.vue";
import DialogDemo from "./DialogDemo.vue";
import DialogDemoSource from "./DialogDemo.vue?raw";

const meta: Meta<typeof Dialog> = {
  title: "Components/Primitives/Dialog",
  component: Dialog,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Dialog>;

/** Rendered open so the a11y ("test") pass exercises the modal, not just the trigger. */
export const Open: Story = {
  args: {
    open: true,
    title: "Đổi tên composition",
    description: "Tên mới sẽ áp dụng ngay cho toàn bộ scene.",
  },
  render: (args) => ({
    components: { Dialog, Button },
    setup: () => ({ args }),
    template: `
      <Dialog v-bind="args">
        <p class="text-sm text-muted-foreground">Thân dialog.</p>
        <template #footer>
          <Button variant="subtle">Huỷ</Button>
          <Button variant="primary">Lưu</Button>
        </template>
      </Dialog>
    `,
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { DialogDemo }, template: "<DialogDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<DialogDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: DialogDemoSource, language: "vue" } } },
};
