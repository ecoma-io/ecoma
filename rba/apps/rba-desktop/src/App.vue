<script setup lang="ts">
// The shell renders the shared design system and the shared window chrome, and
// nothing of its own. That is the whole point of the project: it proves the two
// shared libs compose inside a Tauri webview, at the moment the toolchain is
// still cheap to change.
import { TitleBar } from "@ecoma-io/ui";
</script>

<template>
  <TitleBar app-name="Ecoma RBA" />
  <main class="p-8">
    <h1 class="text-xl font-semibold">Ecoma RBA</h1>
    <p class="text-muted-foreground mt-2 max-w-prose text-sm">
      Desktop shell. It carries no RBA mechanism yet — the driver, session and Filler interfaces it
      will host are frozen at ◆G0, and this shell exists to prove the Rust and Tauri toolchain
      before that freeze, not to start Track B.
    </p>
  </main>
</template>
