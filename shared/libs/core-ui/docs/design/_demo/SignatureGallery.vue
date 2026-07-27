<script setup lang="ts">
import { ref } from "vue";
import Checkbox from "../../../src/primitives/Checkbox/Checkbox.vue";
import Switch from "../../../src/primitives/Switch/Switch.vue";
import TextField from "../../../src/primitives/TextField/TextField.vue";

// The four signature devices of the Alloy dual-force law, each isolated so its
// token reads on its own. The swatches use the real utilities
// (bg-primary / bg-agent / bg-seam / animate-seam-flow / animate-conduct /
// shadow-halo) so this page also proves they compile. The live Checkbox/Switch
// show the "checked = steel fill" rule on real components; focus the TextField
// to see the halo.
const checked = ref(true);
const on = ref(true);
const text = ref("Quy trình nhập kho");
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
        <div class="flex items-center gap-2">
          <span
            class="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
          >
            Người · Duyệt đơn
          </span>
          <span
            class="inline-flex items-center rounded-md bg-agent px-2.5 py-1 text-xs font-medium text-agent-foreground"
          >
            Agent · Đối soát
          </span>
        </div>
        <div>
          <div class="text-sm font-medium">Dual-force fill</div>
          <div class="text-xs text-muted-foreground">
            Màu kể ai đang làm — thép cho người, đồng cho agent
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
        <div
          class="h-2 w-full rounded-full bg-seam animate-seam-flow"
          style="background-size: 200% 100%"
        />
        <div>
          <div class="text-sm font-medium">Weld seam</div>
          <div class="text-xs text-muted-foreground">
            Mối hàn thép→đồng tại điểm bàn giao — sống khi cộng tác đang chạy
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
        <div class="flex items-center gap-3">
          <span
            class="inline-flex items-center gap-1.5 rounded-md border border-agent/40 bg-agent-muted px-2.5 py-1 text-xs text-foreground animate-conduct"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-agent" />
            Agent đang chạy
          </span>
        </div>
        <div>
          <div class="text-sm font-medium">Conduct</div>
          <div class="text-xs text-muted-foreground">Nhịp dẫn đồng — agent đang làm việc</div>
        </div>
      </div>

      <div class="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
        <div class="flex items-center gap-3">
          <span class="h-5 w-5 rounded-sm bg-primary" />
          <Checkbox v-model="checked" label="Đã chọn — fill thép" />
          <!-- Switch carries no label of its own by design (its doc header: the
               setting row owns it). This gallery has no row, so the name goes here. -->
          <Switch v-model="on" aria-label="Đã bật — fill thép" />
        </div>
        <div>
          <div class="text-sm font-medium">Màu = lực lượng</div>
          <div class="text-xs text-muted-foreground">
            Bật/chọn là quyết định của người → fill thép phẳng, không glow
          </div>
        </div>
      </div>
    </div>

    <div class="rounded-lg border border-border bg-card p-5">
      <div class="mb-2 text-xs text-muted-foreground">
        Bấm vào field để thấy focus halo (quầng thép quanh ring) trên component thật:
      </div>
      <TextField v-model="text" class="w-full max-w-sm" aria-label="Tên quy trình" />
    </div>
  </div>
</template>
