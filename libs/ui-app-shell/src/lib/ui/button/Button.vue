<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { PrimitiveProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import type { ButtonVariants } from '.';
import { Primitive } from 'reka-ui';
import { cn } from '../../utils';
import { buttonVariants } from '.';

interface Props extends PrimitiveProps {
  variant?: ButtonVariants['variant'];
  size?: ButtonVariants['size'];
  class?: HTMLAttributes['class'];
}

const {
  variant = undefined,
  size = undefined,
  class: className = undefined,
  as = 'button',
  // oxlint-disable-next-line vue/max-props
} = defineProps<Props>();
</script>

<template>
  <Primitive
    data-slot="button"
    :as="as"
    :as-child="asChild"
    :class="cn(buttonVariants({ variant, size }), className)"
  >
    <slot />
  </Primitive>
</template>
