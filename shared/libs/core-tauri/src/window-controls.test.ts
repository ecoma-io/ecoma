import { beforeEach, describe, expect, it, vi } from "vitest";

const currentWindow = {
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn(),
};

// The platform boundary: in a real webview this module is backed by the
// Tauri runtime, which no test process has.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => currentWindow,
}));

import { useWindowControls } from "./window-controls";

/** Node test environment has no microtask-flushing DOM lifecycle — drain manually. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  currentWindow.minimize.mockResolvedValue(undefined);
  currentWindow.toggleMaximize.mockResolvedValue(undefined);
  currentWindow.close.mockResolvedValue(undefined);
  currentWindow.isMaximized.mockResolvedValue(false);
});

describe("useWindowControls", () => {
  it("initializes isMaximized from the window", async () => {
    currentWindow.isMaximized.mockResolvedValue(true);

    const { isMaximized } = useWindowControls();
    await flushMicrotasks();

    expect(isMaximized.value).toBe(true);
  });

  it("delegates minimize/close directly to the window", () => {
    const { minimize, close } = useWindowControls();
    minimize();
    close();

    expect(currentWindow.minimize).toHaveBeenCalledTimes(1);
    expect(currentWindow.close).toHaveBeenCalledTimes(1);
  });

  it("toggles maximize and refreshes isMaximized after it resolves", async () => {
    const { isMaximized, maximize } = useWindowControls();
    await flushMicrotasks();
    expect(isMaximized.value).toBe(false);

    currentWindow.isMaximized.mockResolvedValue(true);
    maximize();
    await flushMicrotasks();

    expect(currentWindow.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(isMaximized.value).toBe(true);
  });
});
