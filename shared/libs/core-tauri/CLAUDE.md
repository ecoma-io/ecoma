# Tauri app plumbing (`shared/libs/core-tauri`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`. Nx
project name `core-tauri`; import alias `@ecoma-io/core-tauri` (tags
`type:lib`, `scope:shared`). Shared Tauri webview plumbing for desktop apps:
the window-chrome controls that back `@ecoma-io/ui`'s `TitleBar`. Currently
the workspace's only desktop-shell substrate.

- **One entry point.** Tauri's webview drives its own window directly through
  `@tauri-apps/api/window`, so the whole bridge is `useWindowControls` in
  `src/window-controls.ts`. Do not invent a preload/main-process-style tier
  split here — that layering belongs to shells that need an IPC hop, and
  this one does not.
- **The composable's shape is the shell contract.** `UseWindowControls`
  (`isMaximized` ref + `minimize`/`maximize`/`close`) is the only surface a
  host app's TitleBar wiring depends on, and it deliberately carries no
  Tauri type in its signature. That keeps adding a second shell a matter of
  implementing this shape — a reserved seam with no second consumer today.
  Widening it with a Tauri-specific type closes that seam silently.
- **Frameless is configuration, not code.** In Tauri it lives in the host
  app's `tauri.conf.json` (`app.windows[].decorations: false`) and its Rust
  shell — nothing for this lib to own. Window sizing policy is likewise a
  per-app product decision (core-ui's Design System › Principles §4).
- `useWindowControls` initializes eagerly, not `onMounted`, and refreshes
  `isMaximized` only after its own `maximize()` — a known, accepted limit
  (an OS-driven maximize outside the TitleBar buttons is not observed).
- Unit tests mock `@tauri-apps/api/window` at the module boundary — the
  real backing only exists inside a running webview; runtime proof belongs
  to a host app's e2e, not here.
