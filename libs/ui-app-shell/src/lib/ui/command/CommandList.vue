<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { ListboxContentProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { ListboxContent, useForwardProps } from 'reka-ui';
import { cn } from '../../utils';

const { class: className = undefined, ...props } = defineProps<
  ListboxContentProps & { class?: HTMLAttributes['class'] }
>();

const forwarded = useForwardProps(props);
</script>

<template>
  <ListboxContent
    data-slot="command-list"
    v-bind="forwarded"
    :class="cn('max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto', className)"
  >
    <div role="presentation">
      <slot />
    </div>
  </ListboxContent>
</template>
