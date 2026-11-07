<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
import { computed } from 'vue';
import { cn } from '../utils';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb';
import { appShellBreadcrumbLinks } from './breadcrumb';
import type { AppShellBreadcrumbLink } from './types';

/**
 * Breadcrumb của header.
 *
 * Nguồn luôn tự suy breadcrumb từ `route.fullPath`; ở đây `links` là prop tuỳ
 * chọn để app có nhãn riêng (đã dịch, hoặc không suy được từ slug), và `path` là
 * đường lui mặc định. Cả hai đường đều thuần dữ liệu vào / DOM ra, không đọc
 * route trong library.
 *
 * Mục cuối render bằng `BreadcrumbPage` (không phải link) đúng như nguồn: nó là
 * trang đang xem, và đó cũng là lý do `aria-current="page"` có sẵn trong
 * `BreadcrumbPage`.
 */
const {
  links = undefined,
  path = '/',
  homeLabel = 'Home',
  class: className = undefined,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  links?: readonly AppShellBreadcrumbLink[];
  path?: string;
  homeLabel?: string;
  class?: string;
}>();

const resolved = computed<readonly AppShellBreadcrumbLink[]>(
  () => links ?? appShellBreadcrumbLinks(path, homeLabel),
);
</script>

<template>
  <Breadcrumb :class="cn(className)">
    <BreadcrumbList>
      <template v-for="(link, index) in resolved" :key="link.href">
        <BreadcrumbItem>
          <BreadcrumbLink v-if="index !== resolved.length - 1" as-child>
            <NuxtLink :to="link.href">
              {{ link.title }}
            </NuxtLink>
          </BreadcrumbLink>
          <BreadcrumbPage v-else>
            {{ link.title }}
          </BreadcrumbPage>
        </BreadcrumbItem>
        <BreadcrumbSeparator v-if="index < resolved.length - 1">
          <ChevronRight />
        </BreadcrumbSeparator>
      </template>
    </BreadcrumbList>
  </Breadcrumb>
</template>
