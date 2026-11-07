<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { ListboxGroupProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { ListboxGroup, ListboxGroupLabel, useId } from 'reka-ui';
import { computed, onMounted, onUnmounted } from 'vue';
import { cn } from '../../utils';
import { provideCommandGroupContext, useCommand } from '.';

const {
  class: className = undefined,
  heading = undefined,
  ...props
  // oxlint-disable-next-line vue/max-props
} = defineProps<
  ListboxGroupProps & {
    class?: HTMLAttributes['class'];
    heading?: string;
  }
>();

const { allGroups, filterState } = useCommand();
const id = useId();

const isRender = computed(() => (!filterState.search ? true : filterState.filtered.groups.has(id)));

provideCommandGroupContext({ id });
onMounted(() => {
  if (!allGroups.value.has(id)) allGroups.value.set(id, new Set());
});
onUnmounted(() => {
  allGroups.value.delete(id);
});
</script>

<template>
  <ListboxGroup
    v-bind="props"
    :id="id"
    data-slot="command-group"
    :class="cn('text-foreground overflow-hidden p-1', className)"
    :hidden="isRender ? undefined : true"
  >
    <ListboxGroupLabel v-if="heading" class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
      {{ heading }}
    </ListboxGroupLabel>
    <slot />
  </ListboxGroup>
</template>
