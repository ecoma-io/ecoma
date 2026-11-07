<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { LabelProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { Label } from 'reka-ui';
import { cn } from '../../utils';

const { class: className = undefined, ...props } = defineProps<
  LabelProps & { class?: HTMLAttributes['class'] }
>();
</script>

<template>
  <Label
    data-slot="label"
    v-bind="props"
    :class="
      cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )
    "
  >
    <slot />
  </Label>
</template>
