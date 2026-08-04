<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import gsap from "gsap";
import Surface from "../../../src/primitives/Surface/Surface.vue";
import Badge from "../../../src/primitives/Badge/Badge.vue";

/**
 * "Điểm nhấn ấn tượng" — khoảnh khắc agent bàn giao kết quả cho người. Đây là
 * loại motion mà token CSS mặc định (≤200ms) cố tình KHÔNG làm: dàn cảnh nhiều
 * bước, overshoot, quầng weft bung ra tại điểm chạm. Khi cần một accent như
 * vậy, ta dùng GSAP timeline.
 */
const root = ref<HTMLElement | null>(null);
let ctx: ReturnType<typeof gsap.context> | null = null;

const tiles = [
  { title: "1.284 dòng khớp", meta: "đối soát tự động" },
  { title: "3 dòng lệch", meta: "chờ người quyết" },
  { title: "Báo cáo sẵn sàng", meta: "bàn giao 09:41" },
];

const play = () => {
  const reduce =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  ctx?.revert(); // trả DOM về trạng thái gốc trước khi diễn lại
  ctx = gsap.context(() => {
    // Reduced-motion: bỏ toàn bộ dàn cảnh, hiện thẳng kết quả.
    if (reduce) {
      gsap.set("[data-tile]", { opacity: 1, y: 0, scale: 1 });
      gsap.set("[data-burst]", { opacity: 0 });
      return;
    }

    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

    // 1 — quầng weft bung ra từ thẻ agent (accent, không phải feedback).
    tl.fromTo(
      "[data-burst]",
      { scale: 0.6, opacity: 0.85 },
      { scale: 2.4, opacity: 0, duration: 0.7, ease: "power2.out" },
      0,
    );
    // 2 — thẻ bàn giao nảy nhẹ báo "đã nhận".
    tl.fromTo(
      "[data-prompt]",
      { scale: 1 },
      { scale: 1.03, duration: 0.16, yoyo: true, repeat: 1, ease: "power2.inOut" },
      0,
    );
    // 3 — kết quả trồi lên theo stagger, overshoot bằng back.out.
    tl.fromTo(
      "[data-tile]",
      { y: 26, opacity: 0, scale: 0.92 },
      { y: 0, opacity: 1, scale: 1, duration: 0.55, ease: "back.out(1.7)", stagger: 0.12 },
      0.12,
    );
  }, root.value ?? undefined);
};

onMounted(play);
onBeforeUnmount(() => ctx?.revert());
</script>

<template>
  <div ref="root" class="flex flex-col gap-6">
    <button
      class="self-start rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-subtle"
      @click="play"
    >
      ↻ Diễn lại accent
    </button>

    <!-- Thẻ bàn giao + quầng weft tại điểm chạm -->
    <div class="relative w-fit">
      <div
        data-burst
        class="pointer-events-none absolute -inset-3 rounded-2xl bg-agent/30 blur-xl"
      />
      <div
        data-prompt
        class="relative flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"
      >
        <Badge variant="ai">Agent</Badge>
        <span class="text-foreground">Đối soát xong — bàn giao 3 dòng lệch cho bạn quyết</span>
      </div>
    </div>

    <!-- Kết quả agent bàn giao -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Surface v-for="t in tiles" :key="t.title" data-tile variant="muted">
        <div class="text-sm font-medium">{{ t.title }}</div>
        <div class="tabular mt-1 text-xs text-muted-foreground">{{ t.meta }}</div>
      </Surface>
    </div>
  </div>
</template>
