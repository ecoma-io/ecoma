<script setup lang="ts">
import { ref } from "vue";
import Tabs, { type TabItem } from "./Tabs.vue";

const active = ref("overview");

const tabs: TabItem[] = [
  { value: "overview", label: "Tổng quan" },
  { value: "activity", label: "Hoạt động" },
  { value: "settings", label: "Cài đặt", disabled: true },
];
</script>

<template>
  <div style="max-width: 24rem">
    <Tabs v-model="active" :tabs="tabs">
      <template #overview>
        <p class="text-sm text-foreground">
          Scene "Intro" — 3 asset, cập nhật lần cuối 2 giờ trước.
        </p>
      </template>
      <template #activity>
        <p class="text-sm text-foreground">Ada Lovelace vừa render preview lúc 14:32.</p>
      </template>
      <template #settings>
        <p class="text-sm text-muted-foreground">Cần quyền chủ sở hữu để đổi cài đặt.</p>
      </template>
    </Tabs>
  </div>
</template>
