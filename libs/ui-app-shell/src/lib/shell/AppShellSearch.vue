<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import { Circle, Search } from '@lucide/vue';
import { Button } from '../ui/button';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '../ui/command';
import { Kbd } from '../ui/kbd';
import { SidebarMenuButton } from '../ui/sidebar';
import { useAppShell } from './context';
import { useAppShellMetaSymbol } from './shortcuts';
import type { AppShellCommandGroup } from './types';

/**
 * Nút mở command palette trong sidebar + chính palette đó.
 *
 * Nguồn hardcode danh sách lệnh; ở đây `groups` là dữ liệu do app truyền vào —
 * library không sở hữu danh sách lệnh, chỉ render và điều hướng.
 *
 * Trạng thái mở/đóng nằm trong context của `AppShell` (một ref duy nhất cho cả
 * nút, phím tắt ⌘/Ctrl + K và dialog), nên ba đường vào không thể lệch nhau.
 *
 * Kbd đổi giữa `⌘` và `Ctrl` theo nền tảng. Giá trị này chỉ được đọc sau khi
 * mount (`onMounted` trong composable), nên SSR và lần render đầu ở client luôn
 * giống nhau — không có nhánh nào ở đây đọc `navigator` trong lúc render.
 */
const {
  groups,
  placeholder = 'Type a command or search...',
  emptyLabel = 'No results found.',
  label = 'Search',
  dialogTitle = 'Command Palette',
  dialogDescription = 'Search for a command to run...',
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  groups: readonly AppShellCommandGroup[];
  placeholder?: string;
  emptyLabel?: string;
  label?: string;
  dialogTitle?: string;
  dialogDescription?: string;
}>();

const { paletteOpen } = useAppShell();
const metaSymbol = useAppShellMetaSymbol();
</script>

<template>
  <SidebarMenuButton as-child :tooltip="label">
    <Button variant="outline" size="sm" class="text-xs" @click="paletteOpen = !paletteOpen">
      <Search />
      <span class="font-normal group-data-[collapsible=icon]:hidden">{{ label }}</span>
      <div class="ml-auto flex items-center space-x-0.5 group-data-[collapsible=icon]:hidden">
        <Kbd>{{ metaSymbol }}</Kbd>
        <Kbd>K</Kbd>
      </div>
    </Button>
  </SidebarMenuButton>

  <CommandDialog v-model:open="paletteOpen" :title="dialogTitle" :description="dialogDescription">
    <CommandInput :placeholder="placeholder" />
    <CommandList>
      <CommandEmpty>{{ emptyLabel }}</CommandEmpty>
      <template v-for="(group, groupIndex) in groups" :key="group.heading">
        <CommandSeparator v-if="groupIndex > 0" />
        <CommandGroup :heading="group.heading">
          <CommandItem v-for="item in group.items" :key="item.title" :value="item.title" as-child>
            <NuxtLink :to="item.href" class="gap-2" @click="paletteOpen = false">
              <component :is="item.icon ?? Circle" />
              {{ item.title }}
              <CommandShortcut v-if="item.keys?.length">
                <Kbd v-for="key in item.keys" :key="key">{{ key }}</Kbd>
              </CommandShortcut>
            </NuxtLink>
          </CommandItem>
        </CommandGroup>
      </template>
    </CommandList>
  </CommandDialog>
</template>
