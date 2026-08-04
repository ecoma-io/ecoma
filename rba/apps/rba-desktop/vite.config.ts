import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The dev port is fixed and `strictPort` is on because `tauri.conf.json`'s
// `devUrl` names it: if Vite silently moved to the next free port, the desktop
// window would open on a dead URL and the failure would look like a Tauri bug.
export default defineConfig({
  plugins: [vue()],
  root: __dirname,
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 6011, strictPort: true },
  // Tauri's own tooling reads these; a Rust-side panic must not be masked by
  // Vite swallowing the process's stderr.
  clearScreen: false,
});
