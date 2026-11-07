<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { PrimitiveProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import type { BadgeVariants } from '.';
import { Primitive } from 'reka-ui';
import { cn } from '../../utils';
import { badgeVariants } from '.';

const {
  variant = undefined,
  class: className = undefined,
  ...props
  // oxlint-disable-next-line vue/max-props
} = defineProps<
  PrimitiveProps & {
    variant?: BadgeVariants['variant'];
    class?: HTMLAttributes['class'];
  }
>();
</script>

<template>
  <Primitive data-slot="badge" :class="cn(badgeVariants({ variant }), className)" v-bind="props">
    <slot />
  </Primitive>
</template>
