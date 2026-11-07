<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { ListboxFilterProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { Search } from '@lucide/vue';
import { ListboxFilter, useForwardProps } from 'reka-ui';
import { cn } from '../../utils';
import { useCommand } from '.';

defineOptions({
  inheritAttrs: false,
});

const { class: className = undefined, ...props } = defineProps<
  ListboxFilterProps & {
    class?: HTMLAttributes['class'];
  }
>();

const forwardedProps = useForwardProps(props);

const { filterState } = useCommand();
</script>

<template>
  <div data-slot="command-input-wrapper" class="flex h-12 items-center gap-2 border-b px-3">
    <Search class="size-4 shrink-0 opacity-50" />
    <ListboxFilter
      v-bind="{ ...forwardedProps, ...$attrs }"
      v-model="filterState.search"
      data-slot="command-input"
      auto-focus
      :class="
        cn(
          'placeholder:text-muted-foreground flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )
      "
    />
  </div>
</template>
