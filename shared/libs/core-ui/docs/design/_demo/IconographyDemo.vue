<script setup lang="ts">
/**
 * Iconography swatch — Lucide as Loom's icon system. Demonstrates the
 * four conventions the docs page pins: (1) defaults set once via
 * applyLoomIconDefaults (size 16, stroke 1.5 — hairline-first), (2) the
 * 14/16/20 size ladder, (3) the ≤12px glyph exception — stroke 2.5, shown
 * side by side against the un-bumped 1.5 in the very controls that use it,
 * (4) custom domain icons (BrandMark) built with createLucideIcon are
 * indistinguishable from stock icons in usage.
 */
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Download,
  Film,
  FolderOpen,
  Layers,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Scissors,
  Settings,
  Sparkles,
  Undo2,
} from "@lucide/vue";
import BrandMark from "../../../src/icons/BrandMark";
import { applyLoomIconDefaults } from "../../../src/lib/icon-defaults";

// One-time defaults for the whole subtree — hosts call this at their entry.
applyLoomIconDefaults();

const sampler = [
  { icon: Play, name: "Play" },
  { icon: Pause, name: "Pause" },
  { icon: Scissors, name: "Scissors" },
  { icon: Film, name: "Film" },
  { icon: Clapperboard, name: "Clapperboard" },
  { icon: Layers, name: "Layers" },
  { icon: AudioLines, name: "AudioLines" },
  { icon: Sparkles, name: "Sparkles" },
  { icon: FolderOpen, name: "FolderOpen" },
  { icon: Settings, name: "Settings" },
  { icon: MessageSquare, name: "MessageSquare" },
  { icon: Undo2, name: "Undo2" },
  { icon: Download, name: "Download" },
  { icon: Plus, name: "Plus" },
];

const ladder = [
  { size: 14, note: "dense — status bar, header bảng" },
  { size: 16, note: "mặc định — toolbar, menu, nav" },
  { size: 20, note: "nhấn mạnh — empty state, dialog" },
];

// The ≤12px exception, shown as the A/B a reviewer can actually judge: the
// left column inherits the global 1.5 (0.75px thật ở cỡ 12 — quá mảnh), the
// right column declares the spec's 2.5. Both columns render the real glyphs
// of the two primitives that carry 12px icons.
const SMALL_GLYPH_STROKE = 2.5;
const smallGlyphs = [
  { icon: Check, name: "Checkbox — tick" },
  { icon: ChevronUp, name: "NumberField — tăng" },
  { icon: ChevronDown, name: "NumberField — giảm" },
];
</script>

<template>
  <div class="flex flex-col gap-5 text-foreground" style="max-width: 46rem">
    <!-- size ladder -->
    <div class="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div class="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        Thang cỡ
      </div>
      <div class="flex items-end gap-8">
        <div v-for="l in ladder" :key="l.size" class="flex flex-col items-start gap-1.5">
          <component :is="Scissors" :size="l.size" />
          <div class="tabular text-[0.625rem] text-muted-foreground">{{ l.size }}px</div>
          <div class="text-[0.625rem] text-muted-foreground">{{ l.note }}</div>
        </div>
      </div>
    </div>

    <!-- ≤12px exception — the bump is the only way 12px reads like 16px -->
    <div class="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div class="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        Glyph 12px — stroke <code class="tabular normal-case">1.5</code> vs
        <code class="tabular normal-case">2.5</code>
      </div>
      <div class="flex items-start gap-10">
        <div v-for="col in [1.5, SMALL_GLYPH_STROKE]" :key="col" class="flex flex-col gap-2">
          <div class="tabular text-[0.625rem] text-muted-foreground">
            stroke {{ col }}{{ col === SMALL_GLYPH_STROKE ? " — chuẩn" : " — mảnh, sai chuẩn" }}
          </div>
          <div class="flex items-center gap-3">
            <span
              v-for="g in smallGlyphs"
              :key="g.name"
              :title="g.name"
              class="grid h-4 w-4 place-items-center rounded-sm bg-primary text-primary-foreground"
            >
              <component :is="g.icon" :size="12" :stroke-width="col" />
            </span>
          </div>
        </div>
      </div>
      <div class="text-[0.625rem] leading-relaxed text-muted-foreground">
        Stroke sống trên lưới 24 và scale theo size — cỡ 12 chia đôi nét: 1.5 → 0.75px thật, 2.5 →
        1.25px thật (cỡ 16 ở stroke 1.5 là 1.0px). Đây là lý do
        <code class="tabular">Checkbox</code> và <code class="tabular">NumberField</code> khai
        <code class="tabular">:stroke-width="2.5"</code> thay vì thừa kế mặc định.
      </div>
    </div>

    <!-- domain sampler — all inherit size 16 / stroke 1.5 from the shared defaults -->
    <div class="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div class="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        Sampler theo domain — mặc định qua
        <code class="tabular normal-case">applyLoomIconDefaults</code>
      </div>
      <div class="grid grid-cols-7 gap-2">
        <div
          v-for="s in sampler"
          :key="s.name"
          class="flex flex-col items-center gap-1.5 rounded-md border border-border bg-background px-1 py-2.5"
        >
          <component :is="s.icon" />
          <span class="max-w-full truncate text-[0.5625rem] text-muted-foreground">{{
            s.name
          }}</span>
        </div>
      </div>
    </div>

    <!-- custom icon: same API as stock -->
    <div class="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div class="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        Custom icon — <code class="tabular normal-case">createLucideIcon</code>, API y hệt
      </div>
      <div class="flex items-center gap-6">
        <div class="flex items-center gap-3">
          <BrandMark :size="20" />
          <BrandMark />
          <BrandMark :size="14" />
          <span
            class="grid h-4 w-4 place-items-center rounded-[5px] bg-primary text-primary-foreground shadow-sm"
          >
            <BrandMark :size="10" :stroke-width="2.5" />
          </span>
        </div>
        <div class="text-[0.625rem] leading-relaxed text-muted-foreground">
          <code class="tabular">BrandMark</code> từ <code class="tabular">@ecoma-io/ui</code> — 20 /
          16 / 14, và cỡ 10 trong TitleBar (stroke đẩy lên 2.5 để cân quang học).
        </div>
      </div>
    </div>
  </div>
</template>
