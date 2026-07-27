/// <reference types="vite/client" />

// Storybook demo stories import their sibling `<Name>Demo.vue` a second time
// with `?raw` to surface the real SFC as the docs "Show code" source (instead
// of the wrapper "<XDemo />"). Vite resolves this at build; this shim keeps
// `vue-tsc` happy about the `?raw` query on a `.vue` specifier.
declare module "*.vue?raw" {
  const src: string;
  export default src;
}
