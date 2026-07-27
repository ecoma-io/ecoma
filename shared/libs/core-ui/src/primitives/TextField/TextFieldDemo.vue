<script setup lang="ts">
import { ref } from "vue";
import { Search } from "@lucide/vue";
import TextField from "./TextField.vue";

const name = ref("Ada Lovelace");
const query = ref("");
const email = ref("not-an-email");
</script>

<template>
  <div class="flex flex-col gap-6" style="max-width: 24rem">
    <div class="flex flex-col gap-2">
      <span id="tf-demo-name" class="text-xs text-muted-foreground">Họ tên</span>
      <TextField v-model="name" aria-labelledby="tf-demo-name" placeholder="Nhập họ tên" />
    </div>

    <div class="flex flex-col gap-2">
      <span id="tf-demo-search" class="text-xs text-muted-foreground">Tìm kiếm</span>
      <TextField
        v-model="query"
        type="search"
        aria-labelledby="tf-demo-search"
        placeholder="Tìm asset, scene…"
      >
        <template #leading><Search class="h-4 w-4" /></template>
      </TextField>
    </div>

    <div class="flex flex-col gap-2">
      <span id="tf-demo-email" class="text-xs text-muted-foreground">Email (trạng thái lỗi)</span>
      <TextField
        v-model="email"
        type="email"
        invalid
        aria-labelledby="tf-demo-email"
        placeholder="you@example.com"
      />
    </div>

    <div class="flex items-center gap-3">
      <TextField aria-label="Small" size="sm" placeholder="sm" />
      <TextField aria-label="Medium" size="md" placeholder="md" />
      <TextField aria-label="Large" size="lg" placeholder="lg" />
    </div>

    <TextField aria-label="Disabled" disabled placeholder="Không thể nhập" />
  </div>
</template>
