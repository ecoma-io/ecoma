<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { ListboxItemEmits, ListboxItemProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { useCurrentElement } from '@vueuse/core';
import { ListboxItem, useForwardPropsEmits, useId } from 'reka-ui';
import { computed, onMounted, onUnmounted } from 'vue';
import { cn } from '../../utils';
import { useCommand, useCommandGroup } from '.';

const { class: className = undefined, ...props } = defineProps<
  ListboxItemProps & { class?: HTMLAttributes['class'] }
>();
const emits = defineEmits<ListboxItemEmits>();

const forwarded = useForwardPropsEmits(props, emits);

const id = useId();
const { filterState, allItems, allGroups } = useCommand();
// `null` là fallback hợp lệ, không phải trang trí: `CommandItem` không bắt buộc
// nằm trong `CommandGroup` (list phẳng là cách compose hợp lệ, và type context
// đã khai `id?: string`), mà không có fallback thì reka `throw` ngay lúc setup —
// `groupContext?.id` bên dưới không bao giờ chạy tới.
const groupContext = useCommandGroup(null);

const isRender = computed(() => {
  if (!filterState.search) {
    return true;
  } else {
    const filteredCurrentItem = filterState.filtered.items.get(id);
    // If the filtered items is undefined means not in the all times map yet
    // Do the first render to add into the map
    if (filteredCurrentItem === undefined) {
      return true;
    }

    // Check with filter
    return filteredCurrentItem > 0;
  }
});

const currentElement = useCurrentElement();
onMounted(() => {
  if (!(currentElement.value instanceof HTMLElement)) return;

  // textValue to perform filter
  allItems.value.set(id, currentElement.value.textContent ?? props.value?.toString() ?? '');

  const groupId = groupContext?.id;
  if (groupId) {
    if (!allGroups.value.has(groupId)) {
      allGroups.value.set(groupId, new Set([id]));
    } else {
      allGroups.value.get(groupId)?.add(id);
    }
  }
});
onUnmounted(() => {
  allItems.value.delete(id);

  // Phải gỡ cả khỏi group, đối xứng với vế đăng ký ở `onMounted`: `allGroups` chỉ
  // co lại khi `CommandGroup` unmount, nên id của item đã rời đi mà còn nằm trong
  // set của group sẽ khiến group đó vẫn được tính là "còn item khớp" và render ra
  // một group rỗng trong lúc search.
  const groupId = groupContext?.id;
  if (groupId) allGroups.value.get(groupId)?.delete(id);
});
</script>

<template>
  <ListboxItem
    v-if="isRender"
    v-bind="forwarded"
    :id="id"
    data-slot="command-item"
    :class="
      cn(
        'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg:not([class*=\'text-\'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-3 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4',
        className,
      )
    "
    @select="
      () => {
        filterState.search = '';
      }
    "
  >
    <slot />
  </ListboxItem>
</template>
