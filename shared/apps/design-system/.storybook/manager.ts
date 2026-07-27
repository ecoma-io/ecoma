import { addons } from "storybook/manager-api";

addons.setConfig({
  layoutCustomisations: {
    // Docs-first Storybook: the viewport-width picker lives inline in
    // PreviewSurface, so the toolbar is pure noise — hide it 100%.
    showToolbar: () => false,
  },
});
