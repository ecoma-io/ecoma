<script setup lang="ts">
import { Activity, Bot, TrendingDown, TrendingUp } from "@lucide/vue";
import DashboardGrid from "./DashboardGrid.vue";
import Surface from "../../primitives/Surface/Surface.vue";
import Badge from "../../primitives/Badge/Badge.vue";
import Separator from "../../primitives/Separator/Separator.vue";

/** KPI row — label, big tabular value, and a delta as a status Badge. */
const kpis = [
  { label: "Đơn hàng hôm nay", value: "1.284", delta: "+12%", trend: "up" },
  { label: "Doanh thu", value: "482tr", delta: "+4%", trend: "up" },
  { label: "Tỉ lệ hoàn", value: "1,3%", delta: "-0,2%", trend: "down" },
  { label: "Agent đang chạy", value: "6", delta: "+2", trend: "up" },
] as const;

const recentActivity = [
  'Quy trình "Đối soát kho" hoàn tất — 214 dòng khớp.',
  "Agent tổng hợp bình luận đã tạo 8 bản nháp chờ duyệt.",
  "3 hoá đơn đang chờ duyệt quá 24 giờ.",
];
</script>

<template>
  <!-- Realistic dashboard: a KPI row that reflows with the viewport, plus two
       wider panels spanning multiple tiles once the grid has room for them. -->
  <DashboardGrid min-tile-width="14rem" gap="md">
    <Surface v-for="kpi in kpis" :key="kpi.label" pad="md" class="flex flex-col gap-2">
      <p class="text-small text-muted-foreground">{{ kpi.label }}</p>
      <div class="flex items-baseline gap-2">
        <p class="tabular text-display text-foreground">{{ kpi.value }}</p>
        <Badge :variant="kpi.trend === 'up' ? 'success' : 'destructive'">
          <component :is="kpi.trend === 'up' ? TrendingUp : TrendingDown" aria-hidden="true" />
          <span class="tabular">{{ kpi.delta }}</span>
        </Badge>
      </div>
    </Surface>

    <Surface pad="lg" class="flex flex-col gap-3 sm:col-span-2">
      <div class="flex items-center gap-2">
        <Activity aria-hidden="true" class="text-muted-foreground" />
        <p class="text-title text-foreground">Hoạt động gần đây</p>
      </div>
      <template v-for="(item, i) in recentActivity" :key="item">
        <Separator v-if="i > 0" />
        <p class="text-body text-foreground">{{ item }}</p>
      </template>
    </Surface>

    <Surface pad="lg" class="flex flex-col gap-3 sm:col-span-2">
      <div class="flex items-center gap-2">
        <Bot aria-hidden="true" class="text-agent" />
        <p class="text-title text-foreground">Agent đang chạy</p>
      </div>
      <p class="text-body text-muted-foreground">
        6 quy trình agent đang hoạt động, 0 lỗi phát sinh trong giờ qua.
      </p>
    </Surface>
  </DashboardGrid>
</template>
