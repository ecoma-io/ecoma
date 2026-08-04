<script setup lang="ts">
import { ref } from "vue";
import Surface from "../../../src/primitives/Surface/Surface.vue";

const key = ref(0);
const replay = () => (key.value += 1);

const easings = [
  { name: "ease-out", cls: "ease-out", note: "Mặc định — content vào, panel mở" },
  { name: "ease-spring", cls: "ease-spring", note: "Overshoot nhẹ — menu, popover" },
  { name: "ease-in-out", cls: "ease-in-out", note: "Di chuyển đối xứng — indicator trượt" },
];
</script>

<template>
  <div class="flex flex-col gap-6">
    <button
      class="self-start rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-subtle"
      @click="replay"
    >
      ↻ Replay motion
    </button>

    <!-- Enter transitions -->
    <div :key="key" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Surface variant="muted" class="animate-fade">
        <div class="text-sm font-medium">fade</div>
        <div class="text-xs text-muted-foreground">
          Nền overlay, không dịch chuyển — 200ms / ease-out
        </div>
      </Surface>
      <Surface variant="muted" class="animate-fade-rise">
        <div class="text-sm font-medium">fade-rise</div>
        <div class="text-xs text-muted-foreground">Nội dung xuất hiện — 200ms / ease-out</div>
      </Surface>
      <Surface variant="muted" class="animate-scale-in">
        <div class="text-sm font-medium">scale-in</div>
        <div class="text-xs text-muted-foreground">Popover/menu — 140ms / ease-spring</div>
      </Surface>
      <Surface variant="muted" class="animate-toast-in">
        <div class="text-sm font-medium">toast-in</div>
        <div class="text-xs text-muted-foreground">
          Toast trượt vào theo trục swipe — 200ms / ease-spring
        </div>
      </Surface>
    </div>

    <!-- Agent conduction pulse -->
    <div class="flex items-center gap-4">
      <div class="h-10 w-10 rounded-full bg-agent/15 animate-conduct" />
      <div class="text-xs text-muted-foreground">
        <span class="font-medium text-foreground">conduct</span> — nhịp thoi đưa báo hiệu agent đang
        làm việc.
      </div>
    </div>

    <!-- Live seam -->
    <div class="flex items-center gap-4">
      <div
        class="h-2 w-40 shrink-0 rounded-full bg-seam animate-seam-flow"
        style="background-size: 200% 100%"
      />
      <div class="text-xs text-muted-foreground">
        <span class="font-medium text-foreground">seam-flow</span> — đường can sống: biên warp↔weft
        trôi chậm khi cuộc cộng tác người↔agent đang diễn ra.
      </div>
    </div>

    <!-- Indeterminate loop -->
    <div class="flex items-center gap-4">
      <div class="relative h-2 w-40 shrink-0 overflow-hidden rounded-full bg-muted">
        <div class="h-full w-1/3 rounded-full bg-primary animate-progress-indeterminate" />
      </div>
      <div class="text-xs text-muted-foreground">
        <span class="font-medium text-foreground">progress-indeterminate</span> — một đoạn ngắn quét
        track khi chưa có phần trăm để vẽ.
      </div>
    </div>

    <!-- Easing lanes -->
    <div class="flex flex-col gap-3">
      <div v-for="e in easings" :key="e.name" class="flex items-center gap-4">
        <div class="w-28 shrink-0 tabular text-xs text-muted-foreground">{{ e.name }}</div>
        <div class="relative h-6 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            :key="key"
            :class="[
              'lane-dot absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-primary',
              e.cls,
            ]"
          />
        </div>
        <div class="hidden w-56 shrink-0 text-xs text-muted-foreground sm:block">{{ e.note }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Demo-only keyframe: the easing lanes need a shared translate so the three
 * easing curves compare on identical motion. Lives here, not in the shared
 * keyframe library — no product surface glides a dot across a lane. */
@keyframes lane-glide {
  from {
    left: 0;
  }
  to {
    left: calc(100% - 1rem);
  }
}
.lane-dot {
  animation: lane-glide 900ms both;
  /* animation-timing-function đến từ class ease-* của preset */
}
</style>
