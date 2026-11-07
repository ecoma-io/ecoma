<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { AvatarFallbackProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { AvatarFallback } from 'reka-ui';
import { cn } from '../../utils';

const { class: className = undefined, ...props } = defineProps<
  AvatarFallbackProps & { class?: HTMLAttributes['class'] }
>();
</script>

<template>
  <AvatarFallback
    data-slot="avatar-fallback"
    v-bind="props"
    :class="cn('bg-muted flex size-full items-center justify-center rounded-full', className)"
  >
    <slot />
  </AvatarFallback>
</template>
