/**
 * Webview/Vue context: `useWindowControls`, the composable a Tauri host
 * app's TitleBar wiring calls to drive `@ecoma-io/ui`'s `TitleBar`
 * minimize / maximize / close emits. `UseWindowControls` deliberately
 * carries no Tauri type, so a second shell could implement the same shape
 * without an app touching its TitleBar wiring — a reserved seam, with no
 * second consumer today. Tauri needs no preload tier: the webview talks to
 * the window directly through `@tauri-apps/api/window`, so this one module
 * is the whole bridge.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ref } from "vue";
import type { Ref } from "vue";

export interface UseWindowControls {
  isMaximized: Ref<boolean>;
  minimize: () => void;
  maximize: () => void;
  close: () => void;
}

export function useWindowControls(): UseWindowControls {
  const isMaximized = ref(false);
  const currentWindow = getCurrentWindow();

  const refresh = async (): Promise<void> => {
    isMaximized.value = await currentWindow.isMaximized();
  };

  // Eager, not onMounted — no DOM dependency, so this stays usable outside a
  // mounted component tree and unit testable without a jsdom host.
  void refresh();

  function minimize(): void {
    void currentWindow.minimize();
  }

  function maximize(): void {
    void currentWindow.toggleMaximize().then(() => refresh());
  }

  function close(): void {
    void currentWindow.close();
  }

  return { isMaximized, minimize, maximize, close };
}
