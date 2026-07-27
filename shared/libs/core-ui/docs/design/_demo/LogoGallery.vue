<script setup lang="ts">
import { computed } from "vue";
import BrandMark from "../../../src/icons/BrandMark";
import markRaw from "../assets/mark.svg?raw";
import markMonoRaw from "../assets/mark-mono.svg?raw";
import markInverseRaw from "../assets/mark-inverse.svg?raw";
import appIconRaw from "../assets/app-icon.svg?raw";

// The three mark files share internal ids (cl/cr/gap…) because each is a
// standalone asset. Inlined side by side on one page those ids would collide,
// so every instance gets its ids namespaced before injection.
const ns = (raw: string, prefix: string) =>
  raw.replaceAll('id="', `id="${prefix}-`).replaceAll("url(#", `url(#${prefix}-`);

// Micro cuts thicken the nose seam so the gap survives rasterization — same
// optical law as stroke 2.5 for icons ≤ 12px (Design System › Iconography).
// The asset carries seam width 2.8; the cut is a deterministic substitution.
const seam = (raw: string, width: string, prefix: string) =>
  ns(raw.replace('stroke-width="2.8"', `stroke-width="${width}"`), prefix);

const duotone = computed(() => ns(markRaw, "lg-duo"));
const mono = computed(() => ns(markMonoRaw, "lg-mono"));
const inverse = computed(() => ns(markInverseRaw, "lg-inv"));
const appIcon = computed(() => ns(appIconRaw, "lg-app"));

const ladder = computed(() => [
  { size: 96, label: "96 · khe 2.8", svg: ns(markRaw, "lg-s96") },
  { size: 48, label: "48 · khe 2.8", svg: ns(markRaw, "lg-s48") },
  { size: 32, label: "32 · khe 3.6", svg: seam(markRaw, "3.6", "lg-s32") },
  { size: 16, label: "16 · khe 4.4", svg: seam(markRaw, "4.4", "lg-s16") },
]);
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- Variant tiles -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-5">
        <div class="h-20 w-20" aria-hidden="true" v-html="duotone" />
        <div class="text-center">
          <div class="text-sm font-medium">Duotone</div>
          <div class="text-xs text-muted-foreground">Mặc định — digital, nền sáng</div>
        </div>
      </div>
      <div class="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-5">
        <div class="h-20 w-20" aria-hidden="true" v-html="mono" />
        <div class="text-center">
          <div class="text-sm font-medium">Mono</div>
          <div class="text-xs text-muted-foreground">In ấn, ngữ cảnh trung tính</div>
        </div>
      </div>
      <div
        class="flex flex-col items-center gap-3 rounded-lg border border-border bg-foreground p-5"
      >
        <div class="h-20 w-20" aria-hidden="true" v-html="inverse" />
        <div class="text-center">
          <div class="text-sm font-medium text-background">Inverse</div>
          <div class="text-xs text-background/70">Nền tối, footer, splash</div>
        </div>
      </div>
      <div class="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-5">
        <div class="h-20 w-20" aria-hidden="true" v-html="appIcon" />
        <div class="text-center">
          <div class="text-sm font-medium">App icon</div>
          <div class="text-xs text-muted-foreground">Full-bleed — mặt tràn kín ô</div>
        </div>
      </div>
    </div>

    <!-- Size ladder with optical seam cuts -->
    <div class="rounded-lg border border-border bg-card p-5">
      <div class="mb-4 text-xs text-muted-foreground">
        Thang cỡ — khe sống mũi dày lên theo luật optical ở cỡ nhỏ để không bị nuốt khi rasterize:
      </div>
      <div class="flex flex-wrap items-end gap-8">
        <div v-for="l in ladder" :key="l.size" class="flex flex-col items-center gap-2">
          <div
            :style="{ width: `${l.size}px`, height: `${l.size}px` }"
            aria-hidden="true"
            v-html="l.svg"
          />
          <div class="tabular text-xs text-muted-foreground">{{ l.label }}</div>
        </div>
      </div>
    </div>

    <!-- Clear space -->
    <div class="flex items-center gap-6 rounded-lg border border-border bg-card p-5">
      <div class="rounded-md border border-dashed border-agent/60 p-6" aria-hidden="true">
        <div class="h-16 w-16" v-html="ns(markRaw, 'lg-cs')" />
      </div>
      <div class="text-xs text-muted-foreground">
        <span class="font-medium text-foreground">Clear space</span> — chừa trống tối thiểu ¼ chiều
        cao mark ở mỗi phía (vùng gạch đứt); không đặt chữ hay phần tử khác lấn vào.
      </div>
    </div>

    <!-- BrandMark in UI -->
    <div class="flex items-center gap-4 rounded-lg border border-border bg-card p-5">
      <span class="flex items-center gap-2 text-sm text-foreground">
        <BrandMark :size="16" aria-hidden="true" />
        Ecoma
      </span>
      <span class="flex items-center gap-2 text-xs text-muted-foreground">
        <BrandMark :size="10" :stroke-width="2.5" aria-hidden="true" />
        TitleBar 10px — stroke 2.5
      </span>
      <div class="text-xs text-muted-foreground">
        Trong UI, mark xuất hiện qua icon <code>BrandMark</code> (mono, lưới 24,
        <code>currentColor</code>) — không nhúng SVG duotone vào giao diện.
      </div>
    </div>
  </div>
</template>
