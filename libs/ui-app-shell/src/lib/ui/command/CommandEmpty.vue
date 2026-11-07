<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { PrimitiveProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { Primitive } from 'reka-ui';
import { computed } from 'vue';
import { cn } from '../../utils';
import { useCommand } from '.';

const { class: className = undefined, ...props } = defineProps<
  PrimitiveProps & { class?: HTMLAttributes['class'] }
>();

const { filterState } = useCommand();
const isRender = computed(() => !!filterState.search && filterState.filtered.count === 0);
</script>

<template>
  <Primitive
    v-if="isRender"
    data-slot="command-empty"
    v-bind="props"
    :class="cn('py-6 text-center text-sm', className)"
  >
    <slot />
  </Primitive>
</template>
